import { Hono } from "hono";
import { replySchema } from "@pebble/protocol";
import type { Db } from "../db/migrate.js";
import type { GatewayConfig } from "../config.js";
import { authenticateAgent } from "../services/auth.js";
import { logActivity } from "../services/activity-log.js";
import { publishNtfyReply } from "../services/ntfy.js";
import { publishPushoverReply } from "../services/pushover.js";

export function agentRepliesRoutes(db: Db, config: GatewayConfig): Hono {
  const app = new Hono();
  app.post("/replies", async (c) => {
    const agent = authenticateAgent(db, config, c);
    if (!agent) return c.json({ ok: false, error: "unauthorized" }, 401);
    const parsed = replySchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ ok: false, error: "invalid_payload" }, 400);
    logActivity(db, {
      user_id: agent.user_id,
      agent_id: agent.id,
      event_id: parsed.data.event_id,
      delivery_id: parsed.data.delivery_id,
      event_type: "agent.reply",
      status: parsed.data.status
    });
    await publishNtfyReply(db, config, agent.user_id, parsed.data.text);
    await publishPushoverReply(db, config, agent.user_id, parsed.data.text, parsed.data.status);
    return c.json({ ok: true });
  });
  return app;
}
