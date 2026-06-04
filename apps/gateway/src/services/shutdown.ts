import type { Db } from "../db/migrate.js";
import { checkpoint } from "../db/migrate.js";
import type { GatewayConfig } from "../config.js";
import { expirePendingDeliveries } from "./queue/expire.js";
import type { DeliveryStreamHub } from "./queue/stream.js";

export class ShutdownManager {
  private draining = false;

  constructor(
    private readonly server: { close(callback?: (err?: Error) => void): unknown },
    private readonly db: Db,
    private readonly config: GatewayConfig,
    private readonly hub: DeliveryStreamHub
  ) {}

  isDraining(): boolean {
    return this.draining;
  }

  install(): void {
    const handler = () => void this.shutdown();
    process.once("SIGTERM", handler);
    process.once("SIGINT", handler);
  }

  async shutdown(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    this.hub.markDraining();
    this.server.close(() => {
      void (async () => {
      try {
        await expirePendingDeliveries(this.db, this.config);
        checkpoint(this.db);
        this.db.close();
      } finally {
        process.exit(0);
      }
      })();
    });
  }
}
