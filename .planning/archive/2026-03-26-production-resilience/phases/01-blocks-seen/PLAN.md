<?xml version="1.0" encoding="UTF-8"?>
<plan>
  <goal>Create the blocks_seen D1 table migration, add BlockSeenRow type, add upsert/query functions, and update test helpers with the new DDL.</goal>
  <context>
    The project uses D1 (SQLite) with migrations in migrations/. Types are in src/types/db.ts,
    query helpers in src/utils/query.ts, and test DDL is inlined in src/__tests__/helpers.ts.
    Existing patterns: INTEGER PRIMARY KEY, ON CONFLICT DO UPDATE for upserts, parameterized
    prepare().bind() calls, and clearData() lists all tables. Boolean fields are 0|1 integers.
    The blocks_seen table tracks canonical/non-canonical status of each block processed by the indexer.
  </context>

  <task id="1">
    <name>Create blocks_seen migration</name>
    <files>migrations/0003_blocks_seen.sql</files>
    <action>
      Create migrations/0003_blocks_seen.sql with a CREATE TABLE IF NOT EXISTS blocks_seen statement.
      The table should have:
        - block_height INTEGER PRIMARY KEY
        - block_hash TEXT NOT NULL
        - is_canonical INTEGER NOT NULL DEFAULT 1  (1=canonical, 0=non-canonical/forked)
        - indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
      Add an index on is_canonical for efficient filtering.
      Follow the style of 0001_initial.sql: header comment, section comment, table, then indexes.
    </action>
    <verify>
      sqlite3 :memory: &lt; migrations/0003_blocks_seen.sql should exit 0.
      Alternatively, the file must parse without errors.
    </verify>
    <done>File migrations/0003_blocks_seen.sql exists with valid SQL DDL.</done>
  </task>

  <task id="2">
    <name>Add BlockSeenRow type and query functions</name>
    <files>src/types/db.ts, src/utils/query.ts</files>
    <action>
      In src/types/db.ts, append a BlockSeenRow interface after SyncStateRow:
        - block_height: number
        - block_hash: string
        - is_canonical: number  (1=canonical, 0=non-canonical)
        - indexed_at: string

      In src/utils/query.ts:
        1. Import BlockSeenRow from ../types/db alongside other imports.
        2. Add a new section "// ============================================================\n// Blocks seen\n// ============================================================"
        3. Add upsertBlockSeen(db, blockHeight, blockHash): inserts or updates
           using INSERT OR REPLACE INTO blocks_seen (block_height, block_hash, is_canonical, indexed_at)
           VALUES (?, ?, 1, datetime('now'))
        4. Add markBlockNonCanonical(db, blockHeight): updates is_canonical = 0 for a given block_height
        5. Add queryRecentBlocks(db, { limit, offset }): returns { rows: BlockSeenRow[], total: number }
           ordered by block_height DESC
    </action>
    <verify>
      npm run check passes (TypeScript types are correct).
    </verify>
    <done>BlockSeenRow exported from db.ts; three query functions exported from query.ts with correct signatures.</done>
  </task>

  <task id="3">
    <name>Update test helpers with blocks_seen DDL</name>
    <files>src/__tests__/helpers.ts</files>
    <action>
      In MIGRATION_DDL string, append the blocks_seen CREATE TABLE and CREATE INDEX statements
      after the lenses table (matching the format already used).
      In clearData(), add "blocks_seen" to the tables array before "agents" so it is cleared too.
      Order does not matter for DELETE (no FK constraints), but keep it consistent with logical grouping.
    </action>
    <verify>
      npm test passes — existing tests still pass and the blocks_seen table is present in test DB.
    </verify>
    <done>MIGRATION_DDL includes blocks_seen table; clearData() deletes from blocks_seen.</done>
  </task>
</plan>
