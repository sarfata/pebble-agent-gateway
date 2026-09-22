import { afterEach, describe, expect, it, vi } from "vitest";
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
  delete process.env.PEBBLE_CLAUDE_COMMAND;
  delete process.env.PEBBLE_CLAUDE_ARGS_JSON;
  delete process.env.PEBBLE_OPENCLAW_COMMAND;
  delete process.env.PEBBLE_OPENCLAW_ARGS_JSON;
  delete process.env.PEBBLE_AGENT_TIMEOUT_MS;
  delete process.env.GROKBOT_WEBHOOK_URL;
  delete process.env.GROKBOT_WEBHOOK_TOKEN;
  delete process.env.GROKBOT_PAYLOAD_KEY;
  delete process.env.GROKBOT_TIMEOUT_MS;
  vi.restoreAllMocks();
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

describe("Claude channel", () => {
  it("invokes the configured Claude command with transcript and trigger placeholders", async () => {
    process.env.PEBBLE_CLAUDE_COMMAND = process.execPath;
    process.env.PEBBLE_CLAUDE_ARGS_JSON = JSON.stringify(["-e", "process.stdout.write(process.argv[1])", "{{prompt}}"]);
    const result = await runAgent("claude", { ...payload, trigger: "double-click-hold" }, {
      promptTemplate: "heard={{transcript}} trigger={{trigger}}",
      channel: "oneshot"
    });
    expect(result).toBe("heard=test trigger=double-click-hold");
  });
});

describe("GrokBot webhook relay", () => {
  it("POSTs the rendered prompt as JSON with a bearer token and returns the response body", async () => {
    process.env.GROKBOT_WEBHOOK_URL = "https://grokbot.example.com/hook";
    process.env.GROKBOT_WEBHOOK_TOKEN = "secret-token";
    process.env.GROKBOT_PAYLOAD_KEY = "message";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Grok says hi", { status: 200 }));
    const result = await runAgent("grokbot", payload, {
      promptTemplate: "heard={{transcript}}",
      channel: "oneshot"
    });
    expect(result).toBe("Grok says hi");
    expect(fetchMock).toHaveBeenCalledWith("https://grokbot.example.com/hook", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        "Content-Type": "application/json",
        Authorization: "Bearer secret-token"
      }),
      body: JSON.stringify({ message: "heard=test" })
    }));
  });

  it("falls back to a confirmation message when the webhook returns an empty body", async () => {
    process.env.GROKBOT_WEBHOOK_URL = "https://grokbot.example.com/hook";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 202 }));
    const result = await runAgent("grokbot", payload, { promptTemplate: "{{transcript}}", channel: "oneshot" });
    expect(result).toBe("Sent to GrokBot (HTTP 202).");
  });

  it("throws a clear error when GROKBOT_WEBHOOK_URL is not configured", async () => {
    await expect(runAgent("grokbot", payload, { promptTemplate: "{{transcript}}", channel: "oneshot" }))
      .rejects.toThrow("GROKBOT_WEBHOOK_URL is not set");
  });

  it("throws with the response body when the webhook returns a non-2xx status", async () => {
    process.env.GROKBOT_WEBHOOK_URL = "https://grokbot.example.com/hook";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad request", { status: 400 }));
    await expect(runAgent("grokbot", payload, { promptTemplate: "{{transcript}}", channel: "oneshot" }))
      .rejects.toThrow("GrokBot webhook returned HTTP 400: bad request");
  });
});
