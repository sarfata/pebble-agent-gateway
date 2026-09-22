import { nanoid } from "nanoid";
import type { PlaintextDeliveryPayload } from "@pebble/protocol";
import type { Db } from "../../db/migrate.js";
import type { GatewayConfig } from "../../config.js";
import { encryptEnvelope } from "../crypto/envelope.js";
import { hashMessage } from "../crypto/token-hash.js";
import { logActivity } from "../activity-log.js";
import { routeConnectors } from "../routing.js";
import type { AuthRing } from "../auth.js";
import type { RingIngestRequest } from "@pebble/protocol";
import type { DeliveryStreamHub } from "./stream.js";
import { logInfo, logWarn } from "../logger.js";
import { encryptAppPayload } from "../crypto/app-payload.js";
import { publishNtfyReply } from "../ntfy.js";
import { processGrokbotDelivery } from "../grokbot.js";
import type { WebhookHttpClient } from "../mcp-events.js";

export async function enqueueRingMessage(db: Db, config: GatewayConfig, hub: DeliveryStreamHub, ring: AuthRing, input: RingIngestRequest, grokbotWebhookClient?: WebhookHttpClient) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.messageTtlMinutes * 60_000).toISOString();
  const eventId = `evt_${nanoid(21)}`;
  const payloadBytes = Buffer.byteLength(JSON.stringify(input));
  const routing = routeConnectors(db, ring.user_id, input.transcript, input.trigger);

  const existing = db.prepare(`select id, expires_at from ring_events where ring_id = ? and source_message_id = ?`)
    .get(ring.id, input.message_id) as { id: string; expires_at: string } | undefined;
  if (existing) {
    const deliveries = db.prepare(`
      select agent_deliveries.id as delivery_id, agent_connectors.kind as agent_kind
      from agent_deliveries join agent_connectors on agent_connectors.id = agent_deliveries.agent_id
      where event_id = ?
    `).all(existing.id);
    logInfo("ring.ingest.idempotent", {
      ring_id: ring.id,
      event_id: existing.id,
      deliveries: deliveries.length
    });
    return { ok: true, event_id: existing.id, deliveries, expires_at: existing.expires_at, idempotent: true };
  }

  const tx = db.transaction(() => {
    if (routing.agents.length === 0) {
      db.prepare(`insert into ring_events values (@id, @user_id, @ring_id, @source_message_id, @message_hash, @target_hint, @payload_bytes, @audio_bytes, @received_at, @expires_at, @status, @created_at)`)
        .run({
          id: eventId,
          user_id: ring.user_id,
          ring_id: ring.id,
          source_message_id: input.message_id,
          message_hash: hashMessage(input.transcript),
          target_hint: routing.targetHint,
          payload_bytes: payloadBytes,
          audio_bytes: null,
          received_at: now.toISOString(),
          expires_at: expiresAt,
          status: "rejected",
          created_at: now.toISOString()
        });
      logActivity(db, {
        user_id: ring.user_id,
        ring_id: ring.id,
        event_id: eventId,
        event_type: "ring.ingest",
        status: "rejected",
        target_kind: routing.targetHint,
        payload_bytes: payloadBytes,
        error_code: "no_target"
      });
      logWarn("ring.ingest.no_target", {
        ring_id: ring.id,
        event_id: eventId,
        target_hint: routing.targetHint,
        payload_bytes: payloadBytes
      });
      return { created: [], grokbotDeliveries: [] };
    }

    db.prepare(`insert into ring_events values (@id, @user_id, @ring_id, @source_message_id, @message_hash, @target_hint, @payload_bytes, @audio_bytes, @received_at, @expires_at, @status, @created_at)`)
      .run({
        id: eventId,
        user_id: ring.user_id,
        ring_id: ring.id,
        source_message_id: input.message_id,
        message_hash: hashMessage(input.transcript),
        target_hint: routing.targetHint,
        payload_bytes: payloadBytes,
        audio_bytes: null,
        received_at: now.toISOString(),
        expires_at: expiresAt,
        status: "queued",
        created_at: now.toISOString()
      });

    const created: Array<{ delivery_id: number; agent_id: string; agent_kind: string }> = [];
    const grokbotDeliveries: Array<{ delivery_id: number; agent: { id: string; user_id: string; encrypted_config_json: string | null } }> = [];
    for (const agent of routing.agents) {
      const plaintext: PlaintextDeliveryPayload = {
        message_id: eventId,
        ring_id: ring.id,
        source_message_id: input.message_id,
        recorded_at: input.recorded_at,
        transcript: input.transcript,
        trigger: input.trigger,
        audio: input.audio_url ? { url: input.audio_url } : null,
        metadata: input.metadata
      };
      // GrokBot has no local connector to hold a private key, so its
      // deliveries always use the app-managed encryption path regardless of
      // whether a connector key happens to be set on the row.
      const encrypted = agent.kind !== "grokbot" && agent.encryption_public_key.trim()
        ? encryptEnvelope(plaintext, agent.encryption_public_key)
        : encryptAppPayload(config, plaintext);
      const result = db.prepare(`
        insert into agent_deliveries (
          event_id, user_id, agent_id, status, encrypted_payload_json, encrypted_payload_deleted_at,
          available_at, expires_at, claimed_at, acked_at, failed_at, failure_reason, created_at
        ) values (?, ?, ?, 'pending', ?, null, ?, ?, null, null, null, null, ?)
      `).run(eventId, ring.user_id, agent.id, JSON.stringify(encrypted), now.toISOString(), expiresAt, now.toISOString());
      const deliveryId = Number(result.lastInsertRowid);
      created.push({ delivery_id: deliveryId, agent_id: agent.id, agent_kind: agent.kind });
      if (agent.kind === "grokbot") {
        grokbotDeliveries.push({ delivery_id: deliveryId, agent: { id: agent.id, user_id: ring.user_id, encrypted_config_json: agent.encrypted_config_json } });
      }
      logActivity(db, {
        user_id: ring.user_id,
        ring_id: ring.id,
        agent_id: agent.id,
        event_id: eventId,
        delivery_id: deliveryId,
        event_type: "delivery.created",
        status: "pending",
        target_kind: agent.kind,
        payload_bytes: payloadBytes
      });
      logInfo("delivery.created", {
        ring_id: ring.id,
        agent_id: agent.id,
        event_id: eventId,
        delivery_id: deliveryId,
        agent_kind: agent.kind,
        expires_at: expiresAt
      });
    }
    return { created, grokbotDeliveries };
  });

  const { created: deliveries, grokbotDeliveries } = tx();
  if (deliveries.length === 0) {
    await publishNtfyReply(db, config, ring.user_id, `Pebble agent error: no agent connector is configured for this message${routing.targetHint ? ` (${routing.targetHint})` : ""}. No transcript was stored.`);
  }
  for (const delivery of deliveries) {
    if (delivery.agent_kind === "grokbot") continue;
    hub.publish(delivery.agent_id, { delivery_id: delivery.delivery_id, event_id: eventId, expires_at: expiresAt });
  }
  // GrokBot has no local connector to claim over SSE, so the gateway forwards
  // it directly here instead. This intentionally runs after the transaction
  // commits since it makes an outbound HTTP call.
  for (const grokbotDelivery of grokbotDeliveries) {
    await processGrokbotDelivery(db, config, grokbotDelivery.agent, { delivery_id: grokbotDelivery.delivery_id, event_id: eventId }, grokbotWebhookClient);
  }
  return { ok: deliveries.length > 0, event_id: eventId, deliveries: deliveries.map(({ agent_id, ...rest }) => rest), expires_at: expiresAt };
}
