#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
REPO_DIR="${SCRIPT_DIR:h}"

export PATH="${PATH:-/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}"
export PEBBLE_OPENCLAW_COMMAND="${PEBBLE_OPENCLAW_COMMAND:-$(command -v openclaw)}"
export PEBBLE_OPENCLAW_ARGS_JSON='["agent","--agent","main","--session-key","agent:main:pebble-ring","--message","{{transcript}}"]'
export PEBBLE_AGENT_TIMEOUT_MS="${PEBBLE_AGENT_TIMEOUT_MS:-120000}"

cd "$REPO_DIR"
exec "${NODE_BIN:-$(command -v node)}" apps/agent-cli/dist/main.js listen --agent openclaw
