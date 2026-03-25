/**
 * check-chainhook.ts
 *
 * Queries the Chainhooks 2.0 API for the status of the registered ERC-8004
 * chainhook and reports a health summary.
 *
 * Usage:
 *   npm run check-chainhook
 *   # or directly:
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/check-chainhook.ts
 *
 * Required env vars:
 *   HIRO_API_KEY    — Hiro platform API key
 *   CHAINHOOK_UUID  — UUID of the registered chainhook (from npm run register)
 *
 * Optional env vars:
 *   CHAINHOOK_NETWORK  — "mainnet" | "testnet" (default: "testnet")
 *
 * Exit codes:
 *   0 — Chainhook is healthy (status: streaming, enabled: true)
 *   1 — Chainhook is unhealthy or could not be fetched
 */

import {
  ChainhooksClient,
  CHAINHOOKS_BASE_URL,
  type ChainhookNetwork,
  type ChainhookStatus,
} from "@hirosystems/chainhooks-client";

// ── Helpers ───────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Error: Missing required environment variable: ${name}`);
    console.error(`  Set it in your .env file or export it before running.`);
    process.exit(1);
  }
  return value;
}

function formatTimestamp(ts: number | null): string {
  if (ts === null) return "never";
  return new Date(ts * 1000).toISOString();
}

function healthLabel(status: ChainhookStatus): string {
  if (status.enabled && status.status === "streaming") return "HEALTHY";
  if (!status.enabled) return "DISABLED";
  if (status.status === "expired") return "EXPIRED";
  if (status.status === "interrupted") return "INTERRUPTED";
  return status.status.toUpperCase();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const apiKey = requireEnv("HIRO_API_KEY");
  const uuid = requireEnv("CHAINHOOK_UUID");

  const rawNetwork = process.env["CHAINHOOK_NETWORK"] ?? "testnet";
  if (rawNetwork !== "mainnet" && rawNetwork !== "testnet") {
    console.error(
      `Error: CHAINHOOK_NETWORK must be "mainnet" or "testnet", got "${rawNetwork}"`
    );
    process.exit(1);
  }
  const network: ChainhookNetwork = rawNetwork;

  const baseUrl = CHAINHOOKS_BASE_URL[network];
  const client = new ChainhooksClient({ baseUrl, apiKey });

  console.log(`Fetching chainhook status...`);
  console.log(`  Network:  ${network}`);
  console.log(`  UUID:     ${uuid}`);
  console.log();

  let chainhook;
  try {
    chainhook = await client.getChainhook(uuid);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: Failed to fetch chainhook: ${message}`);
    process.exit(1);
  }

  const { status, definition } = chainhook;
  const health = healthLabel(status);

  console.log(`Chainhook Health Report`);
  console.log(`  UUID:                       ${uuid}`);
  console.log(`  Name:                       ${definition.name}`);
  console.log(`  Health:                     ${health}`);
  console.log(`  Status:                     ${status.status}`);
  console.log(`  Enabled:                    ${status.enabled}`);
  console.log(`  Occurrence count:           ${status.occurrence_count}`);
  console.log(`  Evaluated block count:      ${status.evaluated_block_count}`);
  console.log(
    `  Last evaluated block:       ${status.last_evaluated_block_height ?? "none"}`
  );
  console.log(
    `  Last evaluated at:          ${formatTimestamp(status.last_evaluated_at)}`
  );
  console.log(
    `  Last occurrence at:         ${formatTimestamp(status.last_occurrence_at)}`
  );
  console.log(
    `  Last occurrence block:      ${status.last_occurrence_block_height ?? "none"}`
  );

  if (health !== "HEALTHY") {
    console.log();
    console.warn(`Warning: Chainhook is not in a healthy state (${health}).`);
    if (status.status === "expired") {
      console.warn(
        `  The chainhook has expired. Re-register with: npm run register`
      );
    } else if (status.status === "interrupted") {
      console.warn(
        `  The chainhook was interrupted. Check the Chainhooks API for details.`
      );
    } else if (!status.enabled) {
      console.warn(
        `  The chainhook is disabled. Enable it via the Chainhooks API.`
      );
    }
    process.exit(1);
  }

  console.log();
  console.log(`Chainhook is healthy and streaming.`);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
