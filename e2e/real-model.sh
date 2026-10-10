#!/usr/bin/env bash
# Smoke test with a real model: the same throwaway OpenCode V2 server as run.sh, with this plugin
# loaded, but a real model instead of the scripted one. The parent is asked to fan a small task out
# to two children; the script records which tools the parent called and in what order, whether it
# ended its turn instead of polling, whether each child called courier_send, and whether both
# reports woke the parent. Not run in CI: it needs a model provider.
#
#   OPENCODE_BIN=/path/to/opencode e2e/real-model.sh
#
# COURIER_SCENARIO=permission runs the permission relay instead: one child whose command needs an
# approval, a parent that should ask the person rather than answer by itself, and this script as
# the person, answering "once" (e2e/real-model-permission.mjs); with COURIER_PERSON=other-server, a
# second server runs on the same data directory and the person answers the parent through it, where
# the child's request is not pending. COURIER_SCENARIO=question runs the
# question relay: one child that is to find out from the person which greeting to use, and this
# script as the person, answering COURIER_ANSWER (default Hi) in the parent's session
# (e2e/real-model-question.mjs). COURIER_SCENARIO=recursive runs the recursive orchestration: a
# job of two parts, one of which the session that gets it splits again, checked by
# e2e/real-model-recursive.mjs down the whole tree.
#
# The default model is a free one on OpenCode Zen, which needs no key. To pick another:
#
#   COURIER_PROVIDER, COURIER_MODEL  the model, as OpenCode names it (default opencode,
#                                     longcat-2.5-preview-free).
#   COURIER_BASE_URL                 declare the provider in opencode.json as an OpenAI-compatible
#                                     endpoint with this URL and the model. Default for the opencode
#                                     provider: https://opencode.ai/zen/v1, so no model catalog is
#                                     needed. Set it empty to use OpenCode's catalog (models.dev)
#                                     instead, with the provider's usual key variable, such as
#                                     ANTHROPIC_API_KEY.
#   COURIER_API_KEY_ENV              for a declared provider, the variable holding its key. The
#                                     config refers to it as {env:NAME}; the key is never written.
#   COURIER_PROMPT, COURIER_EXPECT   the parent's prompt and the values the reports must hold.
#   COURIER_FILES                    recursive: the files, relative to the project, that must hold them.
#   COURIER_MAX_DEPTH                recursive: the maxDepth the checker holds the tree to (default 3).
#   COURIER_TIMEOUT                  seconds to wait for the parent's turn and then for the
#                                     children (default 300 each).
#
# Transcripts (parent.json, child-*.json), timeline.txt, summary.json and the server log stay in
# the work directory (E2E_WORK, default a new temp dir), which is printed at the end.
#
# Needs node, npm, bun (for the build), git, curl, jq and GNU timeout (gtimeout on macOS, from
# coreutils).
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OPENCODE=${OPENCODE_BIN:-opencode}
SERVER_PORT=${SERVER_PORT:-4610}
OTHER_PORT=${OTHER_PORT:-4611}
OTHER_PID=
PROVIDER=${COURIER_PROVIDER:-opencode}
MODEL=${COURIER_MODEL:-longcat-2.5-preview-free}
if [ -z "${COURIER_BASE_URL+set}" ] && [ "$PROVIDER" = opencode ]; then
  BASE_URL=https://opencode.ai/zen/v1
else
  BASE_URL=${COURIER_BASE_URL:-}
fi
KEY_ENV=${COURIER_API_KEY_ENV:-}
export COURIER_TIMEOUT=${COURIER_TIMEOUT:-300}
SCENARIO=${COURIER_SCENARIO:-fanout}
# Every action is allowed; the permission scenario adds a rule that makes its one command ask.
PERMISSIONS='[{ "action": "*", "resource": "*", "effect": "allow" }]'
case $SCENARIO in
  fanout)
    # The sleeps stand in for real work: they keep the children busy until the parent's turn has
    # ended, and apart, so each report finds it idle.
    PROMPT=${COURIER_PROMPT:-'Have two helper sessions work in parallel and report back to you. One runs the shell command `sleep 20; echo $((17 * 23))`, the other runs `sleep 40; echo $((2 ** 10))`, and each reports the number it printed. Start them with courier_spawn and do not run the commands yourself. When both have reported back, reply with one line: RESULTS <first> <second>'}
    export COURIER_EXPECT=${COURIER_EXPECT:-"391 1024"}
    CHECKER=real-model.mjs
    ;;
  permission)
    PROMPT=${COURIER_PROMPT:-'Have a helper session run the shell command `echo courier-permission-$((6 * 7))` and report back what it printed. Start it with courier_spawn and do not run the command yourself. When it has reported back, reply with one line: RESULT <what it printed>'}
    export COURIER_EXPECT=${COURIER_EXPECT:-"courier-permission-42"}
    PERMISSIONS='[{ "action": "*", "resource": "*", "effect": "allow" }, { "action": "shell", "resource": "*courier-permission*", "effect": "ask" }]'
    CHECKER=real-model-permission.mjs
    ;;
  question)
    # The child is not told how to ask: the brief's line on the question tool is part of the test.
    PROMPT=${COURIER_PROMPT:-'Start one helper session with courier_spawn and give it this task, word for word: "Find out from the user which greeting they want to use: Hello, Hi or Hey. Then report the chosen greeting to the session that started you." Do not ask the user anything yourself before the helper does, and do not do the task yourself. When the helper reports back, reply with one line: GREETING <the greeting it reported>'}
    export COURIER_ANSWER=${COURIER_ANSWER:-Hi}
    CHECKER=real-model-question.mjs
    ;;
  recursive)
    # Two parts, one of them two halves of its own: the root splits once, the session that gets that
    # part splits again. The sleeps stand in for work, as in the fan-out; the files are what each level verifies.
    PROMPT=${COURIER_PROMPT:-'Have this job done through helper sessions started with courier_spawn, one session per part, and do no part yourself. It has two parts. Part "numbers" is itself two independent halves, which the session that gets it hands to two sessions of its own: one runs `sleep 20; echo $((17 * 23))` and writes the number it printed to numbers/a.txt, the other runs `sleep 20; echo $((2 ** 10))` and writes the number it printed to numbers/b.txt. Part "count" runs `sleep 20; echo $((99 - 57))` and writes the number it printed to count/total.txt. When the parts have reported back, read the three files yourself and reply with one line: RESULTS <a> <b> <total>'}
    export COURIER_EXPECT=${COURIER_EXPECT:-"391 1024 42"}
    export COURIER_FILES=${COURIER_FILES:-"numbers/a.txt numbers/b.txt count/total.txt"}
    CHECKER=real-model-recursive.mjs
    ;;
  *) echo "COURIER_SCENARIO must be fanout, recursive, permission or question"; exit 1 ;;
esac
unset COURIER_OTHER_SERVER
case ${COURIER_PERSON:-} in
  "") ;;
  other-server) [ "$SCENARIO" = permission ] || { echo "COURIER_PERSON=other-server goes with COURIER_SCENARIO=permission"; exit 1; } ;;
  *) echo "COURIER_PERSON must be other-server, or unset"; exit 1 ;;
esac
WORK=${E2E_WORK:-$(mktemp -d)}
export WORK
# shellcheck source=e2e/lib.sh
source "$ROOT/e2e/lib.sh"
export SERVER OPENCODE_PASSWORD

cleanup() {
  stop_server
  if [ -n "$OTHER_PID" ]; then kill "$OTHER_PID" 2>/dev/null || true; wait "$OTHER_PID" 2>/dev/null || true; fi
  echo "transcripts and logs in $WORK"
}
trap cleanup EXIT

TIMEOUT_BIN=$(command -v timeout || command -v gtimeout || true)
[ -n "$TIMEOUT_BIN" ] || { echo "needs timeout from GNU coreutils (on macOS: brew install coreutils)"; exit 1; }
if [ -n "$KEY_ENV" ]; then
  [[ $KEY_ENV =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "COURIER_API_KEY_ENV must be a variable name"; exit 1; }
  [ -n "${!KEY_ENV:-}" ] || { echo "$KEY_ENV is not set"; exit 1; }
fi

mkdir -p "$WORK/project" "$HOME"
build_plugin

provider='{}'
if [ -n "$BASE_URL" ]; then
  provider=$(jq -n --arg id "$PROVIDER" --arg url "$BASE_URL" --arg model "$MODEL" --arg key "$KEY_ENV" '{
    ($id): {
      package: "aisdk:@ai-sdk/openai-compatible",
      settings: ({ baseURL: $url } + (if $key == "" then {} else { apiKey: "{env:\($key)}" } end)),
      models: { ($model): {} }
    }
  }')
fi
jq -n --arg plugin "$ROOT/dist" --arg model "$PROVIDER/$MODEL" --argjson providers "$provider" --argjson permissions "$PERMISSIONS" '{
  plugins: [$plugin],
  providers: $providers,
  model: $model,
  update: "disable",
  permissions: $permissions
}' >"$WORK/project/opencode.json"
commit_config

start_server
echo "OpenCode $("$OPENCODE" --version) on $SERVER, model $PROVIDER/$MODEL"
if [ "${COURIER_PERSON:-}" = other-server ]; then
  # A second server on the same data directory, started once the first is up (two starting at once
  # race to create the database's tables), as in e2e/two-servers.sh.
  OTHER="http://127.0.0.1:$OTHER_PORT"
  export COURIER_OTHER_SERVER=$OTHER
  (cd "$WORK/project" && exec "$OPENCODE" serve --hostname 127.0.0.1 --port "$OTHER_PORT" --print-logs >>"$WORK/server-b.log" 2>&1 </dev/null) &
  OTHER_PID=$!
  for _ in $(seq 1 30); do curl -sf -u "opencode:$OPENCODE_PASSWORD" "$OTHER/api/info" >/dev/null 2>&1 && break; sleep 1; done
  curl -sf -u "opencode:$OPENCODE_PASSWORD" "$OTHER/api/info" >/dev/null || { echo "the second server did not start; see $WORK/server-b.log"; exit 1; }
  echo "a second server on the same data directory: $OTHER"
fi
echo "parent prompt: $PROMPT"

post() { curl -sf -u "opencode:$OPENCODE_PASSWORD" -X POST -H 'content-type: application/json' --data "$2" "$SERVER/api/$1"; }
if [ "$SCENARIO" != fanout ] && [ "$SCENARIO" != recursive ]; then
  # Started through the API, as a session in the TUI would be, not with opencode run: run cancels
  # any question form opened in its session while it is attached, and the child's request can wake
  # the parent before run has let go. The checker waits for the turns.
  parent=$(post session "$(jq -n --arg directory "$WORK/project" '{ location: { directory: $directory } }')" | jq -r '.data.id // empty' || true)
  [ -z "$parent" ] || post "session/$parent/prompt" "$(jq -n --arg text "$PROMPT" '{ text: $text }')" >/dev/null || parent=
else
  # The parent's first turn; run returns when it ends.
  status=0
  (cd "$WORK/project" && "$TIMEOUT_BIN" "$COURIER_TIMEOUT" "$OPENCODE" run --server "$SERVER" --auto --format json "$PROMPT" \
    </dev/null >"$WORK/parent-run.jsonl" 2>"$WORK/parent-run.err") || status=$?
  case $status in
    0) ;;
    124) echo "the parent's first turn did not end within $COURIER_TIMEOUT s" ;;
    *) echo "opencode run exited with status $status; see $WORK/parent-run.err" ;;
  esac
  parent=$(jq -r 'select(.sessionID != null) | .sessionID' "$WORK/parent-run.jsonl" 2>/dev/null | head -1 || true)
fi
if [ -z "$parent" ]; then
  echo "no parent session; see $WORK/parent-run.err and $WORK/server.log"
  exit 1
fi
echo "parent $parent; waiting for its children"
node "$ROOT/e2e/$CHECKER" "$parent"
