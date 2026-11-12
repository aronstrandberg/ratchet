#!/usr/bin/env bash
# Writes .dev.vars: the local OpenCode service's URL and password from its registration, then the
# secrets in ~/.config/ratchet/secrets.env (NAME=value lines, such as GITHUB_TOKEN) when that file exists.
# The OpenCode port changes when its service restarts, so this runs again then.
set -euo pipefail
registration="${XDG_STATE_HOME:-$HOME/.local/state}/opencode/service.json"
secrets="${XDG_CONFIG_HOME:-$HOME/.config}/ratchet/secrets.env"
cd "$(dirname "$0")/.."
umask 077
{
  jq -r '"OPENCODE_URL=\(.url)\nOPENCODE_PASSWORD=\(.password)"' "$registration"
  if [ -f "$secrets" ]; then cat "$secrets"; fi
} > .dev.vars.tmp
mv .dev.vars.tmp .dev.vars
echo "wrote .dev.vars for $(jq -r .url "$registration")"
