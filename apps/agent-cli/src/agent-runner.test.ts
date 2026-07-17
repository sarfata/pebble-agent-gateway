import { afterEach, describe, expect, it } from "vitest";
import { formatDuration, runAgent } from "./agent-runner.js";
import type { PlaintextDeliveryPayload } from "./protocol.js";

const payload: PlaintextDeliveryPayload = {
  message_id: "message-1",
  source_message_id: "source-1",
  ring_id: "ring-1",
  recorded_at: "2026-07-16T00:00:00.000Z",
  transcript: "test",
  audio: null,
  metadata: {}
};

afterEach(() => {
  delete process.env.PEBBLE_OPENCLAW_COMMAND;
  delete process.env.PEBBLE_OPENCLAW_ARGS_JSON;
  delete process.env.PEBBLE_AGENT_TIMEOUT_MS;
});

describe("agent timeout", () => {
  it("formats durations for people rather than exposing milliseconds", () => {
    expect(formatDuration(120_000)).toBe("2 minutes");
    expect(formatDuration(60_000)).toBe("1 minute");
    expect(formatDuration(5_000)).toBe("5 seconds");
  });

  it("explains that the Ring message arrived when the agent response times out", async () => {
    process.env.PEBBLE_OPENCLAW_COMMAND = process.execPath;
    process.env.PEBBLE_OPENCLAW_ARGS_JSON = JSON.stringify(["-e", "setTimeout(() => {}, 1000)"]);
    process.env.PEBBLE_AGENT_TIMEOUT_MS = "20";

    await expect(runAgent("openclaw", payload, {
      promptTemplate: "{{transcript}}",
      channel: "oneshot"
    })).rejects.toThrow("Your Ring message was received, but node did not finish responding within 20 milliseconds.");
  });
});
