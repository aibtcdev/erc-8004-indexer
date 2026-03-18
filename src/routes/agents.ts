import { Hono } from "hono";
import type { Env } from "../lib/types";
import { getAllAgents, getAgentById, getAgentsByOwner, getAgentCount } from "../services/db";

const agentsRouter = new Hono<{ Bindings: Env }>();

/** GET /agents — List all indexed agents */
agentsRouter.get("/agents", async (c) => {
  const owner = c.req.query("owner");

  if (owner) {
    const agents = await getAgentsByOwner(c.env.DB, owner);
    return c.json({ agents, count: agents.length });
  }

  const agents = await getAllAgents(c.env.DB);
  return c.json({ agents, count: agents.length });
});

/** GET /agents/count — Agent count */
agentsRouter.get("/agents/count", async (c) => {
  const count = await getAgentCount(c.env.DB);
  return c.json({ count });
});

/** GET /agents/:id — Single agent by ID */
agentsRouter.get("/agents/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id) || id < 1) {
    return c.json({ error: "Invalid agent ID" }, 400);
  }

  const agent = await getAgentById(c.env.DB, id);
  if (!agent) {
    return c.json({ error: "Agent not found" }, 404);
  }

  return c.json(agent);
});

export { agentsRouter };
