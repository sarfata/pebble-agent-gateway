import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { ProtocolError, type RequestId, type ServerContext } from "@modelcontextprotocol/server";
import type { GatewayConfig } from "../config.js";
import type { Db } from "../db/migrate.js";
import type { AuthAgent } from "./auth.js";
import type { DeliveryStreamHub } from "./queue/stream.js";

export const PEBBLE_MESSAGE_EVENT = "pebble.message.received";

const DEFAULT_POLL_MS = 5_000;
const DEFAULT_WEBHOOK_TTL_MS = 30 * 60_000;
const MIN_WEBHOOK_TTL_MS = 5 * 60_000;
const MAX_WEBHOOK_TTL_MS = 60 * 60_000;
const WEBHOOK_TIMEOUT_MS = 5_000;
const WEBHOOK_RETRY_DELAYS_MS = [1_000, 10_000, 60_000, 300_000] as const;

export type EventArguments = Record<string, unknown>;

export type EventOccurrence = {
  eventId: string;
  name: typeof PEBBLE_MESSAGE_EVENT;
  timestamp: string;
  data: {
    deliveryId: number;
    ringId: string;
    expiresAt: string;
    claimUrl: string;
  };
  cursor?: string;
};

export type EventRequest = {
  name: string;
  arguments?: EventArguments;
  cursor?: string | null;
  maxAgeMs?: number;
};

export type PollEventRequest = EventRequest & {
  maxEvents?: number;
};

export type WebhookSubscribeRequest = EventRequest & {
  delivery: {
    mode: "webhook";
    url: string;
    secret: string;
  };
  ttlMs?: number | null;
};

export type WebhookUnsubscribeRequest = {
  name: string;
  arguments?: EventArguments;
  delivery: { url: string };
};

type DeliveryRow = {
  delivery_id: number;
  event_id: string;
  ring_id: string;
  available_at: string;
  expires_at: string;
};

type WebhookErrorCategory = "connection_refused" | "timeout" | "tls_error" | "http_4xx" | "http_5xx" | "challenge_failed";

export type WebhookPostResult = {
  status: number;
  body: string;
};

export interface WebhookHttpClient {
  post(url: string, body: string, headers: Record<string, string>): Promise<WebhookPostResult>;
}

class InvalidWebhookUrlError extends Error {}

class WebhookDeliveryError extends Error {
  constructor(readonly category: WebhookErrorCategory, readonly status?: number) {
    super(category);
  }
}

/**
 * HTTPS client for callback delivery. DNS is resolved and checked immediately
 * before every request, then pinned into the socket lookup to close the DNS
 * rebinding window described by the experimental Events proposal.
 */
export class SafeWebhookHttpClient implements WebhookHttpClient {
  private readonly allowedHosts: Set<string>;

  constructor(allowedHosts: string[] = []) {
    this.allowedHosts = new Set(allowedHosts.map((host) => host.toLowerCase()));
  }

  async post(urlString: string, body: string, headers: Record<string, string>): Promise<WebhookPostResult> {
    const url = parseWebhookUrl(urlString);
    const hostname = stripIpv6Brackets(url.hostname);
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
      : await lookup(hostname, { all: true, verbatim: true });
    const address = this.allowedHosts.has(hostname.toLowerCase())
      ? addresses[0]
      : addresses.find((candidate) => isGloballyRoutableIp(candidate.address));
    if (!address) throw new InvalidWebhookUrlError("Webhook hostname does not resolve to a globally routable address");

    // Node's `net.connect`/`https.request` default to Happy Eyeballs
    // (RFC 8305) since Node 18.13/20, which invokes a custom `lookup`
    // function expecting the "all addresses" array-style callback
    // (`callback(err, addresses[])`) rather than the single-address form
    // (`callback(err, address, family)`), signaled by `options.all`. Pass
    // the pinned address back in whichever shape was actually requested.
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      const wantsAll = typeof options === "object" && options !== null && (options as { all?: boolean }).all === true;
      if (wantsAll) {
        callback(null, [{ address: address.address, family: address.family }]);
      } else {
        callback(null, address.address, address.family);
      }
    };

    return await new Promise<WebhookPostResult>((resolve, reject) => {
      const request = httpsRequest({
        protocol: "https:",
        hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: {
          ...headers,
          "Content-Length": Buffer.byteLength(body).toString()
        },
        lookup: pinnedLookup,
        servername: isIP(hostname) ? undefined : hostname
      }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer | string) => {
          const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += value.length;
          if (size > 64 * 1024) {
            request.destroy(new Error("Webhook response exceeded 64 KiB"));
            return;
          }
          chunks.push(value);
        });
        response.on("end", () => resolve({
          status: response.statusCode ?? 500,
          body: Buffer.concat(chunks).toString("utf8")
        }));
      });
      request.setTimeout(WEBHOOK_TIMEOUT_MS, () => {
        const error = new Error("Webhook request timed out") as NodeJS.ErrnoException;
        error.code = "ETIMEDOUT";
        request.destroy(error);
      });
      request.on("error", reject);
      request.end(body);
    });
  }
}

type WebhookSubscription = {
  key: string;
  id: string;
  agent: AuthAgent;
  name: typeof PEBBLE_MESSAGE_EVENT;
  arguments: EventArguments;
  url: string;
  secret: string;
  previousSecret?: { value: string; expiresAt: number };
  expiresAt: number;
  cursor: number;
  lastScheduled: number;
  active: boolean;
  queue: Promise<void>;
  expiryTimer?: ReturnType<typeof setTimeout>;
  offAvailable: () => void;
  lastDeliveryAt?: string;
  lastError?: WebhookErrorCategory;
  failedSince?: string;
};

export class McpEventsService {
  private readonly subscriptions = new Map<string, WebhookSubscription>();
  private readonly verifiedEndpoints = new Map<string, number>();
  private readonly webhookClient: WebhookHttpClient;
  private readonly offDraining: () => void;
  private closed = false;

  constructor(
    private readonly db: Db,
    private readonly config: GatewayConfig,
    private readonly hub: DeliveryStreamHub,
    webhookClient?: WebhookHttpClient
  ) {
    this.webhookClient = webhookClient ?? new SafeWebhookHttpClient(config.mcpWebhookAllowedHosts);
    this.offDraining = hub.onDraining(() => this.close());
  }

  listEvents() {
    return {
      events: [{
        name: PEBBLE_MESSAGE_EVENT,
        description: "A new Pebble message is queued for this authenticated agent connector.",
        delivery: ["poll", "push", "webhook"] as const,
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        payloadSchema: {
          type: "object",
          properties: {
            deliveryId: { type: "integer", description: "Delivery identifier used by the agent claim API." },
            ringId: { type: "string" },
            expiresAt: { type: "string", format: "date-time" },
            claimUrl: { type: "string", format: "uri" }
          },
          required: ["deliveryId", "ringId", "expiresAt", "claimUrl"],
          additionalProperties: false
        }
      }]
    };
  }

  poll(agent: AuthAgent, input: PollEventRequest) {
    this.assertEventRequest(input);
    const requestedLimit = input.maxEvents ?? 50;
    const limit = Math.min(requestedLimit, 100);
    if (requestedLimit < 1) throw new ProtocolError(-32602, "InvalidParams", { field: "maxEvents" });

    const current = this.currentPosition(agent.id);
    if (input.cursor === undefined || input.cursor === null) {
      return { events: [], cursor: formatCursor(current), truncated: false, hasMore: false, nextPollMs: DEFAULT_POLL_MS };
    }

    const start = parseCursor(input.cursor);
    if (start > current) {
      return { events: [], cursor: formatCursor(current), truncated: true, hasMore: false, nextPollMs: DEFAULT_POLL_MS };
    }

    const cutoff = input.maxAgeMs === undefined ? null : new Date(Date.now() - input.maxAgeMs).toISOString();
    const truncated = cutoff === null ? false : this.hasPendingBefore(agent.id, start, cutoff);
    const rows = this.pendingRowsAfter(agent.id, start, cutoff, limit + 1);
    const selected = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const cursor = hasMore && selected.length > 0 ? selected[selected.length - 1].delivery_id : current;
    return {
      // Poll advances at the response level; occurrence cursors are reserved
      // for push and webhook delivery in the current draft.
      events: selected.map((row) => this.toOccurrence(row, false)),
      cursor: formatCursor(cursor),
      truncated,
      hasMore,
      nextPollMs: DEFAULT_POLL_MS
    };
  }

  async stream(agent: AuthAgent, input: EventRequest, ctx: ServerContext): Promise<{ _meta: Record<string, never> }> {
    this.assertEventRequest(input);
    const requestedCursor = input.cursor === undefined || input.cursor === null ? null : parseCursor(input.cursor);
    const initialHead = this.currentPosition(agent.id);
    const start = requestedCursor === null ? initialHead : Math.min(requestedCursor, initialHead);
    const cutoff = input.maxAgeMs === undefined || requestedCursor === null ? null : new Date(Date.now() - input.maxAgeMs).toISOString();
    const truncated = requestedCursor !== null && (requestedCursor > initialHead || (cutoff !== null && this.hasPendingBefore(agent.id, start, cutoff)));
    const buffered: number[] = [];
    let ready = false;
    let lastScheduled = start;
    let finished!: () => void;
    const ended = new Promise<void>((resolve) => { finished = resolve; });
    let notificationQueue = Promise.resolve();

    const send = (method: string, params: Record<string, unknown>) => {
      notificationQueue = notificationQueue.then(() => ctx.mcpReq.notify({ method, params })).catch(() => {
        finished();
      });
      return notificationQueue;
    };
    const sendRow = (row: DeliveryRow) => {
      if (row.delivery_id <= lastScheduled) return;
      lastScheduled = row.delivery_id;
      void send("notifications/events/event", withSubscriptionId(this.toOccurrence(row), ctx.mcpReq.id));
    };

    const offAvailable = this.hub.onAvailable(agent.id, (event) => {
      if (!ready) {
        buffered.push(event.delivery_id);
        return;
      }
      const row = this.deliveryRow(agent.id, event.delivery_id);
      if (row) sendRow(row);
    });
    const offDraining = this.hub.onDraining(() => {
      void send("notifications/events/terminated", withSubscriptionId({
        error: { code: -32012, message: "Forbidden", data: { reason: "gateway_draining" } }
      }, ctx.mcpReq.id));
      finished();
    });
    const abort = () => finished();
    ctx.mcpReq.signal.addEventListener("abort", abort, { once: true });

    await send("notifications/events/active", withSubscriptionId({ cursor: formatCursor(start), truncated }, ctx.mcpReq.id));
    if (requestedCursor !== null) {
      for (const row of this.pendingRowsAfter(agent.id, start, cutoff, 1_000)) sendRow(row);
    }
    ready = true;
    for (const deliveryId of buffered.sort((a, b) => a - b)) {
      const row = this.deliveryRow(agent.id, deliveryId);
      if (row) sendRow(row);
    }

    const heartbeat = setInterval(() => {
      void send("notifications/events/heartbeat", withSubscriptionId({
        cursor: formatCursor(this.currentPosition(agent.id))
      }, ctx.mcpReq.id));
    }, 25_000);
    heartbeat.unref?.();

    await ended;
    clearInterval(heartbeat);
    offAvailable();
    offDraining();
    ctx.mcpReq.signal.removeEventListener("abort", abort);
    await notificationQueue;
    return { _meta: {} };
  }

  async subscribe(agent: AuthAgent, input: WebhookSubscribeRequest) {
    this.assertEventRequest(input);
    const url = parseWebhookUrl(input.delivery.url).toString();
    assertWebhookSecret(input.delivery.secret);
    const key = subscriptionKey(agent.id, url, input.name, input.arguments ?? {});
    const id = subscriptionId(key);
    const endpointKey = `${agent.id}\0${url}`;
    const now = Date.now();
    const existing = this.subscriptions.get(key);
    const suppliedCursor = input.cursor === undefined || input.cursor === null ? null : parseCursor(input.cursor);

    if (!existing && (this.verifiedEndpoints.get(endpointKey) ?? 0) <= now) {
      await this.verifyEndpoint(url, id, input.delivery.secret);
      this.verifiedEndpoints.set(endpointKey, now + MAX_WEBHOOK_TTL_MS);
    }

    const ttlMs = grantTtl(input.ttlMs);
    const expiresAt = now + ttlMs;
    if (existing) {
      if (existing.secret !== input.delivery.secret) {
        existing.previousSecret = { value: existing.secret, expiresAt: now + 5 * 60_000 };
        existing.secret = input.delivery.secret;
      }
      existing.expiresAt = expiresAt;
      existing.active = true;
      existing.lastError = undefined;
      existing.failedSince = undefined;
      this.armExpiry(existing);
      return this.webhookSubscriptionResult(existing);
    }

    const head = this.currentPosition(agent.id);
    const start = suppliedCursor === null ? head : Math.min(suppliedCursor, head);
    const cutoff = input.maxAgeMs === undefined || suppliedCursor === null ? null : new Date(Date.now() - input.maxAgeMs).toISOString();
    const truncated = suppliedCursor !== null && (
      suppliedCursor > head || (cutoff !== null && this.hasPendingBefore(agent.id, start, cutoff))
    );
    const subscription: WebhookSubscription = {
      key,
      id,
      agent,
      name: PEBBLE_MESSAGE_EVENT,
      arguments: input.arguments ?? {},
      url,
      secret: input.delivery.secret,
      expiresAt,
      cursor: start,
      lastScheduled: start,
      active: true,
      queue: Promise.resolve(),
      offAvailable: () => {}
    };
    subscription.offAvailable = this.hub.onAvailable(agent.id, (event) => {
      const row = this.deliveryRow(agent.id, event.delivery_id);
      if (row) this.scheduleWebhookDelivery(subscription, row);
    });
    this.subscriptions.set(key, subscription);
    this.armExpiry(subscription);

    if (suppliedCursor !== null) {
      for (const row of this.pendingRowsAfter(agent.id, start, cutoff, 1_000)) this.scheduleWebhookDelivery(subscription, row);
    }
    return this.webhookSubscriptionResult(subscription, truncated);
  }

  unsubscribe(agent: AuthAgent, input: WebhookUnsubscribeRequest): Record<string, never> {
    this.assertEventRequest({ name: input.name, arguments: input.arguments });
    const url = parseWebhookUrl(input.delivery.url).toString();
    const key = subscriptionKey(agent.id, url, input.name, input.arguments ?? {});
    const subscription = this.subscriptions.get(key);
    if (!subscription) throw new ProtocolError(-32011, "NotFound", { kind: "subscription" });
    this.removeSubscription(subscription);
    return {};
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.offDraining();
    for (const subscription of this.subscriptions.values()) this.removeSubscription(subscription);
    this.verifiedEndpoints.clear();
  }

  private assertEventRequest(input: Pick<EventRequest, "name" | "arguments" | "maxAgeMs">): void {
    if (input.name !== PEBBLE_MESSAGE_EVENT) throw new ProtocolError(-32011, "NotFound", { kind: "event" });
    if (input.arguments && Object.keys(input.arguments).length > 0) {
      throw new ProtocolError(-32602, "InvalidParams", { field: "arguments" });
    }
    if (input.maxAgeMs !== undefined && (!Number.isInteger(input.maxAgeMs) || input.maxAgeMs < 0)) {
      throw new ProtocolError(-32602, "InvalidParams", { field: "maxAgeMs" });
    }
  }

  private currentPosition(agentId: string): number {
    const row = this.db.prepare(`select coalesce(max(id), 0) as position from agent_deliveries where agent_id = ?`)
      .get(agentId) as { position: number };
    return Number(row.position);
  }

  private hasPendingBefore(agentId: string, cursor: number, cutoff: string): boolean {
    return Boolean(this.db.prepare(`
      select 1
      from agent_deliveries
      where agent_id = ? and id > ? and status = 'pending' and expires_at > ? and available_at < ?
      limit 1
    `).get(agentId, cursor, new Date().toISOString(), cutoff));
  }

  private pendingRowsAfter(agentId: string, cursor: number, cutoff: string | null, limit: number): DeliveryRow[] {
    return this.db.prepare(`
      select agent_deliveries.id as delivery_id, agent_deliveries.event_id, ring_events.ring_id,
             agent_deliveries.available_at, agent_deliveries.expires_at
      from agent_deliveries
      join ring_events on ring_events.id = agent_deliveries.event_id
      where agent_deliveries.agent_id = ?
        and agent_deliveries.id > ?
        and agent_deliveries.status = 'pending'
        and agent_deliveries.expires_at > ?
        and (? is null or agent_deliveries.available_at >= ?)
      order by agent_deliveries.id asc
      limit ?
    `).all(agentId, cursor, new Date().toISOString(), cutoff, cutoff, limit) as DeliveryRow[];
  }

  private deliveryRow(agentId: string, deliveryId: number): DeliveryRow | null {
    return this.db.prepare(`
      select agent_deliveries.id as delivery_id, agent_deliveries.event_id, ring_events.ring_id,
             agent_deliveries.available_at, agent_deliveries.expires_at
      from agent_deliveries
      join ring_events on ring_events.id = agent_deliveries.event_id
      where agent_deliveries.agent_id = ? and agent_deliveries.id = ?
        and agent_deliveries.status = 'pending' and agent_deliveries.expires_at > ?
    `).get(agentId, deliveryId, new Date().toISOString()) as DeliveryRow | undefined ?? null;
  }

  private toOccurrence(row: DeliveryRow, includeCursor = true): EventOccurrence {
    return {
      eventId: row.event_id,
      name: PEBBLE_MESSAGE_EVENT,
      timestamp: row.available_at,
      data: {
        deliveryId: row.delivery_id,
        ringId: row.ring_id,
        expiresAt: row.expires_at,
        claimUrl: `${this.config.publicBaseUrl}/api/agent/deliveries/${row.delivery_id}/claim`
      },
      ...(includeCursor ? { cursor: formatCursor(row.delivery_id) } : {})
    };
  }

  private async verifyEndpoint(url: string, subscriptionIdValue: string, secret: string): Promise<void> {
    const challenge = randomBytes(24).toString("base64url");
    const body = JSON.stringify({ type: "verification", challenge });
    let response: WebhookPostResult;
    try {
      response = await this.sendSigned(url, subscriptionIdValue, `msg_verification_${randomBytes(12).toString("base64url")}`, body, [secret]);
    } catch (error) {
      if (error instanceof InvalidWebhookUrlError) throw new ProtocolError(-32602, "InvalidParams", { field: "delivery.url" });
      throw new ProtocolError(-32015, "CallbackEndpointError", { reason: classifyWebhookError(error) });
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ProtocolError(-32015, "CallbackEndpointError", { reason: response.status >= 500 ? "http_5xx" : "http_4xx" });
    }
    let echoed = "";
    try {
      const parsed = JSON.parse(response.body) as { challenge?: unknown };
      if (typeof parsed.challenge === "string") echoed = parsed.challenge;
    } catch {
      // A malformed response is deliberately reported only as a category.
    }
    const expected = Buffer.from(challenge);
    const actual = Buffer.from(echoed);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new ProtocolError(-32015, "CallbackEndpointError", { reason: "challenge_failed" });
    }
  }

  private scheduleWebhookDelivery(subscription: WebhookSubscription, row: DeliveryRow): void {
    if (!subscription.active || row.delivery_id <= subscription.lastScheduled) return;
    subscription.lastScheduled = row.delivery_id;
    subscription.queue = subscription.queue.then(async () => {
      if (!subscription.active || subscription.expiresAt <= Date.now()) return;
      const occurrence = this.toOccurrence(row);
      const secrets = [subscription.secret];
      if (subscription.previousSecret && subscription.previousSecret.expiresAt > Date.now()) secrets.push(subscription.previousSecret.value);
      let delivered = false;
      for (let attempt = 0; attempt <= WEBHOOK_RETRY_DELAYS_MS.length; attempt += 1) {
        if (!subscription.active || subscription.expiresAt <= Date.now()) return;
        if (attempt > 0) await unrefDelay(WEBHOOK_RETRY_DELAYS_MS[attempt - 1]);
        try {
          const response = await this.sendSigned(subscription.url, subscription.id, occurrence.eventId, JSON.stringify(occurrence), secrets);
          if (response.status >= 200 && response.status < 300) {
            delivered = true;
            subscription.lastDeliveryAt = new Date().toISOString();
            subscription.lastError = undefined;
            subscription.failedSince = undefined;
            break;
          }
          const category: WebhookErrorCategory = response.status >= 500 ? "http_5xx" : "http_4xx";
          subscription.lastError = category;
          subscription.failedSince ??= new Date().toISOString();
          if (response.status === 410 || response.status === 413) break;
        } catch (error) {
          subscription.lastError = classifyWebhookError(error);
          subscription.failedSince ??= new Date().toISOString();
          if (error instanceof InvalidWebhookUrlError) break;
        }
      }
      // The cursor advances after ACK or after bounded retries are abandoned.
      // Serial delivery makes this a safe watermark for the next occurrence.
      subscription.cursor = Math.max(subscription.cursor, row.delivery_id);
      if (!delivered && subscription.lastError === undefined) subscription.lastError = "connection_refused";
    }).catch(() => {
      subscription.lastError = "connection_refused";
      subscription.failedSince ??= new Date().toISOString();
    });
  }

  private async sendSigned(url: string, subscriptionIdValue: string, messageId: string, body: string, secrets: string[]): Promise<WebhookPostResult> {
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const signed = `${messageId}.${timestamp}.${body}`;
    const signatures = secrets.map((secret) => {
      const key = decodeWebhookSecret(secret);
      return `v1,${createHmac("sha256", key).update(signed).digest("base64")}`;
    }).join(" ");
    return await this.webhookClient.post(url, body, {
      "Content-Type": "application/json",
      "webhook-id": messageId,
      "webhook-timestamp": timestamp,
      "webhook-signature": signatures,
      "X-MCP-Subscription-Id": subscriptionIdValue
    });
  }

  private webhookSubscriptionResult(subscription: WebhookSubscription, truncated = false) {
    return {
      id: subscription.id,
      refreshBefore: new Date(subscription.expiresAt).toISOString(),
      cursor: formatCursor(subscription.cursor),
      truncated,
      deliveryStatus: {
        active: subscription.active,
        lastDeliveryAt: subscription.lastDeliveryAt,
        lastError: subscription.lastError ?? null,
        failedSince: subscription.failedSince
      }
    };
  }

  private armExpiry(subscription: WebhookSubscription): void {
    if (subscription.expiryTimer) clearTimeout(subscription.expiryTimer);
    subscription.expiryTimer = setTimeout(() => this.removeSubscription(subscription), Math.max(0, subscription.expiresAt - Date.now()));
    subscription.expiryTimer.unref?.();
  }

  private removeSubscription(subscription: WebhookSubscription): void {
    if (this.subscriptions.get(subscription.key) !== subscription) return;
    subscription.active = false;
    if (subscription.expiryTimer) clearTimeout(subscription.expiryTimer);
    subscription.offAvailable();
    this.subscriptions.delete(subscription.key);
  }
}

function withSubscriptionId(params: Record<string, unknown>, id: RequestId): Record<string, unknown> {
  return { ...params, _meta: { "io.modelcontextprotocol/subscriptionId": id } };
}

function formatCursor(position: number): string {
  return `delivery:${position}`;
}

function parseCursor(cursor: string): number {
  const match = /^delivery:(\d+)$/.exec(cursor);
  const value = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 0) throw new ProtocolError(-32602, "InvalidParams", { field: "cursor" });
  return value;
}

function grantTtl(suggested: number | null | undefined): number {
  if (suggested === null || suggested === undefined) return DEFAULT_WEBHOOK_TTL_MS;
  if (!Number.isSafeInteger(suggested) || suggested < 0) throw new ProtocolError(-32602, "InvalidParams", { field: "ttlMs" });
  return Math.min(MAX_WEBHOOK_TTL_MS, Math.max(MIN_WEBHOOK_TTL_MS, suggested));
}

function subscriptionKey(agentId: string, url: string, name: string, args: EventArguments): string {
  return canonicalJson([agentId, url, name, args]);
}

function subscriptionId(key: string): string {
  return `sub_${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseWebhookUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProtocolError(-32602, "InvalidParams", { field: "delivery.url" });
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) {
    throw new ProtocolError(-32602, "InvalidParams", { field: "delivery.url" });
  }
  return url;
}

function assertWebhookSecret(secret: string): void {
  try {
    decodeWebhookSecret(secret);
  } catch {
    throw new ProtocolError(-32602, "InvalidParams", { field: "delivery.secret" });
  }
}

function decodeWebhookSecret(secret: string): Buffer {
  const encoded = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : "";
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) throw new Error("Invalid webhook secret");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length < 24 || bytes.length > 64) throw new Error("Invalid webhook secret length");
  if (bytes.toString("base64") !== encoded) throw new Error("Non-canonical webhook secret");
  return bytes;
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

export function isGloballyRoutableIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split(".").map(Number);
    const [a, b, c] = parts;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && c === 0) return false;
    if (a === 192 && b === 0 && c === 2) return false;
    if (a === 192 && b === 88 && c === 99) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    if (normalized === "::" || normalized === "::1" || normalized.startsWith("::ffff:")) return false;
    if (normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("ff")) return false;
    if (/^fe[89ab]/.test(normalized)) return false;
    if (normalized.startsWith("2001:db8:")) return false;
    const first = Number.parseInt(normalized.split(":", 1)[0], 16);
    return first >= 0x2000 && first <= 0x3fff;
  }
  return false;
}

function classifyWebhookError(error: unknown): WebhookErrorCategory {
  if (error instanceof WebhookDeliveryError) return error.category;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") return "timeout";
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "ENOTFOUND") {
    return "connection_refused";
  }
  if (typeof code === "string" && (code.startsWith("CERT_") || code.includes("TLS") || code.includes("SSL"))) return "tls_error";
  return "connection_refused";
}

function unrefDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
