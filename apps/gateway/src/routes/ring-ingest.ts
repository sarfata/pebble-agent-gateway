import { Hono } from "hono";
import { ringIngestSchema } from "@pebble/protocol";
import { nanoid } from "nanoid";
import type { Db } from "../db/migrate.js";
import type { GatewayConfig } from "../config.js";
import { authenticateRing, authenticateRingToken, type TokenCredential, tokenCredential } from "../services/auth.js";
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
    let body: unknown;
    let credential: TokenCredential | null = tokenCredential(c);
    const contentType = c.req.header("Content-Type") ?? "";
    if (contentType.toLowerCase().includes("multipart/form-data")) {
      const form = await c.req.formData();
      const token = getFormString(form, ["token", "webhook_token", "ingest_token", "ring_token", "authorization"]) ?? getTokenFromJsonFormFields(form);
      if (!credential && token) credential = { token: stripBearer(token), source: "form_token" };
      body = formToIngestBody(form);
      logInfo("ring.ingest.multipart_parsed", {
        request_id: requestId,
        form_fields: summarizeFormFields(form),
        has_audio_file: hasFormFile(form)
      });
    }
    if (!credential) {
      logWarn("ring.ingest.auth_failed", { request_id: requestId, reason: "missing_token" });
      return c.json({ ok: false, error: "unauthorized", request_id: requestId }, 401);
    }
    const ring = credential.source === "form_token" ? authenticateRingToken(db, config, credential.token) : authenticateRing(db, config, c);
    if (!ring) {
      logWarn("ring.ingest.auth_failed", {
        request_id: requestId,
        reason: "unknown_or_revoked_token",
        token_source: credential.source,
        token_hash_prefix: hashToken(credential.token, config.tokenPepper).slice(0, 12)
      });
      return c.json({ ok: false, error: "unauthorized", request_id: requestId }, 401);
    }
    try {
      body ??= await c.req.json();
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
    const result = await enqueueRingMessage(db, config, hub, ring, parsed.data);
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

function stripBearer(value: string): string {
  return value.startsWith("Bearer ") ? value.slice("Bearer ".length) : value;
}

function getFormString(form: FormData, names: string[]): string | null {
  for (const name of names) {
    const value = form.get(name);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function formToIngestBody(form: FormData): unknown {
  const metadata = parseMetadata(getFormString(form, ["metadata", "metadata_json"]));
  const audio = getFirstFile(form, ["audio", "audio_file", "file", "recording"]);
  if (audio) {
    metadata.audio_file = {
      name: audio.name || null,
      type: audio.type || null,
      size: audio.size
    };
  }
  const recordedAt = normalizeRecordedAt(getFormString(form, ["recorded_at", "recordedAt", "created_at", "timestamp"]));
  return {
    message_id: getFormString(form, ["message_id", "messageId", "source_message_id", "id"]) ?? `mobile-${Date.now()}`,
    recorded_at: recordedAt,
    transcript: getFormString(form, ["transcript", "transcription", "text", "message", "body"]) ?? "",
    audio_url: getFormString(form, ["audio_url", "audioUrl"]) ?? null,
    metadata
  };
}

function normalizeRecordedAt(value: string | null): string {
  if (!value) return new Date().toISOString();
  if (/^\d+$/.test(value)) {
    const timestamp = Number(value);
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }
  return value;
}

function getTokenFromJsonFormFields(form: FormData): string | null {
  for (const value of form.values()) {
    if (typeof value !== "string") continue;
    const token = tokenFromJson(value);
    if (token) return token;
  }
  return null;
}

function tokenFromJson(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return findTokenInJson(JSON.parse(trimmed) as unknown);
  } catch {
    return null;
  }
}

function findTokenInJson(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const token = findTokenInJson(item);
      if (token) return token;
    }
    return null;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested === "string" && ["token", "webhook_token", "ingest_token", "ring_token", "authorization"].includes(key)) {
      return nested.trim();
    }
    const token = findTokenInJson(nested);
    if (token) return token;
  }
  return null;
}

function parseMetadata(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return { metadata_parse_error: true };
  }
}

function getFirstFile(form: FormData, names: string[]): File | null {
  for (const name of names) {
    const value = form.get(name);
    if (value instanceof File) return value;
  }
  return null;
}

function hasFormFile(form: FormData): boolean {
  for (const value of form.values()) {
    if (value instanceof File) return true;
  }
  return false;
}

function summarizeFormFields(form: FormData): string {
  return Array.from(form.entries())
    .map(([key, value]) => value instanceof File ? `${key}:file:${value.type || "unknown"}:${value.size}` : `${key}:text`)
    .sort()
    .join(",");
}
