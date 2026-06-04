import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { generateAgentKeypair } from "./crypto.js";

export const configDir = join(homedir(), ".config", "pebble-agent-gateway");
export const configPath = join(configDir, "config.json");
export const cursorPath = join(configDir, "cursor.json");
export const keyPath = join(configDir, "agent-key.json");
export const conversationPath = join(configDir, "conversation.json");

export type CliConfig = {
  server: string;
  token: string;
};

export function ensureKeypair() {
  mkdirSync(dirname(keyPath), { recursive: true });
  if (existsSync(keyPath)) return JSON.parse(readFileSync(keyPath, "utf8")) as ReturnType<typeof generateAgentKeypair>;
  const keypair = generateAgentKeypair();
  writeFileSync(keyPath, JSON.stringify(keypair, null, 2));
  chmodSync(keyPath, 0o600);
  return keypair;
}

export function saveConfig(config: CliConfig): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  chmodSync(configPath, 0o600);
}

export function loadConfig(): CliConfig {
  return JSON.parse(readFileSync(configPath, "utf8")) as CliConfig;
}
