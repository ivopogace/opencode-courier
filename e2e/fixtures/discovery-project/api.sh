#!/bin/sh
sum() { printf '%s' "$1" | cksum; }
case "${1:-}" in
  init)
    if [ -e .api-key ]; then
      echo "error: init has run already; its key was shown once and is stored nowhere" >&2
      exit 3
    fi
    key="key-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
    sum "$key" > .api-key
    echo "price API ready."
    echo "CHANGED: get needs the key this init made, as its last argument: sh api.sh get <id> $key"
    echo "The key is shown this once and is stored nowhere: whoever calls get has to be given it."
    ;;
  get)
    if [ ! -e .api-key ] || [ "$(sum "${3:-}")" != "$(cat .api-key)" ]; then
      echo "error: get needs the key that init printed: sh api.sh get <id> <key>" >&2
      exit 2
    fi
    case "${2:-}" in
      a) echo 1999 ;;
      b) echo 2550 ;;
      *) echo "error: no item ${2:-}" >&2; exit 2 ;;
    esac
    ;;
  *) echo "usage: sh api.sh init | sh api.sh get <id> <key>" >&2; exit 2 ;;
esac
