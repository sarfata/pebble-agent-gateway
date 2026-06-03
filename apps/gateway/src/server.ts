import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { openDb } from "./db/migrate.js";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { ringIngestRoutes } from "./routes/ring-ingest.js";
import { agentEventsRoutes } from "./routes/agent-events.js";
import { agentDeliveryRoutes } from "./routes/agent-claim.js";
import { agentRepliesRoutes } from "./routes/agent-replies.js";
import { provisionRoutes } from "./routes/provision.js";
import { dashboardApiRoutes } from "./routes/dashboard-api.js";
import { DeliveryStreamHub } from "./services/queue/stream.js";
import { expirePendingDeliveries } from "./services/queue/expire.js";
import { ShutdownManager } from "./services/shutdown.js";

export function createApp() {
  const webRoot = fileURLToPath(new URL("../dist-web", import.meta.url));
  const webIndex = fileURLToPath(new URL("../dist-web/index.html", import.meta.url));
  const config = loadConfig();
  const db = openDb(config.databaseUrl);
  expirePendingDeliveries(db);
  const hub = new DeliveryStreamHub();
  let draining = false;
  const app = new Hono();

  app.route("/", healthRoutes(() => draining));
  app.route("/api/auth", authRoutes(db, config));
  app.route("/api/ring", ringIngestRoutes(db, config, hub, () => draining));
  app.route("/api/agent", agentEventsRoutes(db, config, hub));
  app.route("/api/agent", agentDeliveryRoutes(db, config, () => draining));
  app.route("/api/agent", agentRepliesRoutes(db, config));
  app.route("/api/provision", provisionRoutes(db, config));
  app.route("/api/dashboard", dashboardApiRoutes(db, config));
  app.use("/assets/*", serveStatic({ root: webRoot }));
  app.get("*", serveStatic({ path: webIndex }));

  const expirationInterval = setInterval(() => expirePendingDeliveries(db), 60_000);
  return {
    app,
    config,
    db,
    hub,
    setDraining(value: boolean) {
      draining = value;
      if (value) hub.markDraining();
    },
    close() {
      clearInterval(expirationInterval);
      db.close();
    }
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const runtime = createApp();
  const server = serve({ fetch: runtime.app.fetch, port: runtime.config.port }, ({ port }) => {
    console.log(`Pebble Agent Gateway listening on http://localhost:${port}`);
  });
  const shutdown = new ShutdownManager(server, runtime.db, runtime.hub);
  shutdown.install();
}
