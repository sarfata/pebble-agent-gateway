import type { PlaintextDeliveryPayload } from "@pebble/protocol";
import type { Db } from "../db/migrate.js";
import type { GatewayConfig } from "../config.js";
import type { AuthAgent } from "./auth.js";
import { APP_PAYLOAD_ALG, decryptAppPayload, encryptAppPayload, type AppEncryptedPayloadEnvelope } from "./crypto/app-payload.js";
import { SafeWebhookHttpClient, type WebhookHttpClient } from "./mcp-events.js";
import { logActivity } from "./activity-log.js";
import { updateRingEventStatus } from "./queue/claim.js";

type Target = { webhookUrl: string; ingestToken: string };
type Pending = { id: number; event_id: string; user_id: string; agent_id: string; encrypted_payload_json: string; target_json: string; attempts: number; expires_at: string };

export function initializeAgentsChatBridge(db: Db) {
  db.exec(`create table if not exists agents_chat_targets (
    agent_id text primary key references agent_connectors(id) on delete cascade,
    user_id text not null, target_json text not null, created_at text not null
  );
  create table if not exists agents_chat_attempts (
    delivery_id integer primary key references agent_deliveries(id) on delete cascade,
    attempts integer not null, next_attempt_at integer not null
  );`);
}

export function pairAgentsChat(db: Db, config: GatewayConfig, agent: AuthAgent, input: Target) {
  const url = new URL(input.webhookUrl);
  if (url.protocol !== "https:" || url.hostname !== "agents-chat.fly.dev" || (url.port && url.port !== "443") || url.username || url.password || url.search || url.hash || !/^\/api\/rings\/pair_[A-Za-z0-9_-]+\/messages$/.test(url.pathname)) {
    throw new Error("Use the exact Agents Chat HTTPS pairing URL returned by rings_pair");
  }
  if (!/^ring_[A-Za-z0-9_-]{43}$/.test(input.ingestToken)) throw new Error("Invalid Agents Chat ingest credential");
  const connector = db.prepare(`select encryption_public_key from agent_connectors where id = ? and user_id = ? and revoked_at is null`)
    .get(agent.id, agent.user_id) as { encryption_public_key: string } | undefined;
  if (!connector || connector.encryption_public_key.trim()) throw new Error("Choose a gateway-managed connector with no connector public key");
  db.prepare(`insert into agents_chat_targets values (?, ?, ?, ?) on conflict(agent_id) do update set target_json = excluded.target_json, created_at = excluded.created_at`)
    .run(agent.id, agent.user_id, JSON.stringify(encryptAppPayload(config, { webhookUrl: url.toString(), ingestToken: input.ingestToken })), new Date().toISOString());
  return { paired: true, agent_id: agent.id };
}

/** The existing encrypted pending deliveries are the durable outbox. Ingest
 * never waits on a remote server. Restart, retry, and lost HTTP ACK recovery all
 * reuse the gateway event ID as the destination idempotency key. */
export class AgentsChatBridge {
  private running?: Promise<void>;
  private readonly abort = new AbortController();
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly db: Db, private readonly config: GatewayConfig, private readonly http: WebhookHttpClient = new SafeWebhookHttpClient()) {
    initializeAgentsChatBridge(db);
    this.timer = setInterval(() => { void this.drain(); }, 1000); this.timer.unref();
  }
  drain() {
    if (this.running || this.abort.signal.aborted) return this.running ?? Promise.resolve();
    this.running = this.process().catch(() => {
      // Never log arbitrary errors: decrypt/network errors can contain content
      // or credentials. The pending row remains available for the next attempt.
      console.error("Agents Chat outbox processing failed");
    }).finally(() => { this.running = undefined; });
    return this.running;
  }
  async close() { clearInterval(this.timer); this.abort.abort(); await this.running; }

  private async process() {
    const rows = this.db.prepare(`select d.*, t.target_json, coalesce(a.attempts, 0) as attempts from agent_deliveries d
      join agents_chat_targets t on t.agent_id = d.agent_id and t.user_id = d.user_id
      join agent_connectors c on c.id = d.agent_id and c.user_id = d.user_id
      left join agents_chat_attempts a on a.delivery_id = d.id
      where d.status = 'pending' and d.encrypted_payload_json is not null and d.expires_at > ?
        and c.revoked_at is null and coalesce(a.next_attempt_at, 0) <= ? order by d.id limit 20`)
      .all(new Date().toISOString(), Date.now()) as Pending[];
    for (const row of rows) {
      if (this.abort.signal.aborted) return;
      let category = "bridge_network_error", permanent = false;
      try {
        const target = decryptAppPayload<Target>(this.config, JSON.parse(row.target_json));
        const stored = JSON.parse(row.encrypted_payload_json) as AppEncryptedPayloadEnvelope;
        if (stored.alg !== APP_PAYLOAD_ALG) throw new Error("Gateway-managed payload required");
        const payload = decryptAppPayload<PlaintextDeliveryPayload>(this.config, stored);
        const response = await this.http.post(target.webhookUrl, JSON.stringify({ message_id: row.event_id,
          recorded_at: payload.recorded_at, transcript: payload.transcript }), {
          Authorization: `Bearer ${target.ingestToken}`, "Content-Type": "application/json"
        }, AbortSignal.any([this.abort.signal, AbortSignal.timeout(10_000)]));
        if (this.abort.signal.aborted) return;
        if (response.status >= 200 && response.status < 300) {
          const receipt = JSON.parse(response.body) as { accepted?: boolean; eventId?: unknown };
          if (receipt.accepted !== true || typeof receipt.eventId !== "string") throw new Error("Invalid destination acknowledgment");
          // Recheck target and connector after the asynchronous HTTP operation.
          // If the pairing was changed/revoked mid-flight, do not ACK another
          // pairing's delivery. A retry is safe via destination deduplication.
          this.db.transaction(() => {
            const current = this.db.prepare(`select t.target_json from agents_chat_targets t join agent_connectors c on c.id = t.agent_id
              where t.agent_id = ? and t.user_id = ? and c.revoked_at is null`).get(row.agent_id, row.user_id) as { target_json: string } | undefined;
            if (current?.target_json !== row.target_json) return;
            const now = new Date().toISOString();
            const changed = this.db.prepare(`update agent_deliveries set status = 'acked', acked_at = ?, encrypted_payload_json = null,
              encrypted_payload_deleted_at = ? where id = ? and status = 'pending'`).run(now, now, row.id).changes;
            if (!changed) return;
            this.db.prepare(`update agent_connectors set last_seen_at = ? where id = ?`).run(now, row.agent_id);
            logActivity(this.db, { user_id: row.user_id, agent_id: row.agent_id, event_id: row.event_id, delivery_id: row.id, event_type: "delivery.acked", status: "agents_chat_accepted" });
            updateRingEventStatus(this.db, row.event_id);
          }).immediate();
          continue;
        }
        category = `bridge_http_${Math.floor(response.status / 100)}xx`;
        permanent = response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status);
      } catch { if (this.abort.signal.aborted) return; }
      const attempts = row.attempts + 1, now = new Date().toISOString();
      this.db.transaction(() => {
        this.db.prepare(`insert into agents_chat_attempts values (?, ?, ?) on conflict(delivery_id) do update set attempts=excluded.attempts, next_attempt_at=excluded.next_attempt_at`)
          .run(row.id, attempts, Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6)));
        if (permanent) {
          this.db.prepare(`update agent_deliveries set status = 'failed', failed_at = ?, failure_reason = ?, encrypted_payload_json = null,
            encrypted_payload_deleted_at = ? where id = ? and status = 'pending'`).run(now, category, now, row.id);
          updateRingEventStatus(this.db, row.event_id);
        }
        logActivity(this.db, { user_id: row.user_id, agent_id: row.agent_id, event_id: row.event_id, delivery_id: row.id, event_type: "delivery.bridge_attempt", status: permanent ? "failed" : "retrying", error_code: category });
      }).immediate();
    }
  }
}
