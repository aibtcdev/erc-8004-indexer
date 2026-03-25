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
  index.ts              # Hono app + route registration + error handlers
  rpc.ts                # IndexerRPC WorkerEntrypoint for service bindings
  version.ts            # VERSION constant (updated by release-please)
  types.ts              # Env, AppVariables, LogsRPC, Logger interfaces
  middleware/
    logger.ts           # Request-scoped logger middleware
  handlers/             # Event handlers (Phase 3)
  routes/               # API route handlers (Phase 6)
  lenses/               # Reputation lens system (Phase 7)
  __tests__/            # Vitest integration tests
migrations/             # D1 SQL migrations (Phase 2)
scripts/                # tsx scripts (chainhook registration, backfill)
```

## Release Process

Uses release-please with node release type. Conventional commits on `main` trigger automated PRs.
Version is sourced from `src/version.ts` (updated by release-please alongside `package.json`).
