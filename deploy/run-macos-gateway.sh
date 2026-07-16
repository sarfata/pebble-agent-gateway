#!/bin/zsh
set -euo pipefail

export PATH="/Users/thomas/.volta/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export DATABASE_URL="file:/Users/thomas/Library/Application Support/Pebble Agent Gateway/gateway.sqlite"
export PUBLIC_BASE_URL="https://moon.tail161d.ts.net/pebble"
export PORT="3000"
export SESSION_SECRET="$(/usr/bin/security find-generic-password -a thomas -s pebble-agent-gateway-session-secret -w)"
export TOKEN_PEPPER="$(/usr/bin/security find-generic-password -a thomas -s pebble-agent-gateway-token-pepper -w)"
export APP_ENCRYPTION_KEY="$(/usr/bin/security find-generic-password -a thomas -s pebble-agent-gateway-encryption-key -w)"

cd /Users/thomas/pebble-agent-gateway/apps/gateway
exec /Users/thomas/.volta/bin/node dist/server.js
