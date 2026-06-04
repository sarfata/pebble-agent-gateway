import type { Db } from "../../db/migrate.js";
import type { GatewayConfig } from "../../config.js";
import { logActivity } from "../activity-log.js";
import { publishNtfyReply } from "../ntfy.js";
import { updateRingEventStatus } from "./claim.js";

export async function expirePendingDeliveries(db: Db, config: GatewayConfig, now = new Date().toISOString()): Promise<number> {
  const tx = db.transaction(() => {
    const rows = db.prepare(`
      select
        agent_deliveries.id,
        agent_deliveries.event_id,
        agent_deliveries.user_id,
        agent_deliveries.agent_id,
        agent_connectors.kind as agent_kind,
        agent_connectors.name as agent_name
      from agent_deliveries
      join agent_connectors on agent_connectors.id = agent_deliveries.agent_id
      where agent_deliveries.status = 'pending' and agent_deliveries.expires_at <= ?
    `).all(now) as Array<{ id: number; event_id: string; user_id: string; agent_id: string; agent_kind: string; agent_name: string }>;
    for (const row of rows) {
      db.prepare(`update agent_deliveries set status = 'expired', encrypted_payload_json = null, encrypted_payload_deleted_at = ? where id = ?`)
        .run(now, row.id);
      logActivity(db, {
        user_id: row.user_id,
        agent_id: row.agent_id,
        event_id: row.event_id,
        delivery_id: row.id,
        event_type: "delivery.expired",
        status: "expired"
      });
      updateRingEventStatus(db, row.event_id);
    }
    return rows.length;
  });
  const expired = tx();
  const events = db.prepare(`
    select
      ring_events.id,
      ring_events.user_id,
      ring_events.target_hint,
      ring_events.created_at,
      count(agent_deliveries.id) as expired_deliveries
    from ring_events
    join agent_deliveries on agent_deliveries.event_id = ring_events.id
    where ring_events.status = 'expired'
      and agent_deliveries.status = 'expired'
      and not exists (
        select 1 from activity_events
        where activity_events.event_id = ring_events.id
          and activity_events.event_type = 'notification.no_listener'
      )
    group by ring_events.id
  `).all() as Array<{ id: string; user_id: string; target_hint: string | null; created_at: string; expired_deliveries: number }>;
  for (const event of events) {
    logActivity(db, {
      user_id: event.user_id,
      event_id: event.id,
      event_type: "notification.no_listener",
      status: "sent",
      target_kind: event.target_hint,
      metadata: { expired_deliveries: event.expired_deliveries }
    });
    await publishNtfyReply(db, config, event.user_id, `Pebble agent error: no one is listening for this message. It was not claimed within ${config.messageTtlMinutes} minute${config.messageTtlMinutes === 1 ? "" : "s"}, so the pending payload was deleted.`);
  }
  return expired;
}
