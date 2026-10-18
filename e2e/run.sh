#!/usr/bin/env bash
# Live end-to-end test: a real OpenCode V2 server with this plugin loaded, driven by a scripted
# stand-in model (e2e/mock-model.mjs), so no API key is needed.
#
#   OPENCODE_BIN=/path/to/opencode e2e/run.sh      # KEEP=1 keeps the temp dir and logs
#   E2E_SHARD=2/4 e2e/run.sh   # one of four shards; E2E_GROUPS=a,b only those groups; E2E_PLAN=1 prints the plan
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

# Each scenario's heading is `scenario "<title>"`, which ends the one before and times it: the timings
# print as the run ends (on a failure too), the slowest first.
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
# How long the mock model holds a child's reply back from now on, in ms: a scenario that does not need
# the parent to be idle when it lands asks for less right after its heading, and the next heading resets it.
child_delay() { printf '%s' "$1" >"$WORK/child-delay"; }
print_timings() {
  [ -s "$TIMINGS" ] || return 0
  echo
  echo "scenario timings, slowest first (total $(awk -F'\t' '{ sum += $1 } END { print sum }' "$TIMINGS") s)"
  sort -t$'\t' -k1,1nr "$TIMINGS" | awk -F'\t' '{ printf "%5d s  %s\n", $1, $2 }'
}

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

tool_state() { jq -c --arg tool "$1" 'select(.type == "tool_use" and .part.tool == $tool) | .part.state'; }
# The parent's synthetic messages whose envelope carries attribute $2, from session $1.
notices_with() { api "session/$1/message" | jq -c --arg attribute " $2=" '[.data[] | select(.type == "synthetic") | .text | select(contains($attribute))]'; }
kv() { XDG_DATA_HOME=$XDG_DATA_HOME bun "$ROOT/e2e/kv.ts" "$@"; }
# The texts of session $1: what it was sent, what it replied and what its tools returned.
texts() {
  api "session/$1/message" |
    jq -r '.data[] | (.text // empty), (.content[]? | (.text // empty), (.state.content[]?.text // empty),
      (.state.output? // empty | if type == "string" then . else tojson end))'
}
# Waits until session $1's turn has ended, up to $2 (default 30) s, then a second for the plugin to handle
# that event: the point a session that never gets a notice would have got it, for a "not told" check.
turn_ended() {
  for _ in $(seq 1 $((${2:-30} * 2))); do
    [ "$(finished "$1")" = true ] && { sleep 1; return 0; }
    sleep 0.5
  done
  echo "turn_ended: session $1 did not end its turn in ${2:-30} s" >&2
  sleep 1
}
# Whether session $1 has a text containing $2, waiting up to $3 (default 30) s.
has_text() {
  for _ in $(seq 1 "${3:-30}"); do
    if texts "$1" | grep -qF -- "$2"; then echo true; return; fi
    sleep 1
  done
  echo false
}

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
api_post() { curl -sf -u "opencode:$OPENCODE_PASSWORD" -X POST -H 'content-type: application/json' --data "$2" "$SERVER/api/$1"; }
# A turn of session $1 with text $2 through the API: `opencode run --auto` answers a request in its own session itself,
# and takes a native child's asks for its own and answers them.
api_prompt() { api_post "session/$1/prompt" "{\"text\":\"$2\"}" >/dev/null; }
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
# The limits count live sessions: a finished one's last turn ended after anything reached it, and
# one that has reported owes no report, its report settled after its last prompt.
finished() { api "session/$1" | jq -r '(.data // .) | .time.idle != null and .time.updated <= .time.idle'; }
reported() {
  local prompted settled
  prompted=$(kv get "report/$1/prompt" | jq -r '.at // empty')
  settled=$(kv get "report/$1/settled" | jq -r 'select(.by == "report") | .at // empty')
  [ -n "$prompted" ] && [ -n "$settled" ] && [ "$settled" -ge "$prompted" ] && echo true || echo false
}
# Whether session $1 took the notice of request $2 answered elsewhere in the same turn as its child's report, with no reply of its own between.
settled_with_report() {
  api "session/$1/message" | jq -r --arg request "$2" '.data | sort_by(.id) as $m |
    ([range(0; $m | length) | select($m[.].type == "synthetic" and ($m[.].text | contains(" answered=\"") and contains("request=\"" + $request + "\"")))] | first) as $s |
    ([range(0; $m | length) | select($m[.].type == "synthetic" and ($m[.].text | contains("CHILD DONE")))] | first) as $r |
    $s != null and $r != null and $r > $s and ([$m[$s:$r][] | select(.type == "assistant")] | length == 0)'
}
# The state of the last courier_answer call of session $1, from its transcript.
answer_state() {
  api "session/$1/message" | jq -c '[.data[] | select(.type == "assistant") | .content[]? | select(.type == "tool" and .name == "courier_answer") | .state] | last // empty'
}
# The request OpenCode asks the person in session $1 for request $2 of a child, waiting up to $3 (default 30) s.
own_request() {
  for _ in $(seq 1 "${3:-30}"); do
    local id
    id=$(api "session/$1/permission" | jq -r --arg request "$2" '[.data[] | select(.metadata.requestID == $request) | .id] | first // empty')
    if [ -n "$id" ]; then echo "$id"; return; fi
    sleep 1
  done
}
# The roster's reverse index, read straight from OpenCode's database.
indexed_under() { kv get "roster-by-child/$1" | jq -r '.ancestors[0] // empty'; }
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
# The TUI's asks inbox (#144): it reads the tree over the person's RPC and answers over the routes the
# TUI's client takes (e2e/tui.sh drives the TUI itself): a permission request through OpenCode's reply,
# a question through the RPC's answer method. The parent hears each settled once, and is not asked again.
# The person's RPC method $1 with input $2, at the project's location.
inbox() {
  curl -s -u "opencode:$OPENCODE_PASSWORD" -X POST "$SERVER/api/rpc/courier-person/$1?directory=$(node -p 'encodeURIComponent(process.argv[1])' "$WORK/project")" \
    -H 'content-type: application/json' -d "{\"input\":$2}"
}
session_info() { api "session/$1" | jq -c '.data // .'; }
# The session session $1 started with courier_spawn, waiting up to $2 (default 30) s.
spawned_by() {
  for _ in $(seq 1 "${2:-30}"); do
    local id
    id=$(texts "$1" | sed -n 's/.*Started session \(ses_[A-Za-z0-9]*\) in .*/\1/p' | head -1)
    if [ -n "$id" ]; then echo "$id"; return; fi
    sleep 1
  done
}
status_of() { curl -s -o /dev/null -w '%{http_code}' -u "opencode:$OPENCODE_PASSWORD" "$SERVER/api/session/$1"; }
# Each group is a function `run_<name>` that needs no other; the weight is the seconds it took in CI.
# `restart-question` and `roster` restart the server and share a shard; `epilogue` ends every run.
SUITE="reports:81 reports-groups:91 permission:35 depth:4 answer:37 search:11 questions:65 questions-more:75 restart-question:13 probe:10 skill:1 later:23 wake:70 roster:36 webhook:10 cleanup:4 subtree:2 nest:6 stall:150 inbox:37 memory:15 native:41 plugin-add:14"
BOUND="restart-question roster"

# The groups of shard $1 of $2: the heaviest unit (a group, or the bound pair) goes to the lightest shard
# so far, and each shard keeps the order of a full run.
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
    grep -xF -f <(tr ',' '\n' <<<"$E2E_GROUPS") <<<"$all" || true
  elif [ -n "${E2E_SHARD:-}" ]; then
    [[ $E2E_SHARD =~ ^([1-9][0-9]*)/([1-9][0-9]*)$ && ${BASH_REMATCH[1]} -le ${BASH_REMATCH[2]} ]] ||
      { echo "E2E_SHARD must be k/n with 1 <= k <= n, not $E2E_SHARD" >&2; exit 2; }
    shard_groups "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
  else
    echo "$all"
  fi
}
GROUP_LIST=$(selected_groups) || exit 2
# E2E_PLAN=1 prints the groups this run would go through, and runs nothing.
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

  scenario "courier_status"
  out=$(prompt "COURIER-STATUS $parent")
  check "reports the parent's last reply" "$(jq -r 'select(.type == "tool_use") | .part.state | .status == "completed" and (.output | contains("PARENT WOKE"))' <<<"$out")"
  out=$(prompt "COURIER-STATUS ses_missing")
  check "names the error for an unknown session" "$(jq -r 'select(.type == "tool_use") | .part.state.error | contains("NotFoundError")' <<<"$out")"

  scenario "a child runs on its parent's model, not the default one"
  out=$(cd "$WORK/project" && "$OPENCODE" run --server "$SERVER" --auto --format json --model mock/other "COURIER-TEST" </dev/null)
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
    "$(turn_ended "$child"; notices_with "$parent" ended | jq -r 'length == 1')"

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
  check "and its reported turn was not told as one without a report" "$(turn_ended "$child"; notices_with "$parent" ended | jq -r 'length == 1')"

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
  check "and its parent was not told again" "$(turn_ended "$child"; notices_with "$parent" ended | jq -r 'length == 1')"

  scenario "what the person types in a child that has reported does not make it owe a report"
  out=$(prompt "COURIER-TEST")
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "the child reported" "$([ -n "$(reply_time "$parent" "PARENT WOKE")" ] && echo true || echo false)"
  prompt_in "$child" "PERSON-ASKS" >/dev/null
  check "the child answered the person in its own session" "$([ -n "$(reply_time "$child" "CHILD ANSWERS PERSON")" ] && echo true || echo false)"
  check "and its parent was not told it ended without a report" "$(turn_ended "$child"; notices_with "$parent" ended | jq -r 'length == 0')"

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
  check "the parent got exactly one message, with both reports" "$(sleep 2; api "session/$parent/message" | jq -r '[.data[] | select(.type == "synthetic") | .text] |
    length == 1 and (.[0] | contains("reports=\"2\"") and (split("CHILD DONE QUICKLY") | length == 3))')"

  scenario "a sub-orchestrator whose group reports during its turn gets it once that turn ends, and is not told of as silent"
  out=$(prompt "COURIER-GROUP-NESTED")
  root=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  middle=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "the middle session reported its group's message on to the root" "$(has_text "$root" "MIDDLE GOT GROUP" 60)"
  check "it got exactly one message, with both of its leaves' reports" "$(api "session/$middle/message" | jq -r '[.data[] | select(.type == "synthetic") | .text] |
    length == 1 and (.[0] | contains("reports=\"2\"") and (split("CHILD DONE QUICKLY") | length == 3))')"
  check "and the root was not told it ended without a report" "$(turn_ended "$middle"; notices_with "$root" ended | jq -r 'length == 0')"

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
  check "it is still listed" "$(sleep 3; [ "$(child_listing "$parent" "$child")" = listed ] && echo true || echo false)"
  check "and its worktree is still there for courier_cleanup" "$([ -d "$directory" ] && echo true || echo false)"

  scenario "a child that ends its turn to wait for a message it scheduled is not reported, and reports once woken"
  out=$(prompt "COURIER-WAITING")
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "the scheduled message woke the child, which reported" "$([ -n "$(reply_time "$parent" "PARENT WOKE" 75)" ] && echo true || echo false)"
  check "the child's first turn, which ended waiting, was not told" "$(turn_ended "$child"; notices_with "$parent" ended | jq -r 'length == 0')"
  check "the child scheduled the message in its first turn" \
    "$(api "session/$child/message" | jq -r '[.data[] | select(.type == "assistant") | .content[]? | select(.type == "tool" and .name == "courier_later")] | length == 1')"
}

run_permission() {
  for mode in shared isolate; do
    scenario "a child's permission request reaches its idle parent, and the answer goes back ($mode)"
    ask_permission "$([ "$mode" = isolate ] && echo isolate)"
    check "with what it asks for and the choices" "$(jq -r --arg child "$child" '.[0] // "" |
      contains("<courier from=\"" + $child + "\" asks=\"permission\"") and contains("It asks for: shell") and
      contains("echo courier-asks") and contains("- once:") and contains("- reject:") and contains("You cannot decide this") and (contains("- always") | not)' <<<"$notice")"
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
  # With maxDepth 2, a child starts two leaves; one tries courier_spawn as its tool list stands, the
  # other once the probe plugin has put the tool back, so OpenCode refuses the first and courier the second.
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
  # The child in between never reports: its turns end while its leaves owe it reports, and once more after.
  check "the root was told once that the child in between ended without a report, once its leaves had reported" \
    "$(has_text "$root" "PARENT TOLD SILENT" 60 >/dev/null; turn_ended "$middle"; notices_with "$root" ended | jq -r --arg middle "$middle" 'length == 1 and (.[0] | contains("<courier from=\"" + $middle + "\" ended="))')"
  check "every request of a leaf was named a leaf, and the courier's hook left it no courier_spawn, courier_recall or courier_note" \
    "$(jq -sr --argjson leaves "$leaves" '[.[] | select(.type == "probe.context" and (.sessionID | IN($leaves[])))]
      | length > 0 and all(.role == "leaf" and (.tools | index("courier_spawn") | not) and (.tools | index("courier_recall") | not) and (.tools | index("courier_note") | not) and (.tools | index("courier_send")))' "$WORK/probe.log")"
  check "the model saw no courier_spawn in a leaf's tool list unless the probe put it back" \
    "$(jq -sr --argjson leaves "$leaves" '[.[] | select((.session | IN($leaves[])) and (.tools | length > 0))] | group_by(.session)
      | map(any(.tools | index("courier_spawn"))) | sort == [false, true]' "$WORK/model.log")"
  check "the child in between is a sub-orchestrator, with courier_spawn, courier_recall and courier_note" \
    "$(jq -sr --arg middle "$middle" '[.[] | select(.session == $middle and (.tools | length > 0))] | length > 0 and all(.role == "sub-orchestrator" and (.tools | index("courier_spawn")) and (.tools | index("courier_recall")) and (.tools | index("courier_note")))' "$WORK/model.log")"
  # A root's prompt changes once, at its first spawn: the pointer to the skill before, the role part after.
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

run_answer() {
  # A proposed once goes through permission.assert in the parent's session (#164), where OpenCode asks the person; the
  # parent's turn runs through the API, since `opencode run --auto` answers the parent's own prompt itself, as above.
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
      [ "$(has_text "$parent" "TOOL DONE courier_answer" 1)" != true ] && echo true || echo false)"
}

run_search() {
  # The first web search of this run: no provider has been chosen, which OpenCode keeps for every session.
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
  check "courier_status shows the child waiting on it" "$(prompt "COURIER-STATUS $child" | tool_state courier_status |
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
  # Within the two seconds the dismissal is held, over the API as a prompt from the TUI would come
  # (opencode run cancels the question form it opens).
  check "the parent is prompted to ask again" "$([[ $(person "session/$parent/prompt" '{"text":"COURIER-ASK-AGAIN"}') == 20* ]] && echo true || echo false)"
  check "the parent's new question was withdrawn, saying the child carries on without the answers" \
    "$(has_text "$parent" "already dismissed in your session, so it carries on without the answers" 45)"
  check "and no longer shown" "$([ "$(forms_of "$parent")" = 0 ] && echo true || echo false)"
  check "the child was told, carried on and reported" "$(has_text "$parent" "CHILD DISMISSED" 45)"

  # A model slip: the parent asks the person and calls courier_answer in the same step, so its
  # question is linked and answered at once.
  scenario "the parent asks the person and calls courier_answer in one step: its question is withdrawn, and the courier_answer pick counts"
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

  scenario "the child's turn is stopped while the parent asks the person; their answer reaches it as a message"
  ask_question COURIER-QUESTION
  check "the child's turn is interrupted" "$([[ $(person "session/$child/interrupt") == 20* ]] && echo true || echo false)"
  check "the child's question is no longer shown" "$(for _ in $(seq 1 15); do [ "$(forms_of "$child")" = 0 ] && { echo true; exit; }; sleep 1; done; echo false)"
  check "the person answers in the parent's session" "$(answer_form "$parent" "$parent_form" '"Hello"')"
  check "the parent's question passed it on as a message" "$(has_text "$parent" "as a message, since its question had been cut off")"
  check "which woke the child, and it carried on" "$(has_text "$parent" 'CHILD GOT [["Hello"]]' 45)"

  # What OpenCode's inactivity sweep does to a location after an hour: it interrupts every turn there.
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
  # Whether every plugin instance follows an isolated child's events, whichever location they come
  # from: e2e/probe-plugin, loaded next to the courier in every location, logs each event its
  # instance sees through event.subscribe(), as the courier's watcher follows them. The child, in
  # its own worktree, asks for a permission, shows two question forms, one answered in its own
  # session and one withdrawn by the relay when the person answers in the parent's, and then fails.
  scenario "an isolated child's events reach the plugin instance of every location"
  child_delay 1000
  canonical() { node -p 'require("node:fs").realpathSync(process.argv[1])' "$1"; }
  # A shard that has run no isolated child yet starts one, for the third location below.
  [ -n "$(git -C "$WORK/project" worktree list --porcelain | sed -n 's/^worktree //p' | sed -n 2p)" ] || spawn_isolated
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
  check "the model loaded it with the skill tool and got the playbook" \
    "$(tool_state skill <<<"$out" | jq -r '.status == "completed" and (.output | tojson | contains("Never start exactly one session") and contains("Never hand the checking to another session"))')"
  # The person attaches the skill to a prompt, as the TUI's /skills dialog does, and its text goes to the model with the prompt.
  check "attached to the person's prompt, its text reached the model" \
    "$([[ $(person "session/$session/prompt" '{"text":"COURIER-SKILL-ATTACHED","skills":[{"id":"courier-orchestrate"}]}') == 20* ]] && has_text "$session" "SKILL SEEN" 30)"
}

run_wake() {
  scenario "a courier message left waiting in an idle session, its wake missed, is sent again under its inbox id and wakes it (#218)"
  out=$(prompt "COURIER-TEST")
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  check "the child's report woke the parent" "$(has_text "$parent" "PARENT WOKE" 45)"
  turn_ended "$parent" >/dev/null
  # resume: false enqueues without waking the session, as a missed wake leaves a message.
  inbox=$(api_post "session/$parent/synthetic" \
    '{"text":"<courier from=\"ses_e2e\">WAKE AGAIN</courier>","description":"Message from ses_e2e","metadata":{"source":"courier","from":"ses_e2e"},"delivery":"steer","resume":false}' |
    jq -r '.data.id // empty')
  check "a courier message was enqueued for the idle parent ($inbox)" "$([ -n "$inbox" ] && echo true || echo false)"
  delivered() { api "session/$parent/message" | jq -r --arg id "$inbox" '[.data[] | select(.id == $id)] | length'; }
  sleep 5
  check "no turn took it: it waits in the parent's inbox" \
    "$([ "$(delivered)" = 0 ] && api "session/$parent/inbox" | jq -e --arg id "$inbox" 'any(.data[]; .id == $id)' >/dev/null && echo true || echo false)"
  check "the courier watches it, waiting in an idle session" "$(kv get "wake/$parent/$inbox" | jq -r '.running == false')"
  # Missed after WAKE_MS (30 s), found at the scheduler's next tick, up to 15 s later.
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
  check "courier_cancel cancelled it" "$(tool_state courier_cancel <<<"$out" | jq -r '.status == "completed" and (.output | startswith("Cancelled"))')"
  # Messages are delivered at the scheduler's tick, up to 15 s after they are due: a second, uncancelled one in
  # another session shows a tick came after the first was due, and delivered what was due then.
  witness=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$(prompt "COURIER-LATER 0.05")" | head -1)
  check "an uncancelled message, scheduled next, was delivered at the tick" "$([ -n "$(reply_time "$witness" "PARENT WOKE" 45)" ] && echo true || echo false)"
  sleep 2
  woke=$(reply_time "$parent" "PARENT WOKE" 1)
  check "the cancelled message never arrived" "$([ -z "$woke" ] && echo true || echo false)"
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
  # Another server on this data directory, as it would have renewed the key 40 s ago: it expires
  # 20 s from now, and until then this server's scheduler leaves the message to it.
  expires=$(($(now_ms) + 20000))
  kv set scheduler/owner "{\"server\":\"another server\",\"at\":$((expires - 60000))}" "roster-by-child/$(tail -1 <<<"$spawned")"
  # As an older version of the plugin writes it: a roster entry with no reverse key.
  unindexed=$(head -1 <<<"$spawned")
  kv remove "roster-by-child/$unindexed"
  check "one child's reverse key is removed, as if an older version had recorded it" \
    "$([ -z "$(indexed_under "$unindexed")" ] && echo true || echo false)"
  # Report state a failed cleanup left behind: its session has no roster entry.
  orphan=ses_orphaned_report_sweep
  kv set "report/$orphan/prompt" '{"at":1}' "roster-by-child/$(tail -1 <<<"$spawned")"
  kv set "report/$orphan/settled" '{"at":1,"by":"report"}' "roster-by-child/$(tail -1 <<<"$spawned")"
  check "report state is written for a session with no roster entry" "$([ -n "$(kv get "report/$orphan/prompt")" ] && echo true || echo false)"
  start_server
  restarted=$(now_ms)
  # Plugins load per project location, on its first use after a start.
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
  scenario "a signed GitHub webhook wakes a subscribed idle session"
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
  woke=$(reply_time "$parent" "PARENT WOKE" 2)
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

  scenario "a child that subscribes to a webhook and ends its turn to wait is not reported, and reports once a delivery wakes it"
  out=$(prompt "COURIER-HOOKED")
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "the child subscribed and ended its turn" "$(has_text "$child" "TOOL DONE courier_subscribe" 30)"
  check "which was not told as one without a report" "$(turn_ended "$child"; notices_with "$parent" ended | jq -r 'length == 0')"
  body='{"text":"CHILD-REPORT-NOW"}'
  sig=$(printf '%s\n%s' child-ci "$body" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -r | cut -d' ' -f1)
  check "a delivery to its topic is accepted" "$([ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "x-hub-signature-256: sha256=$sig" \
    --data-binary "$body" "http://127.0.0.1:$WEBHOOK_PORT/hook/child-ci")" = 202 ] && echo true || echo false)"
  check "the delivery woke the child, which reported" "$(has_text "$parent" "CHILD DONE AFTER NUDGE" 45)"
  check "and the parent was never told it ended without a report" "$(turn_ended "$child"; notices_with "$parent" ended | jq -r 'length == 0')"
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

run_subtree() {
  scenario "courier_tree shows a three-level tree, and courier_stop from the root stops all of it"
  child_delay 1000
  out=$(prompt "COURIER-SUBTREE-START")
  root=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  middle=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "the middle session started its leaf, and its turn runs on" "$(has_text "$middle" "Started session ses_" 60)"
  seen=$(prompt_in "$root" "COURIER-SUBTREE-TREE" | tool_state courier_tree)
  leaf=$(jq -r '.metadata.metadata.sessions[1].sessionID // empty' <<<"$seen")
  check "courier_tree lists the middle session and its leaf, with their depths and parents" \
    "$(jq -r --arg root "$root" --arg middle "$middle" '.status == "completed" and (.metadata.metadata.sessions | map([.sessionID, .depth, .parentID]) | .[0] == [$middle, 1, $root] and .[1][1] == 2 and .[1][2] == $middle and length == 2)' <<<"$seen")"
  check "each owes its report and is not isolated" \
    "$(jq -r '.metadata.metadata.sessions | all(.report.owes == true and .isolated == false)' <<<"$seen")"
  stopped=$(prompt_in "$root" "COURIER-SUBTREE-STOP $middle" | tool_state courier_stop)
  check "courier_stop interrupted the leaf, then the middle session" \
    "$(jq -r --arg middle "$middle" --arg leaf "$leaf" '.status == "completed" and (.metadata.metadata.stopped | map([.sessionID, .outcome]) == [[$leaf, "interrupted"], [$middle, "interrupted"]])' <<<"$stopped")"
  ended() { for _ in $(seq 1 30); do [ "$(api "session/$1" | jq -r '(.data // .) | .outcome')" = interrupted ] && { echo true; return; }; sleep 1; done; echo false; }
  check "both sessions ended interrupted" "$([ "$(ended "$leaf")" = true ] && [ "$(ended "$middle")" = true ] && echo true || echo false)"
  # The probe plugin logs each event the plugins get: both interrupts reached them, where a failure or a silent end would follow.
  for _ in $(seq 1 30); do [ "$(jq -sr --arg a "$leaf" --arg b "$middle" '[.[] | select(.type == "session.execution.interrupted" and (.sessionID == $a or .sessionID == $b)) | .sessionID] | unique | length == 2' "$WORK/probe.log")" = true ] && break; sleep 1; done
  sleep 1
  check "neither parent was told of the stop, nor that a session ended without a report" \
    "$([ "$(notices_with "$root" ended)" = '[]' ] && [ "$(notices_with "$middle" ended)" = '[]' ] && echo true || echo false)"
  check "the stop is noted for both" "$([ -n "$(kv get "report/$leaf/stopped")" ] && [ -n "$(kv get "report/$middle/stopped")" ] && echo true || echo false)"
  check "a failure notice did not follow either" "$(notices_with "$root" failed | jq -r 'length == 0')"
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
  # A staged revert skips the wake of a message enqueued meanwhile, and of the same message sent again under its
  # inbox id: a real courier report with no turn behind it, which the watch flags stalled.
  scenario "a report whose wake a staged revert suppresses is sent again once, then flagged stalled (#218)"
  # The leaf's report is held back long enough to stage the revert on the middle while it is idle and
  # before the report lands, so the delivery is admitted with no wake.
  child_delay 15000
  out=$(prompt "COURIER-STALL")
  root=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  middle=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "the root started a middle session" "$([ -n "$middle" ] && echo true || echo false)"
  leaf=$(spawned_by "$middle")
  check "the middle started a leaf" "$([ -n "$leaf" ] && echo true || echo false)"
  for _ in $(seq 1 30); do [ "$(finished "$middle")" = true ] && break; sleep 1; done
  check "the middle ended its turn before the report" "$([ "$(finished "$middle")" = true ] && echo true || echo false)"
  # Staging a revert holds the session's input, and skips the wake of the next synthetic, until it commits.
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
  # Missed after WAKE_MS (30 s) and found at a tick up to 15 s later; flagged a WAKE_MS and a tick after that.
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
  check "and no notice besides" "$(sleep 2; notices_with "$parent" answered | jq -r 'length == 0')"
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
    "$(sleep 2; notices_with "$parent" answered | jq -r --arg question "$question" 'length == 1 and (.[0] | contains("request=\"" + $question + "\"") and contains("was answered by the person (") and (contains("in its own session") | not))')"
}

# A tree's record (#260): written as turns end in it, under memory/<projectID>/<topSessionID>, read back with courier_recall;
# and its lesson (#261): one line courier_note writes on it from the top or a sub-orchestrator, never a leaf, refused over
# 300 characters rather than clipped (#269).
# The record of tree $1 once $2, a jq condition, holds, waiting up to $3 (default 30) s; else what is there.
record_of() {
  for _ in $(seq 1 "${3:-30}"); do
    local found
    found=$(kv get "memory/$project/$1")
    if [ -n "$found" ] && [ "$(jq -r "$2" <<<"$found")" = true ]; then echo "$found"; return; fi
    sleep 1
  done
  kv get "memory/$project/$1"
}
run_memory() {
  scenario "a tree's record is kept per project, and courier_recall reads it back from the tree, from a new session and seeded by hand; courier_note writes its lesson"
  out=$(prompt "COURIER-GROUP")
  root=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  members=$(tool_state courier_spawn <<<"$out" | jq -r 'select(.status == "completed") | .metadata.metadata.sessionID')
  check "both members reported, in one message" "$([ -n "$(reply_time "$root" "PARENT GOT GROUP" 45)" ] && echo true || echo false)"
  project=$(session_info "$root" | jq -r '.projectID')
  check "the root's session names the project the record is keyed by" "$([ -n "$project" ] && [ "$project" != null ] && echo true || echo false)"
  record=$(record_of "$root" '.finished == true and (.parts | length == 2) and all(.parts[]; .status == "done")')
  check "once the turns in the tree had ended, the record lists both parts done, in their group, and the tree finished" \
    "$(jq -r --arg a "$(head -1 <<<"$members")" --arg b "$(tail -1 <<<"$members")" '.finished == true and (.parts | map(.sessionID) == [$a, $b]) and
      all(.parts[]; .status == "done" and .group == "pair" and .depth == 1 and .isolated == false and (.duration | type) == "number" and (.cost | type) == "number")' <<<"$record")"
  check "with the top's title and start, its split line not stated, and no recall noted yet" \
    "$(jq -r --argjson info "$(session_info "$root")" '.title == $info.title and .startedAt == $info.time.created and .split == "not stated" and (has("recalled") | not) and .movedAt >= .startedAt' <<<"$record")"
  check "and nothing of the reports' bodies or artifacts" "$(jq -r 'tostring | contains("CHILD DONE") or contains("child/work") | not' <<<"$record")"
  recalled=$(prompt_in "$root" "COURIER-RECALL" | tool_state courier_recall)
  check "courier_recall from the root lists its own tree, marked, with both parts done" \
    "$(jq -r --arg root "$root" '.status == "completed" and .metadata.metadata.top == $root and (.output | contains("- " + $root + " (this tree) ") and contains("2 parts: 2 done") and contains("· finished") and test(" · ran [^·]+ · last moved [^·]+ ago · ")) and
      any(.metadata.metadata.records[]; .sessionID == $root and .finished and (.parts | length) == 2)' <<<"$recalled")"
  check "which noted the root's call on its record" "$(record_of "$root" '.recalled.calls == 1 and (.recalled.at | type) == "number"' | jq -r '.recalled.calls == 1')"
  out=$(prompt "COURIER-RECALL")
  other=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  check "a new session of the project lists the same record, and its own tree without parts" \
    "$(tool_state courier_recall <<<"$out" | jq -r --arg root "$root" --arg other "$other" '.status == "completed" and (.output | contains("- " + $root + " 20") and contains("- " + $other + " (this tree) ") and contains("no parts")) and
      any(.metadata.metadata.records[]; .sessionID == $root and (.parts | length) == 2)' )"
  # Its turn ending after the call refreshes the record: no parts, and finished, as nothing in it runs.
  check "the new session's own record was written by the call, with no parts and the call noted" \
    "$(record_of "$other" '.recalled.calls == 1' | jq -r '.parts == [] and .recalled.calls == 1 and (.recalled.at | type) == "number"')"
  # The listing was counted beside the root's record, under the reader's top (#285); a tree's own record counts nothing.
  check "the listing counted the root's record as shown once to the new session's tree, beside the record, and neither tree's own" \
    "$([ "$(kv get "memory/$project/$root/reads/$other" | jq -r '.shown == 1 and .read == 0 and (.at | type) == "number"')" = true ] && [ -z "$(kv get "memory/$project/$other/reads/$other")" ] && [ -z "$(kv get "memory/$project/$root/reads/$root")" ] && [ "$(kv get "memory/$project/$root" | jq -r 'has("reads") | not')" = true ] && echo true || echo false)"
  out=$(prompt "COURIER-RECALL $root")
  reader=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  full=$(tool_state courier_recall <<<"$out")
  check "with a sessionID, courier_recall gives that record in full, its reads summed over both readers with this read counted" \
    "$(jq -r --arg root "$root" '.status == "completed" and (.output | startswith("Record of the tree under " + $root + ", in project ") and contains("\"reads\": {")) and .metadata.metadata.record.sessionID == $root and (.metadata.metadata.record.parts | length) == 2 and
      (.metadata.metadata.record.reads | .shown == 1 and .read == 1 and (.at | type) == "number")' <<<"$full")"
  check "which was counted as a read under the reader's top" "$(kv get "memory/$project/$root/reads/$reader" | jq -r '.shown == 0 and .read == 1')"
  # The lesson (#261): the top writes one line on its record once its parts have reported, and a second note replaces it.
  today=$(date -u +%F)
  line="The docs part was ten lines; next time do it yourself"
  noted=$(prompt_in "$root" "COURIER-NOTE $line" | tool_state courier_note)
  check "courier_note from the root wrote its lesson on its own tree's record, dated today, and says so" \
    "$(jq -r --arg root "$root" --arg today "$today" --arg line "$line" '.status == "completed" and .metadata.metadata.top == $root and .metadata.metadata.lesson.text == $line and
      (.metadata.metadata.lesson | has("depth") | not) and (.metadata.metadata | has("replaced") | not) and
      (.output | startswith("Noted on the record of the tree under " + $root + " as its lesson (" + $today + "): \"" + $line + "\".") and contains("AGENTS.md"))' <<<"$noted")"
  check "the record holds it, dated, with its parts and the recall as before" \
    "$(record_of "$root" ".lesson.text == \"$line\"" | jq -r --arg line "$line" '.lesson.text == $line and (.lesson.at | type) == "number" and (.lesson | has("depth") | not) and (.parts | length) == 2 and .recalled.calls == 1')"
  check "a new session's courier_recall lists it after the tree's facts, dated" \
    "$(prompt "COURIER-RECALL" | tool_state courier_recall | jq -r --arg root "$root" --arg today "$today" --arg line "$line" '.status == "completed" and
      (.output | contains("- " + $root + " 20") and contains(" · finished · recalled · lesson (" + $today + "): \"" + $line + "\""))')"
  # A lesson over 300 characters is refused, not clipped (#269): nothing is written, and the earlier lesson stays.
  long=$(printf 'y%.0s' $(seq 1 310))
  check "a note over 300 characters is refused, naming its length and the limit, and asks for a shorter one" \
    "$(prompt_in "$root" "COURIER-NOTE $long" | tool_state courier_note | jq -r '.status == "error" and (.error | tostring | contains("Not noted: the lesson is 310 characters, at most 300; write it shorter.") and contains("the earlier lesson, if there was one, stays"))')"
  check "and the record still holds the earlier lesson, whole" \
    "$(record_of "$root" ".lesson.text == \"$line\"" 3 | jq -r --arg line "$line" '.lesson.text == $line and (.lesson.at | type) == "number"')"
  short="For three one-line shell parts, one session each paid off: the sleeps ran in parallel"
  noted=$(prompt_in "$root" "COURIER-NOTE $short" | tool_state courier_note)
  check "a shorter note is then written, replacing the first, which the result names" \
    "$(jq -r --arg line "$line" --arg short "$short" '.status == "completed" and .metadata.metadata.lesson.text == $short and .metadata.metadata.replaced.text == $line and (.metadata.metadata | has("clipped") | not) and
      (.output | contains("It replaces the lesson (") and contains($line))' <<<"$noted")"
  check "and the record holds it" "$(record_of "$root" ".lesson.text == \"$short\"" | jq -r --arg short "$short" '.lesson.text == $short')"
  # A sub-orchestrator's note goes on the same record, marked with its depth; a leaf is refused by the tool when another
  # plugin's hook puts it back (the probe does, for a CHILD-FORCES task), as the courier's hook had hidden it.
  child_delay 1000
  out=$(prompt_in "$root" "COURIER-NOTE-BELOW")
  middle=$(tool_state courier_spawn <<<"$out" | jq -r 'select(.status == "completed") | .metadata.metadata.sessionID')
  check "the middle session noted, started a leaf, and reported on what its leaf got" "$(has_text "$root" "MID GOT LEAF GOT" 60)"
  leaf=$(spawned_by "$middle")
  check "the leaf, which does not see the tool, was refused when it called it anyway, naming its depth" \
    "$(has_text "$middle" "Not noted: this session is a leaf, at depth 2 of a session tree that goes at most 2 deep (maxDepth)." 5)"
  check "the middle session's note replaced the root's on the same record, marked from depth 1" \
    "$(record_of "$root" '.lesson.text == "Noted from depth 1"' | jq -r '.lesson.text == "Noted from depth 1" and .lesson.depth == 1 and (.parts | length) == 4')"
  check "which courier_recall lists as from depth 1" \
    "$(prompt_in "$root" "COURIER-RECALL" | tool_state courier_recall | jq -r --arg root "$root" '.status == "completed" and (.output | contains("- " + $root + " (this tree) ") and contains(", from depth 1): \"Noted from depth 1\""))')"
  check "every request of the leaf went without courier_note, as without courier_recall" \
    "$(jq -sr --arg leaf "$leaf" '[.[] | select(.type == "probe.context" and .sessionID == $leaf)] | length > 0 and all(.role == "leaf" and (.tools | index("courier_note") | not) and (.tools | index("courier_recall") | not))' "$WORK/probe.log")"
  check "a session nobody spawned, whose tree has no record yet, is refused" \
    "$(prompt "COURIER-NOTE Nowhere to put it" | tool_state courier_note | jq -r '.status == "error" and (.error | tostring | contains("Not noted: the tree under ") and contains(" has no record in this project to write a lesson on"))')"
  # A split line stated in markdown (#282): the record keeps it as written, the listing shows it as prose, cut at a word.
  # Its own record is written by the call first, so the turn that states the line ends in a tree with a record.
  said=$(prompt "COURIER-RECALL" | jq -r 'select(.type == "tool_use") | .sessionID' | head -1)
  split='**split: no, because the stances are a timed sequence that only my own turns can stage and hold; considered: one child per stance (but the flashes are short), a separate orchestrator session (it would only add a hop).**'
  prompt_in "$said" "COURIER-SAY $split" >/dev/null
  check "a split line stated in markdown is kept on the record as written" \
    "$(record_of "$said" '.split | startswith("**split: no, because the stances")' | jq -r --arg split "$split" '.split == $split')"
  check "and listed without its marks, cut at the last word within 160 characters" \
    "$(prompt_in "$said" "COURIER-RECALL" | tool_state courier_recall | jq -r --arg said "$said" '.status == "completed" and (.output | split("\n") | map(select(startswith("- " + $said + " (this tree) "))) |
      length == 1 and (.[0] | contains("\" · split: no, because the stances are a timed sequence that only my own turns can stage and hold; considered: one child per stance (but the flashes are short), a… [57 more characters] · ") and (contains("*") | not)))')"
  # A revised split line (#292): once a part has reported, the top states another; the record keeps the first and appends it.
  prompt_in "$said" "COURIER-TEST" >/dev/null
  check "the top's part reported back" "$([ -n "$(reply_time "$said" "PARENT WOKE" 45)" ] && echo true || echo false)"
  revised='split: 2 parts: its tests, its docs'
  prompt_in "$said" "COURIER-SAY $revised" >/dev/null
  record=$(record_of "$said" '(.revisions | length) == 1')
  check "a second, different split line is kept as a revision beside the first, with when it was stated and after how many parts" \
    "$(jq -r --arg split "$split" --arg revised "$revised" '.split == $split and (.revisions | length) == 1 and
      .revisions[0].text == $revised and (.revisions[0].at | type) == "number" and .revisions[0].parts >= 1' <<<"$record")"
  check "which the listing shows after the first, with the part count it was stated at" \
    "$(prompt_in "$said" "COURIER-RECALL" | tool_state courier_recall | jq -r --arg said "$said" '.status == "completed" and (.output | split("\n") | map(select(startswith("- " + $said + " (this tree) "))) |
      length == 1 and (.[0] | contains(" [57 more characters] · then, after 1 part: split: 2 parts: its tests, its docs · 1 part: 1 done")))')"
  check "and the refresh at that turn's end, reading the same replies, appended nothing" \
    "$(record_of "$said" ".movedAt > $(jq '.movedAt' <<<"$record")" | jq -r --argjson before "$record" '.movedAt > $before.movedAt and .revisions == $before.revisions and .split == $before.split')"
  # A mention, then a stated split line (#294): the stated line replaces the mention, once, and the mention is no revision.
  # Its record is written by a call for a record that is missing: the mock echoes a listing, whose split lines are mentions.
  mentioned=$(prompt "COURIER-RECALL ses_nowhere" | jq -r 'select(.type == "tool_use") | .sessionID' | head -1)
  mention='I decided to split: after reading the code'
  prompt_in "$mentioned" "COURIER-SAY $mention" >/dev/null
  check "a passing mention of a split, while no line states one, is kept as the record's split line" \
    "$(record_of "$mentioned" ".split == \"$mention\"" | jq -r --arg mention "$mention" '.split == $mention')"
  stated='split: 2 parts: core, docs'
  prompt_in "$mentioned" "COURIER-SAY $stated" >/dev/null
  check "a line stating one then replaces it, with no revisions" \
    "$(record_of "$mentioned" ".split == \"$stated\"" | jq -r --arg stated "$stated" '.split == $stated and (has("revisions") | not)')"
  check "which the listing shows with no later line" \
    "$(prompt_in "$mentioned" "COURIER-RECALL" | tool_state courier_recall | jq -r --arg mentioned "$mentioned" '.status == "completed" and (.output | split("\n") | map(select(startswith("- " + $mentioned + " (this tree) "))) |
      length == 1 and (.[0] | contains(" · split: 2 parts: core, docs · ") and (contains("then, after") | not) and (contains("after reading the code") | not)))')"
  # A record written by hand, as docs/reference.md's Memory section describes one and the real-model evaluation seeds it.
  seeded='{"startedAt":1760000000000,"movedAt":1760000900000,"title":"Seeded by hand","split":"split: 2 parts: core, docs","finished":true,"lesson":{"text":"Give the docs to one session","at":1760000890000},"parts":[{"sessionID":"ses_seed_core","title":"Core","depth":1,"isolated":true,"group":"wave","status":"done","duration":540000,"cost":0.42,"context":0.31},{"sessionID":"ses_seed_docs","title":"Docs","depth":1,"isolated":false,"status":"partial","duration":60000,"refused":1}]}'
  kv set "memory/$project/ses_seeded" "$seeded" "memory/$project/$root"
  full=$(prompt "COURIER-RECALL ses_seeded" | tool_state courier_recall)
  check "a record seeded with kv.ts, lesson included, reads back as written, with this read counted, and is listed" \
    "$(jq -r --argjson seeded "$seeded" '.status == "completed" and (.metadata.metadata.record | del(.projectID, .sessionID, .reads)) == $seeded and .metadata.metadata.record.reads.read == 1' <<<"$full")"
  check "in the listing, with its parts counted and its lesson dated" "$(prompt "COURIER-RECALL" | tool_state courier_recall | jq -r '.status == "completed" and (.output | contains("- ses_seeded 2025-10-09: \"Seeded by hand\" · split: 2 parts: core, docs · 2 parts: 1 done, 1 partial, 1 isolated, 1 spawn refused · ran 15 min · last moved ") and test(" · last moved [0-9]+ days ago · \\$0\\.42 · finished · lesson \\(2025-10-09\\): \"Give the docs to one session\""))')"
  check "a record that is not there is said to be missing" \
    "$(prompt "COURIER-RECALL ses_nowhere" | tool_state courier_recall | jq -r '.status == "completed" and .metadata.metadata.found == false and (.output | startswith("No record of a tree whose top session is ses_nowhere"))')"
  # The person's pin (#285), beside the record as the memory view writes it: the pinned record is listed first and marked,
  # and the sweep at the next load keeps it, a year old as it is, while an unpinned record as old goes.
  kv set "memory/$project/ses_seeded/pin" '{"at":1760000950000}' "memory/$project/$root"
  kv set "memory/$project/ses_unpinned" "$(jq -c '.title = "Seeded, unpinned" | del(.lesson)' <<<"$seeded")" "memory/$project/$root"
  check "an unpinned record as old is seeded beside it, for the sweep at the next load" "$(kv get "memory/$project/ses_unpinned" | jq -r '.title == "Seeded, unpinned"')"
  check "a pinned record is listed first and marked, and the listing says what a pin means" \
    "$(prompt "COURIER-RECALL" | tool_state courier_recall | jq -r '.status == "completed" and (.output | split("\n") | (.[0] | contains("A record marked \"pinned\" is one the person chose to keep and listed first")) and (.[1] | startswith("- ses_seeded 2025-10-09: ") and contains(" · finished · pinned · lesson ("))) and .metadata.metadata.records[0].pinned.at == 1760000950000 and (.metadata.metadata.records[1] | has("pinned") | not)')"

  # A part whose session OpenCode deleted (#283): an isolated child keeps its roster entry, but not its report state.
  scenario "a deleted isolated child's part keeps its last status and duration, and its tree still reads finished"
  spawn_isolated
  before=$(record_of "$parent" '.finished == true and (.parts | length == 1) and .parts[0].status == "done"')
  check "the child's part reads done and the tree finished once it reported" \
    "$(jq -r --arg child "$child" '.finished == true and .parts[0].sessionID == $child and .parts[0].isolated and (.parts[0].duration | type) == "number"' <<<"$before")"
  check "the isolated child is deleted" "$([[ $(curl -s -o /dev/null -w '%{http_code}' -u "opencode:$OPENCODE_PASSWORD" -X DELETE "$SERVER/api/session/$child") == 20* ]] && echo true || echo false)"
  # The parent's turn ending after the call refreshes the record, with the child's session gone.
  prompt_in "$parent" "COURIER-RECALL" >/dev/null
  after=$(record_of "$parent" ".movedAt > $(jq '.movedAt' <<<"$before")")
  check "after a refresh, the part is as last recorded, its duration unchanged, and the tree still finished" \
    "$(jq -r --argjson before "$before" '.movedAt > $before.movedAt and .finished == true and .parts == $before.parts' <<<"$after")"
  check "which courier_recall lists as finished, its part done" \
    "$(prompt_in "$parent" "COURIER-RECALL" | tool_state courier_recall | jq -r --arg parent "$parent" '.status == "completed" and (.output | split("\n") | map(select(startswith("- " + $parent + " (this tree) "))) |
      length == 1 and (.[0] | contains(" · 1 part: 1 done, 1 isolated · ") and test(" · last moved [^·]+ ago · ") and contains(" · finished") and (contains("not finished") | not)))')"

  scenario "with the memory option off, courier_note is refused; on again, the lesson is still there"
  stop_server
  jq '.plugins[0].options.memory = false' "$WORK/project/opencode.json" >"$WORK/project/opencode.json.new"
  mv "$WORK/project/opencode.json.new" "$WORK/project/opencode.json"
  git -C "$WORK/project" -c user.email=e2e@example.com -c user.name=e2e commit -qam "memory off"
  start_server
  check "the root's note is refused, naming the option" \
    "$(prompt_in "$root" "COURIER-NOTE Off" | tool_state courier_note | jq -r '.status == "error" and (.error | tostring | contains("Not noted: the plugin'"'"'s memory option is false"))')"
  stop_server
  jq 'del(.plugins[0].options.memory)' "$WORK/project/opencode.json" >"$WORK/project/opencode.json.new"
  mv "$WORK/project/opencode.json.new" "$WORK/project/opencode.json"
  git -C "$WORK/project" -c user.email=e2e@example.com -c user.name=e2e commit -qam "memory on"
  start_server
  check "the record kept its lesson meanwhile" "$(record_of "$root" '.lesson.text == "Noted from depth 1"' 5 | jq -r '.lesson.text == "Noted from depth 1" and .lesson.depth == 1')"
  # The sweep runs as the plugin loads, after the server answers, so the unpinned record's removal is waited for.
  check "the sweep at load kept the pinned record, a year old, with its pin, and dropped the unpinned one as old (#285)" \
    "$(for _ in $(seq 1 20); do [ -z "$(kv get "memory/$project/ses_unpinned")" ] && break; sleep 1; done; [ -n "$(kv get "memory/$project/ses_seeded")" ] && [ -n "$(kv get "memory/$project/ses_seeded/pin")" ] && [ -z "$(kv get "memory/$project/ses_unpinned")" ] && echo true || echo false)"
}

run_native() {
  # The nativeChildren option, on for the groups after this one: the server reloads the plugin with it.
  scenario "nativeChildren: a child started without isolate gets OpenCode's own parentID"
  child_delay 1000
  stop_server
  jq '.plugins[0].options.nativeChildren = true' "$WORK/project/opencode.json" >"$WORK/project/opencode.json.new"
  mv "$WORK/project/opencode.json.new" "$WORK/project/opencode.json"
  git -C "$WORK/project" -c user.email=e2e@example.com -c user.name=e2e commit -qam "nativeChildren"
  start_server
  out=$(prompt "COURIER-TEST")
  native_parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  native_child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  info=$(session_info "$native_child")
  check "the child's OpenCode parentID is its parent, and courier's metadata is kept" \
    "$(jq -r --arg parent "$native_parent" '.parentID == $parent and .metadata.courier.parentID == $parent' <<<"$info")"
  check "it has an empty ruleset of its own" "$(jq -r '.permissions == []' <<<"$info")"
  check "OpenCode lists it under its parent" \
    "$(api "session?parentID=$native_parent" | jq -r --arg child "$native_child" '[.data[].id] | index($child) != null')"
  check "the roster records it as native" "$(kv get "roster/$native_parent/$native_child" | jq -r '.native == true and .isolated == false')"
  check "it reported back, waking the parent" "$([ -n "$(reply_time "$native_parent" "PARENT WOKE" 45)" ] && echo true || echo false)"

  scenario "nativeChildren: an isolated child is created as before, without a parentID"
  child_delay 1000
  out=$(prompt "COURIER-TEST isolate")
  parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
  child=$(tool_state courier_spawn <<<"$out" | jq -r '.metadata.metadata.sessionID')
  check "it has no parentID and runs in its worktree" \
    "$(session_info "$child" | jq -r '.parentID == null and (.location.directory | contains("/worktree/"))')"
  check "the roster does not record it as native" "$(kv get "roster/$parent/$child" | jq -r 'has("native") | not')"
  check "it reported back" "$([ -n "$(reply_time "$parent" "PARENT WOKE" 45)" ] && echo true || echo false)"

  # The decision on #146: a native child's request is answered once, in OpenCode's own permission prompt;
  # the top session is told not to ask, then that it is settled.
  scenario "nativeChildren: a child does not run on its parent's session rules; its request is answered in OpenCode's own prompt"
  rules='[{"action":"shell","resource":"echo courier-asks*","effect":"allow"}]'
  parent=$(api_post session "{\"location\":{\"directory\":\"$WORK/project\"},\"permissions\":$rules}" | jq -r '.data.id')
  inherited=$(api_post session "{\"parentID\":\"$parent\"}" | jq -r '.data.id')
  check "a session created under it without a ruleset would run on the parent's" \
    "$(session_info "$inherited" | jq -r --argjson rules "$rules" '.permissions == $rules')"
  api_prompt "$parent" "COURIER-ASK"
  child=$(spawned_by "$parent" 45)
  check "the child, created with an empty ruleset, does not" \
    "$(session_info "$child" | jq -r --arg parent "$parent" '.parentID == $parent and .permissions == []')"
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

  # The owner's decision on #146: a native child's question is answered once, in OpenCode's own form,
  # which the TUI shows in the top session's view; the top session is told, and its question tool is not linked.
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

run_plugin_add() {
  # Last, because it swaps the local plugin for the installed one.
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
}

run_epilogue() {
  # Any reload, reinstall or restart in this run unloaded every instance. An instance's unload
  # waits for the work it started (the roster's prune, the notice of cut-off questions, the relay of
  # the requests already pending as its subscription started), so none of it fails against a location
  # that has closed: the lines those failures log are absent.
  scenario "the work an unloading instance started finished before its location closed"
  check "no prune, cut-off notice or pending relay failed" \
    "$(grep -qE "courier roster prune:|courier question: stored questions:|courier watch: could not relay pending requests:" "$WORK/server.log" && echo false || echo true)"
}

for group in $GROUP_LIST; do "run_${group//-/_}"; done
run_epilogue

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed; rerun with KEEP=1 to keep the server and model logs"
  exit 1
fi
echo "all checks passed"
