import { spawn } from "node:child_process";
import type { PlaintextDeliveryPayload } from "@pebble/protocol";

export type AgentMode = "print" | "codex" | "claude" | "openclaw";

type AgentCommand = {
  command: string;
  args: string[];
};

const defaults: Record<Exclude<AgentMode, "print">, AgentCommand> = {
  codex: { command: "codex", args: ["exec", "{{transcript}}"] },
  claude: { command: "claude", args: ["-p", "{{transcript}}"] },
  openclaw: { command: "openclaw", args: ["run", "{{transcript}}"] }
};

export async function runAgent(mode: AgentMode, payload: PlaintextDeliveryPayload): Promise<string> {
  if (mode === "print") return payload.transcript;
  const configured = commandFromEnv(mode) ?? defaults[mode];
  return runCommand(configured, payload);
}

export function commandHelp(mode: AgentMode): string {
  if (mode === "print") return "Prints the transcript, acks it, and sends no local agent command.";
  const command = defaults[mode];
  return `${command.command} ${command.args.join(" ")}`;
}

function commandFromEnv(mode: Exclude<AgentMode, "print">): AgentCommand | null {
  const upper = mode.toUpperCase();
  const command = process.env[`PEBBLE_${upper}_COMMAND`];
  const argsJson = process.env[`PEBBLE_${upper}_ARGS_JSON`];
  if (!command) return null;
  if (!argsJson) return { command, args: ["{{transcript}}"] };
  const parsed = JSON.parse(argsJson) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error(`PEBBLE_${upper}_ARGS_JSON must be a JSON string array`);
  }
  return { command, args: parsed };
}

function runCommand(configured: AgentCommand, payload: PlaintextDeliveryPayload): Promise<string> {
  const args = configured.args.map((arg) => renderArg(arg, payload));
  return new Promise((resolve, reject) => {
    const child = spawn(configured.command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const output = Buffer.concat(stdout).toString("utf8").trim();
      const error = Buffer.concat(stderr).toString("utf8").trim();
      if (code === 0) return resolve(output || `${configured.command} completed`);
      reject(new Error(error || `${configured.command} exited with code ${code ?? "unknown"}`));
    });
  });
}

function renderArg(arg: string, payload: PlaintextDeliveryPayload): string {
  return arg
    .replaceAll("{{transcript}}", payload.transcript)
    .replaceAll("{{recorded_at}}", payload.recorded_at)
    .replaceAll("{{event_id}}", payload.message_id)
    .replaceAll("{{ring_id}}", payload.ring_id)
    .replaceAll("{{source_message_id}}", payload.source_message_id);
}
