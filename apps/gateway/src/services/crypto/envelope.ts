import { createCipheriv, createDecipheriv, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import { ENVELOPE_ALG, type EncryptedPayloadEnvelope } from "@pebble/protocol";
import { importPrivateKey, importPublicKey } from "./agent-keys.js";

function deriveKey(sharedSecret: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", sharedSecret, Buffer.alloc(0), Buffer.from("pebble-agent-gateway:v1"), 32));
}

export function encryptEnvelope(plaintext: unknown, recipientPublicKey: string): EncryptedPayloadEnvelope {
  const recipient = importPublicKey(recipientPublicKey);
  const ephemeral = generateKeyPairSync("x25519");
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
  const key = deriveKey(shared);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.from(JSON.stringify(plaintext), "utf8");
  const ciphertext = Buffer.concat([cipher.update(body), cipher.final(), cipher.getAuthTag()]);
  return {
    v: 1,
    alg: ENVELOPE_ALG,
    recipient_public_key: recipientPublicKey,
    ephemeral_public_key: ephemeral.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url")
  };
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
