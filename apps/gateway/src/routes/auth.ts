import { Hono } from "hono";
import type { Context } from "hono";
import { nanoid } from "nanoid";
import type { Db } from "../db/migrate.js";
import type { GatewayConfig } from "../config.js";
import { generateToken, hashToken } from "../services/crypto/token-hash.js";
import { hashPassword, verifyPassword } from "../services/password.js";

export function authRoutes(db: Db, config: GatewayConfig): Hono {
  const app = new Hono();
  const authAttempts = new Map<string, { count: number; resetAt: number }>();
  app.use("/signup", authRateLimit(authAttempts));
  app.use("/login", authRateLimit(authAttempts));

  app.post("/signup", async (c) => {
    if (!config.signupsEnabled) return c.json({ ok: false, error: "signups_disabled" }, 403);
    const body = await c.req.json<{ email: string; password: string }>();
    const email = normalizeEmail(body.email);
    if (!email) return c.json({ ok: false, error: "email_required" }, 400);
    if (email.length > 254 || !email.includes("@")) return c.json({ ok: false, error: "email_invalid" }, 400);
    if (!body.password || body.password.length < 8) return c.json({ ok: false, error: "password_too_short" }, 400);
    if (body.password.length > 1024) return c.json({ ok: false, error: "password_too_long" }, 400);
    const existing = db.prepare(`select id from users where email = ?`).get(email);
    if (existing) return c.json({ ok: false, error: "email_already_registered" }, 409);
    const count = db.prepare(`select count(*) as n from users`).get() as { n: number };
    const userId = `usr_${nanoid(21)}`;
    db.prepare(`insert into users (id, email, password_hash, role, created_at) values (?, ?, ?, ?, ?)`)
      .run(userId, email, hashPassword(body.password), count.n === 0 ? "admin" : "user", new Date().toISOString());
    return createSession(c, db, config, userId);
  });

  app.post("/login", async (c) => {
    const body = await c.req.json<{ email: string; password: string }>();
    const user = db.prepare(`select id, password_hash from users where email = ?`).get(normalizeEmail(body.email)) as { id: string; password_hash: string } | undefined;
    if (!user || !verifyPassword(body.password ?? "", user.password_hash)) return c.json({ ok: false, error: "invalid_credentials" }, 401);
    return createSession(c, db, config, user.id);
  });

  app.post("/logout", (c) => {
    const token = sessionToken(c);
    if (token) db.prepare(`delete from sessions where session_token_hash = ?`).run(hashToken(token, config.tokenPepper));
    c.header("Set-Cookie", expiredSessionCookie(config));
    return c.json({ ok: true });
  });

  return app;
}

function authRateLimit(attempts: Map<string, { count: number; resetAt: number }>) {
  return async (c: Context, next: () => Promise<void>) => {
    const now = Date.now();
    const client = c.req.header("Fly-Client-IP")
      ?? c.req.header("X-Forwarded-For")?.split(",")[0]?.trim()
      ?? "unknown";
    const current = attempts.get(client);
    const entry = !current || current.resetAt <= now
      ? { count: 0, resetAt: now + 15 * 60_000 }
      : current;
    entry.count += 1;
    attempts.set(client, entry);
    if (entry.count > 30) {
      c.header("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
      return c.json({ ok: false, error: "rate_limited" }, 429);
    }
    await next();
  };
}

function createSession(c: Context, db: Db, config: GatewayConfig, userId: string) {
  const token = generateToken("sess");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60_000).toISOString();
  db.prepare(`insert into sessions (id, user_id, session_token_hash, expires_at, created_at) values (?, ?, ?, ?, ?)`)
    .run(`ses_${nanoid(21)}`, userId, hashToken(token, config.tokenPepper), expiresAt, now.toISOString());
  c.header("Set-Cookie", sessionCookie(config, token));
  return c.json({ ok: true });
}

function normalizeEmail(email: string | undefined): string {
  return email?.trim().toLowerCase() ?? "";
}

function sessionToken(c: Context): string | null {
  const match = /(?:^|;\s*)pag_session=([^;]+)/.exec(c.req.header("Cookie") ?? "");
  return match ? decodeURIComponent(match[1]) : null;
}

function sessionCookie(config: GatewayConfig, token: string): string {
  const secure = config.publicBaseUrl.startsWith("https://") ? "; Secure" : "";
  return `pag_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${30 * 24 * 60 * 60}`;
}

function expiredSessionCookie(config: GatewayConfig): string {
  const secure = config.publicBaseUrl.startsWith("https://") ? "; Secure" : "";
  return `pag_session=; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=0`;
}
