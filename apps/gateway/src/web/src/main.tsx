import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Activity, AlertTriangle, Bot, Brain, CheckCircle, Code2, Copy, Gauge, Github, KeyRound, Radio, Settings as SettingsIcon, Shield, Terminal, Wrench } from "lucide-react";
import "./styles.css";

type Page = "onboarding" | "dashboard" | "rings" | "agents" | "activity" | "settings" | "data" | "risks";
type ConnectorKind = "codex" | "claude" | "openclaw" | "cli";
type CreatedRing = { ok: boolean; ring_id: string; ingest_token: string; webhook_url: string };
type CreatedAgent = { ok: boolean; agent_id: string; agent_token: string };
type MessageHistoryPoint = { day: string; messages: number };
type DashboardMetrics = {
  message_history: MessageHistoryPoint[];
  messages_received_today: number;
  messages_delivered_today: number;
  messages_expired_today: number;
  average_delivery_latency_ms: number | null;
  connected_agents: number;
  debug_mode: boolean;
};
type OnboardingStatus = {
  rings: number;
  agents: number;
  connected_agents: number;
  latest_ring: null | { status: string; error_code: string | null; created_at: string };
  latest_delivery: null | { status: string; target_kind: string | null; created_at: string };
  latest_ack: null | { status: string; delivery_latency_ms: number | null; created_at: string };
  debug_mode: boolean;
};
type ConnectorOption = {
  kind: ConnectorKind;
  title: string;
  subtitle: string;
  description: string;
  bestFor: string;
  command: string;
  voicePrefix: string;
  icon: typeof Bot;
};

const connectorOptions: ConnectorOption[] = [
  {
    kind: "codex",
    title: "Codex",
    subtitle: "Coding work in a local repo",
    description: "Claims ring messages and passes the transcript to the local Codex CLI. Use this for code edits, tests, reviews, and repo automation.",
    bestFor: "Software projects where Codex should work inside your checkout.",
    command: "pnpm --filter @pebble/agent-cli dev -- listen --agent codex",
    voicePrefix: "Codex, fix the failing test",
    icon: Code2
  },
  {
    kind: "claude",
    title: "Claude",
    subtitle: "General assistant workflows",
    description: "Claims ring messages and passes the transcript to a local Claude CLI command. Use this for writing, summarizing, planning, and general assistant tasks.",
    bestFor: "Non-coding or mixed tasks you want handled by Claude locally.",
    command: "pnpm --filter @pebble/agent-cli dev -- listen --agent claude",
    voicePrefix: "Claude, summarize my last note",
    icon: Brain
  },
  {
    kind: "openclaw",
    title: "OpenClaw",
    subtitle: "OpenClaw local automations",
    description: "Claims ring messages and passes the transcript to your local OpenClaw runner. Use this when OpenClaw owns the downstream automation.",
    bestFor: "Custom local workflows backed by OpenClaw.",
    command: "pnpm --filter @pebble/agent-cli dev -- listen --agent openclaw",
    voicePrefix: "OpenClaw, run my morning workflow",
    icon: Wrench
  },
  {
    kind: "cli",
    title: "CLI smoke test",
    subtitle: "Print and ack only",
    description: "Claims, decrypts, prints, and acks messages without invoking an external agent. Use this first to confirm delivery works.",
    bestFor: "Testing the ring, gateway, encryption, and ack path.",
    command: "pnpm --filter @pebble/agent-cli dev -- listen --agent print",
    voicePrefix: "Test message",
    icon: Terminal
  }
];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(formatApiError(body?.error, response.status));
  }
  return response.json() as Promise<T>;
}

function App() {
  const [page, setPage] = useState<Page>(parsePage(location.pathname));
  const [ready, setReady] = useState(false);
  const [login, setLogin] = useState({ email: "", password: "" });
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState<"login" | "signup" | null>(null);

  useEffect(() => {
    api("/api/dashboard/me").then(() => setReady(true)).catch(() => setReady(false));
  }, []);

  async function submitAuth(mode: "login" | "signup") {
    setAuthError(null);
    if (!login.email.trim()) {
      setAuthError("Enter an email address.");
      return;
    }
    if (!login.password) {
      setAuthError("Enter a password.");
      return;
    }
    if (mode === "signup" && login.password.length < 8) {
      setAuthError("Password must be at least 8 characters.");
      return;
    }
    setAuthBusy(mode);
    try {
      await api(`/api/auth/${mode}`, { method: "POST", body: JSON.stringify(login) });
      setReady(true);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Authentication failed.");
    } finally {
      setAuthBusy(null);
    }
  }

  if (!ready) {
    return <main className="auth">
      <section>
        <h1>Pebble Agent Gateway</h1>
        <input placeholder="email" value={login.email} onChange={(e) => { setAuthError(null); setLogin({ ...login, email: e.target.value }); }} />
        <input placeholder="password" type="password" value={login.password} onChange={(e) => { setAuthError(null); setLogin({ ...login, password: e.target.value }); }} />
        {authError && <p className="error" role="alert">{authError}</p>}
        <div className="row">
          <button disabled={authBusy !== null} onClick={() => submitAuth("login")}>{authBusy === "login" ? "Logging in..." : "Log in"}</button>
          <button disabled={authBusy !== null} className="secondary" onClick={() => submitAuth("signup")}>{authBusy === "signup" ? "Signing up..." : "Sign up"}</button>
        </div>
      </section>
    </main>;
  }

  const nav = [
    ["onboarding", CheckCircle, "Setup"],
    ["dashboard", Gauge, "Dashboard"],
    ["rings", Radio, "Rings"],
    ["agents", Bot, "Agents"],
    ["activity", Activity, "Activity"],
    ["settings", SettingsIcon, "Settings"],
    ["data", Shield, "Data"],
    ["risks", AlertTriangle, "Risks"]
  ] as const;

  return <div className="shell">
    <aside>
      <h1>Pebble Gateway</h1>
      {nav.map(([id, Icon, label]) => <button key={id} className={page === id ? "active" : ""} onClick={() => { setPage(id); history.pushState(null, "", `/${id}`); }}>
        <Icon size={18} /> {label}
      </button>)}
      <footer>
        <a href="https://github.com/sarfata/pebble-agent-gateway" target="_blank" rel="noreferrer"><Github size={15} /> Open source on GitHub</a>
      </footer>
    </aside>
    <main>
      {page === "onboarding" && <Onboarding />}
      {page === "dashboard" && <Dashboard />}
      {page === "rings" && <Rings />}
      {page === "agents" && <Agents />}
      {page === "activity" && <ActivityPage />}
      {page === "settings" && <Settings />}
      {page === "data" && <DataProtection />}
      {page === "risks" && <Risks />}
    </main>
  </div>;
}

function Onboarding() {
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  useEffect(() => {
    const refresh = () => api<OnboardingStatus>("/api/dashboard/onboarding/status").then(setStatus).catch(() => undefined);
    refresh();
    const id = window.setInterval(refresh, 3000);
    return () => window.clearInterval(id);
  }, []);
  return <section>
    <header><h2>Connect Your Ring</h2></header>
    <div className="wizard">
      <WizardStep number="1" title="Link your ring" done={(status?.rings ?? 0) > 0}>
        <p>Create a ring token, then put the Webhook URL and Auth Token into CoreApp's Webhook settings.</p>
        <RingsSetup />
      </WizardStep>
      <WizardStep number="2" title="Confirm the ring reaches the gateway" done={Boolean(status?.latest_ring || status?.latest_delivery)}>
        <p>Send a short voice message from the ring. This panel refreshes every few seconds and only shows metadata.</p>
        <StatusLine label="Latest ring event" value={status?.latest_ring ? `${status.latest_ring.status}${status.latest_ring.error_code ? ` / ${status.latest_ring.error_code}` : ""} at ${status.latest_ring.created_at}` : "Waiting for a message"} />
        <StatusLine label="Delivery created" value={status?.latest_delivery ? `${status.latest_delivery.target_kind ?? "agent"} at ${status.latest_delivery.created_at}` : "Waiting for an agent target"} />
      </WizardStep>
      <WizardStep number="3" title="Connect your agent and confirm it works" done={Boolean(status?.latest_ack)}>
        <p>Pick Codex, Claude, or OpenClaw. The gateway encrypts each pending delivery to the connector key you generate locally.</p>
        <AgentSetup defaultKind="codex" />
        <StatusLine label="Connected agents" value={String(status?.connected_agents ?? 0)} />
        <StatusLine label="Latest ack" value={status?.latest_ack ? `${status.latest_ack.status} at ${status.latest_ack.created_at}` : "Waiting for connector ack"} />
      </WizardStep>
      <WizardStep number="4" title="Keep it running long term" done={false}>
        <AgentRunbook />
      </WizardStep>
    </div>
    <div className="setup-panel">
      <h3>What this website is for</h3>
      <div className="grid three">
        <article><span>Connect agents</span><p>Come back here to add or revoke Codex, Claude, OpenClaw, or CLI connectors.</p></article>
        <article><span>Debug safely</span><p>Use Activity and Settings to inspect metadata. Debug retention is visibly shown and should stay off unless you need it.</p></article>
        <article><span>Check usage</span><p>The dashboard shows received, delivered, expired, latency, connected agents, and debug status.</p></article>
      </div>
    </div>
  </section>;
}

function WizardStep({ number, title, done, children }: { number: string; title: string; done: boolean; children: React.ReactNode }) {
  return <div className={done ? "wizard-step done" : "wizard-step"}>
    <div className="step-marker">{done ? <CheckCircle size={18} /> : number}</div>
    <div>
      <h3>{title}</h3>
      {children}
    </div>
  </div>;
}

function StatusLine({ label, value }: { label: string; value: string }) {
  return <div className="status-line"><span>{label}</span><strong>{value}</strong></div>;
}

function Dashboard() {
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  useEffect(() => { api<DashboardMetrics>("/api/dashboard/metrics").then(setMetrics); }, []);
  const cards = metrics ? Object.entries(metrics).filter(([key]) => key !== "message_history") : [];
  return <section>
    <header><h2>Dashboard</h2></header>
    <MessageHistogram history={metrics?.message_history ?? []} />
    <div className="grid">
      {cards.map(([key, value]) => <article key={key}>
        <span>{key.replaceAll("_", " ")}</span>
        <strong>{String(value ?? "-")}</strong>
      </article>)}
    </div>
  </section>;
}

function MessageHistogram({ history }: { history: MessageHistoryPoint[] }) {
  const max = Math.max(1, ...history.map((point) => point.messages));
  const total = history.reduce((sum, point) => sum + point.messages, 0);
  return <div className="histogram-panel">
    <div className="histogram-header">
      <div>
        <h3>Messages Per Day</h3>
        <p>Last 15 days</p>
      </div>
      <strong>{total}</strong>
    </div>
    <div className="histogram" aria-label="Messages per day for the last 15 days">
      {history.map((point) => {
        const height = `${Math.max(6, Math.round((point.messages / max) * 100))}%`;
        return <div className="histogram-day" key={point.day} title={`${point.day}: ${point.messages} messages`}>
          <span>{point.messages}</span>
          <div className="histogram-track"><div className="histogram-bar" style={{ height }} /></div>
          <time dateTime={point.day}>{formatShortDay(point.day)}</time>
        </div>;
      })}
    </div>
  </div>;
}

function formatShortDay(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).format(date);
}

function Rings() {
  return <section>
    <header><h2>Rings</h2></header>
    <RingsSetup showTable />
  </section>;
}

function RingsSetup({ showTable = false }: { showTable?: boolean }) {
  const [rows, setRows] = useState<any[]>([]);
  const [created, setCreated] = useState<CreatedRing | null>(null);
  const [name, setName] = useState("Pebble Index Ring");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => api<{ rows: any[] }>("/api/dashboard/rings").then((r) => setRows(r.rows));
  useEffect(() => { void refresh(); }, []);
  async function add() {
    setError(null);
    if (!name.trim()) {
      setError("Enter a ring name.");
      return;
    }
    setBusy(true);
    try {
      setCreated(await api<CreatedRing>("/api/dashboard/rings", { method: "POST", body: JSON.stringify({ name: name.trim() }) }));
      setName("Pebble Index Ring");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create ring.");
    } finally {
      setBusy(false);
    }
  }
  async function revoke(row: any) {
    if (row.revoked_at) return;
    if (!confirm(`Revoke ring "${row.name}"? Its current ingest token will stop working immediately.`)) return;
    await api(`/api/dashboard/rings/${row.id}/revoke`, { method: "POST", body: "{}" });
    await refresh();
  }
  return <>
    <div className="inline-form">
      <label>Ring name<input value={name} onChange={(e) => { setError(null); setName(e.target.value); }} /></label>
      <button disabled={busy} onClick={add}><KeyRound size={16} /> {busy ? "Adding..." : "Add ring"}</button>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    <CoreAppSettingsGuide created={created} />
    {showTable && <Table rows={rows} columns={["name", "created_at", "revoked_at"]} actions={(row) => (
      <button className="danger-button" disabled={Boolean(row.revoked_at)} onClick={() => revoke(row)}>
        {row.revoked_at ? "Revoked" : "Revoke"}
      </button>
    )} />}
  </>;
}

function CoreAppSettingsGuide({ created }: { created: CreatedRing | null }) {
  const webhookUrl = created?.webhook_url ?? `${window.location.origin}/api/ring/ingest`;
  return <div className="setup-panel">
    <div>
      <h3>CoreApp webhook settings</h3>
      <p>In the mobile app, open Index Settings, tap Webhook, and enter these values.</p>
    </div>
    <div className="settings-grid">
      <CopyField label="Webhook URL" value={webhookUrl} />
      <CopyField label="Auth Token" value={created?.ingest_token ?? "Create a ring to reveal this token once."} muted={!created} />
      <CopyField label="Send" value="Transcription only" />
      <CopyField label="Trigger" value="Double click & hold" />
    </div>
    <p className="hint">The current CoreApp sends the auth token as the <code>X-Widget-Token</code> header and posts multipart fields named <code>audio</code>, <code>transcription</code>, <code>recordedAt</code>, and <code>client</code>. This gateway accepts that format directly. Use Transcription only or Recording + Transcription; Recording only has no transcript for agent routing.</p>
  </div>;
}

function CopyField({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  async function copy() {
    if (muted) return;
    await navigator.clipboard.writeText(value);
  }
  return <label className="copy-field">
    <span>{label}</span>
    <div>
      <input readOnly value={value} className={muted ? "muted" : ""} />
      <button type="button" className="icon-button" disabled={muted} onClick={copy} aria-label={`Copy ${label}`}>
        <Copy size={16} />
      </button>
    </div>
  </label>;
}

function Agents() {
  return <section>
    <header><h2>Agents</h2></header>
    <AgentSetup defaultKind="codex" showTable />
  </section>;
}

function AgentSetup({ defaultKind, showTable = false }: { defaultKind: string; showTable?: boolean }) {
  const [rows, setRows] = useState<any[]>([]);
  const [created, setCreated] = useState<CreatedAgent | null>(null);
  const initialKind = isConnectorKind(defaultKind) ? defaultKind : "cli";
  const [form, setForm] = useState<{ kind: ConnectorKind; name: string; encryption_public_key: string }>({ kind: initialKind, name: defaultName(initialKind), encryption_public_key: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => api<{ rows: any[] }>("/api/dashboard/agents").then((r) => setRows(r.rows));
  useEffect(() => { void refresh(); }, []);
  async function add() {
    setError(null);
    if (!form.name.trim()) {
      setError("Enter a connector name.");
      return;
    }
    if (!form.encryption_public_key.trim()) {
      setError("Paste the public key printed by the keygen command.");
      return;
    }
    setBusy(true);
    try {
      setCreated(await api<CreatedAgent>("/api/dashboard/agents", {
        method: "POST",
        body: JSON.stringify({
          kind: form.kind,
          name: form.name.trim(),
          encryption_public_key: form.encryption_public_key.trim()
        })
      }));
      setForm({ ...form, encryption_public_key: "" });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create connector.");
    } finally {
      setBusy(false);
    }
  }
  async function revoke(row: any) {
    if (row.revoked_at) return;
    if (!confirm(`Revoke connector "${row.name}"? Its current agent token will stop working immediately.`)) return;
    await api(`/api/dashboard/agents/${row.id}/revoke`, { method: "POST", body: "{}" });
    await refresh();
  }
  const serverUrl = window.location.origin;
  const keygenCommand = "pnpm --filter @pebble/agent-cli dev -- keygen";
  const activeRows = rows.filter((row) => !row.revoked_at);
  const selected = connectorOptions.find((option) => option.kind === form.kind) ?? connectorOptions[0];
  return <>
    <div className="setup-panel">
      <div>
        <h3>Add a local connector</h3>
        <p>The connector keeps its private key on your machine. The gateway only needs the public key so it can encrypt pending messages for that connector.</p>
      </div>
      {activeRows.length > 0 && <div className="routing-note">
        <strong>Before adding another connector</strong>
        <p>You can have more than one. Voice prefixes route by kind: <code>Codex, ...</code> goes to Codex, <code>Claude, ...</code> goes to Claude, and <code>OpenClaw, ...</code> goes to OpenClaw. If you add multiple connectors of the same kind, a prefixed message is delivered to all active connectors of that kind. Messages without a prefix use your default target in Settings, or the first active connector if no default is set.</p>
      </div>}
      <div className="step-list">
        <div>
          <strong>1. Generate a local key</strong>
          <CopyField label="Run in this repo" value={keygenCommand} />
        </div>
        <div>
          <strong>2. Choose what should handle messages</strong>
          <ConnectorChooser selected={form.kind} onSelect={(kind) => setForm({ ...form, kind, name: defaultName(kind) })} />
          <div className="connector-preview">
            <div>
              <span>Preview</span>
              <h4>{selected.title} connector</h4>
              <p>{selected.bestFor}</p>
            </div>
            <CopyField label="Run command after creating" value={selected.command} />
            <p className="hint">Try saying: <code>{selected.voicePrefix}</code></p>
          </div>
        </div>
        <div>
          <strong>3. Create the connector</strong>
          <div className="settings-grid">
            <label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          </div>
          <label className="wide-field">Public encryption key
            <textarea value={form.encryption_public_key} onChange={(e) => setForm({ ...form, encryption_public_key: e.target.value })} placeholder="Paste the key printed by keygen" />
          </label>
          {error && <p className="error" role="alert">{error}</p>}
          <button disabled={busy} onClick={add}><Bot size={16} /> {busy ? "Creating..." : "Create connector"}</button>
        </div>
      </div>
    </div>
    {created && <AgentTokenPanel created={created} serverUrl={serverUrl} />}
    {showTable && <Table rows={rows} columns={["kind", "name", "last_seen_at", "revoked_at"]} actions={(row) => (
      <button className="danger-button" disabled={Boolean(row.revoked_at)} onClick={() => revoke(row)}>
        {row.revoked_at ? "Revoked" : "Revoke"}
      </button>
    )} />}
  </>;
}

function ConnectorChooser({ selected, onSelect }: { selected: ConnectorKind; onSelect: (kind: ConnectorKind) => void }) {
  return <div className="connector-grid" role="radiogroup" aria-label="Connector type">
    {connectorOptions.map((option) => {
      const Icon = option.icon;
      const active = option.kind === selected;
      return <button
        type="button"
        key={option.kind}
        className={active ? "connector-card selected" : "connector-card"}
        onClick={() => onSelect(option.kind)}
        role="radio"
        aria-checked={active}
      >
        <span className="connector-icon"><Icon size={20} /></span>
        <span className="connector-copy">
          <strong>{option.title}</strong>
          <small>{option.subtitle}</small>
          <span>{option.description}</span>
        </span>
      </button>;
    })}
  </div>;
}

function AgentTokenPanel({ created, serverUrl }: { created: CreatedAgent; serverUrl: string }) {
  return <div className="setup-panel success-panel">
    <div>
      <h3>Connector created</h3>
      <p>Copy this token now. The gateway stores only a hash, so it cannot show the token again later.</p>
    </div>
    <CopyField label="Agent token" value={created.agent_token} />
    <CopyField label="Save local config" value={`pnpm --filter @pebble/agent-cli dev -- login --server ${serverUrl} --token ${created.agent_token}`} />
    <CopyField label="Start smoke-test listener" value="pnpm --filter @pebble/agent-cli dev -- listen --agent print" />
    <p className="hint">After the smoke test works, run with <code>--agent codex</code>, <code>--agent claude</code>, or <code>--agent openclaw</code>.</p>
  </div>;
}

function isConnectorKind(kind: string): kind is ConnectorKind {
  return ["codex", "claude", "openclaw", "cli"].includes(kind);
}

function defaultName(kind: ConnectorKind): string {
  if (kind === "codex") return "Local Codex";
  if (kind === "claude") return "Local Claude";
  if (kind === "openclaw") return "Local OpenClaw";
  return "Local CLI";
}

function ActivityPage() {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => { api<{ rows: any[] }>("/api/dashboard/activity").then((r) => setRows(r.rows)); }, []);
  return <section><h2>Activity</h2><Table rows={rows} columns={["created_at", "event_type", "ring_name", "agent_name", "status", "delivery_latency_ms", "payload_bytes", "error_code"]} /></section>;
}

function Settings() {
  const [form, setForm] = useState({ default_agent_kind: "", ntfy_url: "" });
  const [me, setMe] = useState<{ config: { debugRetention: boolean } } | null>(null);
  useEffect(() => { api<{ config: { debugRetention: boolean } }>("/api/dashboard/me").then(setMe).catch(() => undefined); }, []);
  async function save() {
    await api("/api/dashboard/settings", { method: "POST", body: JSON.stringify(form) });
    alert("Saved");
  }
  return <section>
    <h2>Settings</h2>
    <label>Default target agent kind<input value={form.default_agent_kind} onChange={(e) => setForm({ ...form, default_agent_kind: e.target.value })} placeholder="cli, claude, codex, openclaw" /></label>
    <label>ntfy topic URL<input value={form.ntfy_url} onChange={(e) => setForm({ ...form, ntfy_url: e.target.value })} placeholder="https://ntfy.sh/topic" /></label>
    <button onClick={save}>Save</button>
    <div className={me?.config.debugRetention ? "setup-panel danger-panel" : "setup-panel"}>
      <h3>Debug retention</h3>
      <p>Status: <strong>{me?.config.debugRetention ? "enabled" : "disabled"}</strong></p>
      <p className="hint">This MVP does not enable transcript retention from the browser. To debug message contents, set <code>DEBUG_RETENTION=true</code> deliberately in the deployment environment and restart, then turn it off again. The normal activity table remains metadata-only.</p>
    </div>
  </section>;
}

function AgentRunbook() {
  return <div className="runbook-grid">
    <article>
      <span>Codex</span>
      <p>Install and authenticate the Codex CLI locally, then keep the connector running in the repo you want Codex to work in.</p>
      <CopyField label="Run Codex connector" value="pnpm --filter @pebble/agent-cli dev -- listen --agent codex" />
      <p className="hint">For long-running use, run this in tmux, screen, launchd, systemd, or a small always-on machine.</p>
    </article>
    <article>
      <span>Claude</span>
      <p>Install and authenticate the Claude CLI locally. The connector passes transcripts with <code>claude -p</code> by default.</p>
      <CopyField label="Run Claude connector" value="pnpm --filter @pebble/agent-cli dev -- listen --agent claude" />
      <p className="hint">Override the command with <code>PEBBLE_CLAUDE_COMMAND</code> and <code>PEBBLE_CLAUDE_ARGS_JSON</code> if your local CLI uses a different shape.</p>
    </article>
    <article>
      <span>OpenClaw</span>
      <p>Install the OpenClaw command line tool locally. The connector uses <code>openclaw run</code> by default.</p>
      <CopyField label="Run OpenClaw connector" value="pnpm --filter @pebble/agent-cli dev -- listen --agent openclaw" />
      <p className="hint">Override with <code>PEBBLE_OPENCLAW_COMMAND</code> and <code>PEBBLE_OPENCLAW_ARGS_JSON</code> for your local OpenClaw setup.</p>
    </article>
  </div>;
}

function DataProtection() {
  return <section className="content-page">
    <h2>How We Protect Your Data</h2>
    <div className="setup-panel">
      <h3>Default storage</h3>
      <p>Message contents are encrypted before they are written to SQLite. Each pending delivery is encrypted to the selected connector's public key. The private key stays on the machine running your connector.</p>
      <p>When a connector claims a delivery, the encrypted payload is deleted from the active queue by default. If a delivery is never claimed, it expires and is deleted after the configured TTL.</p>
    </div>
    <div className="setup-panel">
      <h3>Logs and metrics</h3>
      <p>Activity logs keep metadata: timestamps, event type, status, target kind, payload size, latency, and error codes. They do not include transcript or audio content by default.</p>
      <p>Debug retention is separate and should be enabled only when you are actively diagnosing an issue.</p>
    </div>
    <div className="setup-panel">
      <h3>Important limitation</h3>
      <p>The gateway receives plaintext during webhook processing because the current mobile app sends plaintext transcription data to the webhook. This is encrypted short-term storage, not full end-to-end encryption from the ring or phone.</p>
    </div>
  </section>;
}

function Risks() {
  return <section className="content-page">
    <h2>What Are The Risks?</h2>
    <div className="setup-panel">
      <h3>Someone gets your ring or can trigger it</h3>
      <p>If someone can trigger your configured ring action, they may be able to send voice commands to your connected agent. Treat ring transcripts as untrusted input. Revoke the ring token immediately if the ring is lost.</p>
    </div>
    <div className="setup-panel">
      <h3>Someone gets a ring or agent token</h3>
      <p>A ring token can submit webhook messages. An agent token can claim encrypted deliveries for its connector. Tokens are shown once, stored only as hashes, and should be rotated or revoked if exposed.</p>
    </div>
    <div className="setup-panel">
      <h3>Local agent actions</h3>
      <p>Codex, Claude, and OpenClaw run locally under your account. The gateway can deliver a transcript, but the local agent tooling decides what actions require confirmation. Do not configure agents to execute shell commands blindly from voice input.</p>
    </div>
    <div className="setup-panel">
      <h3>Hosted gateway trust</h3>
      <p>The hosted gateway sees plaintext transiently during ingest. Pending contents are encrypted at rest, but operators and process memory remain part of the trust boundary until mobile-side encryption exists.</p>
    </div>
  </section>;
}

function Table({ rows, columns, actions }: { rows: any[]; columns: string[]; actions?: (row: any) => React.ReactNode }) {
  return <div className="table"><table><thead><tr>{columns.map((c) => <th key={c}>{c.replaceAll("_", " ")}</th>)}{actions && <th>actions</th>}</tr></thead><tbody>
    {rows.map((row, i) => <tr key={row.id ?? i}>{columns.map((c) => <td key={c}>{String(row[c] ?? "")}</td>)}{actions && <td>{actions(row)}</td>}</tr>)}
  </tbody></table></div>;
}

createRoot(document.getElementById("root")!).render(<App />);

function parsePage(pathname: string): Page {
  const page = pathname.split("/")[1];
  if (["onboarding", "dashboard", "rings", "agents", "activity", "settings", "data", "risks"].includes(page)) {
    return page as Page;
  }
  return "onboarding";
}

function formatApiError(error: string | undefined, status: number): string {
  switch (error) {
    case "email_required":
      return "Enter an email address.";
    case "password_too_short":
      return "Password must be at least 8 characters.";
    case "email_already_registered":
      return "That email is already registered. Log in instead.";
    case "invalid_credentials":
      return "Email or password is incorrect.";
    case "signups_disabled":
      return "Signups are disabled on this gateway.";
    case "invalid_signup":
      return "Enter a valid email and a password of at least 8 characters.";
    default:
      return `Request failed (${status}).`;
  }
}
