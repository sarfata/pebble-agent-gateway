# Pebble Agent Gateway

Pebble Agent Gateway is an open-source, self-hostable bridge between Pebble Index ring voice webhooks and local AI agent connectors.

The gateway receives Pebble/CoreApp webhook events, authenticates a ring token, stores pending deliveries durably in SQLite, encrypts each pending payload to the target connector public key, and lets local connectors claim work over HTTP/SSE.

Source: https://github.com/sarfata/pebble-agent-gateway

## Privacy Model

By default, message contents are not stored in plaintext at rest.

Pending messages are encrypted before they are written to SQLite. Each pending delivery is encrypted to the target connector's public key. When a connector claims a delivery, the encrypted payload is deleted from the active queue. If no connector claims it within the configured TTL, the payload is deleted and the message is marked expired.

The dashboard keeps metadata-only activity logs: timestamps, delivery status, target connector type, payload size, latency, and error codes. Transcripts and audio are not retained unless debug mode is explicitly enabled.

Important limitation: the gateway receives plaintext during webhook processing unless mobile-side end-to-end encryption is enabled. The default guarantee is encrypted short-term storage and metadata-only logs, not full end-to-end encryption.

## Web Onboarding Flow

The web app starts with a guided setup:

1. Link your ring by creating a ring token and configuring CoreApp's Webhook URL and Auth Token fields.
2. Confirm the ring works by sending a test message and watching the metadata-only delivery status.
3. Connect a local agent connector and confirm it claims and acks a delivery.
4. Choose how to keep the connector running long term.

You can return to the website to connect another agent, inspect metadata-only activity and usage stats, configure ntfy replies, or check the data protection and risk notes.

## Quick Start: Local Dev

```bash
corepack enable
pnpm install
pnpm --filter @pebble/gateway dev
```

Open `http://localhost:3000`, sign up, and follow Setup.

## Configure CoreApp Manually

Create a ring in the dashboard. In CoreApp, open Index Settings, tap Webhook, and enter:

```text
Webhook URL: https://your-gateway.example.com/api/ring/ingest
Auth Token:  ri_live_...
Send:        Transcription only
Trigger:     Double click & hold
```

The current CoreApp webhook sends:

```text
Content-Type: multipart/form-data
X-Widget-Token: ri_live_...
fields: audio, transcription, recordedAt, client
```

The gateway also accepts `Authorization: Bearer`, `X-Pebble-Token`, `X-Webhook-Token`, direct form token fields, and `?token=` for compatibility.

## Connect An Agent

Generate a local connector key. The private key stays on your machine; the dashboard only receives the public key.

```bash
pnpm --filter @pebble/agent-cli dev -- keygen
```

Create a connector in the dashboard with kind `codex`, `claude`, `openclaw`, or `cli`, then copy the one-time `ag_live_...` token and store local config:

```bash
pnpm --filter @pebble/agent-cli dev -- login --server https://your-gateway.example.com --token ag_live_...
```

Smoke test without invoking an external agent:

```bash
pnpm --filter @pebble/agent-cli dev -- listen --agent print
```

Run a real local agent connector:

```bash
pnpm --filter @pebble/agent-cli dev -- listen --agent codex
pnpm --filter @pebble/agent-cli dev -- listen --agent claude
pnpm --filter @pebble/agent-cli dev -- listen --agent openclaw
```

Default local commands:

```text
codex:    codex exec "{{transcript}}"
claude:   claude -p "{{transcript}}"
openclaw: openclaw run "{{transcript}}"
```

Override command shapes with:

```bash
PEBBLE_CODEX_COMMAND=codex
PEBBLE_CODEX_ARGS_JSON='["exec","{{transcript}}"]'
PEBBLE_CLAUDE_COMMAND=claude
PEBBLE_CLAUDE_ARGS_JSON='["-p","{{transcript}}"]'
PEBBLE_OPENCLAW_COMMAND=openclaw
PEBBLE_OPENCLAW_ARGS_JSON='["run","{{transcript}}"]'
```

For long-term use, run the connector under tmux, screen, launchd, systemd, Docker, or another process supervisor. If the connector keeps an SSE connection open on Fly.io, the Machine remains active.

## Self-Host With Docker

```bash
cp deploy/.env.example deploy/.env
docker compose -f deploy/docker-compose.yml up --build
```

SQLite is stored in the mounted `/data` volume at `/data/gateway.sqlite`.

## Public HTTPS With Tailscale Funnel

The Pebble iOS app needs a public HTTPS webhook URL. Use Tailscale Funnel for self-hosted Docker:

```bash
tailscale funnel 3000
```

Set `PUBLIC_BASE_URL` to the Funnel HTTPS URL.

## Deploy To Fly.io

```bash
fly launch --copy-config --config deploy/fly.toml
fly volumes create gateway_data --size 1
fly secrets set SESSION_SECRET=... TOKEN_PEPPER=... APP_ENCRYPTION_KEY=... PUBLIC_BASE_URL=https://your-app.fly.dev
fly deploy --config deploy/fly.toml
```

This MVP is single-node. Do not scale it to multiple Machines with one SQLite database.

`min_machines_running=0` saves money because pending messages are durable in SQLite. `min_machines_running=1` gives better always-on SSE behavior.

## ntfy Replies

Add an ntfy topic URL in Settings. Agent replies are posted to that ntfy endpoint, but reply text is not stored by the gateway by default.

Replies sent through ntfy are delivered to your configured ntfy server. Use a self-hosted ntfy server if you do not want reply text sent to ntfy.sh.

## Security Notes

Raw bearer tokens are displayed only at creation and stored only as hashes. Revoke a ring if the ring is lost or someone else can trigger it. Revoke an agent if its token or local machine is compromised.

SQLite WAL may retain historical ciphertext bytes until checkpointing. The privacy guarantee is that plaintext message contents are never written to normal SQLite tables and active ciphertext is removed on claim or expiry.

Treat voice transcripts as untrusted external input. Do not configure local agents to execute shell commands blindly from voice input.

## Environment Variables

```env
PUBLIC_BASE_URL=https://example.com
DATABASE_URL=file:/data/gateway.sqlite
SESSION_SECRET=...
TOKEN_PEPPER=...
APP_ENCRYPTION_KEY=...
MESSAGE_RETENTION_MODE=encrypted_ephemeral
MESSAGE_TTL_MINUTES=60
DELETE_PAYLOAD_ON_CLAIM=true
DEBUG_RETENTION=false
SIGNUPS_ENABLED=true
NTFY_ENABLED=true
```

## Development

```bash
pnpm install
pnpm test
pnpm build
```

## Roadmap

- Pebble mobile-app QR setup PR
- Deeper Codex, Claude, and OpenClaw native integrations
- Time-limited debug-retention controls in the dashboard
- Optional reliability mode with delete-on-ack
- Optional Postgres adapter after the SQLite MVP
