#!/usr/bin/env node
import { Command } from "commander";
import type { PlaintextDeliveryPayload } from "@pebble/protocol";
import { PebbleGatewayClient, connectDeliveryEvents } from "@pebble/connector-core";
import { ensureKeypair, loadConfig, saveConfig } from "./keypair.js";
import { commandHelp, runAgent, type AgentMode } from "./agent-runner.js";
import { decryptEnvelope } from "./crypto.js";

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
  .option("--reply <text>")
  .description("Connect to SSE, claim deliveries, decrypt, run the selected local agent, ack, and optionally reply")
  .action((options: { agent: AgentMode; server?: string; token?: string; reply?: string }) => {
    const config = options.server && options.token
      ? { server: options.server.replace(/\/$/, ""), token: options.token }
      : loadConfig();
    const client = new PebbleGatewayClient(config.server, config.token);
    if (!["print", "codex", "claude", "openclaw"].includes(options.agent)) {
      throw new Error("--agent must be print, codex, claude, or openclaw");
    }
    console.log("Connected to Pebble Agent Gateway");
    console.log(`Agent mode: ${options.agent}`);
    console.log(`Runner: ${commandHelp(options.agent)}`);
    console.log("Waiting for messages...");
    connectDeliveryEvents(config.server, config.token, async (event) => {
      try {
        const claimed = await client.claim(event.delivery_id);
        const payload = claimed.payload ?? decryptEnvelope<PlaintextDeliveryPayload>(claimed.encrypted_payload, ensureKeypair().privateKey);
        console.log(`\n[${payload.recorded_at}] ${payload.transcript}`);
        const result = await runAgent(options.agent, payload);
        if (result) console.log(result);
        await client.ack(event.delivery_id);
        console.log(`Acked delivery ${event.delivery_id}`);
        if (options.reply) await client.reply(event.event_id, event.delivery_id, options.reply);
      } catch (error) {
        console.error(`Failed delivery ${event.delivery_id}:`, error);
      }
    });
  });

program.parse();
