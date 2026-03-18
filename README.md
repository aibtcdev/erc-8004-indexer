# ERC-8004 Indexer

Standalone indexer for the [ERC-8004](https://github.com/aibtcdev/erc-8004) Agent Identity Registry on Stacks. Runs as a Cloudflare Worker with D1 storage, indexing all registered agent identities on a 6-hour cron schedule.

## Architecture

- **Runtime:** Cloudflare Workers (Hono)
- **Database:** Cloudflare D1 (SQLite)
- **Indexing:** Cron trigger every 6 hours
- **Contract:** `identity-registry-v2` on Stacks mainnet
- **Logging:** worker-logs RPC (optional)

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Service info |
| GET | `/health` | Health check with index status |
| GET | `/agents` | List all agents (`?owner=SP...` filter) |
| GET | `/agents/count` | Agent count |
| GET | `/agents/:id` | Single agent by ID |
| GET | `/stats` | Index statistics |

## Development

```bash
# Install dependencies
bun install

# Initialize local D1
bun run db:init:local

# Run locally
bun run dev

# Type check
bunx tsc --noEmit
```

## Deployment

```bash
# Create D1 database
wrangler d1 create erc8004-indexer-db

# Update wrangler.jsonc with the database ID

# Initialize remote D1
bun run db:init:remote

# Deploy
bun run deploy
```

## Configuration

Environment variables in `wrangler.jsonc`:

| Variable | Default | Description |
|----------|---------|-------------|
| `STACKS_NETWORK` | `mainnet` | Stacks network |
| `STACKS_API_URL` | `https://api.hiro.so` | Stacks API base URL |
| `ENVIRONMENT` | `development` | Environment label |

Secrets (via `wrangler secret put`):

| Secret | Description |
|--------|-------------|
| `ADMIN_API_KEY` | Optional admin API key |
