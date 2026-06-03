import type { EncryptedPayloadEnvelope } from "@pebble/protocol";
import type { Db } from "../../db/migrate.js";
import type { GatewayConfig } from "../../config.js";
import type { AuthAgent } from "../auth.js";
import { logActivity } from "../activity-log.js";

export function claimDelivery(db: Db, config: GatewayConfig, agent: AuthAgent, deliveryId: number) {
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    const row = db.prepare(`select * from agent_deliveries where id = ? and agent_id = ?`)
      .get(deliveryId, agent.id) as { id: number; event_id: string; user_id: string; encrypted_payload_json: string | null; status: string; expires_at: string; available_at: string } | undefined;
    if (!row) return { status: 404 as const };
    if (row.status !== "pending") return { status: 409 as const };
    if (row.expires_at <= now) return { status: 410 as const };
    if (!row.encrypted_payload_json) return { status: 410 as const };
    const encrypted_payload = JSON.parse(row.encrypted_payload_json) as EncryptedPayloadEnvelope;
    db.prepare(`
      update agent_deliveries
      set status = 'claimed', claimed_at = ?, encrypted_payload_json = ?, encrypted_payload_deleted_at = ?
      where id = ?
    `).run(now, config.deletePayloadOnClaim ? null : row.encrypted_payload_json, config.deletePayloadOnClaim ? now : null, deliveryId);
    logActivity(db, {
      user_id: row.user_id,
      agent_id: agent.id,
      event_id: row.event_id,
      delivery_id: deliveryId,
      event_type: "delivery.claimed",
      status: config.deletePayloadOnClaim ? "claimed_payload_deleted" : "claimed"
    });
    updateRingEventStatus(db, row.event_id);
    return { status: 200 as const, event_id: row.event_id, encrypted_payload };
  });
  return tx();
}

export function ackDelivery(db: Db, agent: AuthAgent, deliveryId: number, status: string) {
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    const row = db.prepare(`select * from agent_deliveries where id = ? and agent_id = ?`)
      .get(deliveryId, agent.id) as { id: number; event_id: string; user_id: string; status: string; claimed_at: string | null; available_at: string } | undefined;
    if (!row) return { status: 404 as const };
    db.prepare(`update agent_deliveries set status = 'acked', acked_at = ? where id = ?`).run(now, deliveryId);
    logActivity(db, {
      user_id: row.user_id,
      agent_id: agent.id,
      event_id: row.event_id,
      delivery_id: deliveryId,
      event_type: "delivery.acked",
      status,
      delivery_latency_ms: row.claimed_at ? Date.parse(now) - Date.parse(row.available_at) : null
    });
    updateRingEventStatus(db, row.event_id);
    return { status: 200 as const };
  });
  return tx();
}

export function updateRingEventStatus(db: Db, eventId: string): void {
  const rows = db.prepare(`select status from agent_deliveries where event_id = ?`).all(eventId) as Array<{ status: string }>;
  if (rows.length === 0) return;
  const allDone = rows.every((row) => ["claimed", "acked", "expired", "failed"].includes(row.status));
  const allExpired = rows.every((row) => row.status === "expired");
  const anyClaimed = rows.some((row) => ["claimed", "acked"].includes(row.status));
  const status = allExpired ? "expired" : allDone ? "claimed" : anyClaimed ? "partially_claimed" : "queued";
  db.prepare(`update ring_events set status = ? where id = ?`).run(status, eventId);
}
