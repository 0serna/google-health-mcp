import { HealthRepository } from '../db/repository';
import { GoogleHealthClient } from '../google-health/client';
import {
  applyDailyVitalPoint,
  applyRollupPoint,
  extractDateFromRecord,
  parseSleepPoint,
  parseWorkoutPoint,
  resolveMainSleepFlags,
  type ParsedSleepSession,
} from '../google-health/parsers';
import type { DailyMetricRow, Env, SleepSessionRow, WorkoutRow } from '../types';
import { validateDateRange } from '../utils/dates';

export { formatDateUtc, shiftDays } from '../utils/dates';

export interface SyncResult {
  status: 'ok' | 'partial' | 'error';
  fromDate: string;
  toDate: string;
  daysSynced: number;
  sleepSessionsSynced: number;
  workoutsSynced: number;
  warnings: string[];
}

const ROLLUP_TYPES = ['steps', 'distance', 'total-calories', 'active-zone-minutes'] as const;

const DAILY_VITAL_TYPES = [
  'daily-resting-heart-rate',
  'daily-heart-rate-variability',
  'daily-oxygen-saturation',
  'daily-respiratory-rate',
  'daily-sleep-temperature-derivations',
] as const;

export async function syncHealthRange(
  env: Env,
  fromDate: string,
  toDate: string,
  trigger: 'cron' | 'manual',
): Promise<SyncResult> {
  validateDateRange(fromDate, toDate, 90);

  const startedAt = new Date().toISOString();
  const timeZone = env.DEFAULT_TIMEZONE ?? 'UTC';
  const client = new GoogleHealthClient(env);
  const repo = new HealthRepository(env.DB);
  const warnings: string[] = [];

  const dayMap = new Map<string, Partial<DailyMetricRow> & { date: string }>();
  const touchDay = (date: string) => {
    let row = dayMap.get(date);
    if (!row) {
      row = { date };
      dayMap.set(date, row);
    }
    return row;
  };

  let sleepSessions: SleepSessionRow[] = [];
  let workouts: WorkoutRow[] = [];
  let status: SyncResult['status'] = 'error';

  try {
    // 1. Daily activity rollups
    await Promise.all(
      ROLLUP_TYPES.map(async (dataType) => {
        try {
          const points = await client.dailyRollUp({ dataType, fromDate, toDate });
          for (const p of points) {
            const date = extractDateFromRecord(p, timeZone);
            if (!date) continue;
            applyRollupPoint(dataType, touchDay(date), p);
          }
        } catch (err) {
          warnings.push(`${dataType}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    );

    // 2. Daily vitals (RHR, HRV, SpO2, respiratory rate, skin temperature)
    await Promise.all(
      DAILY_VITAL_TYPES.map(async (dataType) => {
        try {
          const points = await client.listDataPoints({
            dataType,
            fromDate,
            toDate,
            reconcile: true,
            timeZone,
          });
          for (const dp of points) {
            const inner = (Object.values(dp).find((v) => v && typeof v === 'object' && !Array.isArray(v)) ??
              dp) as Record<string, unknown>;
            const date = extractDateFromRecord(inner, timeZone) ?? extractDateFromRecord(dp, timeZone);
            if (!date) continue;
            applyDailyVitalPoint(dataType, touchDay(date), dp);
          }
        } catch (err) {
          warnings.push(`${dataType}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    );

    // 3. Sleep sessions
    try {
      const sleepPoints = await client.listDataPoints({
        dataType: 'sleep',
        fromDate,
        toDate,
        reconcile: true,
        timeZone,
      });
      const now = new Date().toISOString();
      const parsed: ParsedSleepSession[] = [];
      for (const dp of sleepPoints) {
        const item = parseSleepPoint(dp, now, timeZone);
        if (item) parsed.push(item);
      }

      sleepSessions = resolveMainSleepFlags(parsed);

      for (const session of sleepSessions) {
        const dayRow = touchDay(session.date);
        dayRow.sleep_total_minutes =
          (dayRow.sleep_total_minutes ?? 0) + (session.asleep_minutes ?? session.duration_minutes ?? 0);
        if (session.deep_minutes !== null) {
          dayRow.sleep_deep_minutes = (dayRow.sleep_deep_minutes ?? 0) + session.deep_minutes;
        }
        if (session.rem_minutes !== null) {
          dayRow.sleep_rem_minutes = (dayRow.sleep_rem_minutes ?? 0) + session.rem_minutes;
        }
        if (session.light_minutes !== null) {
          dayRow.sleep_light_minutes = (dayRow.sleep_light_minutes ?? 0) + session.light_minutes;
        }
        if (session.awake_minutes !== null) {
          dayRow.sleep_awake_minutes = (dayRow.sleep_awake_minutes ?? 0) + session.awake_minutes;
        }
        if (session.efficiency_pct !== null && (session.is_main_sleep === 1 || dayRow.sleep_efficiency_pct == null)) {
          dayRow.sleep_efficiency_pct = session.efficiency_pct;
        }
      }
    } catch (err) {
      warnings.push(`sleep: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 4. Workouts / exercise sessions
    try {
      const exercisePoints = await client.listDataPoints({
        dataType: 'exercise',
        fromDate,
        toDate,
        reconcile: true,
        timeZone,
      });
      const now = new Date().toISOString();
      for (const dp of exercisePoints) {
        const workout = parseWorkoutPoint(dp, now, timeZone);
        if (workout) workouts.push(workout);
      }
    } catch (err) {
      warnings.push(`exercise: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 5. Batch-persist all records into D1 (keeps Free-tier query count minimal)
    const statements: D1PreparedStatement[] = [
      ...sleepSessions.flatMap((s) => [
        repo.prepareDeleteSleepDuplicates(s),
        repo.prepareUpsertSleepSession(s),
      ]),
      ...workouts.map((w) => repo.prepareUpsertWorkout(w)),
      ...Array.from(dayMap.values()).map((row) => repo.prepareUpsertDailyMetric(row)),
    ];
    await repo.executeBatch(statements);

    status =
      warnings.length === 0
        ? 'ok'
        : dayMap.size > 0 || sleepSessions.length > 0 || workouts.length > 0
          ? 'partial'
          : 'error';

    return {
      status,
      fromDate,
      toDate,
      daysSynced: dayMap.size,
      sleepSessionsSynced: sleepSessions.length,
      workoutsSynced: workouts.length,
      warnings,
    };
  } catch (err) {
    status = 'error';
    warnings.push(`persist: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  } finally {
    try {
      await repo.recordSyncRun({
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        trigger,
        from_date: fromDate,
        to_date: toDate,
        status,
        days_synced: dayMap.size,
        error_message: warnings.length > 0 ? warnings.join(' | ').slice(0, 1000) : null,
      });
    } catch (logErr) {
      console.error('Failed to record sync_runs row:', logErr);
    }
  }
}
