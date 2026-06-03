import { z } from "zod";

export const ringIngestSchema = z.object({
  message_id: z.string().min(1).max(256),
  recorded_at: z.string().datetime(),
  transcript: z.string().min(1).max(8000),
  audio_url: z.string().url().nullable().optional(),
  metadata: z.record(z.unknown()).default({})
});

export const ackSchema = z.object({
  status: z.enum(["processed", "failed"]).default("processed")
});

export const replySchema = z.object({
  event_id: z.string().min(1),
  delivery_id: z.number().int().positive(),
  text: z.string().min(1).max(4000),
  status: z.string().min(1).max(64).default("completed")
});

export const createAgentSchema = z.object({
  kind: z.enum(["openclaw", "claude", "codex", "cli"]),
  name: z.string().min(1).max(128),
  encryption_public_key: z.string().max(4096).optional().default("")
});

export const createRingSchema = z.object({
  name: z.string().min(1).max(128)
});

export type RingIngestRequest = z.infer<typeof ringIngestSchema>;
export type AckRequest = z.infer<typeof ackSchema>;
export type ReplyRequest = z.infer<typeof replySchema>;
