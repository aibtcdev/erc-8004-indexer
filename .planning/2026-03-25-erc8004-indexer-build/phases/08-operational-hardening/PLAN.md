<?xml version="1.0" encoding="UTF-8"?>
<plan>
  <goal>Add cron-based chainhook health check with gap detection, a backfill script for initial deployment, finalize wrangler.jsonc cron trigger + env configs, wire the scheduled handler into src/index.ts, update .env.example with all required vars, and document deployment procedures in CLAUDE.md.</goal>
  <context>
    The worker already has fetch routing, D1 event storage, KV state, webhook receiver, API routes, and reputation lenses. The scheduled handler needs access to:
    - INDEXER_KV (chainhook UUID stored as "chainhook:uuid", sync progress)
    - DB (sync_state table has last_indexed_block per contract_id)
    - LOGS (worker-logs RPC, same isLogsRPC pattern from src/middleware/logger.ts)
    - HIRO_API_KEY and CHAINHOOK_UUID are env secrets for script use (not worker bindings)

    Stacks current block height can be fetched from the public API:
      https://api.hiro.so/v2/info (testnet: https://api.testnet.hiro.so/v2/info)
    Response has field: stacks_tip_height (integer)

    ChainhooksClient.getChainhook(uuid) returns { status: ChainhookStatus, definition }
    status fields: enabled (bool), status (string), last_evaluated_block_height (number|null)

    evaluateChainhook() is async — results arrive via webhook, not return value.
    ChainhooksClient has evaluateChainhook(uuid, fromBlock, toBlock) method.

    The scheduled export from a CF Worker is:
      export default { fetch: app.fetch, scheduled: scheduledHandler }
    Where scheduledHandler has signature:
      async (event: ScheduledEvent, env: Env, ctx: ExecutionContext) => void

    Existing patterns to follow:
    - isLogsRPC() type guard from src/middleware/logger.ts
    - requireEnv() pattern from scripts/register-chainhooks.ts
    - CHAINHOOKS_BASE_URL, ChainhooksClient from @hirosystems/chainhooks-client

    The backfill script runs via tsx (Node.js) like other scripts in scripts/.
    It needs HIRO_API_KEY, CHAINHOOK_UUID, and optionally START_BLOCK/END_BLOCK env vars.
  </context>

  <task id="1">
    <name>Create scheduled handler (src/scheduled.ts)</name>
    <files>
      src/scheduled.ts (create),
      src/types.ts (add HIRO_API_KEY to Env if needed — but it's a secret, check),
      src/index.ts (add scheduled export)
    </files>
    <action>
      Create src/scheduled.ts with the cron handler:

      1. Define STACKS_API_URL constants for mainnet and testnet:
         - mainnet: "https://api.hiro.so/v2/info"
         - testnet: "https://api.testnet.hiro.so/v2/info"

      2. Export async function scheduledHandler(event, env, ctx):
         a. Build a console/RPC logger using the same isLogsRPC pattern from logger.ts
            (import isLogsRPC logic inline or import the LogsRPC type from types.ts)
         b. Fetch chainhook UUID from KV: env.INDEXER_KV.get("chainhook:uuid")
            - If null: log warn "No chainhook UUID in KV — skipping health check" and return
         c. Fetch HIRO_API_KEY from env (add to Env as optional string: HIRO_API_KEY?: string)
            - If missing: log warn "HIRO_API_KEY not set — skipping health check" and return
         d. Determine network from env.ENVIRONMENT (if "production" → "mainnet" else "testnet")
         e. Create ChainhooksClient and call getChainhook(uuid)
            - On error: log error with message and return
         f. Extract status.enabled, status.status, status.last_evaluated_block_height
         g. Log info "chainhook_health" with fields: uuid, enabled, status, last_evaluated_block_height
         h. If !enabled or status !== "streaming": log warn "Chainhook unhealthy" and return early
         i. Fetch current Stacks block height from appropriate Stacks API URL
            - fetch() the info endpoint, parse JSON, extract stacks_tip_height
            - On error: log error and return
         j. Query sync_state from D1 to get max last_indexed_block across all contracts
            - Use: SELECT MAX(last_indexed_block) AS max_block FROM sync_state
            - If null or 0: log info "sync_state empty, no gap check needed" and return
         k. Calculate gap = current_block - last_indexed_block
         l. Log info "gap_check" with fields: current_block, last_indexed_block, gap
         m. If gap > 10: trigger backfill via evaluateChainhook(uuid, last_indexed_block + 1, current_block)
            - Log info "backfill_triggered" with fromBlock, toBlock, gap
            - Wrap in try/catch, log error on failure
         n. If gap > 100: log warn "large_gap_detected" with gap size (alert threshold)

      3. Create a standalone logger factory function createScheduledLogger(env, ctx) that
         returns a Logger using the same isLogsRPC / createConsoleLogger pattern from logger.ts.
         The scheduled handler doesn't have Hono context, so it needs its own logger creation.

      Note: HIRO_API_KEY must be added to the Env interface in src/types.ts as optional.
      Note: Import LogsRPC from src/types.ts, not redefine it.
    </action>
    <verify>
      npx tsc --noEmit --project /home/whoabuddy/dev/aibtcdev/erc-8004-indexer/tsconfig.json
      (should pass with no errors)
    </verify>
    <done>
      src/scheduled.ts exists with scheduledHandler function exported.
      src/index.ts exports { fetch: app.fetch, scheduled: scheduledHandler }.
      TypeScript compiles without errors.
    </done>
  </task>

  <task id="2">
    <name>Create backfill script (scripts/backfill.ts)</name>
    <files>
      scripts/backfill.ts (create),
      package.json (add "backfill" script entry)
    </files>
    <action>
      Create scripts/backfill.ts following the same patterns as scripts/register-chainhooks.ts:

      1. Required env vars:
         - HIRO_API_KEY — Hiro platform API key
         - CHAINHOOK_UUID — UUID of the registered chainhook

      2. Optional env vars:
         - CHAINHOOK_NETWORK — "mainnet" | "testnet" (default: "testnet")
         - START_BLOCK_HEIGHT — Block height to start backfill from (default: 0)
         - END_BLOCK_HEIGHT — Block height to end backfill at (default: fetch from Stacks API)

      3. Script behavior:
         a. Validate env vars using requireEnv() helper (same pattern as register-chainhooks.ts)
         b. Parse START_BLOCK_HEIGHT and END_BLOCK_HEIGHT from env
         c. If END_BLOCK_HEIGHT not set: fetch current block height from Stacks API
            - testnet: https://api.testnet.hiro.so/v2/info
            - mainnet: https://api.hiro.so/v2/info
            - Extract stacks_tip_height from JSON response
         d. Validate: startBlock <= endBlock, endBlock - startBlock <= 50000 (safety limit)
         e. Create ChainhooksClient and call evaluateChainhook(uuid, startBlock, endBlock)
         f. Log progress: "Triggering backfill from block X to Y (Z blocks)"
         g. On success: log "Backfill triggered. Events will arrive via webhook."
         h. On error: log error and exit(1)

      4. Add to package.json scripts:
         "backfill": "tsx --tsconfig tsconfig.scripts.json scripts/backfill.ts"

      The script does NOT track progress in KV (that's the worker's job via sync_state).
      The script is idempotent — duplicate events are handled by ON CONFLICT in D1 handlers.
    </action>
    <verify>
      npx tsc --noEmit --project /home/whoabuddy/dev/aibtcdev/erc-8004-indexer/tsconfig.scripts.json
      (should pass with no errors)
    </verify>
    <done>
      scripts/backfill.ts exists with complete implementation.
      "backfill" entry added to package.json scripts.
      TypeScript compiles without errors (scripts tsconfig).
    </done>
  </task>

  <task id="3">
    <name>Finalize wrangler.jsonc cron, update .env.example, update CLAUDE.md</name>
    <files>
      wrangler.jsonc,
      .env.example (update with all vars),
      CLAUDE.md (add deployment section)
    </files>
    <action>
      1. Update wrangler.jsonc:
         - Uncomment/add cron trigger at top level: "triggers": { "crons": ["*/5 * * * *"] }
         - Add HIRO_API_KEY as a secret reference comment (it's set via wrangler secret put)
         - Add cron triggers to staging and production env blocks as well
         - Ensure placeholder IDs remain as-is (STAGING_D1_ID_REPLACE_ME etc.)

      2. Update .env.example:
         Read the current content (it should have existing vars from prior phases) and add:
         - HIRO_API_KEY= (for scripts and scheduled handler)
         - CHAINHOOK_UUID= (for check-chainhook and backfill scripts)
         - CHAINHOOK_NETWORK=testnet (for scripts)
         - START_BLOCK_HEIGHT=0 (for register and backfill scripts)
         - WEBHOOK_URL= (for register script — the deployed worker URL)
         - ADMIN_TOKEN= (for lens admin endpoints)
         - CF_KV_NAMESPACE_ID= (for manual wrangler kv commands)
         Include clear comments grouping: Worker Secrets vs Script-only vars.

      3. Update CLAUDE.md:
         Add a new "## Operational Hardening" section documenting:
         a. Cron health check: fires every 5 min, checks chainhook status in KV, detects gaps
         b. Initial deployment steps:
            1. Create D1 and KV: wrangler d1 create / wrangler kv:namespace create
            2. Update STAGING_D1_ID_REPLACE_ME and STAGING_KV_ID_REPLACE_ME in wrangler.jsonc
            3. Apply migrations: wrangler d1 migrations apply --env staging
            4. Set secrets: wrangler secret put CHAINHOOK_SECRET --env staging
                            wrangler secret put HIRO_API_KEY --env staging
            5. Deploy dry-run to verify: npm run deploy:dry-run
            6. Register chainhook: npm run register (set WEBHOOK_URL to staging domain)
            7. Store UUID in KV: wrangler kv key put "chainhook:uuid" "UUID" --namespace-id ID
            8. Run backfill if needed: npm run backfill (set START_BLOCK_HEIGHT)
         c. Add scheduled handler note: reads HIRO_API_KEY from env, reads UUID from KV
         d. Note about gap threshold: >10 blocks triggers backfill, >100 blocks logs a warning

      Add HIRO_API_KEY to Env interface in src/types.ts as optional (for worker scheduled use):
      HIRO_API_KEY?: string;
    </action>
    <verify>
      npm run check (tsc --noEmit)
      npm test (all 65+ tests pass)
      npm run deploy:dry-run (bundle builds without error)
    </verify>
    <done>
      wrangler.jsonc has cron triggers in top-level and env blocks.
      .env.example has all required vars with comments.
      CLAUDE.md has deployment instructions section.
      npm run check passes.
      npm test passes with 65+ tests.
    </done>
  </task>
</plan>
