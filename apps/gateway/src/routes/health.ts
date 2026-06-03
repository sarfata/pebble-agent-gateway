import { Hono } from "hono";

export function healthRoutes(isDraining: () => boolean): Hono {
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ ok: !isDraining(), draining: isDraining() }, isDraining() ? 503 : 200));
  app.get("/readyz", (c) => c.json({ ok: !isDraining() }, isDraining() ? 503 : 200));
  return app;
}
