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

export function enqueueRingMessage(db: Db, config: GatewayConfig, hub: DeliveryStreamHub, ring: AuthRing, input: RingIngestRequest) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.messageTtlMinutes * 60_000).toISOString();
  const eventId = `evt_${nanoid(21)}`;
  const payloadBytes = Buffer.byteLength(JSON.stringify(input));
  const routing = routeConnectors(db, ring.user_id, input.transcript);

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
      return [];
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
    for (const agent of routing.agents) {
      const plaintext: PlaintextDeliveryPayload = {
        message_id: eventId,
        ring_id: ring.id,
        source_message_id: input.message_id,
        recorded_at: input.recorded_at,
        transcript: input.transcript,
        audio: input.audio_url ? { url: input.audio_url } : null,
        metadata: input.metadata
      };
      const encrypted = agent.encryption_public_key.trim()
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
    return created;
  });

  const deliveries = tx();
  for (const delivery of deliveries) {
    hub.publish(delivery.agent_id, { delivery_id: delivery.delivery_id, event_id: eventId, expires_at: expiresAt });
  }
  return { ok: deliveries.length > 0, event_id: eventId, deliveries: deliveries.map(({ agent_id, ...rest }) => rest), expires_at: expiresAt };
}
