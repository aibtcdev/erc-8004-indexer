<?xml version="1.0" encoding="UTF-8"?>
<plan>
  <goal>Expand GET /api/v1/status to return source health entries from KV, recent blocks from blocks_seen, and gap information. Add integration tests for the new response shape.</goal>
  <context>
    The status route currently returns: status, version, timestamp, sync_state.
    We need to add three new fields:
    - source_health: SourceHealthEntry | null — read from KV via readSourceHealth()
    - recent_blocks: BlockSeenRow[] — top 5 most recent blocks from queryRecentBlocks()
    - gap: { current_block: number; last_indexed_block: number; gap_size: number } | null
      computed from sync_state MAX(last_indexed_block) vs source_health.last_block_height

    Relevant functions:
    - readSourceHealth(kv) in src/utils/source-health.ts
    - queryRecentBlocks(db, {limit, offset}) in src/utils/query.ts
    - querySyncState(db) in src/utils/query.ts (already imported)

    Test pattern: seedAll() to trigger webhook delivery (which writes source health + blocks_seen),
    then GET /status and assert new fields are present.
  </context>

  <task id="1">
    <name>Enhance status route with source health, recent blocks, and gap fields</name>
    <files>src/routes/status.ts</files>
    <action>
      1. Import readSourceHealth from ../utils/source-health
      2. Import queryRecentBlocks from ../utils/query (already imports querySyncState)
      3. In the GET /status handler, fetch all three in parallel:
         - querySyncState(c.env.DB) — already there
         - readSourceHealth(c.env.INDEXER_KV) — new
         - queryRecentBlocks(c.env.DB, { limit: 5, offset: 0 }) — new
      4. Compute gap field:
         - last_indexed_block = MAX of sync_state rows' last_indexed_block (0 if empty)
         - current_block = source_health?.last_block_height ?? 0
         - gap_size = current_block - last_indexed_block
         - Include gap object if both values are available, else null
      5. Return JSON with: status, version, timestamp, sync_state, source_health, recent_blocks, gap
    </action>
    <verify>npm run check — no TypeScript errors</verify>
    <done>
      status route returns source_health (SourceHealthEntry | null), recent_blocks (array),
      and gap ({ current_block, last_indexed_block, gap_size } | null) alongside existing fields.
    </done>
  </task>

  <task id="2">
    <name>Add integration test for enhanced status response shape</name>
    <files>src/__tests__/api.test.ts</files>
    <action>
      Add a second test inside the existing "GET /api/v1/status" describe block.
      After seedAll(), the webhook delivery writes source health and blocks_seen records.
      Assert:
      - body.source_health is not null (object with last_delivery_at, last_block_height, total_deliveries)
      - body.recent_blocks is an array with length > 0
      - body.gap is an object with keys: current_block, last_indexed_block, gap_size (all numbers)
      Keep the existing test ("returns status ok with version and timestamp") unchanged.
    </action>
    <verify>npm test — all tests pass including new status test</verify>
    <done>
      New test "includes source_health, recent_blocks, and gap in response" passes.
    </done>
  </task>
</plan>
