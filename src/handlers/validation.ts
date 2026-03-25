/**
 * Handlers for validation-registry-v2 events.
 */
import type { Logger } from "../types";
import type {
  ValidationRequestEvent,
  ValidationResponseEvent,
} from "../types/events";

/**
 * ValidationRequest — INSERT a new pending validation request.
 * Uses ON CONFLICT DO NOTHING; request_hash is the unique key.
 */
export async function handleValidationRequest(
  db: D1Database,
  event: ValidationRequestEvent,
  blockHeight: number,
  txHash: string,
  logger: Logger
): Promise<void> {
  const {
    validator,
    "agent-id": agentId,
    "request-hash": requestHash,
    "request-uri": requestUri,
  } = event.payload;
  logger.info("handleValidationRequest", {
    requestHash,
    agentId,
    validator,
    blockHeight,
    txHash,
  });

  try {
    await db
      .prepare(
        `INSERT INTO validation_requests
           (request_hash, agent_id, validator, request_uri, has_response,
            created_at_block, created_at_tx)
         VALUES (?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(request_hash) DO NOTHING`
      )
      .bind(requestHash, Number(agentId), validator, requestUri, blockHeight, txHash)
      .run();
  } catch (err) {
    logger.error("handleValidationRequest: db write failed", {
      requestHash,
      agentId,
      blockHeight,
      txHash,
      error: String(err),
    });
    throw err;
  }
}

/**
 * ValidationResponse — UPDATE the matching validation request with response data.
 */
export async function handleValidationResponse(
  db: D1Database,
  event: ValidationResponseEvent,
  blockHeight: number,
  txHash: string,
  logger: Logger
): Promise<void> {
  const {
    "request-hash": requestHash,
    response,
    tag,
    "response-uri": responseUri,
    "response-hash": responseHash,
  } = event.payload;
  logger.info("handleValidationResponse", {
    requestHash,
    response,
    blockHeight,
    txHash,
  });

  try {
    await db
      .prepare(
        `UPDATE validation_requests
         SET has_response = 1,
             response = ?,
             response_uri = ?,
             response_hash = ?,
             tag = ?,
             responded_at_block = ?,
             responded_at_tx = ?
         WHERE request_hash = ?`
      )
      .bind(response, responseUri, responseHash, tag, blockHeight, txHash, requestHash)
      .run();
  } catch (err) {
    logger.error("handleValidationResponse: db write failed", {
      requestHash,
      blockHeight,
      txHash,
      error: String(err),
    });
    throw err;
  }
}
