#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OPENCODE=${OPENCODE_BIN:-opencode}
SERVER_PORT=${SERVER_PORT:-4610}
OTHER_PORT=${OTHER_PORT:-4611}
OTHER_PID=
PROVIDER=${COURIER_PROVIDER:-opencode}
MODEL=${COURIER_MODEL:-deepseek-v4.1-flash-free}
BASE_URL=${COURIER_BASE_URL:-}
KEY_ENV=${COURIER_API_KEY_ENV:-}
export COURIER_TIMEOUT=${COURIER_TIMEOUT:-300}
SCENARIO=${COURIER_SCENARIO:-fanout}
CHECKER_FLAGS=
SEED_PROJECT=
PERMISSIONS='[{ "action": "*", "resource": "*", "effect": "allow" }]'
case $SCENARIO in
  fanout)
    PROMPT=${COURIER_PROMPT:-'Have two helper sessions work in parallel and report back to you. One runs the shell command `echo $((17 * 23))`, the other runs `echo $((2 ** 10))`, and each reports the number it printed. Start them with courier_spawn and do not run the commands yourself. When both have reported back, reply with one line: RESULTS <first> <second>'}
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
    PROMPT=${COURIER_PROMPT:-'Start one helper session with courier_spawn and give it this task, word for word: "Find out from the user which greeting they want to use: Hello, Hi or Hey. Then report the chosen greeting to the session that started you." Do not ask the user anything yourself before the helper does, and do not do the task yourself. When the helper reports back, reply with one line: GREETING <the greeting it reported>'}
    export COURIER_ANSWER=${COURIER_ANSWER:-Hi}
    CHECKER=real-model-question.mjs
    ;;
  recursive)
    PROMPT=${COURIER_PROMPT:-'Have this job done through helper sessions started with courier_spawn, one session per part, and do no part yourself. It has two parts. Part "numbers" is itself two independent halves, which the session that gets it hands to two sessions of its own: one runs `echo $((17 * 23))` and writes the number it printed to numbers/a.txt, the other runs `echo $((2 ** 10))` and writes the number it printed to numbers/b.txt. Part "count" runs `echo $((99 - 57))` and writes the number it printed to count/total.txt. When the parts have reported back, read the three files yourself and reply with one line: RESULTS <a> <b> <total>'}
    export COURIER_EXPECT=${COURIER_EXPECT:-"391 1024 42"}
    export COURIER_FILES=${COURIER_FILES:-"numbers/a.txt numbers/b.txt count/total.txt"}
    CHECKER=real-model-recursive.mjs
    ;;
  recursive-fault)
    PROMPT=${COURIER_PROMPT:-'Have this job done through helper sessions started with courier_spawn, one session per part, and do no part yourself. It has two parts. Part "numbers" is itself two independent halves, which the session that gets it hands to two sessions of its own, doing neither half itself: one runs `echo $((17 * 23))` and writes the number it printed to numbers/a.txt; the other gets this task, passed on word for word: "Run `echo $((2 ** 10))`. Do not write any file yet: report status partial with the number it printed, saying that writing it to numbers/b.txt is left, and end your turn. Once the session that started you sends you a message to finish, write the number to numbers/b.txt and report status done." Part "count" runs `echo $((99 - 57))` and writes the number it printed to count/total.txt. When the parts have reported back, read the three files yourself and reply with one line: RESULTS <a> <b> <total>'}
    export COURIER_EXPECT=${COURIER_EXPECT:-"391 1024 42"}
    export COURIER_FILES=${COURIER_FILES:-"numbers/a.txt numbers/b.txt count/total.txt"}
    CHECKER=real-model-recursive.mjs
    CHECKER_FLAGS=--fault
    ;;
  recursive-staged)
    PROMPT=${COURIER_PROMPT:-'Have this job done through helper sessions started with courier_spawn, one session per part, and do no part yourself. It has two parts. Part "numbers" has a seed and two halves; the session that gets it hands the halves to two sessions of its own. The seed: run `echo $((7 * 61))` and write the number it printed to numbers/seed.txt. The halves each read the seed from numbers/seed.txt: one writes the seed times 17 to numbers/a.txt, the other writes the seed plus 1000 to numbers/b.txt. Part "count" runs `echo $((99 - 57))` and writes the number it printed to count/total.txt. When the parts have reported back, read the four files yourself and reply with one line: RESULTS <seed> <a> <b> <total>'}
    export COURIER_EXPECT=${COURIER_EXPECT:-"427 7259 1427 42"}
    export COURIER_FILES=${COURIER_FILES:-"numbers/seed.txt numbers/a.txt numbers/b.txt count/total.txt"}
    CHECKER=real-model-recursive.mjs
    CHECKER_FLAGS=--staged
    ;;
  recursive-finding | recursive-conflict)
    PROMPT=${COURIER_PROMPT:-'Have this job done through helper sessions started with courier_spawn, one session per part, and do no part yourself. It has two parts. Part "numbers" is itself two independent halves, which the session that gets it hands to two sessions of its own: one runs `for i in $(seq 150); do [ -e .go-halves ] && break; sleep 1; done; echo $((17 * 23))` and writes the number it printed to numbers/a.txt, the other runs `for i in $(seq 150); do [ -e .go-halves ] && break; sleep 1; done; echo $((2 ** 10))` and writes the number it printed to numbers/b.txt. Part "count" runs `for i in $(seq 150); do [ -e .go-count ] && break; sleep 1; done; echo $((99 - 57))` and writes the number it printed to count/total.txt. Another process, outside this job, creates .go-halves and .go-count when those commands may go on: no session creates, removes or looks at those files, and each command is run exactly as written. When the parts have reported back, read the three files yourself and reply with one line: RESULTS <a> <b> <total>'}
    if [ "$SCENARIO" = recursive-conflict ]; then
      export COURIER_EXPECT=${COURIER_EXPECT:-"391 42"}
      export COURIER_FILES=${COURIER_FILES:-"numbers/a.txt count/total.txt"}
      CHECKER_FLAGS=--conflict
    else
      export COURIER_EXPECT=${COURIER_EXPECT:-"391 1024 42"}
      export COURIER_FILES=${COURIER_FILES:-"numbers/a.txt numbers/b.txt count/total.txt"}
      CHECKER_FLAGS=--finding
    fi
    CHECKER=real-model-recursive.mjs
    ;;
  discovery)
    SEED_PROJECT=discovery-project
    PROMPT=${COURIER_PROMPT:-'This project has a price API, api.sh: once `sh api.sh init` has been run, `sh api.sh get <id>` prints the amount of an item as a whole number of cents. Have this job done through helper sessions started with courier_spawn, one session per part, all started together, and do no part yourself: run no api.sh command. It has three parts. Part "init" runs `sh api.sh init`, once, and reports what it printed. Part "a" first runs `for i in $(seq 150); do [ -e .go-parts ] && break; sleep 1; done` exactly as written, then gets the amount of item a from the API and writes it to out/a.txt. Part "b" first runs `for i in $(seq 150); do [ -e .go-parts ] && break; sleep 1; done` exactly as written, then gets the amount of item b from the API and writes it to out/b.txt. Another process, outside this job, creates .go-parts when parts "a" and "b" may go on: no session creates, removes or looks at that file. When the parts have reported back, read out/a.txt and out/b.txt yourself and reply with one line: RESULTS <a> <b>'}
    export COURIER_EXPECT=${COURIER_EXPECT:-"1999 2550"}
    export COURIER_FILES=${COURIER_FILES:-"out/a.txt out/b.txt"}
    CHECKER=real-model-discovery.mjs
    ;;
  review)
    SEED_PROJECT=review-project
    PROMPT=${COURIER_PROMPT:-'The tests of this project run with `npm test`. The job: add a function `slugify(text)` to lib/words.js, exported like the one already there, that lower-cases the text, turns every run of characters other than letters and digits into one hyphen and strips hyphens from both ends, so that "Hello, World!" gives "hello-world"; with tests for it in test/words.test.js, at least three, one of them for text with punctuation at both ends. Do none of the work yourself. First, one helper session started with courier_spawn makes the change and reports. Once it has reported, one review session with fresh context, started with courier_spawn, reads the change against this job, changes nothing and reports what it found. Then have any finding that holds fixed by a helper session. Finally run `npm test` yourself and reply with one line: REVIEWED <the number of passing tests>'}
    export COURIER_EXPECT=${COURIER_EXPECT:-slugify}
    export COURIER_FILES=${COURIER_FILES:-"lib/words.js test/words.test.js"}
    export COURIER_TESTS=${COURIER_TESTS:-5}
    CHECKER=real-model-review.mjs
    ;;
  *) echo "COURIER_SCENARIO must be fanout, recursive, recursive-fault, recursive-staged, recursive-finding, recursive-conflict, discovery, review, permission or question"; exit 1 ;;
esac
case ${COURIER_SKILL:-} in
  "") ;;
  deny) PERMISSIONS=$(jq -c '. + [{ action: "skill", resource: "courier-orchestrate", effect: "deny" }]' <<<"$PERMISSIONS") ;;
  *) echo "COURIER_SKILL must be deny, or unset"; exit 1 ;;
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
jq -n --arg plugin "$ROOT/dist" --arg probe "$ROOT/e2e/probe-plugin" --arg probelog "$WORK/probe.log" --arg model "$PROVIDER/$MODEL" --argjson providers "$provider" --argjson permissions "$PERMISSIONS" '{
  plugins: [$plugin, { package: $probe, options: { log: $probelog } }],
  providers: $providers,
  model: $model,
  update: "disable",
  permissions: $permissions
}' >"$WORK/project/opencode.json"
commit_config
if [ -n "${SEED_PROJECT:-}" ]; then
  cp -R "$ROOT/e2e/fixtures/$SEED_PROJECT/." "$WORK/project/"
  git -C "$WORK/project" add -A
  git -C "$WORK/project" -c user.email=e2e@example.com -c user.name=e2e commit -q -m "the project"
fi

SERVER_FLAGS="--log-level debug"
start_server
echo "OpenCode $("$OPENCODE" --version) on $SERVER, model $PROVIDER/$MODEL${COURIER_SKILL:+, courier-orchestrate denied}"
if [ "${COURIER_PERSON:-}" = other-server ]; then
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
if [ "$SCENARIO" != fanout ] && [ "$SCENARIO" != recursive ] && [ "$SCENARIO" != recursive-fault ] && [ "$SCENARIO" != recursive-staged ] && [ "$SCENARIO" != recursive-finding ] && [ "$SCENARIO" != recursive-conflict ]; then
  parent=$(post session "$(jq -n --arg directory "$WORK/project" '{ location: { directory: $directory } }')" | jq -r '.data.id // empty' || true)
  [ -z "$parent" ] || post "session/$parent/prompt" "$(jq -n --arg text "$PROMPT" '{ text: $text }')" >/dev/null || parent=
else
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
node "$ROOT/e2e/$CHECKER" "$parent" ${CHECKER_FLAGS:+"$CHECKER_FLAGS"}
