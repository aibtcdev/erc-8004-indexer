/**
 * Chainhook webhook payload types.
 *
 * Re-exports key types from @hirosystems/chainhooks-client and defines
 * helper types and type guards for narrowing contract_log operations.
 *
 * The chainhook webhook payload structure:
 * ChainhookEvent {
 *   chainhook: { uuid, name? }
 *   event: {
 *     chain: "stacks" | "bitcoin"
 *     network: "mainnet" | "testnet"
 *     apply: StacksBlock[]   // blocks to apply (forward)
 *     rollback: StacksBlock[] // blocks to rollback (reorg)
 *   }
 * }
 *
 * Each StacksBlock has transactions[], each transaction has operations[].
 * We filter for operations where type === "contract_log" and
 * metadata.contract_identifier matches a watched contract.
 */

// Re-export the primary webhook payload type
export type { ChainhookEvent } from "@hirosystems/chainhooks-client";

// Re-export the Stacks block type (represents one block in apply/rollback arrays)
export type { StacksBlock } from "@hirosystems/chainhooks-client";

// Re-export the contract_log operation type
export type { StacksContractLogOperation } from "@hirosystems/chainhooks-client";

/**
 * The `value` field of a contract_log operation metadata.
 * Chainhooks may return either a string (plain value) or an object with
 * hex/repr fields (for complex Clarity values).
 */
export type ContractLogValue =
  | string
  | { hex: string; repr: string };

/**
 * Narrowed representation of the metadata on a contract_log operation
 * with a guaranteed repr/hex object (what ERC-8004 contracts emit).
 */
export interface ContractLogReprValue {
  hex: string;
  repr: string;
}

/**
 * A StacksOperation narrowed to only the fields needed for routing.
 * Used when iterating operations before narrowing to StacksContractLogOperation.
 */
export interface RawStacksOperation {
  type: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Type guard: narrows an unknown operation to StacksContractLogOperation.
 * Checks for type === "contract_log" and presence of metadata.contract_identifier.
 */
export function isContractLogOperation(
  op: unknown
): op is import("@hirosystems/chainhooks-client").StacksContractLogOperation {
  if (typeof op !== "object" || op === null) return false;
  const o = op as Record<string, unknown>;
  if (o["type"] !== "contract_log") return false;
  const meta = o["metadata"];
  if (typeof meta !== "object" || meta === null) return false;
  return typeof (meta as Record<string, unknown>)["contract_identifier"] === "string";
}

/**
 * Type guard: checks if a ContractLogValue is a repr/hex object.
 * ERC-8004 contracts always emit tuples, so the value will be an object.
 */
export function isReprValue(value: ContractLogValue): value is ContractLogReprValue {
  return typeof value === "object" && value !== null && "repr" in value && "hex" in value;
}

/**
 * Extracts all contract_log operations from a ChainhookEvent's apply blocks
 * that match a given contract_identifier.
 *
 * Returns an array of tuples: [txHash, operation] for further processing.
 */
export function extractContractLogs(
  event: import("@hirosystems/chainhooks-client").ChainhookEvent,
  contractIdentifier: string
): Array<{
  blockIndex: number;
  blockHash: string;
  txHash: string;
  operation: import("@hirosystems/chainhooks-client").StacksContractLogOperation;
}> {
  const results: Array<{
    blockIndex: number;
    blockHash: string;
    txHash: string;
    operation: import("@hirosystems/chainhooks-client").StacksContractLogOperation;
  }> = [];

  for (const block of event.event.apply) {
    for (const tx of block.transactions) {
      for (const op of tx.operations) {
        if (
          isContractLogOperation(op) &&
          op.metadata.contract_identifier === contractIdentifier
        ) {
          results.push({
            blockIndex: block.block_identifier.index,
            blockHash: block.block_identifier.hash,
            txHash: tx.transaction_identifier.hash,
            operation: op,
          });
        }
      }
    }
  }

  return results;
}
