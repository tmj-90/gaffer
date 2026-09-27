#!/usr/bin/env bash
# =====================================================================
# MINIMALISM POST-CONDITION — gaffer_check_minimalism / gaffer_diff_stats
# (lib/minimalism.sh) run the typed CLI (packages/crew minimalismCli.js); every
# observable output (verdict token / exit code / GAFFER_MINIMALISM_REASON, and the
# numstat parse) is pinned to fixtures/typed-seams/minimalism/<case>.txt, captured
# from the bash implementation the CLI replaced (proven byte-identical by the
# former parity test). A missing crew build FAILS CLOSED with the `check_failed`
# token tick.sh parks on — never a silent "ok".
# Run: bash runner/test/minimalism-golden.test.sh   (SEAM_GOLDEN_CAPTURE=1 to re-pin)
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
# shellcheck source=lib/seam-golden.sh
source "$HERE/lib/seam-golden.sh"
export CREW_DIR
pass=0; fail=0
ok() { echo "  ok   $1"; pass=$((pass + 1)); }
no() { echo "  FAIL $1"; fail=$((fail + 1)); }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/minimalism-golden.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT

# mcase <name> <label> <files> <lines> <note> <changed>: token / code / reason, one per line.
# Called in the CURRENT shell (redirect only stdout) so the reason var propagates.
mcase() {
  local name="$1" label="$2" files="$3" lines="$4" note="$5" changed="$6" tok code
  GAFFER_MINIMALISM_REASON=""
  gaffer_check_minimalism "$files" "$lines" "$note" "$changed" > "$WORK/tok" 2>/dev/null; code=$?
  tok="$(cat "$WORK/tok")"
  printf '%s\n%s\n%s\n' "$tok" "$code" "$GAFFER_MINIMALISM_REASON" > "$WORK/out"
  seam_golden minimalism "$name" "$WORK/out" "$label ([$tok/$code])"
}
mcase ok               "ok (within caps, note present)"       3  120 "Refactored the auth module for clarity"      ""
mcase missing-empty    "missing note (empty)"                 3  120 ""                                            ""
mcase missing-ws       "missing note (whitespace only)"       3  120 $'  \t \n '                                    ""
mcase oversized-lines  "oversized by lines (em-dash reason)"  20 900 "Big change touching worker across the board" "runner/lib/worker.sh"
mcase oversized-files  "oversized by files"                   15 100 "note mentions the account view"              "src/account.ts"
mcase unverified       "unverified note (no file referenced)" 2  50  "Totally unrelated boilerplate note here"     "src/auth/reset.ts src/routes/account.ts"
mcase basename         "verified by basename"                 2  50  "tweaked reset.ts logic"                      "src/auth/reset.ts"
mcase stem             "verified by stem (>=4 chars)"         2  50  "updated the account handler"                 "src/account.tsx"
mcase no-changed       "no changed list → skip relevance"     2  50  "any note here is fine"                       ""
mcase truncation       "note excerpt truncation (>80 chars)"  2  50  "$(printf 'x%.0s' {1..120})"                  "src/z.ts"
mcase at-cap           "exactly at line cap (not oversized)"  1  400 "right at the line cap edge"                  "src/edge.ts"
MINIMALISM_ENFORCE=0 mcase enforce-off "MINIMALISM_ENFORCE=0 downgrades a missing note" 3 120 "" ""

# diff-stats: the numstat → "<files> <lines>" parse.
dscase() {
  local name="$1" label="$2" numstat="$3"
  printf '%s' "$numstat" | node "$CLI" diff-stats > "$WORK/out" 2>/dev/null
  seam_golden minimalism "diff-stats-$name" "$WORK/out" "diff-stats $label ([$(cat "$WORK/out")])"
}
dscase empty     "empty (→ 0 0)"     ""
dscase one       "one text file"     "$(printf '12\t3\tsrc/a.ts')"
dscase binary    "text + binary + 0" "$(printf '12\t3\tsrc/a.ts\n-\t-\tlogo.png\n0\t0\ttouched.ts')"
dscase spaces    "path with spaces"  "$(printf '4\t2\tmy dir/file.ts')"

# End-to-end: the WIRED gaffer_diff_stats over a real tiny git repo.
DSREPO="$WORK/ds-repo"; mkdir -p "$DSREPO"
git -C "$DSREPO" init -q -b main
printf 'a\nb\nc\n' > "$DSREPO/f.txt"
git -C "$DSREPO" -c user.email=t@e -c user.name=t add -A
git -C "$DSREPO" -c user.email=t@e -c user.name=t -c commit.gpgsign=false commit -qm base
git -C "$DSREPO" checkout -q -b work
printf 'a\nB\nc\nd\ne\n' > "$DSREPO/f.txt"; printf 'new\n' > "$DSREPO/g.txt"
git -C "$DSREPO" -c user.email=t@e -c user.name=t add -A
git -C "$DSREPO" -c user.email=t@e -c user.name=t -c commit.gpgsign=false commit -qm work
[ "$(gaffer_diff_stats "$DSREPO" main)" = "2 5" ] && ok "diff-stats (wired, real repo) → 2 files / 5 lines" || no "diff-stats wired: $(gaffer_diff_stats "$DSREPO" main)"
[ "$(gaffer_diff_stats "$WORK" main)" = "0 0" ] && ok "diff-stats on a non-repo → 0 0" || no "non-repo diff-stats"

# Fail closed without the typed CLI.
GAFFER_MINIMALISM_REASON=""
tok="$(CREW_DIR="$WORK/nope" gaffer_check_minimalism 3 120 "a fine note about f.txt" "f.txt" 2>/dev/null)"; rc=$?
[ "$tok" = "check_failed" ] && [ "$rc" -eq 1 ] && ok "missing crew dist → check_failed / rc 1 (fail closed)" || no "missing dist: tok='$tok' rc=$rc"
CREW_DIR="$WORK/nope" gaffer_check_minimalism 3 120 "a fine note about f.txt" "f.txt" >/dev/null 2>&1
[ -n "$GAFFER_MINIMALISM_REASON" ] && ok "fail-closed reason is set ($GAFFER_MINIMALISM_REASON)" || no "no reason on fail-closed"
grep -q 'check_failed)' "$RUNNER_DIR/tick.sh" && ok "tick.sh parks on the check_failed verdict" || no "tick.sh does not handle check_failed"

echo ""; echo "minimalism-golden: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
