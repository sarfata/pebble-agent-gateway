import { Hono } from "hono";
import { nanoid } from "nanoid";
import { createAgentSchema, createRingSchema } from "@pebble/protocol";
import type { Db } from "../db/migrate.js";
import type { GatewayConfig } from "../config.js";
import { authUserMiddleware, type AuthUser } from "../services/auth.js";
import { generateToken, hashToken } from "../services/crypto/token-hash.js";
import { decryptAppConfig, encryptAppConfig, publishNtfyReply } from "../services/ntfy.js";
import { publishPushoverReply } from "../services/pushover.js";

const ACCOUNT_LIMITS = {
  rings: 5,
  agents: 10,
  responseTargets: 5
} as const;

export function dashboardApiRoutes(db: Db, config: GatewayConfig): Hono {
  const app = new Hono();
  app.use("*", authUserMiddleware(db, config));

  app.get("/me", (c) => c.json({ user: c.get("user"), config: publicConfig(config) }));

  app.get("/metrics", (c) => {
    const user = c.get("user") as AuthUser;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const historyStart = new Date(today);
    historyStart.setDate(historyStart.getDate() - 14);
    const rows = db.prepare(`select event_type, status, delivery_latency_ms from activity_events where user_id = ? and created_at >= ?`)
      .all(user.id, today.toISOString()) as Array<{ event_type: string; status: string; delivery_latency_ms: number | null }>;
    const historyRows = db.prepare(`
      select substr(created_at, 1, 10) as day, count(*) as messages
      from activity_events
      where user_id = ?
        and created_at >= ?
        and event_type = 'ring.ingest'
      group by substr(created_at, 1, 10)
    `).all(user.id, historyStart.toISOString()) as Array<{ day: string; messages: number }>;
    const countsByDay = new Map(historyRows.map((row) => [row.day, row.messages]));
    const messageHistory = Array.from({ length: 15 }, (_, index) => {
      const day = new Date(historyStart);
      day.setDate(historyStart.getDate() + index);
      const key = day.toISOString().slice(0, 10);
      return { day: key, messages: countsByDay.get(key) ?? 0 };
    });
    const delivered = rows.filter((r) => r.event_type === "delivery.acked").length;
    const latencies = rows.map((r) => r.delivery_latency_ms).filter((v): v is number => typeof v === "number");
    const connectedAgents = db.prepare(`select count(*) as n from agent_connectors where user_id = ? and revoked_at is null and last_seen_at > ?`)
      .get(user.id, new Date(Date.now() - 5 * 60_000).toISOString()) as { n: number };
    return c.json({
      message_history: messageHistory,
      messages_received_today: rows.filter((r) => r.event_type === "delivery.created" || r.event_type === "ring.ingest").length,
      messages_delivered_today: delivered,
      messages_expired_today: rows.filter((r) => r.event_type === "delivery.expired").length,
      average_delivery_latency_ms: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
      connected_agents: connectedAgents.n,
      debug_mode: config.debugRetention
    });
  });

  app.get("/onboarding/status", (c) => {
    const user = c.get("user") as AuthUser;
    const connectedSince = new Date(Date.now() - 5 * 60_000).toISOString();
    const rings = db.prepare(`select count(*) as n from rings where user_id = ? and revoked_at is null`)
      .get(user.id) as { n: number };
    const agents = db.prepare(`select count(*) as n from agent_connectors where user_id = ? and revoked_at is null`)
      .get(user.id) as { n: number };
    const connectedAgents = db.prepare(`select count(*) as n from agent_connectors where user_id = ? and revoked_at is null and last_seen_at > ?`)
      .get(user.id, connectedSince) as { n: number };
    const ntfyTargets = db.prepare(`select count(*) as n from notification_targets where user_id = ? and kind = 'ntfy' and enabled = 1`)
      .get(user.id) as { n: number };
    const pushoverTargets = db.prepare(`select count(*) as n from pushover_targets where user_id = ? and enabled = 1`)
      .get(user.id) as { n: number };
    const latestRing = db.prepare(`
      select event_type, status, error_code, created_at
      from activity_events
      where user_id = ? and event_type = 'ring.ingest'
      order by created_at desc limit 1
    `).get(user.id) ?? null;
    const latestDelivery = db.prepare(`
      select event_type, status, target_kind, created_at
      from activity_events
      where user_id = ? and event_type = 'delivery.created'
      order by created_at desc limit 1
    `).get(user.id) ?? null;
    const latestAck = db.prepare(`
      select event_type, status, target_kind, delivery_latency_ms, created_at
      from activity_events
      where user_id = ? and event_type = 'delivery.acked'
      order by created_at desc limit 1
    `).get(user.id) ?? null;
    return c.json({
      rings: rings.n,
      agents: agents.n,
      connected_agents: connectedAgents.n,
      ntfy_targets: ntfyTargets.n,
      response_targets: ntfyTargets.n + pushoverTargets.n,
      latest_ring: latestRing,
      latest_delivery: latestDelivery,
      latest_ack: latestAck,
      debug_mode: config.debugRetention
    });
  });

  app.get("/activity", (c) => {
    const user = c.get("user") as AuthUser;
    const rows = db.prepare(`
      select activity_events.*, rings.name as ring_name, agent_connectors.name as agent_name
      from activity_events
      left join rings on rings.id = activity_events.ring_id and rings.user_id = activity_events.user_id
      left join agent_connectors on agent_connectors.id = activity_events.agent_id and agent_connectors.user_id = activity_events.user_id
      where activity_events.user_id = ?
      order by activity_events.created_at desc limit 100
    `).all(user.id);
    return c.json({ rows });
  });

  app.get("/responses", (c) => {
    const user = c.get("user") as AuthUser;
    const ntfyRows = db.prepare(`
      select id, label, encrypted_config_json, enabled, created_at, updated_at
      from notification_targets
      where user_id = ? and kind = 'ntfy'
      order by enabled desc, updated_at desc
    `).all(user.id) as Array<{ id: string; label: string; encrypted_config_json: string; enabled: number; created_at: string; updated_at: string }>;
    const pushoverRows = db.prepare(`
      select id, label, enabled, created_at, updated_at
      from pushover_targets
      where user_id = ?
      order by enabled desc, updated_at desc
    `).all(user.id) as Array<{ id: string; label: string; enabled: number; created_at: string; updated_at: string }>;
    return c.json({
      rows: [
        ...ntfyRows.map((row) => ({
        id: row.id,
        kind: "ntfy",
        label: row.label,
        url: decryptAppConfig<{ url: string }>(config, row.encrypted_config_json).url,
        enabled: row.enabled === 1,
        created_at: row.created_at,
        updated_at: row.updated_at
        })),
        ...pushoverRows.map((row) => ({
          id: row.id,
          kind: "pushover",
          label: row.label,
          url: "Pushover app",
          enabled: row.enabled === 1,
          created_at: row.created_at,
          updated_at: row.updated_at
        }))
      ]
    });
  });

  app.get("/rings", (c) => {
    const user = c.get("user") as AuthUser;
    const rows = db.prepare(`
      select
        rings.id,
        rings.name,
        rings.created_at,
        rings.revoked_at,
        max(ring_events.received_at) as last_message_received_at
      from rings
      left join ring_events on ring_events.ring_id = rings.id
      where rings.user_id = ?
      group by rings.id
      order by rings.created_at desc
    `).all(user.id);
    return c.json({ rows });
  });

  app.post("/rings", async (c) => {
    const user = c.get("user") as AuthUser;
    const count = db.prepare(`select count(*) as n from rings where user_id = ? and revoked_at is null`).get(user.id) as { n: number };
    if (count.n >= ACCOUNT_LIMITS.rings) return c.json({ ok: false, error: "ring_limit_reached" }, 409);
    const parsed = createRingSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ ok: false, error: "invalid_payload" }, 400);
    const token = generateToken("ri_live");
    const id = `ring_${nanoid(21)}`;
    db.prepare(`insert into rings (id, user_id, name, ingest_token_hash, created_at, revoked_at) values (?, ?, ?, ?, ?, null)`)
      .run(id, user.id, parsed.data.name, hashToken(token, config.tokenPepper), new Date().toISOString());
    return c.json({ ok: true, ring_id: id, ingest_token: token, webhook_url: `${config.publicBaseUrl}/api/ring/ingest` });
  });

  app.post("/rings/:id/revoke", (c) => {
    const user = c.get("user") as AuthUser;
    db.prepare(`update rings set revoked_at = ? where id = ? and user_id = ?`).run(new Date().toISOString(), c.req.param("id"), user.id);
    return c.json({ ok: true });
  });

  app.get("/agents", (c) => {
    const user = c.get("user") as AuthUser;
    const settings = db.prepare(`select default_agent_kind, double_action_agent_kind from user_settings where user_id = ?`).get(user.id) as {
      default_agent_kind: string | null;
      double_action_agent_kind: string | null;
    } | undefined;
    return c.json({
      default_agent_kind: settings?.default_agent_kind ?? "",
      double_action_agent_kind: settings?.double_action_agent_kind ?? "",
      rows: db.prepare(`
      select
        id,
        kind,
        name,
        encryption_public_key,
        case when encryption_public_key = '' then 'gateway-managed' else 'connector key' end as encryption,
        last_seen_at,
        created_at,
        revoked_at
      from agent_connectors
      where user_id = ?
      order by created_at desc
    `).all(user.id)
    });
  });

  app.post("/agents", async (c) => {
    const user = c.get("user") as AuthUser;
    const count = db.prepare(`select count(*) as n from agent_connectors where user_id = ? and revoked_at is null`).get(user.id) as { n: number };
    if (count.n >= ACCOUNT_LIMITS.agents) return c.json({ ok: false, error: "agent_limit_reached" }, 409);
    const parsed = createAgentSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ ok: false, error: "invalid_payload" }, 400);
    const token = generateToken("ag_live");
    const id = `agt_${nanoid(21)}`;
    db.prepare(`insert into agent_connectors (id, user_id, kind, name, token_hash, encryption_public_key, last_seen_at, created_at, revoked_at) values (?, ?, ?, ?, ?, ?, null, ?, null)`)
      .run(id, user.id, parsed.data.kind, parsed.data.name, hashToken(token, config.tokenPepper), parsed.data.encryption_public_key, new Date().toISOString());
    return c.json({ ok: true, agent_id: id, agent_token: token });
  });

  app.post("/agents/:id/revoke", (c) => {
    const user = c.get("user") as AuthUser;
    db.prepare(`update agent_connectors set revoked_at = ? where id = ? and user_id = ?`).run(new Date().toISOString(), c.req.param("id"), user.id);
    return c.json({ ok: true });
  });

  app.post("/settings", async (c) => {
    const user = c.get("user") as AuthUser;
    const body = await c.req.json<{ default_agent_kind?: string; double_action_agent_kind?: string; ntfy_url?: string; ntfy_label?: string; pushover_user_key?: string; pushover_api_token?: string; pushover_label?: string }>();
    if (!isAgentKindOrEmpty(body.default_agent_kind) || !isAgentKindOrEmpty(body.double_action_agent_kind)) {
      return c.json({ ok: false, error: "invalid_agent_kind" }, 400);
    }
    const hasPushoverUserKey = Boolean(body.pushover_user_key);
    const hasPushoverApiToken = Boolean(body.pushover_api_token);
    if (hasPushoverUserKey !== hasPushoverApiToken) {
      return c.json({ ok: false, error: "pushover_credentials_incomplete" }, 400);
    }
    if (body.ntfy_url && !isAllowedNtfyUrl(body.ntfy_url, config.ntfyAllowedHosts)) {
      return c.json({ ok: false, error: "ntfy_url_not_allowed" }, 400);
    }
    const requestedTargets = Number(Boolean(body.ntfy_url)) + Number(hasPushoverUserKey && hasPushoverApiToken);
    if (requestedTargets > 0) {
      const ntfyCount = db.prepare(`select count(*) as n from notification_targets where user_id = ? and enabled = 1`).get(user.id) as { n: number };
      const pushoverCount = db.prepare(`select count(*) as n from pushover_targets where user_id = ? and enabled = 1`).get(user.id) as { n: number };
      if (ntfyCount.n + pushoverCount.n + requestedTargets > ACCOUNT_LIMITS.responseTargets) {
        return c.json({ ok: false, error: "response_target_limit_reached" }, 409);
      }
    }
    if (body.default_agent_kind !== undefined || body.double_action_agent_kind !== undefined) {
      const current = db.prepare(`select default_agent_kind, double_action_agent_kind from user_settings where user_id = ?`)
        .get(user.id) as { default_agent_kind: string | null; double_action_agent_kind: string | null } | undefined;
      const defaultKind = body.default_agent_kind === undefined ? current?.default_agent_kind ?? null : body.default_agent_kind || null;
      const doubleKind = body.double_action_agent_kind === undefined ? current?.double_action_agent_kind ?? null : body.double_action_agent_kind || null;
      db.prepare(`insert into user_settings (user_id, default_agent_kind, double_action_agent_kind, updated_at) values (?, ?, ?, ?) on conflict(user_id) do update set default_agent_kind = excluded.default_agent_kind, double_action_agent_kind = excluded.double_action_agent_kind, updated_at = excluded.updated_at`)
        .run(user.id, defaultKind, doubleKind, new Date().toISOString());
    }
    if (body.ntfy_url) {
      db.prepare(`insert into notification_targets (id, user_id, kind, label, encrypted_config_json, enabled, created_at, updated_at) values (?, ?, 'ntfy', ?, ?, 1, ?, ?)`)
        .run(`ntfy_${nanoid(21)}`, user.id, body.ntfy_label ?? "ntfy", encryptAppConfig(config, { url: body.ntfy_url }), new Date().toISOString(), new Date().toISOString());
    }
    if (body.pushover_user_key && body.pushover_api_token) {
      db.prepare(`insert into pushover_targets (id, user_id, label, encrypted_config_json, enabled, created_at, updated_at) values (?, ?, ?, ?, 1, ?, ?)`)
        .run(`pushover_${nanoid(21)}`, user.id, body.pushover_label ?? "Pushover", encryptAppConfig(config, { userKey: body.pushover_user_key, apiToken: body.pushover_api_token }), new Date().toISOString(), new Date().toISOString());
    }
    return c.json({ ok: true });
  });

  app.post("/responses/:id/disable", (c) => {
    const user = c.get("user") as AuthUser;
    db.prepare(`update notification_targets set enabled = 0, updated_at = ? where id = ? and user_id = ? and kind = 'ntfy'`)
      .run(new Date().toISOString(), c.req.param("id"), user.id);
    db.prepare(`update pushover_targets set enabled = 0, updated_at = ? where id = ? and user_id = ?`)
      .run(new Date().toISOString(), c.req.param("id"), user.id);
    return c.json({ ok: true });
  });

  app.post("/ntfy/test", async (c) => {
    const user = c.get("user") as AuthUser;
    const target = db.prepare(`select count(*) as n from notification_targets where user_id = ? and kind = 'ntfy' and enabled = 1`)
      .get(user.id) as { n: number };
    if (target.n === 0) return c.json({ ok: false, error: "no_ntfy_target" }, 400);
    await publishNtfyReply(db, config, user.id, "Pebble Agent Gateway ntfy test: replies from local agents will appear here.");
    return c.json({ ok: true });
  });

  app.post("/pushover/test", async (c) => {
    const user = c.get("user") as AuthUser;
    const target = db.prepare(`select count(*) as n from pushover_targets where user_id = ? and enabled = 1`)
      .get(user.id) as { n: number };
    if (target.n === 0) return c.json({ ok: false, error: "no_pushover_target" }, 400);
    await publishPushoverReply(db, config, user.id, "Pebble Agent Gateway is connected. Agent replies will appear here.");
    return c.json({ ok: true });
  });

  return app;
}

function publicConfig(config: GatewayConfig) {
  return {
    publicBaseUrl: config.publicBaseUrl,
    messageTtlMinutes: config.messageTtlMinutes,
    deletePayloadOnClaim: config.deletePayloadOnClaim,
    debugRetention: config.debugRetention,
    signupsEnabled: config.signupsEnabled,
    ntfyEnabled: config.ntfyEnabled
  };
}

function isAllowedNtfyUrl(value: string, allowedHosts: string[]): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && allowedHosts.includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function isAgentKindOrEmpty(value: string | undefined): boolean {
  return value === undefined || value === "" || ["codex", "claude", "openclaw", "cli"].includes(value);
}
