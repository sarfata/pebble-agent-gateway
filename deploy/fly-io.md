# Deploy the gateway to Fly.io

This option keeps the web gateway reachable even when your Mac is asleep. Your AI agent still runs locally through the connector; it is not installed on Fly.io.

## Use the shared relay instead

If you do not need your own deployment, create an account at [pebble-agent-gateway.fly.dev](https://pebble-agent-gateway.fly.dev). The shared community relay is currently free for personal, reasonable use; availability and limits may change and it does not include a paid SLA. Your connector and AI credentials stay on your own computer.

Continue below when you want an isolated instance under your own Fly.io account.

## Before you start

Install and sign in to the Fly CLI:

```bash
brew install flyctl
fly auth login
```

Clone and install the project:

```bash
git clone https://github.com/sarfata/pebble-agent-gateway.git
cd pebble-agent-gateway
corepack enable
pnpm install
```

## First deployment

Pick a unique app name and a nearby Fly region. Replace the example values below:

```bash
fly launch --no-deploy --copy-config --config deploy/fly.toml --name my-pebble-gateway --region sjc
fly volumes create gateway_data --app my-pebble-gateway --region sjc --size 1
```

Generate three independent secrets:

```bash
openssl rand -base64 32
openssl rand -base64 32
openssl rand -base64 32
```

Save them on Fly. Do not paste real secrets into `fly.toml` or commit them to Git:

```bash
fly secrets set --app my-pebble-gateway \
  SESSION_SECRET='first-generated-value' \
  TOKEN_PEPPER='second-generated-value' \
  APP_ENCRYPTION_KEY='third-generated-value' \
  PUBLIC_BASE_URL='https://my-pebble-gateway.fly.dev'
```

Deploy and verify:

```bash
fly deploy --app my-pebble-gateway --config deploy/fly.toml
fly status --app my-pebble-gateway
curl --fail https://my-pebble-gateway.fly.dev/healthz
```

Open `https://my-pebble-gateway.fly.dev`, create your account, and follow the setup guide. Then connect the local agent using the command shown in the dashboard.

The first account created on a fresh instance is marked `admin`. That currently identifies the instance owner and reserves future instance-wide controls; it does not grant access to other accounts' transcripts or resources. For a private deployment, disable further registration after creating the owner:

```bash
fly secrets set --app my-pebble-gateway SIGNUPS_ENABLED=false
```

## Later deployments

From a clean checkout of the version you want to release:

```bash
pnpm test
pnpm build
fly deploy --app my-pebble-gateway --config deploy/fly.toml
curl --fail https://my-pebble-gateway.fly.dev/healthz
```

## Important limits

The current release uses SQLite on one persistent Fly volume. Keep it at one Machine; do not scale horizontally. The default configuration suspends the Machine when idle to save money. Set `min_machines_running = 1` in `deploy/fly.toml` if an always-open connector is more important than the extra cost.

Useful checks:

```bash
fly logs --app my-pebble-gateway
fly ssh console --app my-pebble-gateway
fly volumes list --app my-pebble-gateway
```
