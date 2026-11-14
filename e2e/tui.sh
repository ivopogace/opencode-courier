#!/usr/bin/env bash
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
api_prompt() { curl -sf -u "opencode:$OPENCODE_PASSWORD" -X POST -H 'content-type: application/json' --data "{\"text\":\"$2\"}" "$SERVER/api/session/$1/prompt" >/dev/null; }
prompt_in() { (cd "$WORK/project" && "$OPENCODE" run --server "$SERVER" --auto --format json --session "$1" "$2" </dev/null); }
location() { node -p 'encodeURIComponent(process.argv[1])' "$WORK/project"; }
plugins() { api "plugin?directory=$(location)"; }
rpc() {
  curl -s -u "opencode:$OPENCODE_PASSWORD" -X POST "$SERVER/api/rpc/courier/$1?directory=$(location)" \
    -H 'content-type: application/json' -d "{\"input\":$2}"
}
person_rpc() {
  curl -s -u "opencode:$OPENCODE_PASSWORD" -X POST "$SERVER/api/rpc/courier-person/$1?directory=$(location)" \
    -H 'content-type: application/json' -d "{\"input\":$2}"
}
rpc_ready() {
  for _ in $(seq 1 30); do "$@" | jq -e 'has("output")' >/dev/null 2>&1 && return; sleep 1; done
}
summary_until() {
  local last
  for _ in $(seq 1 "$2"); do
    last=$(rpc summary "{\"sessionID\":\"$1\"}" | jq -c '.output')
    [ "$last" = "$3" ] && break
    sleep 1
  done
  echo "$last"
}
open_tui() {
  tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
  tmux new-session -d -s "$TMUX_SESSION" -x "${COLS:-220}" -y 40 \
    "cd '$WORK/project' && LANG=C.UTF-8 OPENCODE_PASSWORD='$OPENCODE_PASSWORD' TERM=xterm-256color '$OPENCODE' --server '$SERVER' ${2:+--session '$2'} 2>'$WORK/$1.err'; sleep 600"
}
shows() {
  local shown=false
  for _ in $(seq 1 "$2"); do
    if tmux capture-pane -pt "$TMUX_SESSION" 2>/dev/null | grep -qF -- "$1"; then shown=true; break; fi
    sleep 1
  done
  tmux capture-pane -pt "$TMUX_SESSION" >"$WORK/$3.txt" 2>/dev/null || true
  echo "$shown"
}
shows_with() {
  local shown=false
  for _ in $(seq 1 "$(($2 * 2))"); do
    tmux capture-pane -pt "$TMUX_SESSION" >"$WORK/$3.txt" 2>/dev/null || true
    if grep -qF -- "$1" "$WORK/$3.txt" && "$4" "$WORK/$3.txt"; then shown=true; break; fi
    sleep 0.5
  done
  echo "$shown"
}
submit() {
  tmux send-keys -t "$TMUX_SESSION" "$1"
  shows "$1" 10 submit >/dev/null
  tmux send-keys -t "$TMUX_SESSION" Enter
}
kv() { XDG_DATA_HOME=$XDG_DATA_HOME bun "$ROOT/e2e/kv.ts" "$@"; }
hides() {
  local gone=false
  for _ in $(seq 1 "$2"); do
    if ! tmux capture-pane -pt "$TMUX_SESSION" 2>/dev/null | grep -qF -- "$1"; then gone=true; break; fi
    sleep 1
  done
  tmux capture-pane -pt "$TMUX_SESSION" >"$WORK/$3.txt" 2>/dev/null || true
  echo "$gone"
}
footer() { grep -F "courier " "$WORK/$1.txt" | tail -1 || true; }
under_digby() {
  node -e '
    const screen = require("fs").readFileSync(process.argv[1], "utf8").replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/gu, "")
    const lines = [[]]
    let bg = ""
    for (const part of screen.split(/(\x1b\[[0-9;]*m)/u)) {
      const sgr = /^\x1b\[([0-9;]*)m$/u.exec(part)
      if (!sgr) {
        for (const char of part) char === "\n" ? lines.push([]) : lines.at(-1).push({ char, bg })
        continue
      }
      const codes = sgr[1].split(";")
      for (let i = 0; i < codes.length; i++) {
        const code = Number(codes[i] || 0)
        const width = codes[i + 1] === "2" ? 4 : 2
        if (code === 0 || code === 49) bg = ""
        else if (code === 48) (bg = codes.slice(i, i + 1 + width).join(";")), (i += width)
        else if (code === 38) i += width
        else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) bg = String(code)
      }
    }
    const groundAt = (line) => line.findIndex((_, at) => line.slice(at, at + 16).every((one) => one.char === "█") && line.length >= at + 16)
    const ground = lines.findLastIndex((line) => groundAt(line) > 0)
    const column = ground < 7 ? -1 : groundAt(lines[ground])
    const wrong = []
    for (let y = ground - 7; column > 0 && y <= ground; y++)
      for (let x = column; x < column + 16; x++)
        if (lines[y][x]?.bg !== lines[y][column - 1]?.bg) wrong.push(`line ${y} column ${x} "${lines[y][x]?.char}": ${lines[y][x]?.bg} under ${lines[y][column - 1]?.bg}`)
    if (column < 0) console.error("no 16×16 Digby on the screen")
    for (const one of wrong) console.error(one)
    console.log(column > 0 && !wrong.length)
  ' "$WORK/$1.ansi"
}
SPINS='[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] .*\(on screen\)'
spins() {
  local shown=false
  for _ in $(seq 1 "$1"); do
    if tmux capture-pane -pt "$TMUX_SESSION" 2>/dev/null | LC_ALL=C.UTF-8 grep -qE -- "$SPINS"; then shown=true; break; fi
    sleep 1
  done
  tmux capture-pane -pt "$TMUX_SESSION" >"$WORK/$2.txt" 2>/dev/null || true
  echo "$shown"
}
hides_spinner() {
  local gone=false
  for _ in $(seq 1 "$1"); do
    if ! tmux capture-pane -pt "$TMUX_SESSION" 2>/dev/null | LC_ALL=C.UTF-8 grep -qE -- "$SPINS"; then gone=true; break; fi
    sleep 1
  done
  tmux capture-pane -pt "$TMUX_SESSION" >"$WORK/$2.txt" 2>/dev/null || true
  echo "$gone"
}
awake() {
  local awake=true
  for n in $(seq 1 "$1"); do
    tmux capture-pane -pt "$TMUX_SESSION" >"$WORK/$2-$n.txt" 2>/dev/null || true
    node -e '
      const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n").map((line) => [...line])
      const groundAt = (line) => line.findIndex((_, at) => line.length >= at + 16 && line.slice(at, at + 16).every((one) => one === "█"))
      const ground = lines.findLastIndex((line) => groundAt(line) > 0)
      const column = ground < 7 ? -1 : groundAt(lines[ground])
      const art = lines.slice(ground - 7, ground + 1).map((line) => line.slice(column, column + 16).join(""))
      process.exit(column > 0 && !art.some((line) => line.includes("z")) ? 0 : 1)
    ' "$WORK/$2-$n.txt" || awake=false
    sleep 0.5
  done
  echo "$awake"
}
digby_settles() {
  local settled=false
  for _ in $(seq 1 "$1"); do
    tmux capture-pane -Nept "$TMUX_SESSION" >"$WORK/$2.ansi" 2>/dev/null || true
    if [ "$(under_digby "$2" 2>/dev/null)" = true ]; then settled=true; break; fi
    sleep 1
  done
  under_digby "$2" >/dev/null || true
  echo "$settled"
}

mkdir -p "$WORK/project" "$HOME" "$XDG_CONFIG_HOME/opencode"
echo '{ "highlights": false }' >"$XDG_CONFIG_HOME/opencode/cli.json"
build_plugin

cat >"$WORK/project/opencode.json" <<EOT
{
  "plugins": [{ "package": "$ROOT/dist", "options": { "maxTotal": 2 } }, "$ROOT/e2e/search-plugin"],
  "providers": {
    "mock": {
      "package": "aisdk:@ai-sdk/openai-compatible",
      "settings": { "baseURL": "http://127.0.0.1:$MOCK_PORT/v1", "apiKey": "mock" },
      "models": { "chat": { "limit": { "context": 200000, "output": 4096 } }, "other": {} }
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
check "the footer shows what the RPC gave" "$(shows "courier 1 waiting on you · group pair 1/2 · 1 idle" 60 tui-waiting)"
echo "  $(footer tui-waiting)"
echo "the tree panel: /courier tree opens it on both children, with the bar of the parts reported"
rows=$(rpc tree "{\"sessionID\":\"$parent\"}" | jq -c '[.output.rows[] | {depth, state, report: .report.state, group: .group.standing}] | sort_by(.state)')
echo "  $rows"
check "the RPC's tree: one child reported and held, the other waits on the person and owes its report" \
  "$(jq -r '. == [{depth: 1, state: "idle", report: "reported", group: "held"}, {depth: 1, state: "waiting", report: "owed", group: "out"}]' <<<"$rows")"
top=$(rpc tree "{\"sessionID\":\"$parent\"}" | jq -c '.output.top | {sessionID, depth}')
echo "  $top"
check "the RPC's tree carries the parent itself as its top row, at depth 0 (#395)" \
  "$(jq -r --arg parent "$parent" '. == {sessionID: $parent, depth: 0}' <<<"$top")"
contexts=$(rpc tree "{\"sessionID\":\"$parent\"}" | jq -c '[.output.rows[].context]')
echo "  $contexts"
check "the RPC's tree carries a mock-model child's context use: a fraction of the model's window" \
  "$(jq -r 'map(select(. != null)) | length > 0 and all(. > 0 and . <= 1)' <<<"$contexts")"
submit "/courier tree"
check "the panel opens with the bar: 1 of 2 parts reported" "$(shows "courier tree  [█████░░░░░] 1/2 reported" 30 tui-panel)"
check "its first row is the parent, on screen and selected (#395)" "$(grep -qE '▸ . .*\(on screen\)' "$WORK/tui-panel.txt" && echo true || echo false)"
check "it has the reported child's row" "$(grep -qF "✓ Report back to your parent.  idle · reported done · group pair held" "$WORK/tui-panel.txt" && echo true || echo false)"
check "and the asking child's, which says what it waits on" \
  "$(grep -qF "● CHILD-ASKS  waiting on you · owes a report · group pair out" "$WORK/tui-panel.txt" && grep -qF "asks permission: shell echo courier-asks" "$WORK/tui-panel.txt" && echo true || echo false)"
check "the 16×16 Digby shows below the rows, the header without its glyph" \
  "$([ "$(shows "████████████████" 15 tui-panel-digby)" = true ] && ! grep -qE '[▀▄█] +courier tree' "$WORK/tui-panel-digby.txt" && echo true || echo false)"
request=$(api "session/$asking/permission" | jq -r '.data[0].id // empty')
code=$(curl -s -o /dev/null -w '%{http_code}' -u "opencode:$OPENCODE_PASSWORD" -X POST -H 'content-type: application/json' \
  --data '{"decision":"once"}' "$SERVER/api/session/$asking/permission/$request/reply")
check "the person answered the child's request ($request)" "$([ "$code" = 204 ] && echo true || echo false)"
idle='{"running":0,"waiting":0,"idle":2,"groups":[]}'
result=$(summary_until "$parent" 60 "$idle")
echo "  $result"
check "the summary follows: both children idle, the group released" "$([ "$result" = "$idle" ] && echo true || echo false)"
check "the panel follows the report: 2 of 2 parts reported" "$(shows "courier tree  [██████████] 2/2 reported" 30 tui-panel-reported)"
check "once the report's pose ends, the 16×16 Digby keeps no background of the poses before" "$(digby_settles 15 tui-panel-settled)"
api_prompt "$parent" "PARENT-BUSY"
check "the parent's own row spins while it runs, its children idle" "$(spins 30 tui-panel-parent-runs)"
check "and Digby does not sleep through it" "$(awake 6 tui-panel-parent-awake)"
check "the parent's turn ends" "$(hides_spinner 30 tui-panel-parent-done)"
tmux send-keys -t "$TMUX_SESSION" q
check "q closes the panel" "$(hides "courier tree" 10 tui-panel-closed)"
check "the footer follows it" "$(shows "courier 2 idle" 30 tui-released)"
echo "  $(footer tui-released)"
check "and the group is gone from it" "$([[ $(footer tui-released) != *"group pair"* ]] && echo true || echo false)"
submit "/courier tree"
check "the panel opens again" "$(shows "courier tree  [██████████] 2/2 reported" 30 tui-panel-again)"
check "the parent's own row is selected first" "$(grep -qE '▸ +[^✓].*\(on screen\)' "$WORK/tui-panel-again.txt" && echo true || echo false)"
tmux send-keys -t "$TMUX_SESSION" Down
check "down selects the first child, its branch drawn" "$(shows "▸ ├ ✓ " 30 tui-panel-down)"
tmux send-keys -t "$TMUX_SESSION" Enter
check "enter on a child row keeps the panel in the child's view, the child marked" "$(shows "(on screen)  idle · reported done" 30 tui-panel-followed)"
check "with the parent's tree" "$(grep -qF "courier tree  [██████████] 2/2 reported" "$WORK/tui-panel-followed.txt" && echo true || echo false)"
other="CHILD-ASKS"
grep -qF "CHILD-ASKS (on screen)" "$WORK/tui-panel-followed.txt" && other="Report back to your parent."
click_line=$(grep -nF "$other  idle" "$WORK/tui-panel-followed.txt" | tail -1 | cut -d: -f1 || true)
click_column=$(grep -F "$other  idle" "$WORK/tui-panel-followed.txt" | tail -1 | sed "s/$other  idle.*//" | LC_ALL=C.UTF-8 wc -m || true)
check "the other child's row is on screen to click" "$([ -n "$click_line" ] && echo true || echo false)"
tmux send-keys -t "$TMUX_SESSION" -l "$(printf '\033[<0;%d;%dM' $((click_column)) "$click_line")"
tmux send-keys -t "$TMUX_SESSION" -l "$(printf '\033[<0;%d;%dm' $((click_column)) "$click_line")"
check "a click on its row opens that child, the panel following it there" "$(shows "$other (on screen)" 30 tui-panel-clicked)"
tmux send-keys -t "$TMUX_SESSION" C-x n
check "the home screen of /new hides the panel" "$(hides "courier tree" 10 tui-panel-home)"
tmux send-keys -t "$TMUX_SESSION" C-x
sleep 0.3
tmux send-keys -t "$TMUX_SESSION" 1
check "back on the parent, the panel shows again" "$(shows "courier tree  [██████████] 2/2 reported" 30 tui-panel-back)"
tmux send-keys -t "$TMUX_SESSION" q
check "q closes it there" "$(hides "courier tree" 10 tui-panel-followed-closed)"
echo "a panel opened at 100 columns splits once the terminal is widened and the panel followed"
COLS=100 open_tui tui-narrow "$parent"
check "the TUI is open at 100 columns" "$(shows "courier 2 idle" 60 tui-narrow-footer)"
submit "/courier tree"
check "the panel opens" "$(shows "courier tree  [██████████] 2/2 reported" 30 tui-narrow-panel)"
tmux resize-window -t "$TMUX_SESSION" -x 160 -y 40
sleep 1
tmux send-keys -t "$TMUX_SESSION" Enter
check "followed into a child at 160 columns" "$(shows "✓ Report back to your parent." 30 tui-widened)"
check "the panel sits beside the session, not over it" \
  "$(awk '/courier tree/ { if (index($0, "courier tree") > 40) found = 1 } END { print found ? "true" : "false" }' "$WORK/tui-widened.txt")"
open_tui tui "$parent"
check "the TUI is back on the parent" "$(shows "courier 2 idle" 60 tui-parent-again)"
echo "/courier stop is no verb: it shows the usage and stops nothing"
submit "/courier stop $asking"
check "/courier stop shows the usage in a toast, and no confirm" \
  "$([ "$(shows "/courier tree opens the session tree" 30 tui-stop-usage)" = true ] && ! grep -qF "Stop \"CHILD-ASKS\"" "$WORK/tui-stop-usage.txt" && echo true || echo false)"
check "and the child is not noted stopped" "$([ -z "$(kv get "report/$asking/stopped")" ] && echo true || echo false)"
echo "s in the tree panel stops a child after a confirm, through courier_stop's path"
refused=$(rpc stop "{\"sessionID\":\"$asking\",\"by\":\"$asking\"}")
echo "  $refused"
check "the RPC refuses a stop from a session not above the target" "$(jq -r '.type == "refused"' <<<"$refused")"
submit "/courier tree"
check "the panel opens" "$(shows "courier tree" 30 tui-stop-panel)"
for _ in 1 2 3; do
  tmux send-keys -t "$TMUX_SESSION" Down
  sleep 0.5
  tmux capture-pane -pt "$TMUX_SESSION" 2>/dev/null | grep -qE '▸ (├|└) .+CHILD-ASKS' && break
done
check "down selects the child" "$(tmux capture-pane -pt "$TMUX_SESSION" >"$WORK/tui-stop-selected.txt" 2>/dev/null; grep -qE '▸ (├|└) .+CHILD-ASKS' "$WORK/tui-stop-selected.txt" && echo true || echo false)"
tmux send-keys -t "$TMUX_SESSION" s
check "a confirm names the child" "$(shows "Stop \"CHILD-ASKS\"" 30 tui-stop-confirm)"
tmux send-keys -t "$TMUX_SESSION" Enter
check "once confirmed, a toast says what was stopped" "$(shows "Stopped 1 session: 0 interrupted" 30 tui-stopped)"
check "and the child is noted stopped, as courier_stop notes it" "$([ -n "$(kv get "report/$asking/stopped")" ] && echo true || echo false)"
stopped_row=$(rpc tree "{\"sessionID\":\"$parent\"}" | jq -r --arg id "$asking" '.output.rows[] | select(.sessionID == $id) | .stopped')
check "and the panel's tree reads the child as stopped" "$([ "$stopped_row" = true ] && echo true || echo false)"
tmux send-keys -t "$TMUX_SESSION" q
check "q closes the panel" "$(hides "courier tree" 10 tui-stop-closed)"
open_tui tui-home
check "the entry is not on the home screen of a TUI with no session" \
  "$([ "$(shows "ctrl+p" 60 tui-home)" = true ] && ! grep -qF "courier " "$WORK/tui-home.txt" && echo true || echo false)"

echo "the asks inbox answers a child's permission request from the TUI"
out=$(prompt "COURIER-ASK")
asker_parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
asker=$(jq -r 'select(.type == "tool_use" and .part.tool == "courier_spawn") | .part.state.metadata.metadata.sessionID' <<<"$out" | head -1)
for _ in $(seq 1 45); do [ "$(api "session/$asker/permission" | jq -r '.data | length')" = 1 ] && break; sleep 1; done
open_tui tui-prompt "$asker"
check "the child's view shows OpenCode's permission prompt" "$(shows "Allow once" 60 tui-prompt)"
tmux send-keys -t "$TMUX_SESSION" C-x k
check "its key opens the inbox over the prompt, listing the request" \
  "$([ "$(shows "Waiting on you (1)" 20 tui-prompt-inbox)" = true ] && grep -qF "Permission: shell echo courier-asks" "$WORK/tui-prompt-inbox.txt" && echo true || echo false)"
open_tui tui-inbox "$asker_parent"
check "the footer says one waits on the person" "$(shows "courier 1 waiting on you" 60 tui-inbox-footer)"
submit "/asks"
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
check "the child carried on and reported" \
  "$(for _ in $(seq 1 45); do api "session/$asker_parent/message" | jq -e '[.data[] | select(.type == "synthetic") | .text | select(contains("CHILD DONE"))] | length > 0' >/dev/null && { echo true; exit; }; sleep 1; done; echo false)"
check "the parent was told once that it is settled" "$([ "$(settled_notices)" = 1 ] && echo true || echo false)"

echo "a tree that has started more sessions than maxTotal still shows the newest child and what it asks"
one_idle='{"running":0,"waiting":0,"idle":1,"groups":[]}'
check "the first child has ended its turn" "$([ "$(summary_until "$asker_parent" 60 "$one_idle")" = "$one_idle" ] && echo true || echo false)"
out=$(prompt_in "$asker_parent" "COURIER-TEST")
second=$(jq -r 'select(.type == "tool_use" and .part.tool == "courier_spawn") | .part.state.metadata.metadata.sessionID' <<<"$out" | head -1)
check "the limit admits a second child once the first is done" "$([ -n "$second" ] && echo true || echo false)"
two_idle='{"running":0,"waiting":0,"idle":2,"groups":[]}'
check "the second child reported and ended its turn" "$([ "$(summary_until "$asker_parent" 90 "$two_idle")" = "$two_idle" ] && echo true || echo false)"
out=$(prompt_in "$asker_parent" "COURIER-ASK")
third=$(jq -r 'select(.type == "tool_use" and .part.tool == "courier_spawn") | .part.state.metadata.metadata.sessionID' <<<"$out" | head -1)
check "and a third, which asks for a permission" "$([ -n "$third" ] && echo true || echo false)"
for _ in $(seq 1 45); do [ "$(api "session/$third/permission" | jq -r '.data | length')" = 1 ] && break; sleep 1; done
check "the third child waits on its request" "$([ "$(api "session/$third/permission" | jq -r '.data | length')" = 1 ] && echo true || echo false)"
one_waits='{"running":0,"waiting":1,"idle":2,"groups":[]}'
result=$(summary_until "$asker_parent" 30 "$one_waits")
echo "  $result"
check "the summary counts all three: one waiting on the person, two idle" "$([ "$result" = "$one_waits" ] && echo true || echo false)"
rows=$(rpc tree "{\"sessionID\":\"$asker_parent\"}" | jq -c '.output | {rows: [.rows[] | {sessionID, state}], truncated}')
echo "  $rows"
check "the tree lists the newest two, the waiting one among them, and counts the older one left out" \
  "$(jq -r --arg second "$second" --arg third "$third" '.rows == [{sessionID: $second, state: "idle"}, {sessionID: $third, state: "waiting"}] and .truncated == 1' <<<"$rows")"
seen=$(prompt_in "$asker_parent" "COURIER-SUBTREE-TREE" | jq -c 'select(.type == "tool_use" and .part.tool == "courier_tree") | .part.state')
echo "  $(jq -c '{sessions: [.metadata.metadata.sessions[] | .sessionID], truncated: .metadata.metadata.truncated}' <<<"$seen")"
check "courier_tree lists the same two to the model, with the count left out and the note" \
  "$(jq -r --arg second "$second" --arg third "$third" '.status == "completed" and (.metadata.metadata.sessions | map(.sessionID)) == [$second, $third] and .metadata.metadata.truncated == 1 and (.output | contains("1 older session is not listed: at most maxTotal are, the live ones first, then the newest"))' <<<"$seen")"
inbox=$(person_rpc asks "{\"sessionID\":\"$asker_parent\"}" | jq -c '.output | {sessions: (.sessions | length), permissions: [.permissions[] | .sessionID], truncated}')
echo "  $inbox"
check "the asks list every session and the third child's request, uncut" \
  "$(jq -r --arg third "$third" '.sessions == 3 and .permissions == [$third] and .truncated == null' <<<"$inbox")"
open_tui tui-past "$asker_parent"
check "the footer says one waits on the person, and counts the two idle" "$(shows "courier 1 waiting on you · 2 idle" 60 tui-past)"
echo "  $(footer tui-past)"
tmux send-keys -t "$TMUX_SESSION" C-x k
check "the inbox lists the request" \
  "$([ "$(shows "Waiting on you (1)" 20 tui-past-inbox)" = true ] && grep -qF "Permission: shell echo courier-asks" "$WORK/tui-past-inbox.txt" && echo true || echo false)"
tmux send-keys -t "$TMUX_SESSION" Escape
check "Escape closes it" "$(hides "Waiting on you" 10 tui-past-inbox-closed)"
submit "/courier tree"
check "the panel lists the asking child and says one older session is left out" \
  "$([ "$(shows "1 older left out" 30 tui-past-panel)" = true ] && grep -qF "CHILD-ASKS  waiting on you · owes a report" "$WORK/tui-past-panel.txt" && echo true || echo false)"
tmux send-keys -t "$TMUX_SESSION" Down
tmux send-keys -t "$TMUX_SESSION" Enter
check "enter on the idle child's row opens it, the panel following" "$(shows "(on screen)  idle · reported done" 30 tui-past-child)"
tmux send-keys -t "$TMUX_SESSION" q
check "q closes the panel" "$(hides "courier tree" 10 tui-past-panel-closed)"
submit "TYPED-INTO-CHILD"
typed_envelopes() {
  api "session/$asker_parent/message" | jq -r --arg id "$second" '[.data[] | select(.type == "synthetic") | .text | select(startswith("<courier from=\"courier\" route=\"prompt\" in=\"" + $id + "\">"))] | length'
}
check "the root holds exactly one route=\"prompt\" envelope for the line typed into the child" \
  "$(for _ in $(seq 1 30); do [ "$(typed_envelopes)" = 1 ] && { echo true; exit; }; sleep 1; done; echo false)"

echo "the inbox opened from a child lists the top session's courier_answer prompt first, and allows it"
child_request=$(api "session/$third/permission" | jq -r '.data[0].id // empty')
api_prompt "$asker_parent" "COURIER-ANSWER once"
top_request=
for _ in $(seq 1 30); do
  top_request=$(api "session/$asker_parent/permission" | jq -r --arg request "$child_request" '[.data[] | select(.metadata.requestID == $request) | .id] | first // empty')
  [ -n "$top_request" ] && break
  sleep 1
done
check "OpenCode asks the person in the parent's session" "$([ -n "$top_request" ] && echo true || echo false)"
listed=$(person_rpc asks "{\"sessionID\":\"$third\"}" | jq -c '[.output.permissions[] | {sessionID, requestID, passesOn}]')
echo "  $listed"
check "the asks list the parent's prompt first, with the child's request it passes on" \
  "$(jq -r --arg top "$asker_parent" --arg own "$top_request" --arg third "$third" --arg request "$child_request" \
    '.[0] == {sessionID: $top, requestID: $own, passesOn: {sessionID: $third, requestID: $request}} and .[1].requestID == $request' <<<"$listed")"
open_tui tui-top "$third"
check "the child's view shows OpenCode's permission prompt" "$(shows "Allow once" 60 tui-top)"
tmux send-keys -t "$TMUX_SESSION" C-x k
check "its key opens the inbox, the parent's prompt first, worded as the top session's" \
  "$([ "$(shows "Waiting on you (2)" 20 tui-top-inbox)" = true ] &&
    grep -F -e "Permission (top session)" -e "Permission: shell" "$WORK/tui-top-inbox.txt" | head -1 | grep -qF "Permission (top session): courier_answer once" && echo true || echo false)"
tmux send-keys -t "$TMUX_SESSION" Enter
check "choosing it offers the answers" "$(shows "Reject with a reason" 20 tui-top-answers)"
tmux send-keys -t "$TMUX_SESSION" Enter
for _ in $(seq 1 30); do [ "$(api "session/$third/permission" | jq -r '.data | length')" = 0 ] && break; sleep 1; done
check "allowed there, the parent's prompt is settled" \
  "$(api "session/$asker_parent/permission" | jq -r --arg own "$top_request" '[.data[].id] | index($own) == null')"
check "and courier_answer passed once on to the child" "$([ "$(api "session/$third/permission" | jq -r '.data | length')" = 0 ] && echo true || echo false)"
check "the inbox closes once nothing is left" "$(hides "Waiting on you" 20 tui-top-closed)"

echo "a child showing a form waits on the person: the footer and the panel say so"
out=$(prompt "COURIER-SEARCH")
searcher_parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
searcher=$(jq -r 'select(.type == "tool_use" and .part.tool == "courier_spawn") | .part.state.metadata.metadata.sessionID' <<<"$out" | head -1)
form=
for _ in $(seq 1 45); do form=$(api "session/$searcher/form" | jq -r '.data[0].id // empty'); [ -n "$form" ] && break; sleep 1; done
check "the child shows OpenCode's web search form" "$([ -n "$form" ] && echo true || echo false)"
one_form='{"running":0,"waiting":1,"idle":0,"groups":[]}'
result=$(summary_until "$searcher_parent" 15 "$one_form")
echo "  $result"
check "the summary counts the child waiting on the person" "$([ "$result" = "$one_form" ] && echo true || echo false)"
rows=$(rpc tree "{\"sessionID\":\"$searcher_parent\"}" | jq -c '[.output.rows[] | {state, waits}]')
echo "  $rows"
check "the tree's row waits, on the form" "$(jq -r '. == [{state: "waiting", waits: [{type: "form", title: "Web Search"}]}]' <<<"$rows")"
open_tui tui-form "$searcher_parent"
check "the footer says one waits on the person" "$(shows "courier 1 waiting on you" 20 tui-form)"
echo "  $(footer tui-form)"
submit "/courier tree"
check "the panel's row says the child waits, and on what" \
  "$([ "$(shows "shows a form: Web Search" 15 tui-form-panel)" = true ] && grep -qF "CHILD-SEARCHES  waiting on you" "$WORK/tui-form-panel.txt" && echo true || echo false)"
tmux send-keys -t "$TMUX_SESSION" q
check "q closes the panel" "$(hides "courier tree" 10 tui-form-panel-closed)"
dismissed=$(curl -s -o /dev/null -w '%{http_code}' -u "opencode:$OPENCODE_PASSWORD" -X DELETE "$SERVER/api/session/$searcher/form/$form")
check "the person dismisses the form ($form)" "$([ "$dismissed" = 204 ] && echo true || echo false)"
waits=
for _ in $(seq 1 30); do waits=$(rpc summary "{\"sessionID\":\"$searcher_parent\"}" | jq -r '.output.waiting'); [ "$waits" = 0 ] && break; sleep 1; done
check "the summary no longer counts it waiting" "$([ "$waits" = 0 ] && echo true || echo false)"
check "nor does the footer" "$(hides "waiting on you" 20 tui-form-dismissed)"

echo "x forgets a gone isolated child from the tree panel, with its worktree"
out=$(prompt "COURIER-TEST isolate")
forget_parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
forget_child=$(jq -r 'select(.type == "tool_use" and .part.tool == "courier_spawn") | .part.state.metadata.metadata.sessionID' <<<"$out" | head -1)
forget_dir=$(jq -r 'select(.type == "tool_use" and .part.tool == "courier_spawn") | .part.state.metadata.metadata.directory' <<<"$out" | head -1)
check "the isolated child reported and ended its turn" "$([ "$(summary_until "$forget_parent" 90 "$one_idle")" = "$one_idle" ] && echo true || echo false)"
check "its worktree exists" "$([ -d "$forget_dir" ] && echo true || echo false)"
refused=$(rpc cleanup "{\"sessionID\":\"$forget_child\",\"by\":\"$forget_child\"}")
echo "  $refused"
check "the RPC refuses a cleanup from a session not above the target" "$(jq -r '.type == "refused"' <<<"$refused")"
open_tui tui-forget-open "$forget_parent"
check "the TUI on the child's parent counts it in the footer" "$(shows "courier 1 idle" 60 tui-forget-open)"
check "the child is deleted over HTTP" \
  "$([[ $(curl -s -o /dev/null -w '%{http_code}' -u "opencode:$OPENCODE_PASSWORD" -X DELETE "$SERVER/api/session/$forget_child") == 20* ]] && echo true || echo false)"
gone_row() { rpc tree "{\"sessionID\":\"$forget_parent\"}" | jq -r --arg id "$forget_child" '.output.rows[] | select(.sessionID == $id) | .state'; }
check "the panel's tree reads it as gone" "$(for _ in $(seq 1 20); do [ "$(gone_row)" = gone ] && { echo true; exit; }; sleep 1; done; echo false)"
check "the footer no longer counts it" "$(hides "courier 1 idle" 30 tui-forget)"
submit "/courier tree"
check "the panel shows the gone row and the x key" \
  "$([ "$(shows "x forget" 30 tui-forget-panel)" = true ] && grep -qF "Report back to your parent.  gone" "$WORK/tui-forget-panel.txt" && echo true || echo false)"
tmux send-keys -t "$TMUX_SESSION" Down
check "down selects the gone child, below the parent's own row" "$(shows "▸ └   Report back to your parent.  gone" 30 tui-forget-down)"
tmux send-keys -t "$TMUX_SESSION" x
check "x asks to confirm, naming the child" "$(shows "Forget \"Report back to your parent.\"" 30 tui-forget-confirm)"
tmux send-keys -t "$TMUX_SESSION" Enter
check "once confirmed, a toast says it was forgotten" "$(shows "Forgot \"Report back to your parent.\"" 30 tui-forgotten)"
check "and the row is gone from the panel, the parent's own row left with the empty line under it" \
  "$([ "$(shows "No session started with courier_spawn under this one." 30 tui-forget-empty)" = true ] && grep -qE '▸ +.*\(on screen\)' "$WORK/tui-forget-empty.txt" && echo true || echo false)"
check "and from the roster" "$([ -z "$(gone_row)" ] && [ -z "$(kv get "roster-by-child/$forget_child")" ] && echo true || echo false)"
check "and its worktree is removed" "$(for _ in $(seq 1 20); do [ ! -d "$forget_dir" ] && { echo true; exit; }; sleep 1; done; echo false)"
tmux send-keys -t "$TMUX_SESSION" q
check "q closes the panel" "$(hides "courier tree" 10 tui-forget-closed)"

echo "/courier memory is no verb: it shows the usage and opens no view"
open_tui tui-memory "$parent"
check "the TUI is on the parent" "$(shows "courier 2 idle" 60 tui-memory-footer)"
submit "/courier memory"
check "/courier memory shows the usage in a toast, and no memory view" \
  "$([ "$(shows "/courier tree opens the session tree" 30 tui-memory-usage)" = true ] && ! grep -qF "Memory (" "$WORK/tui-memory-usage.txt" && echo true || echo false)"

echo "the tree panel shows a subagent OpenCode's subagent tool started, under the session that started it, marked subagent (#438)"
out=$(prompt "COURIER-SUBAGENT-START")
sub_root=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
sub_mid=$(jq -r 'select(.type == "tool_use" and .part.tool == "courier_spawn") | .part.state.metadata.metadata.sessionID' <<<"$out")
for _ in $(seq 1 60); do [ "$(rpc tree "{\"sessionID\":\"$sub_root\"}" | jq -r '[.output.rows[]? | select(.subagent == true)] | length')" -ge 1 ] && break; sleep 1; done
check "the RPC's tree has a subagent row under the middle session" \
  "$(rpc tree "{\"sessionID\":\"$sub_root\"}" | jq -r --arg mid "$sub_mid" '[.output.rows[] | select(.subagent == true)] | length >= 1 and all(.parentID == $mid and .depth == 2)')"
open_tui tui-subagent "$sub_root"
check "the TUI is on the session" "$(shows "courier 1 running" 60 tui-subagent-footer)"
submit "/courier tree"
check "the panel has the subagent's row, running and marked subagent" "$(shows "running · subagent" 30 tui-subagent-panel)"
check "the middle session's bar counts no subagent as a part owed" "$(grep -qF "0/0 reported" "$WORK/tui-subagent-panel.txt" && echo false || echo true)"
rpc stop "{\"sessionID\":\"$sub_mid\",\"by\":\"$sub_root\"}" >/dev/null || true
tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true

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
"$OPENCODE" service stop >/dev/null 2>&1 </dev/null || true
check "plugin add installed it" "$([ "$added" = ok ] && echo true || echo false)"
[ "$added" = ok ] || cat "$WORK/plugin-add.log"
installed=$(ls -d "$XDG_CACHE_HOME"/opencode/npm/opencode-courier@latest/*/node_modules/opencode-courier 2>/dev/null | tail -1)
check "and nothing of the TUI's packages next to it, which the host provides" \
  "$([ -n "$installed" ] && [ ! -e "$(dirname "$installed")/@opentui" ] && [ ! -e "$(dirname "$installed")/solid-js" ] && echo true || echo false)"
jq 'del(.plugins)' "$WORK/project/opencode.json" >"$WORK/project/opencode.json.new"
mv "$WORK/project/opencode.json.new" "$WORK/project/opencode.json"
start_server
check "its RPC answers" "$([ "$(summary_until "$parent" 30 "$idle")" = "$idle" ] && echo true || echo false)"
info=$(plugins | jq -c '.data[] | select(.id == "courier") | {state: .state.status, features, source: .source.type}')
echo "  $info"
check "the installed package reports features server, tui and rpc" \
  "$(jq -r '.features == {server: true, tui: true, rpc: true} and .source == "package"' <<<"$info")"
open_tui tui-installed "$parent"
check "the TUI loads the installed package's tui entrypoint and shows the entry" "$(shows "courier 2 idle" 60 tui-installed)"

if [ "$failures" != 0 ]; then
  for screen in tui-waiting tui-panel tui-panel-reported tui-panel-closed tui-released tui-panel-again tui-panel-followed tui-panel-home tui-panel-back tui-panel-followed-closed tui-parent-again tui-narrow-footer tui-narrow-panel tui-widened tui-stop-confirm tui-stopped tui-home tui-inbox-footer tui-inbox-list tui-inbox-answers tui-past tui-past-inbox tui-past-panel tui-form tui-form-panel tui-form-dismissed tui-forget-open tui-forget tui-forget-panel tui-forget-confirm tui-forgotten tui-forget-empty tui-top tui-top-inbox tui-top-answers tui-top-closed tui-memory-usage tui-subagent-footer tui-subagent-panel tui-installed; do
    echo "--- $screen"
    sed -n 1,40p "$WORK/$screen.txt" 2>/dev/null || true
  done
  for child in $children; do api "session/$child/message" >"$WORK/messages-$child.log" 2>&1 || true; done
fi

echo
[ "$failures" = 0 ] && echo "all checks passed" || { echo "$failures check(s) failed"; exit 1; }
