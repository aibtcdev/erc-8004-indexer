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
 */

import {
  ChainhooksClient,
  CHAINHOOKS_BASE_URL,
  type EvaluateChainhookRequest,
  type ChainhookNetwork,
} from "@hirosystems/chainhooks-client";
import type { Env, Logger, LogsRPC } from "./types";

const APP_ID = "erc8004-indexer";

// ── Stacks API endpoints ─────────────────────────────────────────────────────

const STACKS_API_URL: Record<ChainhookNetwork, string> = {
  mainnet: "https://api.hiro.so/v2/info",
  testnet: "https://api.testnet.hiro.so/v2/info",
};

// Gap thresholds
/** Minimum gap to trigger a backfill batch */
const GAP_BACKFILL_THRESHOLD = 10;
/** Gap size that triggers a large-gap warning alert */
const GAP_ALERT_THRESHOLD = 100;
/** Maximum blocks to backfill per cron invocation */
const BACKFILL_BATCH_SIZE = 20;

// ── Logger factory ────────────────────────────────────────────────────────────

function isLogsRPC(logs: unknown): logs is LogsRPC {
  return (
    typeof logs === "object" &&
    logs !== null &&
    typeof (logs as LogsRPC).info === "function" &&
    typeof (logs as LogsRPC).warn === "function" &&
    typeof (logs as LogsRPC).error === "function" &&
    typeof (logs as LogsRPC).debug === "function"
  );
}

/**
 * Create a logger for the scheduled handler context.
 * Uses worker-logs RPC if LOGS binding is valid, else falls back to console.
 */
function createScheduledLogger(
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">
): Logger {
  const baseContext: Record<string, unknown> = { trigger: "cron" };

  if (isLogsRPC(env.LOGS)) {
    const logs = env.LOGS;
    return {
      info: (message, context) => {
        ctx.waitUntil(
          logs.info(APP_ID, message, { ...baseContext, ...context })
        );
      },
      warn: (message, context) => {
        ctx.waitUntil(
          logs.warn(APP_ID, message, { ...baseContext, ...context })
        );
      },
      error: (message, context) => {
        ctx.waitUntil(
          logs.error(APP_ID, message, { ...baseContext, ...context })
        );
      },
      debug: (message, context) => {
        ctx.waitUntil(
          logs.debug(APP_ID, message, { ...baseContext, ...context })
        );
      },
    };
  }

  return {
    info: (message, context) => {
      console.log(`[INFO] ${message}`, { ...baseContext, ...context });
    },
    warn: (message, context) => {
      console.warn(`[WARN] ${message}`, { ...baseContext, ...context });
    },
    error: (message, context) => {
      console.error(`[ERROR] ${message}`, { ...baseContext, ...context });
    },
    debug: (message, context) => {
      console.debug(`[DEBUG] ${message}`, { ...baseContext, ...context });
    },
  };
}

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

// ── Scheduled handler ─────────────────────────────────────────────────────────

export async function scheduledHandler(
  _event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  const logger = createScheduledLogger(env, ctx);

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

  // Step 4: Fetch chainhook status
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

  // Step 5: Alert if unhealthy
  if (!status.enabled || status.status !== "streaming") {
    logger.warn("Chainhook is not healthy", {
      uuid,
      enabled: status.enabled,
      status: status.status,
      hint:
        status.status === "expired"
          ? "Re-register with: npm run register"
          : status.status === "interrupted"
            ? "Check Chainhooks API for details"
            : "Enable via Chainhooks API",
    });
    return;
  }

  // Step 6: Fetch current Stacks block height
  const currentBlock = await fetchCurrentBlockHeight(network);
  if (currentBlock === null) {
    logger.error("Failed to fetch current Stacks block height", { network });
    return;
  }

  // Step 7: Query sync_state for max last_indexed_block
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

  // Step 8: Calculate and log gap
  const gap = currentBlock - lastIndexedBlock;
  logger.info("gap_check", {
    current_block: currentBlock,
    last_indexed_block: lastIndexedBlock,
    gap,
    network,
  });

  // Step 9: Alert on large gap
  if (gap > GAP_ALERT_THRESHOLD) {
    logger.warn("large_gap_detected", {
      gap,
      current_block: currentBlock,
      last_indexed_block: lastIndexedBlock,
      hint: "Run npm run backfill to process missed blocks",
    });
  }

  // Step 10: Trigger backfill if gap exceeds threshold
  if (gap > GAP_BACKFILL_THRESHOLD) {
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
  }
}
