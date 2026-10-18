#!/usr/bin/env bash
# Live test of the TUI part: a real OpenCode V2 server loads the package's `tui` and `rpc`
# entrypoints, its RPC answers over HTTP, and the TUI, in tmux, shows the prompt footer's entry and
# follows a change, opens the tree panel with /courier tree, the 16×16 Digby below its rows (#245), with no background left of a pose before (#281), follows it into a child, opens a child with a click (#250), and stops a child with /courier stop;
# a tree that has started more sessions than maxTotal still shows its newest child and what it asks (#188), and the
# inbox opened from a child lists the top session's courier_answer prompt first and allows it (#185);
# a child showing a form waits on the person in the footer and the panel (#183); x in the panel forgets a gone
# isolated child, with its worktree (#187); and /courier memory lists the project's tree records, x forgets a lesson
# alone, then every record, and the view says when memory is off (#262); esc goes back and closes, q filters (#273);
# after a forget the cursor is on the next record (#271); p pins a record and unpins it (#285).
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
# A turn of session $1 with text $2 through the API: `opencode run --auto` would answer the session's own prompt itself.
api_prompt() { curl -sf -u "opencode:$OPENCODE_PASSWORD" -X POST -H 'content-type: application/json' --data "{\"text\":\"$2\"}" "$SERVER/api/session/$1/prompt" >/dev/null; }
prompt_in() { (cd "$WORK/project" && "$OPENCODE" run --server "$SERVER" --auto --format json --session "$1" "$2" </dev/null); }
location() { node -p 'encodeURIComponent(process.argv[1])' "$WORK/project"; }
plugins() { api "plugin?directory=$(location)"; }
# The courier's RPC over HTTP: method $1 with input $2, at the project's location; person_rpc the person's.
rpc() {
  curl -s -u "opencode:$OPENCODE_PASSWORD" -X POST "$SERVER/api/rpc/courier/$1?directory=$(location)" \
    -H 'content-type: application/json' -d "{\"input\":$2}"
}
person_rpc() {
  curl -s -u "opencode:$OPENCODE_PASSWORD" -X POST "$SERVER/api/rpc/courier-person/$1?directory=$(location)" \
    -H 'content-type: application/json' -d "{\"input\":$2}"
}
memory_rpc() {
  curl -s -u "opencode:$OPENCODE_PASSWORD" -X POST "$SERVER/api/rpc/courier-memory/$1?directory=$(location)" \
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
# Opens the TUI in a fresh tmux session, $COLS (220) columns wide, its stderr to $WORK/$1.err: on session $2, or the home screen.
open_tui() {
  tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
  tmux new-session -d -s "$TMUX_SESSION" -x "${COLS:-220}" -y 40 \
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
# Whether each cell of the 16×16 Digby on the screen in $WORK/$1.ansi (capture-pane -e), the eight lines ending on his
# ground, has the background of the panel's cell left of it; the cells that do not are printed to stderr.
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
# Whether the 16×16 Digby is drawn on the panel's background alone within $1 s; the screen, trailing spaces kept (-N), in $WORK/$2.ansi.
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
# The slash commands typed below make a prompt history, after which the home screen would open the release highlights over its footer.
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
check "the footer shows what the RPC gave" "$(shows "courier 1 waiting on you · group pair 1/2 · 1 idle" 60 tui-waiting)"
echo "  $(footer tui-waiting)"
echo "the tree panel: /courier tree opens it on both children, with the bar of the parts reported"
rows=$(rpc tree "{\"sessionID\":\"$parent\"}" | jq -c '[.output.rows[] | {depth, state, report: .report.state, group: .group.standing}] | sort_by(.state)')
echo "  $rows"
check "the RPC's tree: one child reported and held, the other waits on the person and owes its report" \
  "$(jq -r '. == [{depth: 1, state: "idle", report: "reported", group: "held"}, {depth: 1, state: "waiting", report: "owed", group: "out"}]' <<<"$rows")"
contexts=$(rpc tree "{\"sessionID\":\"$parent\"}" | jq -c '[.output.rows[].context]')
echo "  $contexts"
check "the RPC's tree carries a mock-model child's context use: a fraction of the model's window" \
  "$(jq -r 'map(select(. != null)) | length > 0 and all(. > 0 and . <= 1)' <<<"$contexts")"
tmux send-keys -t "$TMUX_SESSION" "/courier tree"
sleep 1
tmux send-keys -t "$TMUX_SESSION" Enter
check "the panel opens with the bar: 1 of 2 parts reported" "$(shows "courier tree  [█████░░░░░] 1/2 reported" 30 tui-panel)"
check "it has the reported child's row" "$(grep -qF "✓ Report back to your parent.  idle · reported done · group pair held" "$WORK/tui-panel.txt" && echo true || echo false)"
check "and the asking child's, which says what it waits on" \
  "$(grep -qF "● CHILD-ASKS  waiting on you · owes a report · group pair out" "$WORK/tui-panel.txt" && grep -qF "asks permission: shell echo courier-asks" "$WORK/tui-panel.txt" && echo true || echo false)"
# Two rows leave the panel in a 40-row window far more than 10 free: the 16×16 Digby shows below them, his ground a full 16 cells,
# and the header drops its glyph, so its title has no half-block before it (#245).
check "the 16×16 Digby shows below the rows, the header without its glyph" \
  "$([ "$(shows "████████████████" 15 tui-panel-digby)" = true ] && ! grep -qE '[▀▄█] +courier tree' "$WORK/tui-panel-digby.txt" && echo true || echo false)"
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
# Waiting, then the report, gave cells of the 16×16 a background; idle, after it, gives none, so none may stay (#281).
check "once the report's pose ends, the 16×16 Digby keeps no background of the poses before" "$(digby_settles 15 tui-panel-settled)"
# q closes the panel, which has the keyboard while it is open; the footer is whole again.
tmux send-keys -t "$TMUX_SESSION" q
check "q closes the panel" "$(hides "courier tree" 10 tui-panel-closed)"
check "the footer follows it" "$(shows "courier 2 idle" 30 tui-released)"
echo "  $(footer tui-released)"
check "and the group is gone from it" "$([[ $(footer tui-released) != *"group pair"* ]] && echo true || echo false)"
# Reopened, enter opens the selected child; the panel follows it there, with the parent's tree and the child marked (#158).
tmux send-keys -t "$TMUX_SESSION" "/courier tree"
sleep 1
tmux send-keys -t "$TMUX_SESSION" Enter
check "the panel opens again" "$(shows "courier tree  [██████████] 2/2 reported" 30 tui-panel-again)"
tmux send-keys -t "$TMUX_SESSION" Enter
check "enter on a child row keeps the panel in the child's view, the child marked" "$(shows "(on screen)" 30 tui-panel-followed)"
check "with the parent's tree" "$(grep -qF "courier tree  [██████████] 2/2 reported" "$WORK/tui-panel-followed.txt" && echo true || echo false)"
# A click on the other child's row opens it (#250): the left button down and up on its title, written to the TUI as the
# SGR mouse report a terminal sends, at the cell tmux shows the title in (1-based, counted in characters, not bytes).
click_line=$(grep -nF "CHILD-ASKS  idle" "$WORK/tui-panel-followed.txt" | tail -1 | cut -d: -f1 || true)
# wc -m counts the line's end too, which makes the characters before the title its 1-based column.
click_column=$(grep -F "CHILD-ASKS  idle" "$WORK/tui-panel-followed.txt" | tail -1 | sed 's/CHILD-ASKS  idle.*//' | LC_ALL=C.UTF-8 wc -m || true)
check "the other child's row is on screen to click" "$([ -n "$click_line" ] && echo true || echo false)"
tmux send-keys -t "$TMUX_SESSION" -l "$(printf '\033[<0;%d;%dM' $((click_column)) "$click_line")"
tmux send-keys -t "$TMUX_SESSION" -l "$(printf '\033[<0;%d;%dm' $((click_column)) "$click_line")"
check "a click on its row opens that child, the panel following it there" "$(shows "CHILD-ASKS (on screen)" 30 tui-panel-clicked)"
# A new session's home screen hides it; back on the parent's tab, the first, it shows again.
tmux send-keys -t "$TMUX_SESSION" C-x n
check "the home screen of /new hides the panel" "$(hides "courier tree" 10 tui-panel-home)"
tmux send-keys -t "$TMUX_SESSION" C-x
sleep 0.3
tmux send-keys -t "$TMUX_SESSION" 1
check "back on the parent, the panel shows again" "$(shows "courier tree  [██████████] 2/2 reported" 30 tui-panel-back)"
tmux send-keys -t "$TMUX_SESSION" q
check "q closes it there" "$(hides "courier tree" 10 tui-panel-followed-closed)"
# A panel opened on a terminal too narrow to split is shown fullscreen by OpenCode, which splits only from 108 columns (#229);
# followed into a child after the terminal was widened, it is a split again, not the fullscreen it was shown as (#180).
echo "a panel opened at 100 columns splits once the terminal is widened and the panel followed"
COLS=100 open_tui tui-narrow "$parent"
check "the TUI is open at 100 columns" "$(shows "courier 2 idle" 60 tui-narrow-footer)"
tmux send-keys -t "$TMUX_SESSION" "/courier tree"
sleep 1
tmux send-keys -t "$TMUX_SESSION" Enter
check "the panel opens" "$(shows "courier tree  [██████████] 2/2 reported" 30 tui-narrow-panel)"
tmux resize-window -t "$TMUX_SESSION" -x 160 -y 40
sleep 1
tmux send-keys -t "$TMUX_SESSION" Enter
# The split pane is narrow, so the title is cut before its "(on screen)"; the mark takes two cells of it.
check "followed into a child at 160 columns" "$(shows "✓ Report back to your parent." 30 tui-widened)"
check "the panel sits beside the session, not over it" \
  "$(awk '/courier tree/ { if (index($0, "courier tree") > 40) found = 1 } END { print found ? "true" : "false" }' "$WORK/tui-widened.txt")"
# /courier stop stops as the open session, so back to the parent.
open_tui tui "$parent"
check "the TUI is back on the parent" "$(shows "courier 2 idle" 60 tui-parent-again)"
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
stopped_row=$(rpc tree "{\"sessionID\":\"$parent\"}" | jq -r --arg id "$asking" '.output.rows[] | select(.sessionID == $id) | .stopped')
check "and the panel's tree reads the child as stopped" "$([ "$stopped_row" = true ] && echo true || echo false)"
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
# Viewing the asking child itself, OpenCode renders its permission prompt in place of the prompt and hides
# the footer, so the key is the way to the inbox, which lists the request from anywhere in the tree.
open_tui tui-prompt "$asker"
check "the child's view shows OpenCode's permission prompt" "$(shows "Allow once" 60 tui-prompt)"
tmux send-keys -t "$TMUX_SESSION" C-x k
check "its key opens the inbox over the prompt, listing the request" \
  "$([ "$(shows "Waiting on you (1)" 20 tui-prompt-inbox)" = true ] && grep -qF "Permission: shell echo courier-asks" "$WORK/tui-prompt-inbox.txt" && echo true || echo false)"
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

# A tree past maxTotal (#188): the limit counts live sessions, so children started one after another outgrow it; every
# read looks every one up, and a listing keeps the live ones first, then the newest, saying how many older are left out.
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
tmux send-keys -t "$TMUX_SESSION" "/courier tree"
sleep 1
tmux send-keys -t "$TMUX_SESSION" Enter
check "the panel lists the asking child and says one older session is left out" \
  "$([ "$(shows "1 older left out" 30 tui-past-panel)" = true ] && grep -qF "CHILD-ASKS  waiting on you · owes a report" "$WORK/tui-past-panel.txt" && echo true || echo false)"
tmux send-keys -t "$TMUX_SESSION" q
check "q closes the panel" "$(hides "courier tree" 10 tui-past-panel-closed)"

# The top session's own permission request (#185): courier_answer's once asks the person in the parent's session, and
# the inbox, opened from the asking child, lists that prompt first and allows it, which passes the child's answer on.
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

# A form (#183): the child of COURIER-SEARCH searches the web before any provider was chosen, so OpenCode shows it
# "Web Search", which only the person can answer; withdrawn by itself after a minute, so the checks are kept short.
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
tmux send-keys -t "$TMUX_SESSION" "/courier tree"
sleep 1
tmux send-keys -t "$TMUX_SESSION" Enter
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

# x in the tree panel (#187): an isolated child deleted over HTTP stays on the roster, a gone row, for courier_cleanup;
# x and Enter forget it through courier_cleanup's path, which removes its clean worktree, and the row goes.
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
tmux send-keys -t "$TMUX_SESSION" "/courier tree"
sleep 1
tmux send-keys -t "$TMUX_SESSION" Enter
check "the panel shows the gone row and the x key" \
  "$([ "$(shows "x forget" 30 tui-forget-panel)" = true ] && grep -qF "Report back to your parent.  gone" "$WORK/tui-forget-panel.txt" && echo true || echo false)"
tmux send-keys -t "$TMUX_SESSION" x
check "x asks to confirm, naming the child" "$(shows "Forget \"Report back to your parent.\"" 30 tui-forget-confirm)"
tmux send-keys -t "$TMUX_SESSION" Enter
check "once confirmed, a toast says it was forgotten" "$(shows "Forgot \"Report back to your parent.\"" 30 tui-forgotten)"
check "and the row is gone from the panel" "$(shows "No session started with courier_spawn under this one." 30 tui-forget-empty)"
check "and from the roster" "$([ -z "$(gone_row)" ] && [ -z "$(kv get "roster-by-child/$forget_child")" ] && echo true || echo false)"
check "and its worktree is removed" "$(for _ in $(seq 1 20); do [ ! -d "$forget_dir" ] && { echo true; exit; }; sleep 1; done; echo false)"
tmux send-keys -t "$TMUX_SESSION" q
check "q closes the panel" "$(hides "courier tree" 10 tui-forget-closed)"

# The memory view (#262): /courier memory lists the project's tree records under "Today" and the local days they last
# moved (#272), the COURIER-TUI tree's with a lesson seeded by hand in its footer; enter shows it in full, x forgets its
# lesson alone, then each record after a confirm, and the view closes once the project has none; off, it says so.
echo "/courier memory lists the project's tree records; x forgets a lesson, then every record"
project=$(api "session/$parent" | jq -r '.data.projectID // .projectID')
record=$(for _ in $(seq 1 30); do found=$(kv get "memory/$project/$parent"); if [ -n "$found" ] && [ "$(jq -r '.finished and (.parts | length) == 2' <<<"$found")" = true ]; then echo "$found"; break; fi; sleep 1; done)
check "the COURIER-TUI tree has a finished record with its two parts" "$([ -n "$record" ] && echo true || echo false)"
# A lesson written by hand on it, as docs/reference.md's Memory section describes a record; the top never called courier_note.
kv set "memory/$project/$parent" "$(jq -c '.lesson = {text: "Give the docs to one session", at: (now * 1000 | floor)}' <<<"$record")" "memory/$project/$parent"
listed=$(memory_rpc records '{}')
echo "  $(jq -c '.output | {memory, records: [.records[] | {sessionID, parts: (.parts | length), lesson: .lesson.text}]}' <<<"$listed")"
check "the RPC lists the project's records newest first, memory on, the seeded lesson among them" \
  "$(jq -r --arg parent "$parent" '.output.memory == true and (.output.records | length) >= 2 and (.output.records | map(.movedAt) | . == (sort | reverse)) and
    any(.output.records[]; .sessionID == $parent and .lesson.text == "Give the docs to one session" and (.parts | length) == 2)' <<<"$listed")"
check "forgetting a record that is not there finds nothing" "$(memory_rpc forget '{"sessionID":"ses_nowhere"}' | jq -r '.output.outcome == "none"')"
total=$(jq -r '.output.records | length' <<<"$listed")
index=$(jq -r --arg parent "$parent" '.output.records | map(.sessionID) | index($parent)' <<<"$listed")
# The view's dates are local, as the TUI's zone has them: UTC in CI, the developer's at home.
today=$(date +%F)
open_tui tui-memory "$parent"
check "the TUI is on the parent" "$(shows "courier 2 idle" 60 tui-memory-footer)"
tmux send-keys -t "$TMUX_SESSION" "/courier memory"
sleep 1
tmux send-keys -t "$TMUX_SESSION" Enter
check "/courier memory opens the view with every record of the project" "$(shows "Memory ($total)" 30 tui-memory-list)"
# Every record is from this run, so "Today" heads the list and no date heads a group; the seeded lesson sits below it.
# The dialog is drawn over the transcript, so a header shares its screen line with whatever is behind it.
check "the tree's row is under Today, with its parts counted and the lesson, dated on the local day, as its footer" \
  "$(awk -v lesson="lesson ($today): \"Give the docs to one session\"" '/(^|[^A-Za-z])Today([^A-Za-z]|$)/ { today = NR } index($0, lesson) && today && today < NR { under = 1 } /(Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z][a-z] [0-9]+ [0-9][0-9][0-9][0-9]/ { dated = 1 } END { exit !(under && !dated) }' "$WORK/tui-memory-list.txt" && grep -qF "2 parts: 2 done" "$WORK/tui-memory-list.txt" && echo true || echo false)"
check "the footer offers x to forget and p to pin" "$(grep -qF "forget x" "$WORK/tui-memory-list.txt" && grep -qF "pin p" "$WORK/tui-memory-list.txt" && echo true || echo false)"
# Down to the tree's row, newest first, then enter.
for _ in $(seq 1 "$index"); do tmux send-keys -t "$TMUX_SESSION" Down; done
tmux send-keys -t "$TMUX_SESSION" Enter
check "enter shows the record in full: its top session and its parts" \
  "$([ "$(shows "Top session $parent" 30 tui-memory-record)" = true ] && grep -qF "CHILD-ASKS" "$WORK/tui-memory-record.txt" && grep -qF "Report back to your parent." "$WORK/tui-memory-record.txt" && echo true || echo false)"
check "the record in full says it was never shown to another tree, and is not pinned" \
  "$(grep -qF "Never shown" "$WORK/tui-memory-record.txt" && grep -qF "Not pinned" "$WORK/tui-memory-record.txt" && echo true || echo false)"
# The lesson's heading is the tenth row: seven facts of the tree (its reads and pin among them, #285), then the two parts;
# the lesson's text, below the dialog's fold with those above it, scrolls into view with the cursor.
for _ in $(seq 1 9); do tmux send-keys -t "$TMUX_SESSION" Down; done
check "on the lesson's heading, its text is in view" "$(shows "Give the docs to one session" 10 tui-memory-lesson)"
tmux send-keys -t "$TMUX_SESSION" x
check "x on the lesson asks to forget the lesson alone" "$(shows "Forget lesson" 30 tui-memory-lesson-confirm)"
tmux send-keys -t "$TMUX_SESSION" Enter
check "once confirmed, a toast says the lesson went" "$(shows "Forgot the lesson of" 30 tui-memory-lesson-forgotten)"
check "and the record is shown again without it" "$(shows "No lesson" 30 tui-memory-no-lesson)"
check "the record kept its parts and lost its lesson" "$(kv get "memory/$project/$parent" | jq -r '(has("lesson") | not) and (.parts | length) == 2')"
tmux send-keys -t "$TMUX_SESSION" Escape
check "esc goes back from the record to the list" "$([ "$(hides "Top session $parent" 10 tui-memory-back)" = true ] && [ "$(shows "Memory ($total)" 10 tui-memory-back)" = true ] && echo true || echo false)"
# q is no footer action (#273): typed in the search, it filters the rows, none of whose titles has three, and the list stays.
tmux send-keys -t "$TMUX_SESSION" qqq
check "q typed in the search filters the rows, and the list stays open" \
  "$([ "$(hides "2 parts: 2 done" 10 tui-memory-search)" = true ] && grep -qF "qqq" "$WORK/tui-memory-search.txt" && grep -qF "Memory ($total)" "$WORK/tui-memory-search.txt" && echo true || echo false)"
tmux send-keys -t "$TMUX_SESSION" BSpace BSpace BSpace
check "cleared, the search shows every row again" "$(shows "2 parts: 2 done" 10 tui-memory-unfiltered)"
tmux send-keys -t "$TMUX_SESSION" Escape
check "esc closes the list" "$(hides "Memory ($total)" 10 tui-memory-closed)"
# The pin (#285): p on the tree's row pins it, with no confirm; the list is read again with the record under Pinned, the
# cursor on it, and the pin lies beside the record, which is not written; p again unpins it.
tmux send-keys -t "$TMUX_SESSION" "/courier memory"
sleep 1
tmux send-keys -t "$TMUX_SESSION" Enter
check "the view opens again, for the pin" "$(shows "Memory ($total)" 30 tui-memory-pin-open)"
for _ in $(seq 1 "$index"); do tmux send-keys -t "$TMUX_SESSION" Down; done
tmux send-keys -t "$TMUX_SESSION" p
# The toast quotes the title after "Pinned"; the group's header does not, and heads the list above Today.
check "p pins the tree's record: a toast says so, and the list has it under Pinned, above Today" \
  "$([ "$(shows "Pinned \"" 15 tui-memory-pinned)" = true ] && awk '/(^|[^A-Za-z])Pinned([^A-Za-z"]|$)/ && !/Pinned "/ { pinned = NR } /(^|[^A-Za-z])Today([^A-Za-z]|$)/ { today = NR } END { exit !(pinned && today && pinned < today) }' "$WORK/tui-memory-pinned.txt" && echo true || echo false)"
check "the pin lies beside the record, which is not written" \
  "$([ "$(kv get "memory/$project/$parent/pin" | jq -r '(.at | type) == "number"')" = true ] && [ "$(kv get "memory/$project/$parent" | jq -r 'has("pinned") | not')" = true ] && echo true || echo false)"
check "the RPC lists it first, pinned" "$(memory_rpc records '{}' | jq -r --arg parent "$parent" '.output.records[0].sessionID == $parent and (.output.records[0].pinned.at | type) == "number"')"
tmux send-keys -t "$TMUX_SESSION" p
check "p again, the cursor still on it, unpins it" "$([ "$(shows "Unpinned \"" 15 tui-memory-unpinned)" = true ] && [ -z "$(kv get "memory/$project/$parent/pin")" ] && echo true || echo false)"
tmux send-keys -t "$TMUX_SESSION" Escape
check "esc closes the list once more" "$(hides "Memory (" 10 tui-memory-pin-closed)"
# Three records seeded as the project's newest (#271): x on the second, confirmed, leaves the cursor on the third, which a
# second x names in its confirm; kept, the list is back on it.
seeded=$(date +%s%3N)
for n in 1 2 3; do
  kv set "memory/$project/ses_cursor$n" "$(jq -c --arg id "ses_cursor$n" --arg title "Cursor seed $n" --argjson at "$((seeded + (4 - n) * 1000))" \
    '.sessionID = $id | .title = $title | .movedAt = $at | .startedAt = ($at - 60000) | del(.lesson)' <<<"$record")" "memory/$project/$parent"
done
total=$((total + 3))
tmux send-keys -t "$TMUX_SESSION" "/courier memory"
sleep 1
tmux send-keys -t "$TMUX_SESSION" Enter
check "the view opens again" "$(shows "Memory ($total)" 30 tui-memory-again)"
tmux send-keys -t "$TMUX_SESSION" Down x
check "x on the second row asks to forget it" "$(shows "of \"Cursor seed 2\"" 15 tui-memory-cursor-confirm)"
tmux send-keys -t "$TMUX_SESSION" Enter
left=$((total - 1))
check "once forgotten, the list is shown without it" "$(shows "Memory ($left)" 15 tui-memory-cursor-forgotten)"
tmux send-keys -t "$TMUX_SESSION" x
check "the cursor is on what was the third row: x names it" "$(shows "of \"Cursor seed 3\"" 15 tui-memory-cursor)"
tmux send-keys -t "$TMUX_SESSION" Escape
check "kept, the list is back with every record" "$([ "$(hides "Forget record" 15 tui-memory-cursor-kept)" = true ] && [ "$(shows "Memory ($left)" 15 tui-memory-cursor-kept)" = true ] && echo true || echo false)"
while [ "$left" -gt 0 ]; do
  tmux send-keys -t "$TMUX_SESSION" x
  [ "$(shows "Forget record" 15 tui-memory-confirm)" = true ] || break
  tmux send-keys -t "$TMUX_SESSION" Enter
  left=$((left - 1))
  if [ "$left" -gt 0 ]; then [ "$(shows "Memory ($left)" 15 tui-memory-fewer)" = true ] || break; fi
done
check "x and a confirm on each row forgets the records one by one, the list counting down" "$([ "$left" = 0 ] && echo true || echo false)"
check "the last one gone, a toast says the project has no record, and the list is closed" \
  "$([ "$(shows "No record of a session tree" 15 tui-memory-empty)" = true ] && ! grep -qF "Memory (" "$WORK/tui-memory-empty.txt" && echo true || echo false)"
check "and the RPC lists none" "$(memory_rpc records '{}' | jq -r '.output.records == []')"

echo "with the memory option off, the view says so"
tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
stop_server
jq '.plugins[0].options.memory = false' "$WORK/project/opencode.json" >"$WORK/project/opencode.json.new"
mv "$WORK/project/opencode.json.new" "$WORK/project/opencode.json"
git -C "$WORK/project" -c user.email=e2e@example.com -c user.name=e2e commit -qam "memory off"
start_server
check "the RPC says memory is off and lists nothing" "$(memory_rpc records '{}' | jq -r '.output.memory == false and .output.records == []')"
open_tui tui-memory-off "$parent"
check "the TUI is back on the parent" "$(shows "courier 2 idle" 60 tui-memory-off-footer)"
tmux send-keys -t "$TMUX_SESSION" "/courier memory"
sleep 1
tmux send-keys -t "$TMUX_SESSION" Enter
check "/courier memory says memory is off" "$([ "$(shows "Memory is off" 30 tui-memory-off)" = true ] && ! grep -qF "Memory (" "$WORK/tui-memory-off.txt" && echo true || echo false)"
tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
stop_server
jq 'del(.plugins[0].options.memory)' "$WORK/project/opencode.json" >"$WORK/project/opencode.json.new"
mv "$WORK/project/opencode.json.new" "$WORK/project/opencode.json"
git -C "$WORK/project" -c user.email=e2e@example.com -c user.name=e2e commit -qam "memory on"
start_server

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
  for screen in tui-waiting tui-panel tui-panel-reported tui-panel-closed tui-released tui-panel-again tui-panel-followed tui-panel-home tui-panel-back tui-panel-followed-closed tui-parent-again tui-narrow-footer tui-narrow-panel tui-widened tui-stop-confirm tui-stopped tui-home tui-inbox-footer tui-inbox-list tui-inbox-answers tui-past tui-past-inbox tui-past-panel tui-form tui-form-panel tui-form-dismissed tui-forget-open tui-forget tui-forget-panel tui-forget-confirm tui-forgotten tui-forget-empty tui-top tui-top-inbox tui-top-answers tui-top-closed tui-memory-list tui-memory-record tui-memory-lesson-confirm tui-memory-lesson-forgotten tui-memory-no-lesson tui-memory-back tui-memory-search tui-memory-unfiltered tui-memory-again tui-memory-cursor-confirm tui-memory-cursor-forgotten tui-memory-cursor tui-memory-cursor-kept tui-memory-confirm tui-memory-fewer tui-memory-empty tui-memory-off tui-installed; do
    echo "--- $screen"
    sed -n 1,40p "$WORK/$screen.txt" 2>/dev/null || true
  done
  for child in $children; do api "session/$child/message" >"$WORK/messages-$child.log" 2>&1 || true; done
fi

echo
[ "$failures" = 0 ] && echo "all checks passed" || { echo "$failures check(s) failed"; exit 1; }
