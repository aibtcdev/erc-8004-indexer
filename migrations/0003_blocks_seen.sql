-- ERC-8004 Indexer: blocks_seen audit table
-- Tracks every block the indexer has processed, with canonical/fork status.
-- Enables gap detection, fork recovery, and block audit history.

-- ============================================================
-- blocks_seen: audit log of processed blocks
-- ============================================================
CREATE TABLE IF NOT EXISTS blocks_seen (
  block_height INTEGER PRIMARY KEY,
  block_hash   TEXT    NOT NULL,
  -- 1 = canonical (on the tip chain), 0 = non-canonical (forked/orphaned)
  is_canonical INTEGER NOT NULL DEFAULT 1,
  indexed_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_blocks_seen_is_canonical
  ON blocks_seen (is_canonical);
