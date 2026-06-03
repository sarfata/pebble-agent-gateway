import { Hono } from "hono";
import { ringIngestSchema } from "@pebble/protocol";
import type { Db } from "../db/migrate.js";
import type { GatewayConfig } from "../config.js";
import { authenticateRing } from "../services/auth.js";
import { enqueueRingMessage } from "../services/queue/enqueue.js";
import type { DeliveryStreamHub } from "../services/queue/stream.js";

export function ringIngestRoutes(db: Db, config: GatewayConfig, hub: DeliveryStreamHub, isDraining: () => boolean): Hono {
  const app = new Hono();
  app.post("/ingest", async (c) => {
    if (isDraining()) return c.json({ ok: false, error: "draining" }, 503);
    const ring = authenticateRing(db, config, c);
    if (!ring) return c.json({ ok: false, error: "unauthorized" }, 401);
    const parsed = ringIngestSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ ok: false, error: "invalid_payload", details: parsed.error.flatten() }, 400);
    return c.json(enqueueRingMessage(db, config, hub, ring, parsed.data), 202);
  });
  return app;
}
