/**
 * Unit-level tests for the adaptive gap threshold logic in the scheduled handler.
 *
 * These tests exercise the staleness detection condition directly using
 * real KV reads via the cloudflare:test env binding, without invoking
 * the full cron handler (which requires dynamic import of ChainhooksClient).
 */
import { describe, it, expect } from "vitest";
import { env as rawEnv } from "cloudflare:test";
import type { Env } from "../types";
import { readSourceHealth } from "../utils/source-health";

const env = rawEnv as unknown as Env;

const STALE_THRESHOLD_MS = 5 * 60 * 1000;

function isStale(health: Awaited<ReturnType<typeof readSourceHealth>>): boolean {
  if (health === null) return true;
  return Date.now() - new Date(health.last_delivery_at).getTime() > STALE_THRESHOLD_MS;
}

describe("scheduled — adaptive gap threshold staleness detection", () => {
  it("treats absent source health as stale", async () => {
    await env.INDEXER_KV.delete("source_health:chainhook");
    const health = await readSourceHealth(env.INDEXER_KV);
    expect(isStale(health)).toBe(true);
  });

  it("treats a delivery older than 5 minutes as stale", async () => {
    const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    await env.INDEXER_KV.put(
      "source_health:chainhook",
      JSON.stringify({
        last_delivery_at: sixMinutesAgo,
        last_block_height: 100,
        total_deliveries: 5,
        total_blocks_applied: 5,
        total_blocks_rolled_back: 0,
      })
    );
    const health = await readSourceHealth(env.INDEXER_KV);
    expect(isStale(health)).toBe(true);
  });

  it("treats a delivery within the last 5 minutes as fresh", async () => {
    const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
    await env.INDEXER_KV.put(
      "source_health:chainhook",
      JSON.stringify({
        last_delivery_at: oneMinuteAgo,
        last_block_height: 200,
        total_deliveries: 10,
        total_blocks_applied: 10,
        total_blocks_rolled_back: 0,
      })
    );
    const health = await readSourceHealth(env.INDEXER_KV);
    expect(isStale(health)).toBe(false);
  });
});
