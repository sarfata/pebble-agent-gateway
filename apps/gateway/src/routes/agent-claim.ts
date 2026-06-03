import { Hono } from "hono";
import { ackSchema } from "@pebble/protocol";
import type { Db } from "../db/migrate.js";
import type { GatewayConfig } from "../config.js";
import { authenticateAgent } from "../services/auth.js";
import { ackDelivery, claimDelivery } from "../services/queue/claim.js";

export function agentDeliveryRoutes(db: Db, config: GatewayConfig, isDraining: () => boolean): Hono {
  const app = new Hono();

  app.post("/deliveries/:id/claim", (c) => {
    if (isDraining()) return c.json({ ok: false, error: "draining" }, 503);
    const agent = authenticateAgent(db, config, c);
    if (!agent) return c.json({ ok: false, error: "unauthorized" }, 401);
    const result = claimDelivery(db, config, agent, Number(c.req.param("id")));
    if (result.status !== 200) return c.json({ ok: false, error: "claim_unavailable" }, result.status);
    return c.json({ ok: true, delivery_id: Number(c.req.param("id")), event_id: result.event_id, encrypted_payload: result.encrypted_payload });
  });

  app.post("/deliveries/:id/ack", async (c) => {
    const agent = authenticateAgent(db, config, c);
    if (!agent) return c.json({ ok: false, error: "unauthorized" }, 401);
    const parsed = ackSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ ok: false, error: "invalid_payload" }, 400);
    const result = ackDelivery(db, agent, Number(c.req.param("id")), parsed.data.status);
    if (result.status !== 200) return c.json({ ok: false, error: "not_found" }, result.status);
    return c.json({ ok: true });
  });

  return app;
}
