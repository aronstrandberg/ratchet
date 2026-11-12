#!/usr/bin/env bash
# Writes .dev.vars from the local OpenCode service's registration, so the gateway can reach it.
# Run it again after the OpenCode service restarts: its port changes.
set -euo pipefail
registration="${XDG_STATE_HOME:-$HOME/.local/state}/opencode/service.json"
cd "$(dirname "$0")/.."
umask 077
jq -r '"OPENCODE_URL=\(.url)\nOPENCODE_PASSWORD=\(.password)"' "$registration" > .dev.vars
echo "wrote .dev.vars for $(jq -r .url "$registration")"
