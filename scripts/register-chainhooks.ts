/**
 * register-chainhooks.ts
 *
 * Registers a single Chainhooks 2.0 subscription covering all 3 ERC-8004
 * contracts (identity-registry-v2, reputation-registry-v2, validation-registry-v2)
 * with contract_log filters.
 *
 * Usage:
 *   npm run register
 *   # or directly:
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/register-chainhooks.ts
 *
 * Required env vars:
 *   HIRO_API_KEY  — Hiro platform API key
 *   WEBHOOK_URL   — Public URL of the deployed worker (without /webhook)
 *
 * Optional env vars:
 *   CHAINHOOK_NETWORK    — "mainnet" | "testnet" (default: "testnet")
 *   START_BLOCK_HEIGHT   — Block height to start from (default: 0)
 *
 * After registration, the script prints the UUID and the wrangler command
 * to persist it in Cloudflare KV for the health check script.
 */

import {
  ChainhooksClient,
  CHAINHOOKS_BASE_URL,
  type ChainhookDefinition,
  type ChainhookNetwork,
} from "@hirosystems/chainhooks-client";

// ── Contract addresses ────────────────────────────────────────────────────────

const DEPLOYERS: Record<ChainhookNetwork, string> = {
  mainnet: "SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD",
  testnet: "ST3YT0XW92E6T2FE59B2G5N2WNNFSBZ6MZKQS5D18",
};

const CONTRACT_NAMES = [
  "identity-registry-v2",
  "reputation-registry-v2",
  "validation-registry-v2",
] as const;

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

function normalizeWebhookUrl(url: string): string {
  // Ensure the URL ends with /webhook exactly once
  const base = url.replace(/\/webhook\/?$/, "").replace(/\/$/, "");
  return `${base}/webhook`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Read required env vars
  const apiKey = requireEnv("HIRO_API_KEY");
  const webhookUrl = requireEnv("WEBHOOK_URL");

  // Read optional env vars with defaults
  const rawNetwork = process.env["CHAINHOOK_NETWORK"] ?? "testnet";
  if (rawNetwork !== "mainnet" && rawNetwork !== "testnet") {
    console.error(
      `Error: CHAINHOOK_NETWORK must be "mainnet" or "testnet", got "${rawNetwork}"`
    );
    process.exit(1);
  }
  const network: ChainhookNetwork = rawNetwork;

  const startBlockHeight = parseInt(
    process.env["START_BLOCK_HEIGHT"] ?? "0",
    10
  );

  const deployer = DEPLOYERS[network];
  const webhookEndpoint = normalizeWebhookUrl(webhookUrl);

  console.log(`Registering ERC-8004 chainhook...`);
  console.log(`  Network:       ${network}`);
  console.log(`  Deployer:      ${deployer}`);
  console.log(`  Webhook URL:   ${webhookEndpoint}`);
  console.log(`  Start height:  ${startBlockHeight}`);
  console.log();

  // Build contract_log filters — one per contract
  const eventFilters = CONTRACT_NAMES.map((name) => ({
    type: "contract_log" as const,
    contract_identifier: `${deployer}.${name}`,
  }));

  // Build the chainhook definition
  const definition: ChainhookDefinition = {
    name: `erc-8004-indexer-${network}`,
    version: "1",
    chain: "stacks",
    network,
    filters: {
      events: eventFilters,
    },
    options: {
      enable_on_registration: true,
      decode_clarity_values: true,
    },
    action: {
      type: "http_post",
      url: webhookEndpoint,
    },
  };

  // Create the client
  const baseUrl = CHAINHOOKS_BASE_URL[network];
  const client = new ChainhooksClient({ baseUrl, apiKey });

  // Register the chainhook
  let chainhook;
  try {
    chainhook = await client.registerChainhook(definition);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: Failed to register chainhook: ${message}`);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  }

  const { uuid, status } = chainhook;

  console.log(`Chainhook registered successfully!`);
  console.log(`  UUID:    ${uuid}`);
  console.log(`  Status:  ${status.status} (enabled: ${status.enabled})`);
  console.log();

  // Print instructions for storing the UUID in Cloudflare KV
  console.log(`To store the UUID in Cloudflare KV, run:`);
  console.log();
  console.log(
    `  npx wrangler kv key put "chainhook:uuid" "${uuid}" --namespace-id $CF_KV_NAMESPACE_ID`
  );
  console.log();
  console.log(
    `Then update CHAINHOOK_UUID in your .env file for use with npm run check-chainhook.`
  );
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
