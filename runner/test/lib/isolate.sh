#!/usr/bin/env bash
# runner/test/lib/isolate.sh — give a test its OWN operator state.
#
# factory.config.sh (and the dispatch / memory CLIs and bin/*.mjs helpers) default
# GAFFER_DATA to the CHECKOUT's .gaffer, DISPATCH_DB / MEMORY_DB under it, and the
# dispatch audit log beside the DB. On a contributor's machine that is the LIVE
# factory's DBs, audit trail and settings.json — which factory.config.sh APPLIES, so a
# test's result depended on the operator's local settings. And `:=` keeps whatever the
# developer's shell already exported. So, before sourcing factory.config.sh:
#
#   . "$HERE/lib/isolate.sh"
#   gaffer_test_isolate "$WORK"     # or with no argument: a fresh dir in $GAFFER_TEST_ISO
#                                   # (the caller removes it, e.g. in its EXIT trap)
#
# exports GAFFER_DATA=<dir>/.gaffer, DISPATCH_DB / MEMORY_DB inside it and
# DISPATCH_AUDIT beside them, overriding anything inherited.
# A failed mktemp EXITS the test (70): returning would leave the inherited GAFFER_DATA
# (the live factory's) in place for the rest of the test (lib/tmpdir.sh).
. "$(dirname "${BASH_SOURCE[0]}")/tmpdir.sh"  # mktemp guard + safe temp removal
gaffer_test_isolate() {
  local dir="${1:-}"
  if [ -z "$dir" ]; then
    dir="$(mktemp -d "${TMPDIR:-/tmp}/gaffer-test-iso.XXXXXX")"
    gaffer_test_check_tmp "$dir" || exit 70
    # shellcheck disable=SC2034  # read by the caller (its EXIT trap removes it)
    GAFFER_TEST_ISO="$dir"
  fi
  export GAFFER_DATA="$dir/.gaffer"
  export DISPATCH_DB="$GAFFER_DATA/dispatch.sqlite" MEMORY_DB="$GAFFER_DATA/memory.sqlite"
  export DISPATCH_AUDIT="$GAFFER_DATA/audit.jsonl"
  mkdir -p "$GAFFER_DATA"
}
