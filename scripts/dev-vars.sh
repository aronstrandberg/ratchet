#!/usr/bin/env bash
# Writes .dev.vars: the local OpenCode service's URL and password from its registration, then the NAME=value
# lines of ~/.config/ratchet/secrets.env (such as GITHUB_TOKEN) and settings.env (such as WAKE_SESSIONS).
# The OpenCode port changes when its service restarts, so this runs again then.
set -euo pipefail
registration="${XDG_STATE_HOME:-$HOME/.local/state}/opencode/service.json"
config="${XDG_CONFIG_HOME:-$HOME/.config}/ratchet"
cd "$(dirname "$0")/.."
umask 077
{
  jq -r '"OPENCODE_URL=\(.url)\nOPENCODE_PASSWORD=\(.password)"' "$registration"
  for file in "$config/secrets.env" "$config/settings.env"; do
    if [ -f "$file" ]; then cat "$file"; fi
  done
} > .dev.vars.tmp
mv .dev.vars.tmp .dev.vars
echo "wrote .dev.vars for $(jq -r .url "$registration")"
