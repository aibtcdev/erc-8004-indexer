# Quest: production-resilience

## Goal

Add production resilience features to the ERC-8004 indexer inspired by the stacks-tracker dual-source pattern: block audit history via `blocks_seen` D1 table, KV-based source health tracking, polling fallback with adaptive backfill thresholds, and an enhanced `/api/v1/status` endpoint exposing source health, recent blocks, and gap information.

## Repos

- `/home/whoabuddy/dev/aibtcdev/erc-8004-indexer`

## Status

`completed`

## Completed

2026-03-26

## Context

- Builds on top of the existing indexer (quest: 2026-03-25-erc8004-indexer-build)
- Existing migrations: 0001_initial.sql, 0002_lenses_seed.sql
- Cron handler runs every 5 minutes (src/scheduled.ts)
- Tests use @cloudflare/vitest-pool-workers with inlined DDL in helpers.ts
- Current status endpoint returns basic sync_state only
