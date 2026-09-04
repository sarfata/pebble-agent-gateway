import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { loadConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/migrate.js";
import { mcpRoutes, type McpEndpoint } from "../src/routes/mcp.js";
import { ringIngestRoutes } from "../src/routes/ring-ingest.js";
import { generateToken, hashToken } from "../src/services/crypto/token-hash.js";
import {
  McpEventsService,
  PEBBLE_MESSAGE_EVENT,
  type WebhookHttpClient,
  type WebhookPostResult
} from "../src/services/mcp-events.js";
import { DeliveryStreamHub } from "../src/services/queue/stream.js";

type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, any>;
  error?: { code: number; message: string; data?: unknown };
};

type WebhookCall = {
  url: string;
  body: string;
  headers: Record<string, string>;
};

class FakeWebhookClient implements WebhookHttpClient {
  readonly calls: WebhookCall[] = [];

  async post(url: string, body: string, headers: Record<string, string>): Promise<WebhookPostResult> {
    this.calls.push({ url, body, headers });
    const payload = JSON.parse(body) as { type?: string; challenge?: string };
    if (payload.type === "verification") {
      return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) };
    }
    return { status: 204, body: "" };
  }
}

type Fixture = {
  app: Hono;
  db: Db;
  endpoint: McpEndpoint;
  events: McpEventsService;
  ringToken: string;
  agentToken: string;
  webhook: FakeWebhookClient;
};

const fixtures: Fixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.events.close();
    await fixture.endpoint.close();
    fixture.db.close();
  }
});

function setup(): Fixture {
  const db = openDb(":memory:");
  const config = loadConfig({
    DATABASE_URL: "file::memory:",
    TOKEN_PEPPER: "mcp-test-pepper",
    APP_ENCRYPTION_KEY: "mcp-app-key",
    MESSAGE_TTL_MINUTES: "60",
    PUBLIC_BASE_URL: "https://gateway.example.com"
  });
  const now = new Date().toISOString();
  const ringToken = generateToken("ri_live");
  const agentToken = generateToken("ag_live");
  db.prepare(`insert into users (id, email, password_hash, role, created_at) values ('usr_mcp', 'mcp@example.com', 'hash', 'admin', ?)`).run(now);
  db.prepare(`insert into rings (id, user_id, name, ingest_token_hash, created_at, revoked_at) values ('ring_mcp', 'usr_mcp', 'Ring', ?, ?, null)`)
    .run(hashToken(ringToken, config.tokenPepper), now);
  db.prepare(`insert into agent_connectors (id, user_id, kind, name, token_hash, encryption_public_key, last_seen_at, created_at, revoked_at) values ('agt_mcp', 'usr_mcp', 'codex', 'Codex', ?, '', null, ?, null)`)
    .run(hashToken(agentToken, config.tokenPepper), now);

  const hub = new DeliveryStreamHub();
  const webhook = new FakeWebhookClient();
  const events = new McpEventsService(db, config, hub, webhook);
  const endpoint = mcpRoutes(db, config, events, () => false);
  const app = new Hono()
    .route("/mcp", endpoint.app)
    .route("/api/ring", ringIngestRoutes(db, config, hub, () => false));
  const fixture = { app, db, endpoint, events, ringToken, agentToken, webhook };
  fixtures.push(fixture);
  return fixture;
}

async function mcpRequest(fixture: Fixture, method: string, params: Record<string, unknown> = {}, id: string | number = 1): Promise<JsonRpcMessage> {
  const response = await fixture.app.request("/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${fixture.agentToken}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      Host: "gateway.example.com"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
  });
  expect(response.status).toBe(200);
  const messages = await responseMessages(response);
  const message = messages.find((candidate) => candidate.id === id);
  if (!message) throw new Error(`MCP response ${String(id)} was missing`);
  if (message.error) throw new Error(`MCP error ${message.error.code}: ${message.error.message}`);
  return message;
}

async function responseMessages(response: Response): Promise<JsonRpcMessage[]> {
  const text = await response.text();
  if (response.headers.get("content-type")?.includes("text/event-stream")) return parseSseMessages(text);
  const parsed = JSON.parse(text) as JsonRpcMessage | JsonRpcMessage[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function parseSseMessages(text: string): JsonRpcMessage[] {
  return text.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice("data:".length).trim()) as JsonRpcMessage);
}

async function readSseUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (message: JsonRpcMessage) => boolean,
  timeoutMs = 2_000
): Promise<JsonRpcMessage> {
  const decoder = new TextDecoder();
  let pending = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Timed out waiting for SSE message")), remaining))
    ]);
    if (chunk.done) throw new Error("SSE stream ended before the expected message");
    pending += decoder.decode(chunk.value, { stream: true });
    const frames = pending.split(/\r?\n\r?\n/);
    pending = frames.pop() ?? "";
    for (const frame of frames) {
      for (const message of parseSseMessages(frame)) {
        if (predicate(message)) return message;
      }
    }
  }
  throw new Error("Timed out waiting for SSE message");
}

async function sendJsonMessage(fixture: Fixture, messageId: string, transcript: string): Promise<void> {
  const response = await fixture.app.request(`/api/ring/ingest?token=${encodeURIComponent(fixture.ringToken)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message_id: messageId,
      recorded_at: new Date().toISOString(),
      transcript,
      audio_url: null,
      metadata: { source: "test-api" }
    })
  });
  expect(response.status).toBe(202);
}

async function sendMultipartMessage(fixture: Fixture, messageId: string, transcript: string): Promise<void> {
  const form = new FormData();
  form.set("token", fixture.ringToken);
  form.set("message_id", messageId);
  form.set("recorded_at", new Date().toISOString());
  form.set("transcript", transcript);
  form.set("metadata", JSON.stringify({ source: "test-webhook" }));
  const response = await fixture.app.request("/api/ring/ingest", { method: "POST", body: form });
  expect(response.status).toBe(202);
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("experimental MCP Events endpoint", () => {
  it("requires an agent connector token", async () => {
    const fixture = setup();
    const response = await fixture.app.request("/mcp", {
      method: "POST",
      headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json", Host: "gateway.example.com" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "events/list", params: {} })
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("advertises the draft capability and all three delivery modes", async () => {
    const fixture = setup();
    const initialized = await mcpRequest(fixture, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "mcp-events-test", version: "1.0.0" }
    });
    expect(initialized.result?.capabilities.events).toEqual({ listChanged: false });
    expect(initialized.result?.capabilities.extensions["io.modelcontextprotocol/events"]).toEqual({ listChanged: false });

    const listed = await mcpRequest(fixture, "events/list");
    expect(listed.result?.events).toEqual([
      expect.objectContaining({
        name: PEBBLE_MESSAGE_EVENT,
        delivery: ["poll", "push", "webhook"],
        inputSchema: expect.any(Object),
        payloadSchema: expect.any(Object)
      })
    ]);
  });

  it("polls new deliveries from both JSON API and multipart webhook ingestion", async () => {
    const fixture = setup();
    const started = await mcpRequest(fixture, "events/poll", { name: PEBBLE_MESSAGE_EVENT, cursor: null });
    expect(started.result).toMatchObject({ events: [], cursor: "delivery:0", truncated: false, hasMore: false });

    await sendJsonMessage(fixture, "mcp-api-1", "a secret API transcript");
    const apiPoll = await mcpRequest(fixture, "events/poll", { name: PEBBLE_MESSAGE_EVENT, cursor: started.result?.cursor });
    expect(apiPoll.result?.events).toHaveLength(1);
    expect(apiPoll.result?.events[0]).toMatchObject({
      name: PEBBLE_MESSAGE_EVENT,
      data: {
        deliveryId: 1,
        ringId: "ring_mcp",
        claimUrl: "https://gateway.example.com/api/agent/deliveries/1/claim"
      }
    });
    expect(JSON.stringify(apiPoll.result)).not.toContain("secret API transcript");

    await sendMultipartMessage(fixture, "mcp-webhook-1", "a secret webhook transcript");
    const webhookPoll = await mcpRequest(fixture, "events/poll", { name: PEBBLE_MESSAGE_EVENT, cursor: apiPoll.result?.cursor });
    expect(webhookPoll.result?.events).toHaveLength(1);
    expect(webhookPoll.result?.events[0].data.deliveryId).toBe(2);
    expect(JSON.stringify(webhookPoll.result)).not.toContain("secret webhook transcript");
  });

  it("pushes live event notifications over the events/stream response", async () => {
    const fixture = setup();
    const abort = new AbortController();
    const response = await fixture.app.request("/mcp", {
      method: "POST",
      signal: abort.signal,
      headers: {
        Authorization: `Bearer ${fixture.agentToken}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        Host: "gateway.example.com"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "stream-1",
        method: "events/stream",
        params: { name: PEBBLE_MESSAGE_EVENT, cursor: null }
      })
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const active = await readSseUntil(reader, (message) => message.method === "notifications/events/active");
    expect(active.params?._meta).toEqual({ "io.modelcontextprotocol/subscriptionId": "stream-1" });

    await sendJsonMessage(fixture, "mcp-stream-1", "stream-only secret");
    const occurrence = await readSseUntil(reader, (message) => message.method === "notifications/events/event");
    expect(occurrence.params).toMatchObject({
      name: PEBBLE_MESSAGE_EVENT,
      data: { deliveryId: 1, ringId: "ring_mcp" },
      _meta: { "io.modelcontextprotocol/subscriptionId": "stream-1" }
    });
    expect(JSON.stringify(occurrence)).not.toContain("stream-only secret");
    abort.abort();
    await reader.cancel();
  });

  it("verifies, signs, delivers, and unsubscribes webhook events", async () => {
    const fixture = setup();
    const secretBytes = Buffer.alloc(32, 7);
    const secret = `whsec_${secretBytes.toString("base64")}`;
    const url = "https://hooks.example.com/mcp-events";
    const subscribed = await mcpRequest(fixture, "events/subscribe", {
      name: PEBBLE_MESSAGE_EVENT,
      delivery: { mode: "webhook", url, secret },
      ttlMs: 600_000,
      cursor: null
    });
    expect(subscribed.result).toMatchObject({
      id: expect.stringMatching(/^sub_/),
      cursor: "delivery:0",
      truncated: false,
      deliveryStatus: { active: true, lastError: null }
    });
    expect(fixture.webhook.calls).toHaveLength(1);
    expect(JSON.parse(fixture.webhook.calls[0].body)).toMatchObject({ type: "verification", challenge: expect.any(String) });

    await sendJsonMessage(fixture, "mcp-webhook-delivery-1", "webhook-only secret");
    await waitFor(() => fixture.webhook.calls.length === 2);
    const delivered = fixture.webhook.calls[1];
    const body = JSON.parse(delivered.body) as Record<string, any>;
    expect(delivered.url).toBe(url);
    expect(body).toMatchObject({ name: PEBBLE_MESSAGE_EVENT, data: { deliveryId: 1, ringId: "ring_mcp" } });
    expect(delivered.body).not.toContain("webhook-only secret");
    expect(delivered.headers["X-MCP-Subscription-Id"]).toBe(subscribed.result?.id);
    const signed = `${delivered.headers["webhook-id"]}.${delivered.headers["webhook-timestamp"]}.${delivered.body}`;
    expect(delivered.headers["webhook-signature"]).toBe(`v1,${createHmac("sha256", secretBytes).update(signed).digest("base64")}`);

    const unsubscribed = await mcpRequest(fixture, "events/unsubscribe", {
      name: PEBBLE_MESSAGE_EVENT,
      delivery: { url }
    });
    expect(unsubscribed.result).toEqual({});
    await sendJsonMessage(fixture, "mcp-webhook-delivery-2", "not delivered after unsubscribe");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fixture.webhook.calls).toHaveLength(2);
  });
});
