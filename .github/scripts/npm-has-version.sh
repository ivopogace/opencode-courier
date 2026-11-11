#!/bin/bash
set -euo pipefail
version="$1"
if out="$(npm view "opencode-courier@${version}" version --json 2>/dev/null)"; then
  if [ -n "${out}" ]; then echo yes; else echo no; fi
  exit 0
fi
case "${out}" in
  *'"code": "E404"'*) echo no ;;
  *)
    echo "::error::npm did not say whether opencode-courier@${version} exists: ${out}" >&2
    exit 1 ;;
esac
