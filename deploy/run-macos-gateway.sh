#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
REPO_DIR="${SCRIPT_DIR:h}"
KEYCHAIN_ACCOUNT="${KEYCHAIN_ACCOUNT:-$(/usr/bin/id -un)}"

export PATH="${PATH:-/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}"
export DATABASE_URL="${DATABASE_URL:-file:${HOME}/Library/Application Support/Pebble Agent Gateway/gateway.sqlite}"
: "${PUBLIC_BASE_URL:?Set PUBLIC_BASE_URL to the public gateway URL}"
export PORT="${PORT:-3000}"
export SESSION_SECRET="${SESSION_SECRET:-$(/usr/bin/security find-generic-password -a "$KEYCHAIN_ACCOUNT" -s pebble-agent-gateway-session-secret -w)}"
export TOKEN_PEPPER="${TOKEN_PEPPER:-$(/usr/bin/security find-generic-password -a "$KEYCHAIN_ACCOUNT" -s pebble-agent-gateway-token-pepper -w)}"
export APP_ENCRYPTION_KEY="${APP_ENCRYPTION_KEY:-$(/usr/bin/security find-generic-password -a "$KEYCHAIN_ACCOUNT" -s pebble-agent-gateway-encryption-key -w)}"

cd "$REPO_DIR/apps/gateway"
exec "${NODE_BIN:-$(command -v node)}" dist/server.js
