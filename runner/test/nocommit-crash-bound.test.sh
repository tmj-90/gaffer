#!/usr/bin/env bash
# =====================================================================
# FINDING-3 — a deterministic agent crash (no-commit / wrong-branch delivery
# failure) must be BOUNDED ACROSS RUNS, not just within one run.
# ---------------------------------------------------------------------
# The no-commit/wrong-branch failure paths release the runner-held claim back to
# `ready`; the skip-file that stops a re-pick is PER-RUN only, and the per-ticket
# cost ceiling lived inside _recover_or_park, which is gated behind
# gaffer_any_branch_has_commits — a crash that never commits never reached it.
# Net: a ticket whose agent deterministically crashes burned one full `claude -p`
# per run, forever, at ESCALATING cost (the accumulated ledger spend feeds the
# difficulty router). The fix: gaffer_release_or_park_nocommit counts these
# failures DURABLY (per-ticket counter under $GAFFER_DATA — the same durability
# domain as the usage ledger) and, once the cross-run bound OR the per-ticket
# cost ceiling is hit, parks VISIBLY to `blocked` via the same rework_exhausted
# machinery _recover_or_park uses, instead of releasing to ready again.
#
# Acceptance criteria driven here (REAL functions extracted verbatim from
# tick.sh, run against the REAL dispatch CLI + DB):
#   AC1  a no-commit failure BELOW the bound still releases to `ready`
#        (re-claimable — the recoverable path stays recoverable) and durably
#        increments the cross-run counter under $GAFFER_DATA;
#   AC2  the counter SURVIVES a fresh run (new skip-file / process state,
#        durable state preserved) — it is cross-run, not per-run;
#   AC3  the Nth no-commit failure parks VISIBLY to `blocked` via the
#        rework_exhausted machinery: status=blocked, last_review_feedback
#        carries code=rework_exhausted, and a ticket.blocked event with
#        reason_code=rework_exhausted is appended (the same paging surface
#        _recover_or_park emits) — NOT released to ready;
#   AC4  the bound is configurable via GAFFER_MAX_NOCOMMIT_FAILURES;
#   AC5  the counter RESETS on park (a post-human retry starts fresh) and a
#        cleared counter starts from 1 again — a flaky-then-fixed ticket is
#        never permanently poisoned;
#   AC6  the per-ticket COST ceiling (delivery_budget_usd, else
#        GAFFER_REWORK_BUDGET_USD, vs the ticket's measured ledger spend) parks
#        to `blocked` on the FIRST no-commit failure once exceeded;
#   AC7  DRY_RUN never increments the counter (side-effect-free);
#   AC8  WIRING: tick.sh's three no-commit/wrong-branch failure paths route
#        through the bounded wrapper; the submit-success path clears the
#        counter; factory.config.sh defines the configurable default;
#   AC9  NEGATIVE CONTROL: the pre-fix shape (plain release-to-ready) never
#        parks however many times it fails — proves this test bites.
#
# Requires the dispatch CLI to be built. SKIPs (exit 0) if it isn't.
# Run: bash runner/test/nocommit-crash-bound.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
TICK="$RUNNER_DIR/tick.sh"
CFG="$RUNNER_DIR/factory.config.sh"
CLI_JS="$ROOT/packages/dispatch/dist/cli/index.js"

command -v node    >/dev/null 2>&1 || { echo "SKIP: node required";    exit 0; }
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 required"; exit 0; }
[ -f "$CLI_JS" ] || { echo "SKIP: dispatch CLI not built ($CLI_JS) — run pnpm -C packages/dispatch build"; exit 0; }

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/nocommit-bound.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
DB="$WORK/dispatch.sqlite"
export GAFFER_DATA="$WORK/data"     # DURABLE across simulated runs (like the usage ledger)
mkdir -p "$GAFFER_DATA"
DRY_RUN=0

# The runner wraps the CLI as `wg`; jget reads stdin JSON as `d` — byte-identical
# to factory.config.sh, so the extracted functions run EXACTLY as they do in tick.sh.
wg()   { node "$CLI_JS" --db "$DB" "$@"; }
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }
LOGF="$WORK/log.txt"; : > "$LOGF"
log()  { printf '%s\n' "$*" >> "$LOGF"; }
# Stubs for the factory.config.sh helpers the wrapper calls (not defined in tick.sh):
# the ledger-spend probe is injectable so the cost-ceiling trigger is deterministic.
gaffer_ticket_rework_spend() { printf '%s' "${STUB_SPEND:-0}"; }
gaffer_recall_feedback()     { :; }

status_of() { wg ticket show "$1" 2>/dev/null | jget "d['ticket']['status']" 2>/dev/null || echo ''; }
feedback_of() {
  python3 - "$DB" "$1" <<'PY'
import sqlite3,sys
db,num=sys.argv[1],int(sys.argv[2])
c=sqlite3.connect(db)
row=c.execute("SELECT last_review_feedback FROM tickets WHERE number=?",(num,)).fetchone()
print(row[0] or '' if row else '')
PY
}
blocked_events() {
  python3 - "$DB" "$1" <<'PY'
import sqlite3,sys
db,num=sys.argv[1],int(sys.argv[2])
c=sqlite3.connect(db)
n=c.execute("SELECT count(*) FROM work_events we JOIN tickets t ON t.id=we.entity_id "
            "WHERE t.number=? AND we.event_type='ticket.blocked' "
            "AND we.payload_json LIKE '%rework_exhausted%'",(num,)).fetchone()[0]
print(n)
PY
}

# ── Source the REAL runner functions (no copy — extracted verbatim from tick.sh) ──
# Each is a top-level definition that closes with `}` in column 0 (the one-liners
# are single lines), so a from-signature-to-first-col0-`}` slice is exact. If the
# function is missing or reshaped, extraction fails loudly — the correct signal.
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
  extract_fn "gaffer_nocommit_file"
  extract_fn "gaffer_nocommit_count"
  extract_fn "_gaffer_nocommit_record_unlocked"
  extract_fn "gaffer_nocommit_record"
  extract_fn "gaffer_nocommit_clear"
  extract_fn "gaffer_release_or_park_nocommit"
} > "$SRC"
for fn in _gaffer_locked _gaffer_skip_ticket_unlocked gaffer_skip_ticket \
          gaffer_release_delivery gaffer_nocommit_file gaffer_nocommit_count \
          _gaffer_nocommit_record_unlocked gaffer_nocommit_record \
          gaffer_nocommit_clear gaffer_release_or_park_nocommit; do
  grep -q "^$fn() {" "$SRC" \
    || { echo "FAIL: could not extract real '$fn' from tick.sh — missing or reshaped"; exit 1; }
done
# shellcheck disable=SC1090
source "$SRC"

# One ready, claimable ticket → echoes its number.
AGENT="$(wg init >/dev/null 2>&1; wg agent register -n fac --max-risk high 2>/dev/null | jget "d['agent']['id']")"
[ -n "$AGENT" ] || { echo "SKIP: could not register agent"; exit 0; }
make_ready_ticket() {
  local num
  num="$(wg ticket create -t "$1" --risk low 2>/dev/null | jget "d['ticket']['number']")"
  wg ac add "$num" -t "AC" >/dev/null 2>&1
  wg ticket ready "$num" >/dev/null 2>&1
  printf '%s' "$num"
}
claim() {  # $1 = num → echoes the claim token (empty on failure)
  wg claim-ticket "$1" --agent "$AGENT" --ttl 900 2>/dev/null | jget "d['claimToken']" 2>/dev/null || echo ''
}
# Simulate ONE fresh runner run failing this ticket with a no-commit crash:
# fresh per-run state (new skip-file, reset claim-resolved flag), durable state
# ($GAFFER_DATA, the dispatch DB) preserved — exactly the cross-run shape.
run_nocommit_failure() {  # $1 = num, $2 = run tag, $3 = reason
  SKIP_FILE="$WORK/skip.$2"; : > "$SKIP_FILE"
  GAFFER_CLAIM_RESOLVED=0
  CLAIM_TOKEN="$(claim "$1")"
  [ -n "$CLAIM_TOKEN" ] || return 1
  NUM="$1"
  gaffer_release_or_park_nocommit "$3"
  gaffer_skip_ticket "$NUM"
  return 0
}

export GAFFER_REWORK_BUDGET_USD=""   # attempt-bound scenarios: no cost ceiling
unset SHOW 2>/dev/null || true
STUB_SPEND=0

echo "== AC1/AC2: failures below the bound release to ready + durably count across runs =="
GAFFER_MAX_NOCOMMIT_FAILURES=3
T1="$(make_ready_ticket crash-loop)"
run_nocommit_failure "$T1" run1 "delivery failed: agent exited non-zero (rc=1) with no commits; branch dropped for retry" \
  || fail "setup: run1 could not claim #$T1"
[ "$(status_of "$T1")" = "ready" ] \
  && ok "AC1: failure 1/3 released #$T1 back to ready (recoverable path stays recoverable)" \
  || fail "AC1: #$T1 not ready after failure 1 (got '$(status_of "$T1")')"
[ "$(gaffer_nocommit_count "$T1")" = "1" ] \
  && ok "AC1: durable no-commit counter recorded failure 1 under \$GAFFER_DATA" \
  || fail "AC1: counter is '$(gaffer_nocommit_count "$T1")' (want 1)"

run_nocommit_failure "$T1" run2 "delivery failed: agent exited non-zero (rc=1) with no commits; branch dropped for retry" \
  || fail "AC2: run2 could not RE-claim #$T1 (must be re-claimable below the bound)"
[ "$(status_of "$T1")" = "ready" ] \
  && ok "AC2: failure 2/3 (fresh run state) still releases to ready" \
  || fail "AC2: #$T1 not ready after failure 2 (got '$(status_of "$T1")')"
[ "$(gaffer_nocommit_count "$T1")" = "2" ] \
  && ok "AC2: the counter SURVIVED the fresh run (2 after two separate runs)" \
  || fail "AC2: counter is '$(gaffer_nocommit_count "$T1")' after run2 (want 2)"

echo "== AC3: the Nth cross-run failure parks VISIBLY to blocked (rework_exhausted) =="
run_nocommit_failure "$T1" run3 "delivery failed: agent exited non-zero (rc=1) with no commits; branch dropped for retry" \
  || fail "AC3: run3 could not claim #$T1"
[ "$(status_of "$T1")" = "blocked" ] \
  && ok "AC3: failure 3/3 parked #$T1 → blocked (NOT released to ready again)" \
  || fail "AC3: #$T1 is '$(status_of "$T1")' after the bound (want blocked)"
printf '%s' "$(feedback_of "$T1")" | grep -q 'rework_exhausted' \
  && ok "AC3: last_review_feedback carries code=rework_exhausted (board card surfaces WHY)" \
  || fail "AC3: last_review_feedback lacks rework_exhausted (got '$(feedback_of "$T1")')"
[ "$(blocked_events "$T1")" -ge 1 ] 2>/dev/null \
  && ok "AC3: a ticket.blocked event with reason_code=rework_exhausted was appended (pages a human)" \
  || fail "AC3: no ticket.blocked/rework_exhausted event recorded"

echo "== AC5: the counter reset on park — a post-human retry starts fresh =="
[ "$(gaffer_nocommit_count "$T1")" = "0" ] \
  && ok "AC5: counter cleared when #$T1 parked (post-human retry is not poisoned)" \
  || fail "AC5: counter is '$(gaffer_nocommit_count "$T1")' after park (want 0)"

echo "== AC4/AC5: configurable bound + a cleared (flaky-then-fixed) ticket counts from 1 =="
GAFFER_MAX_NOCOMMIT_FAILURES=2
T2="$(make_ready_ticket flaky-then-fixed)"
run_nocommit_failure "$T2" t2run1 "delivery failed: worktree HEAD was 'main' (expected gaffer/ branch); branch dropped" \
  || fail "setup: t2run1 could not claim #$T2"
[ "$(status_of "$T2")" = "ready" ] && [ "$(gaffer_nocommit_count "$T2")" = "1" ] \
  && ok "AC4: failure 1/2 (custom bound) → ready, counter 1" \
  || fail "AC4: after failure 1: status '$(status_of "$T2")', counter '$(gaffer_nocommit_count "$T2")'"
# A delivery attempt SUCCEEDS in between (the submit-success path clears the
# counter — wiring asserted in AC8); the ticket must start counting from 1 again.
gaffer_nocommit_clear "$T2"
run_nocommit_failure "$T2" t2run2 "delivery failed: worktree HEAD 'feature/x' is not a gaffer/ branch; branch dropped" \
  || fail "AC5: t2run2 could not claim #$T2"
[ "$(status_of "$T2")" = "ready" ] && [ "$(gaffer_nocommit_count "$T2")" = "1" ] \
  && ok "AC5: after a success-reset the next failure counts 1/2 and still releases to ready" \
  || fail "AC5: after reset+failure: status '$(status_of "$T2")', counter '$(gaffer_nocommit_count "$T2")' (want ready/1)"
run_nocommit_failure "$T2" t2run3 "delivery failed: worktree HEAD 'feature/x' is not a gaffer/ branch; branch dropped" \
  || fail "AC4: t2run3 could not claim #$T2"
[ "$(status_of "$T2")" = "blocked" ] \
  && ok "AC4: the custom bound (2) parks on the 2nd post-reset failure" \
  || fail "AC4: #$T2 is '$(status_of "$T2")' after hitting the custom bound (want blocked)"

echo "== AC6: the per-ticket cost ceiling parks on the FIRST no-commit failure =="
GAFFER_MAX_NOCOMMIT_FAILURES=5
export GAFFER_REWORK_BUDGET_USD="1.00"
STUB_SPEND="5.000000"                # measured ledger spend already past the ceiling
T3="$(make_ready_ticket cost-exhausted)"
run_nocommit_failure "$T3" t3run1 "delivery failed: agent exited non-zero (rc=1) with no commits; branch dropped for retry" \
  || fail "setup: t3run1 could not claim #$T3"
[ "$(status_of "$T3")" = "blocked" ] \
  && ok "AC6: spend \$5 ≥ ceiling \$1 → parked to blocked on the FIRST failure (attempts remaining)" \
  || fail "AC6: #$T3 is '$(status_of "$T3")' with spend past the ceiling (want blocked)"
printf '%s' "$(feedback_of "$T3")" | grep -q 'rework_exhausted' \
  && ok "AC6: the cost-ceiling park carries rework_exhausted too" \
  || fail "AC6: cost-ceiling park lacks rework_exhausted feedback"
# The per-ticket delivery_budget_usd must WIN over the env default when set.
export GAFFER_REWORK_BUDGET_USD="100.00"
SHOW='{"ticket":{"delivery_budget_usd":0.5}}'
STUB_SPEND="0.600000"
T4="$(make_ready_ticket per-ticket-budget)"
run_nocommit_failure "$T4" t4run1 "delivery failed: agent exited non-zero (rc=1) with no commits; branch dropped for retry" \
  || fail "setup: t4run1 could not claim #$T4"
[ "$(status_of "$T4")" = "blocked" ] \
  && ok "AC6: per-ticket budget 0.50 wins over env default 100 (spend 0.60 parks)" \
  || fail "AC6: #$T4 is '$(status_of "$T4")' (per-ticket ceiling should have parked it)"
unset SHOW; STUB_SPEND=0; export GAFFER_REWORK_BUDGET_USD=""

echo "== AC7: DRY_RUN is side-effect-free (no counter increment) =="
T5="$(make_ready_ticket dry-run)"
NUM="$T5"; CLAIM_TOKEN=""; DRY_RUN=1
gaffer_release_or_park_nocommit "delivery failed: dry-run probe"
DRY_RUN=0
[ "$(gaffer_nocommit_count "$T5")" = "0" ] \
  && ok "AC7: DRY_RUN did not increment the durable counter" \
  || fail "AC7: DRY_RUN incremented the counter to '$(gaffer_nocommit_count "$T5")'"

echo "== AC9: NEGATIVE CONTROL — the pre-fix shape never parks (proves the test bites) =="
GAFFER_MAX_NOCOMMIT_FAILURES=2
T6="$(make_ready_ticket unbounded-regression)"
for i in 1 2 3; do
  SKIP_FILE="$WORK/skip.ctl$i"; : > "$SKIP_FILE"
  GAFFER_CLAIM_RESOLVED=0
  NUM="$T6"; CLAIM_TOKEN="$(claim "$T6")"
  gaffer_release_delivery ready "delivery failed: agent exited non-zero (rc=1) with no commits; branch dropped for retry"
  gaffer_skip_ticket "$NUM"
done
[ "$(status_of "$T6")" = "ready" ] \
  && ok "AC9: 3 plain release-to-ready failures never park — the unbounded burn the wrapper prevents" \
  || fail "AC9: negative control did not reproduce the unbounded-requeue shape"

echo "== AC8: wiring — tick.sh routes the paths through the wrapper; success clears; config default =="
check() {  # $1 name, $2 perl-regex over $3 (file)
  if perl -0777 -ne "exit 0 if /$2/ms; exit 1" "$3"; then ok "$1"; else fail "$1 — pattern not found"; fi
}
check "AC8: no-commit agent-crash path routes through the bounded wrapper (before skip)" \
  'gaffer_release_or_park_nocommit "delivery failed: agent exited non-zero \(rc=\$rc\) with no commits;[^\n]*\n[^\n]*gaffer_skip_ticket' "$TICK"
check "AC8: wrong-branch (default branch) path routes through the bounded wrapper" \
  'gaffer_release_or_park_nocommit "delivery failed: worktree HEAD was[^\n]*\n[^\n]*gaffer_skip_ticket' "$TICK"
check "AC8: wrong-branch (non-gaffer branch) path routes through the bounded wrapper" \
  'gaffer_release_or_park_nocommit "delivery failed: worktree HEAD[^\n]*is not a gaffer[^\n]*\n[^\n]*gaffer_skip_ticket' "$TICK"
check "AC8: the submit-success path clears the cross-run counter (flaky-then-fixed reset)" \
  'submitted #\$NUM for review[^\n]*\n(?:[^\n]*\n)*?[^\n]*gaffer_nocommit_clear "\$NUM"' "$TICK"
check "AC8: factory.config.sh defines GAFFER_MAX_NOCOMMIT_FAILURES (aligned with the delivery-attempt cap)" \
  'GAFFER_MAX_NOCOMMIT_FAILURES[^\n]*GAFFER_MAX_DELIVERY_ATTEMPTS' "$CFG"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "nocommit-crash-bound: ALL $PASS checks passed"
  exit 0
fi
echo "nocommit-crash-bound: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
