import { describe, expect, it } from "vitest";
import { openDb, migrate } from "../src/db/migrate.js";

describe("agent_connectors grokbot migration", () => {
  it("upgrades an existing database created with the old CHECK constraint", () => {
    const db = openDb(":memory:");
    const now = new Date().toISOString();
    db.prepare(`insert into users (id, email, password_hash, role, created_at) values ('usr_old', 'old@example.com', 'hash', 'admin', ?)`).run(now);

    // Simulate a database created before the `grokbot` kind existed, with an
    // existing connector row that must survive the upgrade.
    db.pragma("foreign_keys = OFF");
    db.exec(`
      drop table agent_connectors;
      create table agent_connectors (
        id text primary key,
        user_id text not null references users(id) on delete cascade,
        kind text not null check (kind in ('openclaw', 'claude', 'codex', 'cli')),
        name text not null,
        token_hash text not null unique,
        encryption_public_key text not null,
        last_seen_at text,
        created_at text not null,
        revoked_at text
      );
    `);
    db.pragma("foreign_keys = ON");
    db.prepare(`insert into agent_connectors (id, user_id, kind, name, token_hash, encryption_public_key, created_at) values ('agt_old', 'usr_old', 'codex', 'Old Codex', 'hash', '', ?)`)
      .run(now);

    expect(() => db.prepare(`insert into agent_connectors (id, user_id, kind, name, token_hash, encryption_public_key, created_at) values ('agt_should_fail', 'usr_old', 'grokbot', 'GrokBot', 'hash2', '', ?)`).run(now))
      .toThrow(/CHECK constraint failed/);

    migrate(db);

    // Pre-existing rows survive the rebuild, including the new nullable column.
    const preserved = db.prepare(`select kind, name, encrypted_config_json from agent_connectors where id = 'agt_old'`).get() as { kind: string; name: string; encrypted_config_json: string | null };
    expect(preserved).toEqual({ kind: "codex", name: "Old Codex", encrypted_config_json: null });

    // The upgraded constraint now accepts grokbot.
    expect(() => db.prepare(`insert into agent_connectors (id, user_id, kind, name, token_hash, encryption_public_key, created_at) values ('agt_grokbot', 'usr_old', 'grokbot', 'GrokBot', 'hash3', '', ?)`).run(now))
      .not.toThrow();

    // Foreign key enforcement is restored and still works.
    const violations = db.prepare(`pragma foreign_key_check(agent_connectors)`).all();
    expect(violations).toHaveLength(0);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("is a no-op when the constraint already supports grokbot", () => {
    const db = openDb(":memory:");
    expect(() => migrate(db)).not.toThrow();
    const table = db.prepare(`select sql from sqlite_master where type = 'table' and name = 'agent_connectors'`).get() as { sql: string };
    expect(table.sql).toContain("'grokbot'");
  });
});

describe("agent_connectors encrypted_config_json migration", () => {
  it("adds the column to a database that already supports grokbot but predates the column", () => {
    const db = openDb(":memory:");
    const now = new Date().toISOString();
    db.prepare(`insert into users (id, email, password_hash, role, created_at) values ('usr_mid', 'mid@example.com', 'hash', 'admin', ?)`).run(now);

    // Simulate the database state after the grokbot-kind migration landed but
    // before encrypted_config_json existed — exactly the state of an already
    // deployed instance running the connector-based GrokBot PR.
    db.pragma("foreign_keys = OFF");
    db.exec(`
      drop table agent_connectors;
      create table agent_connectors (
        id text primary key,
        user_id text not null references users(id) on delete cascade,
        kind text not null check (kind in ('openclaw', 'claude', 'codex', 'cli', 'grokbot')),
        name text not null,
        token_hash text not null unique,
        encryption_public_key text not null,
        last_seen_at text,
        created_at text not null,
        revoked_at text
      );
    `);
    db.pragma("foreign_keys = ON");
    db.prepare(`insert into agent_connectors (id, user_id, kind, name, token_hash, encryption_public_key, created_at) values ('agt_mid', 'usr_mid', 'grokbot', 'GrokBot', 'hash', '', ?)`).run(now);

    expect(() => migrate(db)).not.toThrow();

    const columns = db.prepare(`pragma table_info(agent_connectors)`).all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "encrypted_config_json")).toBe(true);
    const row = db.prepare(`select encrypted_config_json from agent_connectors where id = 'agt_mid'`).get() as { encrypted_config_json: string | null };
    expect(row.encrypted_config_json).toBeNull();
  });
});
