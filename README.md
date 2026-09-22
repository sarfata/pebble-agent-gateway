# Pebble Agent Gateway

Talk to your AI agent from a Pebble Index ring.

Pebble Agent Gateway is a small, open-source bridge that sends ring voice messages to AI agents running on your own machine. Agent answers come back as reliable phone notifications.

You configure the Pebble/CoreApp mobile app with a public webhook URL and token. When you send a voice message from the ring, the gateway receives it and routes it to Codex, Claude, OpenClaw, GrokBot, or a simple CLI smoke-test runner. Codex, Claude, OpenClaw, and the CLI smoke test run through a local connector on your own machine; GrokBot is different — it has no local dependency, so the gateway itself forwards the transcript straight to a webhook you configure in the dashboard, no connector process required. Agent answers return through Pushover or ntfy.

Source: https://github.com/sarfata/pebble-agent-gateway

![Configure reliable Pushover replies](docs/images/response-notifications.png)

## Fastest path: use the free hosted relay

The shared relay at **https://pebble-agent-gateway.fly.dev** is currently free for personal, reasonable-use setups. Create an account there, follow the five setup steps, and run the connector on your own computer. You do not need a Fly.io account or a public server.

The hosted service is an early community offering, not a paid SLA: availability and limits may change, and abusive or unusually heavy use may be restricted. Each account is currently limited to 5 active rings, 10 active connectors, and 5 active response targets. Your local AI credentials and tools remain on your computer. The relay handles the webhook and encrypted short-lived queue; read [Privacy Model](#privacy-model) before deciding whether the hosted trust model fits you.

Prefer complete control? The project remains fully self-hostable with Tailscale Funnel, Docker, or your own Fly.io app.

## Architecture

There are two pieces:

1. A relay gateway with a public HTTPS URL.
2. An agent connector running on your machine.

The relay can be:

- **Our hosted Fly.io relay**, the quickest free setup for most people.
- **Mac + Tailscale Funnel**, the easiest personal setup. Follow [Run on a Mac with Tailscale](deploy/tailscale-funnel.md).
- **Fly.io**, which keeps the relay online when your Mac sleeps. Follow [Deploy the gateway to Fly.io](deploy/fly-io.md).

You do not need to understand webhooks, SQLite, or encryption to get started. The dashboard walks you through linking the ring and connecting an agent.

The agent connector runs locally where your agent already has access: inside your code checkout for Codex, on your workstation for Claude, or beside your OpenClaw workflows. It opens an outbound SSE connection to the relay, claims pending deliveries, runs the local agent command, acknowledges the delivery, and sends the answer back to the relay for a Pushover or ntfy notification.

GrokBot skips all of that: it has no local CLI, so the gateway POSTs the transcript directly to a webhook URL you configure when creating the connector, and uses the webhook's response as the reply. Nothing needs to run on your machine for GrokBot.

The relay does not need inbound access to your laptop. Your machine connects out to it.

## Privacy Model

By default, message contents are not stored in plaintext at rest.

Pending messages are encrypted before they are written to SQLite. When a connector public key is configured, each pending delivery is encrypted to that key and decrypted locally by the connector. If no connector key is configured, the gateway encrypts the pending delivery with `APP_ENCRYPTION_KEY` and decrypts it during claim.

When a connector claims a delivery, the encrypted payload is deleted from the active queue. If no connector claims it within the configured TTL, the payload is deleted, the message is marked expired, and the gateway sends an error through every configured response channel.

GrokBot connectors are the exception: since the gateway forwards for you, it necessarily holds the webhook URL and token, encrypted at rest with `APP_ENCRYPTION_KEY` the same way Pushover and ntfy credentials are, decrypting them only to make the outbound request.

The dashboard keeps metadata-only activity logs: timestamps, delivery status, target connector type, payload size, latency, and error codes. Transcripts and audio are not retained unless debug mode is explicitly enabled.

Important limitation: the gateway receives plaintext during webhook processing unless mobile-side end-to-end encryption is enabled. The default guarantee is encrypted short-term storage and metadata-only logs, not full end-to-end encryption.

## Configure With The Web UI

The web app starts with a guided setup:

1. Link your ring by creating a ring token and configuring CoreApp's Webhook URL and Auth Token fields.
2. Confirm the ring works by sending a test message and watching the metadata-only delivery status.
3. Configure Pushover (recommended) or ntfy replies, connect a local agent connector, and confirm it claims and answers a delivery.
4. Choose how to keep the connector running long term.

You can return to the website to connect another agent, inspect metadata-only activity and usage stats, configure response notifications, or check the data protection and risk notes.

![Manage local agent connectors](docs/images/agent-connectors.png)

### What the dashboard and admin account are for

The dashboard is the control panel for one account. It creates and revokes ring and connector tokens, configures routing and response notifications, and shows metadata-only diagnostics. It does **not** run your agent; the connector on your own computer does that.

On a fresh self-hosted installation, the first account is marked `admin`. Today that role simply identifies the instance owner and reserves a place for future instance-wide controls. It does not expose other users' transcripts or grant cross-account access; rings, connectors, response targets, and activity remain scoped to their owner. For a private single-user deployment, set `SIGNUPS_ENABLED=false` after creating that first account.

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

If your webhook app only offers a generic Headers list and a "Sign requests" toggle instead of a dedicated Auth Token field, leave signing off and add a header named `Authorization` with value `Bearer <your token>` instead.

## Connect An Agent

Optionally generate a local connector key. This is recommended: the private key stays on your machine, and the dashboard only receives the public key, so queued payloads are encrypted to your connector.

```bash
pnpm --package github:sarfata/pebble-agent-gateway dlx pebble-agent-cli keygen
```

You can also leave the public key blank when creating a connector. In that mode the gateway encrypts pending messages at rest with `APP_ENCRYPTION_KEY`, decrypts them during claim, and still deletes the stored ciphertext on claim or expiry. This is easier to set up, but weaker than connector-side encryption because the gateway can decrypt pending messages.

Create a connector in the dashboard with kind `codex`, `claude`, `openclaw`, `grokbot`, or `cli`. For `codex`, `claude`, `openclaw`, and `cli`, copy the one-time `ag_live_...` token; you'll use it to run a local connector process. `grokbot` is different: instead of a token, the dashboard asks for a webhook URL (and optional token and payload key) and the gateway forwards messages to it directly — see [GrokBot: relay to any webhook](#grokbot-relay-to-any-webhook) below. You can run a connector without cloning this repo:

```bash
pnpm --package github:sarfata/pebble-agent-gateway dlx pebble-agent-cli listen --server https://your-gateway.example.com --token ag_live_... --agent print
```

Smoke test without invoking an external agent:

```bash
pnpm --package github:sarfata/pebble-agent-gateway dlx pebble-agent-cli listen --server https://your-gateway.example.com --token ag_live_... --agent print
```

Run a real local agent connector:

```bash
pnpm --package github:sarfata/pebble-agent-gateway dlx pebble-agent-cli listen --server https://your-gateway.example.com --token ag_live_... --agent codex
pnpm --package github:sarfata/pebble-agent-gateway dlx pebble-agent-cli listen --server https://your-gateway.example.com --token ag_live_... --agent claude --channel local-context
pnpm --package github:sarfata/pebble-agent-gateway dlx pebble-agent-cli listen --server https://your-gateway.example.com --token ag_live_... --agent openclaw
```

Agent output is sent back to the gateway by default. If Pushover or ntfy is configured, the answer appears there. Use `--no-send-reply` to disable replies or `--reply "fixed text"` to send a fixed reply instead of the local agent output.

### Claude: keep the conversation between ring messages

For Claude, the recommended setup is the `local-context` channel shown above.
It makes the ring behave like an ongoing conversation: each Claude invocation
receives up to eight recent ring transcripts and Claude replies, so follow-ups
such as “summarize that,” “do the second option,” or “what did I tell you
earlier?” have the context they need.

The context stays on the connector machine in
`~/.config/pebble-agent-gateway/conversation.json`. The gateway still keeps only
encrypted pending payloads and metadata-only activity logs. The local file is
limited to the 30 most recent turns.

If you want every message to be completely independent and do not want local
conversation history, use the stateless channel instead:

```bash
pnpm --package github:sarfata/pebble-agent-gateway dlx pebble-agent-cli listen --server https://your-gateway.example.com --token ag_live_... --agent claude --channel oneshot
```

### GrokBot: relay to any webhook

GrokBot has no local CLI to install, so there is no connector process to run. Create the connector in the dashboard with kind `grokbot` and fill in:

- **Webhook URL** (required) — where the gateway POSTs each transcript.
- **Webhook token** (optional) — sent as `Authorization: Bearer <token>`.
- **Payload key** (optional, default `text`) — the JSON key the transcript is sent under, e.g. `{"text": "..."}`.

That's it: ring messages routed to GrokBot (by voice prefix, default kind, or double-click-and-hold gesture, same as any other connector) are forwarded automatically, and the webhook's response body becomes the reply. Use **Send test** on the connector after creating it to verify the webhook without needing a ring.

If you'd rather keep the webhook secret off the gateway entirely, `pebble-agent-cli` also has a local `--agent grokbot` mode that reads `GROKBOT_WEBHOOK_URL`, `GROKBOT_WEBHOOK_TOKEN`, and `GROKBOT_PAYLOAD_KEY` from the environment and relays locally instead — see `apps/agent-cli/src/agent-runner.ts` for details. This is an advanced, self-hosted-only path.

Customize the prompt passed to Codex, Claude, or OpenClaw with `-p`:

```bash
pnpm --package github:sarfata/pebble-agent-gateway dlx pebble-agent-cli listen --server https://your-gateway.example.com --token ag_live_... --agent claude --channel local-context -p 'Handle this voice request carefully:

{{transcript}}

Reply with the outcome and any next step.'
```

Supported prompt placeholders are `{{transcript}}`, `{{recorded_at}}`, `{{event_id}}`, `{{ring_id}}`, and `{{source_message_id}}`.

Default local commands:

```text
codex:    codex exec "{{prompt}}"
claude:   claude -p "{{prompt}}"
openclaw: openclaw agent --agent main --message "{{prompt}}"
grokbot:  (no local command; POSTs the prompt to GROKBOT_WEBHOOK_URL instead)
```

Override command shapes with:

```bash
PEBBLE_CODEX_COMMAND=codex
PEBBLE_CODEX_ARGS_JSON='["exec","{{prompt}}"]'
PEBBLE_CLAUDE_COMMAND=claude
PEBBLE_CLAUDE_ARGS_JSON='["-p","{{prompt}}"]'
PEBBLE_OPENCLAW_COMMAND=openclaw
PEBBLE_OPENCLAW_ARGS_JSON='["agent","--agent","main","--message","{{prompt}}"]'
```

The mobile app sends `X-Index-Trigger` for Index gestures. Configure a separate
double-click-and-hold agent on the Agents page; when it is unset, both gestures
use the normal default. An explicit voice prefix such as `Claude, ...` still
takes precedence over gesture routing.

OpenClaw also supports `--channel local-context`. Other CLI connectors use the
stateless `oneshot` channel by default. GrokBot's dashboard-configured mode
has no channel concept; each ring message is forwarded independently.

For long-term use, run the connector under tmux, screen, launchd, systemd, Docker, or another process supervisor. If the connector keeps an SSE connection open on Fly.io, the Machine remains active.

## Connect Through MCP Events (Experimental)

The gateway also exposes a Streamable HTTP MCP endpoint at:

```text
https://your-gateway.example.com/mcp
Authorization: Bearer ag_live_...
```

It uses the official MCP TypeScript server SDK and implements the current draft [MCP Events design sketch](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/pja/design-sketch/docs/design-sketch-proposal.md). Events are not part of an approved MCP specification yet, so the client must support custom MCP methods from this draft.

`events/list` advertises one event, `pebble.message.received`, with all three proposed delivery modes:

- Poll: call `events/poll` with the event name and the last returned cursor.
- Push: keep an `events/stream` request open and consume `notifications/events/*` SSE frames.
- Webhook: call `events/subscribe` with an HTTPS callback and a client-generated Standard Webhooks secret (`whsec_` plus base64 of 24–64 random bytes). Refresh before `refreshBefore`, or call `events/unsubscribe` to stop it.

An absent or `null` cursor starts from now. Persist non-null cursors to resume without replaying already-seen events. Webhook subscriptions are in-memory soft state with a granted lifetime between 5 and 60 minutes, so clients should refresh them; a gateway restart requires resubscription.

Each occurrence contains availability metadata (`deliveryId`, `ringId`, `expiresAt`, and `claimUrl`), not the voice transcript. Claim `claimUrl` promptly with the same agent bearer token to retrieve the encrypted or gateway-decrypted delivery through the existing privacy-preserving queue. JSON test/API ingestion, multipart test webhooks, and live Ring/CoreApp webhooks all pass through the same queue and emit this event.

Webhook callback URLs must use HTTPS. The gateway resolves and checks the destination before every delivery, blocks private/special-purpose addresses, does not follow redirects, verifies callback ownership with a signed challenge, signs deliveries using Standard Webhooks headers, and uses bounded retries. Self-hosters who intentionally need a private callback can explicitly allow its hostname with `MCP_WEBHOOK_ALLOWED_HOSTS`.

## Self-Host With Docker

```bash
cp deploy/.env.example deploy/.env
docker compose -f deploy/docker-compose.yml up --build
```

SQLite is stored in the mounted `/data` volume at `/data/gateway.sqlite`.

For a public HTTPS URL, continue with either [Tailscale Funnel](deploy/tailscale-funnel.md) or [Fly.io](deploy/fly-io.md).

## Pushover Replies (Recommended)

Pushover is the recommended phone notification path because it supports prominent, acknowledged emergency alerts for failures and timeouts:

1. Install Pushover and copy your user key from [pushover.net](https://pushover.net/).
2. Create an application such as “Pebble Agent Gateway” at [pushover.net/apps/build](https://pushover.net/apps/build) and copy its API token.
3. Open **Responses** in the gateway dashboard, enter both values, save, and use **Send test**.

Normal agent answers use standard priority. Connector failures and timeouts use emergency priority so they repeat until acknowledged. Pushover credentials are encrypted at rest and are never returned by the dashboard API after saving. Reply text is sent to Pushover for delivery but is not retained by the gateway by default.

## ntfy Replies (Optional)

Add an ntfy topic URL during Setup or in Settings, then use **Send test** to confirm the notification path. Agent replies are posted to that ntfy endpoint, but reply text is not stored by the gateway by default.

If a routed message expires, the gateway deletes the pending payload and sends an error through the configured response channels. If the local agent command fails or produces no response within two minutes by default, the connector sends a human-readable error through the same reply path.

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
DELETE_PAYLOAD_ON_CLAIM=false
DEBUG_RETENTION=false
SIGNUPS_ENABLED=true
NTFY_ENABLED=true
NTFY_ALLOWED_HOSTS=ntfy.sh
MCP_WEBHOOK_ALLOWED_HOSTS=
```

`NTFY_ALLOWED_HOSTS` is a comma-separated allowlist used when saving ntfy targets. The hosted relay limits ntfy to `ntfy.sh` to prevent accounts from using the gateway to access private network services. Self-hosters can add their own public ntfy hostname.

`MCP_WEBHOOK_ALLOWED_HOSTS` is a comma-separated escape hatch for MCP webhook callbacks and GrokBot webhook forwarding that intentionally resolve to private or otherwise special-purpose IP addresses. Leave it empty for public callbacks and hosted deployments.

## Development

```bash
corepack enable
pnpm install
pnpm test
pnpm build
pnpm --filter @pebble/gateway dev
```

Open `http://localhost:3000`, sign up, and follow Setup.

## Roadmap

- Pebble mobile-app QR setup PR
- Deeper Codex, Claude, and OpenClaw native integrations
- Time-limited debug-retention controls in the dashboard
- Optional reliability mode with delete-on-ack
- Optional Postgres adapter after the SQLite MVP
