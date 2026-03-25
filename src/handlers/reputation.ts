/**
 * Handlers for reputation-registry-v2 events.
 */
import type { Logger } from "../types";
import type {
  ClientApprovedEvent,
  NewFeedbackEvent,
  FeedbackRevokedEvent,
  ResponseAppendedEvent,
} from "../types/events";

/**
 * Normalize a raw feedback value to 18 decimal places (WAD).
 * Uses BigInt arithmetic to avoid floating-point precision issues.
 *
 * wad_value = value * 10^(18 - value_decimals)
 *
 * If value_decimals > 18, divide instead of multiply to avoid overflow.
 */
function normalizeToWad(value: string, valueDecimals: string): string {
  const val = BigInt(value);
  const dec = BigInt(valueDecimals);
  const WAD = 18n;

  if (dec <= WAD) {
    const scale = 10n ** (WAD - dec);
    return (val * scale).toString();
  } else {
    // decimals > 18: divide (truncate toward zero)
    const scale = 10n ** (dec - WAD);
    return (val / scale).toString();
  }
}

/**
 * ClientApproved — UPSERT the index limit granted to a client by an agent.
 */
export async function handleClientApproved(
  db: D1Database,
  event: ClientApprovedEvent,
  blockHeight: number,
  txHash: string,
  logger: Logger
): Promise<void> {
  const { "agent-id": agentId, client, "index-limit": indexLimit } =
    event.payload;
  logger.info("handleClientApproved", { agentId, client, blockHeight, txHash });

  await db
    .prepare(
      `INSERT INTO client_approvals (agent_id, client, index_limit, set_at_block, set_at_tx)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(agent_id, client) DO UPDATE SET
         index_limit = excluded.index_limit,
         set_at_block = excluded.set_at_block,
         set_at_tx = excluded.set_at_tx`
    )
    .bind(Number(agentId), client, indexLimit, blockHeight, txHash)
    .run();
}

/**
 * NewFeedback — INSERT a feedback entry with WAD-normalized value.
 * Uses ON CONFLICT DO NOTHING so replaying the same event is safe.
 */
export async function handleNewFeedback(
  db: D1Database,
  event: NewFeedbackEvent,
  blockHeight: number,
  txHash: string,
  logger: Logger
): Promise<void> {
  const {
    "agent-id": agentId,
    client,
    index,
    value,
    "value-decimals": valueDecimals,
    tag1,
    tag2,
    endpoint,
    "feedback-uri": feedbackUri,
    "feedback-hash": feedbackHash,
  } = event.payload;

  const wadValue = normalizeToWad(value, valueDecimals);
  logger.info("handleNewFeedback", {
    agentId,
    client,
    index,
    wadValue,
    blockHeight,
    txHash,
  });

  await db
    .prepare(
      `INSERT INTO feedback
         (agent_id, client, feedback_index, value, value_decimals, wad_value,
          tag1, tag2, endpoint, feedback_uri, feedback_hash,
          is_revoked, created_at_block, created_at_tx)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(agent_id, client, feedback_index) DO NOTHING`
    )
    .bind(
      Number(agentId),
      client,
      Number(index),
      value,
      valueDecimals,
      wadValue,
      tag1,
      tag2,
      endpoint,
      feedbackUri,
      feedbackHash,
      blockHeight,
      txHash
    )
    .run();
}

/**
 * FeedbackRevoked — mark an existing feedback entry as revoked.
 */
export async function handleFeedbackRevoked(
  db: D1Database,
  event: FeedbackRevokedEvent,
  blockHeight: number,
  txHash: string,
  logger: Logger
): Promise<void> {
  const { "agent-id": agentId, client, index } = event.payload;
  logger.info("handleFeedbackRevoked", {
    agentId,
    client,
    index,
    blockHeight,
    txHash,
  });

  await db
    .prepare(
      `UPDATE feedback
       SET is_revoked = 1, revoked_at_block = ?, revoked_at_tx = ?
       WHERE agent_id = ? AND client = ? AND feedback_index = ?`
    )
    .bind(blockHeight, txHash, Number(agentId), client, Number(index))
    .run();
}

/**
 * ResponseAppended — INSERT a response record for a feedback entry.
 */
export async function handleResponseAppended(
  db: D1Database,
  event: ResponseAppendedEvent,
  blockHeight: number,
  txHash: string,
  logger: Logger
): Promise<void> {
  const {
    "agent-id": agentId,
    client,
    index,
    responder,
    "response-uri": responseUri,
    "response-hash": responseHash,
  } = event.payload;
  logger.info("handleResponseAppended", {
    agentId,
    client,
    index,
    responder,
    blockHeight,
    txHash,
  });

  await db
    .prepare(
      `INSERT INTO feedback_responses
         (agent_id, client, feedback_index, responder, response_uri, response_hash,
          created_at_block, created_at_tx)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      Number(agentId),
      client,
      Number(index),
      responder,
      responseUri,
      responseHash,
      blockHeight,
      txHash
    )
    .run();
}
