#!/bin/bash
# Prints `yes` when opencode-courier@<version> is on npm and `no` when the version is free. Any
# other answer from the registry fails the script, so an outage never passes for "free". Callers
# must let that failure stop them: `published="$(...)"` as a statement of its own does under
# `set -e`; a substitution inside `[ ... ]` would not.
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
