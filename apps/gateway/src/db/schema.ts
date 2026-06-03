export const migrations = [
  `create table if not exists users (
    id text primary key,
    email text unique not null,
    password_hash text not null,
    role text not null default 'user',
    created_at text not null
  )`,
  `create table if not exists sessions (
    id text primary key,
    user_id text not null references users(id) on delete cascade,
    session_token_hash text not null unique,
    expires_at text not null,
    created_at text not null
  )`,
  `create table if not exists rings (
    id text primary key,
    user_id text not null references users(id) on delete cascade,
    name text not null,
    ingest_token_hash text not null unique,
    created_at text not null,
    revoked_at text
  )`,
  `create table if not exists setup_tokens (
    id text primary key,
    user_id text not null references users(id) on delete cascade,
    token_hash text not null unique,
    purpose text not null,
    ring_id text references rings(id) on delete cascade,
    expires_at text not null,
    used_at text,
    created_at text not null
  )`,
  `create table if not exists agent_connectors (
    id text primary key,
    user_id text not null references users(id) on delete cascade,
    kind text not null check (kind in ('openclaw', 'claude', 'codex', 'cli')),
    name text not null,
    token_hash text not null unique,
    encryption_public_key text not null,
    last_seen_at text,
    created_at text not null,
    revoked_at text
  )`,
  `create table if not exists ring_events (
    id text primary key,
    user_id text not null references users(id) on delete cascade,
    ring_id text not null references rings(id) on delete cascade,
    source_message_id text not null,
    message_hash text not null,
    target_hint text,
    payload_bytes integer,
    audio_bytes integer,
    received_at text not null,
    expires_at text not null,
    status text not null check (status in ('queued', 'partially_claimed', 'claimed', 'expired', 'rejected')),
    created_at text not null,
    unique (ring_id, source_message_id)
  )`,
  `create table if not exists agent_deliveries (
    id integer primary key autoincrement,
    event_id text not null references ring_events(id) on delete cascade,
    user_id text not null references users(id) on delete cascade,
    agent_id text not null references agent_connectors(id) on delete cascade,
    status text not null check (status in ('pending', 'claimed', 'acked', 'expired', 'failed')),
    encrypted_payload_json text,
    encrypted_payload_deleted_at text,
    available_at text not null,
    expires_at text not null,
    claimed_at text,
    acked_at text,
    failed_at text,
    failure_reason text,
    created_at text not null,
    unique (event_id, agent_id)
  )`,
  `create index if not exists agent_deliveries_pending_idx on agent_deliveries(agent_id, id) where status = 'pending'`,
  `create index if not exists agent_deliveries_expiry_idx on agent_deliveries(expires_at) where status = 'pending'`,
  `create table if not exists activity_events (
    id integer primary key autoincrement,
    user_id text not null,
    ring_id text,
    agent_id text,
    event_id text,
    delivery_id integer,
    event_type text not null,
    status text not null,
    target_kind text,
    payload_bytes integer,
    audio_bytes integer,
    delivery_latency_ms integer,
    error_code text,
    metadata_json text,
    created_at text not null
  )`,
  `create index if not exists activity_events_user_created_idx on activity_events(user_id, created_at)`,
  `create table if not exists notification_targets (
    id text primary key,
    user_id text not null references users(id) on delete cascade,
    kind text not null check (kind in ('ntfy')),
    label text not null,
    encrypted_config_json text not null,
    enabled integer not null default 1,
    created_at text not null,
    updated_at text not null
  )`,
  `create table if not exists user_settings (
    user_id text primary key references users(id) on delete cascade,
    default_agent_kind text,
    updated_at text not null
  )`
];
