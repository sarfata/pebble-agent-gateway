export const ENVELOPE_ALG = "x25519-hkdf-sha256-aes-256-gcm" as const;

export type EncryptedPayloadEnvelope = {
  v: 1;
  alg: typeof ENVELOPE_ALG;
  recipient_public_key: string;
  ephemeral_public_key: string;
  nonce: string;
  ciphertext: string;
};

export type PlaintextDeliveryPayload = {
  message_id: string;
  ring_id: string;
  source_message_id: string;
  recorded_at: string;
  transcript: string;
  audio: null | {
    url?: string;
    bytes?: number;
  };
  metadata: Record<string, unknown>;
};
