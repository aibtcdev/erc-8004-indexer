/**
 * Generic rollback handler for chain reorganizations.
 *
 * Deletes or un-revokes rows created/updated in the rolled-back transaction.
 * All operations are batched in a single D1 batch call for atomicity.
 */
import type { Logger } from "../types";

/**
 * Handle a rollback of a single transaction.
 *
 * - DELETE rows whose created_at_tx matches (primary forward events)
 * - Un-revoke feedback whose revoked_at_tx matches (FeedbackRevoked events)
 * - Un-respond validation requests whose responded_at_tx matches (ValidationResponse events)
 *
 * The approvals and client_approvals tables use UPSERT semantics — after rollback
 * the old value would need to come from a prior block. Since we can't reconstruct
 * the old value from the rollback payload alone, we delete those rows so they
 * can be re-applied from the canonical chain.
 */
export async function handleRollback(
  db: D1Database,
  blockHeight: number,
  txHash: string,
  logger: Logger
): Promise<void> {
  logger.info("handleRollback", { blockHeight, txHash });

  const stmts = [
    // agents: delete registrations from this tx
    db
      .prepare(
        `DELETE FROM agents WHERE created_at_block = ? AND created_at_tx = ?`
      )
      .bind(blockHeight, txHash),

    // agent_metadata: delete metadata sets from this tx
    db
      .prepare(
        `DELETE FROM agent_metadata WHERE set_at_block = ? AND set_at_tx = ?`
      )
      .bind(blockHeight, txHash),

    // approvals: delete approval ops from this tx
    db
      .prepare(
        `DELETE FROM approvals WHERE set_at_block = ? AND set_at_tx = ?`
      )
      .bind(blockHeight, txHash),

    // feedback: delete new feedback rows created in this tx
    db
      .prepare(
        `DELETE FROM feedback WHERE created_at_block = ? AND created_at_tx = ?`
      )
      .bind(blockHeight, txHash),

    // feedback: un-revoke feedback that was revoked in this tx
    db
      .prepare(
        `UPDATE feedback
         SET is_revoked = 0, revoked_at_block = NULL, revoked_at_tx = NULL
         WHERE revoked_at_block = ? AND revoked_at_tx = ?`
      )
      .bind(blockHeight, txHash),

    // client_approvals: delete approvals set in this tx
    db
      .prepare(
        `DELETE FROM client_approvals WHERE set_at_block = ? AND set_at_tx = ?`
      )
      .bind(blockHeight, txHash),

    // feedback_responses: delete responses created in this tx
    db
      .prepare(
        `DELETE FROM feedback_responses WHERE created_at_block = ? AND created_at_tx = ?`
      )
      .bind(blockHeight, txHash),

    // validation_requests: delete requests created in this tx
    db
      .prepare(
        `DELETE FROM validation_requests WHERE created_at_block = ? AND created_at_tx = ?`
      )
      .bind(blockHeight, txHash),

    // validation_requests: un-respond requests whose response was in this tx
    db
      .prepare(
        `UPDATE validation_requests
         SET has_response = 0,
             response = NULL,
             response_uri = NULL,
             response_hash = NULL,
             tag = NULL,
             responded_at_block = NULL,
             responded_at_tx = NULL
         WHERE responded_at_block = ? AND responded_at_tx = ?`
      )
      .bind(blockHeight, txHash),
  ];

  await db.batch(stmts);
}
