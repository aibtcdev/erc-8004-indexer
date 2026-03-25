/**
 * Feedback and summary routes under /api/v1.
 *
 * GET /api/v1/agents/:id/summary
 * GET /api/v1/agents/:id/feedback
 * GET /api/v1/agents/:id/feedback/:seq
 * GET /api/v1/agents/:id/clients
 * GET /api/v1/agents/:id/feedback/:client/:index/responses
 * GET /api/v1/feedback/recent
 */
import { Hono } from "hono";
import type { Env, AppVariables } from "../types";
import { parsePagination, paginatedResponse } from "../utils/pagination";
import {
  queryFeedbackSummary,
  queryFeedback,
  queryFeedbackBySeq,
  queryClients,
  queryFeedbackResponses,
  queryRecentFeedback,
} from "../utils/query";
import { parseAgentId, parseFeedbackFilters } from "./helpers";

export const feedbackRoute = new Hono<{
  Bindings: Env;
  Variables: AppVariables;
}>();

// GET /agents/:id/summary — feedback aggregation with optional filters
feedbackRoute.get("/agents/:id/summary", async (c) => {
  const agentId = parseAgentId(c);
  if (agentId === null) return c.json({ error: "Invalid agent ID" }, 400);
  const filters = parseFeedbackFilters(c);
  const summary = await queryFeedbackSummary(c.env.DB, agentId, filters);
  return c.json({ agent_id: agentId, ...summary });
});

// GET /agents/:id/feedback — list feedback with pagination and optional filters
feedbackRoute.get("/agents/:id/feedback", async (c) => {
  const agentId = parseAgentId(c);
  if (agentId === null) return c.json({ error: "Invalid agent ID" }, 400);
  const pagination = parsePagination(c.req.query());
  const filters = parseFeedbackFilters(c);
  const { rows, total } = await queryFeedback(c.env.DB, agentId, {
    ...pagination,
    ...filters,
  });
  return c.json(paginatedResponse(rows, total, pagination.limit, pagination.offset));
});

// GET /agents/:id/feedback/:seq — list feedback entries at a given feedback_index
feedbackRoute.get("/agents/:id/feedback/:seq", async (c) => {
  const agentId = parseAgentId(c);
  const seq = parseInt(c.req.param("seq"), 10);
  if (agentId === null || isNaN(seq)) {
    return c.json({ error: "Invalid agent ID or sequence" }, 400);
  }
  const rows = await queryFeedbackBySeq(c.env.DB, agentId, seq);
  return c.json(rows);
});

// GET /agents/:id/clients — list approved clients for an agent
feedbackRoute.get("/agents/:id/clients", async (c) => {
  const agentId = parseAgentId(c);
  if (agentId === null) return c.json({ error: "Invalid agent ID" }, 400);
  const clients = await queryClients(c.env.DB, agentId);
  return c.json(clients);
});

// GET /agents/:id/feedback/:client/:index/responses — list responses for a specific feedback
feedbackRoute.get("/agents/:id/feedback/:client/:index/responses", async (c) => {
  const agentId = parseAgentId(c);
  const feedbackIndex = parseInt(c.req.param("index"), 10);
  const client = c.req.param("client");
  if (agentId === null || isNaN(feedbackIndex) || !client) {
    return c.json({ error: "Invalid parameters" }, 400);
  }
  const responses = await queryFeedbackResponses(
    c.env.DB,
    agentId,
    client,
    feedbackIndex
  );
  return c.json(responses);
});

// GET /feedback/recent — recent feedback across all agents with pagination
feedbackRoute.get("/feedback/recent", async (c) => {
  const pagination = parsePagination(c.req.query());
  const { rows, total } = await queryRecentFeedback(c.env.DB, pagination);
  return c.json(paginatedResponse(rows, total, pagination.limit, pagination.offset));
});
