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

