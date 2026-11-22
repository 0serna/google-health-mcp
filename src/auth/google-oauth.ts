import { DEFAULT_READONLY_SCOPES } from '../google-health/catalog';
import type { Env, StoredGoogleTokens } from '../types';

const KV_TOKENS_KEY = 'google_oauth:tokens';
const KV_STATE_PREFIX = 'google_oauth:state:';
const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const OAUTH_FETCH_TIMEOUT_MS = 15_000;

export const ALL_GOOGLE_OAUTH_SCOPES: string[] = ['openid', 'email', ...DEFAULT_READONLY_SCOPES];

export function getPublicBaseUrl(env: Env): string {
  const base = env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
  if (!base) {
    throw new Error('PUBLIC_BASE_URL is not configured on the Worker.');
  }
  return base;
}

export function getRedirectUri(env: Env): string {
  return `${getPublicBaseUrl(env)}/auth/google/callback`;
}

export function buildGoogleAuthorizeUrl(env: Env, state: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: getRedirectUri(env),
    response_type: 'code',
    scope: ALL_GOOGLE_OAUTH_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

export async function createDirectAuthorizationUrl(env: Env): Promise<{ url: string; state: string }> {
  const state = `direct:${crypto.randomUUID()}`;
  await env.OAUTH_KV.put(`${KV_STATE_PREFIX}${state}`, '1', { expirationTtl: 600 });
  return {
    url: buildGoogleAuthorizeUrl(env, state),
    state,
  };
}

export async function verifyAndConsumeDirectState(env: Env, state: string): Promise<boolean> {
  const key = `${KV_STATE_PREFIX}${state}`;
  const exists = await env.OAUTH_KV.get(key);
  if (!exists) return false;
  await env.OAUTH_KV.delete(key);
  return true;
}

interface GoogleTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

export interface GoogleUserInfo {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

async function parseJsonSafe<T>(res: Response, context: string): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${context}: unexpected non-JSON response (${res.status}): ${text.slice(0, 200)}`);
  }
}

export async function fetchGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const res = await fetch(GOOGLE_USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch Google user profile (${res.status})`);
  }
  return parseJsonSafe<GoogleUserInfo>(res, 'Google userinfo');
}

export async function exchangeCodeForTokens(
  env: Env,
  code: string,
): Promise<{ tokens: StoredGoogleTokens; user: GoogleUserInfo }> {
  const allowedEmail = env.ALLOWED_GOOGLE_EMAIL?.trim().toLowerCase();
  if (!allowedEmail) {
    throw new Error('ALLOWED_GOOGLE_EMAIL is not configured on the Worker. Refusing login (fail-closed).');
  }

  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: getRedirectUri(env),
  });

  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
  });

  const data = await parseJsonSafe<GoogleTokenResponse>(res, 'Google token exchange');
  if (!res.ok || !data.access_token) {
    throw new Error(
      `Failed to exchange OAuth code: ${data.error ?? res.status} ${data.error_description ?? ''}`.trim(),
    );
  }

  const user = await fetchGoogleUserInfo(data.access_token);
  if (user.email_verified !== true || user.email?.trim().toLowerCase() !== allowedEmail) {
    throw new Error('Unauthorized Google account.');
  }

  const existing = await getStoredTokens(env);
  const hasNewRefreshToken = Boolean(data.refresh_token);
  const refreshToken = data.refresh_token ?? existing?.refreshToken;
  if (!refreshToken) {
    throw new Error(
      'Google did not return a refresh_token. Revoke previous access in your Google Account and authorize again.',
    );
  }

  const now = Date.now();
  const expiresIn = typeof data.expires_in === 'number' && data.expires_in > 60 ? data.expires_in : 3600;
  const tokens: StoredGoogleTokens = {
    accessToken: data.access_token,
    refreshToken,
    expiresAt: now + (expiresIn - 60) * 1000,
    grantedAt: hasNewRefreshToken ? now : (existing?.grantedAt ?? now),
    scope: data.scope ?? ALL_GOOGLE_OAUTH_SCOPES.join(' '),
    tokenType: data.token_type ?? 'Bearer',
  };

  await env.OAUTH_KV.put(KV_TOKENS_KEY, JSON.stringify(tokens));
  return { tokens, user };
}

export async function getStoredTokens(env: Env): Promise<StoredGoogleTokens | null> {
  const raw = await env.OAUTH_KV.get(KV_TOKENS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredGoogleTokens;
  } catch {
    return null;
  }
}

export async function clearStoredTokens(env: Env): Promise<void> {
  await env.OAUTH_KV.delete(KV_TOKENS_KEY);
}

/**
 * Returns a valid access_token, refreshing it automatically if expired.
 */
export async function getValidAccessToken(env: Env): Promise<string> {
  const baseUrl = getPublicBaseUrl(env);
  const tokens = await getStoredTokens(env);
  if (!tokens) {
    throw new Error(`No Google Health tokens configured. Authorize first at ${baseUrl}/auth/google`);
  }

  if (Date.now() < tokens.expiresAt) {
    return tokens.accessToken;
  }

  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: tokens.refreshToken,
    grant_type: 'refresh_token',
  });

  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
  });

  const data = await parseJsonSafe<GoogleTokenResponse>(res, 'Google token refresh');
  if (!res.ok || !data.access_token) {
    if (data.error === 'invalid_grant') {
      throw new Error(
        `Google refresh_token expired (Testing mode tokens expire every 7 days). Re-authorize at: ${baseUrl}/auth/google`,
      );
    }
    throw new Error(
      `Failed to refresh Google token: ${data.error ?? res.status} ${data.error_description ?? ''}`.trim(),
    );
  }

  const expiresIn = typeof data.expires_in === 'number' && data.expires_in > 60 ? data.expires_in : 3600;
  const updated: StoredGoogleTokens = {
    ...tokens,
    accessToken: data.access_token,
    expiresAt: Date.now() + (expiresIn - 60) * 1000,
    scope: data.scope ?? tokens.scope,
  };

  await env.OAUTH_KV.put(KV_TOKENS_KEY, JSON.stringify(updated));
  return updated.accessToken;
}

export function getTokenHealthInfo(env: Env, tokens: StoredGoogleTokens | null) {
  const reauthUrl = `${getPublicBaseUrl(env)}/auth/google`;
  if (!tokens) {
    return {
      connected: false,
      reauthUrl,
      message: 'Not connected. Connect via Claude Mobile or visit reauthUrl to authorize Google Health API.',
    };
  }

  const ageMs = Date.now() - tokens.grantedAt;
  const remainingTestingMs = Math.max(0, SEVEN_DAYS_MS - ageMs);
  const remainingTestingHours = Math.round((remainingTestingMs / (1000 * 60 * 60)) * 10) / 10;

  return {
    connected: true,
    grantedAt: new Date(tokens.grantedAt).toISOString(),
    accessTokenExpiresAt: new Date(tokens.expiresAt).toISOString(),
    estimatedTestingRefreshRemainingHours: remainingTestingHours,
    needsReauthSoon: remainingTestingHours < 24,
    scopes: tokens.scope.split(' '),
    reauthUrl,
  };
}
