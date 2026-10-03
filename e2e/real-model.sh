#!/usr/bin/env bash
# Smoke test with a real model: the same throwaway OpenCode V2 server as run.sh, with this plugin
# loaded, but a real model instead of the scripted one. The parent is asked to fan a small task out
# to two children; the script records which tools the parent called and in what order, whether it
# ended its turn instead of polling, whether each child called courier_send, and whether both
# reports woke the parent. Not run in CI: it needs a model provider.
#
#   OPENCODE_BIN=/path/to/opencode2 e2e/real-model.sh
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
OPENCODE=${OPENCODE_BIN:-opencode2}
SERVER_PORT=${SERVER_PORT:-4610}
PROVIDER=${COURIER_PROVIDER:-opencode}
MODEL=${COURIER_MODEL:-longcat-2.5-preview-free}
if [ -z "${COURIER_BASE_URL+set}" ] && [ "$PROVIDER" = opencode ]; then
  BASE_URL=https://opencode.ai/zen/v1
else
  BASE_URL=${COURIER_BASE_URL:-}
fi
KEY_ENV=${COURIER_API_KEY_ENV:-}
export COURIER_TIMEOUT=${COURIER_TIMEOUT:-300}
# The sleeps stand in for real work: they keep the children busy until the parent's turn has ended,
# and apart, so each report finds it idle.
PROMPT=${COURIER_PROMPT:-'Have two helper sessions work in parallel and report back to you. One runs the shell command `sleep 20; echo $((17 * 23))`, the other runs `sleep 40; echo $((2 ** 10))`, and each reports the number it printed. Start them with courier_spawn and do not run the commands yourself. When both have reported back, reply with one line: RESULTS <first> <second>'}
export COURIER_EXPECT=${COURIER_EXPECT:-"391 1024"}
WORK=${E2E_WORK:-$(mktemp -d)}
export WORK
# shellcheck source=e2e/lib.sh
source "$ROOT/e2e/lib.sh"
export SERVER OPENCODE_PASSWORD

cleanup() {
  stop_server
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
echo "building plugin"
(cd "$ROOT" && npm run build >"$WORK/build.log" 2>&1) || { cat "$WORK/build.log"; exit 1; }

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
jq -n --arg plugin "$ROOT/dist" --arg model "$PROVIDER/$MODEL" --argjson providers "$provider" '{
  plugins: [$plugin],
  providers: $providers,
  model: $model,
  update: "disable",
  permissions: [{ action: "*", resource: "*", effect: "allow" }]
}' >"$WORK/project/opencode.json"
git -C "$WORK/project" init -q
git -C "$WORK/project" add opencode.json
git -C "$WORK/project" -c user.email=e2e@example.com -c user.name=e2e commit -q -m "opencode config"

start_server
echo "OpenCode $("$OPENCODE" --version) on $SERVER, model $PROVIDER/$MODEL"
echo "parent prompt: $PROMPT"

# The parent's first turn; run returns when it ends.
status=0
(cd "$WORK/project" && "$TIMEOUT_BIN" "$COURIER_TIMEOUT" "$OPENCODE" run --server "$SERVER" --auto --format json "$PROMPT" \
  </dev/null >"$WORK/parent-run.jsonl" 2>"$WORK/parent-run.err") || status=$?
[ "$status" = 124 ] && echo "the parent's first turn did not end within $COURIER_TIMEOUT s"
parent=$(jq -r 'select(.sessionID != null) | .sessionID' "$WORK/parent-run.jsonl" 2>/dev/null | head -1 || true)
if [ -z "$parent" ]; then
  echo "no parent session; see $WORK/parent-run.err and $WORK/server.log"
  exit 1
fi
echo "parent $parent; waiting for its children"
node "$ROOT/e2e/real-model.mjs" "$parent"
