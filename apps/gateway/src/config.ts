import { randomBytes } from "node:crypto";

export type GatewayConfig = {
  publicBaseUrl: string;
  databaseUrl: string;
  sessionSecret: string;
  tokenPepper: string;
  appEncryptionKey: string;
  messageRetentionMode: "encrypted_ephemeral";
  messageTtlMinutes: number;
  deletePayloadOnClaim: boolean;
  debugRetention: boolean;
  signupsEnabled: boolean;
  ntfyEnabled: boolean;
  ntfyAllowedHosts: string[];
  port: number;
};

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function loadConfig(env = process.env): GatewayConfig {
  return {
    publicBaseUrl: env.PUBLIC_BASE_URL ?? "http://localhost:3000",
    databaseUrl: env.DATABASE_URL ?? "file:./data/gateway.sqlite",
    sessionSecret: env.SESSION_SECRET ?? randomBytes(32).toString("base64url"),
    tokenPepper: env.TOKEN_PEPPER ?? "dev-token-pepper-change-me",
    appEncryptionKey: env.APP_ENCRYPTION_KEY ?? randomBytes(32).toString("base64url"),
    messageRetentionMode: "encrypted_ephemeral",
    messageTtlMinutes: Number(env.MESSAGE_TTL_MINUTES ?? "60"),
    deletePayloadOnClaim: bool(env.DELETE_PAYLOAD_ON_CLAIM, false),
    debugRetention: bool(env.DEBUG_RETENTION, false),
    signupsEnabled: bool(env.SIGNUPS_ENABLED, true),
    ntfyEnabled: bool(env.NTFY_ENABLED, true),
    ntfyAllowedHosts: (env.NTFY_ALLOWED_HOSTS ?? "ntfy.sh").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean),
    port: Number(env.PORT ?? "3000")
  };
}

export function sqlitePath(databaseUrl: string): string {
  if (databaseUrl.startsWith("file:")) return databaseUrl.slice("file:".length);
  return databaseUrl;
}
