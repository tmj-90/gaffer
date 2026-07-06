#!/usr/bin/env bash
# =====================================================================
# B-H2 — the forbidden-fragment list must not word-split-AND-glob.
# ---------------------------------------------------------------------
# _hygiene_forbidden_fragments used to expand the config with an unquoted
# `printf '%s\n' $raw`, which BOTH word-splits AND pathname-expands. A glob
# fragment like `*.events.jsonl` would then expand against the CURRENT WORKING
# DIRECTORY: if a matching file exists in cwd, the literal fragment is replaced
# by that filename (e.g. `decoy.events.jsonl`), so the suffix-glob rule silently
# degrades to a substring match on one specific filename — and a genuinely
# forbidden path such as `src/foo.events.jsonl` then SLIPS THE GATE.
#
# This test proves the fix: run the detector from a cwd that CONTAINS a file
# matching the `*.events.jsonl` glob, and confirm (a) the literal glob fragment
# survives in the list and (b) a forbidden events-log path is still caught.
#
# Run: bash runner/test/hygiene-noglob.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
# shellcheck source=../lib/hygiene.sh
source "$RUNNER_DIR/lib/hygiene.sh"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/hygiene-noglob.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# A cwd that WOULD hijack `*.events.jsonl` (and, for good measure, one that would
# hijack the `.mcp.json` literal is not a glob so it's unaffected — the glob
# fragment is the load-bearing one).
: > "$WORK/decoy.events.jsonl"
: > "$WORK/anything.events.jsonl"

cd "$WORK"

echo "== B-H2: glob fragments survive an adversarial cwd =="
FRAGS="$(_hygiene_forbidden_fragments)"
printf '%s\n' "$FRAGS" | grep -qxF '*.events.jsonl' \
  && ok "literal '*.events.jsonl' fragment survives (not expanded to a cwd match)" \
  || fail "'*.events.jsonl' was glob-expanded away — list is: $(printf '%s' "$FRAGS" | tr '\n' ' ')"
printf '%s\n' "$FRAGS" | grep -qxF 'decoy.events.jsonl' \
  && fail "a cwd filename (decoy.events.jsonl) leaked INTO the fragment list" \
  || ok "no cwd filename leaked into the fragment list"

echo "== B-H2: a forbidden events-log path is still caught from that cwd =="
if _hygiene_path_forbidden "src/foo.events.jsonl"; then
  ok "src/foo.events.jsonl is still detected as forbidden (glob intact)"
else
  fail "src/foo.events.jsonl SLIPPED the gate — the glob degraded to a filename match"
fi
# A benign path must still be allowed (no over-broad matching).
if _hygiene_path_forbidden "src/index.ts"; then
  fail "src/index.ts wrongly flagged forbidden"
else
  ok "src/index.ts correctly allowed"
fi
# Other fragments unaffected by the cwd.
if _hygiene_path_forbidden "pkg/node_modules/x"; then
  ok "node_modules substring fragment still caught"
else
  fail "node_modules fragment lost"
fi

echo "== B-H2: globbing state is restored (no leaked 'set -f') =="
case "$-" in *f*) fail "noglob (set -f) leaked into the caller's shell" ;; *) ok "caller's globbing state left unchanged" ;; esac

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS ($PASS checks)"; exit 0
else
  printf 'FAILED (%d of %d):\n' "${#FAILURES[@]}" "$((PASS + ${#FAILURES[@]}))"
  printf '  - %s\n' "${FAILURES[@]}"; exit 1
fi
