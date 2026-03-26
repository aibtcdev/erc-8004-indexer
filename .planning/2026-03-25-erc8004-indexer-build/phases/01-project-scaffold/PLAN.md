<?xml version="1.0" encoding="UTF-8"?>
<plan>
  <goal>Set up the Cloudflare Worker project matching org conventions exactly. Hono app skeleton, wrangler.jsonc with D1 + KV + LOGS bindings and staging/production environments, tsconfig, vitest with cloudflare pool, package.json scripts, release-please config, version.ts, logger middleware, type definitions, and RPC entrypoint skeleton. Worker builds, type-checks, and responds to GET / with service info.</goal>

  <context>
    The repo has an initial scaffold commit with only:
    - IMPLEMENTATION_PLAN.md (overall project plan)
    - .gitignore, .env.example, .planning/ directory

    Reference patterns from agent-news and agent-hub (org workers):
    - wrangler.jsonc with $schema, nodejs_compat_v2, observability off, env blocks that duplicate ALL bindings
    - Logger middleware: isLogsRPC type guard, createRpcLogger + createConsoleLogger, request-scoped via c.set("logger", ...)
    - LogsRPC interface defined locally (not imported from package)
    - Types: Env interface with DB: D1Database, INDEXER_KV: KVNamespace, LOGS?: unknown, AppVariables with requestId + logger
    - version.ts pattern: export const VERSION = "0.1.0"; // x-release-please-version
    - vitest.config.ts using cloudflareTest() from @cloudflare/vitest-pool-workers, LOGS stub as serviceBinding
    - package.json scripts: wrangler alias (set -a && . ./.env && set +a && npx wrangler), dev, deploy:dry-run, deploy:staging, deploy:production, check, test, test:watch, cf-typegen
    - release-please-config.json with node release type and src/version.ts extra-file
    - D1: binding name "DB", KV: binding name "INDEXER_KV", service: binding "LOGS" -> worker-logs-{env}
    - Staging domain: erc8004.aibtc.dev, Production domain: erc8004.aibtc.com
    - WorkerEntrypoint RPC pattern from worker-logs
    - CLAUDE.md in repo root for project conventions
  </context>

  <task id="1">
    <name>Core config files: package.json, tsconfig.json, wrangler.jsonc, release-please</name>
    <files>
      package.json,
      tsconfig.json,
      wrangler.jsonc,
      release-please-config.json,
      .release-please-manifest.json,
      .github/workflows/release-please.yml,
      vitest.config.ts
    </files>
    <action>
      Create package.json with:
      - name: "erc-8004-indexer", version: "0.1.0", private: true
      - scripts: wrangler (set -a && . ./.env && set +a && npx wrangler), dev, deploy:dry-run (wrangler deploy --dry-run), deploy:staging (wrangler deploy --env staging), deploy:production (wrangler deploy --env production), check (tsc --noEmit), test (vitest run), test:watch (vitest), cf-typegen (wrangler types)
      - dependencies: hono ^4.12.7
      - devDependencies: typescript ^5.9.3, wrangler ^4.77.0, @cloudflare/vitest-pool-workers ^0.13.2, @cloudflare/workers-types ^4.20241205.0, @types/node ^25.3.3, tsx ^4.19.2, vitest ^4.1.0

      Create tsconfig.json matching agent-news pattern:
      - target/module: ES2022, moduleResolution: bundler, strict: true, strictNullChecks: true, skipLibCheck: true, noEmit: true
      - types: ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers/types"]
      - include: ["src/**/*.ts", "vitest.config.ts"]
      - exclude: ["node_modules", "dist"]

      Create wrangler.jsonc:
      - $schema: "node_modules/wrangler/config-schema.json"
      - name: "erc-8004-indexer", main: "src/index.ts"
      - compatibility_date: "2026-01-01", compatibility_flags: ["nodejs_compat_v2"]
      - workers_dev: true, preview_urls: true, observability: { enabled: false }
      - d1_databases: [{ binding: "DB", database_name: "erc8004-indexer-local", database_id: "local" }]
      - kv_namespaces: [{ binding: "INDEXER_KV", id: "local" }]
      - services: [{ binding: "LOGS", service: "worker-logs", entrypoint: "LogsRPC" }]
      - cron_triggers: [] (placeholder comment)
      - env.staging: name "erc-8004-indexer-staging", routes: [{pattern: "erc8004.aibtc.dev", custom_domain: true}], d1_databases (database_id: STAGING_D1_ID_REPLACE_ME), kv_namespaces (id: STAGING_KV_ID_REPLACE_ME), services (worker-logs-staging)
      - env.production: name "erc-8004-indexer", routes: [{pattern: "erc8004.aibtc.com", custom_domain: true}], d1_databases (database_id: PRODUCTION_D1_ID_REPLACE_ME), kv_namespaces (id: PRODUCTION_KV_ID_REPLACE_ME), services (worker-logs-production)

      Create release-please-config.json:
      - packages: { ".": { release-type: "node", changelog-path: "CHANGELOG.md", extra-files: [{ type: "generic", path: "src/version.ts", glob: false }] } }

      Create .release-please-manifest.json: { ".": "0.1.0" }

      Create .github/workflows/release-please.yml:
      - on: push to main
      - permissions: contents: write, pull-requests: write
      - job: uses googleapis/release-please-action@v4

      Create vitest.config.ts matching agent-news pattern:
      - uses cloudflareTest() from @cloudflare/vitest-pool-workers
      - main: "./src/index.ts", wrangler: { configPath: "./wrangler.jsonc" }
      - miniflare: serviceBindings: { LOGS: async () => new Response("ok") }
      - test: { include: ["src/__tests__/**/*.test.ts"] }
    </action>
    <verify>
      cd /home/whoabuddy/dev/aibtcdev/erc-8004-indexer && npm install 2>&1 | tail -5
      Expect: no errors, node_modules created
    </verify>
    <done>All config files created, npm install succeeds without errors</done>
  </task>

  <task id="2">
    <name>Source files: types, version, logger middleware, index, rpc, CLAUDE.md</name>
    <files>
      src/types.ts,
      src/version.ts,
      src/middleware/logger.ts,
      src/index.ts,
      src/rpc.ts,
      CLAUDE.md
    </files>
    <action>
      Create src/version.ts:
      - export const VERSION = "0.1.0"; // x-release-please-version

      Create src/types.ts:
      - LogsRPC interface: info/warn/error/debug methods (appId: string, message: string, context?: Record&lt;string, unknown&gt;) returning Promise&lt;void&gt;
      - Logger interface: info/warn/error/debug methods (message: string, context?: Record&lt;string, unknown&gt;) returning void
      - Env interface: DB: D1Database, INDEXER_KV: KVNamespace, LOGS?: unknown, ENVIRONMENT?: string
      - AppVariables interface: requestId: string, logger: Logger

      Create src/middleware/logger.ts matching agent-news pattern exactly:
      - APP_ID constant: "erc-8004-indexer"
      - isLogsRPC type guard checking for object with info/warn/error/debug functions
      - createRpcLogger: takes logs: LogsRPC + ctx: Pick&lt;ExecutionContext, "waitUntil"&gt; + baseContext, returns Logger that uses ctx.waitUntil for fire-and-forget
      - createConsoleLogger: takes baseContext, returns Logger using console.log/warn/error/debug with [LEVEL] prefix
      - loggerMiddleware: creates requestId via crypto.randomUUID(), builds baseContext with request_id/path/method, selects RPC or console logger, sets requestId and logger on context, calls next()

      Create src/index.ts:
      - Import Hono, cors from hono, VERSION from ./version, types from ./types, loggerMiddleware
      - const app = new Hono&lt;{ Bindings: Env; Variables: AppVariables }&gt;()
      - app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"] }))
      - app.use("*", loggerMiddleware)
      - GET / handler: returns JSON with service, version, status: "ok", timestamp
      - app.notFound: returns 404 JSON with error and path
      - app.onError: logs error, returns 500 JSON with error message
      - export default { fetch: app.fetch }

      Create src/rpc.ts:
      - Import WorkerEntrypoint from "cloudflare:workers"
      - Import Env from ./types
      - IndexerRPC extends WorkerEntrypoint&lt;Env&gt; class
      - async getStatus(): Promise&lt;{ status: string; version: string }&gt; method returning { status: "ok", version: VERSION }

      Create CLAUDE.md with project conventions:
      - Project: ERC-8004 Indexer
      - Stack: Hono, Cloudflare Workers, D1, KV, worker-logs service binding
      - Key commands: npm run dev, npm run check, npm test, npm run deploy:dry-run
      - Conventions: conventional commits, logger middleware (c.var.logger), Env interface in src/types.ts
      - Domains: staging erc8004.aibtc.dev, production erc8004.aibtc.com
    </action>
    <verify>
      cd /home/whoabuddy/dev/aibtcdev/erc-8004-indexer && npm run check 2>&1
      Expect: tsc exits 0 with no type errors
    </verify>
    <done>All source files created, npm run check passes with zero type errors</done>
  </task>

  <task id="3">
    <name>Verify build and test pipeline</name>
    <files>No new files — verification only</files>
    <action>
      Run all acceptance criteria checks:
      1. npm run check (tsc --noEmit)
      2. npm run deploy:dry-run (wrangler deploy --dry-run)
      3. npm test (vitest run — no tests yet but runner must succeed)
      Confirm GET / logic in index.ts returns JSON with service info.
    </action>
    <verify>
      cd /home/whoabuddy/dev/aibtcdev/erc-8004-indexer
      npm run check 2>&1 | tail -5
      npm run deploy:dry-run 2>&1 | tail -10
      npm test 2>&1 | tail -10
    </verify>
    <done>All three commands exit 0. Phase acceptance criteria met.</done>
  </task>
</plan>
