import { describe, expect, it } from 'vitest';
import { computeBaselineAnalysis, computeSleepSummary } from '../src/analytics/metrics';
import { buildTimeRangeFilter, kebabToSnake } from '../src/google-health/catalog';
import type { DailyMetricRow, SleepSessionRow } from '../src/types';
import {
  daysBetweenInclusive,
  isValidDateString,
  localDateStartUtcIso,
  todayInTimezone,
  validateDateRange,
} from '../src/utils/dates';

function makeDailyRow(date: string, overrides: Partial<DailyMetricRow> = {}): DailyMetricRow {
  return {
    date,
    steps: null,
    distance_meters: null,
    calories_kcal: null,
    active_zone_minutes: null,
    resting_hr_bpm: null,
    hrv_rmssd_ms: null,
    spo2_avg_pct: null,
    spo2_min_pct: null,
    respiratory_rate_bpm: null,
    skin_temp_delta_c: null,
    weight_kg: null,
    body_fat_pct: null,
    vo2_max: null,
    sleep_total_minutes: null,
    sleep_deep_minutes: null,
    sleep_rem_minutes: null,
    sleep_light_minutes: null,
    sleep_awake_minutes: null,
    sleep_efficiency_pct: null,
    updated_at: '2026-11-21T00:00:00Z',
    ...overrides,
  };
}

describe('Google Health API v4 AIP-160 filter builder', () => {
  it('converts kebab-case identifiers to snake_case', () => {
    expect(kebabToSnake('daily-resting-heart-rate')).toBe('daily_resting_heart_rate');
    expect(kebabToSnake('body-fat')).toBe('body_fat');
  });

  it('builds daily filters with .date and >= / < comparators', () => {
    expect(buildTimeRangeFilter('daily-heart-rate-variability', '2026-11-01', '2026-11-21')).toBe(
      'daily_heart_rate_variability.date >= "2026-11-01" AND daily_heart_rate_variability.date < "2026-11-22"',
    );
  });

  it('builds interval filters with .interval.start_time', () => {
    expect(buildTimeRangeFilter('steps', '2026-11-20', '2026-11-21')).toBe(
      'steps.interval.start_time >= "2026-11-20T00:00:00Z" AND steps.interval.start_time < "2026-11-22T00:00:00Z"',
    );
  });

  it('builds sleep filters using .interval.end_time and local timezone boundaries', () => {
    expect(buildTimeRangeFilter('sleep', '2026-11-01', '2026-11-21')).toBe(
      'sleep.interval.end_time >= "2026-11-01T00:00:00Z" AND sleep.interval.end_time < "2026-11-22T00:00:00Z"',
    );
    expect(buildTimeRangeFilter('sleep', '2026-11-01', '2026-11-21', undefined, 'America/Bogota')).toBe(
      'sleep.interval.end_time >= "2026-11-01T05:00:00Z" AND sleep.interval.end_time < "2026-11-22T05:00:00Z"',
    );
  });

  it('builds exercise filters using .interval.civil_start_time', () => {
    expect(buildTimeRangeFilter('exercise', '2026-11-01', '2026-11-21')).toBe(
      'exercise.interval.civil_start_time >= "2026-11-01" AND exercise.interval.civil_start_time < "2026-11-22"',
    );
  });

  it('builds instantaneous sample filters using .sample_time.physical_time', () => {
    expect(buildTimeRangeFilter('body-fat', '2026-11-01', '2026-11-21')).toBe(
      'body_fat.sample_time.physical_time >= "2026-11-01T00:00:00Z" AND body_fat.sample_time.physical_time < "2026-11-22T00:00:00Z"',
    );
  });

  it('rejects invalid dataType characters before building filter', () => {
    expect(() => buildTimeRangeFilter('steps" OR 1=1', '2026-11-01', '2026-11-02')).toThrow();
  });
});

describe('Date and timezone utilities', () => {
  it('validates real calendar dates and rejects impossible dates', () => {
    expect(isValidDateString('2026-11-21')).toBe(true);
    expect(isValidDateString('2026-02-29')).toBe(false);
    expect(isValidDateString('2026-13-45')).toBe(false);
  });

  it('converts UTC instants to local calendar dates in America/Bogota', () => {
    // 2026-11-22T01:30:00Z is 2026-11-21 20:30 in America/Bogota (UTC-5)
    expect(todayInTimezone('America/Bogota', new Date('2026-11-22T01:30:00Z'))).toBe('2026-11-21');
    expect(localDateStartUtcIso('2026-11-21', 'America/Bogota')).toBe('2026-11-21T05:00:00Z');
  });

  it('enforces date order and max range span', () => {
    expect(daysBetweenInclusive('2026-11-01', '2026-11-10')).toBe(10);
    expect(() => validateDateRange('2026-11-10', '2026-11-01')).toThrow();
    expect(() => validateDateRange('2026-01-01', '2026-06-01', 90)).toThrow();
  });
});

describe('Analytics: baselines and z-scores', () => {
  it('flags a significant HRV drop below personal baseline excluding recent 7d window', () => {
    const rows: DailyMetricRow[] = [];
    for (let i = 1; i <= 29; i++) {
      const day = String(i).padStart(2, '0');
      rows.push(makeDailyRow(`2026-10-${day}`, { hrv_rmssd_ms: 58 + (i % 5) }));
    }
    rows.push(makeDailyRow('2026-10-30', { hrv_rmssd_ms: 38 }));

    const analysis = computeBaselineAnalysis(rows, 'hrv_rmssd_ms', 'hrv_rmssd_ms', 'ms', '2026-10-30');
    expect(analysis.latestDate).toBe('2026-10-30');
    expect(analysis.latestValue).toBe(38);
    expect(analysis.status).toBe('below_baseline');
    expect(analysis.stale).toBe(false);
    expect(analysis.zScore).not.toBeNull();
    expect(analysis.zScore!).toBeLessThan(-1.25);
  });

  it('marks stale=true when latest sample is more than 3 days before referenceDate', () => {
    const rows: DailyMetricRow[] = [];
    for (let i = 1; i <= 20; i++) {
      const day = String(i).padStart(2, '0');
      rows.push(makeDailyRow(`2026-10-${day}`, { resting_hr_bpm: 55 + (i % 3) }));
    }
    const analysis = computeBaselineAnalysis(rows, 'resting_hr_bpm', 'resting_hr_bpm', 'bpm', '2026-10-30');
    expect(analysis.stale).toBe(true);
  });

  it('reports insufficient_data when fewer than 5 samples exist', () => {
    const rows = [
      makeDailyRow('2026-11-19', { steps: 8000 }),
      makeDailyRow('2026-11-20', { steps: 9500 }),
    ];
    const analysis = computeBaselineAnalysis(rows, 'steps', 'steps', 'steps', '2026-11-20');
    expect(analysis.status).toBe('insufficient_data');
    expect(analysis.sampleCount30d).toBe(1);
  });
});

describe('Analytics: sleep summary', () => {
  it('computes average duration and cumulative sleep debt vs goal', () => {
    const sessions: SleepSessionRow[] = [
      {
        id: 's1',
        date: '2026-11-19',
        start_time: '2026-11-18T23:30:00Z',
        end_time: '2026-11-19T06:30:00Z',
        duration_minutes: 420,
        asleep_minutes: 420,
        deep_minutes: 80,
        rem_minutes: 95,
        light_minutes: 245,
        awake_minutes: 25,
        efficiency_pct: 92,
        is_main_sleep: 1,
        updated_at: '2026-11-19T07:00:00Z',
      },
      {
        id: 's2',
        date: '2026-11-20',
        start_time: '2026-11-19T23:00:00Z',
        end_time: '2026-11-20T06:00:00Z',
        duration_minutes: 420,
        asleep_minutes: 420,
        deep_minutes: 90,
        rem_minutes: 105,
        light_minutes: 225,
        awake_minutes: 20,
        efficiency_pct: 94,
        is_main_sleep: 1,
        updated_at: '2026-11-20T07:00:00Z',
      },
    ];

    const summary = computeSleepSummary(sessions, 480);
    expect(summary.nightsCount).toBe(2);
    expect(summary.sessionsCount).toBe(2);
    expect(summary.avgAsleepMinutes).toBe(420);
    expect(summary.cumulativeSleepDebtMinutes).toBe(120);
    expect(summary.cumulativeSleepDebtHours).toBe(2);
    expect(summary.avgDeepMinutes).toBe(85);
    expect(summary.avgEfficiencyPct).toBe(93);
  });

  it('aggregates naps into the same day instead of adding fake sleep debt', () => {
    const sessions: SleepSessionRow[] = [
      {
        id: 'night1',
        date: '2026-11-20',
        start_time: '2026-11-20T04:00:00Z',
        end_time: '2026-11-20T11:30:00Z',
        duration_minutes: 450,
        asleep_minutes: 420,
        deep_minutes: 90,
        rem_minutes: 100,
        light_minutes: 230,
        awake_minutes: 30,
        efficiency_pct: 93,
        is_main_sleep: 1,
        updated_at: '2026-11-20T12:00:00Z',
      },
      {
        id: 'nap1',
        date: '2026-11-20',
        start_time: '2026-11-20T19:00:00Z',
        end_time: '2026-11-20T19:30:00Z',
        duration_minutes: 30,
        asleep_minutes: 30,
        deep_minutes: null,
        rem_minutes: null,
        light_minutes: null,
        awake_minutes: null,
        efficiency_pct: 100,
        is_main_sleep: 0,
        updated_at: '2026-11-20T20:00:00Z',
      },
    ];

    const summary = computeSleepSummary(sessions, 480);
    expect(summary.nightsCount).toBe(1);
    expect(summary.sessionsCount).toBe(2);
    expect(summary.avgAsleepMinutes).toBe(450);
    expect(summary.cumulativeSleepDebtMinutes).toBe(30);
    expect(summary.avgEfficiencyPct).toBe(93);
  });

  it('deduplicates sessions sharing the same start_time (legacy vs canonical ID)', () => {
    const sessions: SleepSessionRow[] = [
      {
        id: '2026-11-20:2026-11-20T03:35:00Z',
        date: '2026-11-20',
        start_time: '2026-11-20T03:35:00Z',
        end_time: '2026-11-20T11:36:00Z',
        duration_minutes: 481,
        asleep_minutes: 481,
        deep_minutes: 80,
        rem_minutes: 95,
        light_minutes: 306,
        awake_minutes: 20,
        efficiency_pct: 94,
        is_main_sleep: 1,
        updated_at: '2026-11-20T12:00:00Z',
      },
      {
        id: 'users/123/dataTypes/sleep/dataPoints/999',
        date: '2026-11-20',
        start_time: '2026-11-20T03:35:00Z',
        end_time: '2026-11-20T11:36:00Z',
        duration_minutes: 481,
        asleep_minutes: 481,
        deep_minutes: 80,
        rem_minutes: 95,
        light_minutes: 306,
        awake_minutes: 20,
        efficiency_pct: 94,
        is_main_sleep: 1,
        updated_at: '2026-11-21T01:50:00Z',
      },
    ];

    const summary = computeSleepSummary(sessions, 480);
    expect(summary.nightsCount).toBe(1);
    expect(summary.sessionsCount).toBe(1);
    expect(summary.avgAsleepMinutes).toBe(481);
    expect(summary.cumulativeSleepDebtMinutes).toBe(-1);
  });
});
