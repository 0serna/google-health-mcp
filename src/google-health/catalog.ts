import { localDateStartUtcIso, shiftDays } from '../utils/dates';

export type RecordKind = 'interval' | 'daily' | 'sleep' | 'exercise' | 'instantaneous';

export interface HealthDataTypeSpec {
  /** Kebab-case identifier used in the Google Health API v4 URL path */
  dataType: string;
  /** Snake_case identifier used in AIP-160 filter expressions */
  filterPrefix: string;
  recordKind: RecordKind;
  scope: string;
  supportsDailyRollUp: boolean;
  description: string;
}

export const GOOGLE_HEALTH_SCOPES = {
  ACTIVITY: 'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  VITALS: 'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
  SLEEP: 'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
  PROFILE: 'https://www.googleapis.com/auth/googlehealth.profile.readonly',
  SETTINGS: 'https://www.googleapis.com/auth/googlehealth.settings.readonly',
  NUTRITION: 'https://www.googleapis.com/auth/googlehealth.nutrition.readonly',
} as const;

export const DEFAULT_READONLY_SCOPES: string[] = [
  GOOGLE_HEALTH_SCOPES.ACTIVITY,
  GOOGLE_HEALTH_SCOPES.VITALS,
  GOOGLE_HEALTH_SCOPES.SLEEP,
  GOOGLE_HEALTH_SCOPES.PROFILE,
  GOOGLE_HEALTH_SCOPES.SETTINGS,
];

export const DATA_TYPE_CATALOG: Record<string, HealthDataTypeSpec> = {
  steps: {
    dataType: 'steps',
    filterPrefix: 'steps',
    recordKind: 'interval',
    scope: GOOGLE_HEALTH_SCOPES.ACTIVITY,
    supportsDailyRollUp: true,
    description: 'Step counts by interval and daily rollup',
  },
  distance: {
    dataType: 'distance',
    filterPrefix: 'distance',
    recordKind: 'interval',
    scope: GOOGLE_HEALTH_SCOPES.ACTIVITY,
    supportsDailyRollUp: true,
    description: 'Distance traveled in meters',
  },
  'calories-in-heart-rate-zone': {
    dataType: 'calories-in-heart-rate-zone',
    filterPrefix: 'calories_in_heart_rate_zone',
    recordKind: 'interval',
    scope: GOOGLE_HEALTH_SCOPES.ACTIVITY,
    supportsDailyRollUp: true,
    description: 'Calories burned per heart rate zone',
  },
  'total-calories': {
    dataType: 'total-calories',
    filterPrefix: 'total_calories',
    recordKind: 'interval',
    scope: GOOGLE_HEALTH_SCOPES.ACTIVITY,
    supportsDailyRollUp: true,
    description: 'Total calories burned (BMR + activity)',
  },
  'active-zone-minutes': {
    dataType: 'active-zone-minutes',
    filterPrefix: 'active_zone_minutes',
    recordKind: 'interval',
    scope: GOOGLE_HEALTH_SCOPES.ACTIVITY,
    supportsDailyRollUp: true,
    description: 'Active zone minutes across fat burn, cardio, and peak zones',
  },
  exercise: {
    dataType: 'exercise',
    filterPrefix: 'exercise',
    recordKind: 'exercise',
    scope: GOOGLE_HEALTH_SCOPES.ACTIVITY,
    supportsDailyRollUp: false,
    description: 'Workout / exercise sessions (auto-detected or logged)',
  },
  'vo2-max': {
    dataType: 'vo2-max',
    filterPrefix: 'vo2_max',
    recordKind: 'instantaneous',
    scope: GOOGLE_HEALTH_SCOPES.ACTIVITY,
    supportsDailyRollUp: false,
    description: 'VO2 Max cardio fitness estimate',
  },
  sleep: {
    dataType: 'sleep',
    filterPrefix: 'sleep',
    recordKind: 'sleep',
    scope: GOOGLE_HEALTH_SCOPES.SLEEP,
    supportsDailyRollUp: false,
    description: 'Sleep sessions and stages (deep, REM, light, awake)',
  },
  'heart-rate': {
    dataType: 'heart-rate',
    filterPrefix: 'heart_rate',
    recordKind: 'instantaneous',
    scope: GOOGLE_HEALTH_SCOPES.VITALS,
    supportsDailyRollUp: true,
    description: 'Continuous intraday heart rate samples',
  },
  'daily-resting-heart-rate': {
    dataType: 'daily-resting-heart-rate',
    filterPrefix: 'daily_resting_heart_rate',
    recordKind: 'daily',
    scope: GOOGLE_HEALTH_SCOPES.VITALS,
    supportsDailyRollUp: false,
    description: 'Daily resting heart rate (RHR)',
  },
  'heart-rate-variability': {
    dataType: 'heart-rate-variability',
    filterPrefix: 'heart_rate_variability',
    recordKind: 'interval',
    scope: GOOGLE_HEALTH_SCOPES.VITALS,
    supportsDailyRollUp: false,
    description: 'Intraday heart rate variability (HRV)',
  },
  'daily-heart-rate-variability': {
    dataType: 'daily-heart-rate-variability',
    filterPrefix: 'daily_heart_rate_variability',
    recordKind: 'daily',
    scope: GOOGLE_HEALTH_SCOPES.VITALS,
    supportsDailyRollUp: false,
    description: 'Daily HRV summary (nightly RMSSD)',
  },
  'oxygen-saturation': {
    dataType: 'oxygen-saturation',
    filterPrefix: 'oxygen_saturation',
    recordKind: 'interval',
    scope: GOOGLE_HEALTH_SCOPES.VITALS,
    supportsDailyRollUp: false,
    description: 'Intraday blood oxygen saturation (SpO2)',
  },
  'daily-oxygen-saturation': {
    dataType: 'daily-oxygen-saturation',
    filterPrefix: 'daily_oxygen_saturation',
    recordKind: 'daily',
    scope: GOOGLE_HEALTH_SCOPES.VITALS,
    supportsDailyRollUp: false,
    description: 'Daily SpO2 summary (avg/min/max)',
  },
  'daily-respiratory-rate': {
    dataType: 'daily-respiratory-rate',
    filterPrefix: 'daily_respiratory_rate',
    recordKind: 'daily',
    scope: GOOGLE_HEALTH_SCOPES.VITALS,
    supportsDailyRollUp: false,
    description: 'Daily nocturnal respiratory rate',
  },
  'daily-sleep-temperature-derivations': {
    dataType: 'daily-sleep-temperature-derivations',
    filterPrefix: 'daily_sleep_temperature_derivations',
    recordKind: 'daily',
    scope: GOOGLE_HEALTH_SCOPES.VITALS,
    supportsDailyRollUp: false,
    description: 'Nightly skin temperature deviation from personal baseline',
  },
  weight: {
    dataType: 'weight',
    filterPrefix: 'weight',
    recordKind: 'instantaneous',
    scope: GOOGLE_HEALTH_SCOPES.VITALS,
    supportsDailyRollUp: false,
    description: 'Body weight measurements',
  },
  'body-fat': {
    dataType: 'body-fat',
    filterPrefix: 'body_fat',
    recordKind: 'instantaneous',
    scope: GOOGLE_HEALTH_SCOPES.VITALS,
    supportsDailyRollUp: false,
    description: 'Body fat percentage measurements',
  },
};

const DATA_TYPE_REGEX = /^[a-z0-9-]+$/;

export function assertValidDataType(dataType: string): void {
  if (!DATA_TYPE_REGEX.test(dataType)) {
    throw new Error(`Invalid dataType "${dataType}". Use lowercase kebab-case (letters, digits, hyphens).`);
  }
}

export function kebabToSnake(value: string): string {
  return value.replace(/-/g, '_');
}

/**
 * Builds a Google Health API v4 AIP-160 filter expression.
 * Enforces >= and < comparators only, snake_case field prefixes, and data-type-specific
 * time fields per the official v4 specification.
 */
export function buildTimeRangeFilter(
  dataType: string,
  fromDate: string,
  toDate: string,
  overrideKind?: RecordKind,
  timeZone = 'UTC',
): string {
  assertValidDataType(dataType);
  const spec = DATA_TYPE_CATALOG[dataType];
  const prefix = spec?.filterPrefix ?? kebabToSnake(dataType);
  const kind = overrideKind ?? spec?.recordKind ?? 'interval';
  const startDate = fromDate.slice(0, 10);
  const exclusiveEndDate = shiftDays(toDate.slice(0, 10), 1);

  if (kind === 'daily') {
    return `${prefix}.date >= "${startDate}" AND ${prefix}.date < "${exclusiveEndDate}"`;
  }

  if (kind === 'exercise') {
    return `${prefix}.interval.civil_start_time >= "${startDate}" AND ${prefix}.interval.civil_start_time < "${exclusiveEndDate}"`;
  }

  const startIso = fromDate.includes('T') ? fromDate : localDateStartUtcIso(startDate, timeZone);
  const endIso = toDate.includes('T') ? toDate : localDateStartUtcIso(exclusiveEndDate, timeZone);

  if (kind === 'sleep') {
    return `${prefix}.interval.end_time >= "${startIso}" AND ${prefix}.interval.end_time < "${endIso}"`;
  }

  if (kind === 'instantaneous') {
    return `${prefix}.sample_time.physical_time >= "${startIso}" AND ${prefix}.sample_time.physical_time < "${endIso}"`;
  }

  return `${prefix}.interval.start_time >= "${startIso}" AND ${prefix}.interval.start_time < "${endIso}"`;
}
