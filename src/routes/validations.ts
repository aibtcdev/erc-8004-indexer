/**
 * Validation routes under /api/v1.
 *
 * GET /api/v1/agents/:id/validations/summary
 * GET /api/v1/agents/:id/validations
 * GET /api/v1/validators/:addr/requests
 * GET /api/v1/validations/:hash
 */
import { Hono } from "hono";
import type { Env, AppVariables } from "../types";
import { parsePagination, paginatedResponse } from "../utils/pagination";
import {
  queryValidationSummary,
  queryValidations,
  queryValidationsByValidator,
  queryValidationByHash,
} from "../utils/query";

export const validationsRoute = new Hono<{
  Bindings: Env;
  Variables: AppVariables;
}>();

// GET /agents/:id/validations/summary — counts of total/pending/responded
validationsRoute.get("/agents/:id/validations/summary", async (c) => {
  const agentId = parseInt(c.req.param("id"), 10);
  if (isNaN(agentId)) {
    return c.json({ error: "Invalid agent ID" }, 400);
  }
  const summary = await queryValidationSummary(c.env.DB, agentId);
  return c.json({ agent_id: agentId, ...summary });
});

// GET /agents/:id/validations — list validation requests for an agent
validationsRoute.get("/agents/:id/validations", async (c) => {
  const agentId = parseInt(c.req.param("id"), 10);
  if (isNaN(agentId)) {
    return c.json({ error: "Invalid agent ID" }, 400);
  }
  const pagination = parsePagination(new URLSearchParams(c.req.query()));
  const rawHasResponse = c.req.query("has_response");
  const has_response =
    rawHasResponse === "true"
      ? true
      : rawHasResponse === "false"
        ? false
        : undefined;

  const { rows, total } = await queryValidations(c.env.DB, agentId, {
    ...pagination,
    has_response,
  });
  return c.json(paginatedResponse(rows, total, pagination.limit, pagination.offset));
});

// GET /validators/:addr/requests — validation requests assigned to a validator
validationsRoute.get("/validators/:addr/requests", async (c) => {
  const validator = c.req.param("addr");
  if (!validator) {
    return c.json({ error: "Invalid validator address" }, 400);
  }
  const pagination = parsePagination(new URLSearchParams(c.req.query()));
  const { rows, total } = await queryValidationsByValidator(
    c.env.DB,
    validator,
    pagination
  );
  return c.json(paginatedResponse(rows, total, pagination.limit, pagination.offset));
});

// GET /validations/:hash — get single validation by request_hash
validationsRoute.get("/validations/:hash", async (c) => {
  const hash = c.req.param("hash");
  if (!hash) {
    return c.json({ error: "Missing hash" }, 400);
  }
  const validation = await queryValidationByHash(c.env.DB, hash);
  if (!validation) {
    return c.json({ error: "Not Found" }, 404);
  }
  return c.json(validation);
});
