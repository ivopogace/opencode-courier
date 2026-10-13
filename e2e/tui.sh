#!/usr/bin/env bash
# Live test of the TUI part: a real OpenCode V2 server loads the package's `tui` and `rpc`
# entrypoints, its RPC answers over HTTP, and the TUI, in tmux, shows the prompt footer's entry and
# follows a change. Then the same from the package `opencode plugin add` installs. Driven by
# e2e/mock-model.mjs's COURIER-TUI, so no API key is needed.
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
# Opens the TUI on session $1 in a fresh tmux session, 160 columns wide; its stderr goes to $WORK/$2.err.
open_tui() {
  tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
  tmux new-session -d -s "$TMUX_SESSION" -x 160 -y 40 \
    "cd '$WORK/project' && LANG=C.UTF-8 OPENCODE_PASSWORD='$OPENCODE_PASSWORD' TERM=xterm-256color '$OPENCODE' --server '$SERVER' --session '$1' 2>'$WORK/$2.err'; sleep 600"
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
# The footer line of the TUI's screen kept in $WORK/$1.txt, the line the courier's entry is on.
footer() { grep -F "courier " "$WORK/$1.txt" | tail -1 || true; }

mkdir -p "$WORK/project" "$HOME"
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
children=$(jq -r 'select(.type == "tool_use" and .part.tool == "courier_spawn") | .part.state.metadata.metadata.sessionID' <<<"$out")
asking=$(sed -n 2p <<<"$children")
echo "  parent $parent, children $(tr '\n' ' ' <<<"$children")"
info=$(plugins | jq -c '.data[] | select(.id == "courier") | {state: .state.status, features}')
echo "  $info"
check "the server reports features server, tui and rpc" "$(jq -r '.features == {server: true, tui: true, rpc: true}' <<<"$info")"

echo "the RPC answers over HTTP with the parent's summary, and refuses what it cannot take"
waiting='{"running":0,"waiting":1,"idle":1,"groups":[{"name":"pair","reported":1,"members":2}]}'
result=$(summary_until "$parent" 60 "$waiting")
echo "  $result"
check "one child waits on the person, one has reported, and group pair holds 1 of 2" "$([ "$result" = "$waiting" ] && echo true || echo false)"
bad=$(rpc summary '{"wrong":1}')
echo "  $bad"
check "an input without a session is refused as rpc.invalid_input" "$(jq -r '.type == "rpc.invalid_input"' <<<"$bad")"
check "an unknown method is rpc.method_not_found" "$(rpc nothing '{}' | jq -r '.type == "rpc.method_not_found"')"
check "a session that started none has an empty summary" \
  "$(rpc summary "{\"sessionID\":\"$asking\"}" | jq -r '.output == {running: 0, waiting: 0, idle: 0, groups: []}')"

echo "the TUI shows the entry in the prompt's footer, and follows the answer"
open_tui "$parent" tui
check "the footer shows what the RPC gave" "$(shows "courier 1 waiting on you · 1 idle · group pair 1/2" 60 tui-waiting)"
echo "  $(footer tui-waiting)"
request=$(api "session/$asking/permission" | jq -r '.data[0].id // empty')
code=$(curl -s -o /dev/null -w '%{http_code}' -u "opencode:$OPENCODE_PASSWORD" -X POST -H 'content-type: application/json' \
  --data '{"decision":"once"}' "$SERVER/api/session/$asking/permission/$request/reply")
check "the person answered the child's request ($request)" "$([ "$code" = 204 ] && echo true || echo false)"
# The child runs the command and reports, which completes the group; it is released to the parent and dropped.
idle='{"running":0,"waiting":0,"idle":2,"groups":[]}'
result=$(summary_until "$parent" 60 "$idle")
echo "  $result"
check "the summary follows: both children idle, the group released" "$([ "$result" = "$idle" ] && echo true || echo false)"
check "the footer follows it" "$(shows "courier 2 idle" 30 tui-released)"
echo "  $(footer tui-released)"
check "and the group is gone from it" "$([[ $(footer tui-released) != *"group pair"* ]] && echo true || echo false)"
check "the entry is not on the home screen of a TUI with no session" "$(
  tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
  tmux new-session -d -s "$TMUX_SESSION" -x 160 -y 40 \
    "cd '$WORK/project' && LANG=C.UTF-8 OPENCODE_PASSWORD='$OPENCODE_PASSWORD' TERM=xterm-256color '$OPENCODE' --server '$SERVER' 2>'$WORK/tui-home.err'; sleep 600"
  # The home screen's own footer, once drawn, without the entry.
  if [ "$(shows "ctrl+p" 60 tui-home)" = true ] && ! grep -qF "courier " "$WORK/tui-home.txt"; then echo true; else echo false; fi
)"

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
open_tui "$parent" tui-installed
check "the TUI loads the installed package's tui entrypoint and shows the entry" "$(shows "courier 2 idle" 60 tui-installed)"

# What a failed check saw: the screens, and the children's messages, kept with the logs.
if [ "$failures" != 0 ]; then
  for screen in tui-waiting tui-released tui-home tui-installed; do
    echo "--- $screen"
    sed -n 1,40p "$WORK/$screen.txt" 2>/dev/null || true
  done
  for child in $children; do api "session/$child/message" >"$WORK/messages-$child.log" 2>&1 || true; done
fi

echo
[ "$failures" = 0 ] && echo "all checks passed" || { echo "$failures check(s) failed"; exit 1; }
