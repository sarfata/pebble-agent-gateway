import type { PlaintextDeliveryPayload } from "@pebble/protocol";
import type { Db } from "../db/migrate.js";
import type { GatewayConfig } from "../config.js";
import { decryptAppConfig, encryptAppConfig, publishNtfyReply } from "./ntfy.js";
import { publishPushoverReply } from "./pushover.js";
import { decryptAppPayload, type AppEncryptedPayloadEnvelope } from "./crypto/app-payload.js";
import { logActivity } from "./activity-log.js";
import { updateRingEventStatus } from "./queue/claim.js";
import { SafeWebhookHttpClient, type WebhookHttpClient } from "./mcp-events.js";

export type GrokbotWebhookConfig = {
  url: string;
  token?: string;
  payloadKey?: string;
};

const DEFAULT_PAYLOAD_KEY = "text";

// Reused across requests: it has no per-call state beyond its allowed-hosts
// list, which never changes at runtime.
const webhookClient = new SafeWebhookHttpClient();

export function encryptGrokbotConfig(config: GatewayConfig, value: GrokbotWebhookConfig): string {
  return encryptAppConfig(config, value);
}

export function decryptGrokbotConfig(config: GatewayConfig, encryptedJson: string): GrokbotWebhookConfig {
  return decryptAppConfig<GrokbotWebhookConfig>(config, encryptedJson);
}

export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * POSTs a transcript to a GrokBot webhook and returns the text to use as the
 * reply. Reuses the same SSRF-safe HTTPS client (DNS-pinned, blocks
 * private/special-purpose addresses, size- and time-bounded) already used
 * for MCP event webhook subscriptions, since this is the same threat model:
 * the gateway making an outbound call to an arbitrary user-supplied URL.
 */
export async function forwardTranscriptToGrokbot(webhook: GrokbotWebhookConfig, transcript: string, client: WebhookHttpClient = webhookClient): Promise<string> {
  const key = webhook.payloadKey?.trim() || DEFAULT_PAYLOAD_KEY;
  const body = JSON.stringify({ [key]: transcript });
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (webhook.token) headers.Authorization = `Bearer ${webhook.token}`;
  const response = await client.post(webhook.url, body, headers);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`GrokBot webhook returned HTTP ${response.status}${response.body ? `: ${response.body.slice(0, 500)}` : ""}`);
  }
  const text = response.body.trim();
  return text || `Sent to GrokBot (HTTP ${response.status}).`;
}

type GrokbotAgent = { id: string; user_id: string; encrypted_config_json: string | null };
type GrokbotDelivery = { delivery_id: number; event_id: string };

/**
 * Processes a pending delivery for a `grokbot` connector immediately,
 * in-process, instead of leaving it for a connector to claim over SSE.
 * GrokBot has no local dependency, so the gateway forwards it directly:
 * decrypt the queued payload, POST it to the configured webhook, then mark
 * the delivery acked/failed and publish the result the same way a real
 * connector's reply would (see routes/agent-replies.ts).
 */
export async function processGrokbotDelivery(db: Db, config: GatewayConfig, agent: GrokbotAgent, delivery: GrokbotDelivery, client: WebhookHttpClient = webhookClient): Promise<void> {
  const row = db.prepare(`select encrypted_payload_json from agent_deliveries where id = ? and status = 'pending'`)
    .get(delivery.delivery_id) as { encrypted_payload_json: string | null } | undefined;
  if (!row?.encrypted_payload_json) return;

  let transcript: string;
  try {
    const envelope = JSON.parse(row.encrypted_payload_json) as AppEncryptedPayloadEnvelope;
    transcript = decryptAppPayload<PlaintextDeliveryPayload>(config, envelope).transcript;
  } catch (error) {
    await failDelivery(db, config, agent, delivery, error instanceof Error ? error.message : "Could not decrypt delivery payload.");
    return;
  }

  if (!agent.encrypted_config_json) {
    await failDelivery(db, config, agent, delivery, "GrokBot connector is missing its webhook configuration.");
    return;
  }

  try {
    const webhook = decryptGrokbotConfig(config, agent.encrypted_config_json);
    const reply = await forwardTranscriptToGrokbot(webhook, transcript, client);
    await ackDelivery(db, config, agent, delivery, reply);
  } catch (error) {
    await failDelivery(db, config, agent, delivery, error instanceof Error ? error.message : "GrokBot webhook request failed.");
  }
}

async function ackDelivery(db: Db, config: GatewayConfig, agent: GrokbotAgent, delivery: GrokbotDelivery, reply: string): Promise<void> {
  const now = new Date().toISOString();
  db.prepare(`
    update agent_deliveries
    set status = 'acked', claimed_at = ?, acked_at = ?, encrypted_payload_json = null, encrypted_payload_deleted_at = ?
    where id = ?
  `).run(now, now, now, delivery.delivery_id);
  logActivity(db, {
    user_id: agent.user_id,
    agent_id: agent.id,
    event_id: delivery.event_id,
    delivery_id: delivery.delivery_id,
    event_type: "delivery.acked",
    status: "completed"
  });
  updateRingEventStatus(db, delivery.event_id);
  await publishNtfyReply(db, config, agent.user_id, reply);
  await publishPushoverReply(db, config, agent.user_id, reply, "completed");
}

async function failDelivery(db: Db, config: GatewayConfig, agent: GrokbotAgent, delivery: GrokbotDelivery, reason: string): Promise<void> {
  const now = new Date().toISOString();
  db.prepare(`
    update agent_deliveries
    set status = 'failed', failed_at = ?, failure_reason = ?, encrypted_payload_json = null, encrypted_payload_deleted_at = ?
    where id = ?
  `).run(now, reason, now, delivery.delivery_id);
  logActivity(db, {
    user_id: agent.user_id,
    agent_id: agent.id,
    event_id: delivery.event_id,
    delivery_id: delivery.delivery_id,
    event_type: "delivery.acked",
    status: "failed",
    error_code: "grokbot_webhook_failed"
  });
  updateRingEventStatus(db, delivery.event_id);
  const message = `Pebble agent error: ${reason}`;
  await publishNtfyReply(db, config, agent.user_id, message);
  await publishPushoverReply(db, config, agent.user_id, message, "failed");
}
