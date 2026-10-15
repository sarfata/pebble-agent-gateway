import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { openDb } from "../src/db/migrate.js";
import { loadConfig } from "../src/config.js";
import { hashToken } from "../src/services/crypto/token-hash.js";
import { AgentsChatBridge, pairAgentsChat } from "../src/services/agents-chat-bridge.js";
import { DeliveryStreamHub } from "../src/services/queue/stream.js";
import { enqueueRingMessage } from "../src/services/queue/enqueue.js";
import { claimDelivery } from "../src/services/queue/claim.js";
import { agentsChatRoutes } from "../src/routes/agents-chat.js";

const closes: Array<() => unknown> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const target = { webhookUrl: "https://agents-chat.fly.dev/api/rings/pair_example/messages", ingestToken: `ring_${"a".repeat(43)}` };
const agent = { id: "connector", user_id: "owner", kind: "codex" as const, name: "Private agent" };
function setup() {
  const db = openDb(":memory:"), config = loadConfig({ TOKEN_PEPPER: "fixture", APP_ENCRYPTION_KEY: "fixture", NTFY_ENABLED: "false" });
  closes.push(() => db.close());
  const now = new Date().toISOString();
  for (const user of ["owner", "foreign"]) db.prepare(`insert into users values (?, ?, 'hash', 'user', ?)`).run(user, `${user}@example.com`, now);
  db.prepare(`insert into rings values ('ring', 'owner', 'Ring', 'hash', ?, null)`).run(now);
  db.prepare(`insert into agent_connectors values ('connector', 'owner', 'codex', 'Private agent', ?, '', null, ?, null)`).run(hashToken("owner-token", config.tokenPepper), now);
  db.prepare(`insert into agent_connectors values ('foreign', 'foreign', 'codex', 'Other', ?, '', null, ?, null)`).run(hashToken("foreign-token", config.tokenPepper), now);
  let httpStatus = 202, failAfterAccept = false, acknowledged = true;
  const sent: any[] = [], accepted = new Map<string, string>();
  const http = { async post(url: string, raw: string, headers: Record<string, string>) {
    const body = JSON.parse(raw); sent.push({ url, raw, headers, body });
    if (httpStatus === 202) accepted.set(body.message_id, body.transcript);
    if (failAfterAccept) throw new Error(`response lost ${body.transcript}`);
    return { status: httpStatus, body: acknowledged ? JSON.stringify({ accepted: true, eventId: "event_test" }) : `private response ${body.transcript}` };
  } };
  const bridge = new AgentsChatBridge(db, config, http); closes.push(() => bridge.close());
  const hub = new DeliveryStreamHub();
  const ingest = (id = "source-1") => enqueueRingMessage(db, config, hub, { id: "ring", user_id: "owner", name: "Ring" }, {
    message_id: id, recorded_at: now, transcript: "long private ring content ".repeat(40), metadata: {}
  });
  const state = () => db.prepare(`select status, encrypted_payload_json, failure_reason from agent_deliveries order by id`).all() as any[];
  return { db, config, http, bridge, ingest, sent, accepted, state,
    status: (n: number) => { httpStatus = n; }, loseAck: (n: boolean) => { failAfterAccept = n; }, ack: (n: boolean) => { acknowledged = n; } };
}

describe("Agents Chat durable ring bridge", () => {
  it("queues before forwarding and forwards the complete transcript with encrypted credentials", async () => {
    const f = setup(); pairAgentsChat(f.db, f.config, agent, target);
    await f.ingest(); expect(f.sent).toHaveLength(0); expect(f.state()[0].status).toBe("pending");
    expect(claimDelivery(f.db, f.config, agent, 1).status).toBe(409);
    const persisted = JSON.stringify(f.db.prepare(`select * from agents_chat_targets`).all()); expect(persisted).not.toContain(target.ingestToken);
    await f.bridge.drain(); expect(f.sent).toHaveLength(1); expect(f.sent[0].body.transcript.length).toBeGreaterThan(200);
    expect(f.sent[0].headers.Authorization).toBe(`Bearer ${target.ingestToken}`);
    expect(f.state()[0]).toMatchObject({ status: "acked", encrypted_payload_json: null, failure_reason: null });
  });

  it("recovers pending rows after a worker restart and deduplicates lost acknowledgments", async () => {
    const f = setup(); pairAgentsChat(f.db, f.config, agent, target); await f.ingest();
    f.loseAck(true); await f.bridge.drain(); expect(f.state()[0].status).toBe("pending"); expect(f.accepted.size).toBe(1);
    await f.bridge.close(); f.loseAck(false);
    f.db.prepare(`update agents_chat_attempts set next_attempt_at = 0`).run();
    const restarted = new AgentsChatBridge(f.db, f.config, f.http); closes.push(() => restarted.close());
    await restarted.drain(); expect(f.sent).toHaveLength(2); expect(f.sent[0].body.message_id).toBe(f.sent[1].body.message_id); expect(f.accepted.size).toBe(1);
    expect(f.state()[0].status).toBe("acked");
  });

  it("backs off transient errors and never stores remote response bodies in diagnostics", async () => {
    const f = setup(); pairAgentsChat(f.db, f.config, agent, target); await f.ingest(); f.status(503);
    await f.bridge.drain(); await f.bridge.drain(); expect(f.sent).toHaveLength(1); expect(f.state()[0].status).toBe("pending");
    f.db.prepare(`update agents_chat_attempts set next_attempt_at = 0`).run(); f.status(401); await f.bridge.drain();
    expect(f.state()[0]).toMatchObject({ status: "failed", failure_reason: "bridge_http_4xx", encrypted_payload_json: null });
    const diagnostic = JSON.stringify(f.db.prepare(`select * from activity_events`).all()); expect(diagnostic).not.toContain("long private ring content"); expect(diagnostic).not.toContain(target.ingestToken);
  });

  it("does not acknowledge malformed successful responses or expired/revoked deliveries", async () => {
    const f = setup(); pairAgentsChat(f.db, f.config, agent, target); await f.ingest(); f.ack(false); await f.bridge.drain();
    expect(f.state()[0].status).toBe("pending");
    f.db.prepare(`update agents_chat_attempts set next_attempt_at = 0`).run(); f.db.prepare(`update agent_connectors set revoked_at = ? where id = ?`).run(new Date().toISOString(), agent.id);
    await f.bridge.drain(); expect(f.sent).toHaveLength(1);
  });

  it("authenticates pairing, rejects arbitrary destinations, and leaves foreign connectors unchanged", async () => {
    const f = setup(), app = new Hono().route("/api/agent", agentsChatRoutes(f.db, f.config));
    expect((await app.request("/api/agent/agents-chat/pair", { method: "POST" })).status).toBe(401);
    for (const webhookUrl of ["http://agents-chat.fly.dev/api/rings/pair_x/messages", "https://127.0.0.1/api/rings/pair_x/messages", "https://evil.example/api/rings/pair_x/messages", `${target.webhookUrl}?token=x`]) expect(() => pairAgentsChat(f.db, f.config, agent, { ...target, webhookUrl })).toThrow();
    const paired = await app.request("/api/agent/agents-chat/pair", { method: "POST", headers: { Authorization: "Bearer owner-token", "Content-Type": "application/json" }, body: JSON.stringify(target) }); expect(paired.status).toBe(200);
    await app.request("/api/agent/agents-chat/unpair", { method: "POST", headers: { Authorization: "Bearer foreign-token" } });
    expect(f.db.prepare(`select agent_id from agents_chat_targets`).all()).toEqual([{ agent_id: agent.id }]);
  });
});
