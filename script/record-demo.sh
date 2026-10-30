#!/usr/bin/env bash
# Records the README's demo, the TUI in tmux on e2e/mock-model.mjs's model, to an asciicast for script/render-demo.sh:
#   OPENCODE_BIN=/path/to/opencode script/record-demo.sh [out.cast]   # settings: docs/maintainers/development.md
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=$(realpath -m "${1:-demo.cast}")
# shellcheck source=script/demo-lib.sh
source "$ROOT/script/demo-lib.sh"

# A new session from wherever the TUI is, its prompt ready.
new_session() {
  keys C-x n
  hold 1.5
}
# The memory's RPC: method $1 with input $2, at the project's location.
memory_rpc() {
  curl -s -u "opencode:$OPENCODE_PASSWORD" -X POST -H 'content-type: application/json' -d "{\"input\":$2}" \
    "$SERVER/api/rpc/courier-memory/$1?directory=$(node -p 'encodeURIComponent(process.argv[1])' "$WORK/project")"
}
# The TUI waits on a keypress, so the pane is piped to the cast before its first frame.
record_pane() {
  rm -f "$OUT" "$OUT.part"
  echo "recording to $OUT"
  tmux pipe-pane -t "$TMUX_SESSION" -o "node '$ROOT/script/demo-cast.mjs' '$OUT' $COLS $ROWS '$WORK/marks.tsv'"
}
start_demo

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
[ "$lessoned" != null ] || { echo "no record of the project has the first tree's lesson"; KEEP=1; exit 1; }
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
