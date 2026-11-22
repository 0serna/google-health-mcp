import { getValidAccessToken } from '../auth/google-oauth';
import type { Env } from '../types';
import { assertValidDataType, buildTimeRangeFilter, type RecordKind } from './catalog';

const HEALTH_API_BASE = 'https://health.googleapis.com/v4';
const API_FETCH_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 2;

export interface CivilDateTime {
  date: {
    year: number;
    month: number;
    day: number;
  };
  time: {
    hours: number;
    minutes: number;
    seconds: number;
    nanos: number;
  };
}

export function parseCivilDateTime(yyyyMmDd: string, addDays = 0): CivilDateTime {
  const d = new Date(`${yyyyMmDd}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date "${yyyyMmDd}". Use YYYY-MM-DD format.`);
  }
  if (addDays !== 0) {
    d.setUTCDate(d.getUTCDate() + addDays);
  }
  return {
    date: {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
    },
    time: { hours: 0, minutes: 0, seconds: 0, nanos: 0 },
  };
}

export interface DataPointsResponse {
  dataPoints?: Record<string, unknown>[];
  nextPageToken?: string;
}

export interface DailyRollUpResponse {
  rollupDataPoints?: Array<Record<string, unknown>>;
  dailyRollupDataPoints?: Array<Record<string, unknown>>;
  nextPageToken?: string;
}

export interface PaginatedResult {
  items: Array<Record<string, unknown>>;
  hasMore: boolean;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GoogleHealthClient {
  private tokenPromise: Promise<string> | null = null;
  private cachedToken: string | null = null;

  constructor(private readonly env: Env) {}

  /**
   * Deduplicates concurrent token refreshes within a single Worker invocation
   * so parallel Promise.all requests never race on KV writes.
   */
  private async getAccessToken(): Promise<string> {
    if (this.cachedToken) return this.cachedToken;
    if (!this.tokenPromise) {
      this.tokenPromise = getValidAccessToken(this.env)
        .then((token) => {
          this.cachedToken = token;
          return token;
        })
        .finally(() => {
          this.tokenPromise = null;
        });
    }
    return this.tokenPromise;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    cacheKey?: string,
    cacheTtlSeconds = 900,
  ): Promise<T> {
    if (cacheKey) {
      const cached = await this.env.OAUTH_KV.get(cacheKey);
      if (cached) {
        return JSON.parse(cached) as T;
      }
    }

    const token = await this.getAccessToken();
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${HEALTH_API_BASE}${path}`, {
          ...init,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...(init.headers ?? {}),
          },
          signal: AbortSignal.timeout(API_FETCH_TIMEOUT_MS),
        });
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < MAX_RETRIES) {
          await sleepMs(250 * 2 ** attempt);
          continue;
        }
        throw lastError;
      }

      if (res.ok) {
        const data = (await res.json()) as T;
        if (cacheKey) {
          await this.env.OAUTH_KV.put(cacheKey, JSON.stringify(data), { expirationTtl: cacheTtlSeconds });
        }
        return data;
      }

      const text = await res.text();
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < MAX_RETRIES) {
        await sleepMs(300 * 2 ** attempt);
        continue;
      }

      console.error(
        JSON.stringify({
          event: 'google_health_api_error',
          status: res.status,
          method: init.method ?? 'GET',
          path,
          errorBody: text.slice(0, 600),
        }),
      );
      throw new Error(`Google Health API ${res.status} on ${path}: ${text.slice(0, 400)}`);
    }

    throw lastError ?? new Error(`Google Health API request failed on ${path}`);
  }

  async getIdentity(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('/users/me/identity');
  }

  async getProfile(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('/users/me/profile');
  }

  /**
   * Lists dataPoints with automatic pagination and accurate truncation metadata.
   */
  async listDataPointsWithMeta(params: {
    dataType: string;
    fromDate: string;
    toDate: string;
    reconcile?: boolean;
    pageSize?: number;
    maxPages?: number;
    maxItems?: number;
    overrideKind?: RecordKind;
    useCache?: boolean;
    timeZone?: string;
  }): Promise<PaginatedResult> {
    const {
      dataType,
      fromDate,
      toDate,
      reconcile = false,
      pageSize = dataType === 'sleep' || dataType === 'exercise' ? 25 : 1000,
      maxPages = 5,
      maxItems,
      overrideKind,
      useCache = false,
      timeZone = this.env.DEFAULT_TIMEZONE ?? 'UTC',
    } = params;

    assertValidDataType(dataType);
    const effectivePageSize = maxItems ? Math.min(pageSize, maxItems) : pageSize;
    const filter = buildTimeRangeFilter(dataType, fromDate, toDate, overrideKind, timeZone);
    const suffix = reconcile ? ':reconcile' : '';
    const all: Record<string, unknown>[] = [];
    let pageToken: string | undefined;
    let hasMore = false;

    for (let page = 0; page < maxPages; page++) {
      const qs = new URLSearchParams({
        pageSize: String(effectivePageSize),
        filter,
      });
      if (pageToken) qs.set('pageToken', pageToken);

      const path = `/users/me/dataTypes/${encodeURIComponent(dataType)}/dataPoints${suffix}?${qs.toString()}`;
      const cacheKey = useCache && page === 0 ? `api_cache:${path}` : undefined;
      const res = await this.request<DataPointsResponse>(path, { method: 'GET' }, cacheKey);

      if (res.dataPoints?.length) {
        all.push(...res.dataPoints);
      }
      if (maxItems && all.length >= maxItems) {
        hasMore = Boolean(res.nextPageToken) || all.length > maxItems;
        break;
      }
      if (!res.nextPageToken) {
        hasMore = false;
        break;
      }
      hasMore = true;
      pageToken = res.nextPageToken;
    }

    return { items: all, hasMore };
  }

  async listDataPoints(params: Parameters<GoogleHealthClient['listDataPointsWithMeta']>[0]) {
    const { items } = await this.listDataPointsWithMeta(params);
    return items;
  }

  /**
   * Executes POST :dailyRollUp for civil-time daily aggregates.
   * Automatically chunks ranges > 14 days to satisfy the API maxDurationDays limit.
   */
  async dailyRollUpWithMeta(params: {
    dataType: string;
    fromDate: string;
    toDate: string;
    pageSize?: number;
    maxItems?: number;
    useCache?: boolean;
  }): Promise<PaginatedResult> {
    const { dataType, fromDate, toDate, pageSize = 100, maxItems, useCache = false } = params;
    assertValidDataType(dataType);
    const all: Array<Record<string, unknown>> = [];
    let hasMore = false;

    const startMs = new Date(`${fromDate}T12:00:00Z`).getTime();
    const endMs = new Date(`${toDate}T12:00:00Z`).getTime();
    const chunkDays = 14;
    const dayMs = 24 * 60 * 60 * 1000;

    outer: for (let cursorMs = startMs; cursorMs <= endMs; cursorMs += chunkDays * dayMs) {
      const chunkStart = new Date(cursorMs).toISOString().slice(0, 10);
      const chunkEndMs = Math.min(endMs, cursorMs + (chunkDays - 1) * dayMs);
      const chunkEnd = new Date(chunkEndMs).toISOString().slice(0, 10);

      let pageToken: string | undefined;
      for (let page = 0; page < 5; page++) {
        const body = {
          range: {
            start: parseCivilDateTime(chunkStart, 0),
            end: parseCivilDateTime(chunkEnd, 1), // exclusive
          },
          windowSizeDays: 1,
          pageSize,
          ...(pageToken ? { pageToken } : {}),
        };

        const path = `/users/me/dataTypes/${encodeURIComponent(dataType)}/dataPoints:dailyRollUp`;
        const cacheKey =
          useCache && page === 0 ? `api_cache:dailyRollUp:${dataType}:${chunkStart}:${chunkEnd}` : undefined;

        const res = await this.request<DailyRollUpResponse>(
          path,
          { method: 'POST', body: JSON.stringify(body) },
          cacheKey,
        );

        const points = res.rollupDataPoints ?? res.dailyRollupDataPoints ?? [];
        if (points.length) {
          all.push(...points);
        }
        if (maxItems && all.length >= maxItems) {
          hasMore = Boolean(res.nextPageToken) || all.length > maxItems || chunkEndMs < endMs;
          break outer;
        }
        if (!res.nextPageToken) break;
        if (page === 4) hasMore = true;
        pageToken = res.nextPageToken;
      }
    }

    return { items: all, hasMore };
  }

  async dailyRollUp(params: Parameters<GoogleHealthClient['dailyRollUpWithMeta']>[0]) {
    const { items } = await this.dailyRollUpWithMeta(params);
    return items;
  }
}
