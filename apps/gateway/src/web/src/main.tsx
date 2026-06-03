import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Activity, Bot, Gauge, KeyRound, Radio, Settings as SettingsIcon } from "lucide-react";
import "./styles.css";

type Page = "dashboard" | "rings" | "agents" | "activity" | "settings";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers }
  });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json() as Promise<T>;
}

function App() {
  const [page, setPage] = useState<Page>((location.pathname.split("/")[1] as Page) || "dashboard");
  const [ready, setReady] = useState(false);
  const [login, setLogin] = useState({ email: "", password: "" });

  useEffect(() => {
    api("/api/dashboard/me").then(() => setReady(true)).catch(() => setReady(false));
  }, []);

  async function submitAuth(mode: "login" | "signup") {
    await api(`/api/auth/${mode}`, { method: "POST", body: JSON.stringify(login) });
    setReady(true);
  }

  if (!ready) {
    return <main className="auth">
      <section>
        <h1>Pebble Agent Gateway</h1>
        <input placeholder="email" value={login.email} onChange={(e) => setLogin({ ...login, email: e.target.value })} />
        <input placeholder="password" type="password" value={login.password} onChange={(e) => setLogin({ ...login, password: e.target.value })} />
        <div className="row">
          <button onClick={() => submitAuth("login")}>Log in</button>
          <button className="secondary" onClick={() => submitAuth("signup")}>Sign up</button>
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
  const [created, setCreated] = useState<any>(null);
  const refresh = () => api<{ rows: any[] }>("/api/dashboard/rings").then((r) => setRows(r.rows));
  useEffect(() => { void refresh(); }, []);
  async function add() {
    const name = prompt("Ring name") || "Pebble Index Ring";
    setCreated(await api("/api/dashboard/rings", { method: "POST", body: JSON.stringify({ name }) }));
    refresh();
  }
  return <section>
    <header><h2>Rings</h2><button onClick={add}><KeyRound size={16} /> Add ring</button></header>
    {created && <pre>{JSON.stringify(created, null, 2)}</pre>}
    <Table rows={rows} columns={["name", "created_at", "revoked_at"]} />
  </section>;
}

function Agents() {
  const [rows, setRows] = useState<any[]>([]);
  const [created, setCreated] = useState<any>(null);
  const refresh = () => api<{ rows: any[] }>("/api/dashboard/agents").then((r) => setRows(r.rows));
  useEffect(() => { void refresh(); }, []);
  async function add() {
    const kind = prompt("Kind: cli/openclaw/claude/codex", "cli") || "cli";
    const name = prompt("Agent name", "Local CLI") || "Local CLI";
    const encryption_public_key = prompt("Public encryption key") || "";
    setCreated(await api("/api/dashboard/agents", { method: "POST", body: JSON.stringify({ kind, name, encryption_public_key }) }));
    refresh();
  }
  return <section>
    <header><h2>Agents</h2><button onClick={add}><Bot size={16} /> Add connector</button></header>
    {created && <pre>{JSON.stringify(created, null, 2)}</pre>}
    <Table rows={rows} columns={["kind", "name", "last_seen_at", "revoked_at"]} />
  </section>;
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
