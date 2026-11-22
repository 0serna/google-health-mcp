import type { Context, Next } from 'hono';
import type { Env } from '../types';
import { timingSafeStringEqual } from '../utils/crypto';

function createApiKeyMiddleware(allowQueryParam: boolean) {
  return async function requireKey(c: Context<{ Bindings: Env }>, next: Next) {
    const expected = c.env.MCP_API_KEY;
    if (!expected) {
      return c.json({ error: 'MCP_API_KEY is not configured on the Worker.' }, 500);
    }

    const authHeader = c.req.header('Authorization') ?? '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const queryKey = allowQueryParam ? (c.req.query('key') ?? '') : '';
    const provided = bearerToken || queryKey;

    if (!provided || !(await timingSafeStringEqual(provided, expected))) {
      return c.json(
        {
          error: 'Unauthorized',
          hint: 'Provide "Authorization: Bearer <MCP_API_KEY>"',
        },
        401,
      );
    }

    await next();
  };
}

/**
 * Protects /admin/* routes with an Authorization: Bearer <MCP_API_KEY> header only.
 */
export const requireApiKey = createApiKeyMiddleware(false);

/**
 * Protects browser-initiated /auth/google with Bearer header or ?key= query parameter.
 */
export const requireApiKeyOrQuery = createApiKeyMiddleware(true);
