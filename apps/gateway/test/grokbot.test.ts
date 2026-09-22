import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/migrate.js";
import { encryptAppPayload } from "../src/services/crypto/app-payload.js";
import {
  decryptGrokbotConfig,
  encryptGrokbotConfig,
  forwardTranscriptToGrokbot,
  isHttpsUrl,
  processGrokbotDelivery
} from "../src/services/grokbot.js";
import type { WebhookHttpClient, WebhookPostResult } from "../src/services/mcp-events.js";

class FakeWebhookClient implements WebhookHttpClient {
  readonly calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  constructor(private readonly response: WebhookPostResult | (() => WebhookPostResult) = { status: 200, body: "ok" }) {}
  async post(url: string, body: string, headers: Record<string, string>): Promise<WebhookPostResult> {
    this.calls.push({ url, body, headers });
    return typeof this.response === "function" ? this.response() : this.response;
  }
}

function config() {
  return loadConfig({
    DATABASE_URL: "file::memory:",
    TOKEN_PEPPER: "grokbot-test-pepper",
    APP_ENCRYPTION_KEY: "grokbot-app-key"
  });
}

describe("isHttpsUrl", () => {
  it("accepts https URLs and rejects everything else", () => {
    expect(isHttpsUrl("https://example.com/hook")).toBe(true);
    expect(isHttpsUrl("http://example.com/hook")).toBe(false);
    expect(isHttpsUrl("not a url")).toBe(false);
  });
});

describe("GrokBot webhook config encryption", () => {
  it("round-trips the webhook URL, token, and payload key", () => {
    const cfg = config();
    const encrypted = encryptGrokbotConfig(cfg, { url: "https://example.com/hook", token: "secret", payloadKey: "message" });
    expect(decryptGrokbotConfig(cfg, encrypted)).toEqual({ url: "https://example.com/hook", token: "secret", payloadKey: "message" });
  });
});

describe("forwardTranscriptToGrokbot", () => {
  it("POSTs the transcript under the configured payload key with a bearer token", async () => {
    const client = new FakeWebhookClient({ status: 200, body: "Grok says hi" });
    const reply = await forwardTranscriptToGrokbot({ url: "https://example.com/hook", token: "secret", payloadKey: "message" }, "hello", client);
    expect(reply).toBe("Grok says hi");
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({
      url: "https://example.com/hook",
      body: JSON.stringify({ message: "hello" }),
      headers: { "Content-Type": "application/json", Authorization: "Bearer secret" }
    });
  });

  it("falls back to a confirmation message when the response body is empty", async () => {
    const client = new FakeWebhookClient({ status: 202, body: "" });
    const reply = await forwardTranscriptToGrokbot({ url: "https://example.com/hook" }, "hello", client);
    expect(reply).toBe("Sent to GrokBot (HTTP 202).");
  });

  it("throws with the response body on a non-2xx status", async () => {
    const client = new FakeWebhookClient({ status: 400, body: "bad request" });
    await expect(forwardTranscriptToGrokbot({ url: "https://example.com/hook" }, "hello", client))
      .rejects.toThrow("GrokBot webhook returned HTTP 400: bad request");
  });
});

function seedGrokbotDelivery(db: Db, cfg: ReturnType<typeof config>, webhookEncryptedConfig: string | null) {
  const now = new Date().toISOString();
  db.prepare(`insert into users (id, email, password_hash, role, created_at) values ('usr_grok', 'grok@example.com', 'hash', 'admin', ?)`).run(now);
  db.prepare(`insert into rings (id, user_id, name, ingest_token_hash, created_at, revoked_at) values ('ring_grok', 'usr_grok', 'Ring', 'hash', ?, null)`).run(now);
  db.prepare(`insert into agent_connectors (id, user_id, kind, name, token_hash, encryption_public_key, encrypted_config_json, last_seen_at, created_at, revoked_at) values ('agt_grok', 'usr_grok', 'grokbot', 'GrokBot', 'hash', '', ?, null, ?, null)`)
    .run(webhookEncryptedConfig, now);
  db.prepare(`insert into ring_events (id, user_id, ring_id, source_message_id, message_hash, target_hint, payload_bytes, audio_bytes, received_at, expires_at, status, created_at) values ('evt_grok', 'usr_grok', 'ring_grok', 'src', 'hash', 'grokbot', 10, null, ?, ?, 'queued', ?)`)
    .run(now, new Date(Date.now() + 60_000).toISOString(), now);
  const encryptedPayload = encryptAppPayload(cfg, { message_id: "evt_grok", ring_id: "ring_grok", source_message_id: "src", recorded_at: now, transcript: "GrokBot, what is the weather", audio: null, metadata: {} });
  const result = db.prepare(`insert into agent_deliveries (event_id, user_id, agent_id, status, encrypted_payload_json, available_at, expires_at, created_at) values ('evt_grok', 'usr_grok', 'agt_grok', 'pending', ?, ?, ?, ?)`)
    .run(JSON.stringify(encryptedPayload), now, new Date(Date.now() + 60_000).toISOString(), now);
  return Number(result.lastInsertRowid);
}

describe("processGrokbotDelivery", () => {
  it("acks the delivery and returns the webhook reply on success", async () => {
    const cfg = config();
    const db = openDb(":memory:");
    const webhookConfig = encryptGrokbotConfig(cfg, { url: "https://example.com/hook" });
    const deliveryId = seedGrokbotDelivery(db, cfg, webhookConfig);
    const client = new FakeWebhookClient({ status: 200, body: "handled" });

    await processGrokbotDelivery(db, cfg, { id: "agt_grok", user_id: "usr_grok", encrypted_config_json: webhookConfig }, { delivery_id: deliveryId, event_id: "evt_grok" }, client);

    const row = db.prepare(`select status, encrypted_payload_json from agent_deliveries where id = ?`).get(deliveryId) as { status: string; encrypted_payload_json: string | null };
    expect(row.status).toBe("acked");
    expect(row.encrypted_payload_json).toBeNull();
    expect(client.calls[0].body).toBe(JSON.stringify({ text: "GrokBot, what is the weather" }));
    const ringEvent = db.prepare(`select status from ring_events where id = 'evt_grok'`).get() as { status: string };
    expect(ringEvent.status).toBe("claimed");
  });

  it("fails the delivery when the webhook returns a non-2xx status", async () => {
    const cfg = config();
    const db = openDb(":memory:");
    const webhookConfig = encryptGrokbotConfig(cfg, { url: "https://example.com/hook" });
    const deliveryId = seedGrokbotDelivery(db, cfg, webhookConfig);
    const client = new FakeWebhookClient({ status: 500, body: "boom" });

    await processGrokbotDelivery(db, cfg, { id: "agt_grok", user_id: "usr_grok", encrypted_config_json: webhookConfig }, { delivery_id: deliveryId, event_id: "evt_grok" }, client);

    const row = db.prepare(`select status, failure_reason from agent_deliveries where id = ?`).get(deliveryId) as { status: string; failure_reason: string | null };
    expect(row.status).toBe("failed");
    expect(row.failure_reason).toContain("HTTP 500");
  });

  it("fails the delivery when the connector has no webhook configured", async () => {
    const cfg = config();
    const db = openDb(":memory:");
    const deliveryId = seedGrokbotDelivery(db, cfg, null);
    const client = new FakeWebhookClient();

    await processGrokbotDelivery(db, cfg, { id: "agt_grok", user_id: "usr_grok", encrypted_config_json: null }, { delivery_id: deliveryId, event_id: "evt_grok" }, client);

    const row = db.prepare(`select status, failure_reason from agent_deliveries where id = ?`).get(deliveryId) as { status: string; failure_reason: string | null };
    expect(row.status).toBe("failed");
    expect(row.failure_reason).toContain("missing its webhook configuration");
    expect(client.calls).toHaveLength(0);
  });
});
