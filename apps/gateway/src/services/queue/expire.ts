import type { Db } from "../../db/migrate.js";
import { logActivity } from "../activity-log.js";
import { updateRingEventStatus } from "./claim.js";

export function expirePendingDeliveries(db: Db, now = new Date().toISOString()): number {
  const tx = db.transaction(() => {
    const rows = db.prepare(`select id, event_id, user_id, agent_id from agent_deliveries where status = 'pending' and expires_at <= ?`)
      .all(now) as Array<{ id: number; event_id: string; user_id: string; agent_id: string }>;
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
  return tx();
}
