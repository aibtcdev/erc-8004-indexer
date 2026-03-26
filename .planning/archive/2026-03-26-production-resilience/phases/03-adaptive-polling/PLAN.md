<?xml version="1.0" encoding="UTF-8"?>
<plan>
  <goal>Enhance src/scheduled.ts to read chainhook source health from KV and adaptively lower the backfill gap threshold from 10 to 1 when the chainhook source is stale (no delivery in the last 5 minutes). After each successful backfill batch, write a polling source health entry to KV so callers can observe cron activity.</goal>
  <context>
    The scheduled handler in src/scheduled.ts runs every 5 minutes and uses a fixed GAP_BACKFILL_THRESHOLD of 10.
    The source health KV helpers (readSourceHealth, writeSourceHealth) are in src/utils/source-health.ts.
    SourceHealthEntry has a last_delivery_at ISO timestamp field that can be compared to Date.now() to determine staleness.
    The STALE_THRESHOLD_MS should be 5 minutes (300_000 ms).
    A second KV key "source_health:polling" will track the polling source's own health so other consumers can see the cron is running.
    The SOURCE_HEALTH_KEY constant is "source_health:chainhook"; the polling key will be "source_health:polling".
  </context>

  <task id="1">
    <name>Import source health helpers and add adaptive threshold logic</name>
    <files>src/scheduled.ts, src/utils/source-health.ts</files>
    <action>
      1. At the top of src/scheduled.ts, import readSourceHealth and writeSourceHealth from "./utils/source-health".
      2. Add a STALE_THRESHOLD_MS constant (5 * 60 * 1000 = 300_000).
      3. Add a STALE_GAP_BACKFILL_THRESHOLD constant with value 1 (used when chainhook is stale).
      4. After Step 8 (sync_state query) and before Step 9 (gap calculation), add a new step:
         - Call readSourceHealth(env.INDEXER_KV) to get the chainhook source health.
         - Determine if it is stale: health is null OR (Date.now() - new Date(health.last_delivery_at).getTime()) > STALE_THRESHOLD_MS.
         - Compute effectiveGapThreshold: stale ? STALE_GAP_BACKFILL_THRESHOLD : GAP_BACKFILL_THRESHOLD.
         - Log an info event "chainhook_source_stale" with { stale, last_delivery_at, effective_gap_threshold } when stale is true.
      5. In Step 11, replace the hardcoded GAP_BACKFILL_THRESHOLD check with effectiveGapThreshold.
      6. After the backfill_batch_complete log (end of Step 11), write the polling source health to KV:
         - Key "source_health:polling" using writeSourceHealth.
         - Entry: { last_delivery_at: new Date().toISOString(), last_block_height: toBlock, total_deliveries: 1, total_blocks_applied: successCount, total_blocks_rolled_back: 0 }.
         - Note: this is a write (not read-modify-write) since polling health is a snapshot of this run.
         - Use ctx.waitUntil() to fire-and-forget the KV write, consistent with how the logger fires async work.
    </action>
    <verify>
      Run: cd /home/whoabuddy/dev/aibtcdev/erc-8004-indexer && npm run check
      Expected: No TypeScript errors.
    </verify>
    <done>
      src/scheduled.ts imports readSourceHealth and writeSourceHealth, has STALE_THRESHOLD_MS and STALE_GAP_BACKFILL_THRESHOLD constants, reads chainhook source health before gap calculation, uses effectiveGapThreshold in the backfill trigger condition, and writes polling source health after a backfill batch.
    </done>
  </task>

  <task id="2">
    <name>Add tests for adaptive threshold and polling source health write</name>
    <files>src/__tests__/helpers.ts (read only), src/__tests__/webhook.test.ts (read only for patterns)</files>
    <action>
      Create src/__tests__/scheduled.test.ts with two unit-level tests that exercise the adaptive threshold logic by directly testing the condition rather than full cron invocation (which requires dynamic imports of ChainhooksClient). The tests should:

      1. Test "uses stale threshold when source health is absent" — set up KV without "source_health:chainhook", verify effectiveGapThreshold would be 1 by checking the stale condition in isolation.
      2. Test "uses stale threshold when last_delivery_at is over 5 minutes ago" — write a source health entry with last_delivery_at = 6 minutes ago, read it back, verify the stale condition is true.
      3. Test "uses normal threshold when last_delivery_at is recent" — write a source health entry with last_delivery_at = now, read it back, verify stale condition is false.

      Use the cloudflare:test env binding for real KV access. Import readSourceHealth from "../utils/source-health". Use the STALE_THRESHOLD_MS value of 300_000 inline in tests.
    </action>
    <verify>
      Run: cd /home/whoabuddy/dev/aibtcdev/erc-8004-indexer && npm test
      Expected: All tests pass including the new scheduled.test.ts tests.
    </verify>
    <done>
      src/__tests__/scheduled.test.ts exists with 3 tests covering null health (stale), old timestamp (stale), and recent timestamp (fresh). All pass.
    </done>
  </task>

  <task id="3">
    <name>Final build verification</name>
    <files>src/scheduled.ts</files>
    <action>
      Run npm run check and npm run deploy:dry-run to confirm the bundle builds cleanly with no TypeScript errors or Cloudflare Workers incompatibilities.
    </action>
    <verify>
      Run: cd /home/whoabuddy/dev/aibtcdev/erc-8004-indexer && npm run check && npm run deploy:dry-run
      Expected: Both commands exit 0 with no errors.
    </verify>
    <done>TypeScript check and dry-run build both succeed.</done>
  </task>
</plan>
