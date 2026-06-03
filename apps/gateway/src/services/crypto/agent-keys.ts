import { createPrivateKey, createPublicKey, generateKeyPairSync, KeyObject } from "node:crypto";

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

export function importPublicKey(publicKey: string): KeyObject {
  return createPublicKey({ key: Buffer.from(publicKey, "base64url"), type: "spki", format: "der" });
}

export function importPrivateKey(privateKey: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(privateKey, "base64url"), type: "pkcs8", format: "der" });
}
