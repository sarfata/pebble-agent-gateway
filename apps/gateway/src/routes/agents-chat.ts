import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "../db/migrate.js";
import type { GatewayConfig } from "../config.js";
import { authenticateAgent } from "../services/auth.js";
import { initializeAgentsChatBridge, pairAgentsChat } from "../services/agents-chat-bridge.js";

export function agentsChatRoutes(db: Db, config: GatewayConfig) {
  initializeAgentsChatBridge(db);
  const app = new Hono();
  const input = z.object({ webhookUrl: z.string().url().max(2048), ingestToken: z.string().max(100) });
  app.post("/agents-chat/pair", async (c) => {
    const agent = authenticateAgent(db, config, c);
    if (!agent) return c.json({ error: "unauthorized" }, 401);
    const parsed = input.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    try { return c.json(pairAgentsChat(db, config, agent, parsed.data)); }
    catch { return c.json({ error: "invalid_pairing", message: "Use a gateway-managed connector and the exact URL/token from Agents Chat rings_pair" }, 400); }
  });
  app.post("/agents-chat/unpair", (c) => {
    const agent = authenticateAgent(db, config, c);
    if (!agent) return c.json({ error: "unauthorized" }, 401);
    db.prepare(`delete from agents_chat_targets where agent_id = ? and user_id = ?`).run(agent.id, agent.user_id);
    return c.json({ paired: false });
  });
  return app;
}
