import { Hono } from "hono";
import type { Db } from "../db/migrate.js";
import type { GatewayConfig } from "../config.js";
import { authenticateAgent } from "../services/auth.js";
import type { DeliveryStreamHub } from "../services/queue/stream.js";

export function agentEventsRoutes(db: Db, config: GatewayConfig, hub: DeliveryStreamHub): Hono {
  const app = new Hono();
  app.get("/events", (c) => {
    if (hub.isDraining()) return c.json({ ok: false, error: "draining" }, 503);
    const agent = authenticateAgent(db, config, c);
    if (!agent) return c.json({ ok: false, error: "unauthorized" }, 401);
    db.prepare(`update agent_connectors set last_seen_at = ? where id = ?`).run(new Date().toISOString(), agent.id);

    const stream = new ReadableStream({
      start(controller) {
        const send = (chunk: string) => controller.enqueue(new TextEncoder().encode(chunk));
        const sendDelivery = (row: { delivery_id: number; event_id: string; expires_at: string }) => {
          send(`id: ${row.delivery_id}\nevent: delivery.available\ndata: ${JSON.stringify(row)}\n\n`);
        };
        const pending = db.prepare(`select id as delivery_id, event_id, expires_at from agent_deliveries where agent_id = ? and status = 'pending' and expires_at > ? order by id asc`)
          .all(agent.id, new Date().toISOString()) as Array<{ delivery_id: number; event_id: string; expires_at: string }>;
        for (const row of pending) sendDelivery(row);
        const offAvailable = hub.onAvailable(agent.id, sendDelivery);
        const keepalive = setInterval(() => send(": keepalive\n\n"), 25_000);
        const offDraining = hub.onDraining(() => {
          send(`event: gateway.draining\ndata: {"reason":"shutdown"}\n\n`);
          clearInterval(keepalive);
          offAvailable();
          offDraining();
          controller.close();
        });
        return () => {
          clearInterval(keepalive);
          offAvailable();
          offDraining();
        };
      }
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      }
    });
  });
  return app;
}
