import { Hono } from "hono";
import { ringIngestSchema } from "@pebble/protocol";
import { nanoid } from "nanoid";
import type { Db } from "../db/migrate.js";
import type { GatewayConfig } from "../config.js";
import { authenticateRing, tokenCredential } from "../services/auth.js";
import { enqueueRingMessage } from "../services/queue/enqueue.js";
import type { DeliveryStreamHub } from "../services/queue/stream.js";
import { hashToken } from "../services/crypto/token-hash.js";
import { logActivity } from "../services/activity-log.js";
import { logInfo, logWarn } from "../services/logger.js";

export function ringIngestRoutes(db: Db, config: GatewayConfig, hub: DeliveryStreamHub, isDraining: () => boolean): Hono {
  const app = new Hono();
  app.post("/ingest", async (c) => {
    const requestId = c.req.header("X-Request-Id") ?? `req_${nanoid(12)}`;
    c.header("X-Request-Id", requestId);
    logInfo("ring.ingest.received", {
      request_id: requestId,
      content_type: c.req.header("Content-Type") ?? null,
      user_agent: c.req.header("User-Agent") ?? null
    });
    if (isDraining()) {
      logWarn("ring.ingest.rejected", { request_id: requestId, reason: "draining" });
      return c.json({ ok: false, error: "draining", request_id: requestId }, 503);
    }
    const credential = tokenCredential(c);
    if (!credential) {
      logWarn("ring.ingest.auth_failed", { request_id: requestId, reason: "missing_token" });
      return c.json({ ok: false, error: "unauthorized", request_id: requestId }, 401);
    }
    const ring = authenticateRing(db, config, c);
    if (!ring) {
      logWarn("ring.ingest.auth_failed", {
        request_id: requestId,
        reason: "unknown_or_revoked_token",
        token_source: credential.source,
        token_hash_prefix: hashToken(credential.token, config.tokenPepper).slice(0, 12)
      });
      return c.json({ ok: false, error: "unauthorized", request_id: requestId }, 401);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      logWarn("ring.ingest.invalid_json", { request_id: requestId, ring_id: ring.id });
      logActivity(db, {
        user_id: ring.user_id,
        ring_id: ring.id,
        event_type: "ring.ingest",
        status: "rejected",
        error_code: "invalid_json"
      });
      return c.json({ ok: false, error: "invalid_json", request_id: requestId }, 400);
    }
    const parsed = ringIngestSchema.safeParse(body);
    if (!parsed.success) {
      const fields = Object.keys(parsed.error.flatten().fieldErrors).join(",");
      logWarn("ring.ingest.invalid_payload", { request_id: requestId, ring_id: ring.id, fields });
      logActivity(db, {
        user_id: ring.user_id,
        ring_id: ring.id,
        event_type: "ring.ingest",
        status: "rejected",
        error_code: "invalid_payload",
        metadata: { fields }
      });
      return c.json({ ok: false, error: "invalid_payload", details: parsed.error.flatten(), request_id: requestId }, 400);
    }
    const result = enqueueRingMessage(db, config, hub, ring, parsed.data);
    logInfo("ring.ingest.accepted", {
      request_id: requestId,
      ring_id: ring.id,
      event_id: result.event_id,
      deliveries: result.deliveries.length,
      accepted: result.ok,
      idempotent: result.idempotent === true
    });
    return c.json({ ...result, request_id: requestId }, 202);
  });
  return app;
}
