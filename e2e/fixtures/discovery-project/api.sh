#!/bin/sh
case "${1:-} ${2:-}" in
  "describe ")
    echo "price API v2"
    echo "get <id>: prints the amount of item <id> as a whole number of cents."
    echo "CHANGED in v2: amounts are in cents, not in euros as in v1."
    ;;
  "get a") echo 1999 ;;
  "get b") echo 2550 ;;
  *) echo "usage: sh api.sh describe | sh api.sh get <a|b>" >&2; exit 2 ;;
esac
