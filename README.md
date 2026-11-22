# google-health-mcp

A remote **Model Context Protocol (MCP)** server (Streamable HTTP) running on **Cloudflare Workers** + **D1** + **KV** + **Cron Triggers** for querying and analyzing your **Google Health API v4** data (Fitbit Air / Pixel Watch) from **Claude Mobile**, **Claude.ai**, Cursor, Claude Code, and other MCP clients.

## Features

* **Native MCP OAuth 2.1 (`@cloudflare/workers-oauth-provider`)**: Works out of the box with **Claude.ai / Claude Mobile** via RFC 9728 Protected Resource Metadata, RFC 8414 Authorization Server Metadata, and Dynamic Client Registration. Restricted to a single allowed Google email (`ALLOWED_GOOGLE_EMAIL`).
* **Bearer Token Fallback**: Also accepts `Authorization: Bearer <MCP_API_KEY>` for IDEs, CLIs, and custom scripts.
* **Automatic Scheduled Sync**: A Cloudflare Cron Trigger runs every 6 hours to sync the latest 3 days into **Cloudflare D1** (SQLite), keeping a permanent historical archive even when Google's 7-day Testing-mode refresh token expires.
* **8 Read-Only & Analytics MCP Tools**:
  * `health_status` — OAuth connection health (with 7-day Testing-mode expiry warning and 1-click renewal URL), last sync run, and cached D1 date range.
  * `health_sync_now` — On-demand sync (1 to 90 days) from Google Health API v4 into D1.
  * `health_daily_summary` — Consolidated daily metrics (steps, distance, calories, active zone minutes, RHR, HRV, SpO2, respiratory rate, skin temp delta, and sleep stages).
  * `health_trends_and_baselines` — 7-day averages vs. 30-day personal baselines, standard deviation, and **z-score** anomaly detection.
  * `health_sleep_analysis` — Sleep duration, stages (Deep, REM, Light, Awake), efficiency, and cumulative sleep debt vs. your daily sleep goal.
  * `health_workouts` — Exercise sessions enriched with same-day and next-day recovery metrics (HRV, RHR, sleep).
  * `health_query_api_v4` — Generic read-only query against any of the 40+ Google Health API v4 `dataTypes` (`list`, `reconcile`, `dailyRollUp`) with 15-minute KV caching.
  * `health_data_catalog` — Supported `dataTypes`, AIP-160 filter conventions, and read-only OAuth scopes.
* **100% Cloudflare Free Tier**: Uses Workers, D1, KV, and Cron Triggers.

---

## Architecture

```text
Fitbit Air / Pixel Watch
        │
        ▼
Google Health API v4 (OAuth 2.0, read-only)
        │  ▲
        │  └── Cron every 6h + on-demand sync
        ▼
Cloudflare Worker (Hono + @cloudflare/workers-oauth-provider)
  ├── Cloudflare D1  → Permanent daily metrics, sleep sessions, workouts
  ├── Cloudflare KV  → OAuth grants, Google tokens, 15m API response cache
  └── /mcp           → Streamable HTTP MCP endpoint
        ▲
        ├── Claude.ai / Claude Mobile (MCP OAuth 2.1)
        └── Cursor / Claude Code / CLI (Bearer MCP_API_KEY)
```

---

## Setup & Deployment

### 1. Google Cloud Console (Google Health API v4)

1. Create or select a project in [Google Cloud Console](https://console.cloud.google.com/).
2. Enable **Google Health API** (`health.googleapis.com`).
3. Under **Google Auth Platform → Audience**, keep the app in **Testing** mode (free, no CASA audit required) and add your personal Google account as a **Test user**.
4. Under **Google Auth Platform → Data Access**, add the `.readonly` Google Health scopes (`activity_and_fitness.readonly`, `health_metrics_and_measurements.readonly`, `sleep.readonly`, `profile.readonly`, `settings.readonly`).
5. Under **Clients**, create a **Web application** OAuth 2.0 Client ID with these **Authorized redirect URIs**:
   * Production: `https://<your-worker>.<your-subdomain>.workers.dev/auth/google/callback`
   * Local dev: `http://localhost:8787/auth/google/callback`

### 2. Cloudflare Resources (Free Tier)

Copy `wrangler.jsonc.example` to `wrangler.jsonc` (ignored by Git) and fill in your D1 database ID, KV namespace ID, `DEFAULT_TIMEZONE`, and `ALLOWED_GOOGLE_EMAIL`:

```bash
cp wrangler.jsonc.example wrangler.jsonc

npm install
npx wrangler login

# Create D1 database and copy database_id into wrangler.jsonc
npx wrangler d1 create google-health-db

# Create KV namespace and copy id into wrangler.jsonc
npx wrangler kv namespace create OAUTH_KV

# Apply D1 migrations
npm run db:migrate:local
npm run db:migrate:remote
```

### 3. Secrets & Deploy

Copy `.dev.vars.example` to `.dev.vars` for local development (`npm run dev`), and set production secrets in Cloudflare:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put PUBLIC_BASE_URL      # e.g. https://google-health-mcp.<subdomain>.workers.dev
npx wrangler secret put MCP_API_KEY          # e.g. openssl rand -hex 32

npm run deploy
```

### 4. Authorize & Initial Backfill

Open in your browser to authorize Google Health API:

```text
https://<your-worker>.<your-subdomain>.workers.dev/auth/google?key=<MCP_API_KEY>
```

> **Note on Google OAuth Testing Mode:** Refresh tokens expire every 7 days in Testing mode. When that happens, `health_status` will notify you and you can renew in 1 click by visiting `/auth/google?key=<MCP_API_KEY>` (or reconnecting in Claude). Your historical data in D1 remains intact.

Trigger a 30-day initial backfill:

```bash
curl -X POST "https://<your-worker>.<your-subdomain>.workers.dev/admin/sync?days=30" \
  -H "Authorization: Bearer <MCP_API_KEY>"
```

---

## Connecting MCP Clients

### Claude.ai & Claude Mobile (Native MCP OAuth 2.1)

1. Open **Claude.ai → Settings → Connectors → Add custom connector** (automatically synced to **Claude Mobile**).
2. Enter your MCP endpoint URL:
   ```text
   https://<your-worker>.<your-subdomain>.workers.dev/mcp
   ```
3. Click **Connect** and sign in with the Google account configured in `ALLOWED_GOOGLE_EMAIL`.

### IDEs & CLI (Cursor, Claude Code, T3 Code)

```json
{
  "mcpServers": {
    "google-health": {
      "url": "https://<your-worker>.<your-subdomain>.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_API_KEY>"
      }
    }
  }
}
```

---

## Development

```bash
npm run typecheck   # TypeScript strict type checking
npm test            # Run Vitest unit tests
npm run dev         # Local Wrangler dev server
npm run deploy      # Deploy to Cloudflare Workers
```
