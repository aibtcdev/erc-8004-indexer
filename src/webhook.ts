/**
 * POST /webhook — Chainhooks 2.0 event receiver.
 *
 * Authentication: Bearer token compared against "webhook_secret" in INDEXER_KV.
 * If the KV key is absent (not yet configured), the request is allowed through
 * with a warning log to simplify initial setup.
 *
 * Processing order:
 *   1. Auth check
 *   2. Parse ChainhookEvent body
 *   3. Iterate apply[] blocks → route contract_log ops to handlers
 *   4. Iterate rollback[] blocks → call handleRollback per tx
 *   5. Upsert sync_state for each contract that appeared in apply
 *   6. Return 200 {ok: true}
 */
import type { Context } from "hono";
import type { Env, AppVariables } from "./types";
import type { ChainhookEvent } from "./types/chainhook";
import { isContractLogOperation, isReprValue } from "./types/chainhook";
import { routeEvent } from "./handlers/index";
import { handleRollback } from "./handlers/rollback";
import { upsertBlockSeen, markBlockNonCanonical } from "./utils/query";
import { updateSourceHealth } from "./utils/source-health";

// ============================================================
// Contract identifiers
// ============================================================

export const IDENTITY_CONTRACT =
  "SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.identity-registry-v2";
export const REPUTATION_CONTRACT =
  "SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.reputation-registry-v2";
export const VALIDATION_CONTRACT =
  "SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.validation-registry-v2";

export const WATCHED_CONTRACTS: readonly string[] = [
  IDENTITY_CONTRACT,
  REPUTATION_CONTRACT,
  VALIDATION_CONTRACT,
] as const;

// ============================================================
// sync_state upsert
// ============================================================

async function upsertSyncState(
  db: D1Database,
  contractId: string,
  blockHeight: number,
  txHash: string | null
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sync_state (contract_id, last_indexed_block, last_indexed_tx, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(contract_id) DO UPDATE SET
         last_indexed_block = CASE
           WHEN excluded.last_indexed_block >= sync_state.last_indexed_block
           THEN excluded.last_indexed_block
           ELSE sync_state.last_indexed_block
         END,
         last_indexed_tx = CASE
           WHEN excluded.last_indexed_block >= sync_state.last_indexed_block
           THEN excluded.last_indexed_tx
           ELSE sync_state.last_indexed_tx
         END,
         updated_at = CASE
           WHEN excluded.last_indexed_block >= sync_state.last_indexed_block
           THEN excluded.updated_at
           ELSE sync_state.updated_at
         END`
    )
    .bind(contractId, blockHeight, txHash)
    .run();
}

// ============================================================
// Webhook route handler
// ============================================================

export async function webhookRoute(
  c: Context<{ Bindings: Env; Variables: AppVariables }>
): Promise<Response> {
  const logger = c.var.logger;
  const startMs = Date.now();

  // --- 1. Bearer token authentication ---
  const authHeader = c.req.header("Authorization");
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;

  const secret = await c.env.INDEXER_KV.get("webhook_secret");

  if (secret !== null) {
    // Secret is configured — enforce it
    if (!token || token !== secret) {
      logger.error("webhookRoute: unauthorized request", {
        hasToken: !!token,
        path: "auth",
      });
      return c.json({ error: "Unauthorized" }, 401);
    }
  } else {
    // No secret configured yet — allow but log a warning
    logger.warn(
      "webhookRoute: webhook_secret not set in INDEXER_KV, allowing request"
    );
  }

  // --- 2. Parse body ---
  let payload: ChainhookEvent;
  try {
    payload = await c.req.json<ChainhookEvent>();
  } catch (err) {
    logger.error("webhookRoute: failed to parse request body", {
      error: String(err),
    });
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const db = c.env.DB;
  logger.info("webhookRoute: received payload", {
    chainhookUuid: payload.chainhook?.uuid,
    applyCount: payload.event?.apply?.length ?? 0,
    rollbackCount: payload.event?.rollback?.length ?? 0,
  });

  // --- 3. Process apply blocks ---
  // Track which contracts appeared and the last block seen per contract
  const contractLastBlock = new Map<string, { height: number; txHash: string | null }>();
  let eventsReceived = 0;
  let eventsProcessed = 0;
  let highestApplyBlockHeight = 0;

  for (const block of payload.event?.apply ?? []) {
    const blockHeight = block.block_identifier.index;
    const blockHash = block.block_identifier.hash;

    for (const tx of block.transactions) {
      const txHash = tx.transaction_identifier.hash;

      for (const op of tx.operations) {
        if (!isContractLogOperation(op)) continue;
        const contractId = op.metadata.contract_identifier;
        if (!WATCHED_CONTRACTS.includes(contractId)) continue;

        const value = op.metadata.value;
        if (!isReprValue(value)) {
          logger.debug("webhookRoute: skipping non-repr value", {
            contractId,
            blockHeight,
            txHash,
          });
          continue;
        }

        eventsReceived++;

        try {
          const handled = await routeEvent(
            db,
            value.repr,
            blockHeight,
            txHash,
            logger
          );
          if (handled) {
            eventsProcessed++;
          } else {
            logger.debug("webhookRoute: event not routed", {
              contractId,
              repr: value.repr.slice(0, 100),
            });
          }
        } catch (err) {
          logger.error("webhookRoute: handler error", {
            contractId,
            blockHeight,
            txHash,
            error: String(err),
          });
          // Continue processing remaining ops — don't fail the entire webhook
        }

        // Track for sync_state update
        const existing = contractLastBlock.get(contractId);
        if (!existing || blockHeight > existing.height) {
          contractLastBlock.set(contractId, { height: blockHeight, txHash });
        }
      }
    }

    // Record block in audit log
    try {
      await upsertBlockSeen(db, blockHeight, blockHash);
    } catch (err) {
      logger.error("webhookRoute: blocks_seen upsert error", {
        blockHeight,
        error: String(err),
      });
    }

    if (blockHeight > highestApplyBlockHeight) {
      highestApplyBlockHeight = blockHeight;
    }
  }

  // --- 4. Process rollback blocks ---
  const rollbackCount = payload.event?.rollback?.length ?? 0;
  for (const block of payload.event?.rollback ?? []) {
    const blockHeight = block.block_identifier.index;

    for (const tx of block.transactions) {
      const txHash = tx.transaction_identifier.hash;
      try {
        await handleRollback(db, blockHeight, txHash, logger);
      } catch (err) {
        logger.error("webhookRoute: rollback error", {
          blockHeight,
          txHash,
          error: String(err),
        });
      }
    }

    // Mark block as non-canonical in audit log
    try {
      await markBlockNonCanonical(db, blockHeight);
    } catch (err) {
      logger.error("webhookRoute: blocks_seen non-canonical mark error", {
        blockHeight,
        error: String(err),
      });
    }
  }

  // --- 5. Update sync_state for each contract seen in apply ---
  for (const [contractId, { height, txHash }] of contractLastBlock) {
    try {
      await upsertSyncState(db, contractId, height, txHash);
    } catch (err) {
      logger.error("webhookRoute: sync_state update error", {
        contractId,
        height,
        error: String(err),
      });
    }
  }

  // --- 6. Update source health in KV ---
  try {
    await updateSourceHealth(c.env.INDEXER_KV, {
      blocksApplied: payload.event?.apply?.length ?? 0,
      blocksRolledBack: rollbackCount,
      lastBlockHeight: highestApplyBlockHeight,
    });
  } catch (err) {
    logger.error("webhookRoute: source health update error", {
      error: String(err),
    });
  }

  // --- 7. Summary log ---
  logger.info("webhookRoute: completed", {
    blockCount: payload.event?.apply?.length ?? 0,
    rollbackCount,
    eventsReceived,
    eventsProcessed,
    duration_ms: Date.now() - startMs,
  });

  return c.json({ ok: true }, 200);
}
