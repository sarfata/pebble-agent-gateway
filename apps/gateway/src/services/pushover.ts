import type { Db } from "../db/migrate.js";
import type { GatewayConfig } from "../config.js";
import { decryptAppConfig } from "./ntfy.js";

type PushoverConfig = {
  userKey: string;
  apiToken: string;
};

export async function publishPushoverReply(
  db: Db,
  config: GatewayConfig,
  userId: string,
  text: string,
  status = "completed"
): Promise<void> {
  const targets = db.prepare(`select encrypted_config_json from pushover_targets where user_id = ? and enabled = 1`)
    .all(userId) as Array<{ encrypted_config_json: string }>;
  for (const target of targets) {
    const pushover = decryptAppConfig<PushoverConfig>(config, target.encrypted_config_json);
    const failed = status !== "completed";
    const body = new URLSearchParams({
      token: pushover.apiToken,
      user: pushover.userKey,
      title: failed ? "Pebble agent failed" : "Pebble agent reply",
      message: text,
      priority: failed ? "2" : "0"
    });
    if (failed) {
      body.set("retry", "60");
      body.set("expire", "3600");
    }
    const response = await fetch("https://api.pushover.net/1/messages.json", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    if (!response.ok) throw new Error(`Pushover returned HTTP ${response.status}`);
  }
}
