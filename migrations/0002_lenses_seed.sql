-- ERC-8004 Indexer: Lens system migration
-- Adds config column to lenses table and seeds the reference "aibtc" lens.

-- Add config column to existing lenses table.
-- Using NOT NULL with DEFAULT '{}' ensures backward compatibility.
ALTER TABLE lenses ADD COLUMN config TEXT NOT NULL DEFAULT '{}';

-- Seed the reference "aibtc" lens.
INSERT OR IGNORE INTO lenses (name, description, config) VALUES (
  'aibtc',
  'AIBTC ecosystem reference lens: approved clients only, ±100 WAD bounds, rate-limited (10/day), 30-day decay.',
  '{"trust":{"approved_clients_only":true,"min_feedback_count_per_reviewer":1},"bounds":{"min_wad_value":"-100000000000000000000","max_wad_value":"100000000000000000000"},"rate":{"max_per_reviewer_per_window":10,"window_blocks":144},"decay":{"enabled":true,"half_life_blocks":4320},"weight":{"enabled":false,"weight_by_reviewer_score":false}}'
);
