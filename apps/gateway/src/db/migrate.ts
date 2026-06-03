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
  });
  tx();
}

export function checkpoint(db: Db): void {
  db.pragma("wal_checkpoint(TRUNCATE)");
}
