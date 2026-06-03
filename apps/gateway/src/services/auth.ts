import type { Context, MiddlewareHandler } from "hono";
import type { Db } from "../db/migrate.js";
import type { GatewayConfig } from "../config.js";
import { hashToken } from "./crypto/token-hash.js";

export type AuthRing = {
  id: string;
  user_id: string;
  name: string;
};

export type AuthAgent = {
  id: string;
  user_id: string;
  kind: "openclaw" | "claude" | "codex" | "cli";
  name: string;
};

export type AuthUser = {
  id: string;
  email: string;
  role: string;
};

function bearer(c: Context): string | null {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

export function authenticateRing(db: Db, config: GatewayConfig, c: Context): AuthRing | null {
  const token = bearer(c);
  if (!token) return null;
  return db.prepare(`select id, user_id, name from rings where ingest_token_hash = ? and revoked_at is null`)
    .get(hashToken(token, config.tokenPepper)) as AuthRing | undefined ?? null;
}

export function authenticateAgent(db: Db, config: GatewayConfig, c: Context): AuthAgent | null {
  const token = bearer(c);
  if (!token) return null;
  return db.prepare(`select id, user_id, kind, name from agent_connectors where token_hash = ? and revoked_at is null`)
    .get(hashToken(token, config.tokenPepper)) as AuthAgent | undefined ?? null;
}

export function authUserMiddleware(db: Db, config: GatewayConfig): MiddlewareHandler {
  return async (c, next) => {
    const cookie = c.req.header("Cookie") ?? "";
    const match = /(?:^|;\s*)pag_session=([^;]+)/.exec(cookie);
    if (!match) return c.json({ ok: false, error: "unauthorized" }, 401);
    const tokenHash = hashToken(decodeURIComponent(match[1]), config.tokenPepper);
    const user = db.prepare(`
      select users.id, users.email, users.role
      from sessions join users on users.id = sessions.user_id
      where sessions.session_token_hash = ? and sessions.expires_at > ?
    `).get(tokenHash, new Date().toISOString()) as AuthUser | undefined;
    if (!user) return c.json({ ok: false, error: "unauthorized" }, 401);
    c.set("user", user);
    await next();
  };
}
