-- Initial schema for Google Health API v4 history (Fitbit Air / Pixel Watch)

CREATE TABLE IF NOT EXISTS daily_metrics (
  date TEXT PRIMARY KEY, -- YYYY-MM-DD (local civil date)
  steps INTEGER,
  distance_meters REAL,
  calories_kcal REAL,
  active_zone_minutes INTEGER,
  resting_hr_bpm REAL,
  hrv_rmssd_ms REAL,
  spo2_avg_pct REAL,
  spo2_min_pct REAL,
  respiratory_rate_bpm REAL,
  skin_temp_delta_c REAL,
  weight_kg REAL,
  body_fat_pct REAL,
  vo2_max REAL,
  sleep_total_minutes INTEGER,
  sleep_deep_minutes INTEGER,
  sleep_rem_minutes INTEGER,
  sleep_light_minutes INTEGER,
  sleep_awake_minutes INTEGER,
  sleep_efficiency_pct REAL,
  raw_json TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sleep_sessions (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL, -- YYYY-MM-DD wake-up / primary date
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  duration_minutes INTEGER,
  asleep_minutes INTEGER,
  deep_minutes INTEGER,
  rem_minutes INTEGER,
  light_minutes INTEGER,
  awake_minutes INTEGER,
  efficiency_pct REAL,
  is_main_sleep INTEGER DEFAULT 1,
  raw_json TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sleep_sessions_date ON sleep_sessions(date);

CREATE TABLE IF NOT EXISTS workouts (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL, -- YYYY-MM-DD
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  exercise_type TEXT,
  duration_minutes REAL,
  calories_kcal REAL,
  distance_meters REAL,
  avg_hr_bpm REAL,
  max_hr_bpm REAL,
  raw_json TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workouts_date ON workouts(date);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  trigger TEXT NOT NULL, -- 'cron' | 'manual'
  from_date TEXT NOT NULL,
  to_date TEXT NOT NULL,
  status TEXT NOT NULL, -- 'ok' | 'partial' | 'error'
  days_synced INTEGER DEFAULT 0,
  error_message TEXT
);
