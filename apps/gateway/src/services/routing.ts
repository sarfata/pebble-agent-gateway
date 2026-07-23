import type { Db } from "../db/migrate.js";

export type AgentConnectorRow = {
  id: string;
  user_id: string;
  kind: "openclaw" | "claude" | "codex" | "cli";
  name: string;
  encryption_public_key: string;
};

export function targetHintFromTranscript(transcript: string): AgentConnectorRow["kind"] | null {
  const prefix = transcript.trimStart().split(/[,\s]/, 1)[0]?.toLowerCase();
  if (prefix === "claude") return "claude";
  if (prefix === "codex") return "codex";
  if (prefix === "openclaw") return "openclaw";
  return null;
}

export function routeConnectors(
  db: Db,
  userId: string,
  transcript: string,
  trigger?: "single-click-hold" | "double-click-hold"
): { targetHint: string | null; agents: AgentConnectorRow[] } {
  const hinted = targetHintFromTranscript(transcript);
  const settings = db.prepare(`select default_agent_kind, double_action_agent_kind from user_settings where user_id = ?`)
    .get(userId) as {
      default_agent_kind: AgentConnectorRow["kind"] | null;
      double_action_agent_kind: AgentConnectorRow["kind"] | null;
    } | undefined;
  const gestureKind = trigger === "double-click-hold" ? settings?.double_action_agent_kind : null;
  const kind = hinted ?? gestureKind ?? settings?.default_agent_kind ?? null;
  const agents = kind
    ? db.prepare(`select id, user_id, kind, name, encryption_public_key from agent_connectors where user_id = ? and kind = ? and revoked_at is null`)
      .all(userId, kind) as AgentConnectorRow[]
    : db.prepare(`select id, user_id, kind, name, encryption_public_key from agent_connectors where user_id = ? and revoked_at is null order by created_at asc limit 1`)
      .all(userId) as AgentConnectorRow[];
  return { targetHint: kind, agents };
}
