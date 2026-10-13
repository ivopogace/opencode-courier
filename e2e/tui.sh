#!/usr/bin/env bash
# Live test of the TUI part: a real OpenCode V2 server loads the package's `tui` and `rpc`
# entrypoints, its RPC answers over HTTP, and the TUI, in tmux, shows the prompt footer's entry and
# follows a change, opens the tree panel with /courier tree and stops a child with /courier stop.
# Then the same from the package `opencode plugin add` installs. Driven by e2e/mock-model.mjs's
# COURIER-TUI, so no API key is needed.
#
#   OPENCODE_BIN=/path/to/opencode e2e/tui.sh      # KEEP=1 keeps the temp dir and logs
#
# Needs tmux, and what e2e/run.sh needs.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OPENCODE=${OPENCODE_BIN:-opencode}
MOCK_PORT=${MOCK_PORT:-4599}
SERVER_PORT=${SERVER_PORT:-4600}
REGISTRY_PORT=${REGISTRY_PORT:-4602}
WORK=${E2E_WORK:-$(mktemp -d)}
MOCK_PID=
REGISTRY_PID=
TMUX_SESSION=courier-tui-$$
# shellcheck source=e2e/lib.sh
source "$ROOT/e2e/lib.sh"

command -v tmux >/dev/null || { echo "tmux is needed for the TUI test"; exit 1; }

cleanup() {
  tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
  stop_server
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null
  if [ -n "$REGISTRY_PID" ]; then
    kill "$REGISTRY_PID" 2>/dev/null || true
    "$OPENCODE" service stop >/dev/null 2>&1 </dev/null || true
  fi
  if [ "${KEEP:-}" = 1 ]; then echo "kept $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

failures=0
check() {
  if [ "$2" = true ]; then echo "  PASS $1"; else echo "  FAIL $1"; failures=$((failures + 1)); fi
}
prompt() { (cd "$WORK/project" && "$OPENCODE" run --server "$SERVER" --auto --format json "$1" </dev/null); }
location() { node -p 'encodeURIComponent(process.argv[1])' "$WORK/project"; }
plugins() { api "plugin?directory=$(location)"; }
# The courier's RPC over HTTP: method $1 with input $2, at the project's location.
rpc() {
  curl -s -u "opencode:$OPENCODE_PASSWORD" -X POST "$SERVER/api/rpc/courier/$1?directory=$(location)" \
    -H 'content-type: application/json' -d "{\"input\":$2}"
}
# Waits up to $2 s until the summary of session $1 is $3 (compact JSON); prints the last one read.
summary_until() {
  local last
  for _ in $(seq 1 "$2"); do
    last=$(rpc summary "{\"sessionID\":\"$1\"}" | jq -c '.output')
    [ "$last" = "$3" ] && break
    sleep 1
  done
  echo "$last"
}
# Opens the TUI in a fresh tmux session, 160 columns wide, its stderr to $WORK/$1.err: on session $2, or the home screen.
open_tui() {
  tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
  tmux new-session -d -s "$TMUX_SESSION" -x 160 -y 40 \
    "cd '$WORK/project' && LANG=C.UTF-8 OPENCODE_PASSWORD='$OPENCODE_PASSWORD' TERM=xterm-256color '$OPENCODE' --server '$SERVER' ${2:+--session '$2'} 2>'$WORK/$1.err'; sleep 600"
}
# Whether the TUI's screen shows the line $1 within $2 s; the screen is kept in $WORK/$3.txt.
shows() {
  local shown=false
  for _ in $(seq 1 "$2"); do
    if tmux capture-pane -pt "$TMUX_SESSION" 2>/dev/null | grep -qF -- "$1"; then shown=true; break; fi
    sleep 1
  done
  tmux capture-pane -pt "$TMUX_SESSION" >"$WORK/$3.txt" 2>/dev/null || true
  echo "$shown"
}
kv() { XDG_DATA_HOME=$XDG_DATA_HOME bun "$ROOT/e2e/kv.ts" "$@"; }
# Whether the line $1 is gone from the TUI's screen within $2 s; the screen is kept in $WORK/$3.txt.
hides() {
  local gone=false
  for _ in $(seq 1 "$2"); do
    if ! tmux capture-pane -pt "$TMUX_SESSION" 2>/dev/null | grep -qF -- "$1"; then gone=true; break; fi
    sleep 1
  done
  tmux capture-pane -pt "$TMUX_SESSION" >"$WORK/$3.txt" 2>/dev/null || true
  echo "$gone"
}
# The footer line of the TUI's screen kept in $WORK/$1.txt, the line the courier's entry is on.
footer() { grep -F "courier " "$WORK/$1.txt" | tail -1 || true; }

mkdir -p "$WORK/project" "$HOME" "$XDG_CONFIG_HOME/opencode"
# The slash commands typed below make a prompt history, after which the home screen would open the release highlights over its footer.
echo '{ "highlights": false }' >"$XDG_CONFIG_HOME/opencode/cli.json"
build_plugin

cat >"$WORK/project/opencode.json" <<EOT
{
  "plugins": [{ "package": "$ROOT/dist" }],
  "providers": {
    "mock": {
      "package": "aisdk:@ai-sdk/openai-compatible",
      "settings": { "baseURL": "http://127.0.0.1:$MOCK_PORT/v1", "apiKey": "mock" },
      "models": { "chat": {}, "other": {} }
    }
  },
  "model": "mock/chat",
  "update": "disable",
  "permissions": [
    { "action": "*", "resource": "*", "effect": "allow" },
    { "action": "shell", "resource": "echo courier-asks*", "effect": "ask" }
  ]
}
EOT
commit_config

MOCK_PORT=$MOCK_PORT MOCK_LOG=$WORK/model.log node "$ROOT/e2e/mock-model.mjs" >"$WORK/model.out" 2>&1 </dev/null &
MOCK_PID=$!
start_server
echo "OpenCode $("$OPENCODE" --version) on $SERVER"

echo "the server resolves the tui and rpc entrypoints next to dist/index.js"
# A session first: the plugin list is the inventory of a location that has been booted.
out=$(prompt "COURIER-TUI")
parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
children=$(jq -r 'select(.type == "tool_use" and .part.tool == "courier_spawn" and .part.state.status == "completed") |
  .part.state.metadata.metadata.sessionID' <<<"$out")
echo "  parent $parent, children $(tr '\n' ' ' <<<"$children")"
info=$(plugins | jq -c '.data[] | select(.id == "courier") | {state: .state.status, features}')
echo "  $info"
check "the server reports features server, tui and rpc" "$(jq -r '.features == {server: true, tui: true, rpc: true}' <<<"$info")"

echo "the RPC answers over HTTP with the parent's summary, and refuses what it cannot take"
waiting='{"running":0,"waiting":1,"idle":1,"groups":[{"name":"pair","reported":1,"members":2}]}'
result=$(summary_until "$parent" 60 "$waiting")
echo "  $result"
check "one child waits on the person, one has reported, and group pair holds 1 of 2" "$([ "$result" = "$waiting" ] && echo true || echo false)"
# The two spawns run at once, so the one that asks is told by its request, not by the order they finished in.
asking=$(for child in $children; do if [ "$(api "session/$child/permission" | jq -r '.data | length')" = 1 ]; then echo "$child"; fi; done | head -1)
check "the child that asks is found" "$([ -n "$asking" ] && echo true || echo false)"
bad=$(rpc summary '{"wrong":1}')
echo "  $bad"
check "an input without a session is refused as rpc.invalid_input" "$(jq -r '.type == "rpc.invalid_input"' <<<"$bad")"
check "an unknown method is rpc.method_not_found" "$(rpc nothing '{}' | jq -r '.type == "rpc.method_not_found"')"
check "a session that started none has an empty summary" \
  "$(rpc summary "{\"sessionID\":\"$asking\"}" | jq -r '.output == {running: 0, waiting: 0, idle: 0, groups: []}')"

echo "the TUI shows the entry in the prompt's footer, and follows the answer"
open_tui tui "$parent"
check "the footer shows what the RPC gave" "$(shows "courier 1 waiting on you · 1 idle · group pair 1/2" 60 tui-waiting)"
echo "  $(footer tui-waiting)"
echo "the tree panel: /courier tree opens it on both children, with the bar of the parts reported"
rows=$(rpc tree "{\"sessionID\":\"$parent\"}" | jq -c '[.output.rows[] | {depth, state, report: .report.state, group: .group.standing}] | sort_by(.state)')
echo "  $rows"
check "the RPC's tree: one child reported and held, the other waits on the person and owes its report" \
  "$(jq -r '. == [{depth: 1, state: "idle", report: "reported", group: "held"}, {depth: 1, state: "waiting", report: "owed", group: "out"}]' <<<"$rows")"
tmux send-keys -t "$TMUX_SESSION" "/courier tree"
sleep 1
tmux send-keys -t "$TMUX_SESSION" Enter
check "the panel opens with the bar: 1 of 2 parts reported" "$(shows "courier tree  [█████░░░░░] 1/2 reported" 30 tui-panel)"
check "it has the reported child's row" "$(grep -qF "Report back to your parent.  idle · reported done · group pair held" "$WORK/tui-panel.txt" && echo true || echo false)"
check "and the asking child's, which says what it waits on" \
  "$(grep -qF "CHILD-ASKS  waiting on you · owes a report · group pair out" "$WORK/tui-panel.txt" && grep -qF "asks permission: shell echo courier-asks" "$WORK/tui-panel.txt" && echo true || echo false)"
request=$(api "session/$asking/permission" | jq -r '.data[0].id // empty')
code=$(curl -s -o /dev/null -w '%{http_code}' -u "opencode:$OPENCODE_PASSWORD" -X POST -H 'content-type: application/json' \
  --data '{"decision":"once"}' "$SERVER/api/session/$asking/permission/$request/reply")
check "the person answered the child's request ($request)" "$([ "$code" = 204 ] && echo true || echo false)"
# The child runs the command and reports, which completes the group; it is released to the parent and dropped.
idle='{"running":0,"waiting":0,"idle":2,"groups":[]}'
result=$(summary_until "$parent" 60 "$idle")
echo "  $result"
check "the summary follows: both children idle, the group released" "$([ "$result" = "$idle" ] && echo true || echo false)"
check "the panel follows the report: 2 of 2 parts reported" "$(shows "courier tree  [██████████] 2/2 reported" 30 tui-panel-reported)"
# q closes the panel, which has the keyboard while it is open; the footer is whole again.
tmux send-keys -t "$TMUX_SESSION" q
check "q closes the panel" "$(hides "courier tree" 10 tui-panel-closed)"
check "the footer follows it" "$(shows "courier 2 idle" 30 tui-released)"
echo "  $(footer tui-released)"
check "and the group is gone from it" "$([[ $(footer tui-released) != *"group pair"* ]] && echo true || echo false)"
echo "/courier stop stops a child after a confirm, through courier_stop's path"
refused=$(rpc stop "{\"sessionID\":\"$asking\",\"by\":\"$asking\"}")
echo "  $refused"
check "the RPC refuses a stop from a session not above the target" "$(jq -r '.type == "refused"' <<<"$refused")"
tmux send-keys -t "$TMUX_SESSION" "/courier stop $asking"
sleep 1
tmux send-keys -t "$TMUX_SESSION" Enter
check "a confirm names the child" "$(shows "Stop \"CHILD-ASKS\"" 30 tui-stop-confirm)"
tmux send-keys -t "$TMUX_SESSION" Enter
check "once confirmed, a toast says what was stopped" "$(shows "Stopped 1 session: 0 interrupted" 30 tui-stopped)"
check "and the child is noted stopped, as courier_stop notes it" "$([ -n "$(kv get "report/$asking/stopped")" ] && echo true || echo false)"
open_tui tui-home
# The home screen's own footer, once drawn, without the entry.
check "the entry is not on the home screen of a TUI with no session" \
  "$([ "$(shows "ctrl+p" 60 tui-home)" = true ] && ! grep -qF "courier " "$WORK/tui-home.txt" && echo true || echo false)"

# The asks inbox (#144), in the TUI: its key lists the child's request, and two Enters allow it once
# through OpenCode's reply; the parent is told once that it is settled, and the child carries on.
echo "the asks inbox answers a child's permission request from the TUI"
out=$(prompt "COURIER-ASK")
asker_parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
asker=$(jq -r 'select(.type == "tool_use" and .part.tool == "courier_spawn") | .part.state.metadata.metadata.sessionID' <<<"$out" | head -1)
for _ in $(seq 1 45); do [ "$(api "session/$asker/permission" | jq -r '.data | length')" = 1 ] && break; sleep 1; done
open_tui tui-inbox "$asker_parent"
check "the footer says one waits on the person" "$(shows "courier 1 waiting on you" 60 tui-inbox-footer)"
tmux send-keys -t "$TMUX_SESSION" "/asks"
sleep 1
tmux send-keys -t "$TMUX_SESSION" Enter
check "/asks typed into the prompt opens the inbox" "$(shows "Waiting on you (1)" 20 tui-inbox-slash)"
tmux send-keys -t "$TMUX_SESSION" Escape
check "Escape closes it" "$(hides "Waiting on you" 10 tui-inbox-slash-closed)"
tmux send-keys -t "$TMUX_SESSION" C-x k
check "its key opens the inbox, listing the request with where it comes from" \
  "$([ "$(shows "Permission: shell echo courier-asks" 20 tui-inbox-list)" = true ] && grep -qF "Waiting on you (1)" "$WORK/tui-inbox-list.txt" && echo true || echo false)"
tmux send-keys -t "$TMUX_SESSION" Enter
check "choosing it offers the answers" "$(shows "Allow once" 20 tui-inbox-answers)"
tmux send-keys -t "$TMUX_SESSION" Enter
for _ in $(seq 1 30); do [ "$(api "session/$asker/permission" | jq -r '.data | length')" = 0 ] && break; sleep 1; done
check "the request was answered" "$([ "$(api "session/$asker/permission" | jq -r '.data | length')" = 0 ] && echo true || echo false)"
settled_notices() {
  api "session/$asker_parent/message" | jq -r '[.data[] | select(.type == "synthetic") | .text | select(contains(" answered=\"once\""))] | length'
}
for _ in $(seq 1 30); do [ "$(settled_notices)" = 1 ] && break; sleep 1; done
check "the parent was told once that it is settled" "$(sleep 2; [ "$(settled_notices)" = 1 ] && echo true || echo false)"
check "the child carried on and reported" \
  "$(for _ in $(seq 1 45); do api "session/$asker_parent/message" | jq -e '[.data[] | select(.type == "synthetic") | .text | select(contains("CHILD DONE"))] | length > 0' >/dev/null && { echo true; exit; }; sleep 1; done; echo false)"

# While a form is shown in the session OpenCode renders it in place of the prompt (and hides the footer),
# so the key is the way to the inbox; the relayed question is the form, listed there as its question.
echo "the asks inbox opens by its key while the parent's view shows a form"
out=$(prompt "COURIER-QUESTION")
form_parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
open_tui tui-form "$form_parent"
check "the relayed question is shown as a form in the session" "$(shows "Which greeting?" 60 tui-form)"
tmux send-keys -t "$TMUX_SESSION" C-x k
check "its key opens the inbox over the form, listing the question" \
  "$([ "$(shows "Waiting on you (1)" 20 tui-form-inbox)" = true ] && grep -qF "Which greeting?" "$WORK/tui-form-inbox.txt" && echo true || echo false)"

echo "opencode plugin add installs the package with its tui and rpc entrypoints"
tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
stop_server
rm -rf "$WORK/pack"
mkdir -p "$WORK/pack"
(cd "$ROOT" && npm pack --pack-destination "$WORK/pack" >"$WORK/pack.log" 2>&1) || { cat "$WORK/pack.log"; exit 1; }
tarball=$(ls "$WORK"/pack/*.tgz)
REGISTRY_PORT=$REGISTRY_PORT REGISTRY_TARBALL=$tarball REGISTRY_MANIFEST=$ROOT/package.json node "$ROOT/e2e/registry.mjs" >"$WORK/registry.out" 2>&1 </dev/null &
REGISTRY_PID=$!
for _ in $(seq 1 10); do curl -sf "http://127.0.0.1:$REGISTRY_PORT/opencode-courier" >/dev/null && break; sleep 1; done
curl -sf "http://127.0.0.1:$REGISTRY_PORT/opencode-courier" >/dev/null || { echo "stand-in registry did not start"; cat "$WORK/registry.out"; exit 1; }
export npm_config_registry="http://127.0.0.1:$REGISTRY_PORT/"
added=$( (cd "$WORK/project" && "$OPENCODE" plugin add opencode-courier </dev/null >"$WORK/plugin-add.log" 2>&1) && echo ok || echo failed)
# plugin add starts the background server; this test runs its own.
"$OPENCODE" service stop >/dev/null 2>&1 </dev/null || true
check "plugin add installed it" "$([ "$added" = ok ] && echo true || echo false)"
[ "$added" = ok ] || cat "$WORK/plugin-add.log"
installed=$(ls -d "$XDG_CACHE_HOME"/opencode/npm/opencode-courier@latest/*/node_modules/opencode-courier 2>/dev/null | tail -1)
check "and nothing of the TUI's packages next to it, which the host provides" \
  "$([ -n "$installed" ] && [ ! -e "$(dirname "$installed")/@opentui" ] && [ ! -e "$(dirname "$installed")/solid-js" ] && echo true || echo false)"
jq 'del(.plugins)' "$WORK/project/opencode.json" >"$WORK/project/opencode.json.new"
mv "$WORK/project/opencode.json.new" "$WORK/project/opencode.json"
start_server
# Booted by the RPC call, which waits for the location's plugins.
check "its RPC answers" "$([ "$(summary_until "$parent" 30 "$idle")" = "$idle" ] && echo true || echo false)"
info=$(plugins | jq -c '.data[] | select(.id == "courier") | {state: .state.status, features, source: .source.type}')
echo "  $info"
check "the installed package reports features server, tui and rpc" \
  "$(jq -r '.features == {server: true, tui: true, rpc: true} and .source == "package"' <<<"$info")"
open_tui tui-installed "$parent"
check "the TUI loads the installed package's tui entrypoint and shows the entry" "$(shows "courier 2 idle" 60 tui-installed)"

# What a failed check saw: the screens, and the children's messages, kept with the logs.
if [ "$failures" != 0 ]; then
  for screen in tui-waiting tui-panel tui-panel-reported tui-panel-closed tui-released tui-stop-confirm tui-stopped tui-home tui-inbox-footer tui-inbox-list tui-inbox-answers tui-installed; do
    echo "--- $screen"
    sed -n 1,40p "$WORK/$screen.txt" 2>/dev/null || true
  done
  for child in $children; do api "session/$child/message" >"$WORK/messages-$child.log" 2>&1 || true; done
fi

echo
[ "$failures" = 0 ] && echo "all checks passed" || { echo "$failures check(s) failed"; exit 1; }
