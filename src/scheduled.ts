/**
 * scheduled.ts
 *
 * Cloudflare Worker cron handler — runs every 5 minutes.
 *
 * Responsibilities:
 * 1. Check chainhook health via KV UUID + Chainhooks API
 * 2. Detect gaps between sync_state.last_indexed_block and current Stacks block height
 * 3. Trigger evaluateChainhook() for missed blocks (backfill up to BACKFILL_BATCH_SIZE)
 * 4. Log alerts for anomalies (unhealthy chainhook, large gaps)
 *
 * Note: evaluateChainhook() processes a single block per call.
 * Results arrive asynchronously via the /webhook endpoint.
 *
 * ChainhooksClient is dynamically imported to avoid pulling undici (a Node.js
 * HTTP client) into the Workers bundle, which is incompatible with the CF
 * Workers runtime and breaks vitest-pool-workers test execution.
 */

import type {
  ChainhookNetwork,
  EvaluateChainhookRequest,
} from "@hirosystems/chainhooks-client";
import type { Env } from "./types";
import { createLogger } from "./middleware/logger";
import type { SourceHealthEntry } from "./types";
import { readSourceHealth } from "./utils/source-health";

/** KV key for the cron polling source health snapshot */
const POLLING_HEALTH_KEY = "source_health:polling";

// ── Stacks API endpoints ─────────────────────────────────────────────────────

const STACKS_API_URL: Record<ChainhookNetwork, string> = {
  mainnet: "https://api.hiro.so/v2/info",
  testnet: "https://api.testnet.hiro.so/v2/info",
};

// Gap thresholds
/** Minimum gap to trigger a backfill batch under normal conditions */
const GAP_BACKFILL_THRESHOLD = 10;
/** Minimum gap to trigger a backfill batch when chainhook source is stale */
const STALE_GAP_BACKFILL_THRESHOLD = 1;
/** Gap size that triggers a large-gap warning alert */
const GAP_ALERT_THRESHOLD = 100;
/** Maximum blocks to backfill per cron invocation */
const BACKFILL_BATCH_SIZE = 20;
/** How long without a chainhook delivery before the source is considered stale (5 minutes) */
const STALE_THRESHOLD_MS = 5 * 60 * 1000;

// ── Stacks API ────────────────────────────────────────────────────────────────

async function fetchCurrentBlockHeight(
  network: ChainhookNetwork
): Promise<number | null> {
  try {
    const response = await fetch(STACKS_API_URL[network]);
    if (!response.ok) return null;
    const data = (await response.json()) as { stacks_tip_height?: number };
    return typeof data.stacks_tip_height === "number"
      ? data.stacks_tip_height
      : null;
  } catch {
    return null;
  }
}

function getUnhealthyHint(status: string): string {
  if (status === "expired") return "Re-register with: npm run register";
  if (status === "interrupted") return "Check Chainhooks API for details";
  return "Enable via Chainhooks API";
}

// ── Scheduled handler ─────────────────────────────────────────────────────────

export async function scheduledHandler(
  _event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  const logger = createLogger(env.LOGS, ctx, { trigger: "cron" });

  // Step 1: Read chainhook UUID from KV
  const uuid = await env.INDEXER_KV.get("chainhook:uuid");
  if (!uuid) {
    logger.warn("No chainhook UUID in KV — skipping health check", {
      hint: "Run npm run register and store UUID with wrangler kv key put",
    });
    return;
  }

  // Step 2: Require HIRO_API_KEY
  const apiKey = env.HIRO_API_KEY;
  if (!apiKey) {
    logger.warn("HIRO_API_KEY not set — skipping health check", {
      hint: "Set via wrangler secret put HIRO_API_KEY",
    });
    return;
  }

  // Step 3: Determine network from environment
  const network: ChainhookNetwork =
    env.ENVIRONMENT === "production" ? "mainnet" : "testnet";

  // Step 4: Dynamically import ChainhooksClient to keep it out of the static
  // module graph — avoids loading undici in the Workers/vitest environment.
  const { ChainhooksClient, CHAINHOOKS_BASE_URL } = await import(
    "@hirosystems/chainhooks-client"
  );

  // Step 5: Fetch chainhook status
  const baseUrl = CHAINHOOKS_BASE_URL[network];
  const client = new ChainhooksClient({ baseUrl, apiKey });

  let chainhookStatus: Awaited<ReturnType<typeof client.getChainhook>>;
  try {
    chainhookStatus = await client.getChainhook(uuid);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Failed to fetch chainhook status", { uuid, error: message });
    return;
  }

  const { status } = chainhookStatus;
  logger.info("chainhook_health", {
    uuid,
    enabled: status.enabled,
    status: status.status,
    last_evaluated_block_height: status.last_evaluated_block_height ?? null,
    occurrence_count: status.occurrence_count,
  });

  // Step 6: Alert if unhealthy
  if (!status.enabled || status.status !== "streaming") {
    logger.warn("Chainhook is not healthy", {
      uuid,
      enabled: status.enabled,
      status: status.status,
      hint: getUnhealthyHint(status.status),
    });
    return;
  }

  // Step 7: Fetch current Stacks block height
  const currentBlock = await fetchCurrentBlockHeight(network);
  if (currentBlock === null) {
    logger.error("Failed to fetch current Stacks block height", { network });
    return;
  }

  // Step 8: Query sync_state for max last_indexed_block
  const syncRow = await env.DB.prepare(
    "SELECT MAX(last_indexed_block) AS max_block FROM sync_state"
  ).first<{ max_block: number | null }>();

  const lastIndexedBlock = syncRow?.max_block ?? 0;

  if (lastIndexedBlock === 0) {
    logger.info("sync_state empty — no gap check needed", {
      current_block: currentBlock,
      hint: "Run npm run backfill to populate historical data",
    });
    return;
  }

  // Step 9: Read chainhook source health to determine adaptive gap threshold
  const sourceHealth = await readSourceHealth(env.INDEXER_KV);
  const chainhookStale =
    sourceHealth === null ||
    Date.now() - new Date(sourceHealth.last_delivery_at).getTime() >
      STALE_THRESHOLD_MS;

  if (chainhookStale) {
    logger.info("chainhook_source_stale", {
      stale: true,
      last_delivery_at: sourceHealth?.last_delivery_at ?? null,
      effective_gap_threshold: STALE_GAP_BACKFILL_THRESHOLD,
    });
  }

  const effectiveGapThreshold = chainhookStale
    ? STALE_GAP_BACKFILL_THRESHOLD
    : GAP_BACKFILL_THRESHOLD;

  // Step 10: Calculate and log gap
  const gap = currentBlock - lastIndexedBlock;
  logger.info("gap_check", {
    current_block: currentBlock,
    last_indexed_block: lastIndexedBlock,
    gap,
    network,
  });

  // Step 11: Alert on large gap
  if (gap > GAP_ALERT_THRESHOLD) {
    logger.warn("large_gap_detected", {
      gap,
      current_block: currentBlock,
      last_indexed_block: lastIndexedBlock,
      hint: "Run npm run backfill to process missed blocks",
    });
  }

  // Step 12: Trigger backfill if gap exceeds effective threshold
  if (gap > effectiveGapThreshold) {
    const fromBlock = lastIndexedBlock + 1;
    // Cap at BACKFILL_BATCH_SIZE blocks per cron run to avoid timeout
    const toBlock = Math.min(
      currentBlock,
      lastIndexedBlock + BACKFILL_BATCH_SIZE
    );

    logger.info("backfill_triggered", {
      from_block: fromBlock,
      to_block: toBlock,
      gap,
      batch_size: toBlock - fromBlock + 1,
      uuid,
    });

    // evaluateChainhook processes one block at a time
    let successCount = 0;
    let errorCount = 0;
    for (let blockHeight = fromBlock; blockHeight <= toBlock; blockHeight++) {
      const requestBody: EvaluateChainhookRequest = {
        block_height: blockHeight,
      };
      try {
        await client.evaluateChainhook(uuid, requestBody);
        successCount++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("backfill_block_failed", {
          block_height: blockHeight,
          error: message,
        });
        errorCount++;
        // Continue with next block rather than aborting the whole batch
      }
    }

    logger.info("backfill_batch_complete", {
      from_block: fromBlock,
      to_block: toBlock,
      success_count: successCount,
      error_count: errorCount,
      note: "Events will arrive via webhook asynchronously",
    });

    // Write polling source health so callers can observe that the cron ran
    const pollingHealth: SourceHealthEntry = {
      last_delivery_at: new Date().toISOString(),
      last_block_height: toBlock,
      total_deliveries: 1,
      total_blocks_applied: successCount,
      total_blocks_rolled_back: 0,
    };
    ctx.waitUntil(
      env.INDEXER_KV.put(POLLING_HEALTH_KEY, JSON.stringify(pollingHealth))
    );
  }
}
