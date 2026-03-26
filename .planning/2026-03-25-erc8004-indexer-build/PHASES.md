# Phases

## Phase 1: Project Scaffold
Goal: Set up the Cloudflare Worker project matching org conventions exactly. Hono app skeleton, wrangler.jsonc with D1 + KV + LOGS bindings and staging/production environments, tsconfig, vitest with cloudflare pool, package.json scripts, release-please config, version.ts, logger middleware, and type definitions. Worker builds, type-checks, and responds to GET / with service info.

Creates:
- `src/index.ts` — Hono app with cors, logger middleware, root endpoint, error/404 handlers, D1/KV/LOGS env type
- `src/version.ts` — Version constant for release-please
- `src/types.ts` — Env interface (DB: D1Database, INDEXER_KV: KVNamespace, LOGS: unknown), LogsRPC interface, Logger interface, AppVariables
- `src/middleware/logger.ts` — Request-scoped logger with worker-logs RPC + console fallback (matches x402-sponsor-relay pattern)
- `src/rpc.ts` — IndexerRPC extends WorkerEntrypoint<Env> skeleton with getStatus() method
- `wrangler.jsonc` — D1 binding (DB), KV binding (INDEXER_KV), LOGS service binding, staging/production envs with custom domains (erc8004.aibtc.dev / erc8004.aibtc.com), cron trigger placeholder, observability off
- `package.json` — hono dependency, devDependencies (typescript, vitest, wrangler, @cloudflare/vitest-pool-workers, @types/node, tsx), scripts (dev, deploy:dry-run, deploy:staging, deploy:production, check, test, test:watch, cf-typegen, wrangler)
- `tsconfig.json` — ES2022, bundler resolution, strict, @cloudflare/workers-types
- `vitest.config.ts` — cloudflare vitest pool with wrangler config, LOGS stub, test environment override
- `release-please-config.json` + `.release-please-manifest.json`
- `.github/workflows/release-please.yml`
- `CLAUDE.md` — Project conventions doc

Acceptance criteria:
- `npm run check` passes (tsc --noEmit)
- `npm run deploy:dry-run` succeeds
- `npm test` runs (even if no tests yet)
- GET / returns service info JSON
- Logger middleware creates request-scoped logger

Dependencies: none
Status: `completed`


## Phase 2: D1 Schema & TypeScript Types
Goal: Create the D1 migration with all tables and indexes. Define TypeScript types for all 12 SIP-019 events, chainhook webhook payloads (using @hirosystems/chainhooks-client types), and database row models. Store WAD/i128 values as TEXT.

Creates:
- `migrations/0001_initial.sql` — All tables: agents, agent_metadata, approvals, feedback, client_approvals, feedback_responses, validation_requests, sync_state, lenses (empty for now). All indexes.
- `src/types/db.ts` — TypeScript interfaces for each DB row type (AgentRow, FeedbackRow, etc.)
- `src/types/events.ts` — ERC-8004 event type discriminated union (Registered, MetadataSet, UriUpdated, ApprovalForAll, Transfer, ClientApproved, NewFeedback, FeedbackRevoked, ResponseAppended, ValidationRequest, ValidationResponse)
- `src/types/chainhook.ts` — Re-export and narrow types from @hirosystems/chainhooks-client/schemas (ChainhookEvent, StacksBlock, ContractLogOperation). Define helper types for extracting contract_log operations.
- `src/types/index.ts` — Barrel export
- Update `src/types.ts` to import from `src/types/` (or consolidate)

Acceptance criteria:
- `wrangler d1 migrations apply DB --local` succeeds
- `npm run check` passes with all new types
- All 7 tables created with correct indexes
- WAD values typed as `string` (not `number`)
- ChainhookEvent type correctly narrows contract_log operations

Dependencies: Phase 1
Status: `completed`


## Phase 3: Webhook Receiver & Event Processing
Goal: Implement POST /webhook endpoint that receives Chainhooks 2.0 payloads, authenticates via bearer token, routes contract_log operations to the correct handler by contract_identifier, processes all 12 event types, handles rollbacks, and updates sync_state. All DB writes within transactions.

Creates:
- `src/webhook.ts` — POST /webhook route: bearer token auth, parse ChainhookEvent, iterate apply[]/rollback[] blocks, extract contract_log operations, route by contract_identifier to handler, update sync_state
- `src/handlers/identity.ts` — Handlers for: Registered (INSERT agents), MetadataSet (UPSERT agent_metadata), UriUpdated (UPDATE agents.token_uri), ApprovalForAll (UPSERT approvals), Transfer (UPDATE agents.owner)
- `src/handlers/reputation.ts` — Handlers for: ClientApproved (UPSERT client_approvals), NewFeedback (INSERT feedback), FeedbackRevoked (UPDATE feedback.is_revoked), ResponseAppended (INSERT feedback_responses)
- `src/handlers/validation.ts` — Handlers for: ValidationRequest (INSERT validation_requests), ValidationResponse (UPDATE validation_requests with response data)
- `src/handlers/rollback.ts` — Generic rollback: DELETE FROM each table WHERE block_height = ? AND tx_hash = ?
- `src/handlers/index.ts` — Event router: parse decoded Clarity value, determine event type, dispatch to handler
- `src/__tests__/webhook.test.ts` — Integration tests with mocked chainhook payloads for each event type
- `src/__tests__/rollback.test.ts` — Rollback test: insert events, then rollback, verify deletion
- `src/__tests__/fixtures/` — Sample chainhook payloads (apply + rollback)

Acceptance criteria:
- POST /webhook with valid bearer token processes all 12 event types
- POST /webhook with invalid/missing token returns 401
- Rollback deletes correct rows by block_height + tx_hash
- sync_state updated with last_block_height and last_block_hash after each webhook
- All handlers log to worker-logs via request-scoped logger
- Tests pass for each event type and rollback scenario
- POST /webhook returns 200 (or 204) after processing

Dependencies: Phase 2
Status: `completed`


## Phase 4: Chainhook Registration & Scripts
Goal: Create the registration script that uses @hirosystems/chainhooks-client to register contract_log filters for all 3 ERC-8004 contracts. Create health check script. Store chainhook UUID in KV. Consumer secret setup for webhook authentication.

Creates:
- `scripts/register-chainhooks.ts` — Uses ChainhooksClient to register one chainhook with contract_log filters for identity-registry-v2, reputation-registry-v2, validation-registry-v2. Stores UUID in KV. Sets start_at_block_height. Handles mainnet/testnet via env vars.
- `scripts/check-chainhook.ts` — Queries chainhook status by UUID from KV, logs health info
- `scripts/rotate-secret.ts` — Rotates consumer secret via SDK, outputs new secret for wrangler secret put
- Update `package.json` scripts: `register`, `check-chainhook`, `rotate-secret`
- Update `tsconfig.json` or add `tsconfig.scripts.json` for tsx script execution (matches agent-news pattern)

Acceptance criteria:
- `npm run register` creates chainhook and stores UUID in KV (testnet)
- `npm run check-chainhook` reports chainhook status
- Consumer secret rotation works
- Scripts use .env for HIRO_API_KEY and CHAINHOOK_SECRET
- Scripts are runnable via tsx (not bundled into worker)

Dependencies: Phase 3 (webhook endpoint must exist for registration URL)
Status: `completed`


## Phase 5: Worker-Logs Integration & Structured Logging
Goal: Ensure all webhook processing, event handling, errors, and anomalies produce structured logs via worker-logs service binding. Add request-level logging for all API endpoints. Create the worker-logs app registration.

Creates:
- Update all handlers to include structured context in log calls (agentId, client, blockHeight, eventType, txHash)
- `src/middleware/request-logger.ts` — Log request/response timing for API endpoints (method, path, status, duration_ms)
- Update `src/webhook.ts` to log: events received count, events processed count, rollback count, processing duration
- Add error-level logging for: failed DB writes, invalid payloads, auth failures
- Add warn-level logging for: anomalies (bulk revocation patterns, rate spikes)
- Scripts or instructions for registering "erc8004-indexer" app in worker-logs

Acceptance criteria:
- Every webhook invocation produces at least one INFO log with block height and event count
- Errors produce ERROR logs with full context
- All logs use consistent appId "erc8004-indexer"
- Logs visible in worker-logs dashboard after deployment

Dependencies: Phase 3
Status: `completed`


## Phase 6: Spec-Equivalent Query API
Goal: Implement all REST endpoints under /api/v1/ for agents, feedback, validations, and summary queries. Standard pagination (limit/offset), filtering, and sorting. Extend IndexerRPC with query methods for service binding consumers.

Creates:
- `src/routes/agents.ts` — GET /api/v1/agents, GET /api/v1/agents/:id, GET /api/v1/agents/:id/metadata
- `src/routes/feedback.ts` — GET /api/v1/agents/:id/summary, GET /api/v1/agents/:id/feedback, GET /api/v1/agents/:id/feedback/:seq, GET /api/v1/agents/:id/clients, GET /api/v1/agents/:id/feedback/:client/:index/responses, GET /api/v1/feedback/recent
- `src/routes/validations.ts` — GET /api/v1/agents/:id/validations/summary, GET /api/v1/agents/:id/validations, GET /api/v1/validators/:addr/requests, GET /api/v1/validations/:hash
- `src/routes/status.ts` — GET /api/v1/status (indexer health), GET /api/v1/stats (global counts)
- `src/utils/pagination.ts` — Shared pagination helpers (parse limit/offset, build response envelope)
- `src/utils/query.ts` — D1 query builders for filtered summary, feedback list, validation list
- Update `src/rpc.ts` — Add getAgent(), getSummary(), getFeedback(), getValidationSummary(), getStatus() methods
- `src/__tests__/api.test.ts` — Integration tests: seed D1 via webhook, then query endpoints, verify results

Acceptance criteria:
- All endpoints return correct data with pagination
- Summary query with client + tag filters matches expected aggregation
- Pagination defaults (limit 50, max 200) enforced
- RPC methods return same data as REST endpoints
- Integration test: ingest sample events then verify query results

Dependencies: Phase 3
Status: `completed`


## Phase 7: Reputation Lenses
Goal: Implement the lens system -- D1 lens table, lens configuration schema with trust/bounds/rate/decay/weight dimensions, SQL query modifiers + application-layer weighting pipeline, lens API endpoints, and the reference "aibtc" lens.

Creates:
- `src/lenses/types.ts` — LensConfig type with all 5 dimension schemas (trust, bounds, rate, decay, weight)
- `src/lenses/pipeline.ts` — Lens execution pipeline: base query -> trust filter -> bounds filter -> rate filter -> fetch -> decay weighting -> reviewer weighting -> aggregation
- `src/lenses/defaults.ts` — Default pass-through values for omitted dimensions
- `src/lenses/aibtc.ts` — Reference "aibtc" lens configuration (JSON)
- `src/routes/lenses.ts` — GET /api/v1/lenses, GET /api/v1/lenses/:lens, GET /api/v1/lenses/:lens/agents/:id/summary, GET /api/v1/lenses/:lens/agents/:id/feedback, GET /api/v1/lenses/:lens/agents/:id/score
- `migrations/0002_lenses_seed.sql` — Seed the "aibtc" lens config
- Update `src/rpc.ts` — Add getLensSummary(), getLensScore(), listLenses()
- `src/__tests__/lenses.test.ts` — Same raw data through different lenses produces different scores

Acceptance criteria:
- Lens summary includes transparency metadata (excluded count, reasons)
- aibtc lens applies all 5 dimensions
- Minimal lens (trust-only) works correctly
- Flag detection: bulk revocation, rate spikes
- Lens CRUD (admin endpoints for create/update)

Dependencies: Phase 6
Status: `completed`


## Phase 8: Operational Hardening & Deployment
Goal: Cron-based chainhook health check, gap detection with auto-backfill via evaluateChainhook(), backfill script for initial deployment, staging + production environment configuration, deployment verification.

Creates:
- `src/scheduled.ts` — Cron handler: check chainhook status via KV UUID + Chainhooks API, detect gaps between sync_state.last_block_height and current Stacks block, trigger evaluateChainhook() for missed ranges, log alerts for anomalies
- `scripts/backfill.ts` — Manual backfill: call evaluateChainhook() for a block range, track progress in KV
- Update `wrangler.jsonc` — Add cron trigger (every 5 min), finalize D1 database_id for staging/production, finalize KV namespace IDs
- Update `src/index.ts` — Export scheduled handler alongside fetch handler
- Deployment verification checklist in README or CLAUDE.md
- Update `.env.example` with all required env vars

Acceptance criteria:
- Cron fires every 5 minutes and logs chainhook health status
- Gap detection identifies missed blocks and triggers backfill
- Backfill script processes historical blocks without duplicates
- Staging deployment works end-to-end (register chainhook -> receive events -> query API)
- Production deployment works end-to-end

Dependencies: Phase 4, Phase 5, Phase 6
Status: `completed`
