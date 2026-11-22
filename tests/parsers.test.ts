import { describe, expect, it } from 'vitest';
import {
  applyDailyVitalPoint,
  applyRollupPoint,
  parseSleepPoint,
  parseWorkoutPoint,
  resolveMainSleepFlags,
} from '../src/google-health/parsers';
import type { DailyMetricRow } from '../src/types';

describe('Google Health API v4 parsers', () => {
  it('parses workout civilStartTime and averageHeartRateBeatsPerMinute correctly', () => {
    const dp = {
      dataPointName: 'users/me/dataTypes/exercise/dataPoints/ex-1',
      exercise: {
        exerciseType: 'RUNNING',
        interval: {
          startTime: '2026-11-22T01:00:00Z', // 20:00 America/Bogota on 2026-11-21
          endTime: '2026-11-22T01:45:00Z',
          civilStartTime: {
            date: { year: 2026, month: 11, day: 21 },
            time: { hours: 20, minutes: 0, seconds: 0, nanos: 0 },
          },
        },
        metricsSummary: {
          caloriesKcal: 412,
          distanceMillimeters: 5250000,
          averageHeartRateBeatsPerMinute: 152,
          maxHeartRateBeatsPerMinute: 178,
        },
      },
    };

    const workout = parseWorkoutPoint(dp, '2026-11-22T02:00:00Z', 'America/Bogota');
    expect(workout).not.toBeNull();
    expect(workout!.date).toBe('2026-11-21');
    expect(workout!.duration_minutes).toBe(45);
    expect(workout!.calories_kcal).toBe(412);
    expect(workout!.distance_meters).toBe(5250);
    expect(workout!.avg_hr_bpm).toBe(152);
    expect(workout!.max_hr_bpm).toBe(178);
  });

  it('falls back to local timezone date when workout lacks civilStartTime', () => {
    const dp = {
      id: 'ex-2',
      exercise: {
        exerciseType: 'WEIGHTS',
        interval: {
          startTime: '2026-11-22T01:00:00Z',
          endTime: '2026-11-22T01:30:00Z',
        },
      },
    };

    const workout = parseWorkoutPoint(dp, '2026-11-22T02:00:00Z', 'America/Bogota');
    expect(workout!.date).toBe('2026-11-21');
  });

  it('marks only the longest sleep session of a day as main sleep when isMainSleep is absent', () => {
    const night = parseSleepPoint(
      {
        name: 'sleep-night',
        sleep: {
          interval: {
            startTime: '2026-11-21T04:00:00Z',
            endTime: '2026-11-21T11:30:00Z',
          },
          stages: [
            { startTime: '2026-11-21T04:00:00Z', endTime: '2026-11-21T05:30:00Z', type: 'DEEP' },
            { startTime: '2026-11-21T05:30:00Z', endTime: '2026-11-21T07:00:00Z', type: 'REM' },
            { startTime: '2026-11-21T07:00:00Z', endTime: '2026-11-21T11:00:00Z', type: 'LIGHT' },
            { startTime: '2026-11-21T11:00:00Z', endTime: '2026-11-21T11:30:00Z', type: 'AWAKE' },
          ],
        },
      },
      '2026-11-21T12:00:00Z',
      'America/Bogota',
    )!;

    const nap = parseSleepPoint(
      {
        name: 'sleep-nap',
        sleep: {
          interval: {
            startTime: '2026-11-21T19:00:00Z',
            endTime: '2026-11-21T19:35:00Z',
          },
        },
      },
      '2026-11-21T20:00:00Z',
      'America/Bogota',
    )!;

    const resolved = resolveMainSleepFlags([night, nap]);
    expect(resolved[0].is_main_sleep).toBe(1);
    expect(resolved[0].asleep_minutes).toBe(420);
    expect(resolved[1].is_main_sleep).toBe(0);
    expect(resolved[1].asleep_minutes).toBe(35);
  });

  it('parses daily HRV without mixing deepSleep RMSSD fallback', () => {
    const row: Partial<DailyMetricRow> = { date: '2026-11-21' };
    applyDailyVitalPoint('daily-heart-rate-variability', row, {
      dailyHeartRateVariability: {
        averageHeartRateVariabilityMilliseconds: 64.5,
        deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds: 88.2,
      },
    });
    expect(row.hrv_rmssd_ms).toBe(64.5);

    const rowOnlyDeep: Partial<DailyMetricRow> = { date: '2026-11-21' };
    applyDailyVitalPoint('daily-heart-rate-variability', rowOnlyDeep, {
      dailyHeartRateVariability: {
        deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds: 88.2,
      },
    });
    expect(rowOnlyDeep.hrv_rmssd_ms).toBeNull();
  });

  it('parses active-zone-minutes rollup sums across heart rate zones', () => {
    const row: Partial<DailyMetricRow> = { date: '2026-11-21' };
    applyRollupPoint('active-zone-minutes', row, {
      activeZoneMinutes: {
        sumInFatBurnHeartZone: 25,
        sumInCardioHeartZone: 12,
        sumInPeakHeartZone: 4,
      },
    });
    expect(row.active_zone_minutes).toBe(41);
  });
});
