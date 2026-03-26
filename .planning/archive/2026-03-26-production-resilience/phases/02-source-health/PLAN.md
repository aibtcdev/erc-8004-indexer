<?xml version="1.0" encoding="UTF-8"?>
<plan>
  <goal>Create KV-based source health tracking for the chainhook source, integrate blocks_seen recording into the webhook handler (apply blocks + rollback marking), and update chainhook source health on each webhook delivery.</goal>
  <context>
    Phase 1 added the `blocks_seen` D1 table migration, `BlockSeenRow` type in types/db.ts, and
    three query helpers in utils/query.ts: `upsertBlockSeen`, `markBlockNonCanonical`, `queryRecentBlocks`.

    The webhook handler (src/webhook.ts) already:
    - Iterates apply[] blocks and rollback[] blocks
    - Calls routeEvent and handleRollback per transaction
    - Upserts sync_state after apply blocks
    - Uses request-scoped logger from Hono context (c.var.logger)

    KV namespace is INDEXER_KV. Existing keys: "webhook_secret", "chainhook:uuid".
    New key: "source_health:chainhook" — stores a JSON SourceHealthEntry.

    The ChainhookEvent block type has:
      block.block_identifier.index  (block height as number)
      block.block_identifier.hash   (block hash string)

    types.ts defines Env (DB, INDEXER_KV, LOGS, ENVIRONMENT, ADMIN_TOKEN, HIRO_API_KEY)
    and re-exports from types/index.ts. New SourceHealthEntry type goes in types.ts.

    Tests use @cloudflare/vitest-pool-workers with SELF.fetch() against the real worker.
    helpers.ts has setupDb() (inlined DDL) and clearData(). The blocks_seen DDL is already
    included in helpers.ts from Phase 1.
  </context>

  <task id="1">
    <name>Create src/utils/source-health.ts with KV helpers</name>
    <files>
      src/utils/source-health.ts (create),
      src/types.ts (add SourceHealthEntry interface)
    </files>
    <action>
      Add SourceHealthEntry interface to src/types.ts:
      ```typescript
      export interface SourceHealthEntry {
        last_delivery_at: string;    // ISO timestamp of last webhook delivery
        last_block_height: number;   // block_height from the last apply block seen
        total_deliveries: number;    // count of webhook deliveries received
        total_blocks_applied: number; // cumulative apply blocks processed
        total_blocks_rolled_back: number; // cumulative rollback blocks processed
      }
      ```

      Create src/utils/source-health.ts with:
      - KV_KEY constant: "source_health:chainhook"
      - readSourceHealth(kv: KVNamespace): Promise&lt;SourceHealthEntry | null&gt;
        Reads and JSON-parses the KV entry; returns null if absent or parse fails.
      - writeSourceHealth(kv: KVNamespace, entry: SourceHealthEntry): Promise&lt;void&gt;
        JSON-serializes and writes to KV with no TTL.
      - updateSourceHealth(kv: KVNamespace, delta: { blocksApplied: number; blocksRolledBack: number; lastBlockHeight: number }): Promise&lt;void&gt;
        Reads the current entry (or starts from zero), increments delivery count and
        block counters, sets last_delivery_at to new Date().toISOString() and
        last_block_height to delta.lastBlockHeight (if delta.blocksApplied > 0),
        then writes back.
    </action>
    <verify>
      npx tsc --noEmit (npm run check) passes with no errors on the new file.
      File exists at src/utils/source-health.ts.
      SourceHealthEntry is exported from src/types.ts.
    </verify>
    <done>
      src/utils/source-health.ts created with readSourceHealth, writeSourceHealth,
      updateSourceHealth. SourceHealthEntry interface in types.ts. npm run check passes.
    </done>
  </task>

  <task id="2">
    <name>Integrate blocks_seen recording and source health into webhook handler</name>
    <files>
      src/webhook.ts (modify)
    </files>
    <action>
      Import upsertBlockSeen and markBlockNonCanonical from ./utils/query.
      Import updateSourceHealth from ./utils/source-health.

      In the apply block loop (step 3), after the inner transaction loop completes for
      each block, call upsertBlockSeen(db, blockHeight, block.block_identifier.hash).
      Track the highest apply block height seen (for source health delta).

      In the rollback block loop (step 4), after handleRollback calls complete for each
      block, call markBlockNonCanonical(db, blockHeight).

      After step 5 (sync_state upsert), add a new step 6:
      - Call updateSourceHealth on INDEXER_KV with:
          blocksApplied: payload.event?.apply?.length ?? 0
          blocksRolledBack: payload.event?.rollback?.length ?? 0
          lastBlockHeight: the highest block height seen in apply (or 0 if no apply blocks)
      - Wrap in try/catch; log error but do not fail the response.

      Move the summary log to after the source health update (step 7).

      Errors from upsertBlockSeen and markBlockNonCanonical should be caught and logged
      (same pattern as the existing sync_state error handler) so they do not abort
      processing of remaining blocks.
    </action>
    <verify>
      npm run check passes.
      npm test passes — existing webhook tests remain green.
      Optionally verify blocks_seen rows exist after a test run by querying D1 in tests
      (the existing test suite already exercises the apply/rollback paths).
    </verify>
    <done>
      webhook.ts calls upsertBlockSeen for each apply block, markBlockNonCanonical for
      each rollback block, and updateSourceHealth after sync_state. All error paths are
      caught. npm run check and npm test pass.
    </done>
  </task>

  <task id="3">
    <name>Add blocks_seen and source health assertions to webhook tests</name>
    <files>
      src/__tests__/webhook.test.ts (modify)
    </files>
    <action>
      Add a new describe block "POST /webhook — blocks_seen" with:
      - "records apply block in blocks_seen": post applyIdentityFixture, query
        blocks_seen WHERE block_height = 100, expect is_canonical = 1 and
        block_hash = '0xblock100'.
      - "marks rollback block as non-canonical": post applyIdentityFixture first
        (to seed the block), then post rollback-block.json fixture with the test secret,
        query blocks_seen WHERE block_height = 100, expect is_canonical = 0.

      Add a new describe block "POST /webhook — source health" with:
      - "updates source health KV on delivery": post applyIdentityFixture, then read
        INDEXER_KV key "source_health:chainhook", JSON.parse it, expect
        total_deliveries = 1, total_blocks_applied = 1, last_block_height = 100.

      The rollback fixture is already imported in rollback.test.ts; import it here too:
      import rollbackFixture from "./fixtures/rollback-block.json";
    </action>
    <verify>
      npm test passes with the new test cases green.
    </verify>
    <done>
      New describe blocks in webhook.test.ts cover blocks_seen recording and source
      health KV updates. All tests pass.
    </done>
  </task>
</plan>
```
