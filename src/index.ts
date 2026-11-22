import OAuthProvider, { AuthorizationError } from '@cloudflare/workers-oauth-provider';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import {
  buildGoogleAuthorizeUrl,
  clearStoredTokens,
  createDirectAuthorizationUrl,
  exchangeCodeForTokens,
  getPublicBaseUrl,
  getStoredTokens,
  getTokenHealthInfo,
  verifyAndConsumeDirectState,
} from './auth/google-oauth';
import { requireApiKey, requireApiKeyOrQuery } from './auth/mcp-auth';
import { HealthRepository } from './db/repository';
import { createHealthMcpServer } from './mcp/server';
import { syncHealthRange } from './sync/sync-service';
import type { Env } from './types';
import { timingSafeStringEqual } from './utils/crypto';
import { shiftDays, todayInTimezone } from './utils/dates';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Hono app for public health check, MCP OAuth consent UI (Claude Mobile), and admin routes
const defaultApp = new Hono<{ Bindings: Env }>();

defaultApp.get('/', (c) => {
  return c.json({
    service: 'google-health-mcp',
    status: 'ok',
    mcpEndpoint: '/mcp',
    oauthDiscovery: '/.well-known/oauth-protected-resource/mcp',
    authModes: ['MCP OAuth 2.1 (Claude.ai / Claude Mobile)', 'Bearer MCP_API_KEY (IDEs / CLI)'],
  });
});

// 1. MCP OAuth consent screen (triggered when Claude Mobile / Claude.ai connects)
defaultApp.get('/authorize', async (c) => {
  const oauth = c.env.OAUTH_PROVIDER;
  if (!oauth) return c.text('OAuth provider not initialized', 500);

  try {
    const authRequest = await oauth.parseAuthRequest(c.req.raw);
    const consentInfo = await oauth.describeConsent(authRequest);
    const tx = await oauth.beginConsent(authRequest);

    const clientName = escapeHtml(consentInfo.clientName ?? authRequest.clientId);
    const redirectHost = escapeHtml(consentInfo.redirectHost ?? '');
    const handle = escapeHtml(tx.handle);

    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Authorize Google Health MCP</title>
  </head>
  <body style="font-family: system-ui, sans-serif; max-width: 480px; margin: 48px auto; padding: 0 20px; line-height: 1.5;">
    <h1 style="font-size: 1.4rem;">Connect ${clientName}</h1>
    <p><strong>${clientName}</strong> (${redirectHost}) is requesting <strong>read-only</strong> access to your Google Health (Fitbit Air) data.</p>
    <p style="font-size: 0.9rem; color: #555;">Only the authorized Google account owner can complete this login.</p>
    <form method="POST" action="/authorize" style="display: flex; gap: 12px; margin-top: 24px;">
      <input type="hidden" name="handle" value="${handle}" />
      <button type="submit" name="decision" value="approve" style="padding: 10px 18px; background: #1a73e8; color: white; border: 0; border-radius: 6px; font-size: 1rem; cursor: pointer;">
        Continue with Google
      </button>
      <button type="submit" name="decision" value="deny" style="padding: 10px 18px; background: #eee; color: #222; border: 0; border-radius: 6px; font-size: 1rem; cursor: pointer;">
        Cancel
      </button>
    </form>
  </body>
</html>`;

    const headers = new Headers(tx.headers);
    headers.set('Content-Type', 'text/html; charset=utf-8');
    return new Response(html, { status: 200, headers });
  } catch (err) {
    if (err instanceof AuthorizationError && err.redirectTo) {
      return c.redirect(err.redirectTo, 302);
    }
    return c.text(err instanceof Error ? err.message : 'Invalid OAuth request', 400);
  }
});

// 2. Process consent decision and redirect upstream to Google OAuth
defaultApp.post('/authorize', async (c) => {
  const oauth = c.env.OAUTH_PROVIDER;
  if (!oauth) return c.text('OAuth provider not initialized', 500);

  const form = await c.req.formData();
  const handle = String(form.get('handle') ?? '');
  const decision = String(form.get('decision') ?? '');

  try {
    if (decision !== 'approve') {
      const denied = await oauth.denyConsent(c.req.raw, handle, {
        description: 'User denied authorization.',
      });
      return new Response(null, { status: 302, headers: denied.headers });
    }

    const approved = await oauth.approveConsent(c.req.raw, handle, {
      scope: ['health:read'],
    });
    const upstream = await oauth.beginUpstream(approved.request, {
      headers: approved.headers,
    });

    const googleUrl = buildGoogleAuthorizeUrl(c.env, upstream.state);
    const headers = new Headers(upstream.headers);
    headers.set('Location', googleUrl);
    return new Response(null, { status: 302, headers });
  } catch (err) {
    if (err instanceof AuthorizationError && err.redirectTo) {
      return c.redirect(err.redirectTo, 302);
    }
    return c.text(err instanceof Error ? err.message : 'Failed to process consent', 400);
  }
});

// 3. Direct Google token renewal (without re-adding the connector in Claude)
defaultApp.get('/auth/google', requireApiKeyOrQuery, async (c) => {
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
    return c.json({ error: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not configured.' }, 500);
  }
  const { url } = await createDirectAuthorizationUrl(c.env);
  return c.redirect(url);
});

// 4. Unified Google OAuth callback (handles both MCP OAuth and direct token renewal)
defaultApp.get('/auth/google/callback', async (c) => {
  const error = c.req.query('error');
  if (error) {
    return c.html(`<h1>Authorization cancelled</h1><p>Google returned: ${escapeHtml(error)}</p>`, 400);
  }

  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!code || !state) {
    return c.html('<h1>Invalid request</h1><p>Missing code or state parameter.</p>', 400);
  }

  // Branch A: direct renewal via /auth/google?key=...
  if (state.startsWith('direct:')) {
    const valid = await verifyAndConsumeDirectState(c.env, state);
    if (!valid) {
      return c.html('<h1>Invalid or expired state</h1><p>Please restart /auth/google.</p>', 400);
    }
    try {
      const { tokens, user } = await exchangeCodeForTokens(c.env, code);
      return c.html(
        `<!doctype html>
        <html lang="en">
          <body style="font-family: system-ui, sans-serif; max-width: 600px; margin: 48px auto; line-height: 1.5;">
            <h1>Google Health API Connected</h1>
            <p>Account: <strong>${escapeHtml(user.email ?? user.sub)}</strong></p>
            <p>OAuth tokens saved in Cloudflare KV.</p>
            <p><strong>Scopes:</strong> <code>${escapeHtml(tokens.scope)}</code></p>
            <p>You can close this tab now.</p>
          </body>
        </html>`,
      );
    } catch (err) {
      return c.html(`<h1>OAuth Error</h1><pre>${escapeHtml(err instanceof Error ? err.message : String(err))}</pre>`, 403);
    }
  }

  // Branch B: MCP OAuth flow (Claude Mobile / Claude.ai / OAuth MCP clients)
  const oauth = c.env.OAUTH_PROVIDER;
  if (!oauth) return c.text('OAuth provider not initialized', 500);

  try {
    const resumed = await oauth.finishUpstream(c.req.raw);
    const { user } = await exchangeCodeForTokens(c.env, code);

    const { redirectTo } = await oauth.completeAuthorization({
      request: resumed.request,
      userId: user.sub,
      metadata: { email: user.email ?? 'unknown' },
      scope: resumed.request.scope.length > 0 ? resumed.request.scope : ['health:read'],
      props: {
        email: user.email ?? '',
        sub: user.sub,
      },
    });

    const headers = new Headers(resumed.headers);
    headers.set('Location', redirectTo);
    return new Response(null, { status: 302, headers });
  } catch (err) {
    if (err instanceof AuthorizationError && err.redirectTo) {
      return c.redirect(err.redirectTo, 302);
    }
    return c.html(
      `<h1>MCP OAuth Error</h1><pre>${escapeHtml(err instanceof Error ? err.message : String(err))}</pre>`,
      403,
    );
  }
});

// Admin endpoints protected by Authorization: Bearer <MCP_API_KEY> header only
defaultApp.get('/admin/status', requireApiKey, async (c) => {
  const repo = new HealthRepository(c.env.DB);
  const [tokens, dbStats] = await Promise.all([getStoredTokens(c.env), repo.getStats()]);
  return c.json({
    oauth: getTokenHealthInfo(c.env, tokens),
    database: dbStats,
  });
});

defaultApp.post('/admin/sync', requireApiKey, async (c) => {
  const days = Math.min(90, Math.max(1, Number(c.req.query('days') ?? 7) || 7));
  const end = todayInTimezone(c.env.DEFAULT_TIMEZONE ?? 'UTC');
  const start = shiftDays(end, -(days - 1));
  const result = await syncHealthRange(c.env, start, end, 'manual');
  return c.json(result);
});

defaultApp.post('/admin/revoke-local', requireApiKey, async (c) => {
  await clearStoredTokens(c.env);
  return c.json({ cleared: true });
});

// Protected MCP handler (invoked by OAuthProvider only after OAuth or Bearer API key verification)
const mcpApiHandler: ExportedHandlerFetchHandler<Env> = async (request, env) => {
  const server = createHealthMcpServer(env);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
};

function createOAuthProvider(env: Env): OAuthProvider<Env> {
  const resourceUrl = `${getPublicBaseUrl(env)}/mcp`;

  return new OAuthProvider<Env>({
    apiRoute: '/mcp',
    apiHandler: { fetch: mcpApiHandler },
    defaultHandler: { fetch: defaultApp.fetch },
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    scopesSupported: ['health:read'],
    requiredScopes: ['health:read'],
    resourceMetadata: {
      resource: resourceUrl,
      resource_name: 'Google Health MCP',
    },
    // Also allows Authorization: Bearer <MCP_API_KEY> for IDEs / CLI clients
    resolveExternalToken: async ({ token, env: runtimeEnv }) => {
      if (runtimeEnv.MCP_API_KEY && (await timingSafeStringEqual(token, runtimeEnv.MCP_API_KEY))) {
        return {
          audience: resourceUrl,
          props: { authMode: 'api-key', email: runtimeEnv.ALLOWED_GOOGLE_EMAIL ?? '' },
        };
      }
      return null;
    },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const provider = createOAuthProvider(env);
    return provider.fetch(request, env, ctx);
  },

  // Cron Trigger: syncs the last 3 days every 6 hours
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const tokens = await getStoredTokens(env);
    if (!tokens) {
      console.log('[cron] Skipping sync: no Google OAuth tokens stored yet.');
      return;
    }

    const end = todayInTimezone(env.DEFAULT_TIMEZONE ?? 'UTC');
    const start = shiftDays(end, -2);
    ctx.waitUntil(
      syncHealthRange(env, start, end, 'cron')
        .then((res) => console.log('[cron] Sync completed:', JSON.stringify(res)))
        .catch((err) => console.error('[cron] Sync failed:', err)),
    );
  },
};
