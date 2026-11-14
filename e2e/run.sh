#!/usr/bin/env bash
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
  end_scenario
  print_timings
  stop_server
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null
  if [ -n "$REGISTRY_PID" ]; then
    kill "$REGISTRY_PID" 2>/dev/null || true
    "$OPENCODE" service stop >/dev/null 2>&1 </dev/null || true
  fi
  if [ "${KEEP:-}" = 1 ]; then echo "kept $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

SCENARIO=
SCENARIO_START=0
TIMINGS=$WORK/timings.tsv
end_scenario() {
  [ -n "$SCENARIO" ] || return 0
  local seconds=$((SECONDS - SCENARIO_START))
  printf '%s\t%s\n' "$seconds" "$SCENARIO" >>"$TIMINGS"
  echo "  (${seconds} s)"
  SCENARIO=
}
scenario() {
  end_scenario
  SCENARIO=$1
  SCENARIO_START=$SECONDS
  child_delay "$CHILD_DELAY_MS"
  echo "$1"
}
child_delay() { printf '%s' "$1" >"$WORK/child-delay"; }
print_timings() {
  [ -s "$TIMINGS" ] || return 0
  echo
  echo "scenario timings, slowest first (total $(awk -F'\t' '{ sum += $1 } END { print sum }' "$TIMINGS") s)"
  sort -t$'\t' -k1,1nr "$TIMINGS" | awk -F'\t' '{ printf "%5d s  %s\n", $1, $2 }'
}

PROMPT_LIMIT=${PROMPT_LIMIT:-240}
bounded_run() {
  local directory=$1 out status=0 session
  shift
  out=$(cd "$directory" && timeout -k 5 "$PROMPT_LIMIT" "$OPENCODE" run --server "$SERVER" --auto --format json "$@" </dev/null) || status=$?
  if [ "$status" = 124 ] || [ "$status" = 137 ]; then
    session=$(jq -r 'select(.sessionID? != null) | .sessionID' <<<"$out" 2>/dev/null | head -1) || true
    echo "  FAIL $SCENARIO: opencode run did not end in $PROMPT_LIMIT s (session ${session:-unknown}); killed it" >&2
    echo "$SCENARIO" >>"$WORK/stalled"
    status=0
  fi
  printf '%s\n' "$out"
  return "$status"
}
prompt() { bounded_run "$WORK/project" "$1"; }
prompt_in() { bounded_run "$WORK/project" --session "$1" "$2"; }
now_ms() { node -e 'console.log(Date.now())'; }
failures=0
check() {
  if [ "$2" = true ]; then echo "  PASS $1"; else echo "  FAIL $1"; failures=$((failures + 1)); fi
}
reply_time() {
  for _ in $(seq 1 "${3:-30}"); do
    local found
    found=$(api "session/$1/message" | jq -r --arg text "$2" \
      '[.data[] | select(.type == "assistant") | select([.content[]? | select(.type == "text") | .text] | join("") | contains($text)) | .time.created] | first // empty')
    if [ -n "$found" ]; then echo "$found"; return; fi
    sleep 1
  done
}

tool_state() { jq -c --arg tool "$1" 'select(.type == "tool_use" and .part.tool == $tool) | .part.state'; }
notices_with() { api "session/$1/message" | jq -c --arg attribute " $2=" '[.data[] | select(.type == "synthetic") | .text | select(contains($attribute))]'; }
kv() { XDG_DATA_HOME=$XDG_DATA_HOME bun "$ROOT/e2e/kv.ts" "$@"; }
texts() {
  api "session/$1/message" |
    jq -r '.data[] | (.text // empty), (.content[]? | (.text // empty), (.state.content[]?.text // empty),
      (.state.output? // empty | if type == "string" then . else tojson end))'
}
turn_ended() {
  for _ in $(seq 1 $((${2:-30} * 2))); do
    [ "$(finished "$1")" = true ] && { sleep 1; [ "$(finished "$1")" = true ] && return 0; }
    sleep 0.5
  done
  echo "turn_ended: session $1 did not end its turn in ${2:-30} s" >&2
}
end_handled() {
  local marker
  marker=$(api_post session "{\"location\":{\"directory\":\"$WORK/project\"}}" | jq -r '.data.id // empty')
  if [ -n "$marker" ]; then
    kv set "roster-by-child/$marker" '{"ancestors":["ses_handled_marker"]}' @courier
    kv set "roster/ses_handled_marker/$marker" "{\"sessionID\":\"$marker\",\"parentID\":\"ses_handled_marker\",\"title\":\"marker\",\"directory\":\"$WORK/project\",\"isolated\":false,\"createdAt\":$(now_ms),\"reports\":\"status\"}" @courier
    curl -s -o /dev/null -u "opencode:$OPENCODE_PASSWORD" -X DELETE "$SERVER/api/session/$marker"
    for _ in $(seq 1 $((${3:-30} * 2))); do
      [ -z "$(kv get "roster/ses_handled_marker/$marker")" ] && return 0
      sleep 0.5
    done
  fi
  echo "end_handled: the courier did not handle the events up to the turn end of $1 in ${3:-30} s" >&2
  return 1
}
wait_log() {
  for _ in $(seq 1 "${2:-30}"); do
    if grep -qF -- "$1" "$WORK/server.log"; then echo true; return; fi
    sleep 1
  done
  echo false
}

has_text() {
  for _ in $(seq 1 "${3:-30}"); do
    if texts "$1" | grep -qF -- "$2"; then echo true; return; fi
    sleep 1
  done
  echo false
}

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
person() {
  local body=${2:-'{}'}
  curl -s -o /dev/null -w '%{http_code}' -u "opencode:$OPENCODE_PASSWORD" -X POST -H 'content-type: application/json' --data "$body" "$SERVER/api/$1"
}
api_post() { curl -sf -u "opencode:$OPENCODE_PASSWORD" -X POST -H 'content-type: application/json' --data "$2" "$SERVER/api/$1"; }
api_prompt() {
  curl -sf -m 30 -u "opencode:$OPENCODE_PASSWORD" -X POST -H 'content-type: application/json' --data "{\"text\":\"$2\"}" \
    "$SERVER/api/session/$1/prompt" >/dev/null || echo "  api_prompt: session $1 was not prompted in $SCENARIO" >&2
}
dismiss_form() {
  curl -s -o /dev/null -w '%{http_code}' -u "opencode:$OPENCODE_PASSWORD" -X DELETE "$SERVER/api/session/$1/form/$2"
}
answer_form() { [ "$(person "session/$1/form/$2/reply" "{\"answer\":{\"q0\":$3}}")" = 204 ] && echo true || echo false; }
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
finished() {
  [ "$(api "session/$1" | jq -r '(.data // .) | .time.idle != null and (.time.busy // .time.updated) <= .time.idle')" = true ] && { echo true; return; }
  [ "$(api "session/$1/context" | jq -r '[.data[] | select(.type | IN("agent-switched", "model-switched", "location-switched", "shell") | not)] | last |
    .type == "idle" or (.type == "assistant" and .error.type == "aborted")')" = true ] && echo true || echo false
}
reported() {
  local prompted settled
  prompted=$(kv get "report/$1/prompt" | jq -r '.at // empty')
  settled=$(kv get "report/$1/settled" | jq -r 'select(.by == "report") | .at // empty')
  [ -n "$prompted" ] && [ -n "$settled" ] && [ "$settled" -ge "$prompted" ] && echo true || echo false
}
settled_with_report() {
  api "session/$1/message" | jq -r --arg request "$2" '.data | sort_by(.id) as $m |
    ([range(0; $m | length) | select($m[.].type == "synthetic" and ($m[.].text | contains(" answered=\"") and contains("request=\"" + $request + "\"")))] | first) as $s |
    ([range(0; $m | length) | select($m[.].type == "synthetic" and ($m[.].text | contains("CHILD DONE")))] | first) as $r |
    $s != null and $r != null and $r > $s and ([$m[$s:$r][] | select(.type == "assistant")] | length == 0)'
}
answer_state() {
  api "session/$1/message" | jq -c '[.data[] | select(.type == "assistant") | .content[]? | select(.type == "tool" and .name == "courier_answer") | .state] | last // empty'
}
own_request() {
  for _ in $(seq 1 "${3:-30}"); do
    local id
    id=$(api "session/$1/permission" | jq -r --arg request "$2" '[.data[] | select(.metadata.requestID == $request) | .id] | first // empty')
    if [ -n "$id" ]; then echo "$id"; return; fi
    sleep 1
  done
}
indexed_under() { kv get "roster-by-child/$1" | jq -r '.ancestors[0] // empty'; }
spawn_isolated() {
  local out
  out=$(prompt "COURIER-TEST isolate")
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  directory=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.directory')
  check "the isolated child reported back" "$([ -n "$(reply_time "$parent" "PARENT WOKE")" ] && echo true || echo false)"
}
child_listing() {
  prompt "COURIER-CHILDREN $1" | tool_state courier_children |
    jq -r --arg child "$2" 'if .status != "completed" then "error" elif any(.metadata.metadata.children[]; .sessionID == $child) then "listed" else "unlisted" end'
}
inbox() {
  curl -s -u "opencode:$OPENCODE_PASSWORD" -X POST "$SERVER/api/rpc/courier-person/$1?directory=$(node -p 'encodeURIComponent(process.argv[1])' "$WORK/project")" \
    -H 'content-type: application/json' -d "{\"input\":$2}"
}
session_info() { api "session/$1" | jq -c '.data // .'; }
patch_session() {
  [[ $(curl -s -o /dev/null -w '%{http_code}' -u "opencode:$OPENCODE_PASSWORD" -X PATCH -H 'content-type: application/json' --data "$2" "$SERVER/api/session/$1") == 20* ]] &&
    echo true || echo false
}
spawned_by() {
  for _ in $(seq 1 "${2:-30}"); do
    local id
    id=$(api "session/$1/message" | jq -r '[.data[] | .content[]? | select(.type == "tool" and .name == "courier_spawn") | .. | strings | capture("Started session (?<id>ses_\\w+) in ").id] | first // empty')
    if [ -n "$id" ]; then echo "$id"; return; fi
    sleep 1
  done
}
status_of() { curl -s -o /dev/null -w '%{http_code}' -u "opencode:$OPENCODE_PASSWORD" "$SERVER/api/session/$1"; }
SUITE="reports:89 reports-groups:97 reminder:18 finding:29 finding-up:16 person-message:7 permission:36 depth:4 role-entry:6 fork:10 entries:6 spawn-model:4 answer:35 search:11 questions:63 questions-more:73 restart-question:12 probe:20 skill:1 later:20 schedules:4 wake:50 roster:35 webhook:0 cleanup:5 dirty-root:2 subtree:1 failed-live:11 subagent:2 subagent-role:6 archive:127 nest:6 stall:84 inbox:36 busy:77 spawn-native:15 native:39 decline-seal:17 total-refusal:23 early-report:23 own-checkin:41 idle-stop:23 rolling-slot:33 person-up:12 plugin-add:16"
BOUND="restart-question roster"

shard_groups() {
  printf '%s\n' $SUITE | awk -F: -v k="$1" -v n="$2" -v bound="$BOUND" '
    BEGIN { nb = split(bound, b, " ") }
    {
      name[NR] = $1; unit[NR] = $1
      for (i = 1; i <= nb; i++) if ($1 == b[i]) unit[NR] = b[1]
      weight[unit[NR]] += $2
      if (!(unit[NR] in seen)) { seen[unit[NR]] = 1; order[++units] = unit[NR] }
    }
    END {
      for (i = 1; i <= units; i++) {
        top = i
        for (j = i + 1; j <= units; j++) if (weight[order[j]] > weight[order[top]]) top = j
        swap = order[i]; order[i] = order[top]; order[top] = swap
      }
      for (s = 1; s <= n; s++) load[s] = 0
      for (i = 1; i <= units; i++) {
        lightest = 1
        for (s = 2; s <= n; s++) if (load[s] < load[lightest]) lightest = s
        shard[order[i]] = lightest
        load[lightest] += weight[order[i]]
      }
      for (i = 1; i <= NR; i++) if (shard[unit[i]] == k) print name[i]
    }'
}
selected_groups() {
  local all group
  all=$(printf '%s\n' $SUITE | cut -d: -f1)
  if [ -n "${E2E_GROUPS:-}" ]; then
    for group in ${E2E_GROUPS//,/ }; do
      grep -qxF -- "$group" <<<"$all" || { echo "E2E_GROUPS: unknown group $group; the groups are: $(tr '\n' ' ' <<<"$all")" >&2; exit 2; }
    done
    grep -xF -f <(tr -s ', ' '\n' <<<"$E2E_GROUPS") <<<"$all" || true
  elif [ -n "${E2E_SHARD:-}" ]; then
    [[ $E2E_SHARD =~ ^([1-9][0-9]*)/([1-9][0-9]*)$ && ${BASH_REMATCH[1]} -le ${BASH_REMATCH[2]} ]] ||
      { echo "E2E_SHARD must be k/n with 1 <= k <= n, not $E2E_SHARD" >&2; exit 2; }
    shard_groups "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
  else
    echo "$all"
  fi
}
GROUP_LIST=$(selected_groups) || exit 2
if [ "${E2E_PLAN:-}" = 1 ]; then
  trap - EXIT
  [ -n "${E2E_WORK:-}" ] || rm -rf "$WORK"
  echo "$GROUP_LIST"
  exit 0
fi
echo "live suite${E2E_GROUPS:+, groups $E2E_GROUPS}${E2E_GROUPS:-${E2E_SHARD:+, shard $E2E_SHARD}}: $(tr '\n' ' ' <<<"$GROUP_LIST") epilogue"

mkdir -p "$WORK/project" "$HOME"
WEBHOOK_SECRET=courier-e2e-webhook-secret
printf '%s\n' "$WEBHOOK_SECRET" >"$WORK/webhook-secret"
build_plugin

COURIER_TYPES='["form.cancelled","form.created","form.replied","location.shutdown","permission.asked","permission.replied","session.deleted","session.execution.failed","session.execution.interrupted","session.execution.started","session.execution.succeeded","session.inbox.cancelled","session.inbox.delivered","session.inbox.enqueued"]'

cat >"$WORK/project/opencode.json" <<EOF
{
  "plugins": [
    { "package": "$ROOT/dist", "options": { "maxDepth": 2, "memory": true, "webhook": { "port": $WEBHOOK_PORT, "secretFile": "$WORK/webhook-secret" } } },
    "$ROOT/e2e/search-plugin",
    { "package": "$ROOT/e2e/probe-plugin", "options": { "log": "$WORK/probe.log", "types": $COURIER_TYPES } }
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

MOCK_PORT=$MOCK_PORT MOCK_CHILD_DELAY_MS=$CHILD_DELAY_MS MOCK_CHILD_DELAY_FILE=$WORK/child-delay MOCK_LOG=$WORK/model.log \
  node "$ROOT/e2e/mock-model.mjs" >"$WORK/model.out" 2>&1 </dev/null &
MOCK_PID=$!
start_server
echo "OpenCode $("$OPENCODE" --version) on $SERVER"

run_reports() {
  for mode in shared isolate; do
    scenario "spawn, then wake the idle parent ($mode)"
    message="COURIER-TEST"
    [ "$mode" = isolate ] && message="COURIER-TEST isolate"
    out=$(prompt "$message")
    turn_ended=$(now_ms)
    spawn=$(jq -c 'select(.type == "tool_use" and .part.tool == "courier_spawn") | .part.state' <<<"$out")
    parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
    directory=$(jq -r '.metadata.metadata.directory // empty' <<<"$spawn")
    child=$(jq -r '.metadata.metadata.sessionID' <<<"$spawn")
    check "courier_spawn completed" "$(jq -r '.status == "completed"' <<<"$spawn")"
    if [ "$mode" = isolate ]; then
      check "child runs in its own worktree" "$([[ $directory == */worktree/* ]] && echo true || echo false)"
    fi
    woke=$(reply_time "$parent" "PARENT WOKE")
    check "parent got a new turn after its own had ended" "$([ -n "$woke" ] && [ "$woke" -gt "$turn_ended" ] && echo true || echo false)"
    check "the report carries its status as an attribute, and its artifacts in the body" \
      "$(api "session/$parent/message" | jq -r --arg child "$child" '[.data[] | select(.type == "synthetic") | .text] | any(. ==
        "<courier from=\"" + $child + "\" status=\"done\">\nCHILD DONE\n\nArtifacts:\n- branch: child/work\n- commits: abc1234 Do the task\n- files: README.md\n- checks:\n  - echo ok: ok\n</courier>")')"
    check "which settled the child's report, with the status" "$(kv get "report/$child/settled" | jq -r '.by == "report" and .status == "done"')"
    check "and no notice of a turn without a report, since the child reported" \
      "$(api "session/$parent/message" | jq -r '[.data[] | select(.type == "synthetic") | .text | select(contains(" ended="))] | length == 0')"
  done

  scenario "courier_children reports each child's state and last reply"
  check "with the child's last turn and its reply" "$(prompt "COURIER-CHILDREN $parent" | tool_state courier_children | jq -r --arg child "$child" '.status == "completed" and
    (.metadata.metadata.children[] | select(.sessionID == $child) | .outcome == "succeeded" and (.lastText | contains("TOOL DONE courier_send")) and (.idle | type == "number"))')"
  check "and lists none for an unknown session" "$(prompt "COURIER-CHILDREN ses_missing" | tool_state courier_children | jq -r '.status == "completed" and (.metadata.metadata.children | length == 0)')"

  scenario "a child runs on its parent's model, not the default one"
  out=$(bounded_run "$WORK/project" --model mock/other "COURIER-TEST")
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "the child reported back" "$([ -n "$(reply_time "$parent" "PARENT WOKE")" ] && echo true || echo false)"
  check "every reply of the child came from the parent's model"   "$(api "session/$child/message" | jq -r '[.data[] | select(.type == "assistant") | .model.id] | length > 0 and all(. == "other")')"

  scenario "a child whose turn fails is reported to its idle parent"
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

  failed_parent=$parent failed_child=$child
  scenario "a child that hit a quota limit is reported with when it lifts, and the panel shows it"
  out=$(prompt "COURIER-LIMIT")
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "the parent was woken by the failure" "$([ -n "$(reply_time "$parent" "PARENT WOKE" 45)" ] && echo true || echo false)"
  notices=$(api "session/$parent/message" | jq -c '[.data[] | select(.type == "synthetic") | .text]')
  echo "  $notices"
  check "the notice names the quota error and says to wait about 30 minutes" \
    "$(jq -r 'join("") | contains("provider.quota") and contains("asked to wait about 30 minutes before trying again, until about") and contains("UTC")' <<<"$notices")"
  check "and says not to message the child before then" "$(jq -r 'join("") | contains("Do not message it with courier_send before then")' <<<"$notices")"
  settled=$(kv get "report/$child/settled")
  echo "  $settled"
  check "the child's settled note keeps when the limit lifts, the failure plus 30 minutes" \
    "$(jq -r '.by == "failed" and (.resumesAt - .at) == 1800000' <<<"$settled")"
  directory=$(node -p 'encodeURIComponent(process.argv[1])' "$WORK/project")
  row=$(api_post "rpc/courier/tree?directory=$directory" "{\"input\":{\"sessionID\":\"$parent\"}}" |
    jq -c --arg id "$child" '.output.rows[] | select(.sessionID == $id) | {state, outcome, resumes}')
  echo "  $row"
  check "the panel's row is idle and failed, with a resume time 30 minutes after the failure" \
    "$(jq -r --argjson settled "$settled" '.state == "idle" and .outcome == "failed" and .resumes == $settled.resumesAt' <<<"$row")"
  check "while the child that failed without a retry time has a row without one" \
    "$(api_post "rpc/courier/tree?directory=$directory" "{\"input\":{\"sessionID\":\"$failed_parent\"}}" |
      jq -r --arg id "$failed_child" '[.output.rows[] | select(.sessionID == $id) | select(.outcome == "failed" and (has("resumes") | not))] | length == 1')"

  scenario "a child whose turn ends without a report is reported to its idle parent"
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
    "$(turn_ended "$child"; end_handled "$child" "$parent" && notices_with "$parent" ended | jq -r 'length == 1' || echo false)"

  scenario "a message without a status is progress: a child that then ends its turn is reported, and the notice says so"
  out=$(prompt "COURIER-PROGRESS")
  turn_ended=$(now_ms)
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  woke=$(reply_time "$parent" "PARENT WOKE" 45)
  check "the message started a new turn after the parent's had ended" \
    "$([ -n "$woke" ] && [ "$woke" -gt "$turn_ended" ] && echo true || echo false)"
  check "without a status attribute" "$(api "session/$parent/message" | jq -r --arg child "$child" \
    '[.data[] | select(.type == "synthetic") | .text | select(startswith("<courier from=\"" + $child + "\">") and contains("CHILD HALFWAY"))] | length == 1')"
  check "then the parent was told the child ended without a report, and that its last message had no status" \
    "$([ -n "$(reply_time "$parent" "PARENT TOLD SILENT" 45)" ] && notices_with "$parent" ended | jq -r --arg child "$child" 'length == 1 and (.[0] |
    contains("<courier from=\"" + $child + "\" ended=\"without-report\">") and contains("Its last message to you had no status"))')"
  check "the child owes its parent a report, its message noted as progress" \
    "$([ -z "$(kv get "report/$child/settled")" ] && [ "$(kv get "report/$child/progress" | jq -r '.at | type == "number"')" = true ] && echo true || echo false)"
  prompt_in "$parent" "COURIER-NUDGE $child" >/dev/null
  check "told to report, the child did, with a status" "$(has_text "$parent" "<courier from=\"$child\" status=\"done\">" 45)"
  check "which settled its report, with the status" "$(kv get "report/$child/settled" | jq -r '.by == "report" and .status == "done"')"
  check "and its reported turn was not told as one without a report" "$(turn_ended "$child"; end_handled "$child" "$parent" && notices_with "$parent" ended | jq -r 'length == 1' || echo false)"

  scenario "a child an older release briefed, whose roster entry says nothing of statuses, reports without one, as before"
  out=$(prompt "COURIER-SILENT")
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "the parent was told it ended without a report" "$([ -n "$(reply_time "$parent" "PARENT TOLD SILENT" 45)" ] && echo true || echo false)"
  entry=$(kv get "roster/$parent/$child")
  check "its roster entry is rewritten as an older release wrote it, without reports" \
    "$([ "$(jq -r '.reports' <<<"$entry")" = status ] && kv set "roster/$parent/$child" "$(jq -c 'del(.reports)' <<<"$entry")" "roster/$parent/$child" && echo true || echo false)"
  prompt_in "$parent" "COURIER-NUDGE-PLAIN $child" >/dev/null
  check "told to report, the child did, without a status" "$(has_text "$parent" "CHILD DONE WITHOUT STATUS" 45)"
  check "which settled its report, with no status" "$(kv get "report/$child/settled" | jq -r '.by == "report" and (has("status") | not)')"
  check "and its parent was not told again" "$(turn_ended "$child"; end_handled "$child" "$parent" && notices_with "$parent" ended | jq -r 'length == 1' || echo false)"

  scenario "what the person types in a child that has reported does not make it owe a report"
  out=$(prompt "COURIER-TEST")
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "the child reported" "$([ -n "$(reply_time "$parent" "PARENT WOKE")" ] && echo true || echo false)"
  prompt_in "$child" "PERSON-ASKS" >/dev/null
  check "the child answered the person in its own session" "$([ -n "$(reply_time "$child" "CHILD ANSWERS PERSON")" ] && echo true || echo false)"
  check "and its parent was not told it ended without a report" "$(turn_ended "$child"; end_handled "$child" "$parent" && notices_with "$parent" ended | jq -r 'length == 0' || echo false)"

}

run_reports_groups() {
  scenario "a join group: the parent is woken once, with both reports in one message"
  out=$(prompt "COURIER-GROUP")
  turn_ended=$(now_ms)
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  members=$(tool_state courier_spawn <<<"$out" | jq -r 'select(.status == "completed") | .metadata.metadata.sessionID')
  check "two children were started in the group, and courier_spawn said their reports are held with it" \
    "$([ "$(wc -w <<<"$members")" -eq 2 ] && tool_state courier_spawn <<<"$out" | jq -sr 'all(.metadata.metadata.group == "pair" and (.output | contains("held with group \"pair\"")))')"
  woke=$(reply_time "$parent" "PARENT GOT GROUP" 45)
  check "the group's reports started a new turn after the parent's had ended" "$([ -n "$woke" ] && [ "$woke" -gt "$turn_ended" ] && echo true || echo false)"
  notices=$(api "session/$parent/message" | jq -c '[.data[] | select(.type == "synthetic") | .text]')
  check "the parent got exactly one message" "$(jq -r 'length == 1' <<<"$notices")"
  check "with both reports, each with its status and artifacts, under the group's envelope" \
    "$(jq -r --arg members "$(tr '\n' ',' <<<"$members" | sed 's/,$//')" '.[0] | startswith("<courier from=\"") and contains("\" group=\"pair\" reports=\"2\">") and
      contains("Group \"pair\" is complete: 2 reports of 2 members (2 done). Each report follows") and contains("[1/2] ") and contains("[2/2] ") and
      (split("\": done\nCHILD DONE\n\nArtifacts:\n- branch: child/work") | length == 3) and
      ((capture("from=\"(?<from>[^\"]+)\"").from | split(",") | sort) == ($members | split(",") | sort))' <<<"$notices")"
  check "each child's courier_send result said its report was held with the group, not delivered" \
    "$(for id in $members; do texts "$id" | grep -qF 'It is held with group "pair" and goes to' || { echo false; exit; }; done; echo true)"
  check "each member's report is settled with its status" "$(for id in $members; do [ "$(kv get "report/$id/settled" | jq -r '.by == "report" and .status == "done"')" = true ] || { echo false; exit; }; done; echo true)"
  check "the delivered group is gone from storage" "$(for id in $members; do [ -z "$(kv get "group/$parent/pair/$id")" ] || { echo false; exit; }; done; echo true)"
  check "courier_children shows each child's group as released" "$(prompt "COURIER-CHILDREN $parent" | tool_state courier_children |
    jq -r '.status == "completed" and ([.metadata.metadata.children[].group] == [{name: "pair", report: "released"}, {name: "pair", report: "released"}])')"

  scenario "a member's blocked report reaches the parent at once; the other's is held until that member reports"
  out=$(prompt "COURIER-GROUP-BLOCKED")
  turn_ended=$(now_ms)
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  members=$(tool_state courier_spawn <<<"$out" | jq -r 'select(.status == "completed") | .metadata.metadata.sessionID')
  woke=$(reply_time "$parent" "PARENT BLOCKED" 45)
  check "the blocked report started a new turn after the parent's had ended" "$([ -n "$woke" ] && [ "$woke" -gt "$turn_ended" ] && echo true || echo false)"
  blocked=$(api "session/$parent/message" | jq -r '[.data[] | select(.type == "synthetic") | .text | capture("^<courier from=\"(?<from>ses_\\w+)\" status=\"blocked\">").from] | first // empty')
  held=$(grep -vxF "$blocked" <<<"$members" || true)
  check "it was the one message the parent got, with the blocked status and nothing held" \
    "$([ -n "$blocked" ] && [ -n "$held" ] && api "session/$parent/message" | jq -r '[.data[] | select(.type == "synthetic") | .text] | length == 1 and (.[0] | contains("CHILD BLOCKED"))')"
  check "the other member's done report is held with the group, and the blocked member is still out" \
    "$(for _ in $(seq 1 30); do [ "$(kv get "group/$parent/pair/$held" | jq -r '.report.status == "done"' 2>/dev/null)" = true ] && break; sleep 1; done
       [ "$(kv get "group/$parent/pair/$held" | jq -r '.report.status == "done"')" = true ] && [ "$(kv get "group/$parent/pair/$blocked" | jq -r 'has("report") | not')" = true ] && echo true || echo false)"
  check "courier_children shows the group with one report held and one out" "$(prompt "COURIER-CHILDREN $parent" | tool_state courier_children |
    jq -r --arg held "$held" --arg blocked "$blocked" '.status == "completed" and
      ([.metadata.metadata.children[] | select(.sessionID == $held) | .group] == [{name: "pair", report: "held"}]) and
      ([.metadata.metadata.children[] | select(.sessionID == $blocked) | .group] == [{name: "pair", report: "out"}])')"
  prompt_in "$parent" "COURIER-NUDGE-BLOCK $blocked" >/dev/null
  again=$([ "$(has_text "$parent" "CHILD BLOCKED AGAIN" 45)" = true ] && api "session/$parent/message" | jq -r '[.data[] | select(.type == "synthetic") | .text | select(contains("CHILD BLOCKED AGAIN"))] | first // ""')
  check "blocked again, now that the other's report is held, its report brings that report, which stays held" \
    "$(jq -rn --arg text "$again" --arg held "$held" '($text | contains("status=\"blocked\">")) and ($text | contains("Held with group \"pair\" so far, 1 report")) and
      ($text | contains("- " + $held + " \"")) and ($text | contains(": done\nCHILD DONE\n"))' | grep -qx true &&
      [ "$(kv get "group/$parent/pair/$held" | jq -r '.report.status == "done"')" = true ] && echo true || echo false)"
  prompt_in "$parent" "COURIER-NUDGE $blocked" >/dev/null
  check "answered, the blocked member reported, and the group went to the parent in one message with both reports" \
    "$([ -n "$(reply_time "$parent" "PARENT GOT GROUP" 45)" ] && notices_with "$parent" group | jq -r 'length == 1 and (.[0] |
      contains("reports=\"2\"") and contains("CHILD DONE AFTER NUDGE") and contains("\": done\nCHILD DONE\n"))')"
  check "and the group is gone from storage" "$(for id in $members; do [ -z "$(kv get "group/$parent/pair/$id")" ] || { echo false; exit; }; done; echo true)"

  scenario "a member that ends silently, dropped with courier_cleanup, releases its group without it, and its late report comes on its own"
  out=$(prompt "COURIER-GROUP-DROP")
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  members=$(tool_state courier_spawn <<<"$out" | jq -r 'select(.status == "completed") | .metadata.metadata.sessionID')
  check "the parent was told a member ended without a report" "$([ -n "$(reply_time "$parent" "PARENT TOLD SILENT" 45)" ] && echo true || echo false)"
  silent=$(notices_with "$parent" ended | jq -r '.[0] | capture("^<courier from=\"(?<from>ses_\\w+)\"").from')
  reported=$(grep -vxF "$silent" <<<"$members" || true)
  check "the notice offers to drop it with courier_cleanup" "$(notices_with "$parent" ended | jq -r '.[0] | contains("drop it with courier_cleanup")')"
  check "the other member's report is held, and nothing else reached the parent" \
    "$([ -n "$reported" ] && [ "$(kv get "group/$parent/pair/$reported" | jq -r '.report.status')" = done ] && notices_with "$parent" group | jq -r 'length == 0')"
  cleaned=$(prompt_in "$parent" "COURIER-CLEANUP $silent" | tool_state courier_cleanup)
  check "courier_cleanup forgot it, with no worktree to remove, and dropped it from the group" \
    "$(jq -r '.status == "completed" and .metadata.metadata.outcome == "forgotten" and .metadata.metadata.group == "pair" and (.output | contains("Dropped it from group \"pair\""))' <<<"$cleaned")"
  check "it is off the roster, with its reverse key and report state" \
    "$([ -z "$(kv get "roster/$parent/$silent")$(kv get "roster-by-child/$silent")$(kv get "report/$silent/prompt")" ] && echo true || echo false)"
  check "the group reached the parent at once, in one message, with the held report and the dropped member named" \
    "$(for _ in $(seq 1 10); do [ "$(notices_with "$parent" group | jq -r 'length')" = 1 ] && break; sleep 1; done
       notices_with "$parent" group | jq -r --arg silent "$silent" --arg reported "$reported" 'length == 1 and (.[0] |
         startswith("<courier from=\"" + $reported + "\" group=\"pair\" reports=\"1\">") and
         contains("1 report of 2 members (1 done), 1 member without a report") and contains("CHILD DONE") and
         contains("Without a report: " + $silent + " \"CHILD-SILENT\" (you dropped it with courier_cleanup)."))')"
  check "and the group is gone from storage" "$(for id in $members; do [ -z "$(kv get "group/$parent/pair/$id")" ] || { echo false; exit; }; done; echo true)"
  prompt_in "$parent" "COURIER-NUDGE $silent" >/dev/null
  check "told to report after all, the dropped member's report reached the parent on its own, as a child in no group" \
    "$(has_text "$parent" "<courier from=\"$silent\" status=\"done\">" 45)"
  check "and no group was opened again for it" "$([ -z "$(kv get "group/$parent/pair/$silent")" ] && notices_with "$parent" group | jq -r 'length == 1')"

  scenario "a group whose members report before the parent's turn has ended goes out once it has, in one message"
  out=$(prompt "COURIER-GROUP-SPLIT")
  turn_ended=$(now_ms)
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  members=$(tool_state courier_spawn <<<"$out" | jq -r 'select(.status == "completed") | .metadata.metadata.sessionID')
  first=$(head -1 <<<"$members")
  second=$(sed -n 2p <<<"$members")
  check "the first member reported before the second was started" \
    "$([ -n "$second" ] && [ "$(kv get "report/$first/settled" | jq -r '.at')" -lt "$(kv get "roster/$parent/$second" | jq -r '.createdAt')" ] && echo true || echo false)"
  woke=$(reply_time "$parent" "PARENT GOT GROUP" 45)
  check "both had reported before the parent's turn ended" \
    "$([ "$(kv get "report/$second/settled" | jq -r '.at')" -lt "$turn_ended" ] && echo true || echo false)"
  ended=$(api "session/$parent/message" | jq -r '[.data[] | select(.type == "idle") | .time.created] | min // empty')
  check "the group's reports started a new turn within 3 s of the parent's turn ending, not at the next tick" \
    "$([ -n "$woke" ] && [ -n "$ended" ] && [ "$woke" -gt "$ended" ] && [ $((woke - ended)) -lt 3000 ] && echo true || echo false)"
  check "the parent got exactly one message, with both reports" \
    "$(for _ in $(seq 1 20); do [ -z "$(kv get "group/$parent/pair/$first")$(kv get "group/$parent/pair/$second")" ] && break; sleep 0.5; done
      [ -z "$(kv get "group/$parent/pair/$first")$(kv get "group/$parent/pair/$second")" ] && api "session/$parent/message" | jq -r '[.data[] | select(.type == "synthetic") | .text] |
      length == 1 and (.[0] | contains("reports=\"2\"") and (split("CHILD DONE QUICKLY") | length == 3))' || echo false)"

  scenario "a sub-orchestrator whose group reports during its turn gets it once that turn ends, and is not told of as silent"
  out=$(prompt "COURIER-GROUP-NESTED")
  root=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  middle=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "the middle session reported its group's message on to the root" "$(has_text "$root" "MIDDLE GOT GROUP" 60)"
  check "it got exactly one message, with both of its leaves' reports" "$(api "session/$middle/message" | jq -r '[.data[] | select(.type == "synthetic") | .text] |
    length == 1 and (.[0] | contains("reports=\"2\"") and (split("CHILD DONE QUICKLY") | length == 3))')"
  check "and the root was not told it ended without a report" "$(turn_ended "$middle"; end_handled "$middle" "$root" && notices_with "$root" ended | jq -r 'length == 0' || echo false)"

  scenario "a deleted child that owes a report is forgotten"
  out=$(prompt "COURIER-SILENT")
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "the parent was told it ended without a report" "$([ -n "$(reply_time "$parent" "PARENT TOLD SILENT" 45)" ] && echo true || echo false)"
  check "the child is deleted" "$([[ $(curl -s -o /dev/null -w '%{http_code}' -u "opencode:$OPENCODE_PASSWORD" -X DELETE "$SERVER/api/session/$child") == 20* ]] && echo true || echo false)"
  check "and its report state is gone" \
    "$(for _ in $(seq 1 20); do [ -z "$(kv get "report/$child/prompt")$(kv get "report/$child/told")" ] && { echo true; exit; }; sleep 1; done; echo false)"
  check "and so is its roster entry, so courier_children no longer lists it" \
    "$(for _ in $(seq 1 20); do [ "$(child_listing "$parent" "$child")" = unlisted ] && { echo true; exit; }; sleep 1; done; echo false)"

  scenario "a deleted isolated child stays on courier_children, for courier_cleanup"
  child_delay 1000
  spawn_isolated
  check "the isolated child is deleted" "$([[ $(curl -s -o /dev/null -w '%{http_code}' -u "opencode:$OPENCODE_PASSWORD" -X DELETE "$SERVER/api/session/$child") == 20* ]] && echo true || echo false)"
  check "it is still listed" "$(prompt_in "$parent" "COURIER-CHILDREN $parent" >/dev/null; turn_ended "$parent"
    end_handled "$parent" "$parent" && [ "$(child_listing "$parent" "$child")" = listed ] && echo true || echo false)"
  check "and its worktree is still there for courier_cleanup" "$([ -d "$directory" ] && echo true || echo false)"

  scenario "a child that ends its turn to wait for a message it scheduled is not reported, and reports once woken"
  out=$(prompt "COURIER-WAITING")
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "the scheduled message woke the child, which reported" "$([ -n "$(reply_time "$parent" "PARENT WOKE" 75)" ] && echo true || echo false)"
  check "the child's first turn, which ended waiting, was not told" "$(turn_ended "$child"; end_handled "$child" "$parent" && notices_with "$parent" ended | jq -r 'length == 0' || echo false)"
  check "the child scheduled the message in its first turn" \
    "$(api "session/$child/message" | jq -r '[.data[] | select(.type == "assistant") | .content[]? | select(.type == "tool" and .name == "courier_later")] | length == 1')"
}

run_reminder() {
  scenario "a child about to end its turn without a report is reminded once, in the same turn, and reports"
  out=$(prompt "COURIER-SILENT-HEEDS")
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "the reminded child reported to its parent" "$(has_text "$parent" "<courier from=\"$child\" status=\"done\">" 45)"
  turn_ended "$child"
  reminders=$(notices_with "$child" reminder)
  check "it got one reminder, after its reply and before its report, all in one turn" "$(api "session/$child/message" | jq -r '
    [.data[] | if .type == "idle" then "end" elif .type == "synthetic" then (if (.text | contains("reminder=\"report\"")) then "reminder" else empty end)
      elif .type == "assistant" then ([.content[]? | select(.type == "text") | .text] | join("") | if contains("CHILD SILENT REPLY") then "reply" else empty end),
        ([.content[]? | select(.type == "tool") | .name] | if index("courier_send") then "report" else empty end)
      else empty end] == ["end", "report", "reminder", "reply"]')"
  check "which names the session to report to" "$(jq -r --arg parent "$parent" 'length == 1 and (.[0] |
    startswith("<courier from=\"courier\" reminder=\"report\">") and contains("sessionID \"" + $parent + "\""))' <<<"$reminders")"
  nudged=$(kv get "report/$child/nudged")
  echo "  $nudged"
  check "the mark keeps the reminder's inbox id, and its delivery was not taken for a prompt" \
    "$(api "session/$child/message" | jq -r --argjson nudged "$nudged" --argjson prompt "$(kv get "report/$child/prompt")" \
      '[.data[] | select(.type == "synthetic" and (.text | contains("reminder=\"report\""))) | .id] == [$nudged.inboxID] and $prompt.at <= $nudged.at')"
  check "its report settled what it owed" "$(kv get "report/$child/settled" | jq -r '.by == "report" and .status == "done"')"
  check "the parent was not told of a turn without a report, and no wake was watched for the reminder" \
    "$(end_handled "$child" "$parent" && [ "$(notices_with "$parent" ended | jq -r 'length')" = 0 ] && [ -z "$(kv get "wake/$child/$(jq -r .inboxID <<<"$nudged")")" ] && echo true || echo false)"

  scenario "a child that ignores its reminder ends its turn, and the parent is told as before"
  out=$(prompt "COURIER-SILENT")
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "the parent was told the child ended without a report" "$([ -n "$(reply_time "$parent" "PARENT TOLD SILENT" 45)" ] && echo true || echo false)"
  turn_ended "$child"
  check "after one reminder, not two" "$(notices_with "$child" reminder | jq -r 'length == 1')"
  check "once, with the reply it gave after the reminder" "$(notices_with "$parent" ended | jq -r --arg child "$child" 'length == 1 and (.[0] |
    contains("<courier from=\"" + $child + "\" ended=\"without-report\">") and contains("CHILD SILENT REPLY"))')"
  check "and the child still owes the report of its task" "$([ -z "$(kv get "report/$child/settled")" ] && echo true || echo false)"
}

run_early_report() {
  scenario "a child whose group completes in the turn that started it reports then, and owes nothing when the group or its own child's status-less message arrives"
  out=$(prompt "COURIER-EARLY-REPORT")
  root=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  middle=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "the middle session reported to the root in the turn that started its group" "$(has_text "$root" "MID DONE EARLY" 60)"
  check "its group's message reached it after, in a turn of its own" "$([ -n "$(reply_time "$middle" "MID SAW GROUP" 60)" ] && echo true || echo false)"
  turn_ended "$middle"
  check "that turn ended without a report reminder, and the middle session reported once" "$(api "session/$middle/message" | jq -r --arg root "$root" '
    ([.data[] | select(.type == "synthetic") | .text | select(contains(" reminder=\"report\""))] | length == 0) and
    ([.data[] | select(.type == "assistant") | .content[]? | select(.type == "tool" and .name == "courier_send" and .state.input.sessionID == $root)] | length == 1)')"
  prompt_at=$(kv get "report/$middle/prompt" | jq -r .at)
  check "the group's delivery was not taken for a prompt" "$(kv get "report/$middle/settled" | jq -r --argjson prompt "$prompt_at" '.at >= $prompt')"
  grandchild=$(spawned_by "$middle")
  api_post "session/$middle/synthetic" "$(jq -nc --arg text "<courier from=\"$grandchild\">GRANDCHILD-CORRECTS</courier>" --arg from "$grandchild" \
    '{text: $text, description: ("Message from " + $from), metadata: {source: "courier", from: $from}, delivery: "steer"}')" >/dev/null
  check "its own child's status-less message reached it after, in a turn of its own" "$([ -n "$(reply_time "$middle" "PARENT WOKE" 30)" ] && echo true || echo false)"
  turn_ended "$middle"
  check "that turn ended without a report reminder or a second report" "$(api "session/$middle/message" | jq -r --arg root "$root" '
    ([.data[] | select(.type == "synthetic") | .text | select(contains(" reminder=\"report\""))] | length == 0) and
    ([.data[] | select(.type == "assistant") | .content[]? | select(.type == "tool" and .name == "courier_send" and .state.input.sessionID == $root)] | length == 1)')"
  check "the child's message was not taken for a prompt" "$(kv get "report/$middle/prompt" | jq -r --argjson prompt "$prompt_at" '.at == $prompt')"
  api_post "session/$middle/synthetic" "$(jq -nc --arg text "<courier from=\"$root\">CHILD-REPORT-NOW</courier>" --arg from "$root" \
    '{text: $text, description: ("Message from " + $from), metadata: {source: "courier", from: $from}, delivery: "steer"}')" >/dev/null
  moved=$(for _ in $(seq 1 60); do
    [ "$(kv get "report/$middle/prompt" | jq -r --argjson before "$prompt_at" '.at > $before')" = true ] && { echo true; exit; }
    sleep 0.5
  done; echo false)
  check "a later courier message to it counted as a prompt" "$moved"
  check "the ends of those turns told the root nothing" "$([ -z "$(kv get "report/$middle/told")" ] && echo true || echo false)"
  check "the root's next message from it is the report that message asked for, with no notice of a silent end before it" \
    "$([ "$(has_text "$root" "CHILD DONE AFTER NUDGE" 30)" = true ] && notices_with "$root" ended | jq -r 'length == 0')"
}

run_own_checkin() {
  scenario "a child whose own check-in fires after it reported owes nothing for it, while its parent's scheduled message counts"
  out=$(prompt "COURIER-OWN-CHECKIN")
  root=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  middle=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "the middle session scheduled a check-in for itself and reported to the root" "$(has_text "$root" "MID DONE BEFORE CHECK-IN" 60)"
  check "its check-in reached it after, in a turn of its own" "$([ -n "$(reply_time "$middle" "MID SAW CHECK-IN" 60)" ] && echo true || echo false)"
  turn_ended "$middle"
  check "that turn ended without a report reminder, and the middle session reported once" "$(api "session/$middle/message" | jq -r --arg root "$root" '
    ([.data[] | select(.type == "synthetic") | .text | select(contains(" reminder=\"report\""))] | length == 0) and
    ([.data[] | select(.type == "assistant") | .content[]? | select(.type == "tool" and .name == "courier_send" and .state.input.sessionID == $root)] | length == 1)')"
  prompt_at=$(kv get "report/$middle/prompt" | jq -r .at)
  check "the check-in's delivery was not taken for a prompt" "$(kv get "report/$middle/settled" | jq -r --argjson prompt "$prompt_at" '.at >= $prompt')"
  api_post "session/$middle/synthetic" "$(jq -nc --arg text "<courier from=\"$root\" scheduled=\"2026-01-01T00:00:00.000Z\">CHILD-REPORT-NOW</courier>" --arg from "$root" \
    '{text: $text, description: ("Scheduled message from " + $from), metadata: {source: "courier", from: $from, scheduled: "later_e2e"}, delivery: "queue"}')" >/dev/null
  moved=$(for _ in $(seq 1 60); do
    [ "$(kv get "report/$middle/prompt" | jq -r --argjson before "$prompt_at" '.at > $before')" = true ] && { echo true; exit; }
    sleep 0.5
  done; echo false)
  check "a message its parent scheduled for it counted as a prompt" "$moved"
  check "the end of the check-in's turn told the root nothing" "$([ -z "$(kv get "report/$middle/told")" ] && echo true || echo false)"
  check "the root's next message from it is the report that message asked for, with no notice of a silent end before it" \
    "$([ "$(has_text "$root" "CHILD DONE AFTER NUDGE" 30)" = true ] && notices_with "$root" ended | jq -r 'length == 0')"
  turn_ended "$middle"
  turn_ended "$root"
  api_post "session/$middle/synthetic" "$(jq -nc --arg text "<courier from=\"$middle\" scheduled=\"2026-01-01T00:00:00.000Z\">MID-CHECK-IN</courier>" \
    --arg from "$middle" --argjson at "$(now_ms)" \
    '{text: $text, description: ("Scheduled message from " + $from), metadata: {source: "courier", from: $from, scheduled: "later_e2e_own", scheduledAt: $at}, delivery: "queue"}')" >/dev/null
  check "a message it scheduled for itself after its report got it a report reminder" "$(has_text "$middle" "<courier from=\"courier\" reminder=\"report\">" 45)"
  check "and the root was told it ended without a report" "$(has_text "$root" "<courier from=\"$middle\" ended=\"without-report\">" 45)"
  turn_ended "$middle"
  turn_ended "$root"
}

run_finding() {
  scenario "a child's finding without a status reaches its parent, which passes it on into a sibling's running turn"
  out=$(prompt "COURIER-FINDING")
  turn_ended=$(now_ms)
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  finder=$(tool_state courier_spawn <<<"$out" | jq -r 'select(.input.task == "CHILD-FINDS") | .metadata.metadata.sessionID')
  hearer=$(tool_state courier_spawn <<<"$out" | jq -r 'select(.input.task == "CHILD-HEARS") | .metadata.metadata.sessionID')
  check "two children were started in one group" "$([ -n "$finder" ] && [ -n "$hearer" ] && echo true || echo false)"
  passed=$(reply_time "$parent" "PARENT PASSED ON" 45)
  check "the finding started a new turn after the parent's had ended" "$([ -n "$passed" ] && [ "$passed" -gt "$turn_ended" ] && echo true || echo false)"
  plain=$(api "session/$parent/message" | jq -r --arg finder "$finder" '[.data[] | select(.type == "synthetic") | .text |
    select(startswith("<courier from=\"" + $finder + "\">") and contains("FINDING: the shared API returns cents"))] | length == 1')
  check "it came without a status, and was noted as the finder's progress" \
    "$([ "$plain" = true ] && [ "$(kv get "report/$finder/progress" | jq -r '.at | type == "number"')" = true ] && echo true || echo false)"
  check "the parent passed it on to the sibling only" \
    "$([ "$(has_text "$hearer" "<courier from=\"$parent\">" 30)" = true ] && ! texts "$finder" | grep -qF "Passed on from" && echo true || echo false)"
  check "the sibling heard it in the turn it was running, and reported it" \
    "$([ -n "$(reply_time "$parent" "PARENT GOT GROUP" 60)" ] && notices_with "$parent" group | jq -r 'length == 1 and (.[0] |
      contains("reports=\"2\"") and contains("HEARD FINDING: the shared API returns cents") and contains("FINDER DONE"))')"
  check "neither child was told as one that ended without a report" "$(notices_with "$parent" ended | jq -r 'length == 0')"

  scenario "a group member's finding on its report reaches the parent at once, the report held; the sibling has it before it reports"
  out=$(prompt "COURIER-FINDING-IN-REPORT")
  turn_ended=$(now_ms)
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  finder=$(tool_state courier_spawn <<<"$out" | jq -r 'select(.input.task == "CHILD-FINDS-IN-REPORT") | .metadata.metadata.sessionID')
  hearer=$(tool_state courier_spawn <<<"$out" | jq -r 'select(.input.task == "CHILD-HEARS") | .metadata.metadata.sessionID')
  check "two children were started in one group" "$([ -n "$finder" ] && [ -n "$hearer" ] && echo true || echo false)"
  passed=$(reply_time "$parent" "PARENT PASSED ON" 45)
  check "the finding started a new turn after the parent's had ended" "$([ -n "$passed" ] && [ "$passed" -gt "$turn_ended" ] && echo true || echo false)"
  check "the finder's one courier_send was its report, held with the group, its finding sent ahead" \
    "$(api "session/$finder/message" | jq -r '[.data[] | select(.type == "assistant") | .content[]? | select(.type == "tool" and .name == "courier_send") | .state] |
      length == 1 and (.[0] | .status == "completed" and .input.status == "done" and ((.metadata.metadata // .metadata) | .finding == "ahead" and .held.group == "finding") and
        (tostring | contains("Its finding went to")))')"
  check "the parent passed it on to the sibling only" \
    "$([ "$(has_text "$hearer" "<courier from=\"$parent\">" 30)" = true ] && ! texts "$finder" | grep -qF "Passed on from" && echo true || echo false)"
  check "the sibling heard it in the turn it was running, and reported it" \
    "$([ -n "$(reply_time "$parent" "PARENT GOT GROUP" 60)" ] && notices_with "$parent" group | jq -r 'length == 1 and (.[0] |
      contains("reports=\"2\"") and contains("HEARD FINDING: the shared API returns cents") and contains("FINDER DONE\n\nFinding for the other parts:\nFINDING: the shared API returns cents"))')"
  check "the finding came in an envelope of its own, marked ahead, before the group's message" \
    "$(api "session/$parent/message" | jq -r --arg finder "$finder" '[.data | sort_by(.id)[] | select(.type == "synthetic") | .text] |
      (map(startswith("<courier from=\"" + $finder + "\" finding=\"ahead\">") and contains("held with group \"finding\"") and contains("FINDING: the shared API returns cents")) | index(true)) as $ahead |
      (map(contains(" group=\"finding\"")) | index(true)) as $group | length == 2 and $ahead == 0 and $group == 1')"
  check "the finder sent no progress, and neither child was told as one that ended without a report" \
    "$([ -z "$(kv get "report/$finder/progress")" ] && notices_with "$parent" ended | jq -r 'length == 0')"

  scenario "the report that completes its group sends no finding ahead: the finding comes in the group's message, under the report"
  out=$(prompt "COURIER-FINDING-LAST")
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  early=$(tool_state courier_spawn <<<"$out" | jq -r 'select(.input.task == "CHILD-REPORTS-FIRST") | .metadata.metadata.sessionID')
  finder=$(tool_state courier_spawn <<<"$out" | jq -r 'select(.input.task == "CHILD-FINDS-LAST") | .metadata.metadata.sessionID')
  check "two children were started in one group" "$([ -n "$early" ] && [ -n "$finder" ] && echo true || echo false)"
  check "the first member's report is held" \
    "$(for _ in $(seq 1 30); do [ "$(kv get "group/$parent/finding/$early" | jq -r '.report.status == "done"' 2>/dev/null)" = true ] && { echo true; exit; }; sleep 1; done; echo false)"
  api_post "session/$finder/synthetic" "$(jq -nc --arg text "<courier from=\"$parent\">REPORT-NOW</courier>" --arg from "$parent" \
    '{text: $text, description: ("Message from " + $from), metadata: {source: "courier", from: $from}, delivery: "steer"}')" >/dev/null
  check "the parent got the group's message, with the finding under the finder's report" \
    "$([ -n "$(reply_time "$parent" "PARENT GOT GROUP" 60)" ] && notices_with "$parent" group | jq -r 'length == 1 and (.[0] |
      contains("reports=\"2\"") and contains("FIRST DONE") and contains("FINDER DONE\n\nFinding for the other parts:\nFINDING: the shared API returns cents"))')"
  check "the finder's report completed the group and its result says the finding goes in the group's message" \
    "$(api "session/$finder/message" | jq -r '[.data[] | select(.type == "assistant") | .content[]? | select(.type == "tool" and .name == "courier_send") | .state] |
      length == 1 and (.[0] | .status == "completed" and ((.metadata.metadata // .metadata) | .finding == "held" and .held.group == "finding" and .held.reported == 2) and
        (tostring | contains("Its finding goes in that message, under your report")))')"
  check "no finding went ahead: the group's message is the parent's only courier message" \
    "$(api "session/$parent/message" | jq -r '[.data[] | select(.type == "synthetic") | .text] | length == 1 and (map(contains("finding=\"ahead\"")) | any | not)')"
}

run_finding_up() {
  scenario "a grandchild's finding reaches the root: its parent, told so by its brief, passes it up without a status"
  out=$(prompt "COURIER-RELAY-UP")
  turn_ended=$(now_ms)
  root=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  mid=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "the child's brief says to pass a finding from below up" \
    "$(has_text "$mid" "Do the same with one a session you started sends you, when it reaches past your own part." 10)"
  deep=$(for _ in $(seq 1 30); do
    found=$(texts "$mid" | sed -n 's/.*Started session \(ses_[A-Za-z0-9]*\) in .*/\1/p' | head -1)
    [ -n "$found" ] && { echo "$found"; break; }
    sleep 1
  done)
  check "the child started a grandchild" "$([ -n "$deep" ] && echo true || echo false)"
  heard=$(reply_time "$root" "ROOT HEARD FINDING" 45)
  check "the grandchild's finding reached the child without a status" \
    "$(api "session/$mid/message" | jq -r --arg deep "$deep" '[.data[] | select(.type == "synthetic") | .text |
      select(startswith("<courier from=\"" + $deep + "\">") and contains("FINDING-UP: the shared config is read-only"))] | length == 1')"
  check "the child passed it up, and it started a new turn of the root after its first had ended" \
    "$([ -n "$heard" ] && [ "$heard" -gt "$turn_ended" ] && echo true || echo false)"
  check "it reached the root once, without a status, naming the grandchild" \
    "$(api "session/$root/message" | jq -r --arg mid "$mid" --arg deep "$deep" '[.data[] | select(.type == "synthetic") | .text |
      select(startswith("<courier from=\"" + $mid + "\">") and contains("Passed up from " + $deep + ": FINDING-UP: the shared config is read-only"))] | length == 1')"
  check "and the child still reported to the root" "$([ -n "$(reply_time "$root" "ROOT GOT REPORT" 60)" ] && echo true || echo false)"
}

run_person_up() {
  scenario "text typed into a spawned session reaches every session above it from the plugin, and not once the tree has finished, though OpenCode reports each turn of the native grandchild to its parent"
  out=$(prompt "COURIER-RELAY-PERSON")
  root=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  mid=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  leaf=$(spawned_by "$mid")
  check "the child started a grandchild, a native one" "$([ -n "$leaf" ] && [ "$(session_info "$leaf" | jq -r '.parentID')" = "$mid" ] && echo true || echo false)"
  check "the grandchild ended a turn without a report, so the tree is at work" "$([ -n "$(reply_time "$leaf" "LEAF WAITS" 30)" ] && echo true || echo false)"
  check "the grandchild's brief says courier passes it up, and does not ask it to" \
    "$([ "$(has_text "$leaf" "Do not send it up yourself" 10)" = true ] && ! texts "$leaf" | grep -qF "the person's word" && echo true || echo false)"
  check "the grandchild's task prompt reached its inbox marked as courier's" \
    "$(jq -sr --arg leaf "$leaf" '[.[] | select(.type == "session.inbox.enqueued" and .sessionID == $leaf and .item.type == "user")] | first | .item.metadata.source == "courier" and .item.metadata.task == true' "$WORK/probe.log")"
  prompt_in "$leaf" "PERSON-SAYS: print the number, do not write a file" >/dev/null
  check "the root replied to the envelope" "$([ -n "$(reply_time "$root" "ROOT HEARD TYPED" 45)" ] && echo true || echo false)"
  check "the middle replied to the envelope" "$([ -n "$(reply_time "$mid" "RELAYER HEARD TYPED" 45)" ] && echo true || echo false)"
  for session in "$root" "$mid"; do
    check "$([ "$session" = "$root" ] && echo root || echo middle) holds exactly one envelope, naming the session and the route" \
      "$(api "session/$session/message" | jq -r --arg open "<courier from=\"courier\" route=\"prompt\" in=\"$leaf\">" '[.data[] | select(.type == "synthetic") | .text | select(startswith($open) and contains("PERSON-SAYS"))] | length == 1')"
  done
  check "the middle reported, once the grandchild had" "$([ -n "$(reply_time "$root" "ROOT GOT REPORT" 60)" ] && echo true || echo false)"
  check "the grandchild heard nothing from the middle" \
    "$(api "session/$leaf/message" | jq -r --arg mid "$mid" '[.data[] | select(.type == "synthetic") | .text | select(startswith("<courier from=\"" + $mid + "\""))] | length == 0')"
  turn_ended "$root"
  prompt_in "$leaf" "PERSON-LATE" >/dev/null
  check "text typed into the finished tree is logged as reaching nobody" "$(wait_log "courier fan-up: text typed into $leaf reached nobody: the tree has finished" 30)"
  check "and the root holds no envelope for it" "$(api "session/$root/message" | jq -r '[.data[] | select(.type == "synthetic") | .text | select(contains("PERSON-LATE"))] | length == 0')"
}

run_person_message() {
  scenario "a parent's message with a status to its child goes without the status, and the child's brief says courier passes the person's words up"
  out=$(prompt "COURIER-STATUS-DOWN")
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "the child's brief has the person's message sentence" \
    "$(has_text "$child" "Do not send it up yourself" 10)"
  check "the child's brief says how to wait for a wake-up from outside the tree" \
    "$(has_text "$child" "schedule yourself a check-in with courier_later, which shows you as waiting" 10)"
  check "courier_send dropped the status and said so" "$(tool_state courier_send <<<"$out" | jq -r '.status == "completed" and
    .metadata.metadata.dropped == "blocked" and (.metadata.metadata | has("status") | not) and (.output | contains("without the status blocked"))')"
  check "the child got the message without a status" \
    "$([ "$(has_text "$child" "<courier from=\"$parent\">" 30)" = true ] && ! texts "$child" | grep -qF "<courier from=\"$parent\" status=" && echo true || echo false)"
  check "the child heard it and reported, the tag it echoed escaped so the parent read one envelope" "$([ -n "$(reply_time "$parent" "PARENT WOKE" 60)" ] &&
    api "session/$parent/message" | jq -r --arg heard "HEARD &lt;courier from=\"$parent\"> STEER: undo it" \
      '[.data[] | select(.type == "synthetic") | .text | select(contains($heard)) | select([match("</?courier"; "g")] | length == 2)] | length == 1')"
}

run_permission() {
  for mode in shared isolate; do
    scenario "a child's permission request reaches its idle parent, and the answer goes back ($mode)"
    ask_permission "$([ "$mode" = isolate ] && echo isolate)"
    check "with what it asks for and the choices" "$(jq -r --arg child "$child" '.[0] // "" |
      contains("<courier from=\"" + $child + "\" asks=\"permission\"") and contains("It asks for: shell") and
      contains("echo courier-asks") and contains("- once:") and contains("- reject:") and contains("You cannot decide this") and (contains("- always") | not)' <<<"$notice")"
    check "courier_children shows the child waiting on it" \
      "$(prompt "COURIER-CHILDREN $parent" | tool_state courier_children | jq -r --arg request "$request" '.status == "completed" and (.output | contains($request))')"
    choice=$([ "$mode" = isolate ] && echo reject || echo once)
    answered=$(prompt_in "$parent" "COURIER-ANSWER $choice" | tool_state courier_answer)
    check "courier_answer passed on $choice" "$(jq -r '.status == "completed" and .metadata.metadata.answered == true' <<<"$answered")"
    check "the child carried on and reported back" "$([ -n "$(reply_time "$parent" "PARENT WOKE" 45)" ] && echo true || echo false)"
    report=$(api "session/$parent/message" | jq -r '[.data[] | select(.type == "synthetic") | .text | select(contains("CHILD DONE shell"))] | join("")')
    if [ "$mode" = isolate ]; then
      check "the child's command was refused" "$([[ $report == *'"error"'* && $report != *"exited with code"* ]] && echo true || echo false)"
    else
      check "the child's command ran" "$([[ $report == *"courier-asks"* && $report != *"Refused"* ]] && echo true || echo false)"
    fi
    check "the parent got no stale notice" "$(notices_with "$parent" answered | jq -r 'length == 0')"
  done

  scenario "a request answered in the child's own session leaves no stale question with the parent, and starts no turn of its own (#227)"
  ask_permission ""
  code=$(curl -s -o /dev/null -w '%{http_code}' -u "opencode:$OPENCODE_PASSWORD" -X POST -H 'content-type: application/json' \
    --data '{"decision":"once"}' "$SERVER/api/session/$child/permission/$request/reply")
  check "answered in the child's session" "$([ "$code" = 204 ] && echo true || echo false)"
  check "the child carried on and reported back" "$([ -n "$(reply_time "$parent" "PARENT WOKE" 45)" ] && echo true || echo false)"
  check "the parent was told it is settled, once, naming the request and the answer" \
    "$(notices_with "$parent" answered | jq -r --arg request "$request" 'length == 1 and (.[0] | contains("request=\"" + $request + "\"") and contains("answered=\"once\""))')"
  check "the root took it with the child's report, in the same turn" "$(settled_with_report "$parent" "$request")"
  check "and replied to the ask and the report only: two turns, not three" \
    "$(api "session/$parent/message" | jq -r '[.data[] | select(.type == "assistant") | [.content[]? | select(.type == "text") | .text] | join("") | select(test("PARENT (ASKS|WOKE|SETTLED)"))] | length == 2')"
  answered=$(prompt_in "$parent" "COURIER-ANSWER once" | tool_state courier_answer)
  check "a late courier_answer passes nothing on" \
    "$(jq -r '.status == "completed" and .metadata.metadata.answered == false and (.output | contains("is pending in this OpenCode server") and contains("another OpenCode server on the same data directory"))' <<<"$answered")"
}

run_depth() {
  scenario "a leaf at maxDepth does not see courier_spawn, and is refused when it calls it anyway"
  child_delay 1000
  out=$(prompt "COURIER-DEPTH")
  root=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  middle=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "the leaf without the tool was told it is not available" \
    "$(has_text "$middle" "Tool is not available for this request: courier_spawn" 60)"
  check "the leaf that called it anyway was refused by courier_spawn, naming maxDepth" \
    "$(has_text "$middle" "Not started: this session is at depth 2 of its session tree, and the tree goes at most 2 deep (maxDepth)" 60)"
  leaves=$(jq -sc '[.[] | select(.reply.args.task? == "CHILD-TOO-DEEP") | .session] | unique' "$WORK/model.log")
  check "two leaves tried" "$(jq -r 'length == 2' <<<"$leaves")"
  check "the root was told once that the child in between ended without a report, once its leaves had reported" \
    "$(has_text "$root" "PARENT TOLD SILENT" 60 >/dev/null; turn_ended "$middle"; end_handled "$middle" "$root" && notices_with "$root" ended | jq -r --arg middle "$middle" 'length == 1 and (.[0] | contains("<courier from=\"" + $middle + "\" ended="))' || echo false)"
  check "every request of a leaf was named a leaf, and the courier's hook left it no courier_spawn" \
    "$(jq -sr --argjson leaves "$leaves" '[.[] | select(.type == "probe.context" and (.sessionID | IN($leaves[])))]
      | length > 0 and all(.role == "leaf" and (.tools | index("courier_spawn") | not) and (.tools | index("courier_send")))' "$WORK/probe.log")"
  check "the model saw no courier_spawn in a leaf's tool list unless the probe put it back" \
    "$(jq -sr --argjson leaves "$leaves" '[.[] | select((.session | IN($leaves[])) and (.tools | length > 0))] | group_by(.session)
      | map(any(.tools | index("courier_spawn"))) | sort == [false, true]' "$WORK/model.log")"
  check "the child in between is a sub-orchestrator, with courier_spawn" \
    "$(jq -sr --arg middle "$middle" '[.[] | select(.session == $middle and (.tools | length > 0))] | length > 0 and all(.role == "sub-orchestrator" and (.tools | index("courier_spawn")))' "$WORK/model.log")"
  check "the root was pointed to the skill until it had started a child, then named root orchestrator" \
    "$(jq -sr --arg root "$root" '[.[] | select(.session == $root and (.tools | length > 0)) | .role] | index("root orchestrator") as $i
      | $i > 0 and (.[:$i] | all(. == "root")) and (.[$i:] | all(. == "root orchestrator"))' "$WORK/model.log")"
  check "a leaf that has reported reads as finished and owes no report, so it no longer counts against the limits" \
    "$(for _ in $(seq 1 30); do leaf=$(jq -r '.[0]' <<<"$leaves"); [ "$(finished "$leaf")" = true ] && [ "$(reported "$leaf")" = true ] && { echo true; exit; }; sleep 1; done; echo false)"
  leaf=$(jq -r '.[0]' <<<"$leaves")
  check "deleting the session in between forgets the report state of the leaf that reported to it" \
    "$([ -n "$(kv get "report/$leaf/settled")" ] &&
      [[ $(curl -s -o /dev/null -w '%{http_code}' -u "opencode:$OPENCODE_PASSWORD" -X DELETE "$SERVER/api/session/$middle") == 20* ]] &&
      for _ in $(seq 1 20); do [ -z "$(kv get "report/$leaf/prompt")$(kv get "report/$leaf/settled")" ] && { echo true; exit; }; sleep 1; done; echo false)"
}

entry_of() {
  api "experimental/session/$1/instructions/entries" | jq -r --arg key "$2" '(.data // .) | .[]? | select(.key == $key) | .value'
}
role_entry_of() {
  local value
  value=$(entry_of "$1" role)
  [ -n "$value" ] || echo "role_entry_of $1: no role entry in: $(api "experimental/session/$1/instructions/entries")" >&2
  printf '%s' "$value"
}
instruction_updates() { api "session/$1/message" | jq -c '[.data[] | select(.type == "system" and (.description | startswith("Instructions updated: "))) | .description]'; }
run_role_entry() {
  scenario "the role part rides in each spawned session's role entry, which a compaction keeps, and a root gets its own (#384)"
  child_delay 1000
  out=$(prompt "COURIER-ROLE")
  role_root=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  role_mid=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "the middle session's report woke the root" "$(has_text "$role_root" "ROOT WOKE" 90)"
  role_leaf=$(texts "$role_mid" | sed -n 's/.*Started session \(ses_[A-Za-z0-9]*\) in .*/\1/p' | head -1)
  check "the middle session started a leaf" "$([ -n "$role_leaf" ] && echo true || echo false)"
  check "each session's role entry names its role: root orchestrator, sub-orchestrator at depth 1, leaf at depth 2" \
    "$([[ $(role_entry_of "$role_root") == "opencode-courier role: root orchestrator"* &&
      $(role_entry_of "$role_mid") == "opencode-courier role: sub-orchestrator, at depth 1 of at most 2"* &&
      $(role_entry_of "$role_leaf") == "opencode-courier role: leaf, at depth 2"* ]] && echo true || echo false)"
  check "every request of the middle session and the leaf carried the role in the entry's block, none in a part of the hook's" \
    "$(jq -sr --arg mid "$role_mid" --arg leaf "$role_leaf" '[.[] | select((.session == $mid or .session == $leaf) and (.tools | length > 0))]
      | length >= 3 and all(.roleEntry and (.rolePart | not))' "$WORK/model.log")"
  check "every request of the leaf named it a leaf, without courier_spawn, and the hook saw the role too" \
    "$(jq -sr --arg leaf "$role_leaf" '[.[] | select(.session == $leaf and (.tools | length > 0))]
      | length > 0 and all(.role == "leaf" and (.tools | index("courier_spawn") | not) and (.tools | index("courier_send")))' "$WORK/model.log" |
      grep -qx true && jq -sr --arg leaf "$role_leaf" '[.[] | select(.type == "probe.context" and .sessionID == $leaf)] | length > 0 and all(.role == "leaf")' "$WORK/probe.log" | grep -qx true && echo true || echo false)"
  check "the root was pointed to the skill in a part of the hook's until it had started a child, then named root orchestrator by its entry alone" \
    "$(jq -sr --arg root "$role_root" '[.[] | select(.session == $root and (.tools | length > 0))] | (map(.role) | index("root orchestrator")) as $i
      | $i > 0 and (.[:$i] | all(.role == "root" and .rolePart and (.roleEntry | not))) and (.[$i:] | all(.role == "root orchestrator" and .roleEntry and (.rolePart | not)))' "$WORK/model.log")"
  echo "  instruction updates in the root's transcript: $(instruction_updates "$role_root")"
  check "the root's transcript shows its entries' arrival as system messages, Instructions updated: api/…, one naming the role" \
    "$(instruction_updates "$role_root" | jq -r 'length >= 1 and any(contains("api/role"))')"
  turn_ended "$role_leaf"
  api_post "session/$role_leaf/compact" '{}' >/dev/null
  check "the leaf's compaction completed" \
    "$(for _ in $(seq 1 60); do [ "$(api "session/$role_leaf/message" | jq -r '[.data[] | select(.type == "compaction" and .status == "completed")] | length > 0')" = true ] && { echo true; exit; }; sleep 1; done; echo false)"
  prompt_in "$role_leaf" "CHILD-ROLE-AGAIN" >/dev/null
  check "after the compaction the leaf still has its entry, and its request named it a leaf through the block, without courier_spawn" \
    "$([[ $(role_entry_of "$role_leaf") == "opencode-courier role: leaf"* ]] && jq -sr --arg leaf "$role_leaf" '[.[] | select(.session == $leaf and (.tools | length > 0))]
      | last | .role == "leaf" and .roleEntry and (.rolePart | not) and (.tools | index("courier_spawn") | not) and (.reply.text == "LEAF AGAIN")' "$WORK/model.log")"
}

fork_of() { api_post "session/$1/fork" '{}' | jq -r '(.data // .).id // empty'; }
system_hashes() { jq -sc --arg session "$1" '[.[] | select(.session == $session and (.tools | length > 0)) | .systemHash] | unique' "$WORK/model.log"; }
run_fork() {
  scenario "a fork of a session in a tree is told that courier did not start it, loses its role and standing entries and reports to no one (#602)"
  child_delay 1000
  out=$(prompt "COURIER-ROLE")
  fork_root=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  fork_mid=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "the middle session's report woke the root" "$(has_text "$fork_root" "ROOT WOKE" 90)"
  fork_leaf=$(texts "$fork_mid" | sed -n 's/.*Started session \(ses_[A-Za-z0-9]*\) in .*/\1/p' | head -1)
  turn_ended "$fork_root"
  turn_ended "$fork_mid"
  turn_ended "$fork_leaf"
  check "before the fork the middle session holds its role and standing entries, and the leaf its role" \
    "$([[ $(entry_of "$fork_mid" role) == "opencode-courier role: sub-orchestrator"* && $(entry_of "$fork_mid" standing) == "opencode-courier standing:"* &&
      $(entry_of "$fork_leaf" role) == "opencode-courier role: leaf"* ]] && echo true || echo false)"
  root_before=$(api "session/$fork_root/message" | jq -c '[.data[].id]')
  mid_before=$(api "session/$fork_mid/message" | jq -c '[.data[].id]')
  leaf_before=$(api "session/$fork_leaf/message" | jq -c '[.data[].id]')
  leaf_fork=$(fork_of "$fork_leaf")
  mid_fork=$(fork_of "$fork_mid")
  check "OpenCode forked the leaf and the middle session" "$([ -n "$leaf_fork" ] && [ -n "$mid_fork" ] && echo true || echo false)"
  check "the forks are copies: each names its original, and the leaf's fork carries the courier metadata of the leaf" \
    "$([ "$(session_info "$leaf_fork" | jq -r '.fork.sessionID')" = "$fork_leaf" ] && [ "$(session_info "$mid_fork" | jq -r '.fork.sessionID')" = "$fork_mid" ] &&
      [ "$(session_info "$leaf_fork" | jq -r '.metadata.courier.parentID')" = "$fork_mid" ] && echo true || echo false)"
  check "the leaf's fork holds no role entry and the middle session's fork neither role nor standing, while the originals keep theirs" \
    "$(for _ in $(seq 1 20); do
      [ -z "$(entry_of "$leaf_fork" role)$(entry_of "$mid_fork" role)$(entry_of "$mid_fork" standing)" ] &&
        [[ $(entry_of "$fork_leaf" role) == "opencode-courier role: leaf"* && $(entry_of "$fork_mid" role) == "opencode-courier role: sub-orchestrator"* &&
          $(entry_of "$fork_mid" standing) == "opencode-courier standing:"* ]] && { echo true; exit; }
      sleep 1
    done; echo false)"
  check "no fork has a roster entry" "$([ -z "$(indexed_under "$leaf_fork")$(indexed_under "$mid_fork")" ] && echo true || echo false)"
  prompt_in "$leaf_fork" "CHILD-ROLE-AGAIN" >/dev/null
  prompt_in "$mid_fork" "CHILD-ROLE-AGAIN" >/dev/null
  echo "  the leaf's fork was told: $(notices_with "$leaf_fork" notice)"
  echo "  OpenCode's own fork notices in the leaf's fork: $(api "session/$leaf_fork/message" | jq -r '[.data[] | select(.type == "synthetic" and (.text | startswith("<fork-notice>")))] | length')"
  check "the leaf's fork holds one courier fork notice, which names the leaf and tells it to send the leaf's parent nothing" \
    "$(notices_with "$leaf_fork" notice | jq -r --arg leaf "$fork_leaf" --arg mid "$fork_mid" 'length == 1 and (.[0] | startswith("<courier from=\"courier\" notice=\"fork\" of=\"" + $leaf + "\">") and
      contains("Courier did not start this fork.") and contains("send session " + $mid + " nothing with courier_send") and (contains("courier_children") | not))')"
  check "the middle session's fork holds one, which says the brief is the middle session's and its children report to it" \
    "$(notices_with "$mid_fork" notice | jq -r --arg mid "$fork_mid" --arg root "$fork_root" 'length == 1 and (.[0] | contains(" of=\"" + $mid + "\"") and
      contains("The brief above from session " + $root + " is the assignment of session " + $mid) and contains("are the children of session " + $mid))')"
  echo "  instruction updates in the forks: leaf $(instruction_updates "$leaf_fork"), middle $(instruction_updates "$mid_fork")"
  check "each fork's transcript gained one update for its removed entries, api/role for the leaf's and api/role, api/standing beside the copied ones for the middle session's" \
    "$([ "$(instruction_updates "$leaf_fork")" = '["Instructions updated: api/role"]' ] &&
      [ "$(instruction_updates "$mid_fork" | jq -r '[.[] | select(contains("api/role"))] == ["Instructions updated: api/role, api/standing"]')" = true ] &&
      [ "$(instruction_updates "$fork_mid" | jq -r 'any(contains("api/role")) | not')" = true ] && echo true || echo false)"
  echo "  system prompt hashes: leaf $(system_hashes "$fork_leaf"), its fork $(system_hashes "$leaf_fork"); middle $(system_hashes "$fork_mid"), its fork $(system_hashes "$mid_fork")"
  check "the leaf's fork answered as a top session: courier_spawn among its tools, no role part of the hook's, and the system prompt of the leaf byte for byte" \
    "$(jq -sr --arg fork "$leaf_fork" '[.[] | select(.session == $fork and (.tools | length > 0))] | length > 0 and
      all((.tools | index("courier_spawn")) and (.rolePart | not) and .roleEntry and .reply.text == "LEAF AGAIN")' "$WORK/model.log" | grep -qx true &&
      [ "$(system_hashes "$leaf_fork")" = "$(system_hashes "$fork_leaf")" ] && [ "$(system_hashes "$leaf_fork" | jq -r 'length')" = 1 ] && echo true || echo false)"
  check "the middle session's fork answered too, with no role part of the hook's" \
    "$(jq -sr --arg fork "$mid_fork" '[.[] | select(.session == $fork and (.tools | length > 0))] | length > 0 and all((.tools | index("courier_spawn")) and (.rolePart | not) and .reply.text == "LEAF AGAIN")' "$WORK/model.log")"
  turn_ended "$leaf_fork"
  turn_ended "$mid_fork"
  check "the root, the middle session and the leaf got nothing from the forks, and the forks called no tool, so sent nothing with courier_send" \
    "$([ "$(api "session/$fork_root/message" | jq -c '[.data[].id]')" = "$root_before" ] && [ "$(api "session/$fork_mid/message" | jq -c '[.data[].id]')" = "$mid_before" ] &&
      [ "$(api "session/$fork_leaf/message" | jq -c '[.data[].id]')" = "$leaf_before" ] &&
      [ "$(jq -sr --arg a "$leaf_fork" --arg b "$mid_fork" '[.[] | select((.session == $a or .session == $b) and .reply.tool != null)] | length' "$WORK/model.log")" = 0 ] && echo true || echo false)"
}

run_entries() {
  scenario "a parent carries the standing of the sessions it started in a standing entry, kept current, removed with its last child, and no lessons entry (#384)"
  child_delay 6000
  out=$(prompt "COURIER-GROUP")
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  members=$(tool_state courier_spawn <<<"$out" | jq -r 'select(.status == "completed") | .metadata.metadata.sessionID')
  first=$(head -1 <<<"$members")
  second=$(tail -1 <<<"$members")
  standing=$(entry_of "$parent" standing)
  check "once the spawns were done, the parent's standing listed both members working, their group waiting for them" \
    "$([[ $standing == "opencode-courier standing: "* && $standing == *"- $first \"Report back to your parent.\": working; group \"pair\" waits for it"* && $standing == *"- $second \"Report back to your parent.\": working; group \"pair\" waits for it"* ]] && echo true || echo false)"
  check "the parent's reply after the spawns was asked with the standing in an update, no look needed" \
    "$(jq -sr --arg parent "$parent" '[.[] | select(.session == $parent and (.tools | length > 0))] | length >= 2 and (.[1] | .standingEntry) and (.[0] | .standingEntry | not)' "$WORK/model.log")"
  check "the group's reports woke the parent" "$([ -n "$(reply_time "$parent" "PARENT GOT GROUP" 60)" ] && echo true || echo false)"
  check "then the standing read both as reported done, their group delivered" \
    "$(for _ in $(seq 1 15); do standing=$(entry_of "$parent" standing); [[ $standing == *"- $first \"Report back to your parent.\": reported done; group \"pair\" was delivered"* && $standing == *"- $second \"Report back to your parent.\": reported done; group \"pair\" was delivered"* ]] && { echo true; exit; }; sleep 1; done; echo false)"
  check "every announcement in the parent's transcript named the standing, and the woken request carried it" \
    "$(instruction_updates "$parent" | jq -r 'length >= 2 and all(contains("api/standing"))' | grep -qx true && jq -sr --arg parent "$parent" '[.[] | select(.session == $parent and (.tools | length > 0))] | last | .standingEntry' "$WORK/model.log")"
  check "the parent's announcements named its role and its standing, and none named lessons" \
    "$(instruction_updates "$parent" | jq -r '(join(" ") | contains("api/role") and contains("api/standing")) and all(contains("api/lessons") | not)')"
  cleaned=$(prompt_in "$parent" "COURIER-CLEANUP $first" | tool_state courier_cleanup)
  check "courier_cleanup dropped the first member, and the standing lists the second alone" \
    "$(jq -r '.status == "completed" and .metadata.metadata.outcome == "forgotten"' <<<"$cleaned" | grep -qx true && standing=$(entry_of "$parent" standing) && [[ $standing == *"- $second "* && $standing != *"- $first "* ]] && echo true || echo false)"
  prompt_in "$parent" "COURIER-CLEANUP $second" >/dev/null
  check "dropping the last one removed the standing entry" "$([ -z "$(entry_of "$parent" standing)" ] && [[ $(entry_of "$parent" role) == "opencode-courier role: root orchestrator"* ]] && echo true || echo false)"
  check "the parent and its children were given no lessons entry" "$(for id in "$parent" "$first" "$second"; do [ -z "$(entry_of "$id" lessons)" ] || { echo false; exit; }; done; echo true)"
  child_delay 0
}

run_spawn_model() {
  scenario "a child runs on the model and variant its parent names, and the roster says so (#359)"
  child_delay 1000
  out=$(prompt "COURIER-MODEL mock/other high")
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "courier_spawn completed, naming the model and variant in its result" \
    "$(tool_state courier_spawn <<<"$out" | jq -r '.status == "completed" and (.output | contains(", on mock/other#high."))')"
  check "the session was created on that model and variant" \
    "$(session_info "$child" | jq -r '.model.providerID == "mock" and .model.id == "other" and .model.variant == "high"')"
  check "the child reported back" "$([ -n "$(reply_time "$parent" "PARENT WOKE")" ] && echo true || echo false)"
  check "every reply of the child came from that model at that variant" \
    "$(api "session/$child/message" | jq -r '[.data[] | select(.type == "assistant") | .model] | length > 0 and all(.id == "other" and .variant == "high")')"
  check "and every request of the child asked the provider for that model with the variant's reasoning effort" \
    "$(jq -sr --arg child "$child" '[.[] | select(.session == $child)] | length > 0 and all(.options.model == "other" and .options.reasoning_effort == "high")' "$WORK/model.log")"
  check "the roster names the model, which the tree panel's row shows" "$(kv get "roster/$parent/$child" | jq -r '.model == "mock/other#high"')"
  check "courier_children lists it with the model" "$(prompt "COURIER-CHILDREN $parent" | tool_state courier_children |
    jq -r --arg child "$child" '.status == "completed" and any(.metadata.metadata.children[]; .sessionID == $child and .model == "mock/other#high")')"

  scenario "a variant alone applies to the parent's own model"
  child_delay 1000
  out=$(prompt "COURIER-MODEL - low")
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "the session was created on the parent's model at the variant" \
    "$(session_info "$child" | jq -r '.model.providerID == "mock" and .model.id == "chat" and .model.variant == "low"')"
  check "the child reported back" "$([ -n "$(reply_time "$parent" "PARENT WOKE")" ] && echo true || echo false)"
  check "its requests carried the variant's reasoning effort" \
    "$(jq -sr --arg child "$child" '[.[] | select(.session == $child)] | length > 0 and all(.options.model == "chat" and .options.reasoning_effort == "low")' "$WORK/model.log")"
  check "the roster names the parent's model with the variant" "$(kv get "roster/$parent/$child" | jq -r '.model == "mock/chat#low"')"
  out=$(prompt "COURIER-TEST")
  child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "a child on its parent's model and variant records none" \
    "$(tool_state courier_spawn <<<"$out" | jq -r '.status == "completed" and (.output | contains(", on ") | not) and (.metadata.metadata | has("model") | not)')"
  check "and is started on OpenCode's default, which its parent, started with no model of its own, runs on" \
    "$(session_info "$child" | jq -r '.model.providerID == "mock" and .model.id == "chat"')"

  scenario "a model OpenCode does not list, a variant the model has not, or a name that is not provider/model is refused, and nothing is started"
  child_delay 1000
  out=$(prompt "COURIER-MODEL mock/nope high")
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  check "an unknown model is refused, naming the provider's models" \
    "$(tool_state courier_spawn <<<"$out" | jq -r '.status == "error" and (.error | contains("lists no model mock/nope here") and contains("The models of mock here are chat, other"))')"
  check "an unknown variant is refused, naming the model's variants" \
    "$(prompt "COURIER-MODEL mock/other huge" | tool_state courier_spawn | jq -r '.status == "error" and (.error | contains("mock/other has no variant \"huge\"") and contains("Its variants are low, medium, high and default"))')"
  check "a name without a provider is refused, saying the form" \
    "$(prompt "COURIER-MODEL other -" | tool_state courier_spawn | jq -r '.status == "error" and (.error | contains("model must be provider/model"))')"
  check "no session was started under the parent" "$(prompt "COURIER-CHILDREN $parent" | tool_state courier_children | jq -r '.status == "completed" and (.metadata.metadata.children | length == 0)')"
}

run_answer() {
  scenario "a parent's courier_answer is held until the person answers OpenCode's prompt in the parent's session"
  ask_permission ""
  api_prompt "$parent" "COURIER-ANSWER once"
  own=$(own_request "$parent" "$request" 30)
  check "OpenCode asks the person in the parent's session, bound to the child's request and the courier_answer call"   "$([ -n "$own" ] && api "session/$parent/permission" | jq -r --arg own "$own" --arg child "$child" '.data[] | select(.id == $own) |
      .sessionID != $child and .action == "shell" and .resources == ["echo courier-asks"] and ((.save // []) | length == 0) and
      .metadata.from == $child and .source.type == "tool" and (.source.messageID | startswith("msg"))' || echo false)"
  check "the child's request still waits" "$(api "session/$child/permission" | jq -r --arg request "$request" '[.data[].id] | index($request) != null')"
  check "and courier_answer has not returned" "$(answer_state "$parent" | jq -r '.status == "running"')"
  check "the person allows it in the parent's prompt" "$([ "$(person "session/$parent/permission/$own/reply" '{"decision":"once"}')" = 204 ] && echo true || echo false)"
  check "courier_answer then passed once on" \
    "$(for _ in $(seq 1 30); do s=$(answer_state "$parent"); [ "$(jq -r '.status == "completed"' <<<"$s")" = true ] && { jq -r '.metadata.answered == true and ([.content[].text] | join("") | contains("Allowed in your session"))' <<<"$s"; exit; }; sleep 1; done; echo false)"
  check "the child's command ran, and it reported back" \
    "$(has_text "$parent" "CHILD DONE shell" 45 >/dev/null; api "session/$parent/message" | jq -r '[.data[] | select(.type == "synthetic") | .text | select(contains("CHILD DONE shell"))] | join("") | contains("courier-asks") and (contains("Refused") | not)')"
  check "the parent was told nothing about its own request" \
    "$([ "$(notices_with "$parent" answered | jq length)" = 0 ] && [ "$(notices_with "$parent" asks | jq length)" = 1 ] && echo true || echo false)"

  scenario "the person refuses the parent's prompt with a reason: courier_answer fails with it, and the child's request is refused with the same reason"
  ask_permission ""
  api_prompt "$parent" "COURIER-ANSWER once"
  own=$(own_request "$parent" "$request" 30)
  check "the person rejects it in the parent's prompt, with a reason" \
    "$([ -n "$own" ] && [ "$(person "session/$parent/permission/$own/reply" '{"decision":"reject","message":"Not here"}')" = 204 ] && echo true || echo false)"
  check "courier_answer failed with the reason, and the parent carried on" \
    "$(has_text "$parent" "TOOL DONE courier_answer" 45 >/dev/null; answer_state "$parent" | jq -r '.status == "error" and (.error.message | contains("not allowed in your session (Not here)") and contains("passed on with that reason"))')"
  check "and the parent's model read the reason in courier_answer's result" \
    "$(api "session/$parent/message" | jq -r '[.data[] | select(.type == "assistant") | .content[]? | .text? // empty |
      select(startswith("TOOL DONE courier_answer"))] | any(contains("not allowed in your session (Not here)"))')"
  check "the child's call was refused with it, and the child carried on and reported back" \
    "$(has_text "$parent" "CHILD DONE shell" 45 >/dev/null; report=$(api "session/$parent/message" | jq -r '[.data[] | select(.type == "synthetic") | .text | select(contains("CHILD DONE shell"))] | join("")');
      [[ $report == *'"error"'* && $report != *"exited with code"* ]] && echo true || echo false)"
  check "the request is settled in the child's session" "$(api "session/$child/permission" | jq -r --arg request "$request" '[.data[].id] | index($request) == null')"
  check "and the parent was told nothing stale" "$([ "$(notices_with "$parent" answered | jq length)" = 0 ] && echo true || echo false)"

  scenario "a plain rejection of the parent's prompt ends the parent's step, and the child's request waits on"
  ask_permission ""
  api_prompt "$parent" "COURIER-ANSWER once"
  own=$(own_request "$parent" "$request" 30)
  check "the person rejects it in the parent's prompt, without a reason" \
    "$([ -n "$own" ] && [ "$(person "session/$parent/permission/$own/reply" '{"decision":"reject"}')" = 204 ] && echo true || echo false)"
  check "the parent's call ended on the decline, as its own tool call would" \
    "$(for _ in $(seq 1 30); do [ "$(answer_state "$parent" | jq -r '.status == "error"')" = true ] && break; sleep 1; done
      answer_state "$parent" | jq -r '.status == "error" and .error.type == "aborted" and (.error.message | contains("declined"))')"
  check "the child's request still waits" "$(api "session/$child/permission" | jq -r --arg request "$request" '[.data[].id] | index($request) != null')"
  check "the person answers it in the child's session, and the child carries on" \
    "$([ "$(person "session/$child/permission/$request/reply" '{"decision":"once"}')" = 204 ] && [ "$(has_text "$parent" "CHILD DONE shell" 45)" = true ] && echo true || echo false)"
  check "which the parent was told once, and its model got no courier_answer result meanwhile" \
    "$(reply_time "$parent" "PARENT WOKE" 45 >/dev/null; [ "$(notices_with "$parent" answered | jq -r 'length == 1 and (.[0] | contains("answered=\"once\""))')" = true ] &&
      ! texts "$parent" | grep -qF "TOOL DONE courier_answer" && echo true || echo false)"
}

run_search() {
  scenario "a child's web search asks for a provider with a form: the parent is told, and told when it is answered"
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
}

run_questions() {
  scenario "a child's question reaches its idle parent, which asks the person; their choice goes back"
  ask_question COURIER-QUESTION
  notice=$(notices_with "$parent" asks)
  check "the parent was told once, with the question and its options" "$(jq -r --arg child "$child" 'length == 1 and (.[0] |
    contains("<courier from=\"" + $child + "\" asks=\"question\" request=\"question_") and contains("Which greeting?") and
    contains("{\"questions\":[{\"question\":\"Which greeting?\",\"header\":\"Greeting\"") and contains("Do not answer it yourself"))' <<<"$notice")"
  check "the parent asks exactly what the child asks" "$([ "$(fields_of "$parent")" = "$(fields_of "$child")" ] && echo true || echo false)"
  request=$(jq -r '.[0] | capture("request=\"(?<id>[^\"]+)\"").id' <<<"$notice")
  check "courier_children shows the child waiting on it" "$(prompt "COURIER-CHILDREN $parent" | tool_state courier_children |
    jq -r --arg request "$request" '.status == "completed" and (.output | contains($request) and contains("\"type\": \"question\""))')"
  check "the person answers in the parent's session" "$(answer_form "$parent" "$parent_form" '"Hi"')"
  check "the parent's question passed the answer on, without courier_answer" "$(has_text "$parent" "do not call courier_answer")"
  check "the child carried on with it and reported back" "$(has_text "$parent" 'CHILD GOT [["Hi"]]' 45)"
  check "the child's question is no longer shown" "$([ "$(forms_of "$child")" = 0 ] && echo true || echo false)"

  scenario "a multi-select question"
  ask_question COURIER-QUESTION-MULTI
  check "the parent asks it as one too" "$(fields_of "$parent" | jq -r '.[0].type == "multiselect"')"
  check "the person picks two in the parent's session" "$(answer_form "$parent" "$parent_form" '["Hello","Hey"]')"
  check "the child got both" "$(has_text "$parent" 'CHILD GOT [["Hello","Hey"]]' 45)"

  scenario "an isolated child's question, answered with the person's own text"
  ask_question "COURIER-QUESTION isolate"
  check "the person types an answer in the parent's session" "$(answer_form "$parent" "$parent_form" '"Something else"')"
  check "the child got it" "$(has_text "$parent" 'CHILD GOT [["Something else"]]' 45)"
  check "the child's question is no longer shown" "$([ "$(forms_of "$child")" = 0 ] && echo true || echo false)"

  scenario "a parent that relabels the options passes the answer on with courier_answer"
  ask_question COURIER-QUESTION-RELABEL
  check "the person answers the parent's reworded question" "$(answer_form "$parent" "$parent_form" '"hi"')"
  check "courier_answer passed it on" "$(has_text "$parent" "Passed the answers to question")"
  check "the child got it" "$(has_text "$parent" 'CHILD GOT [["hi"]]' 45)"
  check "the child's question is no longer shown" "$([ "$(forms_of "$child")" = 0 ] && echo true || echo false)"

  scenario "a parent that rewords the question is not linked, is told so, and passes the answer on with courier_answer"
  ask_question COURIER-QUESTION-REWORD
  check "the person answers the parent's reworded question" "$(answer_form "$parent" "$parent_form" '"Hey"')"
  check "the parent's question said it was not passed on" "$(has_text "$parent" "these answers were not passed on by themselves")"
  check "courier_answer passed it on" "$(has_text "$parent" "Passed the answers to question")"
  check "the child got it" "$(has_text "$parent" 'CHILD GOT [["Hey"]]' 45)"

  scenario "the person answers in the child's session instead"
  ask_question COURIER-QUESTION
  check "the person answers in the child's session" "$(answer_form "$child" "$child_form" '"Hey"')"
  check "the parent's question is withdrawn" "$(has_text "$parent" "Session $child no longer waits on this question: it was answered in its own session")"
  check "and no longer shown" "$([ "$(forms_of "$parent")" = 0 ] && echo true || echo false)"
  check "the child carried on with the answer" "$(has_text "$parent" 'CHILD GOT [["Hey"]]' 45)"

}

run_questions_more() {
  scenario "the person dismisses the question in the child's session"
  ask_question COURIER-QUESTION
  check "dismissed in the child's session" "$([ "$(dismiss_form "$child" "$child_form")" = 204 ] && echo true || echo false)"
  check "the parent's question is withdrawn, saying so" "$(has_text "$parent" "dismissed in its own session, which ends its turn")"
  check "and no longer shown" "$([ "$(forms_of "$parent")" = 0 ] && echo true || echo false)"

  scenario "the person dismisses the question in the parent's session"
  ask_question COURIER-QUESTION
  check "dismissed in the parent's session" "$([ "$(dismiss_form "$parent" "$parent_form")" = 204 ] && echo true || echo false)"
  check "the child was told, carried on and reported" "$(has_text "$parent" "CHILD DISMISSED" 45)"
  check "the child's question is no longer shown" "$([ "$(forms_of "$child")" = 0 ] && echo true || echo false)"

  scenario "the parent asks again while its dismissal is held: the new question is withdrawn, and the child carries on without the answers"
  ask_question COURIER-QUESTION
  check "dismissed in the parent's session" "$([ "$(dismiss_form "$parent" "$parent_form")" = 204 ] && echo true || echo false)"
  check "the parent is prompted to ask again" "$([[ $(person "session/$parent/prompt" '{"text":"COURIER-ASK-AGAIN"}') == 20* ]] && echo true || echo false)"
  check "the parent's new question was withdrawn, saying the child carries on without the answers" \
    "$(has_text "$parent" "already dismissed in your session, so it carries on without the answers" 45)"
  check "and no longer shown" "$([ "$(forms_of "$parent")" = 0 ] && echo true || echo false)"
  check "the child was told, carried on and reported" "$(has_text "$parent" "CHILD DISMISSED" 45)"

  scenario "the parent asks the person and calls courier_answer in one step: its question is withdrawn, and the courier_answer pick counts"
  out=$(prompt "COURIER-QUESTION-BOTH")
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "the child asks, and the parent is told" "$(has_text "$parent" 'asks="question"' 45)"
  check "the parent's question was withdrawn, naming the answers courier_answer passed on" \
    "$(has_text "$parent" 'already answered with courier_answer (User has answered your questions: "Which greeting?"="Hi"' 45)"
  check "courier_answer passed it on" "$(has_text "$parent" "Passed the answers to question")"
  check "the parent's form is gone, unanswered" "$([ "$(forms_of "$parent")" = 0 ] && echo true || echo false)"
  check "the child carried on with the courier_answer pick" "$(has_text "$parent" 'CHILD GOT [["Hi"]]' 45)"
  check "the child's question is no longer shown" "$([ "$(forms_of "$child")" = 0 ] && echo true || echo false)"

  scenario "the child's turn is stopped while the parent asks the person; their answer reaches it as a message"
  ask_question COURIER-QUESTION
  check "the child's turn is interrupted" "$([[ $(person "session/$child/interrupt") == 20* ]] && echo true || echo false)"
  check "the child's question is no longer shown" "$(for _ in $(seq 1 15); do [ "$(forms_of "$child")" = 0 ] && { echo true; exit; }; sleep 1; done; echo false)"
  check "the person answers in the parent's session" "$(answer_form "$parent" "$parent_form" '"Hello"')"
  check "the parent's question passed it on as a message" "$(has_text "$parent" "as a message, since its question had been cut off")"
  check "which woke the child, and it carried on" "$(has_text "$parent" 'CHILD GOT [["Hello"]]' 45)"

  scenario "both turns are stopped while the question is open; the parent is told and asks again"
  ask_question COURIER-QUESTION
  person "session/$child/interrupt" >/dev/null
  person "session/$parent/interrupt" >/dev/null
  check "the parent was told the question was cut off" "$(has_text "$parent" 'stopped="true"' 45)"
  again=$(form_of "$parent" "$parent_form" 45)
  check "and asks the person again" "$([ -n "$again" ] && echo true || echo false)"
  check "the person answers" "$(answer_form "$parent" "$again" '"Hi"')"
  check "the child woke with the answer and carried on" "$(has_text "$parent" 'CHILD GOT [["Hi"]]' 45)"

  scenario "a question of a child's child goes to the session at the top"
  out=$(prompt "COURIER-QUESTION nested")
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  middle=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  parent_form=$(form_of "$parent" "" 60)
  check "the parent at the top asks the person" "$([ -n "$parent_form" ] && echo true || echo false)"
  check "its notice names the session in between" "$(notices_with "$parent" asks | jq -r --arg middle "$middle" '.[0] // "" | contains("which " + $middle + " started with courier_spawn")')"
  check "the person answers in the top session" "$(answer_form "$parent" "$parent_form" '"Hey"')"
  check "the child's child got it and reported to the session in between" "$(has_text "$middle" 'CHILD GOT [["Hey"]]' 45)"
}

run_restart_question() {
  scenario "a question open across a server restart"
  ask_question COURIER-QUESTION
  stop_server
  start_server
  api "plugin?directory=$(node -p 'encodeURIComponent(process.argv[1])' "$WORK/project")" >/dev/null
  check "the parent was told the question was cut off" "$(has_text "$parent" 'restarted="true"' 60)"
  again=$(form_of "$parent" "$parent_form" 45)
  check "and asks the person again" "$([ -n "$again" ] && echo true || echo false)"
  check "the person answers" "$(answer_form "$parent" "$again" '"Hello"')"
  check "the child woke with the answer and carried on" "$(has_text "$parent" 'CHILD GOT [["Hello"]]' 45)"
}

run_probe() {
  scenario "an isolated child's events reach the plugin instance of every location"
  child_delay 1000
  canonical() { node -p 'require("node:fs").realpathSync(process.argv[1])' "$1"; }
  [ -n "$(git -C "$WORK/project" worktree list --porcelain | sed -n 's/^worktree //p' | sed -n 2p)" ] || spawn_isolated
  bystander=$(git -C "$WORK/project" worktree list --porcelain | sed -n 's/^worktree //p' | sed -n 2p)
  check "a third location is open" "$([ -n "$bystander" ] &&
    bounded_run "$bystander" "hello" >/dev/null && echo true || echo false)"
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
  delivered() {
    jq -r --argjson types "$probe_types" --argjson instances "$instances" \
      '. as $delivery | all($types[]; ($delivery[.] // []) | length > 0 and all(. == $instances))' <<<"$delivery"
  }
  for _ in $(seq 1 30); do read_probe; [ "$(delivered)" = true ] && break; sleep 1; done
  short() { sed "s|$(canonical "$WORK/project")|parent|g; s|$(canonical "$worktree")|child|g; ${bystander:+s|$(canonical "$bystander")|bystander|g;} s|$(canonical "$WORK")/||g"; }
  echo "  instances: $(short <<<"$instances")"
  for type in $(jq -r '.[]' <<<"$probe_types"); do
    echo "  $type, each event seen by: $(jq -c --arg type "$type" '.[$type] // []' <<<"$delivery" | short)"
    check "every instance saw each of the child's $type events once" \
      "$(jq -r --arg type "$type" --argjson instances "$instances" '(.[$type] // []) | length > 0 and all(. == $instances)' <<<"$delivery")"
  done

  scenario "the courier's instances follow only the event types its modules handle"
  check "the courier subscribes with its modules' types through every hub subscription" \
    "$(grep -qF "courier watch: following $(jq -r 'join(", ")' <<<"$COURIER_TYPES") through " "$WORK/server.log" &&
      ! grep -qF "courier watch: following every event" "$WORK/server.log" && echo true || echo false)"
  probed=$(jq -sc --arg child "$child" '(map(select(.sessionID == $child)) | first | .pid) as $pid | map(select(.pid == $pid and .sessionID == $child))' "$WORK/probe.log")
  echo "  unfiltered, the child's event types: $(jq -c 'map(select(.id != null and (.type | startswith("probe.") | not)) | .type) | unique' <<<"$probed")"
  check "the unfiltered subscription got the child's streamed step and tool events" \
    "$(jq -r 'map(.type) | any(startswith("session.step.")) and any(startswith("session.tool."))' <<<"$probed")"
  check "the filtered one got none of them, only the courier's types" \
    "$(jq -r --argjson types "$COURIER_TYPES" 'map(select(.type == "probe.filtered") | .event) | length > 0 and all(IN($types[]))' <<<"$probed")"
  check "and every event of those types the unfiltered one got, in the same location" \
    "$(jq -r --argjson types "$COURIER_TYPES" '
      (map(select(.type == "probe.filtered") | [.location, .id]) | unique) as $filtered
      | map(select(.type as $type | $types | index($type)) | [.location, .id]) | unique | all(IN($filtered[]))' <<<"$probed")"

  scenario "after OpenCode reloads every location, a child's permission request still reaches its parent once"
  check "every location reloads" "$([ "$(person location/reload)" = 204 ] && echo true || echo false)"
  ask_permission isolate
  answered=$(prompt_in "$parent" "COURIER-ANSWER once" | tool_state courier_answer)
  check "courier_answer passed it on" "$(jq -r '.status == "completed" and .metadata.metadata.answered == true' <<<"$answered")"
  check "the child carried on and reported back" "$([ -n "$(reply_time "$parent" "PARENT WOKE" 45)" ] && echo true || echo false)"
}

run_skill() {
  scenario "the courier-orchestrate skill is listed in a session with the plugin loaded, and its text reaches the model"
  out=$(prompt "COURIER-SKILL")
  session=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  check "OpenCode lists it for the project, with its description" \
    "$(api "skill?directory=$(node -p 'encodeURIComponent(process.argv[1])' "$WORK/project")" | jq -r '[.data[] | select(.id == "courier-orchestrate")] |
      length == 1 and (.[0].name == "courier-orchestrate") and (.[0].description | contains("courier_spawn"))')"
  check "every request of the session listed it among the available skills" \
    "$(jq -sr --arg session "$session" '[.[] | select(.session == $session and (.tools | length > 0))] | length > 0 and all(.skills | index("courier-orchestrate"))' "$WORK/model.log")"
  check "the model loaded it with the skill tool and got the tools' mechanics" \
    "$(tool_state skill <<<"$out" | jq -r '.status == "completed" and (.output | tojson | contains("Below the root, never start one session for the whole task") and contains("or, at the root only, `split: 1 part:") and contains("Open the files and run the project'"'"'s checks yourself") and contains("If courier_spawn is not among your tools, you cannot split") and contains("never answer for the person") and contains("are not in this skill: if a skill for them is listed to you, load it too") and (contains("verifier") | not))')"
  check "attached to the person's prompt, its text reached the model" \
    "$([[ $(person "session/$session/prompt" '{"text":"COURIER-SKILL-ATTACHED","skills":[{"id":"courier-orchestrate"}]}') == 20* ]] && has_text "$session" "SKILL SEEN" 30)"
  out=$(prompt "COURIER-SKILL-READ")
  check "the skill tool named skill://courier-orchestrate as the skill's base directory" \
    "$(tool_state skill <<<"$out" | jq -r '.status == "completed" and (.output | contains("Base directory for this skill: skill://courier-orchestrate\n"))')"
  check "a read of skill://courier-orchestrate/SKILL.md, the directory it was told about, served the skill's text" \
    "$(tool_state read <<<"$out" | jq -r '.status == "completed" and (.input.path == "skill://courier-orchestrate/SKILL.md") and (.output | contains("Below the root, never start one session for the whole task"))')"

  scenario "a config that still sets the memory option loads, logs one line for it, and offers no memory tool and no lessons entry"
  check "the server log has the line for the memory option, and no line reading the option as a setting" \
    "$(grep -qF -- "courier: the memory option is not read: memory was removed in 0.17.0. Remove it from the config." "$WORK/server.log" && ! grep -qF "memory must be true or false" "$WORK/server.log" && echo true || echo false)"
  check "no request of this run offered courier_recall or courier_note, or carried a lessons block" \
    "$(jq -sr '[.[] | select(.tools | length > 0)] | length > 0 and all((.tools | index("courier_recall") | not) and (.tools | index("courier_note") | not) and (.lessonsEntry | not))' "$WORK/model.log")"
}

run_wake() {
  scenario "a courier message left waiting in an idle session, its wake missed, is sent again under its inbox id and wakes it (#218)"
  out=$(prompt "COURIER-TEST")
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  check "the child's report woke the parent" "$(has_text "$parent" "PARENT WOKE" 45)"
  turn_ended "$parent" >/dev/null
  inbox=$(api_post "session/$parent/synthetic" \
    '{"text":"<courier from=\"ses_e2e\">WAKE AGAIN</courier>","description":"Message from ses_e2e","metadata":{"source":"courier","from":"ses_e2e"},"delivery":"steer","resume":false}' |
    jq -r '.data.id // empty')
  check "a courier message was enqueued for the idle parent ($inbox)" "$([ -n "$inbox" ] && echo true || echo false)"
  delivered() { api "session/$parent/message" | jq -r --arg id "$inbox" '[.data[] | select(.id == $id)] | length'; }
  for _ in $(seq 1 20); do [ -n "$(kv get "wake/$parent/$inbox")" ] && break; sleep 0.5; done
  check "the courier watches it, waiting in an idle session" "$(kv get "wake/$parent/$inbox" | jq -r '.running == false')"
  check "no turn took it: it waits in the parent's inbox" \
    "$([ "$(delivered)" = 0 ] && [ "$(finished "$parent")" = true ] && api "session/$parent/inbox" | jq -e --arg id "$inbox" 'any(.data[]; .id == $id)' >/dev/null && echo true || echo false)"
  for _ in $(seq 1 75); do [ "$(delivered)" = 1 ] && break; sleep 1; done
  check "the scheduler woke the parent again, which took the message once" "$([ "$(delivered)" = 1 ] && echo true || echo false)"
  check "and replied to it in a new turn" \
    "$(for _ in $(seq 1 30); do [ "$(texts "$parent" | grep -cF "PARENT WOKE")" -ge 2 ] && { echo true; exit; }; sleep 1; done; echo false)"
  check "the server log says it was woken again" "$(grep -qF "courier wake: $parent left message $inbox waiting while idle; woken again" "$WORK/server.log" && echo true || echo false)"
  check "and the watch is over" "$(for _ in $(seq 1 10); do [ -z "$(kv get "wake/$parent/$inbox")" ] && { echo true; exit; }; sleep 1; done; echo false)"
}

run_later() {
  scenario "courier_later wakes the idle parent, with the delay sent as a string as some models do"
  out=$(prompt "COURIER-LATER-STRING 0.05")
  turn_ended=$(now_ms)
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  check "courier_later completed" "$(tool_state courier_later <<<"$out" | jq -r '.status == "completed"')"
  woke=$(reply_time "$parent" "PARENT WOKE" 45)
  check "the scheduled message started a new turn after the parent's had ended" \
    "$([ -n "$woke" ] && [ "$woke" -gt "$turn_ended" ] && echo true || echo false)"

  scenario "courier_cancel stops a scheduled message"
  out=$(prompt "COURIER-LATER-CANCEL 0.05")
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  scheduled=$(tool_state courier_later <<<"$out" | jq -r '.metadata.metadata.id // empty')
  check "courier_cancel cancelled it" "$(tool_state courier_cancel <<<"$out" | jq -r '.status == "completed" and (.output | startswith("Cancelled"))')"
  witness=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$(prompt "COURIER-LATER 0.05")" | head -1)
  check "an uncancelled message, scheduled next, was delivered at the tick" "$([ -n "$(reply_time "$witness" "PARENT WOKE" 45)" ] && echo true || echo false)"
  check "the cancelled message never arrived" \
    "$([ -n "$scheduled" ] && [ -z "$(kv get "later/$scheduled")" ] && [ "$(notices_with "$parent" scheduled)" = '[]' ] &&
      api "session/$parent/inbox" | jq -e '.data | length == 0' >/dev/null && echo true || echo false)"
}

run_schedules() {
  scenario "with experimental.schedules on, a spawned session is not offered OpenCode's schedule tools, and its root is"
  child_delay 1000
  stop_server
  jq '.experimental.schedules = true' "$WORK/project/opencode.json" >"$WORK/project/opencode.json.new"
  mv "$WORK/project/opencode.json.new" "$WORK/project/opencode.json"
  git -C "$WORK/project" -c user.email=e2e@example.com -c user.name=e2e commit -qam "schedules on"
  start_server
  out=$(prompt "COURIER-TEST")
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "the child reported back, waking the parent" "$([ -n "$(reply_time "$parent" "PARENT WOKE" 45)" ] && echo true || echo false)"
  check "the child's session carries the courier's rule denying them" \
    "$(session_info "$child" | jq -r '.permissions == [{ "action": "opencode_schedule_*", "resource": "*", "effect": "deny" }]')"
  check "the root was offered them" \
    "$(jq -sr --arg parent "$parent" --arg child "$child" '
      ([.[] | select(.session == $child) | .opencodeTools] | max) as $below
      | any(.[]; .session == $parent and (.schedules or ($below >= 0 and .opencodeTools > $below)))' "$WORK/model.log")"
  check "no request of the child offered them" \
    "$(jq -sr --arg parent "$parent" --arg child "$child" '
      ([.[] | select(.session == $parent) | .opencodeTools] | max) as $above
      | [.[] | select(.session == $child and (.tools | length > 0))]
      | length > 0 and all((.schedules | not) and ($above < 0 or .opencodeTools < $above))' "$WORK/model.log")"
  stop_server
  jq 'del(.experimental)' "$WORK/project/opencode.json" >"$WORK/project/opencode.json.new"
  mv "$WORK/project/opencode.json.new" "$WORK/project/opencode.json"
  git -C "$WORK/project" -c user.email=e2e@example.com -c user.name=e2e commit -qam "schedules off"
  start_server
}

run_roster() {
  scenario "courier_children lists the sessions a parent spawned"
  child_delay 1000
  out=$(prompt "COURIER-ROSTER")
  roster_parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  spawned=$(tool_state courier_spawn <<<"$out" | jq -r 'select(.status == "completed") | .metadata.metadata.sessionID')
  check "spawned two children" "$([ "$(wc -w <<<"$spawned")" -eq 2 ] && echo true || echo false)"
  listed=$(tool_state courier_children <<<"$out" | jq -r 'select(.status == "completed") | .output')
  check "courier_children lists both" "$(for id in $spawned; do grep -q "$id" <<<"$listed" || { echo false; exit; }; done; echo true)"
  check "the parent was woken by its children" "$([ -n "$(reply_time "$roster_parent" "PARENT WOKE")" ] && echo true || echo false)"
  check "each child is indexed under its parent" \
    "$(for id in $spawned; do [ "$(indexed_under "$id")" = "$roster_parent" ] || { echo false; exit; }; done; echo true)"

  scenario "a scheduled message survives a server restart, delivered once another server's owner key expires"
  out=$(prompt "COURIER-LATER 0.25")
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  check "courier_later completed" "$(tool_state courier_later <<<"$out" | jq -r '.status == "completed"')"
  check "the scheduler holds the owner key" "$(kv get scheduler/owner | jq -r '(.server | type) == "string" and (.at | type) == "number"')"
  stop_server
  check "and gave it back as the server stopped" "$([ -z "$(kv get scheduler/owner)" ] && echo true || echo false)"
  expires=$(($(now_ms) + 20000))
  kv set scheduler/owner "{\"server\":\"another server\",\"at\":$((expires - 60000))}" "roster-by-child/$(tail -1 <<<"$spawned")"
  unindexed=$(head -1 <<<"$spawned")
  kv remove "roster-by-child/$unindexed"
  check "one child's reverse key is removed, as if an older version had recorded it" \
    "$([ -z "$(indexed_under "$unindexed")" ] && echo true || echo false)"
  orphan=ses_orphaned_report_sweep
  kv set "report/$orphan/prompt" '{"at":1}' "roster-by-child/$(tail -1 <<<"$spawned")"
  kv set "report/$orphan/settled" '{"at":1,"by":"report"}' "roster-by-child/$(tail -1 <<<"$spawned")"
  check "report state is written for a session with no roster entry" "$([ -n "$(kv get "report/$orphan/prompt")" ] && echo true || echo false)"
  start_server
  restarted=$(now_ms)
  api "plugin?directory=$(node -p 'encodeURIComponent(process.argv[1])' "$WORK/project")" >/dev/null
  woke=$(reply_time "$parent" "PARENT WOKE" 60)
  check "it was delivered after the restart" "$([ -n "$woke" ] && [ "$woke" -gt "$restarted" ] && echo true || echo false)"
  check "only once the other server's key had expired" "$([ -n "$woke" ] && [ "$woke" -ge "$expires" ] && echo true || echo false)"
  check "and this server holds the key now" "$(kv get scheduler/owner | jq -r '.server != "another server"')"

  scenario "the roster survives a restart and can be read from another session"
  out=$(prompt "COURIER-CHILDREN $roster_parent")
  listed=$(tool_state courier_children <<<"$out" | jq -c 'select(.status == "completed") | .metadata.metadata.children')
  check "lists both children" "$(jq -r --arg ids "$spawned" '[.[].sessionID] | sort == ($ids | split("\n") | sort)' <<<"$listed")"
  check "with each child's last reply" "$(jq -r 'all((.lastText // "") | contains("TOOL DONE courier_send"))' <<<"$listed")"
  check "the entry written without a reverse key got one when the plugin loaded" \
    "$(for _ in $(seq 1 10); do [ "$(indexed_under "$unindexed")" = "$roster_parent" ] && { echo true; exit; }; sleep 1; done; echo false)"

  check "report state with no roster entry was swept when the plugin loaded" \
    "$(for _ in $(seq 1 10); do [ -z "$(kv get "report/$orphan/prompt")$(kv get "report/$orphan/settled")" ] && { echo true; exit; }; sleep 1; done; echo false)"
  check "while a live child's report state was kept" \
    "$(for id in $spawned; do [ -n "$(kv get "report/$id/prompt")" ] || { echo false; exit; }; done; echo true)"
}

run_webhook() {
  scenario "a webhook option left from an older release is ignored: no receiver listens"
  check "the plugin loaded" "$(grep -qF "courier watch: following" "$WORK/server.log" && echo true || echo false)"
  check "nothing listens on the old receiver's port" \
    "$(curl -s -o /dev/null -X POST --max-time 2 "http://127.0.0.1:$WEBHOOK_PORT/github" && echo false || echo true)"
}

run_cleanup() {
  scenario "courier_cleanup removes a clean worktree"
  child_delay 1000
  spawn_isolated
  check "its worktree exists" "$([ -d "$directory" ] && echo true || echo false)"
  check "it is indexed under its parent" "$([ "$(indexed_under "$child")" = "$parent" ] && echo true || echo false)"
  cleaned=$(prompt_in "$parent" "COURIER-CLEANUP $child" | tool_state courier_cleanup)
  check "courier_cleanup removed it" "$(jq -r '.status == "completed" and .metadata.metadata.outcome == "removed"' <<<"$cleaned")"
  check "the worktree directory is gone" "$([ ! -e "$directory" ] && echo true || echo false)"
  check "its reverse key is gone too" "$([ -z "$(kv get "roster-by-child/$child")" ] && echo true || echo false)"
  check "git no longer lists the worktree" "$(git -C "$WORK/project" worktree list | grep -qF "$directory" && echo false || echo true)"
  check "the child is off courier_children" "$([ "$(child_listing "$parent" "$child")" = unlisted ] && echo true || echo false)"

  scenario "courier_cleanup keeps a worktree with uncommitted changes"
  child_delay 1000
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
}

run_dirty_root() {
  scenario "a root with uncommitted changes is warned that its isolated child does not see them (#461)"
  child_delay 1000
  echo "not committed" >"$WORK/project/dirty-root.txt"
  out=$(prompt "COURIER-TEST isolate")
  rm -f "$WORK/project/dirty-root.txt"
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  spawned=$(tool_state courier_spawn <<<"$out")
  directory=$(jq -r '.metadata.metadata.directory' <<<"$spawned")
  check "courier_spawn warned about the uncommitted changes" \
    "$(jq -r '.status == "completed" and .metadata.metadata.uncommitted == true and (.metadata.metadata | has("fromParent") | not) and (.output | contains("Your working tree has uncommitted changes, which it does not see"))' <<<"$spawned")"
  check "the child's worktree does not have the file" "$([ -d "$directory" ] && [ ! -e "$directory/dirty-root.txt" ] && echo true || echo false)"
  check "the isolated child reported back" "$([ -n "$(reply_time "$parent" "PARENT WOKE")" ] && echo true || echo false)"
}

run_subtree() {
  scenario "courier_tree shows a three-level tree, and courier_stop from the root stops all of it"
  child_delay 1000
  out=$(prompt "COURIER-SUBTREE-START")
  root=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  middle=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "the middle session started its leaf, and its turn runs on" "$(has_text "$middle" "Started session ses_" 60)"
  below="Its permission requests and questions go to the top session of the tree, not to you"
  check "the middle session's spawn result says its leaf's asks go to the top, and the root's does not (#477)" \
    "$(texts "$middle" | grep -qF "$below" && ! texts "$root" | grep -qF "$below" && echo true || echo false)"
  seen=$(prompt_in "$root" "COURIER-SUBTREE-TREE" | tool_state courier_tree)
  leaf=$(jq -r '.metadata.metadata.sessions[1].sessionID // empty' <<<"$seen")
  check "courier_tree lists the middle session and its leaf, with their depths and parents" \
    "$(jq -r --arg root "$root" --arg middle "$middle" '.status == "completed" and (.metadata.metadata.sessions | map([.sessionID, .depth, .parentID]) | .[0] == [$middle, 1, $root] and .[1][1] == 2 and .[1][2] == $middle and length == 2)' <<<"$seen")"
  check "each owes its report and is not isolated" \
    "$(jq -r '.metadata.metadata.sessions | all(.report.owes == true and .isolated == false)' <<<"$seen")"
  directory=$(node -p 'encodeURIComponent(process.argv[1])' "$WORK/project")
  panel=$(api_post "rpc/courier/tree?directory=$directory" "{\"input\":{\"sessionID\":\"$middle\"}}" | jq -c '.output | {top: (.top | {sessionID, parentID, depth}), rows: [.rows[].sessionID]}')
  echo "  $panel"
  check "the panel's tree read from the middle session has it as its top row, under the root, and its leaf below (#395)" \
    "$(jq -r --arg root "$root" --arg middle "$middle" --arg leaf "$leaf" '. == {top: {sessionID: $middle, parentID: $root, depth: 0}, rows: [$leaf]}' <<<"$panel")"
  stopped=$(prompt_in "$root" "COURIER-SUBTREE-STOP $middle" | tool_state courier_stop)
  check "courier_stop interrupted the leaf, then the middle session" \
    "$(jq -r --arg middle "$middle" --arg leaf "$leaf" '.status == "completed" and (.metadata.metadata.stopped | map([.sessionID, .outcome]) == [[$leaf, "interrupted"], [$middle, "interrupted"]])' <<<"$stopped")"
  ended() { for _ in $(seq 1 30); do [ "$(api "session/$1" | jq -r '(.data // .) | .outcome')" = interrupted ] && { echo true; return; }; sleep 1; done; echo false; }
  check "both sessions ended interrupted" "$([ "$(ended "$leaf")" = true ] && [ "$(ended "$middle")" = true ] && echo true || echo false)"
  handled=$(end_handled "$leaf" "$root" && end_handled "$middle" "$root" && echo true || echo false)
  check "neither parent was told of the stop, nor that a session ended without a report" \
    "$([ "$handled" = true ] && [ "$(notices_with "$root" ended)" = '[]' ] && [ "$(notices_with "$middle" ended)" = '[]' ] && echo true || echo false)"
  check "the stop is noted for both" "$([ -n "$(kv get "report/$leaf/stopped")" ] && [ -n "$(kv get "report/$middle/stopped")" ] && echo true || echo false)"
  check "a failure notice did not follow either" "$([ "$handled" = true ] && notices_with "$root" failed | jq -r 'length == 0' || echo false)"
}

run_idle_stop() {
  scenario "courier_stop of an idle session that owes a report tells the session that started it that it still counts (#501)"
  out=$(prompt "COURIER-IDLE-STOP")
  root=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  middle=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "the middle session's leaf ended its turn without a report" "$(has_text "$middle" "PARENT TOLD SILENT" 60)"
  leaf=$(api "session/$middle/message" | jq -r '[.data[] | .. | strings | capture("Started session (?<id>ses_\\w+)").id] | first // empty')
  [ -n "$leaf" ] && turn_ended "$leaf"
  check "the leaf is idle and owes its report" \
    "$([ -n "$leaf" ] && [ "$(kv get "report/$leaf/prompt" | jq -r '.at | type == "number"')" = true ] && [ -z "$(kv get "report/$leaf/settled")" ] && echo true || echo false)"
  turn_ended "$root"
  stopped=$(prompt_in "$root" "COURIER-SUBTREE-STOP $leaf" | tool_state courier_stop)
  echo "  $(jq -c '.metadata.metadata | {stopped, told}' <<<"$stopped")"
  check "courier_stop found the leaf idle and told the middle session" \
    "$(jq -r --arg leaf "$leaf" --arg middle "$middle" '.status == "completed" and (.metadata.metadata.stopped | map([.sessionID, .outcome]) == [[$leaf, "idle"]]) and .metadata.metadata.told == $middle' <<<"$stopped")"
  check "the middle session woke on the notice" "$(has_text "$middle" "PARENT WOKE" 45)"
  notices=$(notices_with "$middle" ended | jq -c 'map(select(contains("ended=\"stopped\"")))')
  echo "  $notices"
  check "it was told once, from the leaf, that it still counts, and offered courier_cleanup or a message" \
    "$(jq -r --arg leaf "$leaf" 'length == 1 and (.[0] | contains("<courier from=\"" + $leaf + "\" ended=\"stopped\">") and contains("still owed you a report") and contains("courier_cleanup") and (contains("will not report back") | not))' <<<"$notices")"
  check "the leaf still owes its report" "$([ -z "$(kv get "report/$leaf/settled")" ] && [ -n "$(kv get "report/$leaf/stopped")" ] && echo true || echo false)"
  turn_ended "$middle"
  turn_ended "$root"

  scenario "courier_stop of an idle session that sent blocked tells the session that started it not to answer it (#512)"
  out=$(prompt "COURIER-BLOCKED-STOP")
  root=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  middle=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "the middle session's leaf sent it status blocked" "$(has_text "$middle" "PARENT BLOCKED" 60)"
  leaf=$(api "session/$middle/message" | jq -r '[.data[] | .. | strings | capture("Started session (?<id>ses_\\w+)").id] | first // empty')
  [ -n "$leaf" ] && turn_ended "$leaf"
  check "the leaf is idle, its last report blocked" \
    "$([ -n "$leaf" ] && [ "$(kv get "report/$leaf/settled" | jq -r '.by == "report" and .status == "blocked"')" = true ] && echo true || echo false)"
  turn_ended "$middle"
  turn_ended "$root"
  stopped=$(prompt_in "$root" "COURIER-SUBTREE-STOP $leaf" | tool_state courier_stop)
  echo "  $(jq -c '.metadata.metadata | {stopped, told}' <<<"$stopped")"
  check "courier_stop found the leaf idle and told the middle session" \
    "$(jq -r --arg leaf "$leaf" --arg middle "$middle" '.status == "completed" and (.metadata.metadata.stopped | map([.sessionID, .outcome]) == [[$leaf, "idle"]]) and .metadata.metadata.told == $middle' <<<"$stopped")"
  check "the middle session woke on the notice" "$(has_text "$middle" "PARENT WOKE" 45)"
  notices=$(notices_with "$middle" ended | jq -c 'map(select(contains("ended=\"stopped\"")))')
  echo "  $notices"
  check "it was told once, from the leaf, not to send it the answer it waited on, and that it still holds back its join group (#523)" \
    "$(jq -r --arg leaf "$leaf" 'length == 1 and (.[0] | contains("<courier from=\"" + $leaf + "\" ended=\"stopped\">") and contains("waiting on your answer") and contains("Do not send it that answer") and contains("It still holds back its join group") and (contains("still owed you a report") | not))' <<<"$notices")"
  turn_ended "$middle"
  turn_ended "$root"
}

run_failed_live() {
  scenario "a failed session with a live session under it still counts, and its parent's notice says so (#462)"
  stop_server
  jq '.plugins[0].options.maxChildren = 1' "$WORK/project/opencode.json" >"$WORK/project/opencode.json.new"
  mv "$WORK/project/opencode.json.new" "$WORK/project/opencode.json"
  git -C "$WORK/project" -c user.email=e2e@example.com -c user.name=e2e commit -qam "maxChildren 1"
  start_server
  out=$(prompt "COURIER-MID-BREAKS")
  root=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  middle=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "the middle session started its leaf" "$(has_text "$middle" "Started session ses_" 60)"
  check "the middle session's turn failed, waking the root" "$(has_text "$root" "PARENT WOKE" 45)"
  leaf=$(api "session/$middle/message" | jq -r '[.data[] | .. | strings | capture("Started session (?<id>ses_\\w+)").id] | first // empty')
  notices=$(notices_with "$root" failed)
  echo "  $notices"
  check "the root was told once, of the middle session's failure" \
    "$(jq -r --arg middle "$middle" 'length == 1 and (.[0] | contains("<courier from=\"" + $middle + "\" failed="))' <<<"$notices")"
  check "the notice names the leaf still running, whose report will wake the middle session, and says it still counts" \
    "$(jq -r '.[0] | contains("It has 1 session of its own still running (\"") and contains("whose reports will wake it") and contains("still counts toward your limits")' <<<"$notices")"
  check "and offers messaging or stopping it, not a replacement" \
    "$(jq -r '.[0] | contains("message it rather than replace it, or stop it with courier_stop first") and (contains("start a replacement") | not)' <<<"$notices")"
  turn_ended "$root"
  refused=$(prompt_in "$root" "COURIER-TEST" | tool_state courier_spawn)
  check "with maxChildren 1, the root's replacement spawn is refused, naming maxChildren 1" \
    "$(jq -r '.status == "error" and (.error | tostring | contains("(maxChildren 1)"))' <<<"$refused")"
  stopped=$(prompt_in "$root" "COURIER-SUBTREE-STOP $middle" | tool_state courier_stop)
  check "courier_stop stops the middle session and its leaf" \
    "$(jq -r --arg leaf "$leaf" '.status == "completed" and (.metadata.metadata.stopped | map(.sessionID) | index($leaf) != null)' <<<"$stopped")"
  check "the middle session, its turn failed, was idle, and the result says an idle stop does not settle a session (#466)" \
    "$(jq -r --arg middle "$middle" '(.metadata.metadata.stopped | any(.sessionID == $middle and .outcome == "idle")) and (.output | contains("Stopping an idle session does not settle it: one that owed a report still owes it"))' <<<"$stopped")"
  [ -n "$leaf" ] && turn_ended "$leaf"
  turn_ended "$root"
  stop_server
  jq 'del(.plugins[0].options.maxChildren)' "$WORK/project/opencode.json" >"$WORK/project/opencode.json.new"
  mv "$WORK/project/opencode.json.new" "$WORK/project/opencode.json"
  git -C "$WORK/project" -c user.email=e2e@example.com -c user.name=e2e commit -qam "maxChildren default"
  start_server
}

run_total_refusal() {
  scenario "a maxTotal refusal tells a session with none of its own running that only reports held for a group can wake it (#479, #526)"
  stop_server
  jq '.plugins[0].options.maxTotal = 2' "$WORK/project/opencode.json" >"$WORK/project/opencode.json.new"
  mv "$WORK/project/opencode.json.new" "$WORK/project/opencode.json"
  git -C "$WORK/project" -c user.email=e2e@example.com -c user.name=e2e commit -qam "maxTotal 2"
  start_server
  out=$(prompt "COURIER-SILENT")
  root=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  first=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "the root was told its first child ended without a report" "$([ -n "$(reply_time "$root" "PARENT TOLD SILENT" 45)" ] && echo true || echo false)"
  turn_ended "$first"
  turn_ended "$root"
  second=$(prompt_in "$root" "COURIER-SILENT" | tool_state courier_spawn | jq -r '.metadata.metadata.sessionID // empty')
  check "the root started a second child, the first still owing its report" "$([ -n "$second" ] && echo true || echo false)"
  [ -n "$second" ] && turn_ended "$second"
  turn_ended "$root"
  refused=$(prompt_in "$second" "COURIER-TEST" | tool_state courier_spawn)
  echo "  $(jq -c '.error' <<<"$refused")"
  check "the second child, none of its own running, is refused at maxTotal 2 and told only reports held for a group can wake it" \
    "$(jq -r '.status == "error" and (.error | tostring | contains("(maxTotal 2). Do this part yourself: none of the sessions you started counts, so only reports already held for a group can still wake you.")) and (.error | tostring | contains("end your turn") | not)' <<<"$refused")"
  turn_ended "$second"
  turn_ended "$root"
  refused=$(prompt_in "$root" "COURIER-TEST" | tool_state courier_spawn)
  check "the root, its two children still owing reports, is refused at maxTotal 2 and told to answer any blocked one and try again once one of them has reported" \
    "$(jq -r '.status == "error" and (.error | tostring | contains("(maxTotal 2). Do this part yourself, or answer any session you started that is blocked, end your turn and try again once one of them has reported, not in a loop. A session also counts while one it started is live, and one that is blocked, or whose turn ended without a report unless it failed or was interrupted, counts until it reports or its parent drops it with courier_cleanup."))' <<<"$refused")"
  turn_ended "$root"
  stop_server
  jq 'del(.plugins[0].options.maxTotal)' "$WORK/project/opencode.json" >"$WORK/project/opencode.json.new"
  mv "$WORK/project/opencode.json.new" "$WORK/project/opencode.json"
  git -C "$WORK/project" -c user.email=e2e@example.com -c user.name=e2e commit -qam "maxTotal default"
  start_server
}

run_rolling_slot() {
  scenario "a parent at maxChildren spawns the next in the turn a report starts, while the reporter's turn runs on (#511)"
  stop_server
  jq '.plugins[0].options.maxChildren = 1' "$WORK/project/opencode.json" >"$WORK/project/opencode.json.new"
  mv "$WORK/project/opencode.json.new" "$WORK/project/opencode.json"
  git -C "$WORK/project" -c user.email=e2e@example.com -c user.name=e2e commit -qam "maxChildren 1"
  start_server
  out=$(prompt "COURIER-ROLLING")
  root=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  first=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  started=$(reply_time "$root" "ROOT STARTED NEXT" 60)
  next=$(api "session/$root/message" | jq -c '[.data[] | select(.type == "assistant") | .content[]? |
    select(.type == "tool" and .name == "courier_spawn" and .state.input.task == "CHILD-ROLLING-NEXT") | .state] | first')
  echo "  $(jq -c '.error // .status' <<<"$next")"
  check "the root, woken by the report, started the next child at maxChildren 1" "$(jq -r '.status == "completed"' <<<"$next")"
  finished_at=$(reply_time "$first" "ROLLING FIRST FINISHED" 60)
  check "it did so while the reporter's turn still ran" \
    "$([ -n "$started" ] && [ -n "$finished_at" ] && [ "$started" -lt "$finished_at" ] && echo true || echo false)"
  second=$(jq -r '.metadata.metadata.sessionID // .metadata.sessionID // empty' <<<"$next")
  [ -n "$second" ] && turn_ended "$second"
  turn_ended "$first"
  turn_ended "$root"
  scenario "a child idle after a blocked report still counts toward maxChildren (#524)"
  out=$(prompt "COURIER-SPAWN-BLOCKS")
  root=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  blocked=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "the root was woken by its child's blocked report" "$([ -n "$(reply_time "$root" "PARENT BLOCKED" 45)" ] && echo true || echo false)"
  turn_ended "$blocked"
  turn_ended "$root"
  refused=$(prompt_in "$root" "COURIER-TEST" | tool_state courier_spawn)
  echo "  $(jq -c '.error // .status' <<<"$refused")"
  check "the root's next spawn is refused at maxChildren 1, its blocked child counted" \
    "$(jq -r '.status == "error" and (.error | tostring | contains("1 session you started is running, blocked or still owes a report, the most allowed at once (maxChildren 1)"))' <<<"$refused")"
  turn_ended "$root"
  stop_server
  jq 'del(.plugins[0].options.maxChildren)' "$WORK/project/opencode.json" >"$WORK/project/opencode.json.new"
  mv "$WORK/project/opencode.json.new" "$WORK/project/opencode.json"
  git -C "$WORK/project" -c user.email=e2e@example.com -c user.name=e2e commit -qam "maxChildren default"
  start_server
}

run_subagent() {
  scenario "OpenCode's subagents show in courier_tree and the panel, courier_stop interrupts them though they run in the background, and the record lists them (#438)"
  child_delay 1000
  out=$(prompt "COURIER-SUBAGENT-START")
  root=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  middle=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "the middle session started two subagents, which run in the background, and its turn runs on" "$(has_text "$middle" "working in the background" 60)"
  seen=""
  for _ in $(seq 1 30); do
    seen=$(prompt_in "$root" "COURIER-SUBTREE-TREE" | tool_state courier_tree)
    [ "$(jq -r '[.metadata.metadata.sessions[] | select(.subagent == true)] | length' <<<"$seen")" = 2 ] && break
    sleep 1
  done
  echo "  $(jq -c '[.metadata.metadata.sessions[] | {sessionID, depth, parentID, subagent, title}]' <<<"$seen")"
  check "courier_tree lists the middle session, and both subagents under it, marked subagent, owing no report" \
    "$(jq -r --arg root "$root" --arg middle "$middle" '.metadata.metadata.sessions | map([.sessionID, .depth, .parentID, .subagent // false]) as $rows |
      $rows[0] == [$middle, 1, $root, false] and ($rows[1:] | length == 2 and all(.[1] == 2 and .[2] == $middle and .[3] == true)) and
      (.[1:] | all(has("report") | not) and (map(.title) | sort == ["Look it up", "Run the checks"]))' <<<"$seen")"
  first=$(jq -r '.metadata.metadata.sessions[] | select(.title == "Run the checks") | .sessionID' <<<"$seen")
  second=$(jq -r '.metadata.metadata.sessions[] | select(.title == "Look it up") | .sessionID' <<<"$seen")
  check "both subagents run" "$([ "$(session_info "$first" | jq -r '.parentID')" = "$middle" ] && [ "$(texts "$second" | grep -c 'SUBAGENT-SECOND')" -ge 1 ] && echo true || echo false)"
  directory=$(node -p 'encodeURIComponent(process.argv[1])' "$WORK/project")
  panel=$(api_post "rpc/courier/tree?directory=$directory" "{\"input\":{\"sessionID\":\"$root\"}}" | jq -c '[.output.rows[] | {sessionID, parentID, depth, subagent}]')
  echo "  $panel"
  check "the panel's rows have both subagents under the middle session, marked subagent" \
    "$(jq -r --arg middle "$middle" --arg first "$first" --arg second "$second" '(map(select(.subagent == true)) | map(.sessionID) | sort) == ([$first, $second] | sort) and
      all(.[]; .subagent != true or (.parentID == $middle and .depth == 2))' <<<"$panel")"
  summary=$(api_post "rpc/courier/summary?directory=$directory" "{\"input\":{\"sessionID\":\"$root\"}}" | jq -c '.output')
  check "the status entry counts only the middle session, as OpenCode's footer counts the subagents" "$(jq -r '.running + .waiting + .idle + (.stalled // 0) == 1' <<<"$summary")"
  stopped=$(prompt_in "$root" "COURIER-SUBTREE-STOP $middle" | tool_state courier_stop)
  echo "  $(jq -c '.metadata.metadata.stopped' <<<"$stopped")"
  check "courier_stop interrupted both subagents, then the middle session" \
    "$(jq -r --arg middle "$middle" --arg first "$first" --arg second "$second" '.status == "completed" and (.metadata.metadata.stopped | map([.sessionID, .outcome, .subagent // false]) as $s |
      ($s[0:2] | sort) == ([[$first, "interrupted", true], [$second, "interrupted", true]] | sort) and $s[2] == [$middle, "interrupted", false] and ($s | length == 3))' <<<"$stopped")"
  ended() { for _ in $(seq 1 30); do [ "$(api "session/$1" | jq -r '(.data // .) | .outcome')" = interrupted ] && { echo true; return; }; sleep 1; done; echo false; }
  check "all three ended interrupted" "$([ "$(ended "$first")" = true ] && [ "$(ended "$second")" = true ] && [ "$(ended "$middle")" = true ] && echo true || echo false)"
  told() { api "session/$middle/message" | jq -r --arg first "$first" --arg second "$second" '[.data[] | select(.type == "synthetic") | .metadata.childID // empty] | index($first) != null and index($second) != null'; }
  for _ in $(seq 1 30); do [ "$(told)" = true ] && [ "$(finished "$middle")" = true ] && [ "$(session_info "$middle" | jq -r '.outcome')" = interrupted ] && break; sleep 0.5; done
  check "OpenCode told the middle session that both subagents ended" "$(told)"
  check "their ends did not wake the stopped middle session again" \
    "$([ "$(finished "$middle")" = true ] && ! texts "$middle" | grep -qF "SAW SUBAGENT END" && [ "$(session_info "$middle" | jq -r '.outcome')" = interrupted ] && echo true || echo false)"
  check "no courier report state was noted for the subagents" "$([ -z "$(kv get "report/$first/stopped")" ] && [ -z "$(kv get "report/$second/settled")" ] && echo true || echo false)"
}

run_subagent_role() {
  scenario "an OpenCode subagent of a courier child gets no root role line and no courier_spawn (#463)"
  out=$(prompt "COURIER-SUBAGENT-NO-ROOT")
  root=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "the child reported its subagent's answer to the root" "$(has_text "$root" "CHILD SAW" 60)"
  sub=$(jq -sr '[.[] | select(.reply.text? == "SUBAGENT NO ROOT DONE") | .session] | unique | .[0] // empty' "$WORK/model.log")
  check "the subagent was started by the child, through OpenCode's parentID" "$([ -n "$sub" ] && [ "$(session_info "$sub" | jq -r '.parentID')" = "$child" ] && echo true || echo false)"
  check "every request of the subagent had no role line, no hook part, and no courier_spawn, but courier_send" \
    "$(jq -sr --arg sub "$sub" '[.[] | select(.session == $sub and (.tools | length > 0))]
      | length > 0 and all(.role == null and (.rolePart | not) and (.roleEntry | not) and (.tools | index("courier_spawn") | not) and (.tools | index("courier_send")))' "$WORK/model.log" |
      grep -qx true && jq -sr --arg sub "$sub" '[.[] | select(.type == "probe.context" and .sessionID == $sub)] | length > 0 and all(.role == null and (.tools | index("courier_spawn") | not))' "$WORK/probe.log" | grep -qx true && echo true || echo false)"
  check "the child kept its role and courier_spawn" \
    "$(jq -sr --arg child "$child" '[.[] | select(.session == $child and (.tools | length > 0))] | length > 0 and all(.role == "sub-orchestrator" and (.tools | index("courier_spawn")))' "$WORK/model.log")"
}

run_archive() {
  scenario "a child that reported and was archived reads as idle, and no longer counts against the limits (#324)"
  stop_server
  jq '.plugins[0].options.maxChildren = 1' "$WORK/project/opencode.json" >"$WORK/project/opencode.json.new"
  mv "$WORK/project/opencode.json.new" "$WORK/project/opencode.json"
  git -C "$WORK/project" -c user.email=e2e@example.com -c user.name=e2e commit -qam "maxChildren 1"
  start_server
  out=$(prompt "COURIER-TEST")
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "the child reported back, waking the parent" "$([ -n "$(reply_time "$parent" "PARENT WOKE" 45)" ] && echo true || echo false)"
  turn_ended "$child"
  turn_ended "$parent"
  check "the child is idle and owes no report" "$([ "$(finished "$child")" = true ] && [ "$(reported "$child")" = true ] && echo true || echo false)"
  check "the person archives it" "$(patch_session "$child" '{"archived":true}')"
  for _ in $(seq 1 10); do [ "$(session_info "$child" | jq -r '.time.archived != null')" = true ] && break; sleep 1; done
  check "archiving stamped its updated time with the archive's, past its last turn's end" \
    "$(session_info "$child" | jq -r '.time.archived != null and .time.updated == .time.archived and .time.updated > .time.idle')"
  check "which reads as finished, its transcript ending on its last turn's end" "$(finished "$child")"
  listed=$(prompt "COURIER-CHILDREN $parent" | tool_state courier_children | jq -c --arg child "$child" '.metadata.metadata.children[] | select(.sessionID == $child)')
  echo "  $listed"
  check "courier_children says it was archived when it last changed, its last turn having succeeded" \
    "$(jq -r '.outcome == "succeeded" and .archived != null and .archived == .updated' <<<"$listed")"
  directory=$(node -p 'encodeURIComponent(process.argv[1])' "$WORK/project")
  row=$(api_post "rpc/courier/tree?directory=$directory" "{\"input\":{\"sessionID\":\"$parent\"}}" |
    jq -c --arg id "$child" '.output.rows[] | select(.sessionID == $id) | {state, idle, report}')
  echo "  $row"
  check "the panel's row reads it idle and reported, with its last turn's end" \
    "$(jq -r '.state == "idle" and (.idle | type == "number") and .report.state == "reported" and .report.status == "done"' <<<"$row")"
  summary=$(api_post "rpc/courier/summary?directory=$directory" "{\"input\":{\"sessionID\":\"$parent\"}}" | jq -c '.output')
  echo "  $summary"
  check "and the footer counts it idle, not running" "$(jq -r '.running == 0 and .idle == 1' <<<"$summary")"
  started=$(prompt_in "$parent" "COURIER-TEST" | tool_state courier_spawn)
  check "with maxChildren 1, the parent starts another child: the archived one does not count" "$(jq -r '.status == "completed"' <<<"$started")"
  second=$(jq -r '.metadata.metadata.sessionID' <<<"$started")
  check "the new child reported back" \
    "$(for _ in $(seq 1 45); do [ "$(reported "$second")" = true ] && { echo true; exit; }; sleep 1; done; echo false)"
  turn_ended "$second"

  scenario "a child archived while its turn runs on reads as running, and still counts against the limits (#324)"
  api_prompt "$second" "COURIER-HOLD"
  last_message() { api "session/$1/message" | jq -r '.data | sort_by(.id) | last | .type'; }
  for _ in $(seq 1 30); do [ "$(last_message "$second")" = user ] && break; sleep 1; done
  check "the prompt reached it, and its turn waits on the model" "$([ "$(last_message "$second")" = user ] && echo true || echo false)"
  check "the person archives it" "$(patch_session "$second" '{"archived":true}')"
  for _ in $(seq 1 10); do [ "$(session_info "$second" | jq -r '.time.archived != null')" = true ] && break; sleep 1; done
  check "the archive is the last stamp on its updated time, past its last turn's end, as for an idle one" \
    "$(session_info "$second" | jq -r '.time.archived != null and .time.updated == .time.archived and .time.updated > .time.idle')"
  row=$(api_post "rpc/courier/tree?directory=$directory" "{\"input\":{\"sessionID\":\"$parent\"}}" |
    jq -c --arg id "$second" '.output.rows[] | select(.sessionID == $id) | {state, report}')
  echo "  $row"
  check "its transcript tells: the panel's row reads it running, still reported" "$(jq -r '.state == "running" and .report.state == "reported"' <<<"$row")"
  summary=$(api_post "rpc/courier/summary?directory=$directory" "{\"input\":{\"sessionID\":\"$parent\"}}" | jq -c '.output')
  echo "  $summary"
  check "and the footer counts it running, the first child idle" "$(jq -r '.running == 1 and .idle == 1' <<<"$summary")"
  refused=$(prompt_in "$parent" "COURIER-TEST" | tool_state courier_spawn)
  check "while it runs, the parent's next spawn is refused, naming maxChildren 1" \
    "$(jq -r '.status == "error" and (.error | tostring | contains("(maxChildren 1)"))' <<<"$refused")"
  check "the person interrupts it" "$([[ $(person "session/$second/interrupt") == 20* ]] && echo true || echo false)"
  turn_ended "$second"
  check "and then it reads idle" \
    "$(api_post "rpc/courier/tree?directory=$directory" "{\"input\":{\"sessionID\":\"$parent\"}}" | jq -r --arg id "$second" '.output.rows[] | select(.sessionID == $id) | .state == "idle"')"

  scenario "a reported idle child the person renames, switches to another model or unarchives reads as idle, and no longer counts (#326)"
  check "the person unarchives the first child" "$(patch_session "$child" '{"archived":false}')"
  for _ in $(seq 1 10); do [ "$(session_info "$child" | jq -r '.time.archived == null')" = true ] && break; sleep 1; done
  check "unarchiving stamped its updated time past its last turn's end" "$(session_info "$child" | jq -r '.time.archived == null and .time.updated > .time.idle')"
  check "which reads as finished, its transcript ending on that turn's end" "$(finished "$child")"
  summary=$(api_post "rpc/courier/summary?directory=$directory" "{\"input\":{\"sessionID\":\"$parent\"}}" | jq -c '.output')
  echo "  $summary"
  check "the footer counts it and the archived second child idle" "$(jq -r '.running == 0 and .idle == 2' <<<"$summary")"
  out=$(prompt "COURIER-TEST")
  third_parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  third=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "a new parent's child reported back, waking it" "$([ -n "$(reply_time "$third_parent" "PARENT WOKE" 45)" ] && echo true || echo false)"
  turn_ended "$third"
  turn_ended "$third_parent"
  check "the person renames the child" "$(patch_session "$third" '{"title":"Renamed by the person"}')"
  for _ in $(seq 1 10); do [ "$(session_info "$third" | jq -r '.title')" = "Renamed by the person" ] && break; sleep 1; done
  check "renaming stamped its updated time past its last turn's end, recording nothing in its transcript" \
    "$([ "$(session_info "$third" | jq -r '.time.archived == null and .time.updated > .time.idle')" = true ] &&
      [ "$(api "session/$third/context" | jq -r '.data | last | .type')" = idle ] && echo true || echo false)"
  check "which reads as finished" "$(finished "$third")"
  listed=$(prompt "COURIER-CHILDREN $third_parent" | tool_state courier_children | jq -c --arg child "$third" '.metadata.metadata.children[] | select(.sessionID == $child)')
  echo "  $listed"
  check "courier_children lists it by its new title, its last turn having succeeded before the rename" \
    "$(jq -r '.title == "Renamed by the person" and .outcome == "succeeded" and .updated > .idle and .archived == null' <<<"$listed")"
  row=$(api_post "rpc/courier/tree?directory=$directory" "{\"input\":{\"sessionID\":\"$third_parent\"}}" |
    jq -c --arg id "$third" '.output.rows[] | select(.sessionID == $id) | {title, state, idle, report}')
  echo "  $row"
  check "the panel's row reads it idle and reported, by its new title, with its last turn's end" \
    "$(jq -r '.title == "Renamed by the person" and .state == "idle" and (.idle | type == "number") and .report.state == "reported"' <<<"$row")"
  summary=$(api_post "rpc/courier/summary?directory=$directory" "{\"input\":{\"sessionID\":\"$third_parent\"}}" | jq -c '.output')
  echo "  $summary"
  check "and the footer counts it idle, not running" "$(jq -r '.running == 0 and .idle == 1' <<<"$summary")"
  check "the person switches its model" "$([ "$(person "session/$third/model" '{"model":{"providerID":"mock","id":"other"}}')" = 204 ] && echo true || echo false)"
  for _ in $(seq 1 10); do [ "$(api "session/$third/context" | jq -r '.data | last | .type')" = model-switched ] && break; sleep 1; done
  check "the switch is the last message in its transcript, and stamped its updated time again" \
    "$([ "$(api "session/$third/context" | jq -r '.data | last | .type')" = model-switched ] &&
      [ "$(session_info "$third" | jq -r '.time.updated > .time.idle')" = true ] && echo true || echo false)"
  check "it still reads as finished, and the panel's row idle" \
    "$([ "$(finished "$third")" = true ] && [ "$(api_post "rpc/courier/tree?directory=$directory" "{\"input\":{\"sessionID\":\"$third_parent\"}}" |
      jq -r --arg id "$third" '.output.rows[] | select(.sessionID == $id) | .state')" = idle ] && echo true || echo false)"
  started=$(prompt_in "$third_parent" "COURIER-TEST" | tool_state courier_spawn)
  check "with maxChildren 1, the parent starts another child: the renamed and switched one does not count" "$(jq -r '.status == "completed"' <<<"$started")"
  fourth=$(jq -r '.metadata.metadata.sessionID' <<<"$started")
  check "the new child reported back" \
    "$(for _ in $(seq 1 45); do [ "$(reported "$fourth")" = true ] && { echo true; exit; }; sleep 1; done; echo false)"
  turn_ended "$fourth"

  scenario "a reported idle child with a courier message waiting to wake it counts against the limits until it takes the message (#326)"
  wake_row() { kv get "wake/$1/$inbox" | jq -r "${@:2}"; }
  taken() { api "session/$1/message" | jq -r --arg id "$inbox" 'any(.data[]; .id == $id)'; }
  at=$(now_ms)
  text="<courier from=\"$third_parent\">CHILD-REPORT-NOW</courier>"
  inbox=$(api_post "session/$fourth/synthetic" "$(jq -nc --arg text "$text" --arg from "$third_parent" \
    '{text: $text, description: ("Message from " + $from), metadata: {source: "courier", from: $from}, delivery: "steer", resume: false}')" | jq -r '.data.id // empty')
  check "a courier message waits in the idle child's inbox ($inbox)" \
    "$([ -n "$inbox" ] && api "session/$fourth/inbox" | jq -e --arg id "$inbox" 'any(.data[]; .id == $id)' >/dev/null && echo true || echo false)"
  kv set "wake/$fourth/$inbox" "$(jq -nc --arg text "$text" --arg from "$third_parent" --argjson at "$at" \
    '{at: $at, text: $text, description: ("Message from " + $from), running: false, idleAt: $at}')" "report/$fourth/prompt"
  check "its wake row says it waits in an idle session, not stalled" "$(wake_row "$fourth" '.running == false and .stalled == null')"
  refused=$(prompt_in "$third_parent" "COURIER-TEST" | tool_state courier_spawn)
  check "while it waits, the parent's next spawn is refused, naming maxChildren 1" \
    "$(jq -r '.status == "error" and (.error | tostring | contains("(maxChildren 1)"))' <<<"$refused")"
  check "and the message still waits, not taken" "$([ "$(taken "$fourth")" = false ] && echo true || echo false)"
  for _ in $(seq 1 75); do [ "$(taken "$fourth")" = true ] && break; sleep 1; done
  check "the scheduler woke the child again, which took the message" "$(taken "$fourth")"
  check "and reported again, waking the parent" "$(has_text "$third_parent" "CHILD DONE AFTER NUDGE" 45)"
  check "and the watch is over" "$(for _ in $(seq 1 10); do [ -z "$(kv get "wake/$fourth/$inbox")" ] && { echo true; exit; }; sleep 1; done; echo false)"
  turn_ended "$fourth"
  turn_ended "$third_parent"
  started=$(prompt_in "$third_parent" "COURIER-TEST" | tool_state courier_spawn)
  check "with maxChildren 1, the parent's next spawn then goes through" "$(jq -r '.status == "completed"' <<<"$started")"
  fifth=$(jq -r '.metadata.metadata.sessionID' <<<"$started")
  check "the new child reported back" \
    "$(for _ in $(seq 1 45); do [ "$(reported "$fifth")" = true ] && { echo true; exit; }; sleep 1; done; echo false)"
  turn_ended "$fifth"

  scenario "a follow-up courier_send to a reported child is watched when the tool returns, so a spawn in the same step counts it (#330)"
  reports_before=$(texts "$third_parent" | grep -cF "CHILD DONE AFTER NUDGE" || true)
  nudged=$(prompt_in "$third_parent" "COURIER-NUDGE $fifth" | tool_state courier_send | jq -r '.metadata.metadata.messageID // empty')
  check "the parent sent its reported child a follow-up ($nudged)" "$([ -n "$nudged" ] && echo true || echo false)"
  check "which is watched, or already taken and the watch over" \
    "$(for _ in $(seq 1 10); do [ -n "$(kv get "wake/$fifth/$nudged")" ] || [ "$(api "session/$fifth/message" | jq -r --arg id "$nudged" 'any(.data[]; .id == $id)')" = true ] && { echo true; exit; }; sleep 1; done; echo false)"
  check "the child reported again, waking the parent" \
    "$(for _ in $(seq 1 45); do [ "$(texts "$third_parent" | grep -cF "CHILD DONE AFTER NUDGE")" -gt "$reports_before" ] && { echo true; exit; }; sleep 1; done; echo false)"
  check "and the watch is over" "$(for _ in $(seq 1 10); do [ -z "$(kv get "wake/$fifth/$nudged")" ] && { echo true; exit; }; sleep 1; done; echo false)"
  turn_ended "$fifth"
  turn_ended "$third_parent"

  scenario "a child whose first turn the person ended by declining its request plainly reads as idle, still owing its report (#326)"
  ask_permission ""
  summary=$(api_post "rpc/courier/summary?directory=$directory" "{\"input\":{\"sessionID\":\"$parent\"}}" | jq -c '.output')
  echo "  $summary"
  check "while its request waits, the footer counts it waiting" "$(jq -r '.waiting == 1 and .running == 0 and .idle == 0' <<<"$summary")"
  check "the person declines the child's request in its own session, without a reason" \
    "$([ "$(person "session/$child/permission/$request/reply" '{"decision":"reject"}')" = 204 ] && echo true || echo false)"
  for _ in $(seq 1 30); do [ "$(api "session/$child/context" | jq -r '.data | last | .error.type == "aborted"')" = true ] && break; sleep 1; done
  check "its transcript ends on the interrupted step, and it has no idle time" \
    "$([ "$(api "session/$child/context" | jq -r '.data | last | .type == "assistant" and .error.type == "aborted"')" = true ] &&
      [ "$(session_info "$child" | jq -r '.time.idle == null')" = true ] && echo true || echo false)"
  check "which reads as finished" "$(finished "$child")"
  row=$(api_post "rpc/courier/tree?directory=$directory" "{\"input\":{\"sessionID\":\"$parent\"}}" |
    jq -c --arg id "$child" '.output.rows[] | select(.sessionID == $id) | {state, report, waits, idle, created}')
  echo "  $row"
  check "the panel's row reads it idle since its interrupted step ended, waiting on nothing, its report still owed" \
    "$(jq -r '.state == "idle" and (.idle | type == "number") and .idle > .created and .waits == [] and .report.state == "owed"' <<<"$row")"
  summary=$(api_post "rpc/courier/summary?directory=$directory" "{\"input\":{\"sessionID\":\"$parent\"}}" | jq -c '.output')
  echo "  $summary"
  check "and the footer counts it idle" "$(jq -r '.running == 0 and .waiting == 0 and .idle == 1' <<<"$summary")"
  check "and the parent was told the child ended without a report, as for any silent turn" \
    "$(for _ in $(seq 1 30); do [ "$(notices_with "$parent" ended | jq -r 'length')" -ge 1 ] && { echo true; exit; }; sleep 1; done; echo false)"
  check "the child is deleted" "$([[ $(curl -s -o /dev/null -w '%{http_code}' -u "opencode:$OPENCODE_PASSWORD" -X DELETE "$SERVER/api/session/$child") == 20* ]] && echo true || echo false)"

  scenario "a courier message sent to a child while its request waits is taken once a plain decline has ended its turn (#326)"
  ask_permission ""
  inbox=$(prompt_in "$parent" "COURIER-NUDGE $child" | tool_state courier_send | jq -r '.metadata.metadata.messageID // empty')
  check "the parent sent the waiting child a message ($inbox)" "$([ -n "$inbox" ] && echo true || echo false)"
  check "which the courier watches as the running turn's to take" \
    "$(for _ in $(seq 1 10); do [ "$(wake_row "$child" '.running')" = true ] && { echo true; exit; }; sleep 1; done; echo false)"
  check "and which waits, not taken" "$([ "$(taken "$child")" = false ] && echo true || echo false)"
  check "the person declines the child's request in its own session, without a reason" \
    "$([ "$(person "session/$child/permission/$request/reply" '{"decision":"reject"}')" = 204 ] && echo true || echo false)"
  for _ in $(seq 1 15); do [ "$(taken "$child")" = true ] && break; sleep 1; done
  check "the child takes the message at once" "$(taken "$child")"
  check "and reports, waking the parent" "$(has_text "$parent" "CHILD DONE AFTER NUDGE" 45)"
  check "and the watch is over, so nothing is to wake it again" \
    "$(for _ in $(seq 1 10); do [ -z "$(kv get "wake/$child/$inbox")" ] && { echo true; exit; }; sleep 1; done; echo false)"
  turn_ended "$child"
  turn_ended "$parent"
  check "the child is deleted" "$([[ $(curl -s -o /dev/null -w '%{http_code}' -u "opencode:$OPENCODE_PASSWORD" -X DELETE "$SERVER/api/session/$child") == 20* ]] && echo true || echo false)"
  stop_server
  jq 'del(.plugins[0].options.maxChildren)' "$WORK/project/opencode.json" >"$WORK/project/opencode.json.new"
  mv "$WORK/project/opencode.json.new" "$WORK/project/opencode.json"
  git -C "$WORK/project" -c user.email=e2e@example.com -c user.name=e2e commit -qam "maxChildren default"
  start_server
}

run_nest() {
  scenario "nested isolation: a grandchild starts from its isolated parent's HEAD"
  child_delay 1000
  out=$(prompt "COURIER-NEST")
  nest_parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  nest_mid=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "the child's report, after it merged its grandchild's branch, woke the parent" "$(has_text "$nest_parent" "MID MERGED leaf.txt" 90)"
  nest_leaf=$(texts "$nest_mid" | sed -n 's/.*Started session \(ses_[A-Za-z0-9]*\) in .*/\1/p' | head -1)
  check "the child started an isolated grandchild" "$([ -n "$nest_leaf" ] && echo true || echo false)"
  mid_dir=$(kv get "roster/$nest_parent/$nest_mid" | jq -r '.directory')
  leaf_entry=$(kv get "roster/$nest_mid/$nest_leaf")
  leaf_dir=$(jq -r '.directory' <<<"$leaf_entry")
  check "the grandchild has a worktree of its own" "$([[ $leaf_dir == */worktree/* && $leaf_dir != "$mid_dir" ]] && echo true || echo false)"
  mid_commit=$(git -C "$WORK/project" log --grep='^mid work$' --format=%H "courier/$nest_mid" 2>/dev/null | head -1 || true)
  check "the child committed on courier/<its session>" "$([ -n "$mid_commit" ] && echo true || echo false)"
  check "the grandchild's recorded base is the child's commit" "$([ -n "$mid_commit" ] && [ "$(jq -r '.base' <<<"$leaf_entry")" = "$mid_commit" ] && echo true || echo false)"
  check "its worktree contains the child's file" "$([ -f "$leaf_dir/leaf-saw-mid.txt" ] && echo true || echo false)"
  check "and the child's commit is in its history" "$(git -C "$leaf_dir" log --format=%s | grep -x 'mid work' >/dev/null && echo true || echo false)"
  check "the grandchild committed on courier/<its session>" "$(git -C "$WORK/project" log -1 --format=%s "courier/$nest_leaf" 2>/dev/null | grep -qx 'leaf work' && echo true || echo false)"
  check "the child merged it into its own worktree" "$([ -f "$mid_dir/leaf.txt" ] && echo true || echo false)"
}

run_stall() {
  scenario "a report whose wake a staged revert suppresses is sent again once, then flagged stalled (#218)"
  child_delay 15000
  out=$(prompt "COURIER-STALL")
  root=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  middle=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "the root started a middle session" "$([ -n "$middle" ] && echo true || echo false)"
  leaf=$(spawned_by "$middle")
  check "the middle started a leaf" "$([ -n "$leaf" ] && echo true || echo false)"
  for _ in $(seq 1 30); do [ "$(finished "$middle")" = true ] && break; sleep 1; done
  check "the middle ended its turn before the report" "$([ "$(finished "$middle")" = true ] && echo true || echo false)"
  message=$(api "session/$middle/message" | jq -r '.data[0].id')
  staged=$(curl -s -o /dev/null -w '%{http_code}' -u "opencode:$OPENCODE_PASSWORD" -X POST -H 'content-type: application/json' \
    --data "{\"messageID\":\"$message\"}" "$SERVER/api/session/$middle/revert/stage")
  check "the revert is staged on the idle middle" "$([[ $staged == 20* ]] && echo true || echo false)"
  inbox=
  for _ in $(seq 1 40); do
    inbox=$(api "session/$middle/inbox" | jq -r '[.data[] | select(.type == "synthetic")] | first | .id // empty')
    [ -n "$inbox" ] && break
    sleep 1
  done
  check "the leaf's report waits in the middle's inbox ($inbox)" "$([ -n "$inbox" ] && echo true || echo false)"
  watched() { kv get "wake/$middle/$inbox" | jq -r "$1"; }
  check "the courier watches it, waiting in an idle session" "$(watched '.running == false')"
  for _ in $(seq 1 60); do [ "$(watched '.rewoken != null')" = true ] && break; sleep 1; done
  check "the scheduler sent it again under the same inbox id" "$(watched '.rewoken != null')"
  check "which OpenCode took for the message waiting, not a second one" \
    "$(api "session/$middle/inbox" | jq -r --arg id "$inbox" '[.data[] | select(.type == "synthetic")] | length == 1 and .[0].id == $id')"
  for _ in $(seq 1 60); do [ "$(watched '.stalled != null')" = true ] && break; sleep 1; done
  check "still not taken, it is flagged stalled" "$(watched '.stalled != null')"
  summary=$(api_post "rpc/courier/summary?directory=$(node -p 'encodeURIComponent(process.argv[1])' "$WORK/project")" "{\"input\":{\"sessionID\":\"$root\"}}" | jq -c '.output')
  echo "  $summary"
  check "the root's tree summary counts the stalled middle" "$(jq -r '.stalled == 1' <<<"$summary")"
  row=$(api_post "rpc/courier/tree?directory=$(node -p 'encodeURIComponent(process.argv[1])' "$WORK/project")" "{\"input\":{\"sessionID\":\"$root\"}}" |
    jq -c --arg id "$middle" '.output.rows[] | select(.sessionID == $id) | {state, stalled}')
  echo "  $row"
  check "and the panel's row reads it as stalled, since the report arrived" "$(jq -r '.state == "stalled" and (.stalled | type == "number")' <<<"$row")"
}

run_inbox() {
  scenario "the asks inbox lists a child's permission request, and answers it as the TUI does"
  ask_permission ""
  listed=$(inbox asks "{\"sessionID\":\"$parent\"}" | jq -c '.output')
  check "it lists the request, from the parent's tree" \
    "$(jq -r --arg parent "$parent" --arg child "$child" --arg request "$request" '.top == $parent and .sessions[0].sessionID == $child and
      (.permissions | length == 1 and (.[0] | .sessionID == $child and .requestID == $request and .action == "shell" and
        .resources == ["echo courier-asks"]))' <<<"$listed" 2>/dev/null || echo false)"
  check "the child's own session lists the same" "$([ "$(inbox asks "{\"sessionID\":\"$child\"}" | jq -c '.output')" = "$listed" ] && echo true || echo false)"
  check "the inbox answers through OpenCode's reply" "$([ "$(person "session/$child/permission/$request/reply" '{"decision":"once"}')" = 204 ] && echo true || echo false)"
  check "the child carried on and reported back" "$([ -n "$(reply_time "$parent" "PARENT WOKE" 45)" ] && echo true || echo false)"
  check "the parent was told it is settled, once" \
    "$(notices_with "$parent" answered | jq -r --arg request "$request" 'length == 1 and (.[0] | contains("request=\"" + $request + "\"") and contains("answered=\"once\""))')"
  check "and took it with the child's report, in one turn" "$(settled_with_report "$parent" "$request")"
  check "and nothing is left in the inbox" "$(inbox asks "{\"sessionID\":\"$parent\"}" | jq -r '.output.permissions == [] and .output.questions == []')"

  scenario "the asks inbox answers a child's question through the person's RPC, while the parent asks the person"
  ask_question COURIER-QUESTION
  question=$(inbox asks "{\"sessionID\":\"$parent\"}" | jq -r --arg child "$child" '.output.questions[] | select(.sessionID == $child) | .requestID')
  check "it lists the question" "$([[ $question == question_* ]] && echo true || echo false)"
  answered=$(inbox answer "{\"sessionID\":\"$child\",\"requestID\":\"$question\",\"answers\":[[\"Hi\"]]}" | jq -c '.output')
  check "the answer went to the child's waiting call" "$([ "$answered" = '{"answered":true,"by":"result"}' ] && echo true || echo false)"
  check "the child got it and reported" "$(has_text "$parent" 'CHILD GOT [["Hi"]]' 45)"
  check "the parent's own question was withdrawn, saying it is settled: no second ask" \
    "$(has_text "$parent" "Session $child no longer waits on this question: it was answered by the person (" 30)"
  check "both forms are gone" "$([ "$(forms_of "$parent")" = 0 ] && [ "$(forms_of "$child")" = 0 ] && echo true || echo false)"
  check "and no notice besides" "$(turn_ended "$parent"; end_handled "$parent" "$parent" && notices_with "$parent" answered | jq -r 'length == 0' || echo false)"
  check "answering it again passes nothing on" \
    "$(inbox answer "{\"sessionID\":\"$child\",\"requestID\":\"$question\",\"answers\":[[\"Hey\"]]}" | jq -r '.output == {answered: false}')"

  scenario "the asks inbox answers a child's question the parent was told of and did not ask: the parent hears it answered by the person"
  out=$(prompt "COURIER-QUESTION-WAIT")
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  question=$(reply_time "$parent" "PARENT WAITS QUESTION" 45 >/dev/null; inbox asks "{\"sessionID\":\"$parent\"}" | jq -r --arg child "$child" '.output.questions[] | select(.sessionID == $child) | .requestID')
  check "the parent was told of it and asked no one" "$([[ $question == question_* ]] && [ "$(forms_of "$parent")" = 0 ] && echo true || echo false)"
  answered=$(inbox answer "{\"sessionID\":\"$child\",\"requestID\":\"$question\",\"answers\":[[\"Hey\"]]}" | jq -c '.output')
  check "the answer went to the child's waiting call" "$([ "$answered" = '{"answered":true,"by":"result"}' ] && echo true || echo false)"
  check "the child got it and reported" "$(has_text "$parent" 'CHILD GOT [["Hey"]]' 45)"
  check "the parent was told once that the person answered it, not its own session" \
    "$(turn_ended "$parent"; end_handled "$parent" "$parent" && notices_with "$parent" answered | jq -r --arg question "$question" 'length == 1 and (.[0] | contains("request=\"" + $question + "\"") and contains("was answered by the person (") and (contains("in its own session") | not))' || echo false)"
}

run_busy() {
  scenario "a reported child the person renames at rest reads idle: its busy time, when its latest execution started, is not past its idle time (#400)"
  out=$(prompt "COURIER-TEST")
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "the child reported back, waking the parent" "$([ -n "$(reply_time "$parent" "PARENT WOKE" 45)" ] && echo true || echo false)"
  turn_ended "$child"
  turn_ended "$parent"
  times=$(session_info "$child" | jq -c '.time')
  echo "  $times"
  check "the host stamped when the child's execution started, after it was created and before its turn's end" \
    "$(jq -r '.busy != null and .busy >= .created and .busy <= .idle' <<<"$times")"
  check "the person renames it" "$(patch_session "$child" '{"title":"Renamed at rest"}')"
  for _ in $(seq 1 10); do [ "$(session_info "$child" | jq -r '.title')" = "Renamed at rest" ] && break; sleep 1; done
  times=$(session_info "$child" | jq -c '.time')
  echo "  $times"
  check "the rename stamped its updated time past its last turn's end, and left its busy time where it was" \
    "$(jq -r '.updated > .idle and .busy <= .idle' <<<"$times")"
  check "which reads as finished by its times" "$(finished "$child")"
  directory=$(node -p 'encodeURIComponent(process.argv[1])' "$WORK/project")
  row=$(api_post "rpc/courier/tree?directory=$directory" "{\"input\":{\"sessionID\":\"$parent\"}}" |
    jq -c --arg id "$child" '.output.rows[] | select(.sessionID == $id) | {title, state, idle, report}')
  echo "  $row"
  check "the panel's row reads it idle since that end, reported, by its new title" \
    "$(jq -r --argjson idle "$(jq '.idle' <<<"$times")" '.title == "Renamed at rest" and .state == "idle" and .idle == $idle and .report.state == "reported"' <<<"$row")"
  summary=$(api_post "rpc/courier/summary?directory=$directory" "{\"input\":{\"sessionID\":\"$parent\"}}" | jq -c '.output')
  echo "  $summary"
  check "and the footer counts it idle, not running" "$(jq -r '.running == 0 and .idle == 1' <<<"$summary")"
  listed=$(prompt "COURIER-CHILDREN $parent" | tool_state courier_children | jq -c --arg child "$child" '.metadata.metadata.children[] | select(.sessionID == $child)')
  echo "  $listed"
  check "courier_children lists it by its new title, its last turn having succeeded before the rename" \
    "$(jq -r '.title == "Renamed at rest" and .outcome == "succeeded" and .updated > .idle' <<<"$listed")"

  scenario "a child at rest after a plain decline, its busy time past its idle time, still reads idle by its transcript (#400)"
  ask_permission ""
  times=$(session_info "$child" | jq -c '.time')
  echo "  $times"
  check "while its request waits, its first execution has started and no turn has ended: a busy time, no idle time" \
    "$(jq -r '.busy != null and .idle == null' <<<"$times")"
  check "the person declines the child's request in its own session, without a reason" \
    "$([ "$(person "session/$child/permission/$request/reply" '{"decision":"reject"}')" = 204 ] && echo true || echo false)"
  for _ in $(seq 1 30); do [ "$(api "session/$child/context" | jq -r '.data | last | .error.type == "aborted"')" = true ] && break; sleep 1; done
  check "its transcript ends on the interrupted step, and it still has a busy time and no idle time" \
    "$([ "$(api "session/$child/context" | jq -r '.data | last | .type == "assistant" and .error.type == "aborted"')" = true ] &&
      [ "$(session_info "$child" | jq -r --argjson busy "$(jq '.busy' <<<"$times")" '.time.busy == $busy and .time.idle == null')" = true ] && echo true || echo false)"
  check "which reads as finished by its transcript" "$(finished "$child")"
  row=$(api_post "rpc/courier/tree?directory=$directory" "{\"input\":{\"sessionID\":\"$parent\"}}" |
    jq -c --arg id "$child" '.output.rows[] | select(.sessionID == $id) | {state, report, waits, idle}')
  echo "  $row"
  check "the panel's row reads it idle since that step ended, waiting on nothing, its report still owed" \
    "$(jq -r '.state == "idle" and (.idle | type == "number") and .waits == [] and .report.state == "owed"' <<<"$row")"
  summary=$(api_post "rpc/courier/summary?directory=$directory" "{\"input\":{\"sessionID\":\"$parent\"}}" | jq -c '.output')
  echo "  $summary"
  check "and the footer counts it idle" "$(jq -r '.running == 0 and .waiting == 0 and .idle == 1' <<<"$summary")"
  check "the child is deleted" "$([[ $(curl -s -o /dev/null -w '%{http_code}' -u "opencode:$OPENCODE_PASSWORD" -X DELETE "$SERVER/api/session/$child") == 20* ]] && echo true || echo false)"

  scenario "a courier message whose wake was lost is sent again once the child's busy time shows no execution started since; one started since marks it taken (#400)"
  out=$(prompt "COURIER-TEST")
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "the child reported back, waking the parent" "$([ -n "$(reply_time "$parent" "PARENT WOKE" 45)" ] && echo true || echo false)"
  turn_ended "$child"
  turn_ended "$parent"
  api_prompt "$child" "COURIER-HOLD"
  for _ in $(seq 1 30); do [ "$(session_info "$child" | jq -r '.time.busy > .time.idle')" = true ] && break; sleep 1; done
  times=$(session_info "$child" | jq -c '.time')
  echo "  $times"
  check "the prompt started an execution, stamped past the child's last turn's end" "$(jq -r '.busy > .idle' <<<"$times")"
  busy=$(jq -r '.busy' <<<"$times")
  wake_row() { kv get "wake/$1/$2" | jq -r "${@:3}"; }
  stale=msg_courier_e2e_stale
  kv set "wake/$child/$stale" "$(jq -nc --arg from "$parent" --argjson at "$((busy - 60000))" \
    '{at: $at, text: ("<courier from=\"" + $from + "\">STALE</courier>"), running: false, idleAt: $at}')" "report/$child/prompt"
  check "the scheduler marked it as the running execution's to take, and sent nothing" \
    "$(for _ in $(seq 1 20); do [ "$(wake_row "$child" "$stale" '.running')" = true ] && { echo true; exit; }; sleep 1; done; echo false)"
  check "it logged no wake again for it" "$(grep -qF "$stale" "$WORK/server.log" && echo false || echo true)"
  check "and the child's transcript got no message of it" "$(api "session/$child/message" | jq -r --arg id "$stale" 'any(.data[]; .id == $id) | not')"
  kv remove "wake/$child/$stale"
  check "the person interrupts the held turn" "$([[ $(person "session/$child/interrupt") == 20* ]] && echo true || echo false)"
  turn_ended "$child"
  busy=$(session_info "$child" | jq -r '.time.busy // empty')
  check "the child is at rest, its execution ended after it started ($busy)" \
    "$([ -n "$busy" ] && [ "$(session_info "$child" | jq -r '.time.idle >= .time.busy')" = true ] && echo true || echo false)"
  taken() { api "session/$1/message" | jq -r --arg id "$inbox" 'any(.data[]; .id == $id)'; }
  at=$(now_ms)
  text="<courier from=\"$parent\">CHILD-REPORT-NOW</courier>"
  inbox=$(api_post "session/$child/synthetic" "$(jq -nc --arg text "$text" --arg from "$parent" \
    '{text: $text, description: ("Message from " + $from), metadata: {source: "courier", from: $from}, delivery: "steer", resume: false}')" | jq -r '.data.id // empty')
  check "a courier message waits in the idle child's inbox ($inbox)" \
    "$([ -n "$inbox" ] && api "session/$child/inbox" | jq -e --arg id "$inbox" 'any(.data[]; .id == $id)' >/dev/null && echo true || echo false)"
  kv set "wake/$child/$inbox" "$(jq -nc --arg text "$text" --arg from "$parent" --argjson at "$at" \
    '{at: $at, text: $text, description: ("Message from " + $from), running: false, idleAt: $at}')" "report/$child/prompt"
  check "the child's busy time is before the message was enqueued: no execution has started for it" \
    "$(session_info "$child" | jq -r --argjson at "$at" '.time.busy < $at')"
  for _ in $(seq 1 75); do [ "$(taken "$child")" = true ] && break; sleep 1; done
  check "the scheduler woke the child again, which took the message" "$(taken "$child")"
  check "the server log says it was woken again" "$(grep -qF "courier wake: $child left message $inbox waiting while idle; woken again" "$WORK/server.log" && echo true || echo false)"
  check "and the wake again started an execution, stamped at or after the message was enqueued" \
    "$(session_info "$child" | jq -r --argjson at "$at" '.time.busy >= $at')"
  check "the child reported again, waking the parent" "$(has_text "$parent" "CHILD DONE AFTER NUDGE" 45)"
  check "and the watch is over" "$(for _ in $(seq 1 10); do [ -z "$(kv get "wake/$child/$inbox")" ] && { echo true; exit; }; sleep 1; done; echo false)"
  turn_ended "$child"
  turn_ended "$parent"
}

run_spawn_native() {
  scenario "native: true per spawn makes one child a subagent beside a standalone sibling in the same group, with nativeChildren off"
  parent=$(api_post session "{\"location\":{\"directory\":\"$WORK/project\"}}" | jq -r '.data.id')
  api_prompt "$parent" "COURIER-MIXED"
  members=$(for _ in $(seq 1 45); do
    ids=$(texts "$parent" | sed -n 's/.*Started session \(ses_[A-Za-z0-9]*\) in .*/\1/p' | sort -u)
    [ "$(wc -w <<<"$ids")" -eq 2 ] && { echo "$ids"; break; }
    sleep 1
  done)
  check "two children were started in the group" "$([ "$(wc -w <<<"$members")" -eq 2 ] && echo true || echo false)"
  mixed_native=$(for id in $members; do [ "$(session_info "$id" | jq -r '.parentID')" = "$parent" ] && echo "$id"; done | head -1)
  mixed_plain=$(grep -vxF "${mixed_native:-none}" <<<"$members" | head -1)
  check "one has the parent as its OpenCode parentID, with the courier's ruleset, not the parent's, and the other has none" \
    "$([ -n "$mixed_native" ] && [ -n "$mixed_plain" ] && [ "$(session_info "$mixed_native" | jq -r '.permissions == [{ "action": "opencode_schedule_*", "resource": "*", "effect": "deny" }]')" = true ] &&
      [ "$(session_info "$mixed_plain" | jq -r '.parentID == null')" = true ] && echo true || echo false)"
  check "OpenCode lists only the subagent under the parent" \
    "$(api "session?parentID=$parent" | jq -r --arg native "$mixed_native" --arg plain "$mixed_plain" '[.data[].id] | index($native) != null and index($plain) == null')"
  check "the parent's role entry says what OpenCode's own message at the subagent's turn end is, and neither child's does" \
    "$([[ $(role_entry_of "$parent") == "opencode-courier role: root orchestrator"*$'\n'"OpenCode's own message at a turn end:"* ]] &&
      [[ $(role_entry_of "$mixed_native")$(role_entry_of "$mixed_plain") != *"OpenCode's own message at a turn end:"* ]] && echo true || echo false)"
  check "the roster records the subagent as native and the other not, both in the group" \
    "$([ "$(kv get "roster/$parent/$mixed_native" | jq -r '.native == true and .isolated == false and .group == "pair"')" = true ] &&
      [ "$(kv get "roster/$parent/$mixed_plain" | jq -r '(has("native") | not) and .isolated == false and .group == "pair"')" = true ] && echo true || echo false)"
  check "courier_spawn's result says which is the subagent" \
    "$(api "session/$parent/message" | jq -r --arg native "$mixed_native" --arg plain "$mixed_plain" '[.data[] | select(.type == "assistant") | .content[]? | select(.type == "tool" and .name == "courier_spawn") | .state.metadata] |
      (map(select(.sessionID == $native)) | .[0].native == true) and (map(select(.sessionID == $plain)) | .[0] | has("native") | not)')"
  check "the parent was told of both requests: the subagent's as shown by OpenCode, the standalone child's to answer" \
    "$(for _ in $(seq 1 45); do [ "$(notices_with "$parent" asks | jq length)" = 2 ] && break; sleep 1; done
      notices_with "$parent" asks | jq -r --arg native "$mixed_native" --arg plain "$mixed_plain" 'length == 2 and
        (map(select(startswith("<courier from=\"" + $native + "\""))) | length == 1 and (.[0] | contains("shown=\"native\"") and contains("Do not ask them yourself"))) and
        (map(select(startswith("<courier from=\"" + $plain + "\""))) | length == 1 and (.[0] | (contains("shown=") | not) and contains("- once:") and contains("- reject:")))')"
  check "and asked the person nothing itself" "$([ "$(forms_of "$parent")" = 0 ] && echo true || echo false)"
  turn_ended "$parent" 30
  check "courier_children shows the subagent as native, and its sibling not" \
    "$(api_prompt "$parent" "COURIER-CHILDREN $parent"; for _ in $(seq 1 30); do listing=$(api "session/$parent/message" | jq -c '[.data[] | select(.type == "assistant") | .content[]? | select(.type == "tool" and .name == "courier_children") | .state] | last // empty'); [ -n "$listing" ] && [ "$(jq -r '.status' <<<"$listing")" = completed ] && break; sleep 1; done
      jq -r --arg native "$mixed_native" --arg plain "$mixed_plain" '.status == "completed" and (.metadata.children | (map(select(.sessionID == $native)) | .[0].native == true) and (map(select(.sessionID == $plain)) | .[0] | has("native") | not))' <<<"$listing")"
  request=$(api "session/$mixed_native/permission" | jq -r '.data[0].id // empty')
  check "the person answers the subagent's request in OpenCode's own prompt, as the TUI's view of the parent does" \
    "$([ -n "$request" ] && [ "$(person "session/$mixed_native/permission/$request/reply" '{"decision":"once"}')" = 204 ] && echo true || echo false)"
  plain_request=$(api "session/$mixed_plain/permission" | jq -r '.data[0].id // empty')
  api_prompt "$parent" "COURIER-ANSWER once"
  own=$(own_request "$parent" "$plain_request" 30)
  check "the parent proposed once for the standalone child's request with courier_answer, which OpenCode asks the person about in the parent's session, as before" \
    "$([ -n "$plain_request" ] && [ -n "$own" ] && [ "$(person "session/$parent/permission/$own/reply" '{"decision":"once"}')" = 204 ] && echo true || echo false)"
  check "courier_answer passed it on to the standalone child" \
    "$(for _ in $(seq 1 30); do s=$(answer_state "$parent"); [ "$(jq -r '.status == "completed"' <<<"$s")" = true ] && { jq -r --arg plain "$mixed_plain" '.metadata.answered == true and .input.sessionID == $plain' <<<"$s"; exit; }; sleep 1; done; echo false)"
  check "the group delivered one message with both reports, the subagent's and its sibling's" \
    "$([ -n "$(reply_time "$parent" "PARENT GOT GROUP" 60)" ] && notices_with "$parent" group | jq -r --arg native "$mixed_native" --arg plain "$mixed_plain" 'length == 1 and (.[0] |
      contains("reports=\"2\"") and (split("CHILD DONE shell") | length == 3) and contains($native) and contains($plain))')"
  check "the parent was told once that the subagent's request is settled, and asked nothing" \
    "$([ "$(notices_with "$parent" answered | jq -r --arg native "$mixed_native" 'length == 1 and (.[0] | startswith("<courier from=\"" + $native + "\"") and contains("answered=\"once\""))')" = true ] &&
      [ "$(forms_of "$parent")" = 0 ] && echo true || echo false)"

  scenario "native: true with isolate: true is refused, and nothing is started"
  worktrees=$(git -C "$WORK/project" worktree list | wc -l)
  out=$(prompt "COURIER-NATIVE-ISOLATE")
  check "courier_spawn refused it, naming both and what to do" \
    "$(tool_state courier_spawn <<<"$out" | jq -r '.status == "error" and (.error | contains("native: true and isolate: true cannot go together") and contains("never both"))')"
  check "no worktree was made" "$([ "$(git -C "$WORK/project" worktree list | wc -l)" = "$worktrees" ] && echo true || echo false)"

  scenario "deleting the parent deletes its subagent, not the standalone sibling"
  check "the parent is deleted" \
    "$([[ $(curl -s -o /dev/null -w '%{http_code}' -u "opencode:$OPENCODE_PASSWORD" -X DELETE "$SERVER/api/session/$parent") == 20* ]] && echo true || echo false)"
  check "and with it the subagent" "$([ "$(status_of "$mixed_native")" = 404 ] && echo true || echo false)"
  check "whose report state is gone" \
    "$(for _ in $(seq 1 20); do [ -z "$(kv get "report/$mixed_native/prompt")$(kv get "report/$mixed_native/settled")" ] && { echo true; exit; }; sleep 1; done; echo false)"
  check "the standalone sibling is still there" "$([ "$(status_of "$mixed_plain")" = 200 ] && echo true || echo false)"
}

run_native() {
  scenario "nativeChildren: a child started without isolate gets OpenCode's own parentID"
  child_delay 1000
  stop_server
  jq '.plugins[0].options.nativeChildren = true' "$WORK/project/opencode.json" >"$WORK/project/opencode.json.new"
  mv "$WORK/project/opencode.json.new" "$WORK/project/opencode.json"
  git -C "$WORK/project" -c user.email=e2e@example.com -c user.name=e2e commit -qam "nativeChildren"
  start_server
  native_parent=$(api_post session "{\"location\":{\"directory\":\"$WORK/project\"}}" | jq -r '.data.id')
  api_prompt "$native_parent" "COURIER-TEST"
  native_child=$(spawned_by "$native_parent" 45)
  check "the parent started a child" "$([ -n "$native_child" ] && echo true || echo false)"
  info=$(session_info "$native_child")
  check "the child's OpenCode parentID is its parent, and courier's metadata is kept" \
    "$(jq -r --arg parent "$native_parent" '.parentID == $parent and .metadata.courier.parentID == $parent' <<<"$info")"
  check "it has the courier's ruleset of its own" "$(jq -r '.permissions == [{ "action": "opencode_schedule_*", "resource": "*", "effect": "deny" }]' <<<"$info")"
  check "OpenCode lists it under its parent" \
    "$(api "session?parentID=$native_parent" | jq -r --arg child "$native_child" '[.data[].id] | index($child) != null')"
  check "the roster records it as native" "$(kv get "roster/$native_parent/$native_child" | jq -r '.native == true and .isolated == false')"
  check "it reported back, waking the parent" "$([ -n "$(reply_time "$native_parent" "PARENT WOKE" 45)" ] && echo true || echo false)"
  check "OpenCode told the parent of the child's turn end too, in a message of its own" \
    "$(for _ in $(seq 1 30); do api "session/$native_parent/message" | jq -e --arg child "$native_child" '[.data[] | select(.type == "synthetic" and .metadata.source == "subagent" and .metadata.childID == $child)] | length >= 1' >/dev/null && { echo true; exit; }; sleep 1; done; echo false)"

  check "from its first spawn every request of the parent carries, once, what OpenCode's own message is, the same bytes on the request that message starts" \
    "$(for _ in $(seq 1 30); do jq -sre --arg parent "$native_parent" '[.[] | select(.session == $parent and (.tools | length > 0))] | (map(.hostReports | length > 0) | index(true)) as $i
      | $i != null and $i > 0 and (.[:$i] | all(.hostReports == [])) and (.[$i].hostReports as $first | ($first | length == 1) and (.[$i:] | all(.hostReports == $first) and any(.hostMessage)))' "$WORK/model.log" >/dev/null && { echo true; exit; }; sleep 1; done; echo false)"
  check "the child, which can start sessions, has it in its role entry on every request, and the parent's role entry holds it" \
    "$([[ $(role_entry_of "$native_parent") == "opencode-courier role: root orchestrator"*$'\n'"OpenCode's own message at a turn end:"* ]] &&
      jq -sr --arg child "$native_child" '[.[] | select(.session == $child and (.tools | length > 0))] | length > 0 and (.[0].hostReports | length == 1) and all(.roleEntry) and (map(.hostReports) | unique | length == 1)' "$WORK/model.log" | grep -qx true && echo true || echo false)"
  scenario "nativeChildren: an isolated child is created as before, without a parentID"
  child_delay 1000
  out=$(prompt "COURIER-TEST isolate")
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "it has no parentID and runs in its worktree" \
    "$(session_info "$child" | jq -r '.parentID == null and (.location.directory | contains("/worktree/"))')"
  check "the roster does not record it as native" "$(kv get "roster/$parent/$child" | jq -r 'has("native") | not')"
  check "it reported back" "$([ -n "$(reply_time "$parent" "PARENT WOKE" 45)" ] && echo true || echo false)"

  scenario "nativeChildren: a child does not run on its parent's session rules; its request is answered in OpenCode's own prompt"
  rules='[{"action":"shell","resource":"echo courier-asks*","effect":"allow"}]'
  parent=$(api_post session "{\"location\":{\"directory\":\"$WORK/project\"},\"permissions\":$rules}" | jq -r '.data.id')
  inherited=$(api_post session "{\"parentID\":\"$parent\"}" | jq -r '.data.id')
  check "a session created under it without a ruleset would run on the parent's" \
    "$(session_info "$inherited" | jq -r --argjson rules "$rules" '.permissions == $rules')"
  api_prompt "$parent" "COURIER-ASK"
  child=$(spawned_by "$parent" 45)
  check "the child, created with the courier's ruleset, does not" \
    "$(session_info "$child" | jq -r --arg parent "$parent" '.parentID == $parent and .permissions == [{ "action": "opencode_schedule_*", "resource": "*", "effect": "deny" }]')"
  check "so it asks, and the parent is told once, that OpenCode shows the request to the person" \
    "$(has_text "$parent" "PARENT TOLD NATIVE PERMISSION" 45 >/dev/null; notices_with "$parent" asks | jq -r 'length == 1 and (.[0] | contains("shown=\"native\"") and contains("Do not ask them yourself"))')"
  check "and asks the person nothing itself" "$([ "$(forms_of "$parent")" = 0 ] && echo true || echo false)"
  request=$(api "session/$child/permission" | jq -r '.data[0].id // empty')
  check "the person answers in OpenCode's own prompt, as the TUI's view of the parent does" \
    "$([ -n "$request" ] && [ "$(person "session/$child/permission/$request/reply" '{"decision":"once"}')" = 204 ] && echo true || echo false)"
  check "the command ran, and the child reported back" "$(has_text "$parent" "CHILD DONE shell" 45)"
  check "the parent was told once that it is settled, and asked nothing" \
    "$(has_text "$parent" "CHILD DONE shell" 45 >/dev/null; [ "$(notices_with "$parent" answered | jq -r 'length == 1 and (.[0] | contains("answered=\"once\""))')" = true ] &&
      [ "$(notices_with "$parent" asks | jq length)" = 1 ] && [ "$(forms_of "$parent")" = 0 ] && echo true || echo false)"

  scenario "nativeChildren: a native grandchild's question is answered in OpenCode's own form, and the top session is only told"
  parent=$(api_post session "{\"location\":{\"directory\":\"$WORK/project\"}}" | jq -r '.data.id')
  api_prompt "$parent" "COURIER-QUESTION nested"
  middle=$(spawned_by "$parent" 45)
  leaf=$(spawned_by "$middle" 45)
  leaf_form=$(form_of "$leaf" "" 60)
  check "the grandchild is a native child of the child, which is one of the top, and shows its question" \
    "$([ -n "$leaf_form" ] && [ "$(session_info "$leaf" | jq -r '.parentID')" = "$middle" ] && [ "$(session_info "$middle" | jq -r '.parentID')" = "$parent" ] && echo true || echo false)"
  check "the top session was told once, as a question OpenCode shows the person" \
    "$(has_text "$parent" "PARENT TOLD NATIVE QUESTION" 45 >/dev/null; notices_with "$parent" asks | jq -r 'length == 1 and (.[0] | contains("shown=\"native\"") and contains("Do not ask them yourself"))')"
  check "and asks the person nothing itself" "$([ "$(forms_of "$parent")" = 0 ] && echo true || echo false)"
  check "the person answers the grandchild's form, as the TUI's view of the top session does" "$(answer_form "$leaf" "$leaf_form" '"Hey"')"
  check "the grandchild got it and reported to the child" "$(has_text "$middle" 'CHILD GOT [["Hey"]]' 45)"
  turn_ended "$leaf"
  turn_ended "$middle"
  check "OpenCode's report of the grandchild's turn reached the child, and the child owes no report for it" \
    "$(api "session/$middle/message" | jq -r --arg leaf "$leaf" '[.data[] | select(.type == "synthetic" and .metadata.source == "subagent" and .metadata.childID == $leaf)] | length >= 1')"
  check "so the turn it started told the top session nothing: it heard once that the child ended without a report, for the grandchild's report" \
    "$(has_text "$middle" "NOTED CHILD TURN END" 30 >/dev/null; turn_ended "$middle"; sleep 2; notices_with "$parent" ended | jq -r 'map(select(contains("ended=\"without-report\""))) | length == 1')"
  check "the top session was told once that it is settled, and asked nothing" \
    "$(has_text "$parent" "PARENT SETTLED" 45 >/dev/null; [ "$(notices_with "$parent" answered | jq -r 'length == 1 and (.[0] | contains("answered=\"elsewhere\""))')" = true ] &&
      [ "$(notices_with "$parent" asks | jq length)" = 1 ] && [ "$(forms_of "$parent")" = 0 ] && echo true || echo false)"

  scenario "nativeChildren: an isolated child's question is still linked to the top session's"
  ask_question "COURIER-QUESTION isolate"
  check "the person answers in the parent's session" "$(answer_form "$parent" "$parent_form" '"Hi"')"
  check "the child got it and reported back" "$(has_text "$parent" 'CHILD GOT [["Hi"]]' 45)"

  scenario "nativeChildren: deleting a parent deletes its native children, and their report state goes"
  check "the child's roster entry and report state are there" \
    "$([ -n "$(kv get "roster/$native_parent/$native_child")" ] && [ -n "$(kv get "report/$native_child/settled")" ] && echo true || echo false)"
  check "the parent is deleted" \
    "$([[ $(curl -s -o /dev/null -w '%{http_code}' -u "opencode:$OPENCODE_PASSWORD" -X DELETE "$SERVER/api/session/$native_parent") == 20* ]] && echo true || echo false)"
  check "and with it the child" "$([ "$(status_of "$native_child")" = 404 ] && echo true || echo false)"
  check "whose report state is gone, as for any deleted child" \
    "$(for _ in $(seq 1 20); do [ -z "$(kv get "report/$native_child/prompt")$(kv get "report/$native_child/settled")" ] && { echo true; exit; }; sleep 1; done; echo false)"
}

run_decline_seal() {
  scenario "a group whose last member reports after a plain decline ended the parent's turn is released to the parent (#465)"
  child_delay 15000
  parent=$(api_post session "{\"location\":{\"directory\":\"$WORK/project\"}}" | jq -r '.data.id')
  api_prompt "$parent" "COURIER-GROUP-DECLINE"
  member=$(for _ in $(seq 1 30); do
    id=$(texts "$parent" | sed -n 's/.*Started session \(ses_[A-Za-z0-9]*\) in .*/\1/p' | head -1)
    [ -n "$id" ] && { echo "$id"; break; }
    sleep 1
  done)
  own=$(for _ in $(seq 1 30); do
    id=$(api "session/$parent/permission" | jq -r '[.data[] | select(.action == "shell" and .resources == ["echo courier-asks top"]) | .id] | first // empty')
    [ -n "$id" ] && { echo "$id"; break; }
    sleep 1
  done)
  check "in one step, the parent started a member in group pair and asks the person to run a command" \
    "$([ -n "$member" ] && [ -n "$own" ] && [ "$(kv get "group/$parent/pair/$member" | jq -r 'has("report") | not')" = true ] && echo true || echo false)"
  check "the person declines the parent's own request, without a reason" \
    "$([ "$(person "session/$parent/permission/$own/reply" '{"decision":"reject"}')" = 204 ] && echo true || echo false)"
  for _ in $(seq 1 30); do [ "$(api "session/$parent/context" | jq -r '.data | last | .error.type == "aborted"')" = true ] && break; sleep 1; done
  check "its transcript ends on the interrupted step, and it has no idle time" \
    "$([ "$(api "session/$parent/context" | jq -r '.data | last | .type == "assistant" and .error.type == "aborted"')" = true ] &&
      [ "$(session_info "$parent" | jq -r '.time.idle == null')" = true ] && echo true || echo false)"
  check "the member's report is not in yet" "$([ "$(kv get "report/$member/settled" | jq -r '.by // empty')" != report ] && echo true || echo false)"
  check "once the member reports, the group reaches the parent in one message, which starts a turn" \
    "$([ -n "$(reply_time "$parent" "PARENT GOT GROUP" 60)" ] && notices_with "$parent" group | jq -r --arg member "$member" 'length == 1 and (.[0] |
      startswith("<courier from=\"" + $member + "\" group=\"pair\" reports=\"1\">") and contains("CHILD DONE"))')"
  check "and the group is gone from storage" "$([ -z "$(kv get "group/$parent/pair/$member")" ] && echo true || echo false)"
  turn_ended "$parent"
  check "the parent is deleted" "$([[ $(curl -s -o /dev/null -w '%{http_code}' -u "opencode:$OPENCODE_PASSWORD" -X DELETE "$SERVER/api/session/$parent") == 20* ]] && echo true || echo false)"
}

run_plugin_add() {
  scenario "opencode plugin add installs the packed package and its tools load"
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
  "$OPENCODE" service stop >/dev/null 2>&1 </dev/null || true
  check "plugin add installed it" "$([ "$added" = ok ] && echo true || echo false)"
  check "and added it to the global config" \
    "$(jq -r '.plugins | index("opencode-courier") != null' "$XDG_CONFIG_HOME/opencode/opencode.json" 2>/dev/null || echo false)"
  jq 'del(.plugins)' "$WORK/project/opencode.json" >"$WORK/project/opencode.json.new"
  mv "$WORK/project/opencode.json.new" "$WORK/project/opencode.json"
  log_start=$(($(wc -l <"$WORK/server.log") + 1))
  start_server
  out=$(prompt "COURIER-CHILDREN ses_missing")
  check "its courier_children tool runs" "$(tool_state courier_children <<<"$out" | jq -r '.status == "completed" and (.metadata.metadata.children | length == 0)')"
  entrypoint=$(tail -n +"$log_start" "$WORK/server.log" |
    sed -n 's|.*msg="loading plugin" id=opencode-courier entrypoint=file://\([^ ]*/node_modules/opencode-courier/dist/index\.js\).*|\1|p' | head -1 || true)
  check "loaded from the installed package" "$([ -n "$entrypoint" ] && echo true || echo false)"
  integrity="sha512-$(openssl dgst -sha512 -binary "$tarball" | base64 | tr -d '\n')"
  locked=$(jq -r '.packages["node_modules/opencode-courier"] | "\(.resolved) \(.integrity)"' \
    "${entrypoint%/node_modules/opencode-courier/dist/index.js}/package-lock.json" 2>/dev/null || true)
  check "built from the packed tarball" \
    "$([ "$locked" = "http://127.0.0.1:$REGISTRY_PORT/opencode-courier/-/$(basename "$tarball") $integrity" ] && echo true || echo false)"

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

  pin=$(jq -r '.devDependencies["@opencode/plugin"]' "$ROOT/package.json")
  host=$(host_version)
  check "the plugin's log lines reach the server log" "$(grep -qF "courier watch: following" "$WORK/server.log" && echo true || echo false)"
  if [ "$host" = "$pin" ]; then
    echo "the server log names no version mismatch: OpenCode $host is the pinned version"
    check "no line says the version differs" "$(grep -qF "was built and tested against OpenCode" "$WORK/server.log" && echo false || echo true)"
  else
    echo "the server log names the version mismatch: OpenCode $host is not the pinned $pin"
    check "a line names the pin and this server's version" \
      "$(grep -qF "was built and tested against OpenCode $pin; this server is $host (" "$WORK/server.log" && echo true || echo false)"
  fi
  check "no line says the versions could not be compared" "$(grep -qF "cannot compare the OpenCode version" "$WORK/server.log" && echo false || echo true)"
}

run_epilogue() {
  scenario "the work an unloading instance started finished before its location closed"
  check "no prune, cut-off notice or pending relay failed" \
    "$(grep -qE "courier roster prune:|courier question: stored questions:|courier watch: could not relay pending requests:" "$WORK/server.log" && echo false || echo true)"
}

for group in $GROUP_LIST; do
  group_start=$SECONDS
  "run_${group//-/_}"
  end_scenario
  echo "group $group: $((SECONDS - group_start)) s"
done
run_epilogue

[ -s "$WORK/stalled" ] && failures=$((failures + $(wc -l <"$WORK/stalled")))
if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed; rerun with KEEP=1 to keep the server and model logs"
  exit 1
fi
echo "all checks passed"
