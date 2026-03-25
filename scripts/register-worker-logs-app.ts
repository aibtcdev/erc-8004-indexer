/**
 * Register the "erc8004-indexer" application with the worker-logs service.
 *
 * Usage:
 *   npm run register-logs-app
 *
 * Environment variables (from .env):
 *   WORKER_LOGS_URL  — Base URL of the worker-logs service
 *                      e.g. https://logs.aibtc.dev  (staging)
 *                      e.g. https://logs.aibtc.com  (production)
 *   ADMIN_API_KEY    — Admin API key for the worker-logs service
 *                      (source ~/dev/aibtcdev/worker-logs/.env for the key)
 */

const APP_ID = "erc8004-indexer";
const APP_DESCRIPTION =
  "ERC-8004 Indexer — Cloudflare Worker that indexes identity, reputation, and validation events from Stacks via Chainhooks 2.0";

async function main(): Promise<void> {
  const baseUrl = process.env.WORKER_LOGS_URL;
  const adminKey = process.env.ADMIN_API_KEY;

  if (!baseUrl) {
    console.error(
      "Error: WORKER_LOGS_URL is not set. Add it to your .env file.\n" +
        "Example values:\n" +
        "  WORKER_LOGS_URL=https://logs.aibtc.dev  (staging)\n" +
        "  WORKER_LOGS_URL=https://logs.aibtc.com  (production)"
    );
    process.exit(1);
  }

  if (!adminKey) {
    console.error(
      "Error: ADMIN_API_KEY is not set. Source it from ~/dev/aibtcdev/worker-logs/.env\n" +
        "  source ~/dev/aibtcdev/worker-logs/.env\n" +
        "  npm run register-logs-app"
    );
    process.exit(1);
  }

  const url = `${baseUrl.replace(/\/$/, "")}/apps`;
  console.log(`Registering app "${APP_ID}" at ${url} ...`);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Key": adminKey,
      },
      body: JSON.stringify({
        appId: APP_ID,
        description: APP_DESCRIPTION,
      }),
    });
  } catch (err) {
    console.error(`Error: Failed to reach worker-logs service at ${url}`);
    console.error(String(err));
    process.exit(1);
  }

  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  if (res.ok) {
    console.log(`Success (${res.status}):`, body);
    console.log(`\nApp "${APP_ID}" is now registered in worker-logs.`);
    console.log(
      "Logs will appear in the dashboard at " +
        `${baseUrl.replace(/\/$/, "")}/apps/${APP_ID}/logs`
    );
  } else if (res.status === 409) {
    console.log(
      `App "${APP_ID}" already exists — no action needed. (${res.status})`
    );
  } else {
    console.error(`Error: worker-logs responded with ${res.status}:`, body);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
