import type { Db } from "../db/migrate.js";

export type ActivityInput = {
  user_id: string;
  ring_id?: string | null;
  agent_id?: string | null;
  event_id?: string | null;
  delivery_id?: number | null;
  event_type: string;
  status: string;
  target_kind?: string | null;
  payload_bytes?: number | null;
  audio_bytes?: number | null;
  delivery_latency_ms?: number | null;
  error_code?: string | null;
  metadata?: Record<string, unknown> | null;
};

export function logActivity(db: Db, input: ActivityInput): void {
  db.prepare(`insert into activity_events (
    user_id, ring_id, agent_id, event_id, delivery_id, event_type, status,
    target_kind, payload_bytes, audio_bytes, delivery_latency_ms, error_code,
    metadata_json, created_at
  ) values (
    @user_id, @ring_id, @agent_id, @event_id, @delivery_id, @event_type, @status,
    @target_kind, @payload_bytes, @audio_bytes, @delivery_latency_ms, @error_code,
    @metadata_json, @created_at
  )`).run({
    user_id: input.user_id,
    ring_id: input.ring_id ?? null,
    agent_id: input.agent_id ?? null,
    event_id: input.event_id ?? null,
    delivery_id: input.delivery_id ?? null,
    event_type: input.event_type,
    status: input.status,
    target_kind: input.target_kind ?? null,
    payload_bytes: input.payload_bytes ?? null,
    audio_bytes: input.audio_bytes ?? null,
    delivery_latency_ms: input.delivery_latency_ms ?? null,
    error_code: input.error_code ?? null,
    metadata_json: input.metadata ? JSON.stringify(input.metadata) : null,
    created_at: new Date().toISOString()
  });
}
