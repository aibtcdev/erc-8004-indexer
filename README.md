# erc-8004-indexer

Indexes the ERC-8004 agent registries on Stacks mainnet and serves them over a read-only HTTP API. The registries are `identity-registry-v2`, `reputation-registry-v2` and `validation-registry-v2` at `SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD`.

| Environment | URL |
|---|---|
| Production | https://erc8004.aibtc.com |
| Staging | https://erc8004.aibtc.dev |

Events arrive through a Hiro Chainhooks 2.0 subscription (`POST /webhook`, bearer `CHAINHOOK_SECRET`) and are stored in D1. A cron job checks chainhook health and detects gaps. History before the subscription is loaded with `scripts/backfill.ts`.

## Is it synced?

Check `GET /api/v1/status` before trusting an empty result. `sync_state` lists the last indexed block per contract, and `gap` compares it with the chain tip. If `sync_state` is empty, the indexer has never received events, and every lookup returns empty even for agents that exist on chain. Compare `GET /api/v1/stats` with `get-last-token-id` on `identity-registry-v2`.

## API (all under `/api/v1`, read-only, JSON)

List endpoints take `?limit=` (default 50, max 200) and `?offset=`.

| Endpoint | Returns |
|---|---|
| `GET /status` | Sync state per contract, source health, recent blocks, gap |
| `GET /stats` | Counts of agents, feedback and validations |
| `GET /agents` | Registered agents (paginated) |
| `GET /agents/:id` | One agent |
| `GET /agents/:id/metadata` | Its metadata entries |
| `GET /agents/:id/summary` | Reputation summary |
| `GET /agents/:id/feedback` | Feedback received (paginated) |
| `GET /agents/:id/feedback/:seq` | One feedback entry |
| `GET /agents/:id/clients` | Clients that gave feedback |
| `GET /agents/:id/feedback/:client/:index/responses` | Responses to one feedback entry |
| `GET /feedback/recent` | Latest feedback across agents (paginated) |
| `GET /agents/:id/validations` | Validation requests for an agent |
| `GET /agents/:id/validations/summary` | Validation summary |
| `GET /validators/:addr/requests` | Requests addressed to a validator |
| `GET /validations/:hash` | One validation request |
| `GET /lenses`, `GET /lenses/:lens` | Configured reputation lenses |
| `GET /lenses/:lens/agents/:id/{summary,feedback,score}` | An agent seen through one lens |

`POST /lenses` and `PUT /lenses/:lens` are admin-only (`Authorization: Bearer` checked against `ADMIN_TOKEN`, or the KV key `admin_token`).

## Develop

```bash
npm ci
npm test                 # vitest (workers pool)
npm run check            # tsc --noEmit
npm run dev              # local worker (needs a .env, see below)
npm run deploy:dry-run   # build without deploying
```

The `wrangler` script sources `./.env`, so create one first (it can be empty for dev and dry-runs; `npm test` does not need it). Secrets: `CHAINHOOK_SECRET` (worker) and `HIRO_API_KEY` (registration and backfill scripts only).

Bringing up a new environment after deploying: `scripts/register-chainhooks.ts`, then `scripts/backfill.ts`, then confirm with `scripts/check-chainhook.ts` and `GET /api/v1/status`.

Conventions, bindings per environment and the logging setup are in [CLAUDE.md](CLAUDE.md).
