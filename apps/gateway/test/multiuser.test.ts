import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/migrate.js";
import { authRoutes } from "../src/routes/auth.js";
import { dashboardApiRoutes } from "../src/routes/dashboard-api.js";

function testApp() {
  const db = openDb(":memory:");
  const config = loadConfig({
    DATABASE_URL: "file::memory:",
    PUBLIC_BASE_URL: "https://gateway.example.com",
    SESSION_SECRET: "session-secret",
    TOKEN_PEPPER: "token-pepper",
    APP_ENCRYPTION_KEY: "encryption-key",
    SIGNUPS_ENABLED: "true"
  });
  const app = new Hono()
    .route("/api/auth", authRoutes(db, config))
    .route("/api/dashboard", dashboardApiRoutes(db, config));
  return { app, db };
}

async function signup(app: Hono, email: string): Promise<string> {
  const response = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse-battery-staple" })
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie");
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("Secure");
  return cookie!.split(";")[0];
}

describe("multi-user account isolation", () => {
  it("scopes dashboard resources and prevents cross-account revocation", async () => {
    const { app, db } = testApp();
    const ownerCookie = await signup(app, " Owner@Example.com ");
    const memberCookie = await signup(app, "member@example.com");

    const ownerMe = await app.request("/api/dashboard/me", { headers: { Cookie: ownerCookie } });
    const memberMe = await app.request("/api/dashboard/me", { headers: { Cookie: memberCookie } });
    expect((await ownerMe.json() as any).user.role).toBe("admin");
    expect((await memberMe.json() as any).user.role).toBe("user");
    expect(db.prepare(`select email from users where role = 'admin'`).get()).toEqual({ email: "owner@example.com" });

    const ownerCreate = await app.request("/api/dashboard/rings", {
      method: "POST",
      headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Owner ring" })
    });
    const ownerRingId = (await ownerCreate.json() as any).ring_id as string;
    await app.request("/api/dashboard/rings", {
      method: "POST",
      headers: { Cookie: memberCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Member ring" })
    });

    await app.request(`/api/dashboard/rings/${ownerRingId}/revoke`, {
      method: "POST",
      headers: { Cookie: memberCookie }
    });
    const ownerRings = await app.request("/api/dashboard/rings", { headers: { Cookie: ownerCookie } });
    const memberRings = await app.request("/api/dashboard/rings", { headers: { Cookie: memberCookie } });
    expect((await ownerRings.json() as any).rows.map((row: any) => row.name)).toEqual(["Owner ring"]);
    expect((await memberRings.json() as any).rows.map((row: any) => row.name)).toEqual(["Member ring"]);
    expect(db.prepare(`select revoked_at from rings where id = ?`).get(ownerRingId)).toEqual({ revoked_at: null });
  });

  it("invalidates the server-side session on logout", async () => {
    const { app, db } = testApp();
    const cookie = await signup(app, "person@example.com");
    expect((db.prepare(`select count(*) as n from sessions`).get() as { n: number }).n).toBe(1);

    const logout = await app.request("/api/auth/logout", { method: "POST", headers: { Cookie: cookie } });
    expect(logout.headers.get("set-cookie")).toContain("Secure");
    expect((db.prepare(`select count(*) as n from sessions`).get() as { n: number }).n).toBe(0);
    expect((await app.request("/api/dashboard/me", { headers: { Cookie: cookie } })).status).toBe(401);
  });
});
