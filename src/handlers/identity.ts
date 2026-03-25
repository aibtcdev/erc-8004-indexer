/**
 * Handlers for identity-registry-v2 events.
 * Each function executes D1 writes for a single event occurrence.
 */
import type { Logger } from "../types";
import type {
  RegisteredEvent,
  MetadataSetEvent,
  UriUpdatedEvent,
  ApprovalForAllEvent,
  TransferEvent,
} from "../types/events";

/**
 * Registered — INSERT a new agent row.
 * Uses ON CONFLICT DO NOTHING to be idempotent (safe to replay).
 */
export async function handleRegistered(
  db: D1Database,
  event: RegisteredEvent,
  blockHeight: number,
  txHash: string,
  logger: Logger
): Promise<void> {
  const { "agent-id": agentId, owner, "token-uri": tokenUri } = event.payload;
  logger.info("handleRegistered", { agentId, owner, blockHeight, txHash });

  try {
    await db
      .prepare(
        `INSERT INTO agents (agent_id, owner, token_uri, created_at_block, created_at_tx)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO NOTHING`
      )
      .bind(Number(agentId), owner, tokenUri || null, blockHeight, txHash)
      .run();
  } catch (err) {
    logger.error("handleRegistered: db write failed", {
      agentId,
      blockHeight,
      txHash,
      error: String(err),
    });
    throw err;
  }
}

/**
 * MetadataSet — UPSERT a key/value metadata entry for an agent.
 * The print event carries key and value-len but not the raw value bytes;
 * value_hex is stored as empty string until a separate indexing pass fills it.
 */
export async function handleMetadataSet(
  db: D1Database,
  event: MetadataSetEvent,
  blockHeight: number,
  txHash: string,
  logger: Logger
): Promise<void> {
  const { "agent-id": agentId, key, "value-len": valueLen } = event.payload;
  logger.info("handleMetadataSet", { agentId, key, blockHeight, txHash });

  try {
    await db
      .prepare(
        `INSERT INTO agent_metadata (agent_id, key, value_hex, value_len, set_at_block, set_at_tx)
         VALUES (?, ?, '', ?, ?, ?)
         ON CONFLICT(agent_id, key) DO UPDATE SET
           value_len = excluded.value_len,
           set_at_block = excluded.set_at_block,
           set_at_tx = excluded.set_at_tx`
      )
      .bind(Number(agentId), key, Number(valueLen), blockHeight, txHash)
      .run();
  } catch (err) {
    logger.error("handleMetadataSet: db write failed", {
      agentId,
      key,
      blockHeight,
      txHash,
      error: String(err),
    });
    throw err;
  }
}

/**
 * UriUpdated — UPDATE agents.token_uri for the given agent.
 */
export async function handleUriUpdated(
  db: D1Database,
  event: UriUpdatedEvent,
  blockHeight: number,
  txHash: string,
  logger: Logger
): Promise<void> {
  const { "agent-id": agentId, "new-uri": newUri } = event.payload;
  logger.info("handleUriUpdated", { agentId, newUri, blockHeight, txHash });

  try {
    await db
      .prepare(
        `UPDATE agents SET token_uri = ?, updated_at_block = ? WHERE agent_id = ?`
      )
      .bind(newUri, blockHeight, Number(agentId))
      .run();
  } catch (err) {
    logger.error("handleUriUpdated: db write failed", {
      agentId,
      blockHeight,
      txHash,
      error: String(err),
    });
    throw err;
  }
}

/**
 * ApprovalForAll — UPSERT an operator approval/revocation for an agent.
 */
export async function handleApprovalForAll(
  db: D1Database,
  event: ApprovalForAllEvent,
  blockHeight: number,
  txHash: string,
  logger: Logger
): Promise<void> {
  const { "agent-id": agentId, operator, approved } = event.payload;
  logger.info("handleApprovalForAll", {
    agentId,
    operator,
    approved,
    blockHeight,
    txHash,
  });

  try {
    await db
      .prepare(
        `INSERT INTO approvals (agent_id, operator, approved, set_at_block, set_at_tx)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, operator) DO UPDATE SET
           approved = excluded.approved,
           set_at_block = excluded.set_at_block,
           set_at_tx = excluded.set_at_tx`
      )
      .bind(Number(agentId), operator, approved ? 1 : 0, blockHeight, txHash)
      .run();
  } catch (err) {
    logger.error("handleApprovalForAll: db write failed", {
      agentId,
      operator,
      blockHeight,
      txHash,
      error: String(err),
    });
    throw err;
  }
}

/**
 * Transfer — UPDATE agents.owner when an NFT transfer occurs.
 * The token-id in the event is the same as agent_id.
 */
export async function handleTransfer(
  db: D1Database,
  event: TransferEvent,
  blockHeight: number,
  txHash: string,
  logger: Logger
): Promise<void> {
  const { "token-id": tokenId, recipient } = event.payload;
  logger.info("handleTransfer", { tokenId, recipient, blockHeight, txHash });

  try {
    await db
      .prepare(
        `UPDATE agents SET owner = ?, updated_at_block = ? WHERE agent_id = ?`
      )
      .bind(recipient, blockHeight, Number(tokenId))
      .run();
  } catch (err) {
    logger.error("handleTransfer: db write failed", {
      tokenId,
      blockHeight,
      txHash,
      error: String(err),
    });
    throw err;
  }
}
