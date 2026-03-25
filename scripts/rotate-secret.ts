/**
 * rotate-secret.ts
 *
 * Rotates the Chainhooks 2.0 consumer secret via the Hiro API and prints
 * the new secret for use as a Cloudflare Worker secret.
 *
 * The consumer secret is used by the Chainhooks service to sign webhook
 * deliveries. The worker validates incoming webhooks using this secret
 * as a Bearer token (CHAINHOOK_SECRET worker secret).
 *
 * Usage:
 *   npm run rotate-secret
 *   # or directly:
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/rotate-secret.ts
 *
 * Required env vars:
 *   HIRO_API_KEY  — Hiro platform API key
 *
 * Optional env vars:
 *   CHAINHOOK_NETWORK  — "mainnet" | "testnet" (default: "testnet")
 *
 * After running, copy the printed secret and set it as the worker secret:
 *   npx wrangler secret put CHAINHOOK_SECRET
 */

import {
  ChainhooksClient,
  CHAINHOOKS_BASE_URL,
  type ChainhookNetwork,
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

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const apiKey = requireEnv("HIRO_API_KEY");

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

  console.log(`Rotating consumer secret...`);
  console.log(`  Network:  ${network}`);
  console.log();

  let result;
  try {
    result = await client.rotateConsumerSecret();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: Failed to rotate consumer secret: ${message}`);
    process.exit(1);
  }

  const { secret } = result;

  if (secret === null) {
    console.error(
      `Error: API returned null for the new secret. This is unexpected.`
    );
    console.error(`  Check your HIRO_API_KEY and network configuration.`);
    process.exit(1);
  }

  console.log(`Consumer secret rotated successfully!`);
  console.log();
  console.log(`New secret (copy this value):`);
  console.log(`  ${secret}`);
  console.log();
  console.log(`Next steps:`);
  console.log(
    `  1. Set the secret as a Cloudflare Worker secret (for your deployed environment):`
  );
  console.log(`     npx wrangler secret put CHAINHOOK_SECRET`);
  console.log(`     (paste the secret above when prompted)`);
  console.log();
  console.log(`  2. Update CHAINHOOK_SECRET in your .env file for local dev.`);
  console.log();
  console.log(
    `  3. The worker will use this secret to validate incoming webhook Bearer tokens.`
  );
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
