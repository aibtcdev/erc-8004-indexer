/**
 * GET /api/v1/agents
 * GET /api/v1/agents/:id
 * GET /api/v1/agents/:id/metadata
 */
import { Hono } from "hono";
import type { Env, AppVariables } from "../types";
import { parsePagination, paginatedResponse } from "../utils/pagination";
import {
  queryAgents,
  queryAgentById,
  queryAgentMetadata,
} from "../utils/query";
import { parseAgentId } from "./helpers";

export const agentsRoute = new Hono<{
  Bindings: Env;
  Variables: AppVariables;
}>();

// GET /agents — list all agents with pagination
agentsRoute.get("/agents", async (c) => {
  const pagination = parsePagination(new URLSearchParams(c.req.query()));
  const { rows, total } = await queryAgents(c.env.DB, pagination);
  return c.json(paginatedResponse(rows, total, pagination.limit, pagination.offset));
});

// GET /agents/:id — get agent by numeric ID
agentsRoute.get("/agents/:id", async (c) => {
  const agentId = parseAgentId(c);
  if (agentId === null) return c.json({ error: "Invalid agent ID" }, 400);
  const agent = await queryAgentById(c.env.DB, agentId);
  if (!agent) return c.json({ error: "Not Found" }, 404);
  return c.json(agent);
});

// GET /agents/:id/metadata — list all metadata entries for an agent
agentsRoute.get("/agents/:id/metadata", async (c) => {
  const agentId = parseAgentId(c);
  if (agentId === null) return c.json({ error: "Invalid agent ID" }, 400);
  const metadata = await queryAgentMetadata(c.env.DB, agentId);
  return c.json(metadata);
});
