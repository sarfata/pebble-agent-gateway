import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { openDb } from "../src/db/migrate.js";
import { loadConfig } from "../src/config.js";
import { generateAgentKeypair } from "../src/services/crypto/agent-keys.js";
import { generateToken, hashToken } from "../src/services/crypto/token-hash.js";
import { enqueueRingMessage } from "../src/services/queue/enqueue.js";
import { claimDelivery, ackDelivery } from "../src/services/queue/claim.js";
import { expirePendingDeliveries } from "../src/services/queue/expire.js";
import { decryptEnvelope } from "../src/services/crypto/envelope.js";
import { DeliveryStreamHub } from "../src/services/queue/stream.js";
import { agentEventsRoutes } from "../src/routes/agent-events.js";
import { ringIngestRoutes } from "../src/routes/ring-ingest.js";

function seed() {
  const db = openDb(":memory:");
  const config = loadConfig({
    DATABASE_URL: "file::memory:",
    TOKEN_PEPPER: "test-pepper",
    APP_ENCRYPTION_KEY: "app-key",
    MESSAGE_TTL_MINUTES: "60",
    DELETE_PAYLOAD_ON_CLAIM: "true"
  });
  const now = new Date().toISOString();
  const userId = "usr_test";
  db.prepare(`insert into users (id, email, password_hash, role, created_at) values (?, ?, ?, 'admin', ?)`).run(userId, "a@example.com", "hash", now);
  const ringToken = generateToken("ri_live");
  const agentToken = generateToken("ag_live");
  const keypair = generateAgentKeypair();
  db.prepare(`insert into rings (id, user_id, name, ingest_token_hash, created_at, revoked_at) values ('ring_test', ?, 'Ring', ?, ?, null)`)
    .run(userId, hashToken(ringToken, config.tokenPepper), now);
  db.prepare(`insert into agent_connectors (id, user_id, kind, name, token_hash, encryption_public_key, last_seen_at, created_at, revoked_at) values ('agt_test', ?, 'codex', 'Codex', ?, ?, null, ?, null)`)
    .run(userId, hashToken(agentToken, config.tokenPepper), keypair.publicKey, now);
  return { db, config, ringToken, agentToken, keypair, userId };
}

describe("gateway integration", () => {
  it("keeps transcripts out of SQLite, survives queue read, claims, decrypts, deletes, and acks", () => {
    const { db, config, keypair } = seed();
    const hub = new DeliveryStreamHub();
    const result = enqueueRingMessage(db, config, hub, { id: "ring_test", user_id: "usr_test", name: "Ring" }, {
      message_id: "pebble-msg-123",
      recorded_at: "2026-06-02T19:22:00.000Z",
      transcript: "Codex, fix the failing auth test",
      audio_url: null,
      metadata: { locale: "en-US" }
    });
    expect(result.ok).toBe(true);
    const dump = db.prepare(`
      select coalesce(group_concat(id || email || role || created_at), '') as text from users
      union all select coalesce(group_concat(id || name || created_at || coalesce(revoked_at,'')), '') from rings
      union all select coalesce(group_concat(id || source_message_id || message_hash || status), '') from ring_events
      union all select coalesce(group_concat(id || status || coalesce(encrypted_payload_json,'') || coalesce(encrypted_payload_deleted_at,'')), '') from agent_deliveries
      union all select coalesce(group_concat(event_type || status || coalesce(metadata_json,'')), '') from activity_events
    `).all() as Array<{ text: string }>;
    expect(dump.map((r) => r.text).join("\n")).not.toContain("fix the failing auth test");

    const deliveryId = result.deliveries[0].delivery_id;
    const claimed = claimDelivery(db, config, { id: "agt_test", user_id: "usr_test", kind: "codex", name: "Codex" }, deliveryId);
    expect(claimed.status).toBe(200);
    if (claimed.status !== 200) throw new Error("claim failed");
    expect(decryptEnvelope<any>(claimed.encrypted_payload, keypair.privateKey).transcript).toBe("Codex, fix the failing auth test");
    const row = db.prepare(`select encrypted_payload_json from agent_deliveries where id = ?`).get(deliveryId) as { encrypted_payload_json: string | null };
    expect(row.encrypted_payload_json).toBeNull();
    expect(ackDelivery(db, { id: "agt_test", user_id: "usr_test", kind: "codex", name: "Codex" }, deliveryId, "processed").status).toBe(200);
  });

  it("expires pending encrypted payloads", () => {
    const { db } = seed();
    db.prepare(`insert into ring_events (id, user_id, ring_id, source_message_id, message_hash, target_hint, payload_bytes, audio_bytes, received_at, expires_at, status, created_at) values ('evt_old', 'usr_test', 'ring_test', 'old', 'hash', 'codex', 10, null, '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z', 'queued', '2026-01-01T00:00:00.000Z')`).run();
    db.prepare(`insert into agent_deliveries (event_id, user_id, agent_id, status, encrypted_payload_json, available_at, expires_at, created_at) values ('evt_old', 'usr_test', 'agt_test', 'pending', '{"ciphertext":"x"}', '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();
    expect(expirePendingDeliveries(db, "2026-01-01T02:00:00.000Z")).toBe(1);
    const row = db.prepare(`select status, encrypted_payload_json from agent_deliveries where event_id = 'evt_old'`).get() as { status: string; encrypted_payload_json: string | null };
    expect(row.status).toBe("expired");
    expect(row.encrypted_payload_json).toBeNull();
  });

  it("emits SSE availability metadata without payload content", async () => {
    const { db, config, agentToken } = seed();
    const hub = new DeliveryStreamHub();
    const app = new Hono().route("/api/agent", agentEventsRoutes(db, config, hub));
    db.prepare(`insert into ring_events (id, user_id, ring_id, source_message_id, message_hash, target_hint, payload_bytes, audio_bytes, received_at, expires_at, status, created_at) values ('evt_sse', 'usr_test', 'ring_test', 'sse', 'hash', 'codex', 10, null, ?, ?, 'queued', ?)`)
      .run(new Date().toISOString(), new Date(Date.now() + 60_000).toISOString(), new Date().toISOString());
    db.prepare(`insert into agent_deliveries (event_id, user_id, agent_id, status, encrypted_payload_json, available_at, expires_at, created_at) values ('evt_sse', 'usr_test', 'agt_test', 'pending', '{"ciphertext":"secret transcript"}', ?, ?, ?)`)
      .run(new Date().toISOString(), new Date(Date.now() + 60_000).toISOString(), new Date().toISOString());
    const response = await app.request("/api/agent/events", { headers: { Authorization: `Bearer ${agentToken}` } });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const chunk = await reader.read();
    reader.cancel();
    const text = new TextDecoder().decode(chunk.value);
    expect(text).toContain("delivery.available");
    expect(text).not.toContain("secret transcript");
  });

  it("publishes ntfy replies without storing reply text", async () => {
    const { db, config } = seed();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const { encryptAppConfig, publishNtfyReply } = await import("../src/services/ntfy.js");
    db.prepare(`insert into notification_targets (id, user_id, kind, label, encrypted_config_json, enabled, created_at, updated_at) values ('ntfy_test', 'usr_test', 'ntfy', 'Phone', ?, 1, ?, ?)`)
      .run(encryptAppConfig(config, { url: "https://ntfy.sh/test-topic" }), new Date().toISOString(), new Date().toISOString());
    await publishNtfyReply(db, config, "usr_test", "reply body");
    expect(fetchMock).toHaveBeenCalledWith("https://ntfy.sh/test-topic", expect.objectContaining({ body: "reply body" }));
    const activity = db.prepare(`select coalesce(group_concat(metadata_json), '') as text from activity_events`).get() as { text: string };
    expect(activity.text).not.toContain("reply body");
    fetchMock.mockRestore();
  });

  it("accepts current mobile-app direct URL plus token ingest without setup exchange", async () => {
    const { db, config, ringToken } = seed();
    const hub = new DeliveryStreamHub();
    const app = new Hono().route("/api/ring", ringIngestRoutes(db, config, hub, () => false));
    const response = await app.request(`/api/ring/ingest?token=${encodeURIComponent(ringToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message_id: "mobile-direct-1",
        recorded_at: "2026-06-02T19:22:00.000Z",
        transcript: "Codex, handle this direct mobile webhook",
        audio_url: null,
        metadata: { source: "mobile-app" }
      })
    });
    const body = await response.json() as { ok: boolean; request_id: string };
    expect(response.status).toBe(202);
    expect(body.ok).toBe(true);
    expect(body.request_id.startsWith("req_")).toBe(true);
  });
});
