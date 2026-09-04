import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import { createMcpHandler, Server, type ServerCapabilities } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import type { Context, Hono } from "hono";
import type { Db } from "../db/migrate.js";
import type { GatewayConfig } from "../config.js";
import { authenticateAgent, tokenCredential, type AuthAgent } from "../services/auth.js";
import type { McpEventsService } from "../services/mcp-events.js";

const EmptyArgumentsSchema = z.record(z.string(), z.unknown()).optional().default({});
const EventRequestSchema = z.object({
  name: z.string(),
  arguments: EmptyArgumentsSchema,
  cursor: z.string().nullable().optional(),
  maxAgeMs: z.number().int().nonnegative().optional()
});
const PollRequestSchema = EventRequestSchema.extend({
  maxEvents: z.number().int().positive().optional()
});
const WebhookSubscribeRequestSchema = EventRequestSchema.extend({
  delivery: z.object({
    mode: z.literal("webhook"),
    url: z.string(),
    secret: z.string()
  }),
  ttlMs: z.number().int().nonnegative().nullable().optional()
});
const WebhookUnsubscribeRequestSchema = z.object({
  name: z.string(),
  arguments: EmptyArgumentsSchema,
  delivery: z.object({ url: z.string() })
});
const ListRequestSchema = z.object({ cursor: z.string().optional() }).optional().default({});

const EventOccurrenceSchema = z.object({
  eventId: z.string(),
  name: z.string(),
  timestamp: z.string(),
  data: z.object({
    deliveryId: z.number().int(),
    ringId: z.string(),
    expiresAt: z.string(),
    claimUrl: z.string()
  }),
  cursor: z.string().nullable().optional()
});
const ListResultSchema = z.object({
  events: z.array(z.unknown()),
  nextCursor: z.string().optional()
});
const PollResultSchema = z.object({
  events: z.array(EventOccurrenceSchema),
  cursor: z.string(),
  truncated: z.boolean(),
  hasMore: z.boolean(),
  nextPollMs: z.number().int()
});
const SubscribeResultSchema = z.object({
  id: z.string(),
  refreshBefore: z.string().nullable(),
  cursor: z.string().nullable(),
  truncated: z.boolean(),
  deliveryStatus: z.object({
    active: z.boolean(),
    lastDeliveryAt: z.string().optional(),
    lastError: z.string().nullable(),
    failedSince: z.string().optional()
  }).optional()
});
const EmptyResultSchema = z.object({
  _meta: z.record(z.string(), z.unknown()).optional()
});

export type McpEndpoint = {
  app: Hono;
  close(): Promise<void>;
};

export function mcpRoutes(
  db: Db,
  config: GatewayConfig,
  events: McpEventsService,
  isDraining: () => boolean
): McpEndpoint {
  const publicHostname = new URL(config.publicBaseUrl).hostname;
  const allowedHosts = Array.from(new Set([publicHostname, "localhost", "127.0.0.1", "[::1]"]));
  const app = createMcpHonoApp({
    host: "0.0.0.0",
    allowedHosts,
    allowedOrigins: allowedHosts
  });

  const handler = createMcpHandler((context) => {
    const agent = context.authInfo?.extra?.agent as AuthAgent | undefined;
    if (!agent) throw new Error("Authenticated agent context is required");
    return createEventsServer(events, agent);
  }, {
    responseMode: "auto",
    onerror: (error) => console.error("MCP request failed", error)
  });

  app.all("/", async (c: Context) => {
    if (isDraining()) return c.json({ error: "draining" }, 503);
    const agent = authenticateAgent(db, config, c);
    const credential = tokenCredential(c);
    if (!agent || !credential) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": "Bearer"
        }
      });
    }
    db.prepare(`update agent_connectors set last_seen_at = ? where id = ?`).run(new Date().toISOString(), agent.id);
    return await handler.fetch(c.req.raw, {
      parsedBody: c.get("parsedBody"),
      authInfo: {
        token: credential.token,
        clientId: agent.id,
        scopes: ["events:read"],
        extra: { agent }
      }
    });
  });

  return { app, close: () => handler.close() };
}

function createEventsServer(events: McpEventsService, agent: AuthAgent): Server {
  // The draft predates the finalized extension registry. Advertise its exact
  // top-level capability and the 2026 extension-map equivalent during the
  // incubation period so either style of experimental client can discover it.
  const capabilities = {
    events: { listChanged: false },
    extensions: {
      "io.modelcontextprotocol/events": { listChanged: false }
    }
  } as ServerCapabilities;
  const server = new Server({ name: "pebble-agent-gateway", version: "0.1.0" }, {
    capabilities,
    instructions: "Subscribe to pebble.message.received to learn when a queued Pebble delivery is available. Claim the delivery promptly using data.claimUrl and the same bearer token."
  });

  server.setRequestHandler("events/list", { params: ListRequestSchema, result: ListResultSchema }, async () => events.listEvents());
  server.setRequestHandler("events/poll", { params: PollRequestSchema, result: PollResultSchema }, async (params) => events.poll(agent, params));
  server.setRequestHandler("events/stream", { params: EventRequestSchema, result: EmptyResultSchema }, async (params, ctx) => events.stream(agent, params, ctx));
  server.setRequestHandler("events/subscribe", { params: WebhookSubscribeRequestSchema, result: SubscribeResultSchema }, async (params) => events.subscribe(agent, params));
  server.setRequestHandler("events/unsubscribe", { params: WebhookUnsubscribeRequestSchema, result: EmptyResultSchema }, async (params) => events.unsubscribe(agent, params));
  return server;
}
