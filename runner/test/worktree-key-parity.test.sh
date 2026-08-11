#!/usr/bin/env bash
# =====================================================================
# LOAD-BEARING byte-identity test for the worktree-leaf strangler port (P4)
# (runner/tick.sh WT_ROWS loop → packages/crew worktreeKey). Mirrors the
# dod-distill / render parity tests in shape and discipline.
# ---------------------------------------------------------------------
# tick.sh derives each write repo's throwaway-worktree leaf from the repo id
# (fallback name, fallback repo<index>) via `tr -c 'A-Za-z0-9._-' '-' | sed`.
# This drives the EXACT bash derivation and the typed CLI port
# (worktreeKeyCli.js → worktreeKey) on the SAME inputs and asserts byte-identity
# (cmp -s), so the ts branch tick.sh selects under GAFFER_RUNTIME=ts can never
# derive a different worktree path than the legacy bash (which would break
# re-run idempotency / orphan a worktree). Determinism is load-bearing.
#
# LC_ALL=C pins tr/sed to single-byte/byte semantics on every platform so the
# byte-oriented TS port and the awk-family tools compare deterministically
# across the ubuntu + macOS matrix (same rationale as dod-distill-parity).
# =====================================================================
set -uo pipefail
export LC_ALL=C LC_CTYPE=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
CREW_DIR="$ROOT/packages/crew"
CLI="$CREW_DIR/dist/runtime/worktree/worktreeKeyCli.js"

command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
[ -f "$CLI" ] || { echo "SKIP: crew not built ($CLI) — run pnpm -C packages/crew build"; exit 0; }

pass=0
fail=0
ok() { echo "  ok   $1"; pass=$((pass + 1)); }
no() { echo "  FAIL $1"; fail=$((fail + 1)); }

# The EXACT bash derivation from tick.sh (the else/legacy branch + the backstop).
bash_key() {
  local rid="$1" rname="$2" idx="$3" k
  k="${rid:-$rname}"
  [ -n "$k" ] || k="repo$idx"
  k="$(printf '%s' "$k" | tr -c 'A-Za-z0-9._-' '-' | sed -E 's/-+/-/g; s/^-+//; s/-+$//')"
  [ -n "$k" ] || k="repo$idx"
  printf '%s' "$k"
}
# The ts seam as tick.sh invokes it (CLI + the same backstop).
ts_key() {
  local k
  k="$(node "$CLI" --id "$1" --name "$2" --index "$3" 2>/dev/null)"
  [ -n "$k" ] || k="repo$3"
  printf '%s' "$k"
}

key_case() {
  local label="$1" rid="$2" rname="$3" idx="$4"
  local b t
  b="$(bash_key "$rid" "$rname" "$idx")"
  t="$(ts_key "$rid" "$rname" "$idx")"
  if [ "$b" = "$t" ]; then
    ok "$label — bash tr|sed and ts are byte-identical ([$b])"
  else
    no "$label — DIVERGED (bash=[$b] ts=[$t])"
  fi
}

key_case "plain id"                 "fixture-repo-id"            "fixture-app"  0
key_case "id empty → name"          ""                          "My Repo Name!" 1
key_case "sed-special chars"        "weird/id:with*chars"       "x"            2
key_case "leading/trailing dashes"  "---leading-and-trailing---" "y"           3
key_case "multibyte (byte collapse)" "café-ünïcode"             "z"            4
key_case "both empty → repo<index>" ""                          ""             5
key_case "all dots (dots allowed)"  "...."                      "only-dots"    6
key_case "spaces + tabs"            "a b	c"                     "n"            7
key_case "only-specials → repo<index>" "@@@###"                 ""             8
key_case "name with slash"          ""                          "org/app"      9

echo ""
echo "worktree-key-parity: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
