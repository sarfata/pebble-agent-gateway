# Pebble Agent Gateway

Pebble Agent Gateway is an open-source, self-hostable bridge between Pebble Index ring voice-message webhooks and local AI agent connectors.

## Privacy model

By default, Pebble Agent Gateway does not store message contents in plaintext at rest.

Pending messages are encrypted before they are written to SQLite. Each pending delivery is encrypted to the target connector's public key. When a connector claims a delivery, the encrypted payload is deleted from the active queue. If no connector claims it within the configured TTL, the payload is deleted and the message is marked expired.

The dashboard keeps metadata-only activity logs: timestamps, delivery status, target connector type, payload size, and latency. Transcripts and audio are not retained unless debug mode is explicitly enabled.

The gateway receives plaintext during webhook processing unless mobile-side end-to-end encryption is enabled. The default guarantee is encrypted short-term storage and metadata-only logs, not full end-to-end encryption.

## Quick start: local dev

```bash
corepack enable
pnpm install
pnpm --filter @pebble/gateway dev
```

Open `http://localhost:3000`, sign up, create an agent connector, then create a ring token.

## Self-host with Docker

```bash
cp deploy/.env.example deploy/.env
docker compose -f deploy/docker-compose.yml up --build
```

SQLite is stored in the mounted `/data` volume at `/data/gateway.sqlite`.

## Public HTTPS with Tailscale Funnel

The Pebble iOS app needs a public HTTPS webhook URL. Use Tailscale Funnel for self-hosted Docker:

```bash
tailscale funnel 3000
```

Set `PUBLIC_BASE_URL` to the Funnel HTTPS URL.

## Deploy to Fly.io

```bash
fly launch --copy-config --config deploy/fly.toml
fly volumes create gateway_data --size 1
fly secrets set SESSION_SECRET=... TOKEN_PEPPER=... APP_ENCRYPTION_KEY=... PUBLIC_BASE_URL=https://your-app.fly.dev
fly deploy --config deploy/fly.toml
```

This MVP is single-node. Do not scale it to multiple Machines with one SQLite database.

`min_machines_running=0` saves money because pending messages are durable in SQLite. `min_machines_running=1` gives better always-on SSE behavior. If an agent keeps an SSE connection open, the Machine remains active. If no agent is connected, ring ingest can wake the Machine, store the encrypted message, and stop again.

## Configure a Pebble ring manually

Create a ring in the dashboard. Configure the Pebble webhook URL as:

```text
https://your-gateway.example.com/api/ring/ingest
```

Use the one-time-displayed `ri_live_...` token as the bearer token.

## QR auto-configuration plan

`POST /api/provision/setup-token` creates a short-lived `pst_...` QR payload. A future Pebble app flow can exchange it at `/api/provision/exchange` for a webhook URL and ring ingest token.

## Add an agent connector

Generate a local keypair:

```bash
pnpm --filter @pebble/agent-cli dev -- login --server https://example.com --token temporary
```

Create an agent connector in the dashboard with the printed public key. Store the displayed `ag_live_...` token locally, then run:

```bash
pebble-agent-cli login --server https://example.com --token ag_live_...
pebble-agent-cli listen
```

## Configure ntfy replies

Add an ntfy topic URL in settings. Agent replies are posted to that ntfy endpoint, but reply text is not stored by the gateway by default.

Replies sent through ntfy are delivered to your configured ntfy server. Use a self-hosted ntfy server if you do not want reply text sent to ntfy.sh.

## Activity dashboard

The dashboard shows metadata-only metrics and activity: received, delivered, expired, average latency, connected agents, and debug mode status.

## Security notes

Raw bearer tokens are displayed only at creation and stored only as hashes. The gateway never writes plaintext transcripts or audio to normal SQLite tables. SQLite WAL may retain historical ciphertext bytes until checkpointing; the privacy guarantee is that plaintext is never written and active ciphertext is removed on claim or expiry.

## Environment variables

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
- Full Codex MCP connector
- Claude and OpenClaw native connectors
- Optional reliability mode with delete-on-ack
- Optional Postgres adapter after the SQLite MVP
