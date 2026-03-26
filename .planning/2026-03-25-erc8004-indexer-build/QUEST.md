# ERC-8004 Indexer Build

Build a Cloudflare Worker that indexes ERC-8004 contract events from Stacks via Chainhooks 2.0 webhooks, stores them in D1, and exposes them through a spec-equivalent query API and modular reputation lenses.

Status: completed
Created: 2026-03-25
Repos: aibtcdev/erc-8004-indexer

## Goal

A production-ready indexer that:
- Receives chainhook webhook events for 3 ERC-8004 contracts (identity, reputation, validation registries)
- Stores all 12 SIP-019 event types in D1 with rollback support
- Exposes REST endpoints matching the ERC-8004 spec read functions (no page-size-14 ceiling)
- Exports an RPC entrypoint (WorkerEntrypoint) for service bindings from other workers
- Provides a reputation lens system for modular scoring on top of raw data
- Integrates with worker-logs for centralized logging

## Reference Architecture

Patterns drawn from production aibtcdev Cloudflare Workers:

| Pattern | Source Repo | Notes |
|---------|-------------|-------|
| Hono web framework | all workers | Standard across org |
| `wrangler.jsonc` with `$schema` | all workers | `"$schema": "node_modules/wrangler/config-schema.json"` |
| `nodejs_compat_v2` flag | all workers | `compatibility_date: "2026-01-01"` |
| `LogsRPC` service binding | x402-sponsor-relay, agent-news | `{ "binding": "LOGS", "service": "worker-logs-<env>", "entrypoint": "LogsRPC" }` |
| Logger middleware pattern | x402-sponsor-relay | RPC logger with console fallback, request-scoped via `c.set("logger", ...)` |
| `LogsRPC` interface type | agent-news | Defined locally, not imported from worker-logs package |
| Release-please CI | all workers | `release-please-config.json` with node release type |
| Env duplication per environment | all workers | Services, KV, D1 NOT inherited by env blocks |
| D1 bindings | agent-hub | `d1_databases` with `database_id` per env |
| `npm run wrangler` via .env | all workers | `"wrangler": "set -a && . ./.env && set +a && npx wrangler"` |
| vitest with cloudflare pool | agent-news, worker-logs | `@cloudflare/vitest-pool-workers` for D1/KV/DO testing |
| WorkerEntrypoint RPC | worker-logs | `LogsRPC extends WorkerEntrypoint<Env>` pattern |
| `version.ts` for release-please | x402-sponsor-relay, agent-news | Separate version file for CI version bumping |

## Skeptic's Notes

### Validated

1. **`@hirosystems/chainhooks-client` SDK exists**: v2.1.1, published 2026-03-17. Provides `ChainhooksClient` class with `registerChainhook()`, `getChainhook()`, `enableChainhook()`, `evaluateChainhook()`, and consumer secret management. Uses `@sinclair/typebox` for schemas.

2. **SDK API shape matches plan**: The `ChainhookDefinition` type includes `name`, `chain` ("stacks"), `network` ("mainnet"|"testnet"), `filters.events[]` with `type: "contract_log"` and optional `contract_identifier`, `action: { type: "http_post", url: string }`, and `options: { decode_clarity_values, enable_on_registration, ... }`. The implementation plan's registration script is structurally correct.

3. **Webhook payload format confirmed**: `ChainhookEvent` has structure `{ chainhook: { uuid, name }, event: { chain, network, apply: Block[], rollback: Block[] } }`. Each block has `block_identifier: { index, hash }`, `transactions[]` with `operations[]`. The `contract_log` operation type has `metadata: { contract_identifier, topic, value: string | { hex, repr } }`.

4. **Worker-logs integration pattern confirmed**: Service binding as `{ "binding": "LOGS", "service": "worker-logs-staging", "entrypoint": "LogsRPC" }`. RPC methods: `info(appId, message, context?)`, `warn(...)`, `error(...)`, `debug(...)`. Each worker defines `LogsRPC` interface locally (not published as package). Logger middleware creates request-scoped logger with console fallback for local dev.

5. **D1 in org confirmed**: agent-hub uses `d1_databases` with `binding: "DB"`, separate `database_id` per environment. Schema in standalone `.sql` file (not `migrations/` directory). D1 migrations managed via `wrangler d1 migrations` commands.

6. **`nodejs_compat_v2` confirmed**: All org workers use this flag. Still current as of wrangler v4.75.0.

### Concerns & Corrections

1. **IMPLEMENTATION_PLAN.md says "notification string to route to handler"**: This is vague. The actual chainhook payload delivers `contract_log` operations with `metadata.contract_identifier` (e.g., `SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.identity-registry-v2`) and `metadata.value` (either a string or `{ hex, repr }` depending on `decode_clarity_values`). Routing should be by `contract_identifier`, NOT by "notification prefix". The `value` field contains the Clarity print event data. When `decode_clarity_values: true`, `value` is the decoded repr string. The plan's event routing table should route by contract + function name derived from the decoded value, not by "notification string prefix".

2. **IMPLEMENTATION_PLAN.md says `{ event: { apply[], rollback[] } }`**: Actual shape is `{ chainhook: { uuid, name }, event: { chain, network, apply: Block[], rollback: Block[] } }`. Minor but the outer wrapper matters for auth validation.

3. **Consumer secret for webhook auth**: The SDK provides `rotateConsumerSecret()` and `getConsumerSecret()` methods. This is the Chainhooks 2.0 way to authenticate incoming webhooks -- the secret is set via the API, then included in webhook deliveries. The plan mentions `Authorization: Bearer <CHAINHOOK_SECRET>` but the actual mechanism may use HMAC signature verification, not bearer tokens. This needs investigation during implementation.

4. **`evaluateChainhook()` for backfill**: The SDK method exists but takes `uuid` + `EvaluateChainhookRequest` (a block range). This is the correct mechanism for gap detection and backfill, but it queues an on-demand evaluation -- it does not return results synchronously. The webhook will receive the replayed events asynchronously.

5. **D1 migrations directory**: The plan uses `migrations/` directory. Cloudflare D1 supports `migrations_dir` in the `d1_databases` binding. The org (agent-hub) uses a standalone `schema.sql` file instead of the migrations directory pattern. Decision needed: use wrangler's migration system (`wrangler d1 migrations create/apply`) which creates numbered files in `migrations/`, or use a standalone schema file. Recommend the standard `migrations/` approach for this project since schema will evolve.

6. **WAD values as i128**: The plan correctly flags this. D1/SQLite stores integers as i64 (max ~9.2e18). WAD values with 18 decimals can exceed this. TEXT storage with numeric comparison is the safest path. The plan already recommends this.

7. **Missing: `undici` dependency**: `@hirosystems/chainhooks-client` uses `undici` internally. Cloudflare Workers have a built-in `fetch` but `undici` may not be available. The registration script should run via `tsx` (Node.js), NOT inside the Worker. The Worker only receives webhooks -- it never calls the Chainhooks API at runtime.

8. **Contract addresses**: The plan uses `SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD` for mainnet and `ST3YT0XW92E6T2FE59B2G5N2WNNFSBZ6MZKQS5D18` for testnet. These should be verified against the actual deployed contracts before registration.

9. **No `start_at_block_height` in plan**: The `ChainhookDefinition.options` includes `start_at_block_height` which is critical for not re-processing the entire chain. Should be set to the contract deployment block height. The plan mentions "recently deployed" but does not specify the block.

10. **Chanfana not needed**: The plan says "Hono (matches worker-logs pattern)". x402-sponsor-relay uses Chanfana (OpenAPI), but this indexer does not need OpenAPI docs initially. Plain Hono is simpler and matches agent-news/worker-logs. Can add Chanfana later if needed.
