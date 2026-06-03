import { Hono } from "hono";
import { nanoid } from "nanoid";
import type { Db } from "../db/migrate.js";
import type { GatewayConfig } from "../config.js";
import { generateToken, hashToken } from "../services/crypto/token-hash.js";
import { authUserMiddleware, type AuthUser } from "../services/auth.js";

export function provisionRoutes(db: Db, config: GatewayConfig): Hono {
  const app = new Hono();
  app.post("/setup-token", authUserMiddleware(db, config), (c) => {
    const user = c.get("user") as AuthUser;
    const token = generateToken("pst");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 60_000).toISOString();
    db.prepare(`insert into setup_tokens (id, user_id, token_hash, purpose, ring_id, expires_at, used_at, created_at) values (?, ?, ?, 'ring_setup', null, ?, null, ?)`)
      .run(`stp_${nanoid(21)}`, user.id, hashToken(token, config.tokenPepper), expiresAt, now.toISOString());
    return c.json({
      setup_token: token,
      expires_at: expiresAt,
      qr_payload: {
        version: 1,
        type: "pebble-agent-gateway-setup",
        setup_url: `${config.publicBaseUrl}/api/provision/exchange`,
        setup_token: token,
        expires_at: expiresAt
      }
    });
  });

  app.post("/exchange", async (c) => {
    const body = await c.req.json<{ setup_token: string; device_label?: string }>();
    const now = new Date().toISOString();
    const setup = db.prepare(`select * from setup_tokens where token_hash = ? and used_at is null and expires_at > ?`)
      .get(hashToken(body.setup_token, config.tokenPepper), now) as { id: string; user_id: string } | undefined;
    if (!setup) return c.json({ ok: false, error: "invalid_setup_token" }, 401);
    const ringToken = generateToken("ri_live");
    const ringId = `ring_${nanoid(21)}`;
    db.transaction(() => {
      db.prepare(`insert into rings (id, user_id, name, ingest_token_hash, created_at, revoked_at) values (?, ?, ?, ?, ?, null)`)
        .run(ringId, setup.user_id, body.device_label ?? "Pebble Index Ring", hashToken(ringToken, config.tokenPepper), now);
      db.prepare(`update setup_tokens set used_at = ?, ring_id = ? where id = ?`).run(now, ringId, setup.id);
    })();
    return c.json({ webhook_url: `${config.publicBaseUrl}/api/ring/ingest`, ring_id: ringId, ingest_token: ringToken });
  });
  return app;
}
