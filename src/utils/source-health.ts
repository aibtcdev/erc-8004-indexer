/**
 * KV helpers for chainhook source health tracking.
 *
 * Stores a running health record under "source_health:chainhook" in INDEXER_KV.
 * The record is updated on every webhook delivery and can be read by the
 * status endpoint or scheduled handler for gap detection and alerting.
 */

import type { SourceHealthEntry } from "../types";

export const SOURCE_HEALTH_KEY = "source_health:chainhook";

/**
 * Read the current source health entry from KV.
 * Returns null if the key is absent or the stored value cannot be parsed.
 */
export async function readSourceHealth(
  kv: KVNamespace
): Promise<SourceHealthEntry | null> {
  const raw = await kv.get(SOURCE_HEALTH_KEY);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as SourceHealthEntry;
  } catch {
    return null;
  }
}

/**
 * Write a source health entry to KV (no TTL).
 */
export async function writeSourceHealth(
  kv: KVNamespace,
  entry: SourceHealthEntry
): Promise<void> {
  await kv.put(SOURCE_HEALTH_KEY, JSON.stringify(entry));
}

/**
 * Atomically read-modify-write the source health entry.
 * Increments delivery count and block counters; updates timestamp and
 * last_block_height when at least one apply block was included.
 */
export async function updateSourceHealth(
  kv: KVNamespace,
  delta: {
    blocksApplied: number;
    blocksRolledBack: number;
    lastBlockHeight: number;
  }
): Promise<void> {
  const current = await readSourceHealth(kv);

  const next: SourceHealthEntry = {
    last_delivery_at: new Date().toISOString(),
    last_block_height:
      delta.blocksApplied > 0
        ? delta.lastBlockHeight
        : (current?.last_block_height ?? 0),
    total_deliveries: (current?.total_deliveries ?? 0) + 1,
    total_blocks_applied:
      (current?.total_blocks_applied ?? 0) + delta.blocksApplied,
    total_blocks_rolled_back:
      (current?.total_blocks_rolled_back ?? 0) + delta.blocksRolledBack,
  };

  await writeSourceHealth(kv, next);
}
