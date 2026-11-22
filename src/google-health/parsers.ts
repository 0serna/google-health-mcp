import type { DailyMetricRow, SleepSessionRow, WorkoutRow } from '../types';
import { isoTimestampToLocalDate } from '../utils/dates';

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function formatCivilDate(obj: unknown): string | null {
  const rec = asRecord(obj);
  if (!rec) return null;
  const dateObj = asRecord(rec.date) ?? rec;
  const year = asNumber(dateObj.year);
  const month = asNumber(dateObj.month);
  const day = asNumber(dateObj.day);
  if (year && month && day) {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return null;
}

/**
 * Extracts a YYYY-MM-DD civil date from a Google Health API v4 data point or rollup point.
 * Checks civilStartTime (both nested under interval and top-level), then date, then falls back
 * to converting physical timestamps into the configured local timezone.
 */
export function extractDateFromRecord(obj: Record<string, unknown>, timeZone = 'UTC'): string | null {
  const interval = asRecord(obj.interval);

  const fromIntervalCivil =
    (typeof interval?.civilStartTime === 'string' && /^\d{4}-\d{2}-\d{2}/.test(interval.civilStartTime)
      ? interval.civilStartTime.slice(0, 10)
      : formatCivilDate(interval?.civilStartTime)) ??
    (typeof interval?.civilEndTime === 'string' && /^\d{4}-\d{2}-\d{2}/.test(interval.civilEndTime)
      ? interval.civilEndTime.slice(0, 10)
      : formatCivilDate(interval?.civilEndTime));
  if (fromIntervalCivil) return fromIntervalCivil;

  const fromTopCivil =
    typeof obj.civilStartTime === 'string' && /^\d{4}-\d{2}-\d{2}/.test(obj.civilStartTime)
      ? obj.civilStartTime.slice(0, 10)
      : formatCivilDate(obj.civilStartTime);
  if (fromTopCivil) return fromTopCivil;

  if (typeof obj.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(obj.date)) {
    return obj.date.slice(0, 10);
  }
  const fromDateObj = formatCivilDate(obj.date);
  if (fromDateObj) return fromDateObj;

  const ts =
    (typeof interval?.endTime === 'string' ? interval.endTime : null) ??
    (typeof interval?.startTime === 'string' ? interval.startTime : null) ??
    (typeof obj.startTime === 'string' ? obj.startTime : null);
  if (ts) {
    return isoTimestampToLocalDate(ts, timeZone) ?? ( /^\d{4}-\d{2}-\d{2}/.test(ts) ? ts.slice(0, 10) : null );
  }

  return null;
}

function getNestedNumber(root: Record<string, unknown>, paths: string[][]): number | null {
  for (const path of paths) {
    let cursor: unknown = root;
    for (const key of path) {
      const rec = asRecord(cursor);
      if (!rec || !(key in rec)) {
        cursor = undefined;
        break;
      }
      cursor = rec[key];
    }
    const n = asNumber(cursor);
    if (n !== null) return n;
  }
  return null;
}

function unwrapPayload(dp: Record<string, unknown>, preferredKey: string): Record<string, unknown> {
  return asRecord(dp[preferredKey]) ?? asRecord(dp.value) ?? dp;
}

export function applyRollupPoint(
  dataType: string,
  row: Partial<DailyMetricRow>,
  point: Record<string, unknown>,
): void {
  const payload = asRecord(point.value) ?? point;

  switch (dataType) {
    case 'steps': {
      row.steps = getNestedNumber(payload, [
        ['steps', 'countSum'],
        ['countSum'],
        ['steps', 'count'],
        ['count'],
      ]);
      break;
    }
    case 'distance': {
      const mm = getNestedNumber(payload, [
        ['distance', 'millimetersSum'],
        ['millimetersSum'],
        ['distanceMillimetersSum'],
      ]);
      if (mm !== null) {
        row.distance_meters = Math.round((mm / 1000) * 10) / 10;
      } else {
        row.distance_meters = getNestedNumber(payload, [
          ['distance', 'metersSum'],
          ['metersSum'],
          ['distanceMeters'],
        ]);
      }
      break;
    }
    case 'total-calories': {
      row.calories_kcal = getNestedNumber(payload, [
        ['totalCalories', 'kcalSum'],
        ['kcalSum'],
        ['kilocaloriesSum'],
        ['caloriesSum'],
        ['kcal'],
      ]);
      break;
    }
    case 'active-zone-minutes': {
      const azm = asRecord(payload.activeZoneMinutes) ?? payload;
      const fatBurn = asNumber(azm.sumInFatBurnHeartZone) ?? 0;
      const cardio = asNumber(azm.sumInCardioHeartZone) ?? 0;
      const peak = asNumber(azm.sumInPeakHeartZone) ?? 0;
      const zoneTotal = fatBurn + cardio + peak;
      if (zoneTotal > 0) {
        row.active_zone_minutes = Math.round(zoneTotal);
      } else {
        row.active_zone_minutes = getNestedNumber(azm, [
          ['activeZoneMinutesSum'],
          ['minutesSum'],
          ['countSum'],
        ]);
      }
      break;
    }
  }
}

export function applyDailyVitalPoint(
  dataType: string,
  row: Partial<DailyMetricRow>,
  dp: Record<string, unknown>,
): void {
  switch (dataType) {
    case 'daily-resting-heart-rate': {
      const p = unwrapPayload(dp, 'dailyRestingHeartRate');
      row.resting_hr_bpm = getNestedNumber(p, [['beatsPerMinute'], ['bpm']]);
      break;
    }
    case 'daily-heart-rate-variability': {
      const p = unwrapPayload(dp, 'dailyHeartRateVariability');
      row.hrv_rmssd_ms = getNestedNumber(p, [
        ['averageHeartRateVariabilityMilliseconds'],
        ['averageRmssdMilliseconds'],
        ['rmssdMilliseconds'],
      ]);
      break;
    }
    case 'daily-oxygen-saturation': {
      const p = unwrapPayload(dp, 'dailyOxygenSaturation');
      row.spo2_avg_pct = getNestedNumber(p, [['averagePercentage'], ['averageSpo2'], ['percentage']]);
      row.spo2_min_pct = getNestedNumber(p, [['lowerBoundPercentage'], ['minPercentage'], ['minSpo2']]);
      break;
    }
    case 'daily-respiratory-rate': {
      const p = unwrapPayload(dp, 'dailyRespiratoryRate');
      row.respiratory_rate_bpm = getNestedNumber(p, [
        ['breathsPerMinute'],
        ['averageBreathsPerMinute'],
        ['rate'],
      ]);
      break;
    }
    case 'daily-sleep-temperature-derivations': {
      const p = unwrapPayload(dp, 'dailySleepTemperatureDerivations');
      const nightly = getNestedNumber(p, [['nightlyTemperatureCelsius']]);
      const baseline = getNestedNumber(p, [['baselineTemperatureCelsius']]);
      if (nightly !== null && baseline !== null) {
        row.skin_temp_delta_c = Math.round((nightly - baseline) * 100) / 100;
      } else {
        row.skin_temp_delta_c = getNestedNumber(p, [
          ['relativeTemperatureCelsius'],
          ['deltaCelsius'],
          ['baselineRelativeCelsius'],
        ]);
      }
      break;
    }
  }
}

export interface ParsedSleepSession {
  session: SleepSessionRow;
  explicitMainSleep: boolean | null;
}

export function parseSleepPoint(
  dp: Record<string, unknown>,
  nowIso: string,
  timeZone = 'UTC',
): ParsedSleepSession | null {
  const sleepObj = asRecord(dp.sleep) ?? dp;
  const interval = asRecord(sleepObj.interval) ?? {};
  const startTime = typeof interval.startTime === 'string' ? interval.startTime : '';
  const endTime = typeof interval.endTime === 'string' ? interval.endTime : '';
  const date = extractDateFromRecord(sleepObj, timeZone) ?? extractDateFromRecord(dp, timeZone);
  if (!date || !startTime) return null;

  const summary = asRecord(sleepObj.summary) ?? {};
  const stages = Array.isArray(sleepObj.stages)
    ? (sleepObj.stages as Array<{ startTime?: string; endTime?: string; type?: string }>)
    : [];

  let stageDeep = 0;
  let stageRem = 0;
  let stageLight = 0;
  let stageAwake = 0;
  for (const st of stages) {
    if (!st.startTime || !st.endTime || !st.type) continue;
    const mins = (new Date(st.endTime).getTime() - new Date(st.startTime).getTime()) / 60_000;
    if (!Number.isFinite(mins) || mins <= 0) continue;
    const t = st.type.toUpperCase();
    if (t === 'DEEP') stageDeep += mins;
    else if (t === 'REM') stageRem += mins;
    else if (t === 'LIGHT') stageLight += mins;
    else if (t === 'AWAKE') stageAwake += mins;
  }

  const deepMin = getNestedNumber(summary, [['deepMinutes'], ['stagesSummary', 'deepMinutes']]) ?? (stageDeep > 0 ? stageDeep : null);
  const remMin = getNestedNumber(summary, [['remMinutes'], ['stagesSummary', 'remMinutes']]) ?? (stageRem > 0 ? stageRem : null);
  const lightMin = getNestedNumber(summary, [['lightMinutes'], ['stagesSummary', 'lightMinutes']]) ?? (stageLight > 0 ? stageLight : null);
  const awakeMin =
    getNestedNumber(summary, [['awakeMinutes'], ['minutesAwake'], ['stagesSummary', 'awakeMinutes']]) ??
    (stageAwake > 0 ? stageAwake : null);

  const durationMin =
    startTime && endTime
      ? Math.round((new Date(endTime).getTime() - new Date(startTime).getTime()) / 60_000)
      : null;

  const stageAsleep = stageDeep + stageRem + stageLight;
  const asleepMin =
    getNestedNumber(summary, [['minutesAsleep'], ['asleepMinutes'], ['totalSleepMinutes']]) ??
    (stageAsleep > 0 ? stageAsleep : durationMin);

  const efficiency =
    getNestedNumber(summary, [['efficiency'], ['efficiencyPercentage']]) ??
    (asleepMin !== null && durationMin !== null && durationMin > 0
      ? Math.round((asleepMin / durationMin) * 1000) / 10
      : null);

  const explicitMainSleep =
    typeof sleepObj.isMainSleep === 'boolean' ? sleepObj.isMainSleep : null;

  const session: SleepSessionRow = {
    id: String(dp.dataPointName ?? dp.name ?? dp.id ?? `${date}:${startTime}`),
    date,
    start_time: startTime,
    end_time: endTime || startTime,
    duration_minutes: durationMin !== null ? Math.round(durationMin) : null,
    asleep_minutes: asleepMin !== null ? Math.round(asleepMin) : null,
    deep_minutes: deepMin !== null ? Math.round(deepMin) : null,
    rem_minutes: remMin !== null ? Math.round(remMin) : null,
    light_minutes: lightMin !== null ? Math.round(lightMin) : null,
    awake_minutes: awakeMin !== null ? Math.round(awakeMin) : null,
    efficiency_pct: efficiency,
    is_main_sleep: explicitMainSleep === false ? 0 : 1,
    raw_json: JSON.stringify(dp),
    updated_at: nowIso,
  };

  return { session, explicitMainSleep };
}

/**
 * Resolves is_main_sleep across all sessions for each date:
 * if Google did not provide isMainSleep explicitly, only the longest session of each day is marked as main sleep.
 */
export function resolveMainSleepFlags(parsed: ParsedSleepSession[]): SleepSessionRow[] {
  const byDate = new Map<string, ParsedSleepSession[]>();
  for (const item of parsed) {
    const list = byDate.get(item.session.date) ?? [];
    list.push(item);
    byDate.set(item.session.date, list);
  }

  for (const items of byDate.values()) {
    if (items.length <= 1) {
      if (items[0] && items[0].explicitMainSleep === null) {
        items[0].session.is_main_sleep = 1;
      }
      continue;
    }

    const hasExplicitMain = items.some((i) => i.explicitMainSleep === true);
    if (hasExplicitMain) {
      for (const item of items) {
        item.session.is_main_sleep = item.explicitMainSleep === true ? 1 : 0;
      }
      continue;
    }

    let longestIdx = 0;
    let longestMins = -1;
    for (let i = 0; i < items.length; i++) {
      const mins = items[i].session.asleep_minutes ?? items[i].session.duration_minutes ?? 0;
      if (mins > longestMins) {
        longestMins = mins;
        longestIdx = i;
      }
    }
    for (let i = 0; i < items.length; i++) {
      items[i].session.is_main_sleep = i === longestIdx ? 1 : 0;
    }
  }

  return parsed.map((p) => p.session);
}

export function parseWorkoutPoint(
  dp: Record<string, unknown>,
  nowIso: string,
  timeZone = 'UTC',
): WorkoutRow | null {
  const exObj = asRecord(dp.exercise) ?? dp;
  const interval = asRecord(exObj.interval) ?? asRecord(exObj.session) ?? {};
  const startTime = typeof interval.startTime === 'string' ? interval.startTime : '';
  const endTime = typeof interval.endTime === 'string' ? interval.endTime : '';
  const date =
    extractDateFromRecord(exObj, timeZone) ??
    extractDateFromRecord(dp, timeZone) ??
    (startTime ? isoTimestampToLocalDate(startTime, timeZone) : null);
  if (!date || !startTime) return null;

  const durationMin =
    startTime && endTime
      ? Math.round(((new Date(endTime).getTime() - new Date(startTime).getTime()) / 60_000) * 10) / 10
      : getNestedNumber(exObj, [['metricsSummary', 'activeDurationMinutes'], ['activeDurationMinutes'], ['durationMinutes']]);

  const distanceMm = getNestedNumber(exObj, [
    ['metricsSummary', 'distanceMillimeters'],
    ['distanceMillimeters'],
  ]);
  const distanceMeters =
    distanceMm !== null
      ? Math.round((distanceMm / 1000) * 10) / 10
      : getNestedNumber(exObj, [['metricsSummary', 'distanceMeters'], ['distanceMeters']]);

  return {
    id: String(dp.dataPointName ?? dp.name ?? dp.id ?? `${date}:${startTime}`),
    date,
    start_time: startTime,
    end_time: endTime || startTime,
    exercise_type: String(exObj.exerciseType ?? exObj.displayName ?? exObj.type ?? 'UNKNOWN'),
    duration_minutes: durationMin,
    calories_kcal: getNestedNumber(exObj, [
      ['metricsSummary', 'caloriesKcal'],
      ['caloriesKcal'],
      ['metricsSummary', 'totalCalories'],
      ['totalCalories'],
      ['calories'],
    ]),
    distance_meters: distanceMeters,
    avg_hr_bpm: getNestedNumber(exObj, [
      ['metricsSummary', 'averageHeartRateBeatsPerMinute'],
      ['averageHeartRateBeatsPerMinute'],
      ['metricsSummary', 'averageHeartRateBpm'],
      ['averageHeartRateBpm'],
      ['averageHeartRate'],
    ]),
    max_hr_bpm: getNestedNumber(exObj, [
      ['metricsSummary', 'maxHeartRateBeatsPerMinute'],
      ['maxHeartRateBeatsPerMinute'],
      ['metricsSummary', 'maxHeartRateBpm'],
      ['maxHeartRateBpm'],
      ['maxHeartRate'],
    ]),
    raw_json: JSON.stringify(dp),
    updated_at: nowIso,
  };
}
