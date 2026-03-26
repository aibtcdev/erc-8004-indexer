/**
 * Shared helpers for ERC-8004 Indexer operational scripts.
 */

import type { ChainhookNetwork } from "@hirosystems/chainhooks-client";

/**
 * Read a required environment variable or exit with an error message.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Error: Missing required environment variable: ${name}`);
    console.error(`  Set it in your .env file or export it before running.`);
    process.exit(1);
  }
  return value;
}

/**
 * Parse and validate the CHAINHOOK_NETWORK environment variable.
 * Defaults to "testnet" if not set.
 */
export function parseNetwork(): ChainhookNetwork {
  const raw = process.env["CHAINHOOK_NETWORK"] ?? "testnet";
  if (raw !== "mainnet" && raw !== "testnet") {
    console.error(
      `Error: CHAINHOOK_NETWORK must be "mainnet" or "testnet", got "${raw}"`
    );
    process.exit(1);
  }
  return raw;
}

/** Stacks API info endpoints by network. */
export const STACKS_API_URL: Record<ChainhookNetwork, string> = {
  mainnet: "https://api.hiro.so/v2/info",
  testnet: "https://api.testnet.hiro.so/v2/info",
};
