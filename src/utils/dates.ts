const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Checks whether a string is a valid calendar date in YYYY-MM-DD format.
 */
export function isValidDateString(value: string): boolean {
  if (!DATE_REGEX.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function assertValidDateString(value: string, fieldName = 'date'): void {
  if (!isValidDateString(value)) {
    throw new Error(`Invalid ${fieldName} "${value}". Expected a real calendar date in YYYY-MM-DD format.`);
  }
}

export function formatDateUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Returns today's YYYY-MM-DD in the given IANA timezone (defaults to UTC).
 */
export function todayInTimezone(timeZone = 'UTC', now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return formatDateUtc(now);
  }
}

/**
 * Converts a UTC ISO timestamp into a YYYY-MM-DD calendar date in the given IANA timezone.
 */
export function isoTimestampToLocalDate(iso: string, timeZone = 'UTC'): string | null {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return null;
  return todayInTimezone(timeZone, dt);
}

export function shiftDays(yyyyMmDd: string, deltaDays: number): string {
  assertValidDateString(yyyyMmDd);
  const d = new Date(`${yyyyMmDd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return formatDateUtc(d);
}

export function daysBetweenInclusive(fromDate: string, toDate: string): number {
  assertValidDateString(fromDate, 'fromDate');
  assertValidDateString(toDate, 'toDate');
  const start = Date.parse(`${fromDate}T00:00:00Z`);
  const end = Date.parse(`${toDate}T00:00:00Z`);
  return Math.floor((end - start) / 86_400_000) + 1;
}

export function validateDateRange(fromDate: string, toDate: string, maxDays?: number): void {
  assertValidDateString(fromDate, 'fromDate');
  assertValidDateString(toDate, 'toDate');
  if (fromDate > toDate) {
    throw new Error(`Invalid date range: fromDate (${fromDate}) must be on or before toDate (${toDate}).`);
  }
  if (maxDays !== undefined) {
    const span = daysBetweenInclusive(fromDate, toDate);
    if (span > maxDays) {
      throw new Error(`Date range of ${span} days exceeds maximum allowed (${maxDays} days).`);
    }
  }
}

/**
 * Computes the UTC offset in milliseconds for an instant in a given IANA timezone.
 * Positive values mean the timezone is ahead of UTC; negative values (e.g. America/Bogota = -5h) mean behind UTC.
 */
function getTimezoneOffsetMs(utcDate: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(utcDate);

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - utcDate.getTime();
}

/**
 * Converts local midnight (00:00:00) of YYYY-MM-DD in the given IANA timezone into a UTC ISO-8601 string.
 * For example: localDateStartUtcIso("2026-11-21", "America/Bogota") -> "2026-11-21T05:00:00Z".
 */
export function localDateStartUtcIso(yyyyMmDd: string, timeZone = 'UTC'): string {
  assertValidDateString(yyyyMmDd);
  if (!timeZone || timeZone === 'UTC' || timeZone === 'Etc/UTC') {
    return `${yyyyMmDd}T00:00:00Z`;
  }
  try {
    const nominalUtc = new Date(`${yyyyMmDd}T00:00:00Z`);
    const offset1 = getTimezoneOffsetMs(nominalUtc, timeZone);
    const approxUtc = new Date(nominalUtc.getTime() - offset1);
    const offset2 = getTimezoneOffsetMs(approxUtc, timeZone);
    const exactUtc = new Date(nominalUtc.getTime() - offset2);
    return exactUtc.toISOString().replace(/\.\d{3}Z$/, 'Z');
  } catch {
    return `${yyyyMmDd}T00:00:00Z`;
  }
}
