# Run on a Mac with Tailscale Funnel

This is the simplest personal setup: the gateway and agent connector run on your Mac, while Tailscale gives the Pebble app a safe public HTTPS address.

## Before you start

Install:

- [Node.js 22 or newer](https://nodejs.org/)
- [Tailscale](https://tailscale.com/download/mac) and sign in
- at least one supported agent: Codex, Claude, or OpenClaw

Clone and build the project:

```bash
git clone https://github.com/sarfata/pebble-agent-gateway.git
cd pebble-agent-gateway
corepack enable
pnpm install
pnpm build
```

## Start the gateway

Create a private settings file:

```bash
cp deploy/.env.example deploy/.env
```

Replace each `change-me` value in `deploy/.env` with a different value from `openssl rand -base64 32`. The file is ignored by Git. Leave `PUBLIC_BASE_URL` as localhost until Tailscale gives you the public URL below.

Start the gateway:

```bash
docker compose -f deploy/docker-compose.yml up --build
```

If you prefer not to use Docker, load the settings and run:

```bash
set -a
source deploy/.env
set +a
DATABASE_URL='file:./gateway.sqlite' pnpm --filter @pebble/gateway start
```

## Give it a public HTTPS URL

In a second Terminal window:

```bash
tailscale funnel 3000
```

On macOS, if the `tailscale` command is not on your `PATH`, use:

```bash
/Applications/Tailscale.app/Contents/MacOS/Tailscale funnel 3000
```

Tailscale prints a URL similar to `https://your-mac.your-tailnet.ts.net`. Set `PUBLIC_BASE_URL` in `deploy/.env` to that exact URL, restart the gateway, and open the URL in a browser.

## Connect the ring and agent

The web dashboard walks you through both steps:

1. Create an account and a ring token, then copy the webhook URL and token into CoreApp.
2. Create an agent connector and run the login command shown by the dashboard.
3. Start the connector, for example:

```bash
pnpm --filter @pebble/agent-cli dev listen --agent openclaw
```

Leave the gateway, Funnel, and connector running. For an always-on personal setup, use launchd or another process supervisor instead of keeping three Terminal windows open.

## Verify it

```bash
curl --fail https://your-mac.your-tailnet.ts.net/healthz
```

Then send a short ring message. The dashboard should show it moving from received to acknowledged, and your local connector should print the transcript and agent response.
