import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { GatewayConfig } from "../../config.js";

export const APP_PAYLOAD_ALG = "app-key-aes-256-gcm" as const;

export type AppEncryptedPayloadEnvelope = {
  v: 1;
  alg: typeof APP_PAYLOAD_ALG;
  nonce: string;
  ciphertext: string;
};

function key(config: GatewayConfig): Buffer {
  return createHash("sha256").update(config.appEncryptionKey).digest();
}

export function encryptAppPayload(config: GatewayConfig, plaintext: unknown): AppEncryptedPayloadEnvelope {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(config), nonce);
  const body = Buffer.from(JSON.stringify(plaintext), "utf8");
  const ciphertext = Buffer.concat([cipher.update(body), cipher.final(), cipher.getAuthTag()]);
  return {
    v: 1,
    alg: APP_PAYLOAD_ALG,
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url")
  };
}

export function decryptAppPayload<T>(config: GatewayConfig, envelope: AppEncryptedPayloadEnvelope): T {
  if (envelope.alg !== APP_PAYLOAD_ALG) throw new Error(`unsupported app payload alg ${envelope.alg}`);
  const bytes = Buffer.from(envelope.ciphertext, "base64url");
  const encrypted = bytes.subarray(0, -16);
  const tag = bytes.subarray(-16);
  const decipher = createDecipheriv("aes-256-gcm", key(config), Buffer.from(envelope.nonce, "base64url"));
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8")) as T;
}
