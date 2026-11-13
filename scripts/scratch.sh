#!/usr/bin/env bash
# Runs a scratch Ratchet for trying a change end to end: its own empty state, a stand-in for OpenCode, Linear
# and incident.io (scripts/fake-outside.ts), and the real GitHub, which it only reads. Nothing reaches a real
# session, issue or incident.
#
#   scripts/scratch.sh [port]     Ratchet on the port (9877), the stand-in on the next one
#
# Stop it with Ctrl-C, and start it again to try a change. The running service and its state are not touched.
set -euo pipefail
cd "$(dirname "$0")/.."
port="${1:-9877}"
fake=$((port + 1))
secrets="${XDG_CONFIG_HOME:-$HOME/.config}/ratchet/secrets.env"

bun scripts/fake-outside.ts "$fake" &
trap 'kill $! 2>/dev/null || true' EXIT

umask 077
{
  echo "OPENCODE_URL=http://127.0.0.1:$fake"
  echo "OPENCODE_PASSWORD=none"
  echo "WAKE_SESSIONS=*"
  echo "LINEAR_URL=http://127.0.0.1:$fake/linear/graphql"
  echo "LINEAR_API_KEY=none"
  echo "INCIDENT_IO_URL=http://127.0.0.1:$fake/incident"
  echo "INCIDENT_IO_API_KEY=none"
  # Without a token the scratch Ratchet starts, and reading a pull request fails.
  if [ -f "$secrets" ]; then grep '^GITHUB_TOKEN=' "$secrets" || echo "GITHUB_TOKEN=none"; else echo "GITHUB_TOKEN=none"; fi
} > .dev.vars
rm -rf .celld

# No file watching: this machine runs close to the kernel's limit on file watches. Start it again after a change.
CELLD_ESBUILD="$PWD/node_modules/@esbuild/linux-x64/bin/esbuild" celld dev . --port "$port" --no-watch
