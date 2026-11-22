import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER?: OAuthHelpers;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  PUBLIC_BASE_URL: string;
  MCP_API_KEY: string;
  ALLOWED_GOOGLE_EMAIL?: string;
  DEFAULT_TIMEZONE?: string;
  SLEEP_GOAL_MINUTES?: string;
}

export interface StoredGoogleTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  grantedAt: number; // epoch ms (used to warn before the 7-day Testing-mode refresh limit)
  scope: string;
  tokenType: string;
}

export interface DailyMetricRow {
  date: string; // YYYY-MM-DD
  steps: number | null;
  distance_meters: number | null;
  calories_kcal: number | null;
  active_zone_minutes: number | null;
  resting_hr_bpm: number | null;
  hrv_rmssd_ms: number | null;
  spo2_avg_pct: number | null;
  spo2_min_pct: number | null;
  respiratory_rate_bpm: number | null;
  skin_temp_delta_c: number | null;
  weight_kg: number | null;
  body_fat_pct: number | null;
  vo2_max: number | null;
  sleep_total_minutes: number | null;
  sleep_deep_minutes: number | null;
  sleep_rem_minutes: number | null;
  sleep_light_minutes: number | null;
  sleep_awake_minutes: number | null;
  sleep_efficiency_pct: number | null;
  raw_json?: string | null;
  updated_at: string;
}

export interface SleepSessionRow {
  id: string;
  date: string;
  start_time: string;
  end_time: string;
  duration_minutes: number | null;
  asleep_minutes: number | null;
  deep_minutes: number | null;
  rem_minutes: number | null;
  light_minutes: number | null;
  awake_minutes: number | null;
  efficiency_pct: number | null;
  is_main_sleep: number;
  raw_json?: string | null;
  updated_at: string;
}

export interface WorkoutRow {
  id: string;
  date: string;
  start_time: string;
  end_time: string;
  exercise_type: string | null;
  duration_minutes: number | null;
  calories_kcal: number | null;
  distance_meters: number | null;
  avg_hr_bpm: number | null;
  max_hr_bpm: number | null;
  raw_json?: string | null;
  updated_at: string;
}

export interface SyncRunRow {
  id?: number;
  started_at: string;
  finished_at: string | null;
  trigger: 'cron' | 'manual';
  from_date: string;
  to_date: string;
  status: 'ok' | 'partial' | 'error';
  days_synced: number;
  error_message: string | null;
}

export interface MetricBaselineAnalysis {
  metric: string;
  unit: string;
  latestDate: string | null;
  latestValue: number | null;
  recent7dAvg: number | null;
  baseline30dAvg: number | null;
  baseline30dStdDev: number | null;
  deltaPct: number | null;
  zScore: number | null;
  status: 'normal' | 'above_baseline' | 'below_baseline' | 'insufficient_data';
  sampleCount30d: number;
  stale: boolean;
}
