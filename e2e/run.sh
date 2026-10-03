#!/usr/bin/env bash
# Live end-to-end test: a real OpenCode V2 server with this plugin loaded, driven by a scripted
# stand-in model (e2e/mock-model.mjs), so no API key is needed.
#
#   OPENCODE_BIN=/path/to/opencode2 e2e/run.sh      # KEEP=1 keeps the temp dir and logs
#
# E2E_WORK picks the working directory (CI points it somewhere it can upload the logs from).
#
# Needs node and npm, bun (for the build), git, curl, jq and openssl.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OPENCODE=${OPENCODE_BIN:-opencode2}
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
  "plugins": [{ "package": "$ROOT/dist", "options": { "webhook": { "port": $WEBHOOK_PORT, "secretFile": "$WORK/webhook-secret" } } }],
  "providers": {
    "mock": {
      "package": "aisdk:@ai-sdk/openai-compatible",
      "settings": { "baseURL": "http://127.0.0.1:$MOCK_PORT/v1", "apiKey": "mock" },
      "models": { "chat": {}, "other": {} }
    }
  },
  "model": "mock/chat",
  "update": "disable",
  "permissions": [{ "action": "*", "resource": "*", "effect": "allow" }]
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

echo "a scheduled message survives a server restart"
out=$(prompt "COURIER-LATER 0.25")
parent=$(jq -r 'select(.type == "tool_use") | .sessionID' <<<"$out" | head -1)
check "courier_later completed" "$(tool_state courier_later <<<"$out" | jq -r '.status == "completed"')"
stop_server
start_server
restarted=$(now_ms)
# Plugins load per project location, on its first use after a start.
api "plugin?directory=$(node -p 'encodeURIComponent(process.argv[1])' "$WORK/project")" >/dev/null
woke=$(reply_time "$parent" "PARENT WOKE" 60)
check "it was delivered after the restart" "$([ -n "$woke" ] && [ "$woke" -gt "$restarted" ] && echo true || echo false)"

echo "the roster survives a restart and can be read from another session"
out=$(prompt "COURIER-CHILDREN $roster_parent")
listed=$(tool_state courier_children <<<"$out" | jq -c 'select(.status == "completed") | .metadata.metadata.children')
check "lists both children" "$(jq -r --arg ids "$spawned" '[.[].sessionID] | sort == ($ids | split("\n") | sort)' <<<"$listed")"
check "with each child's last reply" "$(jq -r 'all((.lastText // "") | contains("TOOL DONE courier_send"))' <<<"$listed")"

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
cleaned=$(prompt_in "$parent" "COURIER-CLEANUP $child" | tool_state courier_cleanup)
check "courier_cleanup removed it" "$(jq -r '.status == "completed" and .metadata.metadata.outcome == "removed"' <<<"$cleaned")"
check "the worktree directory is gone" "$([ ! -e "$directory" ] && echo true || echo false)"
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
echo "opencode2 plugin add installs the packed package and its tools load"
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

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed; rerun with KEEP=1 to keep the server and model logs"
  exit 1
fi
echo "all checks passed"
