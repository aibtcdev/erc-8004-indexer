-- ERC-8004 Agent Identity Index
CREATE TABLE IF NOT EXISTS agents (
  agent_id INTEGER PRIMARY KEY,
  owner TEXT NOT NULL,
  uri TEXT,
  wallet TEXT,
  network TEXT NOT NULL DEFAULT 'mainnet',
  indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index metadata (last sync state)
CREATE TABLE IF NOT EXISTS index_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(owner);
CREATE INDEX IF NOT EXISTS idx_agents_wallet ON agents(wallet);
CREATE INDEX IF NOT EXISTS idx_agents_updated_at ON agents(updated_at);
