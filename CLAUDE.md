# ERC-8004 Indexer — Project Conventions

## Stack

- **Runtime**: Cloudflare Worker (`nodejs_compat_v2`, compatibility_date 2026-01-01)
- **Framework**: Hono (plain, no Chanfana/OpenAPI initially)
- **Storage**: D1 (event storage), KV (indexer state + chainhook IDs)
- **Logging**: worker-logs service binding (`LOGS` → `LogsRPC`)
- **Testing**: Vitest with `@cloudflare/vitest-pool-workers` (cloudflareTest pool)

## Key Commands

```bash
npm run dev              # Local development server
npm run check            # TypeScript type-check (tsc --noEmit)
npm test                 # Run tests once
npm run test:watch       # Watch mode
npm run deploy:dry-run   # Build without deploying (verify bundle)
npm run deploy:staging   # Deploy to erc8004.aibtc.dev
npm run deploy:production # Deploy to erc8004.aibtc.com
npm run cf-typegen       # Regenerate worker-configuration.d.ts from wrangler.jsonc
```

## Conventions

### Commits
Conventional commits: `type(scope): message`
Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`

### Logger
Always use the request-scoped logger from Hono context — never call `console.log` directly in handlers:
```typescript
const logger = c.var.logger;
logger.info("Event processed", { agentId, blockHeight });
```

The logger is created by `loggerMiddleware` in `src/middleware/logger.ts`.
- Production: sends to worker-logs via RPC (`ctx.waitUntil` for fire-and-forget)
- Local dev / tests: falls back to `console.log/warn/error/debug`

### Types
All Cloudflare bindings are defined in `src/types.ts`:
- `Env` — D1Database, KVNamespace, LOGS (unknown), ENVIRONMENT
- `AppVariables` — requestId, logger (set by middleware)
- `LogsRPC` — worker-logs RPC interface (defined locally, not imported)
- `Logger` — request-scoped logger interface

### Environment Bindings
Bindings are NOT inherited by wrangler.jsonc env blocks — they must be explicitly duplicated in each `env.staging` and `env.production` block.

### RPC Exports
`IndexerRPC` in `src/rpc.ts` exports query methods for service bindings from other workers.
Callers bind via: `{ "binding": "INDEXER", "service": "erc-8004-indexer", "entrypoint": "IndexerRPC" }`

## Environments

| Environment | Domain | D1 | KV | LOGS service |
|-------------|--------|----|----|-------------|
| local dev | localhost:8787 | local | local | console fallback |
| staging | erc8004.aibtc.dev | erc8004-indexer-staging | STAGING_KV_ID | worker-logs-staging |
| production | erc8004.aibtc.com | erc8004-indexer-production | PRODUCTION_KV_ID | worker-logs-production |

## Secrets (set via `wrangler secret put`)

- `CHAINHOOK_SECRET` — bearer token for authenticating incoming webhook requests
- `HIRO_API_KEY` — for Chainhooks 2.0 registration scripts (scripts only, not worker)

## Project Structure

```
src/
  index.ts              # Hono app + route registration + scheduled export
  rpc.ts                # IndexerRPC WorkerEntrypoint for service bindings
  scheduled.ts          # Cron handler: chainhook health check + gap detection
  version.ts            # VERSION constant (updated by release-please)
  types.ts              # Env, AppVariables, LogsRPC, Logger interfaces
  middleware/
    logger.ts           # Request-scoped logger middleware
    request-logger.ts   # Per-request method/path/status/duration logging
  handlers/             # Event handlers (Phase 3)
  routes/               # API route handlers (Phase 6)
  lenses/               # Reputation lens system (Phase 7)
  __tests__/            # Vitest integration tests
migrations/             # D1 SQL migrations (Phase 2)
scripts/
  register-chainhooks.ts   # Register Chainhooks 2.0 subscription
  check-chainhook.ts       # Check chainhook health status
  rotate-secret.ts         # Rotate CHAINHOOK_SECRET via Chainhooks API
  register-worker-logs-app.ts  # Register app with worker-logs service
  backfill.ts              # Backfill historical blocks via evaluateChainhook()
```

## Operational Hardening

### Cron Health Check

A scheduled handler (`src/scheduled.ts`) fires every 5 minutes via Cloudflare Cron Triggers.

It performs:
1. Reads the chainhook UUID from `INDEXER_KV` (key: `chainhook:uuid`)
2. Calls `ChainhooksClient.getChainhook(uuid)` using `HIRO_API_KEY` to get live status
3. Logs `chainhook_health` with enabled/status/last_evaluated_block_height fields
4. Alerts (warn) if chainhook is not streaming or is disabled
5. Fetches current Stacks block height from `api.hiro.so/v2/info` (or testnet equivalent)
6. Compares against `MAX(last_indexed_block)` from `sync_state` table
7. Triggers `evaluateChainhook()` for up to 20 missed blocks per run when gap > 10
8. Warns on `large_gap_detected` when gap > 100 blocks

Network is determined by `ENVIRONMENT` env var: `"production"` → mainnet, else testnet.

### Initial Deployment Steps

#### One-time resource provisioning (Cloudflare CLI required):

```bash
# Create D1 database and KV namespace for staging
npx wrangler d1 create erc8004-indexer-staging
npx wrangler kv:namespace create INDEXER_KV --env staging

# Update wrangler.jsonc:
#   - Replace STAGING_D1_ID_REPLACE_ME with the d1 create output ID
#   - Replace STAGING_KV_ID_REPLACE_ME with the kv:namespace create output ID

# Apply migrations
npx wrangler d1 migrations apply erc8004-indexer-staging --env staging

# Set worker secrets
npx wrangler secret put CHAINHOOK_SECRET --env staging
npx wrangler secret put HIRO_API_KEY --env staging
npx wrangler secret put ADMIN_TOKEN --env staging
```

#### Verify build (no deploy):

```bash
npm run deploy:dry-run
```

#### Register chainhook and seed KV:

```bash
# Set env vars in .env first:
#   HIRO_API_KEY=...
#   WEBHOOK_URL=https://erc8004.aibtc.dev
#   CHAINHOOK_NETWORK=testnet
#   START_BLOCK_HEIGHT=<recent block>

npm run register
# Copy the printed UUID, then:
npx wrangler kv key put "chainhook:uuid" "<UUID>" --namespace-id $CF_KV_NAMESPACE_ID
```

#### Optional: Backfill historical data:

```bash
# Set in .env:
#   CHAINHOOK_UUID=<UUID from register step>
#   START_BLOCK_HEIGHT=<start of ERC-8004 contract deployment>
#   END_BLOCK_HEIGHT=<optional; fetched automatically if omitted>

npm run backfill
# Events arrive via webhook asynchronously; check GET /api/v1/status to confirm sync
```

#### Repeat for production with `--env production`.

### Backfill Script

`scripts/backfill.ts` calls `evaluateChainhook()` once per block (100ms delay between calls).

- Maximum range: 50,000 blocks per run. Split into multiple runs for larger ranges.
- The operation is idempotent — duplicate events are handled by `ON CONFLICT` in D1.
- Errors per block are logged but do not abort the batch; exit code 1 if any blocks fail.

### Deployment Commands

| Command | Description |
|---------|-------------|
| `npm run deploy:dry-run` | Build bundle without deploying (verify output) |
| `npm run deploy:staging` | Deploy to erc8004.aibtc.dev |
| `npm run deploy:production` | Deploy to erc8004.aibtc.com |

**IMPORTANT**: Do NOT run `npm run deploy` directly. Use `deploy:staging` or `deploy:production`.
CI/CD (GitHub Actions) handles production deployments on push to `main`.

## Release Process

Uses release-please with node release type. Conventional commits on `main` trigger automated PRs.
Version is sourced from `src/version.ts` (updated by release-please alongside `package.json`).
