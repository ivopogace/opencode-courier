#!/usr/bin/env bash
# Live end-to-end test: a real OpenCode V2 server with this plugin loaded, driven by a scripted
# stand-in model (e2e/mock-model.mjs), so no API key is needed.
#
#   OPENCODE_BIN=/path/to/opencode e2e/run.sh      # KEEP=1 keeps the temp dir and logs
#
# E2E_WORK picks the working directory (CI points it somewhere it can upload the logs from).
#
# Needs node and npm, bun (for the build), git, curl, jq and openssl.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OPENCODE=${OPENCODE_BIN:-opencode}
MOCK_PORT=${MOCK_PORT:-4599}
SERVER_PORT=${SERVER_PORT:-4600}
WEBHOOK_PORT=${WEBHOOK_PORT:-4601}
REGISTRY_PORT=${REGISTRY_PORT:-4602}
CHILD_DELAY_MS=${CHILD_DELAY_MS:-5000}
WORK=${E2E_WORK:-$(mktemp -d)}
MOCK_PID=
REGISTRY_PID=
# shellcheck source=e2e/lib.sh
source "$ROOT/e2e/lib.sh"

cleanup() {
  stop_server
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null
  if [ -n "$REGISTRY_PID" ]; then
    kill "$REGISTRY_PID" 2>/dev/null || true
    "$OPENCODE" service stop >/dev/null 2>&1 </dev/null || true
  fi
  if [ "${KEEP:-}" = 1 ]; then echo "kept $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

prompt() { (cd "$WORK/project" && "$OPENCODE" run --server "$SERVER" --auto --format json "$1" </dev/null); }
# Like prompt, but a new turn in the existing session $1.
prompt_in() { (cd "$WORK/project" && "$OPENCODE" run --server "$SERVER" --auto --format json --session "$1" "$2" </dev/null); }
now_ms() { node -e 'console.log(Date.now())'; }
failures=0
check() {
  if [ "$2" = true ]; then echo "  PASS $1"; else echo "  FAIL $1"; failures=$((failures + 1)); fi
}
# The time a session's assistant message containing $2 was created, waiting up to $3 (default 30) s.
reply_time() {
  for _ in $(seq 1 "${3:-30}"); do
    local found
    found=$(api "session/$1/message" | jq -r --arg text "$2" \
      '[.data[] | select(.type == "assistant") | select([.content[]? | select(.type == "text") | .text] | join("") | contains($text)) | .time.created] | first // empty')
    if [ -n "$found" ]; then echo "$found"; return; fi
    sleep 1
  done
}

mkdir -p "$WORK/project" "$HOME"
WEBHOOK_SECRET=courier-e2e-webhook-secret
printf '%s\n' "$WEBHOOK_SECRET" >"$WORK/webhook-secret"
build_plugin

cat >"$WORK/project/opencode.json" <<EOF
{
  "plugins": [
    { "package": "$ROOT/dist", "options": { "maxDepth": 2, "webhook": { "port": $WEBHOOK_PORT, "secretFile": "$WORK/webhook-secret" } } },
    "$ROOT/e2e/search-plugin",
    { "package": "$ROOT/e2e/probe-plugin", "options": { "log": "$WORK/probe.log" } }
  ],
  "providers": {
    "mock": {
      "package": "aisdk:@ai-sdk/openai-compatible",
      "settings": { "baseURL": "http://127.0.0.1:$MOCK_PORT/v1", "apiKey": "mock" },
      "models": { "chat": {}, "other": {} }
    }
  },
  "model": "mock/chat",
  "update": "disable",
  "permissions": [
    { "action": "*", "resource": "*", "effect": "allow" },
    { "action": "shell", "resource": "echo courier-asks*", "effect": "ask" }
  ]
}
EOF
commit_config

MOCK_PORT=$MOCK_PORT MOCK_CHILD_DELAY_MS=$CHILD_DELAY_MS MOCK_LOG=$WORK/model.log \
  node "$ROOT/e2e/mock-model.mjs" >"$WORK/model.out" 2>&1 </dev/null &
MOCK_PID=$!
start_server
echo "OpenCode $("$OPENCODE" --version) on $SERVER"

for mode in shared isolate; do
  echo "spawn, then wake the idle parent ($mode)"
  message="COURIER-TEST"
  [ "$mode" = isolate ] && message="COURIER-TEST isolate"
  out=$(prompt "$message")
  turn_ended=$(now_ms)
  spawn=$(jq -c 'select(.type == "tool_use" and .part.tool == "courier_spawn") | .part.state' <<<"$out")
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  directory=$(jq -r '.metadata.metadata.directory // empty' <<<"$spawn")
  check "courier_spawn completed" "$(jq -r '.status == "completed"' <<<"$spawn")"
  if [ "$mode" = isolate ]; then
    check "child runs in its own worktree" "$([[ $directory == */worktree/* ]] && echo true || echo false)"
  fi
  woke=$(reply_time "$parent" "PARENT WOKE")
  check "parent got a new turn after its own had ended" "$([ -n "$woke" ] && [ "$woke" -gt "$turn_ended" ] && echo true || echo false)"
  check "and no notice of a turn without a report, since the child reported" \
    "$(api "session/$parent/message" | jq -r '[.data[] | select(.type == "synthetic") | .text | select(contains(" ended="))] | length == 0')"
done

echo "courier_status"
out=$(prompt "COURIER-STATUS $parent")
check "reports the parent's last reply" "$(jq -r 'select(.type == "tool_use") | .part.state | .status == "completed" and (.output | contains("PARENT WOKE"))' <<<"$out")"
out=$(prompt "COURIER-STATUS ses_missing")
check "names the error for an unknown session" "$(jq -r 'select(.type == "tool_use") | .part.state.error | contains("NotFoundError")' <<<"$out")"

tool_state() { jq -c --arg tool "$1" 'select(.type == "tool_use" and .part.tool == $tool) | .part.state'; }

echo "a child runs on its parent's model, not the default one"
out=$(cd "$WORK/project" && "$OPENCODE" run --server "$SERVER" --auto --format json --model mock/other "COURIER-TEST" </dev/null)
parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
check "the child reported back" "$([ -n "$(reply_time "$parent" "PARENT WOKE")" ] && echo true || echo false)"
check "every reply of the child came from the parent's model"   "$(api "session/$child/message" | jq -r '[.data[] | select(.type == "assistant") | .model.id] | length > 0 and all(. == "other")')"

echo "a child whose turn fails is reported to its idle parent"
out=$(prompt "COURIER-FAIL")
turn_ended=$(now_ms)
parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
check "courier_spawn completed" "$(tool_state courier_spawn <<<"$out" | jq -r '.status == "completed"')"
woke=$(reply_time "$parent" "PARENT WOKE")
check "the failure started a new turn after the parent's had ended"   "$([ -n "$woke" ] && [ "$woke" -gt "$turn_ended" ] && echo true || echo false)"
notices=$(api "session/$parent/message" | jq -c '[.data[] | select(.type == "synthetic") | .text]')
check "the parent was told once" "$(jq -r 'length == 1' <<<"$notices")"
check "which child failed, and with what error"   "$(jq -r --arg child "$child" 'join("") | contains("<courier from=\"" + $child + "\" failed=") and contains("not available in your country")' <<<"$notices")"

# The parent's synthetic messages whose envelope carries attribute $2, from session $1.
notices_with() { api "session/$1/message" | jq -c --arg attribute " $2=" '[.data[] | select(.type == "synthetic") | .text | select(contains($attribute))]'; }
kv() { XDG_DATA_HOME=$XDG_DATA_HOME bun "$ROOT/e2e/kv.ts" "$@"; }

echo "a child whose turn ends without a report is reported to its idle parent"
out=$(prompt "COURIER-SILENT")
turn_ended=$(now_ms)
parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
woke=$(reply_time "$parent" "PARENT TOLD SILENT" 45)
check "the silent end started a new turn after the parent's had ended" \
  "$([ -n "$woke" ] && [ "$woke" -gt "$turn_ended" ] && echo true || echo false)"
notice=$(notices_with "$parent" ended)
check "the parent was told once, which child it was, and its last reply" "$(jq -r --arg child "$child" 'length == 1 and (.[0] |
  contains("<courier from=\"" + $child + "\" ended=\"without-report\">") and contains("CHILD SILENT REPLY") and contains("Decide what it needs"))' <<<"$notice")"
check "the child owes its parent a report" \
  "$([ "$(kv get "report/$child/prompt" | jq -r '.at | type == "number"')" = true ] && [ -z "$(kv get "report/$child/settled")" ] && echo true || echo false)"
prompt_in "$parent" "COURIER-NUDGE $child" >/dev/null
check "told to report, the child did" "$([ -n "$(reply_time "$parent" "PARENT WOKE" 45)" ] && echo true || echo false)"
check "which settled its report" "$(kv get "report/$child/settled" | jq -r '.by == "report"')"
check "and its reported turn was not told as one without a report" \
  "$(sleep 2; notices_with "$parent" ended | jq -r 'length == 1')"

echo "what the person types in a child that has reported does not make it owe a report"
out=$(prompt "COURIER-TEST")
parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
check "the child reported" "$([ -n "$(reply_time "$parent" "PARENT WOKE")" ] && echo true || echo false)"
prompt_in "$child" "PERSON-ASKS" >/dev/null
check "the child answered the person in its own session" "$([ -n "$(reply_time "$child" "CHILD ANSWERS PERSON")" ] && echo true || echo false)"
check "and its parent was not told it ended without a report" "$(sleep 3; notices_with "$parent" ended | jq -r 'length == 0')"

echo "a deleted child that owes a report is forgotten"
out=$(prompt "COURIER-SILENT")
parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
check "the parent was told it ended without a report" "$([ -n "$(reply_time "$parent" "PARENT TOLD SILENT" 45)" ] && echo true || echo false)"
check "the child is deleted" "$([[ $(curl -s -o /dev/null -w '%{http_code}' -u "opencode:$OPENCODE_PASSWORD" -X DELETE "$SERVER/api/session/$child") == 20* ]] && echo true || echo false)"
check "and its report state is gone" \
  "$(for _ in $(seq 1 20); do [ -z "$(kv get "report/$child/prompt")$(kv get "report/$child/told")" ] && { echo true; exit; }; sleep 1; done; echo false)"

echo "a child that ends its turn to wait for a message it scheduled is not reported, and reports once woken"
out=$(prompt "COURIER-WAITING")
parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
check "the scheduled message woke the child, which reported" "$([ -n "$(reply_time "$parent" "PARENT WOKE" 75)" ] && echo true || echo false)"
check "the child's first turn, which ended waiting, was not told" "$(sleep 2; notices_with "$parent" ended | jq -r 'length == 0')"
check "the child scheduled the message in its first turn" \
  "$(api "session/$child/message" | jq -r '[.data[] | select(.type == "assistant") | .content[]? | select(.type == "tool" and .name == "courier_later")] | length == 1')"
# Starts a parent with COURIER-ASK ($1 is "isolate" or empty) and waits until it has been told that its
# child asks for permission; sets parent, child, request and notice.
ask_permission() {
  local out turn_ended woke
  out=$(prompt "COURIER-ASK $1")
  turn_ended=$(now_ms)
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  woke=$(reply_time "$parent" "PARENT ASKS" 45)
  check "the request started a new turn after the parent's had ended" \
    "$([ -n "$woke" ] && [ "$woke" -gt "$turn_ended" ] && echo true || echo false)"
  notice=$(notices_with "$parent" asks)
  check "the parent was told once" "$(jq -r 'length == 1' <<<"$notice")"
  request=$(jq -r '.[0] // "" | capture("request=\"(?<id>[^\"]+)\"").id // empty' <<<"$notice")
}

for mode in shared isolate; do
  echo "a child's permission request reaches its idle parent, and the answer goes back ($mode)"
  ask_permission "$([ "$mode" = isolate ] && echo isolate)"
  check "with what it asks for and the choices" "$(jq -r --arg child "$child" '.[0] // "" |
    contains("<courier from=\"" + $child + "\" asks=\"permission\"") and contains("It asks for: shell") and
    contains("echo courier-asks") and contains("- once:") and contains("- reject:") and contains("Do not decide this yourself")' <<<"$notice")"
  check "courier_status shows the child waiting on it" \
    "$(prompt "COURIER-STATUS $child" | tool_state courier_status | jq -r --arg request "$request" '.status == "completed" and (.output | contains($request))')"
  choice=$([ "$mode" = isolate ] && echo reject || echo once)
  answered=$(prompt_in "$parent" "COURIER-ANSWER $choice" | tool_state courier_answer)
  check "courier_answer passed on $choice" "$(jq -r '.status == "completed" and .metadata.metadata.answered == true' <<<"$answered")"
  check "the child carried on and reported back" "$([ -n "$(reply_time "$parent" "PARENT WOKE" 45)" ] && echo true || echo false)"
  report=$(api "session/$parent/message" | jq -r '[.data[] | select(.type == "synthetic") | .text | select(contains("CHILD DONE shell"))] | join("")')
  if [ "$mode" = isolate ]; then
    # Rejected with a message, the call fails and the child carries on; a bare rejection would end its turn.
    check "the child's command was refused" "$([[ $report == *'"error"'* && $report != *"exited with code"* ]] && echo true || echo false)"
  else
    check "the child's command ran" "$([[ $report == *"courier-asks"* && $report != *"Refused"* ]] && echo true || echo false)"
  fi
  check "the parent got no stale notice" "$(notices_with "$parent" answered | jq -r 'length == 0')"
done

echo "a request answered in the child's own session leaves no stale question with the parent"
ask_permission ""
code=$(curl -s -o /dev/null -w '%{http_code}' -u "opencode:$OPENCODE_PASSWORD" -X POST -H 'content-type: application/json' \
  --data '{"decision":"once"}' "$SERVER/api/session/$child/permission/$request/reply")
check "answered in the child's session" "$([ "$code" = 204 ] && echo true || echo false)"
check "the parent was told it is settled" "$([ -n "$(reply_time "$parent" "PARENT SETTLED")" ] && echo true || echo false)"
check "the notice names the request and the answer" \
  "$(notices_with "$parent" answered | jq -r --arg request "$request" 'length == 1 and (.[0] | contains("request=\"" + $request + "\"") and contains("answered=\"once\""))')"
answered=$(prompt_in "$parent" "COURIER-ANSWER once" | tool_state courier_answer)
check "a late courier_answer passes nothing on" \
  "$(jq -r '.status == "completed" and .metadata.metadata.answered == false and (.output | contains("is pending in this OpenCode server") and contains("another OpenCode server on the same data directory"))' <<<"$answered")"
check "the child carried on and reported back" "$([ -n "$(reply_time "$parent" "PARENT WOKE" 45)" ] && echo true || echo false)"

# The texts of session $1: what it was sent, what it replied and what its tools returned.
texts() {
  api "session/$1/message" |
    jq -r '.data[] | (.text // empty), (.content[]? | (.text // empty), (.state.content[]?.text // empty),
      (.state.output? // empty | if type == "string" then . else tojson end))'
}
# Whether session $1 has a text containing $2, waiting up to $3 (default 30) s.
has_text() {
  for _ in $(seq 1 "${3:-30}"); do
    if texts "$1" | grep -qF -- "$2"; then echo true; return; fi
    sleep 1
  done
  echo false
}
# The id of the pending form of session $1 that is not $2, waiting up to $3 (default 30) s.
form_of() {
  for _ in $(seq 1 "${3:-30}"); do
    local id
    id=$(api "session/$1/form" | jq -r --arg old "$2" '[.data[] | select(.id != $old) | .id] | first // empty')
    if [ -n "$id" ]; then echo "$id"; return; fi
    sleep 1
  done
}
forms_of() { api "session/$1/form" | jq -r '.data | length'; }
fields_of() { api "session/$1/form" | jq -c '.data[0].fields'; }
# POSTs to the server's API as the person would, from the TUI; prints the HTTP status.
person() {
  local body=${2:-'{}'}
  curl -s -o /dev/null -w '%{http_code}' -u "opencode:$OPENCODE_PASSWORD" -X POST -H 'content-type: application/json' --data "$body" "$SERVER/api/$1"
}
# The person dismisses form $2 of session $1, as the TUI does; prints the HTTP status.
dismiss_form() {
  curl -s -o /dev/null -w '%{http_code}' -u "opencode:$OPENCODE_PASSWORD" -X DELETE "$SERVER/api/session/$1/form/$2"
}
# The person answers form $2 of session $1 with $3, a JSON value.
answer_form() { [ "$(person "session/$1/form/$2/reply" "{\"answer\":{\"q0\":$3}}")" = 204 ] && echo true || echo false; }
# Starts a parent with $1 and waits until its child's question is shown in the child and, asked by
# the parent, in the parent; sets parent, child, child_form and parent_form.
ask_question() {
  local out
  out=$(prompt "$1")
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  child_form=$(form_of "$child" "" 45)
  parent_form=$(form_of "$parent" "" 45)
  check "the child asks, and the parent asks the person in its own session" \
    "$([ -n "$child_form" ] && [ -n "$parent_form" ] && echo true || echo false)"
}

# With maxDepth 2, a child starts two leaves; one tries courier_spawn as its tool list stands, the
# other once the probe plugin has put the tool back, so OpenCode refuses the first and courier the second.
echo "a leaf at maxDepth does not see courier_spawn, and is refused when it calls it anyway"
out=$(prompt "COURIER-DEPTH")
root=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
middle=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
check "the leaf without the tool was told it is not available" \
  "$(has_text "$middle" "Tool is not available for this request: courier_spawn" 60)"
check "the leaf that called it anyway was refused by courier_spawn, naming maxDepth" \
  "$(has_text "$middle" "Not started: this session is at depth 2 of its session tree, and the tree goes at most 2 deep (maxDepth)" 60)"
leaves=$(jq -sc '[.[] | select(.reply.args.task? == "CHILD-TOO-DEEP") | .session] | unique' "$WORK/model.log")
check "two leaves tried" "$(jq -r 'length == 2' <<<"$leaves")"
# The child in between never reports: its turns end while its leaves owe it reports, and once more after.
check "the root was told once that the child in between ended without a report, once its leaves had reported" \
  "$(has_text "$root" "PARENT TOLD SILENT" 60 >/dev/null; sleep 2; notices_with "$root" ended | jq -r --arg middle "$middle" 'length == 1 and (.[0] | contains("<courier from=\"" + $middle + "\" ended="))')"
check "every request of a leaf was named a leaf, and the courier's hook left it no courier_spawn" \
  "$(jq -sr --argjson leaves "$leaves" '[.[] | select(.type == "probe.context" and (.sessionID | IN($leaves[])))]
    | length > 0 and all(.role == "leaf" and (.tools | index("courier_spawn") | not) and (.tools | index("courier_send")))' "$WORK/probe.log")"
check "the model saw no courier_spawn in a leaf's tool list unless the probe put it back" \
  "$(jq -sr --argjson leaves "$leaves" '[.[] | select((.session | IN($leaves[])) and (.tools | length > 0))] | group_by(.session)
    | map(any(.tools | index("courier_spawn"))) | sort == [false, true]' "$WORK/model.log")"
check "the child in between is a sub-orchestrator, with courier_spawn" \
  "$(jq -sr --arg middle "$middle" '[.[] | select(.session == $middle and (.tools | length > 0))] | length > 0 and all(.role == "sub-orchestrator" and (.tools | index("courier_spawn")))' "$WORK/model.log")"
check "the root had no role part until it had started a child, then root orchestrator" \
  "$(jq -sr --arg root "$root" '[.[] | select(.session == $root and (.tools | length > 0)) | .role] | .[0] == null and .[-1] == "root orchestrator"' "$WORK/model.log")"
# The limits count live sessions: a finished one's last turn ended after anything reached it, and
# one that has reported owes no report, its report settled after its last prompt.
finished() { api "session/$1" | jq -r '(.data // .) | .time.idle != null and .time.updated <= .time.idle'; }
reported() {
  local prompted settled
  prompted=$(kv get "report/$1/prompt" | jq -r '.at // empty')
  settled=$(kv get "report/$1/settled" | jq -r 'select(.by == "report") | .at // empty')
  [ -n "$prompted" ] && [ -n "$settled" ] && [ "$settled" -ge "$prompted" ] && echo true || echo false
}
check "a leaf that has reported reads as finished and owes no report, so it no longer counts against the limits" \
  "$(for _ in $(seq 1 30); do leaf=$(jq -r '.[0]' <<<"$leaves"); [ "$(finished "$leaf")" = true ] && [ "$(reported "$leaf")" = true ] && { echo true; exit; }; sleep 1; done; echo false)"
leaf=$(jq -r '.[0]' <<<"$leaves")
check "deleting the session in between forgets the report state of the leaf that reported to it" \
  "$([ -n "$(kv get "report/$leaf/settled")" ] &&
    [[ $(curl -s -o /dev/null -w '%{http_code}' -u "opencode:$OPENCODE_PASSWORD" -X DELETE "$SERVER/api/session/$middle") == 20* ]] &&
    for _ in $(seq 1 20); do [ -z "$(kv get "report/$leaf/prompt")$(kv get "report/$leaf/settled")" ] && { echo true; exit; }; sleep 1; done; echo false)"

# The first web search of this run: no provider has been chosen, which OpenCode keeps for every session.
echo "a child's web search asks for a provider with a form: the parent is told, and told when it is answered"
out=$(prompt "COURIER-SEARCH")
parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
first=$(form_of "$child" "" 45)
check "the child shows OpenCode's web search form" "$([ -n "$first" ] && echo true || echo false)"
check "the parent was told" "$(has_text "$parent" "PARENT TOLD FORM $first" 45)"
check "once, with the form's choices, that only the person can answer, and that the choice is for every session" \
  "$(notices_with "$parent" asks | jq -r --arg child "$child" --arg form "$first" 'length == 1 and (.[0] |
  contains("<courier from=\"" + $child + "\" asks=\"form\" form=\"" + $form + "\" kind=\"websearch.provider\">") and
  contains("shows a form, \"Web Search\"") and contains("- Choose another provider") and contains("- Disable web search") and
  contains("only the person you are working with can, in session " + $child) and contains("no session is asked again"))')"
check "the person picks another provider in the child's session" \
  "$([ "$(person "session/$child/form/$first/reply" '{"answer":{"choice":"choose"}}')" = 204 ] && echo true || echo false)"
second=$(form_of "$child" "$first" 30)
check "OpenCode asks which provider, in a second form" "$([ -n "$second" ] && echo true || echo false)"
check "the parent was told the first is answered" "$(has_text "$parent" "settled=\"answered\" form=\"$first\"" 30)"
check "and about the second" "$(has_text "$parent" "asks=\"form\" form=\"$second\"" 30)"
check "the person picks the stand-in provider" \
  "$([ "$(person "session/$child/form/$second/reply" '{"answer":{"provider":"courier-search"}}')" = 204 ] && echo true || echo false)"
check "the child's search ran on it, and the child reported back" "$(has_text "$parent" "COURIER SEARCH RESULT" 45)"
check "each form was told once, and settled once" \
  "$([ "$(notices_with "$parent" asks | jq length)" = 2 ] && [ "$(notices_with "$parent" settled | jq length)" = 2 ] && echo true || echo false)"

echo "a child's question reaches its idle parent, which asks the person; their choice goes back"
ask_question COURIER-QUESTION
notice=$(notices_with "$parent" asks)
check "the parent was told once, with the question and its options" "$(jq -r --arg child "$child" 'length == 1 and (.[0] |
  contains("<courier from=\"" + $child + "\" asks=\"question\" request=\"question_") and contains("Which greeting?") and
  contains("{\"questions\":[{\"question\":\"Which greeting?\",\"header\":\"Greeting\"") and contains("Do not answer it yourself"))' <<<"$notice")"
check "the parent asks exactly what the child asks" "$([ "$(fields_of "$parent")" = "$(fields_of "$child")" ] && echo true || echo false)"
request=$(jq -r '.[0] | capture("request=\"(?<id>[^\"]+)\"").id' <<<"$notice")
check "courier_status shows the child waiting on it" "$(prompt "COURIER-STATUS $child" | tool_state courier_status |
  jq -r --arg request "$request" '.status == "completed" and (.output | contains($request) and contains("\"type\": \"question\""))')"
check "the person answers in the parent's session" "$(answer_form "$parent" "$parent_form" '"Hi"')"
check "the parent's question passed the answer on, without courier_answer" "$(has_text "$parent" "do not call courier_answer")"
check "the child carried on with it and reported back" "$(has_text "$parent" 'CHILD GOT [["Hi"]]' 45)"
check "the child's question is no longer shown" "$([ "$(forms_of "$child")" = 0 ] && echo true || echo false)"

echo "a multi-select question"
ask_question COURIER-QUESTION-MULTI
check "the parent asks it as one too" "$(fields_of "$parent" | jq -r '.[0].type == "multiselect"')"
check "the person picks two in the parent's session" "$(answer_form "$parent" "$parent_form" '["Hello","Hey"]')"
check "the child got both" "$(has_text "$parent" 'CHILD GOT [["Hello","Hey"]]' 45)"

echo "an isolated child's question, answered with the person's own text"
ask_question "COURIER-QUESTION isolate"
check "the person types an answer in the parent's session" "$(answer_form "$parent" "$parent_form" '"Something else"')"
check "the child got it" "$(has_text "$parent" 'CHILD GOT [["Something else"]]' 45)"
check "the child's question is no longer shown" "$([ "$(forms_of "$child")" = 0 ] && echo true || echo false)"

echo "a parent that relabels the options passes the answer on with courier_answer"
ask_question COURIER-QUESTION-RELABEL
check "the person answers the parent's reworded question" "$(answer_form "$parent" "$parent_form" '"hi"')"
check "courier_answer passed it on" "$(has_text "$parent" "Passed the answers to question")"
check "the child got it" "$(has_text "$parent" 'CHILD GOT [["hi"]]' 45)"
check "the child's question is no longer shown" "$([ "$(forms_of "$child")" = 0 ] && echo true || echo false)"

echo "a parent that rewords the question is not linked, is told so, and passes the answer on with courier_answer"
ask_question COURIER-QUESTION-REWORD
check "the person answers the parent's reworded question" "$(answer_form "$parent" "$parent_form" '"Hey"')"
check "the parent's question said it was not passed on" "$(has_text "$parent" "these answers were not passed on by themselves")"
check "courier_answer passed it on" "$(has_text "$parent" "Passed the answers to question")"
check "the child got it" "$(has_text "$parent" 'CHILD GOT [["Hey"]]' 45)"

echo "the person answers in the child's session instead"
ask_question COURIER-QUESTION
check "the person answers in the child's session" "$(answer_form "$child" "$child_form" '"Hey"')"
check "the parent's question is withdrawn" "$(has_text "$parent" "Session $child no longer waits on this question: it was answered in its own session")"
check "and no longer shown" "$([ "$(forms_of "$parent")" = 0 ] && echo true || echo false)"
check "the child carried on with the answer" "$(has_text "$parent" 'CHILD GOT [["Hey"]]' 45)"

echo "the person dismisses the question in the child's session"
ask_question COURIER-QUESTION
check "dismissed in the child's session" "$([ "$(dismiss_form "$child" "$child_form")" = 204 ] && echo true || echo false)"
check "the parent's question is withdrawn, saying so" "$(has_text "$parent" "dismissed in its own session, which ends its turn")"
check "and no longer shown" "$([ "$(forms_of "$parent")" = 0 ] && echo true || echo false)"

echo "the person dismisses the question in the parent's session"
ask_question COURIER-QUESTION
check "dismissed in the parent's session" "$([ "$(dismiss_form "$parent" "$parent_form")" = 204 ] && echo true || echo false)"
check "the child was told, carried on and reported" "$(has_text "$parent" "CHILD DISMISSED" 45)"
check "the child's question is no longer shown" "$([ "$(forms_of "$child")" = 0 ] && echo true || echo false)"

echo "the parent asks again while its dismissal is held: the new question is withdrawn, and the child carries on without the answers"
ask_question COURIER-QUESTION
check "dismissed in the parent's session" "$([ "$(dismiss_form "$parent" "$parent_form")" = 204 ] && echo true || echo false)"
# Within the two seconds the dismissal is held, over the API as a prompt from the TUI would come
# (opencode run cancels the question form it opens).
check "the parent is prompted to ask again" "$([[ $(person "session/$parent/prompt" '{"text":"COURIER-ASK-AGAIN"}') == 20* ]] && echo true || echo false)"
check "the parent's new question was withdrawn, saying the child carries on without the answers" \
  "$(has_text "$parent" "already dismissed in your session, so it carries on without the answers" 45)"
check "and no longer shown" "$([ "$(forms_of "$parent")" = 0 ] && echo true || echo false)"
check "the child was told, carried on and reported" "$(has_text "$parent" "CHILD DISMISSED" 45)"

# A model slip: the parent asks the person and calls courier_answer in the same step, so its
# question is linked and answered at once.
echo "the parent asks the person and calls courier_answer in one step: its question is withdrawn, and the courier_answer pick counts"
out=$(prompt "COURIER-QUESTION-BOTH")
parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
# The child's form goes within a moment of the notice, so the notice, not the form, shows it asked.
check "the child asks, and the parent is told" "$(has_text "$parent" 'asks="question"' 45)"
check "the parent's question was withdrawn, naming the answers courier_answer passed on" \
  "$(has_text "$parent" 'already answered with courier_answer (User has answered your questions: "Which greeting?"="Hi"' 45)"
check "courier_answer passed it on" "$(has_text "$parent" "Passed the answers to question")"
check "the parent's form is gone, unanswered" "$([ "$(forms_of "$parent")" = 0 ] && echo true || echo false)"
check "the child carried on with the courier_answer pick" "$(has_text "$parent" 'CHILD GOT [["Hi"]]' 45)"
check "the child's question is no longer shown" "$([ "$(forms_of "$child")" = 0 ] && echo true || echo false)"

echo "the child's turn is stopped while the parent asks the person; their answer reaches it as a message"
ask_question COURIER-QUESTION
check "the child's turn is interrupted" "$([[ $(person "session/$child/interrupt") == 20* ]] && echo true || echo false)"
check "the child's question is no longer shown" "$(for _ in $(seq 1 15); do [ "$(forms_of "$child")" = 0 ] && { echo true; exit; }; sleep 1; done; echo false)"
check "the person answers in the parent's session" "$(answer_form "$parent" "$parent_form" '"Hello"')"
check "the parent's question passed it on as a message" "$(has_text "$parent" "as a message, since its question had been cut off")"
check "which woke the child, and it carried on" "$(has_text "$parent" 'CHILD GOT [["Hello"]]' 45)"

# What OpenCode's inactivity sweep does to a location after an hour: it interrupts every turn there.
echo "both turns are stopped while the question is open; the parent is told and asks again"
ask_question COURIER-QUESTION
person "session/$child/interrupt" >/dev/null
person "session/$parent/interrupt" >/dev/null
check "the parent was told the question was cut off" "$(has_text "$parent" 'stopped="true"' 45)"
again=$(form_of "$parent" "$parent_form" 45)
check "and asks the person again" "$([ -n "$again" ] && echo true || echo false)"
check "the person answers" "$(answer_form "$parent" "$again" '"Hi"')"
check "the child woke with the answer and carried on" "$(has_text "$parent" 'CHILD GOT [["Hi"]]' 45)"

echo "a question of a child's child goes to the session at the top"
out=$(prompt "COURIER-QUESTION nested")
parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
middle=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
parent_form=$(form_of "$parent" "" 60)
check "the parent at the top asks the person" "$([ -n "$parent_form" ] && echo true || echo false)"
check "its notice names the session in between" "$(notices_with "$parent" asks | jq -r --arg middle "$middle" '.[0] // "" | contains("which " + $middle + " started with courier_spawn")')"
check "the person answers in the top session" "$(answer_form "$parent" "$parent_form" '"Hey"')"
check "the child's child got it and reported to the session in between" "$(has_text "$middle" 'CHILD GOT [["Hey"]]' 45)"

echo "a question open across a server restart"
ask_question COURIER-QUESTION
stop_server
start_server
api "plugin?directory=$(node -p 'encodeURIComponent(process.argv[1])' "$WORK/project")" >/dev/null
check "the parent was told the question was cut off" "$(has_text "$parent" 'restarted="true"' 60)"
again=$(form_of "$parent" "$parent_form" 45)
check "and asks the person again" "$([ -n "$again" ] && echo true || echo false)"
check "the person answers" "$(answer_form "$parent" "$again" '"Hello"')"
check "the child woke with the answer and carried on" "$(has_text "$parent" 'CHILD GOT [["Hello"]]' 45)"

# Whether every plugin instance follows an isolated child's events, whichever location they come
# from: e2e/probe-plugin, loaded next to the courier in every location, logs each event its
# instance sees through event.subscribe(), as the courier's watcher follows them. The child, in
# its own worktree, asks for a permission, shows two question forms, one answered in its own
# session and one withdrawn by the relay when the person answers in the parent's, and then fails.
echo "an isolated child's events reach the plugin instance of every location"
canonical() { node -p 'require("node:fs").realpathSync(process.argv[1])' "$1"; }
# A third location, neither the parent's nor the child's: an earlier isolated child's worktree (the
# first one listed is the project itself), opened by a session of its own, which loads the plugins there.
bystander=$(git -C "$WORK/project" worktree list --porcelain | sed -n 's/^worktree //p' | sed -n 2p)
check "a third location is open" "$([ -n "$bystander" ] &&
  (cd "$bystander" && "$OPENCODE" run --server "$SERVER" --auto --format json "hello" </dev/null >/dev/null) && echo true || echo false)"
out=$(prompt "COURIER-PROBE")
parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
worktree=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.directory')
check "the child runs in its own worktree" "$([[ $worktree == */worktree/* ]] && echo true || echo false)"
check "the parent was told the child asks for permission" "$([ -n "$(reply_time "$parent" "PARENT ASKS" 45)" ] && echo true || echo false)"
request=$(notices_with "$parent" asks | jq -r '.[0] // "" | capture("request=\"(?<id>[^\"]+)\"").id // empty')
check "answered in the child's session" "$([ "$(person "session/$child/permission/$request/reply" '{"decision":"once"}')" = 204 ] && echo true || echo false)"
child_form=$(form_of "$child" "" 45)
parent_form=$(form_of "$parent" "" 45)
check "the child asks a question, and the parent asks the person" "$([ -n "$child_form" ] && [ -n "$parent_form" ] && echo true || echo false)"
check "the person answers in the child's session" "$(answer_form "$child" "$child_form" '"Hey"')"
second_child_form=$(form_of "$child" "$child_form" 45)
second_parent_form=$(form_of "$parent" "$parent_form" 45)
check "the child asks again, and so does the parent" "$([ -n "$second_child_form" ] && [ -n "$second_parent_form" ] && echo true || echo false)"
check "the person answers in the parent's session" "$(answer_form "$parent" "$second_parent_form" '"Hi"')"
check "the child's failure reached the parent" "$(has_text "$parent" "<courier from=\"$child\" failed=" 45)"
locations=$(for directory in "$WORK/project" "$worktree" ${bystander:+"$bystander"}; do canonical "$directory"; done | jq -Rsc 'split("\n") | map(select(length > 0))')
probe_types='["permission.asked","permission.replied","form.created","form.replied","form.cancelled","session.execution.failed"]'
# Reads the probe log of this server process into: instances, the locations whose last probe line
# says loaded, with the three above; and delivery, for each event type of the child's, the
# locations that logged each of its events, a location once per time it logged the event.
read_probe() {
  local probed
  probed=$(jq -sc --arg child "$child" '(map(select(.sessionID == $child)) | first | .pid) as $pid | map(select(.pid == $pid))' "$WORK/probe.log")
  instances=$(jq -c --argjson locations "$locations" '
    [.[] | select(.type == "probe.loaded" or .type == "probe.unloaded")] | group_by(.location)
    | map(select(last.type == "probe.loaded") | .[0].location) + $locations | unique' <<<"$probed")
  delivery=$(jq -c --arg child "$child" '
    map(select(.sessionID == $child and .id != null)) | group_by(.type)
    | map({ key: .[0].type, value: (group_by(.id) | map(map(.location) | sort)) }) | from_entries' <<<"$probed")
}
# Every type occurred, and every event of it was logged exactly once by each instance.
delivered() {
  jq -r --argjson types "$probe_types" --argjson instances "$instances" \
    '. as $delivery | all($types[]; ($delivery[.] // []) | length > 0 and all(. == $instances))' <<<"$delivery"
}
# The other instances follow the events independently of the one that told the parent.
for _ in $(seq 1 30); do read_probe; [ "$(delivered)" = true ] && break; sleep 1; done
short() { sed "s|$(canonical "$WORK/project")|parent|g; s|$(canonical "$worktree")|child|g; ${bystander:+s|$(canonical "$bystander")|bystander|g;} s|$(canonical "$WORK")/||g"; }
echo "  instances: $(short <<<"$instances")"
for type in $(jq -r '.[]' <<<"$probe_types"); do
  echo "  $type, each event seen by: $(jq -c --arg type "$type" '.[$type] // []' <<<"$delivery" | short)"
  check "every instance saw each of the child's $type events once" \
    "$(jq -r --arg type "$type" --argjson instances "$instances" '(.[$type] // []) | length > 0 and all(. == $instances)' <<<"$delivery")"
done

# The hub follows OpenCode's events through two locations' instances, one subscription and a
# standby. Reloading shuts every location down and builds it again, so each instance unloads and a
# new one loads: as each subscription's instance unloads, the other keeps following the events and
# a new one starts through another instance, or the first new instances start both again, and a
# child's request is still told once.
echo "after OpenCode reloads every location, a child's permission request still reaches its parent once"
check "every location reloads" "$([ "$(person location/reload)" = 204 ] && echo true || echo false)"
ask_permission isolate
answered=$(prompt_in "$parent" "COURIER-ANSWER once" | tool_state courier_answer)
check "courier_answer passed it on" "$(jq -r '.status == "completed" and .metadata.metadata.answered == true' <<<"$answered")"
check "the child carried on and reported back" "$([ -n "$(reply_time "$parent" "PARENT WOKE" 45)" ] && echo true || echo false)"

echo "courier_later wakes the idle parent, with the delay sent as a string as some models do"
out=$(prompt "COURIER-LATER-STRING 0.05")
turn_ended=$(now_ms)
parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
check "courier_later completed" "$(tool_state courier_later <<<"$out" | jq -r '.status == "completed"')"
woke=$(reply_time "$parent" "PARENT WOKE" 45)
check "the scheduled message started a new turn after the parent's had ended" \
  "$([ -n "$woke" ] && [ "$woke" -gt "$turn_ended" ] && echo true || echo false)"

echo "courier_cancel stops a scheduled message"
out=$(prompt "COURIER-LATER-CANCEL 0.05")
parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
check "courier_cancel cancelled it" "$(tool_state courier_cancel <<<"$out" | jq -r '.status == "completed" and (.output | startswith("Cancelled"))')"
woke=$(reply_time "$parent" "PARENT WOKE" 25)
check "the cancelled message never arrived" "$([ -z "$woke" ] && echo true || echo false)"

echo "courier_children lists the sessions a parent spawned"
out=$(prompt "COURIER-ROSTER")
roster_parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
spawned=$(tool_state courier_spawn <<<"$out" | jq -r 'select(.status == "completed") | .metadata.metadata.sessionID')
check "spawned two children" "$([ "$(wc -w <<<"$spawned")" -eq 2 ] && echo true || echo false)"
listed=$(tool_state courier_children <<<"$out" | jq -r 'select(.status == "completed") | .output')
check "courier_children lists both" "$(for id in $spawned; do grep -q "$id" <<<"$listed" || { echo false; exit; }; done; echo true)"
check "the parent was woken by its children" "$([ -n "$(reply_time "$roster_parent" "PARENT WOKE")" ] && echo true || echo false)"
# The roster's reverse index, read straight from OpenCode's database.
indexed_under() { kv get "roster-by-child/$1" | jq -r '.ancestors[0] // empty'; }
check "each child is indexed under its parent" \
  "$(for id in $spawned; do [ "$(indexed_under "$id")" = "$roster_parent" ] || { echo false; exit; }; done; echo true)"

echo "a scheduled message survives a server restart, delivered once another server's owner key expires"
out=$(prompt "COURIER-LATER 0.25")
parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
check "courier_later completed" "$(tool_state courier_later <<<"$out" | jq -r '.status == "completed"')"
check "the scheduler holds the owner key" "$(kv get scheduler/owner | jq -r '(.server | type) == "string" and (.at | type) == "number"')"
stop_server
check "and gave it back as the server stopped" "$([ -z "$(kv get scheduler/owner)" ] && echo true || echo false)"
# Another server on this data directory, as it would have renewed the key 40 s ago: it expires
# 20 s from now, and until then this server's scheduler leaves the message to it.
expires=$(($(now_ms) + 20000))
kv set scheduler/owner "{\"server\":\"another server\",\"at\":$((expires - 60000))}" "roster-by-child/$(tail -1 <<<"$spawned")"
# As an older version of the plugin writes it: a roster entry with no reverse key.
unindexed=$(head -1 <<<"$spawned")
kv remove "roster-by-child/$unindexed"
check "one child's reverse key is removed, as if an older version had recorded it" \
  "$([ -z "$(indexed_under "$unindexed")" ] && echo true || echo false)"
start_server
restarted=$(now_ms)
# Plugins load per project location, on its first use after a start.
api "plugin?directory=$(node -p 'encodeURIComponent(process.argv[1])' "$WORK/project")" >/dev/null
woke=$(reply_time "$parent" "PARENT WOKE" 60)
check "it was delivered after the restart" "$([ -n "$woke" ] && [ "$woke" -gt "$restarted" ] && echo true || echo false)"
check "only once the other server's key had expired" "$([ -n "$woke" ] && [ "$woke" -ge "$expires" ] && echo true || echo false)"
check "and this server holds the key now" "$(kv get scheduler/owner | jq -r '.server != "another server"')"

echo "the roster survives a restart and can be read from another session"
out=$(prompt "COURIER-CHILDREN $roster_parent")
listed=$(tool_state courier_children <<<"$out" | jq -c 'select(.status == "completed") | .metadata.metadata.children')
check "lists both children" "$(jq -r --arg ids "$spawned" '[.[].sessionID] | sort == ($ids | split("\n") | sort)' <<<"$listed")"
check "with each child's last reply" "$(jq -r 'all((.lastText // "") | contains("TOOL DONE courier_send"))' <<<"$listed")"
check "the entry written without a reverse key got one when the plugin loaded" \
  "$(for _ in $(seq 1 10); do [ "$(indexed_under "$unindexed")" = "$roster_parent" ] && { echo true; exit; }; sleep 1; done; echo false)"

echo "a signed GitHub webhook wakes a subscribed idle session"
out=$(prompt "COURIER-SUBSCRIBE Codertocat/Hello-World#2")
turn_ended=$(now_ms)
parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
check "courier_subscribe completed" "$(tool_state courier_subscribe <<<"$out" | jq -r '.status == "completed" and (.metadata.metadata.receiver == true)')"
payload=$ROOT/e2e/fixtures/pull_request_review.json
signature="sha256=$(openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -r "$payload" | cut -d' ' -f1)"
hook() { curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H 'x-github-event: pull_request_review' \
  -H 'x-github-delivery: 72d3162e-cc78-11e3-81ab-4c9367dc0958' "$@" --data-binary "@$payload" "http://127.0.0.1:$WEBHOOK_PORT/github"; }
check "an unsigned delivery is refused" "$([ "$(hook)" = 401 ] && echo true || echo false)"
check "a wrongly signed delivery is refused" "$([ "$(hook -H "x-hub-signature-256: sha256=$(printf '0%.0s' $(seq 64))")" = 401 ] && echo true || echo false)"
woke=$(reply_time "$parent" "PARENT WOKE" 5)
check "neither woke the session" "$([ -z "$woke" ] && echo true || echo false)"
check "a signed delivery is accepted" "$([ "$(hook -H "x-hub-signature-256: $signature")" = 202 ] && echo true || echo false)"
check "a replay of it is ignored" "$([ "$(hook -H "x-hub-signature-256: $signature")" = 200 ] && echo true || echo false)"
check "a replay with the signature upper-cased is ignored too" \
  "$([ "$(hook -H "x-hub-signature-256: sha256=$(tr a-f A-F <<<"${signature#sha256=}")")" = 200 ] && echo true || echo false)"
check "a replay with junk after the signature is refused" "$([ "$(hook -H "x-hub-signature-256: ${signature}zz")" = 401 ] && echo true || echo false)"
woke=$(reply_time "$parent" "PARENT WOKE")
check "it started a new turn after the session's had ended" "$([ -n "$woke" ] && [ "$woke" -gt "$turn_ended" ] && echo true || echo false)"
summary=$(api "session/$parent/message" | jq -r '[.data[] | select(.type == "synthetic") | .text] | join("")')
check "the turn got the event summary" "$([[ $summary == *"changes_requested"* && $summary == *"Hello-World#2"* ]] && echo true || echo false)"
check "the session got the event exactly once" \
  "$(api "session/$parent/message" | jq -r '[.data[] | select(.type == "synthetic")] | length == 1')"

echo "a child that subscribes to a webhook and ends its turn to wait is not reported, and reports once a delivery wakes it"
out=$(prompt "COURIER-HOOKED")
parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
check "the child subscribed and ended its turn" "$(has_text "$child" "TOOL DONE courier_subscribe" 30)"
check "which was not told as one without a report" "$(sleep 3; notices_with "$parent" ended | jq -r 'length == 0')"
body='{"text":"CHILD-REPORT-NOW"}'
sig=$(printf '%s\n%s' child-ci "$body" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -r | cut -d' ' -f1)
check "a delivery to its topic is accepted" "$([ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "x-hub-signature-256: sha256=$sig" \
  --data-binary "$body" "http://127.0.0.1:$WEBHOOK_PORT/hook/child-ci")" = 202 ] && echo true || echo false)"
check "the delivery woke the child, which reported" "$(has_text "$parent" "CHILD DONE AFTER NUDGE" 45)"
check "and the parent was never told it ended without a report" "$(sleep 2; notices_with "$parent" ended | jq -r 'length == 0')"

# Spawns an isolated child from a new parent and waits for its report; sets parent, child and directory.
spawn_isolated() {
  local out
  out=$(prompt "COURIER-TEST isolate")
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  directory=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.directory')
  check "the isolated child reported back" "$([ -n "$(reply_time "$parent" "PARENT WOKE")" ] && echo true || echo false)"
}
# "listed", "unlisted", or "error" when courier_children did not complete, so a broken listing never passes as unlisted.
child_listing() {
  prompt "COURIER-CHILDREN $1" | tool_state courier_children |
    jq -r --arg child "$2" 'if .status != "completed" then "error" elif any(.metadata.metadata.children[]; .sessionID == $child) then "listed" else "unlisted" end'
}

echo "courier_cleanup removes a clean worktree"
spawn_isolated
check "its worktree exists" "$([ -d "$directory" ] && echo true || echo false)"
check "it is indexed under its parent" "$([ "$(indexed_under "$child")" = "$parent" ] && echo true || echo false)"
cleaned=$(prompt_in "$parent" "COURIER-CLEANUP $child" | tool_state courier_cleanup)
check "courier_cleanup removed it" "$(jq -r '.status == "completed" and .metadata.metadata.outcome == "removed"' <<<"$cleaned")"
check "the worktree directory is gone" "$([ ! -e "$directory" ] && echo true || echo false)"
check "its reverse key is gone too" "$([ -z "$(kv get "roster-by-child/$child")" ] && echo true || echo false)"
check "git no longer lists the worktree" "$(git -C "$WORK/project" worktree list | grep -qF "$directory" && echo false || echo true)"
check "the child is off courier_children" "$([ "$(child_listing "$parent" "$child")" = unlisted ] && echo true || echo false)"

echo "courier_cleanup keeps a worktree with uncommitted changes"
spawn_isolated
echo "work in progress" >"$directory/notes.txt"
cleaned=$(prompt_in "$parent" "COURIER-CLEANUP $child" | tool_state courier_cleanup)
check "courier_cleanup kept it and named the file" \
  "$(jq -r '.status == "completed" and .metadata.metadata.outcome == "kept" and (.output | contains("notes.txt"))' <<<"$cleaned")"
check "the file is still there" "$([ -f "$directory/notes.txt" ] && echo true || echo false)"
check "the child is still on courier_children" "$([ "$(child_listing "$parent" "$child")" = listed ] && echo true || echo false)"
cleaned=$(prompt_in "$parent" "COURIER-CLEANUP $child force" | tool_state courier_cleanup)
check "with force, courier_cleanup removed it" "$(jq -r '.status == "completed" and .metadata.metadata.outcome == "removed"' <<<"$cleaned")"
check "the worktree directory is gone" "$([ ! -e "$directory" ] && echo true || echo false)"

# Last, because it swaps the local plugin for the installed one.
echo "opencode plugin add installs the packed package and its tools load"
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
check "and added it to the global config" \
  "$(jq -r '.plugins | index("opencode-courier") != null' "$XDG_CONFIG_HOME/opencode/opencode.json" 2>/dev/null || echo false)"
jq 'del(.plugins)' "$WORK/project/opencode.json" >"$WORK/project/opencode.json.new"
mv "$WORK/project/opencode.json.new" "$WORK/project/opencode.json"
log_start=$(($(wc -l <"$WORK/server.log") + 1))
start_server
out=$(prompt "COURIER-STATUS ses_missing")
check "its courier_status tool runs" "$(tool_state courier_status <<<"$out" | jq -r '.error // "" | contains("NotFoundError")')"
entrypoint=$(tail -n +"$log_start" "$WORK/server.log" |
  sed -n 's|.*msg="loading plugin" id=opencode-courier entrypoint=file://\([^ ]*/node_modules/opencode-courier/dist/index\.js\).*|\1|p' | head -1 || true)
check "loaded from the installed package" "$([ -n "$entrypoint" ] && echo true || echo false)"
# The published version can equal this one, so prove the loaded copy is this build's tarball: the
# lockfile of the install it came from names the stand-in registry and this tarball's integrity,
# which npm verified (it may take the tarball from its cache, where npm pack left it).
integrity="sha512-$(openssl dgst -sha512 -binary "$tarball" | base64 | tr -d '\n')"
locked=$(jq -r '.packages["node_modules/opencode-courier"] | "\(.resolved) \(.integrity)"' \
  "${entrypoint%/node_modules/opencode-courier/dist/index.js}/package-lock.json" 2>/dev/null || true)
check "built from the packed tarball" \
  "$([ "$locked" = "http://127.0.0.1:$REGISTRY_PORT/opencode-courier/-/$(basename "$tarball") $integrity" ] && echo true || echo false)"

# The version of the OpenCode under test: the installed @opencode/cli package's, found next to the
# binary, or failing that the one `opencode --version` prints, without its prefix.
host_version() {
  local bin
  bin=$(command -v "$OPENCODE") || return 1
  node -e '
    const fs = require("node:fs"), path = require("node:path")
    const dir = path.dirname(fs.realpathSync(process.argv[1]))
    for (const file of [path.join(dir, "..", "package.json"), path.join(dir, "package.json")]) {
      try {
        const pkg = JSON.parse(fs.readFileSync(file, "utf8"))
        if (pkg.name === "@opencode/cli" && pkg.version) { console.log(pkg.version); process.exit(0) }
      } catch {}
    }
    process.exit(1)
  ' "$bin" 2>/dev/null || "$OPENCODE" --version | sed 's/^[^0-9]*//'
}

# Every load above, from dist/ and from the installed package, compared this OpenCode with the pin
# the plugin reads from package.json. On the pinned version the server log carries no warning; on
# any other, as on a CI leg that runs this suite against a newer release, it carries the line, naming
# the host's version. The webhook line proves the plugin's log lines reach the server log at all.
pin=$(jq -r '.devDependencies["@opencode/plugin"]' "$ROOT/package.json")
host=$(host_version)
check "the plugin's log lines reach the server log" "$(grep -qF "courier webhook: listening on" "$WORK/server.log" && echo true || echo false)"
if [ "$host" = "$pin" ]; then
  echo "the server log names no version mismatch: OpenCode $host is the pinned version"
  check "no line says the version differs" "$(grep -qF "was built and tested against OpenCode" "$WORK/server.log" && echo false || echo true)"
else
  echo "the server log names the version mismatch: OpenCode $host is not the pinned $pin"
  check "a line names the pin and this server's version" \
    "$(grep -qF "was built and tested against OpenCode $pin; this server is $host (" "$WORK/server.log" && echo true || echo false)"
fi
check "no line says the versions could not be compared" "$(grep -qF "cannot compare the OpenCode version" "$WORK/server.log" && echo false || echo true)"

# The reload, the reinstall and the restarts above unloaded every instance. An instance's unload
# waits for the work it started (the roster's prune, the notice of cut-off questions, the relay of
# the requests already pending as its subscription started), so none of it fails against a location
# that has closed: the lines those failures log are absent.
echo "the work an unloading instance started finished before its location closed"
check "no prune, cut-off notice or pending relay failed" \
  "$(grep -qE "courier roster prune:|courier question: stored questions:|courier watch: could not relay pending requests:" "$WORK/server.log" && echo false || echo true)"

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed; rerun with KEEP=1 to keep the server and model logs"
  exit 1
fi
echo "all checks passed"
