<?xml version="1.0" encoding="UTF-8"?>
<plan>
  <goal>Create Node.js scripts (run via tsx) that register ERC-8004 chainhooks with the Hiro Chainhooks 2.0 API, check status, and rotate consumer secrets. Store chainhook UUID in Cloudflare KV via wrangler CLI commands.</goal>
  <context>
    SDK: @hirosystems/chainhooks-client v2.1.1
    - ChainhooksClient constructor takes { baseUrl, apiKey?, jwt? }
    - CHAINHOOKS_BASE_URL = { mainnet: 'https://api.mainnet.hiro.so', testnet: 'https://api.testnet.hiro.so' }
    - registerChainhook(definition): Promise&lt;Chainhook&gt; — definition includes name, version:"1", chain:"stacks", network, filters.events[], options?, action
    - getChainhook(uuid): Promise&lt;Chainhook&gt; — returns { uuid, definition, status }
    - rotateConsumerSecret(): Promise&lt;ConsumerSecretResponse&gt; — returns { secret: string | null }
    - getConsumerSecret(): Promise&lt;ConsumerSecretResponse&gt;
    - ChainhookStatus has: status ("new"|"streaming"|"expired"|"interrupted"), enabled, last_evaluated_at, occurrence_count, etc.
    - contract_log filter shape: { type: "contract_log", contract_identifier?: string, sender?: string }

    Contracts (from quest context):
    - mainnet deployer: SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD
    - testnet deployer: ST3YT0XW92E6T2FE59B2G5N2WNNFSBZ6MZKQS5D18
    - identity-registry-v2, reputation-registry-v2, validation-registry-v2

    KV storage: wrangler kv key put command to store UUID after registration.
    KV key convention: "chainhook:uuid" (single chainhook covering all 3 contracts)

    The existing tsconfig.json uses moduleResolution: "bundler" and targets Workers, which is
    incompatible with tsx Node scripts. Need a separate tsconfig.scripts.json for Node CommonJS/ESM.
    tsx handles TypeScript execution directly, but needs Node-compatible module resolution.

    Scripts must NOT be included in worker bundle — they live in scripts/ directory excluded from
    wrangler deploy. The wrangler.jsonc "main" is src/index.ts.

    Consumer secret is returned as a hex string; worker uses it as a Bearer token in webhook
    Authorization header validation (from phase 3 implementation).

    Start block height: use a reasonable recent block for testnet (~170000), mainnet (~175000).
    Can be overridden via START_BLOCK_HEIGHT env var.
  </context>

  <task id="1">
    <name>Add tsconfig.scripts.json and .env.example</name>
    <files>
      /home/whoabuddy/dev/aibtcdev/erc-8004-indexer/tsconfig.scripts.json (create)
      /home/whoabuddy/dev/aibtcdev/erc-8004-indexer/.env.example (create)
    </files>
    <action>
      Create tsconfig.scripts.json with Node-compatible settings:
      - target: ES2022, module: NodeNext, moduleResolution: NodeNext
      - outDir not needed (tsx runs directly without emit)
      - noEmit: true
      - include: ["scripts/**/*.ts"]
      - exclude: ["node_modules", "src"]
      - types: ["node"] (not cloudflare workers)
      - skipLibCheck: true, strict: true

      Create .env.example with all required env vars:
      - HIRO_API_KEY — Hiro API key for authentication with api.mainnet.hiro.so / api.testnet.hiro.so
      - CHAINHOOK_NETWORK — "mainnet" or "testnet" (default: testnet)
      - WEBHOOK_URL — The public URL of the deployed worker's /webhook endpoint
      - START_BLOCK_HEIGHT — Optional: block height to start indexing from
      - CF_ACCOUNT_ID — Cloudflare account ID for wrangler KV commands
      - CF_KV_NAMESPACE_ID — Cloudflare KV namespace ID for INDEXER_KV (staging or production)
      - CHAINHOOK_SECRET — Current consumer secret (used by worker for webhook auth validation)
    </action>
    <verify>
      npx tsx --tsconfig tsconfig.scripts.json -e "console.log('ok')" should succeed or
      at minimum tsconfig.scripts.json should be valid JSON with correct Node settings.
    </verify>
    <done>tsconfig.scripts.json exists with NodeNext module resolution. .env.example exists with all 7 required vars documented.</done>
  </task>

  <task id="2">
    <name>Create register-chainhooks.ts script</name>
    <files>
      /home/whoabuddy/dev/aibtcdev/erc-8004-indexer/scripts/register-chainhooks.ts (create)
    </files>
    <action>
      Create scripts/register-chainhooks.ts that:

      1. Reads env vars: HIRO_API_KEY (required), CHAINHOOK_NETWORK (default "testnet"),
         WEBHOOK_URL (required), START_BLOCK_HEIGHT (optional, defaults to 0 for full history
         or a safe recent block).

      2. Determines contract addresses based on network:
         - testnet deployer: ST3YT0XW92E6T2FE59B2G5N2WNNFSBZ6MZKQS5D18
         - mainnet deployer: SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD
         Contracts: identity-registry-v2, reputation-registry-v2, validation-registry-v2
         Full identifiers: {deployer}.identity-registry-v2, etc.

      3. Creates a ChainhooksClient using CHAINHOOKS_BASE_URL[network] as baseUrl and
         HIRO_API_KEY as apiKey.

      4. Builds a single ChainhookDefinition:
         - name: "erc-8004-indexer-{network}"
         - version: "1"
         - chain: "stacks"
         - network: from env
         - filters.events: 3 contract_log filters, one per contract identifier
         - options: { enable_on_registration: true, decode_clarity_values: true }
         - action: { type: "http_post", url: WEBHOOK_URL + "/webhook" }
           Note: if WEBHOOK_URL already ends with /webhook, don't double-append

      5. Calls client.registerChainhook(definition) and gets back { uuid, definition, status }.

      6. Prints the UUID to stdout.

      7. Outputs the wrangler KV put command to store the UUID:
         console.log("Run to store UUID in KV:")
         console.log(`npx wrangler kv key put chainhook:uuid "${uuid}" --namespace-id $CF_KV_NAMESPACE_ID`)

      8. Handles errors: if registration fails (network error, auth error), log the error and
         exit with code 1.

      Import ChainhooksClient and CHAINHOOKS_BASE_URL from "@hirosystems/chainhooks-client".
      Use process.env for env vars (Node.js).
      No KV write happens in the script itself — operator runs the wrangler command.
    </action>
    <verify>
      npx tsx --tsconfig tsconfig.scripts.json scripts/register-chainhooks.ts
      Without env vars set, it should print an error like "Missing required env var: HIRO_API_KEY"
      and exit non-zero. This confirms the script is syntactically valid and runnable.
    </verify>
    <done>scripts/register-chainhooks.ts compiles and runs via tsx. Missing env var check produces clear error. No syntax or type errors.</done>
  </task>

  <task id="3">
    <name>Create check-chainhook.ts, rotate-secret.ts, and update package.json</name>
    <files>
      /home/whoabuddy/dev/aibtcdev/erc-8004-indexer/scripts/check-chainhook.ts (create)
      /home/whoabuddy/dev/aibtcdev/erc-8004-indexer/scripts/rotate-secret.ts (create)
      /home/whoabuddy/dev/aibtcdev/erc-8004-indexer/package.json (modify)
    </files>
    <action>
      Create scripts/check-chainhook.ts:
      1. Reads env vars: HIRO_API_KEY (required), CHAINHOOK_NETWORK (default "testnet"),
         CHAINHOOK_UUID (required — the UUID stored in KV).
      2. Creates ChainhooksClient with network base URL and API key.
      3. Calls client.getChainhook(uuid) to fetch current status.
      4. Logs a health summary:
         - UUID
         - Status (new/streaming/expired/interrupted)
         - Enabled (true/false)
         - occurrence_count
         - last_evaluated_block_height
         - last_occurrence_at (human readable date if not null)
      5. Exits 0 if status is "streaming" and enabled, exits 1 otherwise with warning.

      Create scripts/rotate-secret.ts:
      1. Reads env vars: HIRO_API_KEY (required), CHAINHOOK_NETWORK (default "testnet").
      2. Creates ChainhooksClient.
      3. Calls client.rotateConsumerSecret() which returns { secret: string | null }.
      4. Logs the new secret value.
      5. Prints instructions: "Update CHAINHOOK_SECRET in your worker secrets:"
         console.log(`npx wrangler secret put CHAINHOOK_SECRET`)
         console.log("Then paste the secret above when prompted.")
      6. If secret is null, log error and exit 1.

      Update package.json scripts section to add:
      - "register": "tsx --tsconfig tsconfig.scripts.json scripts/register-chainhooks.ts"
      - "check-chainhook": "tsx --tsconfig tsconfig.scripts.json scripts/check-chainhook.ts"
      - "rotate-secret": "tsx --tsconfig tsconfig.scripts.json scripts/rotate-secret.ts"

      Keep all existing scripts intact. Add the three new ones.
    </action>
    <verify>
      1. npx tsx --tsconfig tsconfig.scripts.json scripts/check-chainhook.ts
         Should print error about missing HIRO_API_KEY and exit non-zero.
      2. npx tsx --tsconfig tsconfig.scripts.json scripts/rotate-secret.ts
         Should print error about missing HIRO_API_KEY and exit non-zero.
      3. npm run register -- prints error (no real API call without valid key).
      4. npm run check -- this is not needed; npm run check-chainhook works.
    </verify>
    <done>Both helper scripts exist, compile, and handle missing env vars gracefully. package.json has register, check-chainhook, and rotate-secret npm scripts.</done>
  </task>
</plan>
