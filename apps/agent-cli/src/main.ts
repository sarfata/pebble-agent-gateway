#!/usr/bin/env node
import { Command } from "commander";
import type { PlaintextDeliveryPayload } from "@pebble/protocol";
import { PebbleGatewayClient, connectDeliveryEvents } from "@pebble/connector-core";
import { decryptEnvelope } from "@pebble/gateway/services/crypto/envelope";
import { ensureKeypair, loadConfig, saveConfig } from "./keypair.js";

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
  .description("Store gateway connection settings and generate a local encryption keypair")
  .action((options: { server: string; token: string }) => {
    const keypair = ensureKeypair();
    saveConfig({ server: options.server.replace(/\/$/, ""), token: options.token });
    console.log("Saved Pebble Agent Gateway config");
    console.log(`Public encryption key: ${keypair.publicKey}`);
    console.log("Register this public key when creating the connector in the dashboard.");
  });

program.command("listen")
  .option("--reply <text>")
  .description("Connect to SSE, claim deliveries, decrypt, print, ack, and optionally reply")
  .action((options: { reply?: string }) => {
    const config = loadConfig();
    const keypair = ensureKeypair();
    const client = new PebbleGatewayClient(config.server, config.token);
    console.log("Connected to Pebble Agent Gateway");
    console.log("Waiting for messages...");
    connectDeliveryEvents(config.server, config.token, async (event) => {
      try {
        const envelope = await client.claim(event.delivery_id);
        const payload = decryptEnvelope<PlaintextDeliveryPayload>(envelope, keypair.privateKey);
        console.log(`\n[${payload.recorded_at}] ${payload.transcript}`);
        await client.ack(event.delivery_id);
        console.log(`Acked delivery ${event.delivery_id}`);
        if (options.reply) await client.reply(event.event_id, event.delivery_id, options.reply);
      } catch (error) {
        console.error(`Failed delivery ${event.delivery_id}:`, error);
      }
    });
  });

program.parse();
