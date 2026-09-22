import Database from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { migrations } from "./schema.js";
import { sqlitePath } from "../config.js";

export type Db = Database.Database;

export function openDb(databaseUrl: string): Db {
  const path = sqlitePath(databaseUrl);
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  const tx = db.transaction(() => {
    for (const sql of migrations) db.prepare(sql).run();
    const settingsColumns = db.prepare(`pragma table_info(user_settings)`).all() as Array<{ name: string }>;
    if (!settingsColumns.some((column) => column.name === "double_action_agent_kind")) {
      db.prepare(`alter table user_settings add column double_action_agent_kind text`).run();
    }
    const connectorColumns = db.prepare(`pragma table_info(agent_connectors)`).all() as Array<{ name: string }>;
    if (!connectorColumns.some((column) => column.name === "encrypted_config_json")) {
      db.prepare(`alter table agent_connectors add column encrypted_config_json text`).run();
    }
  });
  tx();
  ensureGrokbotKindSupported(db);
}

// SQLite cannot ALTER a CHECK constraint in place, so upgrading an existing
// `agent_connectors` table to accept the `grokbot` kind requires rebuilding
// it. `agent_deliveries.agent_id` has a foreign key into this table, and
// SQLite rewrites *other* tables' stored REFERENCES clauses whenever the
// table they point at is renamed — so we must never rename `agent_connectors`
// itself. Instead we build the replacement under a temp name, drop the
// original, then rename the temp table into place; `agent_deliveries` keeps
// referencing the literal name `agent_connectors` throughout, which resolves
// correctly once the replacement table exists under that name. Foreign key
// enforcement has to be off for this (SQLite disallows dangling references
// mid-rebuild) and can only be toggled outside of an active transaction, so
// this runs after `tx()` has committed, in its own transaction.
// This whole function is a no-op once the constraint already allows
// `grokbot`, which includes brand-new databases created from schema.ts.
function ensureGrokbotKindSupported(db: Db): void {
  const table = db.prepare(`select sql from sqlite_master where type = 'table' and name = 'agent_connectors'`)
    .get() as { sql: string } | undefined;
  if (!table || table.sql.includes("'grokbot'")) return;
  const foreignKeysWereOn = db.pragma("foreign_keys", { simple: true }) === 1;
  if (foreignKeysWereOn) db.pragma("foreign_keys = OFF");
  try {
    const rebuild = db.transaction(() => {
      db.prepare(`
        create table agent_connectors_new (
          id text primary key,
          user_id text not null references users(id) on delete cascade,
          kind text not null check (kind in ('openclaw', 'claude', 'codex', 'cli', 'grokbot')),
          name text not null,
          token_hash text not null unique,
          encryption_public_key text not null,
          encrypted_config_json text,
          last_seen_at text,
          created_at text not null,
          revoked_at text
        )
      `).run();
      db.prepare(`
        insert into agent_connectors_new (id, user_id, kind, name, token_hash, encryption_public_key, encrypted_config_json, last_seen_at, created_at, revoked_at)
        select id, user_id, kind, name, token_hash, encryption_public_key, encrypted_config_json, last_seen_at, created_at, revoked_at from agent_connectors
      `).run();
      db.prepare(`drop table agent_connectors`).run();
      db.prepare(`alter table agent_connectors_new rename to agent_connectors`).run();
    });
    rebuild();
    if (foreignKeysWereOn) {
      const violations = db.prepare(`pragma foreign_key_check(agent_deliveries)`).all();
      if (violations.length > 0) throw new Error("Foreign key violations detected while migrating agent_connectors to support the grokbot kind");
    }
  } finally {
    if (foreignKeysWereOn) db.pragma("foreign_keys = ON");
  }
}

export function checkpoint(db: Db): void {
  db.pragma("wal_checkpoint(TRUNCATE)");
}
