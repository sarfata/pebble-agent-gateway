import { describe, expect, it } from "vitest";
import { generateAgentKeypair } from "../src/services/crypto/agent-keys.js";
import { decryptEnvelope, encryptEnvelope } from "../src/services/crypto/envelope.js";
import { generateToken, hashToken } from "../src/services/crypto/token-hash.js";

describe("crypto", () => {
  it("generates and hashes opaque tokens", () => {
    const token = generateToken("ri_live");
    expect(token.startsWith("ri_live_")).toBe(true);
    expect(hashToken(token, "pepper")).toHaveLength(64);
    expect(hashToken(token, "pepper")).toBe(hashToken(token, "pepper"));
  });

  it("encrypts and decrypts payloads for an agent keypair", () => {
    const keypair = generateAgentKeypair();
    const envelope = encryptEnvelope({ transcript: "Codex, fix the failing auth test" }, keypair.publicKey);
    expect(JSON.stringify(envelope)).not.toContain("failing auth test");
    expect(decryptEnvelope<{ transcript: string }>(envelope, keypair.privateKey).transcript).toBe("Codex, fix the failing auth test");
  });

  it("fails decryption with the wrong private key", () => {
    const recipient = generateAgentKeypair();
    const wrong = generateAgentKeypair();
    const envelope = encryptEnvelope({ transcript: "secret" }, recipient.publicKey);
    expect(() => decryptEnvelope(envelope, wrong.privateKey)).toThrow();
  });
});
