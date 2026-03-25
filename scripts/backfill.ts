/**
 * backfill.ts
 *
 * Manual backfill script — triggers evaluateChainhook() for a range of blocks.
 * Use this on initial deployment or after recovering from an extended outage.
 *
 * Usage:
 *   npm run backfill
 *   # or directly:
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/backfill.ts
 *
 * Required env vars:
 *   HIRO_API_KEY    — Hiro platform API key
 *   CHAINHOOK_UUID  — UUID of the registered chainhook (from npm run register)
 *
 * Optional env vars:
 *   CHAINHOOK_NETWORK    — "mainnet" | "testnet" (default: "testnet")
 *   START_BLOCK_HEIGHT   — Block height to start backfill from (default: 0)
 *   END_BLOCK_HEIGHT     — Block height to end backfill at (default: current block)
 *
 * The script calls evaluateChainhook() once per block. Events arrive
 * asynchronously via the /webhook endpoint. The operation is idempotent —
 * duplicate events are handled by ON CONFLICT clauses in D1 event handlers.
 *
 * Safety limits:
 *   - Maximum range: 50,000 blocks per run
 *   - Adds a small delay between calls to avoid rate limiting
 */

import {
  ChainhooksClient,
  CHAINHOOKS_BASE_URL,
  type EvaluateChainhookRequest,
  type ChainhookNetwork,
} from "@hirosystems/chainhooks-client";
import { requireEnv, parseNetwork, STACKS_API_URL } from "./helpers.js";

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_BLOCK_RANGE = 50_000;
const REQUEST_DELAY_MS = 100; // 100ms between requests to avoid rate limiting

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchCurrentBlockHeight(
  network: ChainhookNetwork
): Promise<number> {
  const url = STACKS_API_URL[network];
  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: Failed to fetch Stacks block height from ${url}`);
    console.error(`  ${message}`);
    process.exit(1);
  }

  if (!response.ok) {
    console.error(
      `Error: Stacks API returned HTTP ${response.status} from ${url}`
    );
    process.exit(1);
  }

  const data = (await response.json()) as { stacks_tip_height?: number };
  if (typeof data.stacks_tip_height !== "number") {
    console.error(`Error: Unexpected response format from Stacks API`);
    console.error(`  Expected stacks_tip_height field in response`);
    process.exit(1);
  }

  return data.stacks_tip_height;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatProgress(current: number, total: number): string {
  const pct = Math.round((current / total) * 100);
  return `${current}/${total} (${pct}%)`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Read required env vars
  const apiKey = requireEnv("HIRO_API_KEY");
  const uuid = requireEnv("CHAINHOOK_UUID");

  const network = parseNetwork();

  const startBlock = parseInt(process.env["START_BLOCK_HEIGHT"] ?? "0", 10);
  if (isNaN(startBlock) || startBlock < 0) {
    console.error(
      `Error: START_BLOCK_HEIGHT must be a non-negative integer, got "${process.env["START_BLOCK_HEIGHT"]}"`
    );
    process.exit(1);
  }

  // Determine end block
  let endBlock: number;
  if (process.env["END_BLOCK_HEIGHT"]) {
    endBlock = parseInt(process.env["END_BLOCK_HEIGHT"], 10);
    if (isNaN(endBlock) || endBlock < 0) {
      console.error(
        `Error: END_BLOCK_HEIGHT must be a non-negative integer, got "${process.env["END_BLOCK_HEIGHT"]}"`
      );
      process.exit(1);
    }
  } else {
    console.log(`Fetching current Stacks block height from ${network}...`);
    endBlock = await fetchCurrentBlockHeight(network);
  }

  // Validate range
  if (startBlock > endBlock) {
    console.error(
      `Error: START_BLOCK_HEIGHT (${startBlock}) must be <= END_BLOCK_HEIGHT (${endBlock})`
    );
    process.exit(1);
  }

  const blockRange = endBlock - startBlock + 1;
  if (blockRange > MAX_BLOCK_RANGE) {
    console.error(
      `Error: Block range ${blockRange} exceeds maximum of ${MAX_BLOCK_RANGE}`
    );
    console.error(
      `  Split into multiple runs using START_BLOCK_HEIGHT and END_BLOCK_HEIGHT`
    );
    process.exit(1);
  }

  // Display plan
  console.log(`\nERC-8004 Indexer Backfill`);
  console.log(`  Network:          ${network}`);
  console.log(`  Chainhook UUID:   ${uuid}`);
  console.log(`  Start block:      ${startBlock}`);
  console.log(`  End block:        ${endBlock}`);
  console.log(`  Total blocks:     ${blockRange}`);
  console.log(
    `  Estimated time:   ~${Math.ceil((blockRange * REQUEST_DELAY_MS) / 1000)}s`
  );
  console.log();
  console.log(`Events will arrive asynchronously via the /webhook endpoint.`);
  console.log(`Starting in 2 seconds... (Ctrl+C to abort)\n`);

  await sleep(2000);

  // Create client
  const baseUrl = CHAINHOOKS_BASE_URL[network];
  const client = new ChainhooksClient({ baseUrl, apiKey });

  // Process blocks
  let successCount = 0;
  let errorCount = 0;
  const errorLog: Array<{ block: number; error: string }> = [];

  for (let blockHeight = startBlock; blockHeight <= endBlock; blockHeight++) {
    const processed = blockHeight - startBlock + 1;

    // Log progress every 100 blocks or on the last block
    if (processed % 100 === 0 || blockHeight === endBlock) {
      console.log(
        `  Progress: ${formatProgress(processed, blockRange)} — block ${blockHeight}`
      );
    }

    const requestBody: EvaluateChainhookRequest = {
      block_height: blockHeight,
    };

    try {
      await client.evaluateChainhook(uuid, requestBody);
      successCount++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errorCount++;
      errorLog.push({ block: blockHeight, error: message });

      // Log errors inline but don't abort
      if (errorCount <= 10) {
        console.warn(
          `  Warning: Block ${blockHeight} failed: ${message}`
        );
      } else if (errorCount === 11) {
        console.warn(
          `  Warning: Further block errors will be suppressed (too many failures)`
        );
      }
    }

    // Rate limit delay between requests
    if (blockHeight < endBlock) {
      await sleep(REQUEST_DELAY_MS);
    }
  }

  // Summary
  console.log();
  console.log(`Backfill complete!`);
  console.log(`  Blocks processed: ${blockRange}`);
  console.log(`  Successful:       ${successCount}`);
  console.log(`  Errors:           ${errorCount}`);

  if (errorCount > 0) {
    console.log();
    console.warn(
      `Warning: ${errorCount} block(s) failed. First 10 errors:`
    );
    errorLog.slice(0, 10).forEach(({ block, error }) => {
      console.warn(`  Block ${block}: ${error}`);
    });
    process.exit(1);
  }

  console.log();
  console.log(
    `Events are being delivered to the worker webhook asynchronously.`
  );
  console.log(
    `Check indexer status at: GET /api/v1/status`
  );
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
