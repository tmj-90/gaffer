#!/usr/bin/env bash
# =====================================================================
# LOAD-BEARING byte-identity test for the minimalism post-condition strangler
# port (P4). Mirrors the dod-distill / worktree-key / hygiene parity tests.
# ---------------------------------------------------------------------
# gaffer_check_minimalism decides a completed delivery's minimalism verdict from
# its diff size + smallest-change note. This drives the REAL bash function as the
# ORACLE and the typed CLI port (minimalismCli.js → checkMinimalism) on the SAME
# inputs, asserting all THREE observable outputs are byte-identical: the verdict
# TOKEN (bash stdout), the return CODE, and the REASON (GAFFER_MINIMALISM_REASON).
# The bash function is called in the CURRENT shell (NOT $(...)) so the reason var
# propagates. This is entrypoint-only — the live tick.sh wiring is a later slice —
# so a byte-identical port is proven before anything routes through it.
#
# LC_ALL=C pins tr/cut to byte semantics across the ubuntu+macOS matrix.
# =====================================================================
set -uo pipefail
export LC_ALL=C LC_CTYPE=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
CREW_DIR="$ROOT/packages/crew"
CLI="$CREW_DIR/dist/runtime/minimalism/minimalismCli.js"

command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
[ -f "$CLI" ] || { echo "SKIP: crew not built ($CLI) — run pnpm -C packages/crew build"; exit 0; }
# shellcheck source=../lib/minimalism.sh
source "$RUNNER_DIR/lib/minimalism.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/minimalism-parity.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
pass=0
fail=0
ok() { echo "  ok   $1"; pass=$((pass + 1)); }
no() { echo "  FAIL $1"; fail=$((fail + 1)); }

# case <label> <files> <lines> <note> <changed>
# Drives the WIRED gaffer_check_minimalism BOTH ways (GAFFER_RUNTIME=bash — the
# legacy body; =ts — the seam through minimalismCli.js) and asserts all three
# observable outputs (stdout token / exit code / GAFFER_MINIMALISM_REASON) agree.
# Called in the CURRENT shell (redirect only stdout) so the reason var propagates.
mcase() {
  local label="$1" files="$2" lines="$3" note="$4" changed="$5"
  local btok bcode breason ttok tcode treason
  GAFFER_RUNTIME=bash gaffer_check_minimalism "$files" "$lines" "$note" "$changed" > "$WORK/tok" 2>/dev/null; bcode=$?
  btok="$(cat "$WORK/tok")"; breason="$GAFFER_MINIMALISM_REASON"
  GAFFER_RUNTIME=ts CREW_DIR="$CREW_DIR" gaffer_check_minimalism "$files" "$lines" "$note" "$changed" > "$WORK/tok" 2>/dev/null; tcode=$?
  ttok="$(cat "$WORK/tok")"; treason="$GAFFER_MINIMALISM_REASON"
  if [ "$btok" = "$ttok" ] && [ "$bcode" = "$tcode" ] && [ "$breason" = "$treason" ]; then
    ok "$label — bash and ts branches agree (token/code/reason)"
  else
    { echo "  bash: [$btok/$bcode] $breason"; echo "  ts:   [$ttok/$tcode] $treason"; } >&2
    no "$label — DIVERGED"
  fi
}

mcase "ok (within caps, note present)"     3  120 "Refactored the auth module for clarity"      ""
mcase "missing note (empty)"               3  120 ""                                            ""
mcase "missing note (whitespace only)"     3  120 $'  \t \n '                                    ""
mcase "oversized by lines (em-dash reason)" 20 900 "Big change touching worker across the board" "runner/lib/worker.sh"
mcase "oversized by files"                 15 100 "note mentions the account view"              "src/account.ts"
mcase "unverified note (no file referenced)" 2 50 "Totally unrelated boilerplate note here"     "src/auth/reset.ts src/routes/account.ts"
mcase "verified by basename"               2  50  "tweaked reset.ts logic"                      "src/auth/reset.ts"
mcase "verified by stem (>=4 chars)"       2  50  "updated the account handler"                 "src/account.tsx"
mcase "no changed list → skip relevance"   2  50  "any note here is fine"                       ""
mcase "note excerpt truncation (>80 chars)" 2 50 "$(printf 'x%.0s' {1..120})"                   "src/z.ts"
mcase "exactly at line cap (not oversized)" 1 400 "right at the line cap edge"                  "src/edge.ts"

# Enforcement OFF: a missing note downgrades from code 1 → code 2, on BOTH branches.
MINIMALISM_ENFORCE=0 GAFFER_RUNTIME=bash gaffer_check_minimalism 3 120 "" "" >/dev/null 2>&1; _bc=$?
MINIMALISM_ENFORCE=0 GAFFER_RUNTIME=ts CREW_DIR="$CREW_DIR" gaffer_check_minimalism 3 120 "" "" >/dev/null 2>&1; _tc=$?
{ [ "$_bc" = 2 ] && [ "$_tc" = 2 ]; } \
  && ok "MINIMALISM_ENFORCE=0 downgrades missing note to code 2 (both branches)" \
  || no "enforce=0 divergence (bash=$_bc ts=$_tc)"

echo ""
echo "minimalism-parity: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
