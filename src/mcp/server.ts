import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { computeBaselineAnalysis, computeSleepSummary } from '../analytics/metrics';
import { getStoredTokens, getTokenHealthInfo } from '../auth/google-oauth';
import { HealthRepository } from '../db/repository';
import { DATA_TYPE_CATALOG, DEFAULT_READONLY_SCOPES } from '../google-health/catalog';
import { GoogleHealthClient } from '../google-health/client';
import { syncHealthRange } from '../sync/sync-service';
import type { Env } from '../types';
import { isValidDateString, shiftDays, todayInTimezone, validateDateRange } from '../utils/dates';

function jsonText(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

function withToolLogging<TArgs extends Record<string, unknown>>(
  toolName: string,
  handler: (args: TArgs) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>,
) {
  return async (args: TArgs) => {
    const started = Date.now();
    try {
      const result = await handler(args);
      console.log(
        JSON.stringify({
          event: 'mcp_tool_ok',
          tool: toolName,
          args,
          durationMs: Date.now() - started,
        }),
      );
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        JSON.stringify({
          event: 'mcp_tool_error',
          tool: toolName,
          args,
          durationMs: Date.now() - started,
          error: message,
        }),
      );
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify({ error: message, tool: toolName, args }, null, 2) }],
      };
    }
  };
}

const dateSchema = z
  .string()
  .refine(isValidDateString, { message: 'Expected a valid calendar date in YYYY-MM-DD format.' });

const DATA_TYPE_ALIASES: Record<string, string> = {
  exercises: 'exercise',
  workouts: 'exercise',
  workout: 'exercise',
  step: 'steps',
  rhr: 'daily-resting-heart-rate',
  'resting-heart-rate': 'daily-resting-heart-rate',
  hrv: 'daily-heart-rate-variability',
  spo2: 'daily-oxygen-saturation',
  'skin-temperature': 'daily-sleep-temperature-derivations',
  'daily-skin-temperature': 'daily-sleep-temperature-derivations',
};

export function createHealthMcpServer(env: Env): McpServer {
  const server = new McpServer({
    name: 'google-health-mcp',
    version: '0.2.0',
  });

  const repo = new HealthRepository(env.DB);
  const client = new GoogleHealthClient(env);
  const timeZone = env.DEFAULT_TIMEZONE ?? 'UTC';
  const defaultSleepGoal = Number(env.SLEEP_GOAL_MINUTES ?? 480) || 480;
  const todayLocal = () => todayInTimezone(timeZone);

  // 1. Connection status, OAuth health, and D1 cache stats
  server.registerTool(
    'health_status',
    {
      description:
        'Checks Google Health API v4 OAuth connection status (including 7-day Testing-mode refresh token warning), last sync run, and cached D1 date range.',
      inputSchema: {},
    },
    withToolLogging('health_status', async () => {
      const [tokens, dbStats] = await Promise.all([getStoredTokens(env), repo.getStats()]);
      return jsonText({
        oauth: getTokenHealthInfo(env, tokens),
        database: dbStats,
        timezone: timeZone,
        todayLocal: todayLocal(),
        sleepGoalMinutes: defaultSleepGoal,
      });
    }),
  );

  // 2. Manual on-demand sync
  server.registerTool(
    'health_sync_now',
    {
      description:
        'Manually syncs recent data from Google Health API v4 (Fitbit Air / Pixel Watch) into the D1 database (max 90 days per call).',
      inputSchema: {
        days: z
          .number()
          .int()
          .min(1)
          .max(90)
          .default(7)
          .describe('Number of days back to sync (default 7, max 90).'),
        fromDate: dateSchema.optional().describe('Optional start date YYYY-MM-DD (overrides days).'),
        toDate: dateSchema.optional().describe('Optional end date YYYY-MM-DD (default today in local timezone).'),
      },
    },
    withToolLogging('health_sync_now', async ({ days, fromDate, toDate }) => {
      const end = toDate ?? todayLocal();
      const start = fromDate ?? shiftDays(end, -(days - 1));
      validateDateRange(start, end, 90);
      const result = await syncHealthRange(env, start, end, 'manual');
      return jsonText(result);
    }),
  );

  // 3. Consolidated daily summary
  server.registerTool(
    'health_daily_summary',
    {
      description:
        'Returns consolidated daily metrics (steps, distance, calories, active zone minutes, RHR, HRV, SpO2, respiratory rate, skin temp delta, and sleep stages) from D1.',
      inputSchema: {
        fromDate: dateSchema.optional().describe('Start date YYYY-MM-DD (default: 7 days ago).'),
        toDate: dateSchema.optional().describe('End date YYYY-MM-DD (default: today in local timezone).'),
        refreshFromApi: z
          .boolean()
          .default(false)
          .describe('If true, syncs from Google Health API v4 before reading D1 (max 90 days when true).'),
      },
    },
    withToolLogging('health_daily_summary', async ({ fromDate, toDate, refreshFromApi }) => {
      const end = toDate ?? todayLocal();
      const start = fromDate ?? shiftDays(end, -6);
      validateDateRange(start, end, refreshFromApi ? 90 : 366);

      let syncWarnings: string[] | undefined;
      if (refreshFromApi) {
        const syncResult = await syncHealthRange(env, start, end, 'manual');
        if (syncResult.warnings.length > 0) {
          syncWarnings = syncResult.warnings;
        }
      }

      const rows = await repo.getDailyMetrics(start, end);
      return jsonText({
        fromDate: start,
        toDate: end,
        daysReturned: rows.length,
        ...(syncWarnings ? { syncWarnings } : {}),
        metrics: rows,
      });
    }),
  );

  // 4. Trends, personal baselines, and z-score anomaly detection
  server.registerTool(
    'health_trends_and_baselines',
    {
      description:
        'Computes 7-day averages vs. prior 30-day personal baselines (excluding the recent 7-day window), standard deviation, and z-scores to flag anomalies in sleep, HRV, resting HR, SpO2, respiratory rate, and activity.',
      inputSchema: {
        referenceDate: dateSchema.optional().describe('Reference date YYYY-MM-DD (default: today in local timezone).'),
      },
    },
    withToolLogging('health_trends_and_baselines', async ({ referenceDate }) => {
      const end = referenceDate ?? todayLocal();
      const start = shiftDays(end, -37);
      const rows = await repo.getDailyMetrics(start, end);

      const analyses = [
        computeBaselineAnalysis(rows, 'sleep_total_minutes', 'sleep_total_minutes', 'min', end),
        computeBaselineAnalysis(rows, 'hrv_rmssd_ms', 'hrv_rmssd_ms', 'ms', end),
        computeBaselineAnalysis(rows, 'resting_hr_bpm', 'resting_hr_bpm', 'bpm', end),
        computeBaselineAnalysis(rows, 'spo2_avg_pct', 'spo2_avg_pct', '%', end),
        computeBaselineAnalysis(rows, 'respiratory_rate_bpm', 'respiratory_rate_bpm', 'brpm', end),
        computeBaselineAnalysis(rows, 'steps', 'steps', 'steps', end),
        computeBaselineAnalysis(rows, 'active_zone_minutes', 'active_zone_minutes', 'min', end),
      ];

      const anomalies = analyses.filter(
        (a) => a.status === 'above_baseline' || a.status === 'below_baseline',
      );

      return jsonText({
        referenceDate: end,
        windowAnalyzed: { fromDate: start, toDate: end, daysInDb: rows.length },
        anomaliesDetected: anomalies.map((a) => ({
          metric: a.metric,
          status: a.status,
          latestDate: a.latestDate,
          latestValue: a.latestValue,
          baseline30dAvg: a.baseline30dAvg,
          zScore: a.zScore,
          stale: a.stale,
        })),
        metrics: analyses,
      });
    }),
  );

  // 5. Detailed sleep analysis
  server.registerTool(
    'health_sleep_analysis',
    {
      description:
        'Analyzes sleep sessions over a date range: average daily sleep, stages (deep, REM, light), efficiency, and cumulative sleep debt relative to your sleep goal (aggregating naps per day).',
      inputSchema: {
        fromDate: dateSchema.optional().describe('Start date YYYY-MM-DD (default: 14 days ago).'),
        toDate: dateSchema.optional().describe('End date YYYY-MM-DD (default: today in local timezone).'),
        sleepGoalMinutes: z
          .number()
          .int()
          .min(240)
          .max(720)
          .optional()
          .describe('Daily sleep target in minutes (default 480 = 8h).'),
      },
    },
    withToolLogging('health_sleep_analysis', async ({ fromDate, toDate, sleepGoalMinutes }) => {
      const end = toDate ?? todayLocal();
      const start = fromDate ?? shiftDays(end, -13);
      validateDateRange(start, end, 366);
      const goal = sleepGoalMinutes ?? defaultSleepGoal;
      const sessions = await repo.getSleepSessions(start, end);

      return jsonText({
        fromDate: start,
        toDate: end,
        summary: computeSleepSummary(sessions, goal),
        sessions,
      });
    }),
  );

  // 6. Workouts with recovery context
  server.registerTool(
    'health_workouts',
    {
      description:
        'Lists workouts/exercises over a date range enriched with same-day and next-day recovery context (HRV, resting HR, and sleep).',
      inputSchema: {
        fromDate: dateSchema.optional().describe('Start date YYYY-MM-DD (default: 14 days ago).'),
        toDate: dateSchema.optional().describe('End date YYYY-MM-DD (default: today in local timezone).'),
      },
    },
    withToolLogging('health_workouts', async ({ fromDate, toDate }) => {
      const end = toDate ?? todayLocal();
      const start = fromDate ?? shiftDays(end, -13);
      validateDateRange(start, end, 366);

      const [workouts, metrics] = await Promise.all([
        repo.getWorkouts(start, end),
        repo.getDailyMetrics(start, shiftDays(end, 1)),
      ]);

      const metricsByDate = new Map(metrics.map((m) => [m.date, m]));
      const enriched = workouts.map((w) => {
        const nextDay = shiftDays(w.date, 1);
        const dayM = metricsByDate.get(w.date);
        const nextM = metricsByDate.get(nextDay);
        return {
          ...w,
          sameDayContext: dayM
            ? {
                restingHrBpm: dayM.resting_hr_bpm,
                hrvRmssdMs: dayM.hrv_rmssd_ms,
                sleepTotalMinutes: dayM.sleep_total_minutes,
              }
            : null,
          nextDayRecovery: nextM
            ? {
                date: nextDay,
                restingHrBpm: nextM.resting_hr_bpm,
                hrvRmssdMs: nextM.hrv_rmssd_ms,
                sleepTotalMinutes: nextM.sleep_total_minutes,
              }
            : null,
        };
      });

      return jsonText({
        fromDate: start,
        toDate: end,
        count: enriched.length,
        workouts: enriched,
      });
    }),
  );

  // 7. Generic read-only query to Google Health API v4
  server.registerTool(
    'health_query_api_v4',
    {
      description:
        'Direct read-only query to any Google Health API v4 dataType using list, reconcile, or dailyRollUp (with 15-minute KV caching, max 90 days per call).',
      inputSchema: {
        dataType: z
          .string()
          .regex(/^[a-z0-9-]+$/i, 'Use kebab-case letters, digits, and hyphens.')
          .describe(
            'Kebab-case dataType identifier (e.g. "steps", "heart-rate", "sleep", "exercise", "daily-heart-rate-variability", "oxygen-saturation").',
          ),
        operation: z
          .enum(['list', 'reconcile', 'dailyRollUp'])
          .default('reconcile')
          .describe('Google Health API v4 operation.'),
        fromDate: dateSchema.describe('Start date YYYY-MM-DD.'),
        toDate: dateSchema.describe('End date YYYY-MM-DD.'),
        maxItems: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(100)
          .describe('Maximum records returned to keep LLM context compact.'),
      },
    },
    withToolLogging('health_query_api_v4', async ({ dataType, operation, fromDate, toDate, maxItems }) => {
      validateDateRange(fromDate, toDate, 90);
      const lower = dataType.toLowerCase();
      const normalizedType = DATA_TYPE_ALIASES[lower] ?? lower;
      const spec = DATA_TYPE_CATALOG[normalizedType];

      if (operation === 'dailyRollUp') {
        if (spec && !spec.supportsDailyRollUp) {
          const { items, hasMore } = await client.listDataPointsWithMeta({
            dataType: normalizedType,
            fromDate,
            toDate,
            reconcile: true,
            maxItems,
            useCache: true,
            timeZone,
          });
          return jsonText({
            dataType: normalizedType,
            operation: 'reconcile',
            note: `${normalizedType} does not support dailyRollUp; automatically used reconcile instead.`,
            fromDate,
            toDate,
            totalReturned: Math.min(items.length, maxItems),
            truncated: hasMore || items.length > maxItems,
            items: items.slice(0, maxItems),
          });
        }

        const { items, hasMore } = await client.dailyRollUpWithMeta({
          dataType: normalizedType,
          fromDate,
          toDate,
          maxItems,
          useCache: true,
        });
        return jsonText({
          dataType: normalizedType,
          operation,
          fromDate,
          toDate,
          totalReturned: Math.min(items.length, maxItems),
          truncated: hasMore || items.length > maxItems,
          items: items.slice(0, maxItems),
        });
      }

      const { items, hasMore } = await client.listDataPointsWithMeta({
        dataType: normalizedType,
        fromDate,
        toDate,
        reconcile: operation === 'reconcile',
        maxItems,
        useCache: true,
        timeZone,
      });

      return jsonText({
        dataType: normalizedType,
        operation,
        fromDate,
        toDate,
        totalReturned: Math.min(items.length, maxItems),
        truncated: hasMore || items.length > maxItems,
        items: items.slice(0, maxItems),
      });
    }),
  );

  // 8. Supported data types catalog
  server.registerTool(
    'health_data_catalog',
    {
      description:
        'Lists supported Google Health API v4 dataTypes, kebab-case/snake_case AIP-160 filter conventions, and read-only OAuth scopes.',
      inputSchema: {},
    },
    withToolLogging('health_data_catalog', async () => {
      return jsonText({
        apiBaseUrl: 'https://health.googleapis.com/v4',
        defaultScopes: DEFAULT_READONLY_SCOPES,
        dataTypes: Object.values(DATA_TYPE_CATALOG),
      });
    }),
  );

  return server;
}
