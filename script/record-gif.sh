#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=$(realpath -m "${1:-demo-gif}")
ROWS=${ROWS:-40}
TUI_ENV=COLORTERM=truecolor
MOCK_CHILD_DELAY_MS=${MOCK_CHILD_DELAY_MS:-7000}
# shellcheck source=script/demo-lib.sh
source "$ROOT/script/demo-lib.sh"

caption() { mark "caption $1"; }
command_line() {
  mark "key $1"
  submit "$1"
}
select_row() {
  local at row
  for _ in $(seq 1 10); do
    wait_for "courier tree  ["
    at=$(grep -n -m1 "▸" "$SCREEN" | cut -d: -f1 || true)
    row=$(grep -n -m1 -E "$1( \\(on screen\\))?  [a-z]+( ·| *$)" "$SCREEN" | cut -d: -f1 || true)
    [ -n "$at" ] && [ -n "$row" ] || { echo "no row \"$1\" or no selection in the tree panel:"; cat "$SCREEN"; KEEP=1; exit 1; }
    [ "$at" = "$row" ] && return
    if [ "$at" -lt "$row" ]; then press "↓" Down; else press "↑" Up; fi
    sleep 0.7
  done
}
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
caption "It starts a lead per issue with courier_spawn, in one group: it needs only both results"
hold 3.5
look "Two leads started" 1 78
caption "and ends its turn: the group's message will wake it. No polling."
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
hold 3.5
look "Two workers started" 1 78
caption "In no group: each worker's message wakes the lead as it comes"
hold 3.5

scene "A finding"
look "Message from" 1 line "" 45
caption "Mid-run, the cause worker finds what the test needs and sends it up at once, without a status"
hold 3.5
look "courier_send [" 2 72
caption "It wakes the lead, which passes the finding on to the test worker"
hold 3.5
look "Cause of #12" 2 80
caption "In the tree the cause worker still runs and owes its report: a finding is not one"
hold 4

scene "The test worker"
caption "Down to the test worker, the orchestrator's grandchild, and enter"
hold 1
select_row "Test for #12"
hold 1
press "enter" Enter
look "log in, wait 31 s" 1 line "" 20
caption "It had drafted a test that logs in plainly, which passes on main"
hold 3.5
look "Message from" 1 line last 20
caption "The lead's message lands in its running turn"
hold 3
look "log in with remember me" 1 line "" 30
caption "and it rewrites the test with remember me on, as the cause worker found"
hold 4
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
look "One part reported" 1 78 "" 20
caption "Each report woke the lead as it came"
hold 3
look "courier_send [" 3 72 last 30
caption "With both in, it fixed the issue and reported up to the orchestrator"
hold 3.5

scene "The top"
caption "Up to the orchestrator, and enter"
hold 1
select_row "Fix #12 and #15"
hold 1
press "enter" Enter
look "Reports of group issues" 1 line last 60
caption "Its leads were a join group, its choice for a pure fan-in: their reports came as one message"
hold 3.5
look "Both issues fixed" 2 78 last
caption "Both issues fixed"
hold 3
look "courier tree  [" 16 80
caption "Two issues fixed in parallel, a finding passed on mid-run, and nothing polled"
hold 5

tmux kill-session -t "$TMUX_SESSION"
cp "$WORK/marks.tsv" "$OUT/marks.tsv"
printf '{ "columns": %d, "rows": %d }\n' "$COLS" "$ROWS" >"$OUT/size.json"
echo "wrote $OUT ($(find "$OUT/frames" -name '*.ans' | wc -l) screens)"
