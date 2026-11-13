#!/usr/bin/env bash
# Saves what Ratchet knows that OpenCode does not: the tasks, the resources they follow and what sessions
# reported about their work. scripts/import.sh puts it back into a Ratchet that starts from empty state.
#
#   scripts/export.sh [directory]     default: ~/.local/share/ratchet/export-<date>
set -euo pipefail
url="http://127.0.0.1:${RATCHET_PORT:-9876}"
out="${1:-${XDG_DATA_HOME:-$HOME/.local/share}/ratchet/export-$(date +%Y%m%d-%H%M)}"
mkdir -p "$out"
curl --silent --fail --max-time 120 "$url/tree" > "$out/tree.json"
curl --silent --fail --max-time 120 "$url/resources" > "$out/resources.json"
# The tasks sessions started themselves, parents before children, each with how to start it again: as a
# child of the task its session is on by then, or as a sibling of it. A session is on its first task to begin
# with, and on each task it starts from then on.
# The board lists the latest change first, so the lists are read backwards: the task a session is on now is
# started last.
jq -r '
  def started: (.id | sub("^tsk_"; "")) as $own | (.sessions | map(sub("^ses_"; "")) | index($own)) == null;
  def flat: ., (.children | reverse | .[] | flat);
  [reverse | .[] | flat] as $tasks
  | ($tasks | map({key: .id, value: .parent}) | from_entries) as $parent
  | reduce ($tasks[] | select(started)) as $task ({on: {}, lines: []};
      ($task.sessions[0]) as $session
      | (.on[$session] // ("tsk_" + ($session | sub("^ses_"; "")))) as $current
      | .lines += ["\($task.id) \(if $task.parent == $current then "child" elif $task.parent == $parent[$current] then "sibling" else "child" end)"]
      | .on[$session] = $task.id)
  | .lines[]' "$out/tree.json" > "$out/started.txt"
echo "export: $(jq '[.. | objects | select(.id?)] | length' "$out/tree.json") tasks, $(jq length "$out/resources.json") resources, $(wc -l < "$out/started.txt") started tasks in $out"
