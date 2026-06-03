import { Hono } from "hono";
import type { Context } from "hono";
import { nanoid } from "nanoid";
import type { Db } from "../db/migrate.js";
import type { GatewayConfig } from "../config.js";
import { generateToken, hashToken } from "../services/crypto/token-hash.js";
import { hashPassword, verifyPassword } from "../services/password.js";

export function authRoutes(db: Db, config: GatewayConfig): Hono {
  const app = new Hono();

  app.post("/signup", async (c) => {
    if (!config.signupsEnabled) return c.json({ ok: false, error: "signups_disabled" }, 403);
    const body = await c.req.json<{ email: string; password: string }>();
    if (!body.email) return c.json({ ok: false, error: "email_required" }, 400);
    if (!body.password || body.password.length < 8) return c.json({ ok: false, error: "password_too_short" }, 400);
    const existing = db.prepare(`select id from users where email = ?`).get(body.email.toLowerCase());
    if (existing) return c.json({ ok: false, error: "email_already_registered" }, 409);
    const count = db.prepare(`select count(*) as n from users`).get() as { n: number };
    const userId = `usr_${nanoid(21)}`;
    db.prepare(`insert into users (id, email, password_hash, role, created_at) values (?, ?, ?, ?, ?)`)
      .run(userId, body.email.toLowerCase(), hashPassword(body.password), count.n === 0 ? "admin" : "user", new Date().toISOString());
    return createSession(c, db, config, userId);
  });

  app.post("/login", async (c) => {
    const body = await c.req.json<{ email: string; password: string }>();
    const user = db.prepare(`select id, password_hash from users where email = ?`).get(body.email?.toLowerCase()) as { id: string; password_hash: string } | undefined;
    if (!user || !verifyPassword(body.password ?? "", user.password_hash)) return c.json({ ok: false, error: "invalid_credentials" }, 401);
    return createSession(c, db, config, user.id);
  });

  app.post("/logout", (c) => {
    c.header("Set-Cookie", "pag_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    return c.json({ ok: true });
  });

  return app;
}

function createSession(c: Context, db: Db, config: GatewayConfig, userId: string) {
  const token = generateToken("sess");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60_000).toISOString();
  db.prepare(`insert into sessions (id, user_id, session_token_hash, expires_at, created_at) values (?, ?, ?, ?, ?)`)
    .run(`ses_${nanoid(21)}`, userId, hashToken(token, config.tokenPepper), expiresAt, now.toISOString());
  c.header("Set-Cookie", `pag_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`);
  return c.json({ ok: true });
}
