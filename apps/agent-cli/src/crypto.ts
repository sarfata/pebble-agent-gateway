import { createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, type KeyObject } from "node:crypto";
import { ENVELOPE_ALG, type EncryptedPayloadEnvelope } from "./protocol.js";

export type AgentKeypair = {
  publicKey: string;
  privateKey: string;
};

export function generateAgentKeypair(): AgentKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url")
  };
}

function importPublicKey(publicKey: string): KeyObject {
  return createPublicKey({ key: Buffer.from(publicKey, "base64url"), type: "spki", format: "der" });
}

function importPrivateKey(privateKey: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(privateKey, "base64url"), type: "pkcs8", format: "der" });
}

function deriveKey(sharedSecret: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", sharedSecret, Buffer.alloc(0), Buffer.from("pebble-agent-gateway:v1"), 32));
}

export function decryptEnvelope<T>(envelope: EncryptedPayloadEnvelope, privateKey: string): T {
  if (envelope.alg !== ENVELOPE_ALG) throw new Error(`unsupported envelope alg ${envelope.alg}`);
  const shared = diffieHellman({
    privateKey: importPrivateKey(privateKey),
    publicKey: importPublicKey(envelope.ephemeral_public_key)
  });
  const key = deriveKey(shared);
  const bytes = Buffer.from(envelope.ciphertext, "base64url");
  const encrypted = bytes.subarray(0, -16);
  const tag = bytes.subarray(-16);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64url"));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}
