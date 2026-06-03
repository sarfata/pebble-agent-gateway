import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Activity, Bot, Copy, Gauge, KeyRound, Radio, Settings as SettingsIcon } from "lucide-react";
import "./styles.css";

type Page = "dashboard" | "rings" | "agents" | "activity" | "settings";
type CreatedRing = { ok: boolean; ring_id: string; ingest_token: string; webhook_url: string };
type CreatedAgent = { ok: boolean; agent_id: string; agent_token: string };

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
  const [page, setPage] = useState<Page>((location.pathname.split("/")[1] as Page) || "dashboard");
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
    ["dashboard", Gauge, "Dashboard"],
    ["rings", Radio, "Rings"],
    ["agents", Bot, "Agents"],
    ["activity", Activity, "Activity"],
    ["settings", SettingsIcon, "Settings"]
  ] as const;

  return <div className="shell">
    <aside>
      <h1>Pebble Gateway</h1>
      {nav.map(([id, Icon, label]) => <button key={id} className={page === id ? "active" : ""} onClick={() => { setPage(id); history.pushState(null, "", `/${id}`); }}>
        <Icon size={18} /> {label}
      </button>)}
    </aside>
    <main>
      {page === "dashboard" && <Dashboard />}
      {page === "rings" && <Rings />}
      {page === "agents" && <Agents />}
      {page === "activity" && <ActivityPage />}
      {page === "settings" && <Settings />}
    </main>
  </div>;
}

function Dashboard() {
  const [metrics, setMetrics] = useState<Record<string, unknown>>({});
  useEffect(() => { api<Record<string, unknown>>("/api/dashboard/metrics").then(setMetrics); }, []);
  return <section>
    <h2>Dashboard</h2>
    <div className="grid">
      {Object.entries(metrics).map(([key, value]) => <article key={key}>
        <span>{key.replaceAll("_", " ")}</span>
        <strong>{String(value ?? "-")}</strong>
      </article>)}
    </div>
  </section>;
}

function Rings() {
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
  return <section>
    <header><h2>Rings</h2></header>
    <div className="inline-form">
      <label>Ring name<input value={name} onChange={(e) => { setError(null); setName(e.target.value); }} /></label>
      <button disabled={busy} onClick={add}><KeyRound size={16} /> {busy ? "Adding..." : "Add ring"}</button>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    <CoreAppSettingsGuide created={created} />
    <Table rows={rows} columns={["name", "created_at", "revoked_at"]} />
  </section>;
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
  const [rows, setRows] = useState<any[]>([]);
  const [created, setCreated] = useState<CreatedAgent | null>(null);
  const [form, setForm] = useState({ kind: "codex", name: "Local Codex", encryption_public_key: "" });
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
  const serverUrl = window.location.origin;
  const keygenCommand = "pnpm --filter @pebble/agent-cli dev -- keygen";
  return <section>
    <header><h2>Agents</h2></header>
    <div className="setup-panel">
      <div>
        <h3>Add a local connector</h3>
        <p>The connector keeps its private key on your machine. The gateway only needs the public key so it can encrypt pending messages for that connector.</p>
      </div>
      <div className="step-list">
        <div>
          <strong>1. Generate a local key</strong>
          <CopyField label="Run in this repo" value={keygenCommand} />
        </div>
        <div>
          <strong>2. Create the connector</strong>
          <div className="settings-grid">
            <label>Kind
              <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                <option value="codex">codex</option>
                <option value="cli">cli</option>
                <option value="claude">claude</option>
                <option value="openclaw">openclaw</option>
              </select>
            </label>
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
    <Table rows={rows} columns={["kind", "name", "last_seen_at", "revoked_at"]} />
  </section>;
}

function AgentTokenPanel({ created, serverUrl }: { created: CreatedAgent; serverUrl: string }) {
  return <div className="setup-panel success-panel">
    <div>
      <h3>Connector created</h3>
      <p>Copy this token now. The gateway stores only a hash, so it cannot show the token again later.</p>
    </div>
    <CopyField label="Agent token" value={created.agent_token} />
    <CopyField label="Save local config" value={`pnpm --filter @pebble/agent-cli dev -- login --server ${serverUrl} --token ${created.agent_token}`} />
    <CopyField label="Start listening" value="pnpm --filter @pebble/agent-cli dev -- listen" />
  </div>;
}

function ActivityPage() {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => { api<{ rows: any[] }>("/api/dashboard/activity").then((r) => setRows(r.rows)); }, []);
  return <section><h2>Activity</h2><Table rows={rows} columns={["created_at", "event_type", "ring_name", "agent_name", "status", "delivery_latency_ms", "payload_bytes", "error_code"]} /></section>;
}

function Settings() {
  const [form, setForm] = useState({ default_agent_kind: "", ntfy_url: "" });
  async function save() {
    await api("/api/dashboard/settings", { method: "POST", body: JSON.stringify(form) });
    alert("Saved");
  }
  return <section>
    <h2>Settings</h2>
    <label>Default target agent kind<input value={form.default_agent_kind} onChange={(e) => setForm({ ...form, default_agent_kind: e.target.value })} placeholder="cli, claude, codex, openclaw" /></label>
    <label>ntfy topic URL<input value={form.ntfy_url} onChange={(e) => setForm({ ...form, ntfy_url: e.target.value })} placeholder="https://ntfy.sh/topic" /></label>
    <button onClick={save}>Save</button>
  </section>;
}

function Table({ rows, columns }: { rows: any[]; columns: string[] }) {
  return <div className="table"><table><thead><tr>{columns.map((c) => <th key={c}>{c.replaceAll("_", " ")}</th>)}</tr></thead><tbody>
    {rows.map((row, i) => <tr key={row.id ?? i}>{columns.map((c) => <td key={c}>{String(row[c] ?? "")}</td>)}</tr>)}
  </tbody></table></div>;
}

createRoot(document.getElementById("root")!).render(<App />);

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
