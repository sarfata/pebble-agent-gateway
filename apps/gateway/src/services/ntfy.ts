import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import type { Db } from "../db/migrate.js";
import type { GatewayConfig } from "../config.js";

function key(config: GatewayConfig): Buffer {
  return createHash("sha256").update(config.appEncryptionKey).digest();
}

export function encryptAppConfig(config: GatewayConfig, value: unknown): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(config), nonce);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return JSON.stringify({
    nonce: nonce.toString("base64url"),
    ciphertext: Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64url")
  });
}

export function decryptAppConfig<T>(config: GatewayConfig, encryptedJson: string): T {
  const parsed = JSON.parse(encryptedJson) as { nonce: string; ciphertext: string };
  const bytes = Buffer.from(parsed.ciphertext, "base64url");
  const encrypted = bytes.subarray(0, -16);
  const tag = bytes.subarray(-16);
  const decipher = createDecipheriv("aes-256-gcm", key(config), Buffer.from(parsed.nonce, "base64url"));
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8")) as T;
}

export async function publishNtfyReply(db: Db, config: GatewayConfig, userId: string, text: string): Promise<void> {
  if (!config.ntfyEnabled) return;
  const targets = db.prepare(`select encrypted_config_json from notification_targets where user_id = ? and kind = 'ntfy' and enabled = 1`)
    .all(userId) as Array<{ encrypted_config_json: string }>;
  for (const target of targets) {
    const ntfy = decryptAppConfig<{ url: string }>(config, target.encrypted_config_json);
    await fetch(ntfy.url, {
      method: "POST",
      headers: {
        Title: "Pebble agent reply",
        Tags: "robot"
      },
      body: text
    });
  }
}
