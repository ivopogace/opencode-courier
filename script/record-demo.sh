#!/usr/bin/env bash
# Records the README's demo: the TUI in tmux on e2e/mock-model.mjs's scripted model, with e2e/tui.sh's setup, typed
# into scene by scene, its pane written to an asciicast with a marker per scene (docs/maintainers/development.md).
#
#   OPENCODE_BIN=/path/to/opencode script/record-demo.sh [out.cast]   # default demo.cast; KEEP=1 keeps the temp dir
#
# COLS and ROWS (160×42) size the terminal, PACE (1) scales each hold on a finished step, TYPE_DELAY (0.05 s) is the
# pause between typed characters. script/render-demo.sh turns the cast into the narrated video.
set -euo pipefail
# Bash counts characters, not bytes, in what look measures.
export LC_ALL=C.UTF-8

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OPENCODE=${OPENCODE_BIN:-opencode}
OUT=$(realpath -m "${1:-demo.cast}")
COLS=${COLS:-160}
ROWS=${ROWS:-42}
PACE=${PACE:-1}
TYPE_DELAY=${TYPE_DELAY:-0.05}
MOCK_PORT=${MOCK_PORT:-4699}
SERVER_PORT=${SERVER_PORT:-4700}
WORK=${E2E_WORK:-$(mktemp -d)}
MOCK_PID=
TMUX_SESSION=courier-demo-$$
# shellcheck source=e2e/lib.sh
source "$ROOT/e2e/lib.sh"

command -v tmux >/dev/null || { echo "tmux is needed to record the demo"; exit 1; }

cleanup() {
  tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
  stop_server
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null
  if [ "${KEEP:-}" = 1 ]; then echo "kept $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

# A marker $1 in the cast: a scene's name, "focus <column> <row> <columns> <rows>" or "focus off", in cells from 1.
mark() { printf '%s\t%s\n' "$(date +%s%3N)" "$1" >>"$WORK/marks.tsv"; }
# Sends keys to the TUI; a key ends the highlight, so what is typed is never dimmed.
FOCUSED=
keys() {
  if [ -n "$FOCUSED" ]; then mark "focus off"; FOCUSED=; fi
  tmux send-keys -t "$TMUX_SESSION" "$@"
}
hold() { sleep "$(awk -v s="$1" -v p="$PACE" 'BEGIN { print s * p }')"; }
# Types $1 a character at a time, as a person would.
type_text() {
  local text=$1 i
  for ((i = 0; i < ${#text}; i++)); do
    keys -l -- "${text:i:1}"
    sleep "$TYPE_DELAY"
  done
}
# Types $1 into the prompt and sends it; a slash command waits a moment for its completion to show.
submit() {
  type_text "$1"
  sleep 0.6
  keys Enter
}
# Waits up to $2 s (30) for the screen to show $1; the screen is kept in $WORK/screens, and a miss ends the recording.
wait_for() {
  local name
  name=$(printf '%03d' "$(find "$WORK/screens" -type f | wc -l)")
  for _ in $(seq 1 "${2:-30}"); do
    if tmux capture-pane -pt "$TMUX_SESSION" | grep -qF -- "$1"; then
      tmux capture-pane -pt "$TMUX_SESSION" >"$WORK/screens/$name.txt"
      SCREEN=$WORK/screens/$name.txt
      return
    fi
    sleep 1
  done
  tmux capture-pane -pt "$TMUX_SESSION" >"$WORK/screens/$name.txt"
  echo "the screen did not show \"$1\" in time; it was:"
  cat "$WORK/screens/$name.txt"
  KEEP=1
  exit 1
}
# Waits up to $2 s (30) for $1 to leave the screen, as a toast does.
wait_gone() {
  for _ in $(seq 1 "${2:-30}"); do
    tmux capture-pane -pt "$TMUX_SESSION" | grep -qF -- "$1" || return 0
    sleep 1
  done
}
# The memory's RPC: method $1 with input $2, at the project's location.
memory_rpc() {
  curl -s -u "opencode:$OPENCODE_PASSWORD" -X POST -H 'content-type: application/json' -d "{\"input\":$2}" \
    "$SERVER/api/rpc/courier-memory/$1?directory=$(node -p 'encodeURIComponent(process.argv[1])' "$WORK/project")"
}
# Waits for $1 as wait_for does, then highlights it: $2 rows (1) down from its line, $3 columns (its length) from its
# start, or "line" for its line's text up to its end, on the last line showing it when $4 is "last". Its first cell is left
# in AT_COLUMN and AT_ROW.
look() {
  wait_for "$1" "${5:-30}"
  local found text prefix columns
  found=$(grep -nF -- "$1" "$SCREEN")
  if [ "${4:-}" = last ]; then found=$(tail -1 <<<"$found"); else found=$(head -1 <<<"$found"); fi
  AT_ROW=${found%%:*}
  text=${found#*:}
  prefix=${text%%"$1"*}
  AT_COLUMN=$((${#prefix} + 1))
  columns=${3:-${#1}}
  if [ "$columns" = line ]; then
    columns=$((AT_COLUMN - 1 + ${#1}))
    prefix=${text%%[! ]*}
    AT_COLUMN=$((${#prefix} + 1))
    columns=$((columns - ${#prefix}))
  fi
  [ $((AT_COLUMN + columns - 1)) -le "$COLS" ] || columns=$((COLS - AT_COLUMN + 1))
  mark "focus $AT_COLUMN $AT_ROW $columns ${2:-1}"
  FOCUSED=1
}
# Highlights $1 as look does, $2 columns wide, then clicks its first cell, as a terminal reports the left button.
click() {
  look "$1" 1 "${2:-}"
  hold 1.5
  keys -l "$(printf '\033[<0;%d;%dM' "$AT_COLUMN" "$AT_ROW")"
  keys -l "$(printf '\033[<0;%d;%dm' "$AT_COLUMN" "$AT_ROW")"
}
# Starts scene $1: a marker in the cast, and a line here.
scene() {
  echo "scene: $1"
  mark "$1"
}
# A new session from wherever the TUI is, its prompt ready.
new_session() {
  keys C-x n
  hold 1.5
}

mkdir -p "$WORK/project" "$WORK/screens" "$HOME" "$XDG_CONFIG_HOME/opencode"
echo '{ "highlights": false }' >"$XDG_CONFIG_HOME/opencode/cli.json"
build_plugin

cat >"$WORK/project/opencode.json" <<EOT
{
  "plugins": ["$ROOT/dist", "$ROOT/e2e/search-plugin"],
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

# Reports and failures are held back a while, so each parent has ended its turn when they land, and the viewer sees it wait.
MOCK_PORT=$MOCK_PORT MOCK_CHILD_DELAY_MS=${MOCK_CHILD_DELAY_MS:-3000} MOCK_LOG=$WORK/model.log \
  node "$ROOT/e2e/mock-model.mjs" >"$WORK/model.out" 2>&1 </dev/null &
MOCK_PID=$!
start_server
echo "OpenCode $("$OPENCODE" --version) on $SERVER, recording to $OUT"

# The TUI waits on a keypress, so the pane is piped to the cast before its first frame.
rm -f "$OUT" "$OUT.part"
tmux new-session -d -s "$TMUX_SESSION" -x "$COLS" -y "$ROWS" \
  "stty -echo; read -r _; cd '$WORK/project' && LANG=C.UTF-8 OPENCODE_PASSWORD='$OPENCODE_PASSWORD' TERM=xterm-256color exec '$OPENCODE' --server '$SERVER' 2>'$WORK/tui.err'"
tmux pipe-pane -t "$TMUX_SESSION" -o "node '$ROOT/script/demo-cast.mjs' '$OUT' $COLS $ROWS '$WORK/marks.tsv'"
keys Enter
wait_for "ctrl+p" 60
hold 3

scene "A join group"
submit "COURIER-TUI"
look "courier_spawn [task=Report back" 3 50
hold 2.5
look "1 waiting on you" 1 "" last
hold 3
submit "/courier tree"
look "courier tree  [" 6 76 "" 45
hold 6

scene "A click opens a child"
click "CHILD-ASKS  waiting" 50
look "CHILD-ASKS (on screen)" 2 60
hold 3
look "Allow once" 3 40 last
hold 3
click "Report back to your parent.  idle" 50
look "courier_send [" 1 60 last
hold 3
# Back to the parent, the first tab.
keys C-x
sleep 0.3
keys 1
wait_for "1/2 reported"
hold 1.5
keys q
hold 1

scene "The asks inbox"
keys C-x k
look "Permission: shell echo courier-asks" 1 60
hold 2.5
keys Enter
look "Allow once" 1 30
hold 1.5
keys Enter
look "Reports of group pair" 1 line last
hold 2
look "2 idle" 1 "" last
hold 2
# The tree's top notes a lesson on its record, for the memory scenes.
submit "COURIER-NOTE Give the docs to one session"
look "courier_note [text=" 1 50
hold 3

scene "A child whose turn fails"
new_session
submit "COURIER-FAIL"
look "Session failed" 3 46
hold 3
wait_gone "Session failed"
look " failed" 1 line last
hold 2
submit "/courier tree"
look "CHILD-FAILS  failed" 2 60
hold 4
keys q

scene "A child that ends its turn without a report"
new_session
submit "COURIER-SILENT"
look "ended without a report" 1 line last
hold 3
submit "/courier tree"
look "CHILD-SILENT  " 2 60
hold 4
keys q

scene "/courier stop"
new_session
submit "COURIER-SUBTREE-START"
look "2 running" 1 "" last
hold 2
submit "/courier stop"
look "Stop which session?" 5 60
hold 2.5
keys Enter
look "Stop \"" 4 52
hold 3
keys Enter
look "Stopped" 1 34
hold 3

scene "A form only you can answer"
new_session
submit "COURIER-SEARCH"
look "shows a form" 1 line last 45
hold 2
look "1 waiting on you" 1 "" last
hold 2
submit "/courier tree"
look "CHILD-SEARCHES  waiting" 2 60
hold 4
keys q
hold 1
keys C-x k
look "Form: Web Search" 1 60
hold 2.5
keys Enter
hold 2
keys Enter
look "Message from" 1 line last 45
hold 3

scene "The memory view"
submit "/courier memory"
wait_for "Memory ("
hold 2
# Down to the first tree's record, the one with the lesson, in the view's order: the RPC's.
lessoned=$(memory_rpc records '{}' | jq -r '.output.records | map(.lesson != null) | index(true)')
for _ in $(seq 1 "$lessoned"); do keys Down; sleep 0.4; done
look "lesson (" 1 50
hold 3
keys Enter
look "Top session" 8 70
hold 4
keys Escape
hold 1
keys p
look "Pinned \"" 1 50
hold 3
keys Escape
hold 1

scene "Recall from another tree"
new_session
submit "COURIER-RECALL"
look "pinned · lesson" 1 line "" 45
hold 6

tmux kill-session -t "$TMUX_SESSION"
for _ in $(seq 1 20); do [ -f "$OUT" ] && break; sleep 0.5; done
[ -f "$OUT" ] || { echo "the cast was not written; see $OUT.part"; KEEP=1; exit 1; }
echo "wrote $OUT ($(grep -c '^\[[0-9.]*, *"m", *"[^f]' "$OUT") scenes)"
