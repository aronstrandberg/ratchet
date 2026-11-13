#!/usr/bin/env bash
# Puts back what a Ratchet with empty state cannot learn from OpenCode: the tasks sessions started, and the
# resources tasks follow with the work status sessions reported. It reads an export from scripts/export.sh
# and calls the session tools as each session.
#
#   scripts/import.sh <directory>
#
# Run it after the gateway has seen OpenCode's sessions (GET /gateway/opencode), and with WAKE_SESSIONS empty,
# or every resource that ended since it was registered wakes its session again.
set -uo pipefail
export_dir="$1"
url="http://127.0.0.1:${RATCHET_PORT:-9876}"

call() {
  curl --silent --max-time 120 "$url/mcp" -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' -H 'MCP-Protocol-Version: 2026-07-28' \
    -H 'Mcp-Method: tools/call' -H "Mcp-Name: $1" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2,\"_meta\":{\"io.modelcontextprotocol/protocolVersion\":\"2026-07-28\",\"io.modelcontextprotocol/clientInfo\":{\"name\":\"import\",\"version\":\"0\"},\"io.modelcontextprotocol/clientCapabilities\":{},\"ai.opencode/sessionID\":\"$3\"}}}" |
    jq -c '.result | if .isError then {error: (.content[0].text // "")[0:200]} else (.structuredContent // {}) end' 2>/dev/null ||
    echo '{"error":"no answer"}'
}

# Registers the resources one exported task follows, as its session, with the status the session reported.
follow() {
  local task="$1" session="$2"
  jq -c --arg task "$task" '[.. | objects | select(.id? == $task)][0].attachments[]' "$export_dir/tree.json" |
    while read -r attachment; do
      resource=$(jq -c .resource <<<"$attachment")
      relation=$(jq -r .relation <<<"$attachment")
      status=$(jq -r .status <<<"$attachment")
      echo "  $resource ($relation): $(call resource_register "{\"resource\":$resource,\"relation\":\"$relation\"}" "$session")"
      if [ "$status" != "unassigned" ]; then
        note=$(jq -c .note <<<"$attachment")
        echo "  $status: $(call resource_set_status "{\"resource\":$resource,\"state\":\"$status\",\"note\":$note}" "$session")"
      fi
    done
}

# A session's first task is its current task in a Ratchet that starts from empty state.
jq -r '[.. | objects | select(.id?)] | .[]
  | select((.id | sub("^tsk_"; "")) as $own | (.sessions | map(sub("^ses_"; "")) | index($own)) != null)
  | select(.attachments | length > 0) | "\(.id) \(.sessions[0])"' "$export_dir/tree.json" |
  while read -r task session; do
    echo "first task $task of $session"
    follow "$task" "$session"
  done

# A started task is recreated, which makes it its session's current task, and then follows its resources.
while read -r task placement; do
  row=$(jq -c --arg task "$task" '[.. | objects | select(.id? == $task)][0]' "$export_dir/tree.json")
  session=$(jq -r '.sessions[0]' <<<"$row")
  echo "started $(jq -r .title <<<"$row") ($placement): $(call task_start "{\"title\":$(jq -c .title <<<"$row"),\"relation\":\"$placement\"}" "$session" | jq -r '.task.id // .error')"
  follow "$task" "$session"
done < "$export_dir/started.txt"
