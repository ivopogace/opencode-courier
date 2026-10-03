# Shared by run.sh and real-model.sh: a throwaway home directory and an OpenCode V2 server for
# $WORK/project. Source it after setting OPENCODE, WORK and SERVER_PORT.

export HOME=$WORK/home XDG_CONFIG_HOME=$WORK/home/.config XDG_DATA_HOME=$WORK/home/.local/share
export XDG_STATE_HOME=$WORK/home/.local/state XDG_CACHE_HOME=$WORK/home/.cache
export OPENCODE_PASSWORD=courier-e2e
SERVER="http://127.0.0.1:$SERVER_PORT"
SERVER_PID=

api() { curl -sf -u "opencode:$OPENCODE_PASSWORD" "$SERVER/api/$1"; }
start_server() {
  (cd "$WORK/project" && exec "$OPENCODE" serve --hostname 127.0.0.1 --port "$SERVER_PORT" --print-logs >>"$WORK/server.log" 2>&1 </dev/null) &
  SERVER_PID=$!
  for _ in $(seq 1 30); do api health >/dev/null 2>&1 && return; sleep 1; done
  echo "OpenCode server did not start; see $WORK/server.log"
  exit 1
}
stop_server() {
  [ -n "$SERVER_PID" ] || return 0
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=
}
