#!/usr/bin/env bash
# Experiment, not in CI: two OpenCode servers on one data directory, both with this plugin loaded,
# driven by the scripted stand-in model (e2e/mock-model.mjs), so no API key is needed. It counts,
# from a real run, how often courier tells a session something when both servers run:
#
#   - courier_later messages that fall due while both schedulers tick in step, then out of step,
#     and which server holds the scheduler's owner key (scheduler/owner) that picks the one to deliver;
#   - a child's permission request, and whether courier_answer reaches it from the other server, or
#     says there that the request may wait in another server;
#   - a child whose turn fails.
#
#   OPENCODE_BIN=/path/to/opencode e2e/two-servers.sh     # KEEP=1 keeps the temp dir and logs
#
# Both servers run in the same project with the same HOME and XDG directories, so they open the
# same database, and with it the same plugin storage. Prompts go to server A; server B has the
# plugin loaded for the project, so its scheduler and its watcher run, and is prompted only to try
# courier_answer there. ROUNDS (default 10) sets how many courier_later messages are scheduled each
# time. Each server's event stream (/api/event) is recorded in events-a.sse and events-b*.sse,
# which shows which server queued each message. Results and the setup are in
# docs/plugin-api-notes.md; the script exits 1 when a result differs from what was seen at the
# pinned version, so a host where two servers behave differently stands out. Whether the two
# schedulers' ticks fall within milliseconds of each other depends on how long each server takes to
# set the plugin up, and varies from run to run; since the owner key, only one of them delivers
# either way, and a message delivered twice is a result that differs.
#
# Needs node and npm, bun (for the build), git, curl and jq.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OPENCODE=${OPENCODE_BIN:-opencode}
MOCK_PORT=${MOCK_PORT:-4609}
SERVER_PORT=${SERVER_PORT:-4610}
OTHER_PORT=${OTHER_PORT:-4611}
CHILD_DELAY_MS=${CHILD_DELAY_MS:-5000}
ROUNDS=${ROUNDS:-10}
# How often each scheduler looks for due messages: src/later.ts's TICK_MS.
TICK_MS=$(sed -n 's/^export const TICK_MS = \([0-9_]*\)$/\1/p' "$ROOT/src/later.ts" | tr -d _)
[ -n "$TICK_MS" ] || { echo "cannot read TICK_MS from src/later.ts"; exit 1; }
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

# Server B: the same command as start_server, on another port, logging to server-b.log. Started
# only once server A is up: two servers starting at once on a new data directory race to create
# its tables, and the loser exits ("table `account_state` already exists").
start_other() {
  (cd "$WORK/project" && exec "$OPENCODE" serve --hostname 127.0.0.1 --port "$OTHER_PORT" --print-logs >>"$WORK/server-b.log" 2>&1 </dev/null) &
  OTHER_PID=$!
  for _ in $(seq 1 30); do curl -sf -u "opencode:$OPENCODE_PASSWORD" "$OTHER/api/info" >/dev/null 2>&1 && return; sleep 1; done
  echo "second OpenCode server did not start; see $WORK/server-b.log"
  exit 1
}
# The state of the plugin on server $1 in the project's location: the first call loads the
# location's plugins, which are listed once loaded.
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
# Records server $1's event stream, as it comes (server-sent events), into $2.
record_events() {
  curl -sN -u "opencode:$OPENCODE_PASSWORD" "$1/api/event" >"$2" &
  STREAM_PIDS="$STREAM_PIDS $!"
}
# The events recorded in $1, one JSON event per line.
events_in() { sed -n 's/^data: //p' "$1"; }
# How many courier messages the server whose stream is in $1 queued for sessions: synthetic messages
# whose metadata carries "scheduled", "asks" and "failed", the three counts in that order.
queued_by() {
  events_in "$1" | jq -rs '[.[] | select(.type == "session.inbox.enqueued") | .data.item.payload.metadata? // {} |
    select(.source == "courier")] | [(map(select(has("scheduled"))) | length), (map(select(has("asks"))) | length),
    (map(select(has("failed"))) | length)] | join(", ")'
}
# When the schedulers ticked in step: the time, in ms, the first scheduled message was queued.
first_tick() { cat "$@" | sed -n 's/^data: //p' | jq -s '[.[] | select(.type == "session.inbox.enqueued" and
  .data.item.payload.metadata.scheduled? != null) | .created] | min'; }
prompt_on() { (cd "$WORK/project" && "$OPENCODE" run --server "$1" --auto --format json "$2" </dev/null); }
prompt_in_on() { (cd "$WORK/project" && "$OPENCODE" run --server "$1" --auto --format json --session "$2" "$3" </dev/null); }
kv() { XDG_DATA_HOME=$XDG_DATA_HOME bun "$ROOT/e2e/kv.ts" "$@"; }
# Whether process $1 is process $2 or one of its descendants.
descends() {
  local pid=$1
  while [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
    [ "$pid" = "$2" ] && return 0
    # The parent's id, the second field after the process name, which may hold spaces or parentheses.
    pid=$(tr '\n' ' ' 2>/dev/null <"/proc/$pid/stat" | sed 's/.*) //' | cut -d' ' -f2 || true)
  done
  return 1
}
# The server holding the scheduler's owner key, A or B by the process id in its id
# (<host>:<pid>:<start>), or "none".
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
# How many synthetic messages of session $1 contain $2.
count() { api "session/$1/message" | jq --arg text "$2" '[.data[] | select(.type == "synthetic") | select(.text | contains($text))] | length'; }
# Waits until session $1 has a synthetic message containing $2, up to $3 (default 45) s; fails if
# it never comes.
wait_for() {
  for _ in $(seq 1 "${3:-45}"); do [ "$(count "$1" "$2")" -gt 0 ] && return; sleep 1; done
  return 1
}
# Schedules ROUNDS courier_later messages through server A at once, waits for them and for two
# more ticks, and prints how many times each was delivered. Scheduled in parallel, they fall due
# within a few seconds of each other, mostly in the same tick of each scheduler.
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
# Prints a result and compares it with the one seen at the pinned version.
result() {
  local verdict=as-seen
  [ "$2" = "$3" ] || { verdict="DIFFERS (seen at the pin: $3)"; failures=$((failures + 1)); }
  echo "  $1: $2 [$verdict]"
}
# How many of the counts in $1 are above one.
duplicates() { tr ' ' '\n' <<<"$1" | awk '$1 > 1 { d++ } END { print d + 0 }'; }
# How many of the counts in $1 are zero: messages never delivered.
lost() { tr ' ' '\n' <<<"$1" | awk '$1 == 0 { d++ } END { print d + 0 }'; }

mkdir -p "$WORK/project" "$HOME"
build_plugin
# No webhook receiver: both servers would bind its port.
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
# Loaded on both at once, so the two schedulers tick in step, some milliseconds apart.
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
wait_for "$parent" 'asks="permission"' || true
sleep 15
asked=$(count "$parent" 'asks="permission"')
echo "  the parent answers it with courier_answer in a turn on server B, then on server A"
answered_b=$(prompt_in_on "$OTHER" "$parent" "COURIER-ANSWER once" | tool_state courier_answer)
answer_b=$(jq -r '.metadata.metadata.answered' <<<"$answered_b")
elsewhere_b=$(jq -r '.output | contains("another OpenCode server on the same data directory")' <<<"$answered_b")
answer_a=$(prompt_in_on "$SERVER" "$parent" "COURIER-ANSWER once" | tool_state courier_answer | jq -r '.metadata.metadata.answered')

echo "a child's turn fails"
out=$(prompt_on "$SERVER" "COURIER-FAIL")
parent=$(parent_of <<<"$out")
wait_for "$parent" 'failed=' || true
sleep 15
failed=$(count "$parent" 'failed=')

echo "server B restarted, its plugin loaded half a tick after server A's ticks"
# A's ticks fall where the first round's deliveries were queued, by either stream (in step, they
# were milliseconds apart); B's scheduler ticks first when its plugin is set up, a moment after the
# load is asked for, which is left out.
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
# Not compared: which server took the key first, A or B, varies from run to run.
echo "  the owner key held by: in step $owner_in_step, B stopped $owner_b_stopped, out of step $owner_out_of_step"
result "messages never delivered" "$(lost "$in_step $out_of_step")" 0
result "messages delivered twice, in step" "$(duplicates "$in_step")" 0
result "messages delivered twice, out of step" "$(duplicates "$out_of_step")" 0
result "notices of the permission request" "$asked" 1
result "courier_answer in a turn on server B reached the request" "$answer_b" false
result "and said the request may wait in another server" "$elsewhere_b" true
result "courier_answer in a turn on server A reached the request" "$answer_a" true
result "notices of the failed turn" "$failed" 1
[ "$failures" -eq 0 ] || { echo "$failures result(s) differ from the pinned version's; rerun with KEEP=1 to keep the logs"; exit 1; }
echo "every result is as seen at the pinned version"
