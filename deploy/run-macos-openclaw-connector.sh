#!/bin/zsh
set -euo pipefail

export PATH="/Users/thomas/.volta/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PEBBLE_OPENCLAW_COMMAND="/opt/homebrew/bin/openclaw"
export PEBBLE_OPENCLAW_ARGS_JSON='["agent","--agent","main","--session-key","agent:main:pebble-ring","--message","{{transcript}}"]'
export PEBBLE_AGENT_TIMEOUT_MS="600000"

cd /Users/thomas/pebble-agent-gateway
exec /Users/thomas/.volta/bin/node apps/agent-cli/dist/main.js listen --agent openclaw
