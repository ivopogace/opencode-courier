#!/usr/bin/env bash
# Live end-to-end test: a real OpenCode V2 server with this plugin loaded, driven by a scripted
# stand-in model (e2e/mock-model.mjs), so no API key is needed.
#
#   OPENCODE_BIN=/path/to/opencode2 e2e/run.sh      # KEEP=1 keeps the temp dir and logs
#
# Needs node, bun (for the build), git, curl and jq.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OPENCODE=${OPENCODE_BIN:-opencode2}
MOCK_PORT=${MOCK_PORT:-4599}
SERVER_PORT=${SERVER_PORT:-4600}
CHILD_DELAY_MS=${CHILD_DELAY_MS:-5000}
WORK=$(mktemp -d)
SERVER="http://127.0.0.1:$SERVER_PORT"
PIDS=()

export HOME=$WORK/home XDG_CONFIG_HOME=$WORK/home/.config XDG_DATA_HOME=$WORK/home/.local/share
export XDG_STATE_HOME=$WORK/home/.local/state XDG_CACHE_HOME=$WORK/home/.cache
export OPENCODE_PASSWORD=courier-e2e

cleanup() {
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  if [ "${KEEP:-}" = 1 ]; then echo "kept $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

api() { curl -sf -u "opencode:$OPENCODE_PASSWORD" "$SERVER/api/$1"; }
prompt() { (cd "$WORK/project" && "$OPENCODE" run --server "$SERVER" --auto --format json "$1" </dev/null); }
now_ms() { node -e 'console.log(Date.now())'; }
failures=0
check() {
  if [ "$2" = true ]; then echo "  PASS $1"; else echo "  FAIL $1"; failures=$((failures + 1)); fi
}
# The time a session's assistant message containing $2 was created, waiting up to 30 s for it.
reply_time() {
  for _ in $(seq 1 30); do
    local found
    found=$(api "session/$1/message" | jq -r --arg text "$2" \
      '[.data[] | select(.type == "assistant") | select([.content[]? | select(.type == "text") | .text] | join("") | contains($text)) | .time.created] | first // empty')
    if [ -n "$found" ]; then echo "$found"; return; fi
    sleep 1
  done
}

echo "building plugin"
(cd "$ROOT" && npm run build >/dev/null)

mkdir -p "$WORK/project" "$HOME"
cat >"$WORK/project/opencode.json" <<EOF
{
  "plugins": ["$ROOT/dist"],
  "providers": {
    "mock": {
      "package": "aisdk:@ai-sdk/openai-compatible",
      "settings": { "baseURL": "http://127.0.0.1:$MOCK_PORT/v1", "apiKey": "mock" },
      "models": { "chat": {} }
    }
  },
  "model": "mock/chat",
  "permissions": [{ "action": "*", "resource": "*", "effect": "allow" }]
}
EOF
# Committed, because an isolated child runs in a worktree made from HEAD.
git -C "$WORK/project" init -q
git -C "$WORK/project" add opencode.json
git -C "$WORK/project" -c user.email=e2e@example.com -c user.name=e2e commit -q -m "opencode config"

MOCK_PORT=$MOCK_PORT MOCK_CHILD_DELAY_MS=$CHILD_DELAY_MS MOCK_LOG=$WORK/model.log \
  node "$ROOT/e2e/mock-model.mjs" >"$WORK/model.out" 2>&1 </dev/null &
PIDS+=($!)
(cd "$WORK/project" && exec "$OPENCODE" serve --hostname 127.0.0.1 --port "$SERVER_PORT" --print-logs >"$WORK/server.log" 2>&1 </dev/null) &
PIDS+=($!)
for _ in $(seq 1 30); do grep -q "server listening" "$WORK/server.log" 2>/dev/null && break; sleep 1; done
echo "OpenCode $("$OPENCODE" --version) on $SERVER"

for mode in shared isolate; do
  echo "spawn, then wake the idle parent ($mode)"
  message="COURIER-TEST"
  [ "$mode" = isolate ] && message="COURIER-TEST isolate"
  out=$(prompt "$message")
  turn_ended=$(now_ms)
  spawn=$(jq -c 'select(.type == "tool_use" and .part.tool == "courier_spawn") | .part.state' <<<"$out")
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  directory=$(jq -r '.metadata.metadata.directory // empty' <<<"$spawn")
  check "courier_spawn completed" "$(jq -r '.status == "completed"' <<<"$spawn")"
  if [ "$mode" = isolate ]; then
    check "child runs in its own worktree" "$([[ $directory == */worktree/* ]] && echo true || echo false)"
  fi
  woke=$(reply_time "$parent" "PARENT WOKE")
  check "parent got a new turn after its own had ended" "$([ -n "$woke" ] && [ "$woke" -gt "$turn_ended" ] && echo true || echo false)"
done

echo "courier_status"
out=$(prompt "COURIER-STATUS $parent")
check "reports the parent's last reply" "$(jq -r 'select(.type == "tool_use") | .part.state | .status == "completed" and (.output | contains("PARENT WOKE"))' <<<"$out")"
out=$(prompt "COURIER-STATUS ses_missing")
check "names the error for an unknown session" "$(jq -r 'select(.type == "tool_use") | .part.state.error | contains("NotFoundError")' <<<"$out")"

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed; rerun with KEEP=1 to keep the server and model logs"
  exit 1
fi
echo "all checks passed"
