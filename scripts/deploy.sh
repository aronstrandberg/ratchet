#!/usr/bin/env bash
# Moves the running Ratchet to origin/main.
#
# The service runs from its own checkout, so an edit in a working checkout never reaches it. This checkout
# must be clean and at origin/main, and `bun run check` must pass here before the service's checkout moves.
#
# The service does not watch its files, so the deploy restarts its unit. A restart wakes every cell again:
# the service answers within a minute, and calls that reach a cell still asleep are slow for some minutes more.
set -euo pipefail
live="${RATCHET_LIVE:-${XDG_DATA_HOME:-$HOME/.local/share}/ratchet/live}"
url="http://127.0.0.1:${RATCHET_PORT:-9876}/tree"
cd "$(dirname "$0")/.."

git fetch --quiet origin main
target="$(git rev-parse origin/main)"
if [ "$(git rev-parse HEAD)" != "$target" ] || [ -n "$(git status --porcelain)" ]; then
  echo "deploy: this checkout must be clean and at origin/main (${target:0:7})" >&2
  exit 1
fi
bun run check

if [ ! -d "$live/.git" ]; then
  git clone --quiet "$(git remote get-url origin)" "$live"
  git -C "$live" checkout --quiet --detach "$target"
  (cd "$live" && bun install --frozen-lockfile)
  "$live/scripts/dev-vars.sh"
  echo "deploy: created $live at ${target:0:7}. Start the ratchet unit."
  exit 0
fi

before="$(git -C "$live" rev-parse HEAD)"
if [ "$before" = "$target" ]; then
  echo "deploy: the service is already at ${target:0:7}"
  exit 0
fi
git -C "$live" fetch --quiet origin main
git -C "$live" checkout --quiet --detach "$target"
if ! git -C "$live" diff --quiet "$before" "$target" -- bun.lock package.json; then
  (cd "$live" && bun install --frozen-lockfile)
fi

systemctl --user restart "${RATCHET_UNIT:-ratchet.service}"

for _ in $(seq 1 300); do
  if curl --silent --fail --max-time 5 --output /dev/null "$url"; then
    echo "deploy: the service is at ${target:0:7} and answers"
    exit 0
  fi
  sleep 1
done
echo "deploy: the service does not answer on $url after moving from ${before:0:7} to ${target:0:7}" >&2
exit 1
