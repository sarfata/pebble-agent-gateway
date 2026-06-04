#!/usr/bin/env node
import { Command } from "commander";
import { ensureKeypair, loadConfig, saveConfig } from "./keypair.js";
import { commandHelp, defaultPromptTemplate, runAgent, type AgentChannel, type AgentMode } from "./agent-runner.js";
import { decryptEnvelope } from "./crypto.js";
import { PebbleGatewayClient } from "./client.js";
import { connectDeliveryEvents } from "./sse.js";
import type { PlaintextDeliveryPayload } from "./protocol.js";

const program = new Command();

program
  .name("pebble-agent-cli")
  .description("Proof-of-life connector for Pebble Agent Gateway")
  .version("0.1.0");

program.command("keygen")
  .description("Generate or print the local connector encryption public key")
  .action(() => {
    const keypair = ensureKeypair();
    console.log(keypair.publicKey);
  });

program.command("login")
  .requiredOption("--server <url>")
  .requiredOption("--token <token>")
  .description("Store gateway connection settings")
  .action((options: { server: string; token: string }) => {
    saveConfig({ server: options.server.replace(/\/$/, ""), token: options.token });
    console.log("Saved Pebble Agent Gateway config");
    console.log("Run keygen separately if you want connector-side encryption.");
  });

program.command("listen")
  .option("--agent <mode>", "print, codex, claude, or openclaw", "print")
  .option("--server <url>", "Gateway base URL. If omitted, the saved config is used.")
  .option("--token <token>", "Agent token. If omitted, the saved config is used.")
  .option("-p, --prompt <template>", "Prompt template passed to the local agent. Supports {{transcript}}, {{recorded_at}}, {{event_id}}, {{ring_id}}, and {{source_message_id}}.", defaultPromptTemplate)
  .option("--channel <mode>", "oneshot or local-context", "oneshot")
  .option("--reply <text>", "Send this fixed reply instead of the local agent output.")
  .option("--no-send-reply", "Do not send replies back through the gateway.")
  .description("Connect to SSE, claim deliveries, decrypt, run the selected local agent, ack, and send the agent answer back")
  .action(async (options: { agent: AgentMode; server?: string; token?: string; prompt: string; channel: AgentChannel; reply?: string; sendReply: boolean }) => {
    const config = options.server && options.token
      ? { server: options.server.replace(/\/$/, ""), token: options.token }
      : loadConfig();
    const client = new PebbleGatewayClient(config.server, config.token);
    if (!["print", "codex", "claude", "openclaw"].includes(options.agent)) {
      throw new Error("--agent must be print, codex, claude, or openclaw");
    }
    if (!["oneshot", "local-context"].includes(options.channel)) {
      throw new Error("--channel must be oneshot or local-context");
    }
    console.log("Connected to Pebble Agent Gateway");
    console.log(`Agent mode: ${options.agent}`);
    console.log(`Channel: ${options.channel}`);
    console.log(`Runner: ${commandHelp(options.agent)}`);
    if (options.sendReply) console.log("Replies: agent output is sent back through the gateway");
    console.log("Waiting for messages...");
    const source = connectDeliveryEvents(config.server, config.token, async (event) => {
      let claimed = false;
      try {
        const delivery = await client.claim(event.delivery_id);
        claimed = true;
        const payload = delivery.payload ?? decryptEnvelope<PlaintextDeliveryPayload>(delivery.encrypted_payload, ensureKeypair().privateKey);
        console.log(`\n[${payload.recorded_at}] ${payload.transcript}`);
        const result = await runAgent(options.agent, payload, { promptTemplate: options.prompt, channel: options.channel });
        if (result) console.log(result);
        await client.ack(event.delivery_id);
        console.log(`Acked delivery ${event.delivery_id}`);
        const replyText = replyForDelivery(options, result, event.delivery_id);
        if (replyText) {
          await client.reply(event.event_id, event.delivery_id, replyText);
          console.log(`Sent reply for delivery ${event.delivery_id}`);
        }
      } catch (error) {
        console.error(`Failed delivery ${event.delivery_id}:`, error);
        const message = error instanceof Error ? error.message : String(error);
        if (options.sendReply) {
          try {
            await client.reply(event.event_id, event.delivery_id, `Pebble agent error: ${message}`, "failed");
            console.log(`Sent error reply for delivery ${event.delivery_id}`);
          } catch (replyError) {
            console.error(`Failed to send error reply for delivery ${event.delivery_id}:`, replyError);
          }
        }
        if (claimed) {
          try {
            await client.ack(event.delivery_id, "failed");
            console.log(`Acked failed delivery ${event.delivery_id}`);
          } catch (ackError) {
            console.error(`Failed to ack failed delivery ${event.delivery_id}:`, ackError);
          }
        }
      }
    });
    await keepListeningUntilShutdown(source);
  });

program.parse();

async function keepListeningUntilShutdown(source: { close: () => void }): Promise<void> {
  await new Promise<void>((resolve) => {
    const interval = setInterval(() => undefined, 60_000);
    const shutdown = () => {
      clearInterval(interval);
      source.close();
      resolve();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

function replyForDelivery(options: { agent: AgentMode; reply?: string; sendReply: boolean }, result: string, deliveryId: number): string | null {
  if (!options.sendReply) return null;
  if (options.reply) return options.reply;
  if (options.agent === "print") return `Pebble Agent Gateway received and acked delivery ${deliveryId}.`;
  return result.trim() || `${options.agent} completed delivery ${deliveryId}.`;
}
