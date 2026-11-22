import type { DailyMetricRow, SleepSessionRow, SyncRunRow, WorkoutRow } from '../types';

export class HealthRepository {
  constructor(private readonly db: D1Database) {}

  prepareUpsertDailyMetric(row: Partial<DailyMetricRow> & { date: string }): D1PreparedStatement {
    const now = new Date().toISOString();
    return this.db
      .prepare(
        `INSERT INTO daily_metrics (
          date, steps, distance_meters, calories_kcal, active_zone_minutes,
          resting_hr_bpm, hrv_rmssd_ms, spo2_avg_pct, spo2_min_pct,
          respiratory_rate_bpm, skin_temp_delta_c, weight_kg, body_fat_pct, vo2_max,
          sleep_total_minutes, sleep_deep_minutes, sleep_rem_minutes, sleep_light_minutes,
          sleep_awake_minutes, sleep_efficiency_pct, raw_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(date) DO UPDATE SET
          steps = COALESCE(excluded.steps, daily_metrics.steps),
          distance_meters = COALESCE(excluded.distance_meters, daily_metrics.distance_meters),
          calories_kcal = COALESCE(excluded.calories_kcal, daily_metrics.calories_kcal),
          active_zone_minutes = COALESCE(excluded.active_zone_minutes, daily_metrics.active_zone_minutes),
          resting_hr_bpm = COALESCE(excluded.resting_hr_bpm, daily_metrics.resting_hr_bpm),
          hrv_rmssd_ms = COALESCE(excluded.hrv_rmssd_ms, daily_metrics.hrv_rmssd_ms),
          spo2_avg_pct = COALESCE(excluded.spo2_avg_pct, daily_metrics.spo2_avg_pct),
          spo2_min_pct = COALESCE(excluded.spo2_min_pct, daily_metrics.spo2_min_pct),
          respiratory_rate_bpm = COALESCE(excluded.respiratory_rate_bpm, daily_metrics.respiratory_rate_bpm),
          skin_temp_delta_c = COALESCE(excluded.skin_temp_delta_c, daily_metrics.skin_temp_delta_c),
          weight_kg = COALESCE(excluded.weight_kg, daily_metrics.weight_kg),
          body_fat_pct = COALESCE(excluded.body_fat_pct, daily_metrics.body_fat_pct),
          vo2_max = COALESCE(excluded.vo2_max, daily_metrics.vo2_max),
          sleep_total_minutes = COALESCE(excluded.sleep_total_minutes, daily_metrics.sleep_total_minutes),
          sleep_deep_minutes = COALESCE(excluded.sleep_deep_minutes, daily_metrics.sleep_deep_minutes),
          sleep_rem_minutes = COALESCE(excluded.sleep_rem_minutes, daily_metrics.sleep_rem_minutes),
          sleep_light_minutes = COALESCE(excluded.sleep_light_minutes, daily_metrics.sleep_light_minutes),
          sleep_awake_minutes = COALESCE(excluded.sleep_awake_minutes, daily_metrics.sleep_awake_minutes),
          sleep_efficiency_pct = COALESCE(excluded.sleep_efficiency_pct, daily_metrics.sleep_efficiency_pct),
          raw_json = COALESCE(excluded.raw_json, daily_metrics.raw_json),
          updated_at = excluded.updated_at`,
      )
      .bind(
        row.date,
        row.steps ?? null,
        row.distance_meters ?? null,
        row.calories_kcal ?? null,
        row.active_zone_minutes ?? null,
        row.resting_hr_bpm ?? null,
        row.hrv_rmssd_ms ?? null,
        row.spo2_avg_pct ?? null,
        row.spo2_min_pct ?? null,
        row.respiratory_rate_bpm ?? null,
        row.skin_temp_delta_c ?? null,
        row.weight_kg ?? null,
        row.body_fat_pct ?? null,
        row.vo2_max ?? null,
        row.sleep_total_minutes ?? null,
        row.sleep_deep_minutes ?? null,
        row.sleep_rem_minutes ?? null,
        row.sleep_light_minutes ?? null,
        row.sleep_awake_minutes ?? null,
        row.sleep_efficiency_pct ?? null,
        row.raw_json ?? null,
        row.updated_at ?? now,
      );
  }

  prepareDeleteSleepDuplicates(session: SleepSessionRow): D1PreparedStatement {
    return this.db
      .prepare(`DELETE FROM sleep_sessions WHERE start_time = ? AND id != ?`)
      .bind(session.start_time, session.id);
  }

  prepareUpsertSleepSession(session: SleepSessionRow): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO sleep_sessions (
          id, date, start_time, end_time, duration_minutes, asleep_minutes,
          deep_minutes, rem_minutes, light_minutes, awake_minutes,
          efficiency_pct, is_main_sleep, raw_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          date = excluded.date,
          start_time = excluded.start_time,
          end_time = excluded.end_time,
          duration_minutes = excluded.duration_minutes,
          asleep_minutes = excluded.asleep_minutes,
          deep_minutes = excluded.deep_minutes,
          rem_minutes = excluded.rem_minutes,
          light_minutes = excluded.light_minutes,
          awake_minutes = excluded.awake_minutes,
          efficiency_pct = excluded.efficiency_pct,
          is_main_sleep = excluded.is_main_sleep,
          raw_json = excluded.raw_json,
          updated_at = excluded.updated_at`,
      )
      .bind(
        session.id,
        session.date,
        session.start_time,
        session.end_time,
        session.duration_minutes,
        session.asleep_minutes,
        session.deep_minutes,
        session.rem_minutes,
        session.light_minutes,
        session.awake_minutes,
        session.efficiency_pct,
        session.is_main_sleep,
        session.raw_json ?? null,
        session.updated_at,
      );
  }

  prepareUpsertWorkout(workout: WorkoutRow): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO workouts (
          id, date, start_time, end_time, exercise_type,
          duration_minutes, calories_kcal, distance_meters, avg_hr_bpm, max_hr_bpm,
          raw_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          date = excluded.date,
          start_time = excluded.start_time,
          end_time = excluded.end_time,
          exercise_type = excluded.exercise_type,
          duration_minutes = excluded.duration_minutes,
          calories_kcal = excluded.calories_kcal,
          distance_meters = excluded.distance_meters,
          avg_hr_bpm = excluded.avg_hr_bpm,
          max_hr_bpm = excluded.max_hr_bpm,
          raw_json = excluded.raw_json,
          updated_at = excluded.updated_at`,
      )
      .bind(
        workout.id,
        workout.date,
        workout.start_time,
        workout.end_time,
        workout.exercise_type,
        workout.duration_minutes,
        workout.calories_kcal,
        workout.distance_meters,
        workout.avg_hr_bpm,
        workout.max_hr_bpm,
        workout.raw_json ?? null,
        workout.updated_at,
      );
  }

  async executeBatch(statements: D1PreparedStatement[], chunkSize = 100): Promise<void> {
    if (statements.length === 0) return;
    for (let i = 0; i < statements.length; i += chunkSize) {
      const slice = statements.slice(i, i + chunkSize);
      await this.db.batch(slice);
    }
  }

  async upsertDailyMetric(row: Partial<DailyMetricRow> & { date: string }): Promise<void> {
    await this.prepareUpsertDailyMetric(row).run();
  }

  async upsertSleepSession(session: SleepSessionRow): Promise<void> {
    await this.prepareUpsertSleepSession(session).run();
  }

  async upsertWorkout(workout: WorkoutRow): Promise<void> {
    await this.prepareUpsertWorkout(workout).run();
  }

  async getDailyMetrics(fromDate: string, toDate: string): Promise<DailyMetricRow[]> {
    const result = await this.db
      .prepare(
        `SELECT date, steps, distance_meters, calories_kcal, active_zone_minutes,
                resting_hr_bpm, hrv_rmssd_ms, spo2_avg_pct, spo2_min_pct,
                respiratory_rate_bpm, skin_temp_delta_c, weight_kg, body_fat_pct, vo2_max,
                sleep_total_minutes, sleep_deep_minutes, sleep_rem_minutes, sleep_light_minutes,
                sleep_awake_minutes, sleep_efficiency_pct, updated_at
         FROM daily_metrics
         WHERE date >= ? AND date <= ?
         ORDER BY date ASC`,
      )
      .bind(fromDate, toDate)
      .all<DailyMetricRow>();
    return result.results ?? [];
  }

  async getSleepSessions(fromDate: string, toDate: string): Promise<SleepSessionRow[]> {
    const result = await this.db
      .prepare(
        `SELECT id, date, start_time, end_time, duration_minutes, asleep_minutes,
                deep_minutes, rem_minutes, light_minutes, awake_minutes,
                efficiency_pct, is_main_sleep, updated_at
         FROM sleep_sessions
         WHERE date >= ? AND date <= ?
         ORDER BY start_time ASC`,
      )
      .bind(fromDate, toDate)
      .all<SleepSessionRow>();
    return result.results ?? [];
  }

  async getWorkouts(fromDate: string, toDate: string): Promise<WorkoutRow[]> {
    const result = await this.db
      .prepare(
        `SELECT id, date, start_time, end_time, exercise_type,
                duration_minutes, calories_kcal, distance_meters, avg_hr_bpm, max_hr_bpm, updated_at
         FROM workouts
         WHERE date >= ? AND date <= ?
         ORDER BY start_time DESC`,
      )
      .bind(fromDate, toDate)
      .all<WorkoutRow>();
    return result.results ?? [];
  }

  async recordSyncRun(run: SyncRunRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO sync_runs (
          started_at, finished_at, trigger, from_date, to_date, status, days_synced, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        run.started_at,
        run.finished_at,
        run.trigger,
        run.from_date,
        run.to_date,
        run.status,
        run.days_synced,
        run.error_message,
      )
      .run();
  }

  async getStats() {
    const [countRow, lastSync] = await Promise.all([
      this.db
        .prepare(
          `SELECT COUNT(*) as total_days, MIN(date) as first_date, MAX(date) as last_date FROM daily_metrics`,
        )
        .first<{ total_days: number; first_date: string | null; last_date: string | null }>(),
      this.db
        .prepare(`SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1`)
        .first<SyncRunRow>(),
    ]);

    return {
      cachedDays: countRow?.total_days ?? 0,
      firstCachedDate: countRow?.first_date ?? null,
      lastCachedDate: countRow?.last_date ?? null,
      lastSync: lastSync ?? null,
    };
  }
}
