# Shared by script/record-demo.sh and script/record-gif.sh: the TUI in tmux on e2e/mock-model.mjs's model, driven step by
# step, with markers in $WORK/marks.tsv. Source it after setting ROOT; start_demo then starts it all, record_pane hooked in.
# Bash counts characters, not bytes, in what look measures.
export LC_ALL=C.UTF-8

OPENCODE=${OPENCODE_BIN:-opencode}
COLS=${COLS:-160}
ROWS=${ROWS:-42}
PACE=${PACE:-1}
TYPE_DELAY=${TYPE_DELAY:-0.05}
MOCK_PORT=${MOCK_PORT:-4699}
SERVER_PORT=${SERVER_PORT:-4700}
WORK=${E2E_WORK:-$(mktemp -d)}
MOCK_PID=
TMUX_SESSION=courier-demo-$$
# Added to the TUI's environment, as COLORTERM=truecolor.
TUI_ENV=${TUI_ENV:-}
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

# A marker $1: a scene's name, "focus <column> <row> <columns> <rows>" or "focus off", in cells from 1, "caption <text>",
# "key <label>" or "click <column> <row>".
mark() { printf '%s\t%s\n' "$(date +%s%3N)" "$1" >>"$WORK/marks.tsv"; }
# Sends keys to the TUI; a key ends the highlight, so what is typed is never dimmed.
FOCUSED=
keys() {
  if [ -n "$FOCUSED" ]; then mark "focus off"; FOCUSED=; fi
  tmux send-keys -t "$TMUX_SESSION" "$@"
}
# Sends keys $2… to the TUI, shown to the viewer as $1.
press() {
  mark "key $1"
  shift
  keys "$@"
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
# Waits up to $5 s for $1, then highlights $2 rows (1) of it, $3 columns (its length) from it or, with "line", from its
# line's text, on the last line showing it when $4 is "last"; the box's first cell is left in AT_COLUMN and AT_ROW.
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
  mark "click $AT_COLUMN $AT_ROW"
  keys -l "$(printf '\033[<0;%d;%dM' "$AT_COLUMN" "$AT_ROW")"
  keys -l "$(printf '\033[<0;%d;%dm' "$AT_COLUMN" "$AT_ROW")"
}
# Starts scene $1: a marker, and a line here.
scene() {
  echo "scene: $1"
  mark "$1"
}

# The project, the mock model and the server, then the TUI in tmux, which waits on a keypress until record_pane, defined
# by the script sourcing this file, has hooked the pane; returns once the TUI shows.
start_demo() {
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
  echo "OpenCode $("$OPENCODE" --version) on $SERVER"

  tmux new-session -d -s "$TMUX_SESSION" -x "$COLS" -y "$ROWS" \
    "stty -echo; read -r _; cd '$WORK/project' && LANG=C.UTF-8 $TUI_ENV OPENCODE_PASSWORD='$OPENCODE_PASSWORD' TERM=xterm-256color exec '$OPENCODE' --server '$SERVER' 2>'$WORK/tui.err'"
  record_pane
  keys Enter
  wait_for "ctrl+p" 60
  hold 3
}
