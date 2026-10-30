#!/usr/bin/env bash
# Records the README's GIF, an orchestrator fixing two issues in parallel through leads and their workers in the TUI, as the pane's screens and the markers
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
caption "Ask the top session to fix two issues in parallel"
submit "Fix issues #12 and #15 in parallel, one lead per issue"
look "courier_spawn [title=Issue #12" 6 72
caption "It starts a lead per issue with courier_spawn, both in one group"
hold 3
look "Two leads started" 1 78
caption "and ends its turn: the leads' reports will wake it. No polling."
hold 3.5

scene "The tree"
caption "Open the session tree"
command_line "/courier tree"
look "courier tree  [" 2 60 "" 45
caption "The orchestrator, a lead per issue, and the four workers the leads started"
hold 1
look "courier tree  [" 16 80
hold 4.5

scene "A lead"
caption "Switch sessions from the tree: ↓ to the lead of issue #12"
hold 1.5
select_row "Issue #12"
hold 1
caption "enter opens its session; the tree follows you"
press "enter" Enter
look "Two workers started" 1 78 "" 20
hold 1
look "courier_spawn [title=Cause of #12" 6 72
caption "The lead splits its issue again: one worker finds the cause, one writes a failing test"
hold 4

scene "A worker"
caption "Down to a worker, the orchestrator's grandchild, and enter"
hold 1
select_row "Test for #12"
hold 1
press "enter" Enter
look "Write a test that fails on issue #12" 1 72 "" 20
caption "The worker runs: it was briefed by its lead, and owes it a report"
hold 3
wait_for "Reported to my lead" 40
look "courier_send [" 2 72
caption "Its test fails on main: it reports to its lead with courier_send"
hold 4

scene "Back up"
caption "Back up to the lead, and enter"
hold 1
select_row "Issue #12"
hold 1
press "enter" Enter
look "Reports of group issue-12" 1 27 last 20
caption "The cause and the failing test woke the lead together, as one message"
hold 3.5
look "courier_send [" 3 72 last
caption "It fixed the issue and reported up to the orchestrator"
hold 3.5

scene "The top"
caption "Up to the orchestrator, and enter"
hold 1
select_row "Fix #12 and #15"
hold 1
press "enter" Enter
look "Both issues fixed" 2 78 last 60
caption "Once both leads have reported, the orchestrator wakes: both issues fixed"
hold 3
look "courier tree  [" 16 80
caption "Two issues fixed in parallel, seven sessions, and nothing polled"
hold 5

tmux kill-session -t "$TMUX_SESSION"
cp "$WORK/marks.tsv" "$OUT/marks.tsv"
printf '{ "columns": %d, "rows": %d }\n' "$COLS" "$ROWS" >"$OUT/size.json"
echo "wrote $OUT ($(find "$OUT/frames" -name '*.ans' | wc -l) screens)"
