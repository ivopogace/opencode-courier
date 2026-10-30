#!/usr/bin/env bash
# Records the README's GIF, an orchestrator, its leads and their workers in the TUI, as the pane's screens and the markers
# for script/render-gif.py:
#   OPENCODE_BIN=/path/to/opencode script/record-gif.sh [out dir]   # settings: docs/maintainers/development.md
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=$(realpath -m "${1:-demo-gif}")
ROWS=${ROWS:-40}
TUI_ENV=COLORTERM=truecolor
# A worker reports after two to five times this, so the tree still runs while the viewer moves through it.
MOCK_CHILD_DELAY_MS=${MOCK_CHILD_DELAY_MS:-7000}
# shellcheck source=script/demo-lib.sh
source "$ROOT/script/demo-lib.sh"

# The caption under the screen from now on.
caption() { mark "caption $1"; }
# Types $1 into the prompt and sends it, shown to the viewer as typed.
command_line() {
  mark "key $1"
  submit "$1"
}
# Moves the tree panel's selection, ▸, to the row titled $1 with ↓ or ↑, a key at a time.
select_row() {
  local at row
  for _ in $(seq 1 10); do
    wait_for "courier tree  ["
    at=$(grep -n -m1 "▸" "$SCREEN" | cut -d: -f1)
    row=$(grep -n -m1 -E "$1( \\(on screen\\))?  [a-z]+( ·| *$)" "$SCREEN" | cut -d: -f1)
    [ -n "$at" ] && [ -n "$row" ] || { echo "no row \"$1\" or no selection in the tree panel:"; cat "$SCREEN"; KEEP=1; exit 1; }
    [ "$at" = "$row" ] && return
    if [ "$at" -lt "$row" ]; then press "↓" Down; else press "↑" Up; fi
    sleep 0.7
  done
}
# The pane's screen, with its colours, and the cursor, about twelve times a second, until the pane closes.
record_pane() {
  rm -rf "$OUT"
  mkdir -p "$OUT/frames"
  echo "recording to $OUT"
  (
    while tmux has-session -t "$TMUX_SESSION" 2>/dev/null; do
      at=$(date +%s%3N)
      {
        tmux display -pt "$TMUX_SESSION" '#{cursor_x} #{cursor_y} #{cursor_flag}'
        tmux capture-pane -ept "$TMUX_SESSION"
      } >"$OUT/frames/$at.part" 2>/dev/null && mv "$OUT/frames/$at.part" "$OUT/frames/$at.ans"
      sleep 0.08
    done
  ) &
}
start_demo

scene "The orchestrator splits the work"
caption "Ask the top session for work it splits between two leads"
submit "Ship the /v2 API with a backend lead and a docs lead, each splitting its part"
look "courier_spawn [title=Backend lead" 6 70
caption "It starts both leads with courier_spawn, in one group"
hold 3
look "Two leads started" 1 62
caption "and ends its turn: the leads' reports will wake it. No polling."
hold 3.5

scene "The tree"
caption "Open the session tree"
command_line "/courier tree"
look "courier tree  [" 2 60 "" 45
caption "The orchestrator, its two leads, and the four workers the leads started"
hold 1
look "courier tree  [" 16 80
hold 4.5

scene "A lead"
caption "Switch sessions from the tree: ↓ to the Backend lead"
hold 1.5
select_row "Backend lead"
hold 1
caption "enter opens its session; the tree follows you"
press "enter" Enter
look "Two workers started" 1 64 "" 20
hold 1
look "courier_spawn [title=Endpoints" 6 60
caption "The lead split its part again, between two workers of its own"
hold 4

scene "A worker"
caption "Down to a worker, the orchestrator's grandchild, and enter"
hold 1
select_row "Endpoint tests"
hold 1
press "enter" Enter
look "Write the tests for the /v2 endpoints" 1 line "" 20
caption "The worker runs: it was briefed by its lead, and owes it a report"
hold 3
wait_for "Reported to my lead" 40
look "courier_send [" 2 72
caption "Done, it reports to its lead with courier_send"
hold 4

scene "Back up"
caption "Back up to the lead, and enter"
hold 1
select_row "Backend lead"
hold 1
press "enter" Enter
look "Reports of group api" 1 22 last 20
caption "Both workers' reports woke the lead together, as one message"
hold 3.5
look "courier_send [" 3 72 last
caption "and the lead reported up to the orchestrator"
hold 3.5

scene "The top"
caption "Up to the orchestrator, and enter"
hold 1
select_row "Ship the /v2 API"
hold 1
press "enter" Enter
look "Both leads reported" 2 72 last 60
caption "Once both leads have reported, the orchestrator wakes with the whole result"
hold 3
look "courier tree  [" 16 80
caption "Every session reported. Nothing polled."
hold 5

tmux kill-session -t "$TMUX_SESSION"
cp "$WORK/marks.tsv" "$OUT/marks.tsv"
printf '{ "columns": %d, "rows": %d }\n' "$COLS" "$ROWS" >"$OUT/size.json"
echo "wrote $OUT ($(find "$OUT/frames" -name '*.ans' | wc -l) screens)"
