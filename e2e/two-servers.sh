#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OPENCODE=${OPENCODE_BIN:-opencode}
MOCK_PORT=${MOCK_PORT:-4609}
SERVER_PORT=${SERVER_PORT:-4610}
OTHER_PORT=${OTHER_PORT:-4611}
CHILD_DELAY_MS=${CHILD_DELAY_MS:-5000}
ROUNDS=${ROUNDS:-10}
TICK_MS=$(sed -n 's/^export const TICK_MS = \([0-9_]*\)$/\1/p' "$ROOT/src/platform/hub.ts" | tr -d _)
[ -n "$TICK_MS" ] || { echo "cannot read TICK_MS from src/platform/hub.ts"; exit 1; }
WORK=${E2E_WORK:-$(mktemp -d)}
MOCK_PID=
OTHER_PID=
STREAM_PIDS=
# shellcheck source=e2e/lib.sh
source "$ROOT/e2e/lib.sh"
OTHER="http://127.0.0.1:$OTHER_PORT"

stop_other() {
  [ -n "$OTHER_PID" ] || return 0
  kill "$OTHER_PID" 2>/dev/null || true
  wait "$OTHER_PID" 2>/dev/null || true
  OTHER_PID=
}
cleanup() {
  stop_server
  stop_other
  for pid in $MOCK_PID $STREAM_PIDS; do kill "$pid" 2>/dev/null || true; done
  if [ "${KEEP:-}" = 1 ]; then echo "kept $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

start_other() {
  (cd "$WORK/project" && exec "$OPENCODE" serve --hostname 127.0.0.1 --port "$OTHER_PORT" --print-logs >>"$WORK/server-b.log" 2>&1 </dev/null) &
  OTHER_PID=$!
  for _ in $(seq 1 30); do curl -sf -u "opencode:$OPENCODE_PASSWORD" "$OTHER/api/info" >/dev/null 2>&1 && return; sleep 1; done
  echo "second OpenCode server did not start; see $WORK/server-b.log"
  exit 1
}
courier_on() {
  local url state
  url="$1/api/plugin?directory=$(node -p 'encodeURIComponent(process.argv[1])' "$WORK/project")"
  for _ in $(seq 1 30); do
    state=$(curl -sf -u "opencode:$OPENCODE_PASSWORD" "$url" | jq -r '.data[] | select(.id == "courier") | .state.status' || true)
    if [ -n "$state" ]; then echo "$state"; return; fi
    sleep 1
  done
  echo missing
}
expect_active() { [ "$2" = active ] || { echo "the plugin is not active on server $1: $2"; exit 1; }; }
record_events() {
  curl -sN -u "opencode:$OPENCODE_PASSWORD" "$1/api/event" >"$2" &
  STREAM_PIDS="$STREAM_PIDS $!"
}
events_in() { sed -n 's/^data: //p' "$1"; }
queued_by() {
  events_in "$1" | jq -rs '[.[] | select(.type == "session.inbox.enqueued") | .data.item.payload.metadata? // {} |
    select(.source == "courier")] | [(map(select(has("scheduled"))) | length), (map(select(has("asks"))) | length),
    (map(select(has("failed"))) | length)] | join(", ")'
}
first_tick() { cat "$@" | sed -n 's/^data: //p' | jq -s '[.[] | select(.type == "session.inbox.enqueued" and
  .data.item.payload.metadata.scheduled? != null) | .created] | min'; }
prompt_on() { (cd "$WORK/project" && "$OPENCODE" run --server "$1" --auto --format json "$2" </dev/null); }
prompt_in_on() { (cd "$WORK/project" && "$OPENCODE" run --server "$1" --auto --format json --session "$2" "$3" </dev/null); }
kv() { XDG_DATA_HOME=$XDG_DATA_HOME bun "$ROOT/e2e/kv.ts" "$@"; }
descends() {
  local pid=$1
  while [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
    [ "$pid" = "$2" ] && return 0
    pid=$(tr '\n' ' ' 2>/dev/null <"/proc/$pid/stat" | sed 's/.*) //' | cut -d' ' -f2 || true)
  done
  return 1
}
owner() {
  local server pid
  server=$(kv get scheduler/owner | jq -r '.server // empty')
  [ -n "$server" ] || { echo none; return; }
  pid=$(cut -d: -f2 <<<"$server")
  if descends "$pid" "$SERVER_PID"; then echo A
  elif [ -n "$OTHER_PID" ] && descends "$pid" "$OTHER_PID"; then echo B
  else echo "another process ($server)"; fi
}
tool_state() { jq -c --arg tool "$1" 'select(.type == "tool_use" and .part.tool == $tool) | .part.state'; }
parent_of() { jq -r 'select(.type == "tool_use") | .sessionID' | head -1; }
now_ms() { date +%s%3N; }
count() { api "session/$1/message" | jq --arg text "$2" '[.data[] | select(.type == "synthetic") | select(.text | contains($text))] | length'; }
wait_for() {
  for _ in $(seq 1 "${3:-45}"); do [ "$(count "$1" "$2")" -gt 0 ] && return; sleep 1; done
  return 1
}
later_rounds() {
  local round parent parents=() scheduling=()
  for round in $(seq 1 "$ROUNDS"); do
    prompt_on "$SERVER" "COURIER-LATER 0.5" >"$WORK/later-$1-$round.json" &
    scheduling+=($!)
  done
  wait "${scheduling[@]}"
  for round in $(seq 1 "$ROUNDS"); do
    [ "$(tool_state courier_later <"$WORK/later-$1-$round.json" | jq -r '.status')" = completed ] ||
      { echo "courier_later did not complete; see $WORK/later-$1-$round.json" >&2; exit 1; }
    parents+=("$(parent_of <"$WORK/later-$1-$round.json")")
  done
  for parent in "${parents[@]}"; do wait_for "$parent" "CHECK-IN" 75 || true; done
  sleep $((2 * TICK_MS / 1000 + 5))
  for parent in "${parents[@]}"; do count "$parent" "CHECK-IN"; done | paste -sd' '
}
failures=0
result() {
  local verdict=as-seen
  [ "$2" = "$3" ] || { verdict="DIFFERS (seen at the pin: $3)"; failures=$((failures + 1)); }
  echo "  $1: $2 [$verdict]"
}
duplicates() { tr ' ' '\n' <<<"$1" | awk '$1 > 1 { d++ } END { print d + 0 }'; }
lost() { tr ' ' '\n' <<<"$1" | awk '$1 == 0 { d++ } END { print d + 0 }'; }

mkdir -p "$WORK/project" "$HOME"
build_plugin
cat >"$WORK/project/opencode.json" <<EOF
{
  "plugins": [{ "package": "$ROOT/dist" }],
  "providers": {
    "mock": {
      "package": "aisdk:@ai-sdk/openai-compatible",
      "settings": { "baseURL": "http://127.0.0.1:$MOCK_PORT/v1", "apiKey": "mock" },
      "models": { "chat": {} }
    }
  },
  "model": "mock/chat",
  "update": "disable",
  "permissions": [
    { "action": "*", "resource": "*", "effect": "allow" },
    { "action": "shell", "resource": "echo courier-asks*", "effect": "ask" }
  ]
}
EOF
commit_config

MOCK_PORT=$MOCK_PORT MOCK_CHILD_DELAY_MS=$CHILD_DELAY_MS MOCK_LOG=$WORK/model.log \
  node "$ROOT/e2e/mock-model.mjs" >"$WORK/model.out" 2>&1 </dev/null &
MOCK_PID=$!
start_server
start_other
version=$("$OPENCODE" --version)
echo "OpenCode $version: server A on $SERVER, server B on $OTHER, one data directory"
echo "  database files: $(cd "$XDG_DATA_HOME" && find . -name '*.db' | tr '\n' ' ')"
record_events "$SERVER" "$WORK/events-a.sse"
record_events "$OTHER" "$WORK/events-b.sse"
courier_on "$SERVER" >"$WORK/courier-a" &
loading=$!
courier_on "$OTHER" >"$WORK/courier-b"
wait "$loading"
expect_active A "$(cat "$WORK/courier-a")"
expect_active B "$(cat "$WORK/courier-b")"
echo "  courier loaded on both, at once"

echo "$ROUNDS courier_later messages fall due while both schedulers tick in step"
in_step=$(later_rounds in-step)
owner_in_step=$(owner)

echo "a child asks for a permission"
out=$(prompt_on "$SERVER" "COURIER-ASK")
parent=$(parent_of <<<"$out")
child=$(jq -r 'select(.type == "tool_use" and .part.tool == "courier_spawn") | .part.state.metadata.metadata.sessionID' <<<"$out" | head -1)
wait_for "$parent" 'asks="permission"' || true
sleep 15
asked=$(count "$parent" 'asks="permission"')
echo "  a line typed into the asking child, through server A, queues behind its request"
curl -sf -u "opencode:$OPENCODE_PASSWORD" -X POST -H 'content-type: application/json' --data '{"text":"TYPED-INTO-CHILD"}' \
  "$SERVER/api/session/$child/prompt" >/dev/null
echo "  the parent answers it with courier_answer in a turn on server B, then on server A"
answered_b=$(prompt_in_on "$OTHER" "$parent" "COURIER-ANSWER once" | tool_state courier_answer)
answer_b=$(jq -r '.metadata.metadata.answered' <<<"$answered_b")
elsewhere_b=$(jq -r '.output | contains("another OpenCode server on the same data directory")' <<<"$answered_b")
answer_a=$(prompt_in_on "$SERVER" "$parent" "COURIER-ANSWER once" | tool_state courier_answer | jq -r '.metadata.metadata.answered')
wait_for "$parent" "route=\"prompt\" in=\"$child\"" || true
typed=$(count "$parent" "route=\"prompt\" in=\"$child\"")

echo "a child's turn fails"
out=$(prompt_on "$SERVER" "COURIER-FAIL")
parent=$(parent_of <<<"$out")
wait_for "$parent" 'failed=' || true
sleep 15
failed=$(count "$parent" 'failed=')

echo "server B restarted, its plugin loaded half a tick after server A's ticks"
tick=$(first_tick "$WORK/events-a.sse" "$WORK/events-b.sse")
[ "$tick" != null ] || { echo "no scheduled message was delivered in step"; exit 1; }
stop_other
owner_b_stopped=$(owner)
start_other
record_events "$OTHER" "$WORK/events-b-restarted.sse"
wait_ms=$(((tick + TICK_MS / 2 - $(now_ms)) % TICK_MS))
[ "$wait_ms" -ge 0 ] || wait_ms=$((wait_ms + TICK_MS))
sleep "$((wait_ms / 1000)).$(printf '%03d' $((wait_ms % 1000)))"
expect_active B "$(courier_on "$OTHER")"
echo "$ROUNDS courier_later messages fall due while the schedulers tick out of step"
out_of_step=$(later_rounds out-of-step)
owner_out_of_step=$(owner)

echo "which server queued the messages, by its event stream (scheduled, permission, failure)"
for events in "$WORK"/events-*.sse; do echo "  $(basename "$events" .sse): $(queued_by "$events")"; done

echo "results (OpenCode $version)"
echo "  deliveries of each courier_later message, schedulers in step: $in_step"
echo "  deliveries of each courier_later message, schedulers out of step: $out_of_step"
echo "  the owner key held by: in step $owner_in_step, B stopped $owner_b_stopped, out of step $owner_out_of_step"
result "messages never delivered" "$(lost "$in_step $out_of_step")" 0
result "messages delivered twice, in step" "$(duplicates "$in_step")" 0
result "messages delivered twice, out of step" "$(duplicates "$out_of_step")" 0
result "notices of the permission request" "$asked" 1
result "courier_answer in a turn on server B reached the request" "$answer_b" false
result "and said the request may wait in another server" "$elsewhere_b" true
result "courier_answer in a turn on server A reached the request" "$answer_a" true
result "envelopes of the line typed into the child" "$typed" 1
result "notices of the failed turn" "$failed" 1
[ "$failures" -eq 0 ] || { echo "$failures result(s) differ from the pinned version's; rerun with KEEP=1 to keep the logs"; exit 1; }
echo "every result is as seen at the pinned version"
