#!/usr/bin/env bash
# =====================================================================
# UNRECOVERABLE delivery failure → the runner RELEASES its held claim.
# ---------------------------------------------------------------------
# RUNNER-OWNED-BOOKKEEPING: the runner HOLDS the delivery claim for the whole
# delivery, so an UNRECOVERABLE failure (no salvageable commits — agent exited
# non-zero with nothing committed; HEAD left on the default branch; HEAD on a
# non-`gaffer/` branch) must explicitly release the claim back to `ready` (so a
# later tick can retry cleanly) BEFORE it skips the ticket for this run. If it
# skipped WITHOUT releasing, the ticket would be stranded `claimed` with a live
# claim — invisible to the next tick until the lease expires, burning a slot.
#
# This test was previously a pure grep-of-source (perl regexes over tick.sh). It
# now DRIVES THE REAL runner functions — `gaffer_release_delivery` and
# `gaffer_skip_ticket` are EXTRACTED verbatim from tick.sh and sourced here — against
# the REAL dispatch CLI, and asserts the OUTCOME each unrecoverable path produces:
#
#   PART A  BEHAVIORAL (real functions + real dispatch DB):
#     A1  after the runner-held claim is released, the ticket is `ready` again;
#     A2  it carries ZERO active claims (the lease is gone, not just transitioned);
#     A3  it is immediately re-claimable by a later tick (clean retry);
#     A4  GAFFER_CLAIM_RESOLVED is set (the EXIT crash trap won't double-release — N3);
#     A5  gaffer_skip_ticket appended the number to the per-run skip-file;
#     A6  release-BEFORE-skip: the DB shows `ready` AND the skip-file has the number
#         (both effects land — a failed skip can never leave a still-claimed ticket).
#     A7  NEGATIVE CONTROL (proves the test bites): a path that SKIPS WITHOUT
#         releasing strands the ticket `claimed` with a live claim — exactly the
#         regression the release prevents.
#   Every reason string the three real unrecoverable paths pass is exercised.
#
#   PART B  REVERT GUARD (secondary): the three tick.sh paths route through the
#     FINDING-3 bounded wrapper `gaffer_release_or_park_nocommit …` (which releases
#     to `ready` below the cross-run bound — the behaviour Part A proves — and parks
#     to `blocked`/rework_exhausted once it is hit; see nocommit-crash-bound.test.sh)
#     immediately BEFORE `gaffer_skip_ticket`, and the retired `wg ticket move
#     refining || wg block` submit-status fallback is gone. This is a source-ordering
#     guard layered on top of the behavioral proof — it catches a silent
#     reorder/rename a behavioral test on the verbs alone cannot.
#
# Requires the dispatch CLI to be built. SKIPs (exit 0) if it isn't.
# Run: bash test/tick-unrecoverable-claim-release.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
TICK="$RUNNER_DIR/tick.sh"
CLI_JS="$ROOT/packages/dispatch/dist/cli/index.js"

command -v node    >/dev/null 2>&1 || { echo "SKIP: node required";    exit 0; }
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 required"; exit 0; }
[ -f "$CLI_JS" ] || { echo "SKIP: dispatch CLI not built ($CLI_JS) — run pnpm -C packages/dispatch build"; exit 0; }

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tick-unrec.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
DB="$WORK/dispatch.sqlite"
export GAFFER_DATA="$WORK"          # gaffer_skip_ticket appends under $GAFFER_DATA/.skip.lock
SKIP_FILE="$WORK/skip.txt"          # the per-run skip-file (tick.sh sets this globally)
DRY_RUN=0                           # a live delivery holds a token; DRY_RUN never claims/releases

# The runner wraps the CLI as `wg`; jget reads stdin JSON as `d` — byte-identical to
# factory.config.sh, so the extracted functions run EXACTLY as they do in tick.sh.
wg()   { node "$CLI_JS" --db "$DB" "$@"; }
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }
# `log` is the only other tick.sh helper the extracted functions call; keep it quiet.
log()  { :; }
status_of() { wg ticket show "$1" 2>/dev/null | jget "d['ticket']['status']" 2>/dev/null || echo ''; }
active_claims() {
  python3 - "$DB" "$1" <<'PY'
import sqlite3,sys
db,num=sys.argv[1],int(sys.argv[2])
c=sqlite3.connect(db)
n=c.execute("SELECT count(*) FROM ticket_claims tc JOIN tickets t ON t.id=tc.ticket_id "
            "WHERE t.number=? AND tc.status='active'",(num,)).fetchone()[0]
print(n)
PY
}

# ── Source the REAL runner functions (no copy — extracted verbatim from tick.sh) ──
# Each is a top-level definition that closes with `}` in column 0 (the one-liners are
# single lines), so a from-signature-to-first-col0-`}` slice is exact. If a future
# refactor changes that shape this extraction fails loudly (empty function → the
# behavioral asserts below break), which is the correct signal.
extract_fn() {  # $1 = function name → prints its verbatim definition from tick.sh
  awk -v fn="$1" '
    $0 ~ "^" fn "\\(\\) \\{" {print; if ($0 ~ /\}[[:space:]]*$/) exit; p=1; next}
    p {print; if ($0 ~ /^\}/) exit}
  ' "$TICK"
}
SRC="$WORK/real-fns.sh"
{
  extract_fn "_gaffer_locked"
  extract_fn "_gaffer_skip_ticket_unlocked"
  extract_fn "gaffer_skip_ticket"
  extract_fn "gaffer_release_delivery"
} > "$SRC"
# Sanity: all four real functions must have been captured before we rely on them.
for fn in _gaffer_locked _gaffer_skip_ticket_unlocked gaffer_skip_ticket gaffer_release_delivery; do
  grep -q "^$fn() {" "$SRC" || { echo "FAIL: could not extract real '$fn' from tick.sh — refactor changed its shape"; exit 1; }
done
# shellcheck disable=SC1090
source "$SRC"
declare -F gaffer_release_delivery >/dev/null && declare -F gaffer_skip_ticket >/dev/null \
  || { echo "FAIL: the real tick.sh functions did not source"; exit 1; }

# One ready, claimable ticket → returns its number with the runner holding a token.
AGENT="$(wg init >/dev/null 2>&1; wg agent register -n fac --max-risk high 2>/dev/null | jget "d['agent']['id']")"
[ -n "$AGENT" ] || { echo "SKIP: could not register agent"; exit 0; }
make_claimed_ticket() {  # echoes "<num> <token>"
  local title="$1" num tok
  num="$(wg ticket create -t "$title" --risk low 2>/dev/null | jget "d['ticket']['number']")"
  wg ac add "$num" -t "AC" >/dev/null 2>&1
  wg ticket ready "$num" >/dev/null 2>&1
  tok="$(wg claim-ticket "$num" --agent "$AGENT" --ttl 900 2>/dev/null | jget "d['claimToken']" 2>/dev/null)"
  printf '%s %s\n' "$num" "$tok"
}

echo "== PART A: the REAL unrecoverable path releases the runner-held claim =="

# The three unrecoverable outcomes differ ONLY by the reason string tick.sh passes;
# each drives the identical runner-owned release verb, so exercise all three reasons.
i=0
for reason in \
  "delivery failed: agent exited non-zero (rc=1) with no commits; releasing to ready" \
  "delivery failed: worktree HEAD was left on the default branch (no gaffer/ branch)" \
  "delivery failed: worktree HEAD is not a gaffer/ branch"; do
  i=$((i+1))
  # bash-3.2-safe capture of "<num> <token>" (no `< <()` process sub). A failed
  # claim yields only the number, so guard the token with ${2:-}.
  set -- $(make_claimed_ticket "unrec-$i"); NUM="${1:-}"; CLAIM_TOKEN="${2:-}"
  [ -n "${CLAIM_TOKEN:-}" ] || { fail "setup: could not claim #$NUM (path $i)"; continue; }
  [ "$(status_of "$NUM")" = "claimed" ] || { fail "setup: #$NUM not claimed before release (path $i)"; continue; }

  GAFFER_CLAIM_RESOLVED=0
  # EXACTLY what the tick.sh unrecoverable path runs, in order: release, then skip.
  gaffer_release_delivery ready "$reason"
  gaffer_skip_ticket "$NUM"

  [ "$(status_of "$NUM")" = "ready" ] \
    && ok "A1/path$i: released claim → #$NUM is ready again" \
    || fail "A1/path$i: #$NUM not ready after release (got '$(status_of "$NUM")')"
  [ "$(active_claims "$NUM")" = "0" ] \
    && ok "A2/path$i: #$NUM carries ZERO active claims (lease released, not stranded)" \
    || fail "A2/path$i: #$NUM still has $(active_claims "$NUM") active claim(s)"
  RETOK="$(wg claim-ticket "$NUM" --agent "$AGENT" --ttl 900 2>/dev/null | jget "d['claimToken']" 2>/dev/null || echo '')"
  [ -n "$RETOK" ] \
    && ok "A3/path$i: #$NUM is re-claimable on a later tick (clean retry)" \
    || fail "A3/path$i: #$NUM not re-claimable after release"
  # Put it back so the next iteration's counts start clean.
  wg runner-release "$NUM" --to ready --token "$RETOK" --reason "test reset" >/dev/null 2>&1
  [ "$GAFFER_CLAIM_RESOLVED" = "1" ] \
    && ok "A4/path$i: GAFFER_CLAIM_RESOLVED set (EXIT crash trap won't double-release — N3)" \
    || fail "A4/path$i: GAFFER_CLAIM_RESOLVED not set after release"
  grep -qx "$NUM" "$SKIP_FILE" \
    && ok "A5/path$i: gaffer_skip_ticket recorded #$NUM in the per-run skip-file" \
    || fail "A5/path$i: #$NUM not found in the skip-file after gaffer_skip_ticket"
done

echo "== A6: release lands BEFORE skip — both effects are present =="
set -- $(make_claimed_ticket "order"); NUM="${1:-}"; CLAIM_TOKEN="${2:-}"
GAFFER_CLAIM_RESOLVED=0
gaffer_release_delivery ready "delivery failed: no commits"
DB_READY="$([ "$(status_of "$NUM")" = ready ] && echo yes || echo no)"   # released FIRST
gaffer_skip_ticket "$NUM"
{ [ "$DB_READY" = yes ] && grep -qx "$NUM" "$SKIP_FILE"; } \
  && ok "A6: the claim was released to ready and only then was #$NUM skipped" \
  || fail "A6: release-before-skip not observed (ready-first=$DB_READY, skipped=$(grep -qx "$NUM" "$SKIP_FILE" && echo yes || echo no))"

echo "== A7: NEGATIVE CONTROL — skipping WITHOUT releasing strands the ticket =="
set -- $(make_claimed_ticket "stranded"); NUM="${1:-}"; CLAIM_TOKEN="${2:-}"
# Simulate the OLD bug: only skip, never release the runner-held claim.
gaffer_skip_ticket "$NUM"
{ [ "$(status_of "$NUM")" = "claimed" ] && [ "$(active_claims "$NUM")" = "1" ]; } \
  && ok "A7: without the release the ticket is stranded 'claimed' with a live claim (the regression the release prevents)" \
  || fail "A7: negative control did not reproduce the stranded-claim state — the test would not bite"

echo "== PART B: revert guard — tick.sh releases (bounded) BEFORE it skips (3 paths) =="
check() {  # $1 name, $2 perl-regex over tick.sh
  if perl -0777 -ne "exit 0 if /$2/ms; exit 1" "$TICK"; then ok "$1"; else fail "$1 — pattern not found"; fi
}
check "path-A wiring: bounded release-or-park before skip on no-commit agent failure" \
  'gaffer_release_or_park_nocommit "delivery failed: agent exited non-zero \(rc=\$rc\) with no commits;[^\n]*\n[^\n]*gaffer_skip_ticket'
check "path-B wiring: bounded release-or-park before skip on wrong-branch (default branch)" \
  'gaffer_release_or_park_nocommit "delivery failed: worktree HEAD was[^\n]*\n[^\n]*gaffer_skip_ticket'
check "path-C wiring: bounded release-or-park before skip on wrong-branch (non-gaffer branch)" \
  'gaffer_release_or_park_nocommit "delivery failed: worktree HEAD[^\n]*is not a gaffer[^\n]*\n[^\n]*gaffer_skip_ticket'
if perl -0777 -ne 'exit 1 if /wg ticket move "\$NUM" refining --reason "delivery failed/ms; exit 0' "$TICK"; then
  ok "the retired submit-status move-or-block fallback is gone from the failure paths"
else
  fail "a retired 'wg ticket move refining' failure fallback is still present"
fi

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "tick-unrecoverable-claim-release: ALL $PASS checks passed"
  exit 0
fi
echo "tick-unrecoverable-claim-release: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
