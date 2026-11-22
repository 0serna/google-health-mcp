import type { DailyMetricRow, MetricBaselineAnalysis, SleepSessionRow } from '../types';
import { daysBetweenInclusive, shiftDays } from '../utils/dates';

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

export function stdDev(values: number[]): number | null {
  if (values.length < 2) return null;
  const avg = mean(values)!;
  const variance = values.reduce((acc, v) => acc + (v - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function round(value: number | null, decimals = 2): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Computes 7-day trend vs. 30-day personal baseline and z-score for a daily metric.
 * Uses calendar-day windows and excludes the recent 7-day window from the 30-day baseline
 * when enough prior samples exist (falling back to excluding only the latest point for shorter histories).
 */
export function computeBaselineAnalysis(
  rowsAsc: DailyMetricRow[],
  metric: keyof DailyMetricRow,
  label: string,
  unit: string,
  referenceDate?: string,
): MetricBaselineAnalysis {
  const valid = rowsAsc
    .map((r) => ({ date: r.date, value: r[metric] }))
    .filter((x): x is { date: string; value: number } => typeof x.value === 'number' && Number.isFinite(x.value));

  if (valid.length === 0) {
    return {
      metric: label,
      unit,
      latestDate: null,
      latestValue: null,
      recent7dAvg: null,
      baseline30dAvg: null,
      baseline30dStdDev: null,
      deltaPct: null,
      zScore: null,
      status: 'insufficient_data',
      sampleCount30d: 0,
      stale: false,
    };
  }

  const latest = valid[valid.length - 1];
  const ref = referenceDate ?? latest.date;
  const recentStart = shiftDays(ref, -6);
  const baselineStart = shiftDays(ref, -36);
  const baselineEnd = shiftDays(ref, -7);

  const recent7 = valid
    .filter((v) => v.date >= recentStart && v.date <= ref)
    .map((v) => v.value);

  const prior30 = valid
    .filter((v) => v.date >= baselineStart && v.date <= baselineEnd)
    .map((v) => v.value);

  // If fewer than 5 samples exist strictly before the 7-day window, fall back to all prior samples excluding latest.
  const baseline30 =
    prior30.length >= 5
      ? prior30
      : valid
          .slice(0, -1)
          .slice(-30)
          .map((v) => v.value);

  const avg7 = mean(recent7);
  const avg30 = mean(baseline30);
  const sd30 = stdDev(baseline30);

  const deltaPct = avg7 !== null && avg30 !== null && avg30 !== 0 ? ((avg7 - avg30) / avg30) * 100 : null;
  const zScore =
    avg30 !== null && sd30 !== null && sd30 > 0 ? (latest.value - avg30) / sd30 : null;

  let status: MetricBaselineAnalysis['status'] = 'normal';
  if (baseline30.length < 5 || zScore === null) {
    status = 'insufficient_data';
  } else if (zScore >= 1.25) {
    status = 'above_baseline';
  } else if (zScore <= -1.25) {
    status = 'below_baseline';
  }

  const stale = latest.date < ref && daysBetweenInclusive(latest.date, ref) - 1 > 3;

  return {
    metric: label,
    unit,
    latestDate: latest.date,
    latestValue: round(latest.value),
    recent7dAvg: round(avg7),
    baseline30dAvg: round(avg30),
    baseline30dStdDev: round(sd30),
    deltaPct: round(deltaPct, 1),
    zScore: round(zScore, 2),
    status,
    sampleCount30d: baseline30.length,
    stale,
  };
}

/**
 * Aggregates sleep sessions by calendar date so naps add to that day's total sleep
 * instead of being counted as separate nights with full sleep-goal debt.
 */
export function computeSleepSummary(sessions: SleepSessionRow[], sleepGoalMinutes: number) {
  // Deduplicate sessions with the same start_time (e.g. legacy synthetic ID + canonical API dataPointName).
  const uniqueByStart = new Map<string, SleepSessionRow>();
  for (const s of sessions) {
    const existing = uniqueByStart.get(s.start_time);
    if (!existing) {
      uniqueByStart.set(s.start_time, s);
      continue;
    }
    const sIsCanonical = s.id.startsWith('users/');
    const existingIsCanonical = existing.id.startsWith('users/');
    if ((sIsCanonical && !existingIsCanonical) || (sIsCanonical === existingIsCanonical && s.updated_at > existing.updated_at)) {
      uniqueByStart.set(s.start_time, s);
    }
  }
  const dedupedSessions = Array.from(uniqueByStart.values());

  const byDate = new Map<
    string,
    {
      asleepMinutes: number;
      deepMinutes: number;
      hasDeep: boolean;
      remMinutes: number;
      hasRem: boolean;
      lightMinutes: number;
      hasLight: boolean;
      efficiencyPct: number | null;
      hasMainEfficiency: boolean;
    }
  >();

  for (const s of dedupedSessions) {
    const entry = byDate.get(s.date) ?? {
      asleepMinutes: 0,
      deepMinutes: 0,
      hasDeep: false,
      remMinutes: 0,
      hasRem: false,
      lightMinutes: 0,
      hasLight: false,
      efficiencyPct: null,
      hasMainEfficiency: false,
    };

    const asleep = s.asleep_minutes ?? s.duration_minutes;
    if (typeof asleep === 'number') {
      entry.asleepMinutes += asleep;
    }
    if (typeof s.deep_minutes === 'number') {
      entry.deepMinutes += s.deep_minutes;
      entry.hasDeep = true;
    }
    if (typeof s.rem_minutes === 'number') {
      entry.remMinutes += s.rem_minutes;
      entry.hasRem = true;
    }
    if (typeof s.light_minutes === 'number') {
      entry.lightMinutes += s.light_minutes;
      entry.hasLight = true;
    }
    if (typeof s.efficiency_pct === 'number') {
      if (s.is_main_sleep === 1 || !entry.hasMainEfficiency) {
        entry.efficiencyPct = s.efficiency_pct;
        if (s.is_main_sleep === 1) entry.hasMainEfficiency = true;
      }
    }

    byDate.set(s.date, entry);
  }

  const days = Array.from(byDate.values());
  const asleepList = days.map((d) => d.asleepMinutes).filter((v) => v > 0);
  const deepList = days.filter((d) => d.hasDeep).map((d) => d.deepMinutes);
  const remList = days.filter((d) => d.hasRem).map((d) => d.remMinutes);
  const lightList = days.filter((d) => d.hasLight).map((d) => d.lightMinutes);
  const effList = days.map((d) => d.efficiencyPct).filter((v): v is number => v !== null);

  const avgAsleep = mean(asleepList);
  const totalDebtMinutes = asleepList.reduce((acc, mins) => acc + (sleepGoalMinutes - mins), 0);

  return {
    nightsCount: days.length,
    sessionsCount: dedupedSessions.length,
    sleepGoalMinutes,
    avgAsleepMinutes: round(avgAsleep, 1),
    avgAsleepHours: avgAsleep !== null ? round(avgAsleep / 60, 2) : null,
    cumulativeSleepDebtMinutes: Math.round(totalDebtMinutes),
    cumulativeSleepDebtHours: round(totalDebtMinutes / 60, 2),
    avgDeepMinutes: round(mean(deepList), 1),
    avgRemMinutes: round(mean(remList), 1),
    avgLightMinutes: round(mean(lightList), 1),
    avgEfficiencyPct: round(mean(effList), 1),
  };
}
