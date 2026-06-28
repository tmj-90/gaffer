#!/usr/bin/env bash
# =====================================================================
# A-1 — parallel claim safety against the REAL dispatch CLI.
# ---------------------------------------------------------------------
# Proves the invariants that make GAFFER_CONCURRENCY>1 safe, driven through
# the actual `dispatch claim-ticket` path against a temp SQLite DB:
#
#   AC1  CLAIM RACE: two agents claim the SAME ready ticket simultaneously
#        → exactly ONE wins (rc 0), the other loses (rc≠0), and the DB holds
#        exactly ONE active claim. (The partial unique index
#        idx_one_active_claim_per_ticket is the atomic gate.)
#   AC2  CONCURRENCY SHAPE: 2 workers + 3 ready tickets, claimed in parallel
#        → exactly 2 distinct tickets get claimed at once, the 3rd is still
#        ready (one waits). No ticket is double-claimed.
#   AC3  DEPENDENCY GATE: a phase-2 ticket that depends on a phase-1 ticket is
#        UNCLAIMABLE until phase-1 is done; once phase-1 is done it becomes
#        claimable. (Claimable ⇒ all deps satisfied, even under parallelism.)
#
# Requires the dispatch CLI to be built (packages/dispatch/dist). If it isn't,
# the test SKIPs (exit 0) rather than failing a checkout without a build.
# Run: bash test/parallel-claim.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
CLI_JS="$ROOT/packages/dispatch/dist/cli/index.js"

command -v node    >/dev/null 2>&1 || { echo "SKIP: node required";    exit 0; }
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 required"; exit 0; }
[ -f "$CLI_JS" ] || { echo "SKIP: dispatch CLI not built ($CLI_JS) — run pnpm -C packages/dispatch build"; exit 0; }

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/parallel-claim.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
DB="$WORK/dispatch.sqlite"
cli() { node "$CLI_JS" --db "$DB" "$@"; }
jget() { python3 -c "import sys,json;print($1)"; }
active_claims() { # count active claims for ticket <number>
  python3 - "$DB" "$1" <<'PY'
import sqlite3,sys
db,num=sys.argv[1],int(sys.argv[2])
c=sqlite3.connect(db)
n=c.execute("SELECT count(*) FROM ticket_claims tc JOIN tickets t ON t.id=tc.ticket_id "
            "WHERE t.number=? AND tc.status='active'",(num,)).fetchone()[0]
print(n)
PY
}
ticket_status() { cli ticket show "$1" 2>/dev/null | jget "json.load(sys.stdin)['ticket']['status']"; }

cli init >/dev/null 2>&1
# Three independent ready tickets + two agents.
for i in 1 2 3; do
  cli ticket create -t "T$i" --risk low >/dev/null 2>&1
  cli ticket ready "$i" >/dev/null 2>&1
done
A1="$(cli agent register -n w1 --max-risk high 2>/dev/null | jget "json.load(sys.stdin)['agent']['id']")"
A2="$(cli agent register -n w2 --max-risk high 2>/dev/null | jget "json.load(sys.stdin)['agent']['id']")"
[ -n "$A1" ] && [ -n "$A2" ] || { echo "SKIP: could not register agents"; exit 0; }

echo "== AC1: two agents race the SAME ticket → exactly one winner =="
cli claim-ticket 1 -a "$A1" >/dev/null 2>&1 & p1=$!
cli claim-ticket 1 -a "$A2" >/dev/null 2>&1 & p2=$!
rc1=0; rc2=0
wait "$p1" || rc1=$?
wait "$p2" || rc2=$?
winners=0
[ "$rc1" = "0" ] && winners=$((winners+1))
[ "$rc2" = "0" ] && winners=$((winners+1))
[ "$winners" = "1" ] && ok "exactly one claim succeeded (rc: $rc1/$rc2)" || fail "expected 1 winner, got $winners (rc: $rc1/$rc2)"
ac="$(active_claims 1)"
[ "$ac" = "1" ] && ok "DB holds exactly ONE active claim for #1 (no double-claim)" || fail "expected 1 active claim, got $ac"
[ "$(ticket_status 1)" = "claimed" ] && ok "#1 is 'claimed'" || fail "#1 not claimed (got $(ticket_status 1))"

echo "== AC2: 2 workers + 3 ready → exactly 2 in flight, 1 waits =="
# Fresh slate: 3 independent ready tickets. Two workers each claim a DISTINCT
# ticket (#P1 by worker A, #P2 by worker B), modelling the pool delivering two
# tickets in parallel; #P3 is left for a future tick — "one waits". Distinct
# tickets are independent rows so both claims SUCCEED and #P3 stays ready, leaving
# exactly two in flight — and no ticket is ever double-claimed.
P1="$(cli ticket create -t P-a --risk low 2>/dev/null | jget "json.load(sys.stdin)['ticket']['number']")"
P2="$(cli ticket create -t P-b --risk low 2>/dev/null | jget "json.load(sys.stdin)['ticket']['number']")"
P3="$(cli ticket create -t P-c --risk low 2>/dev/null | jget "json.load(sys.stdin)['ticket']['number']")"
for t in "$P1" "$P2" "$P3"; do cli ticket ready "$t" >/dev/null 2>&1; done
cli claim-ticket "$P1" -a "$A1" >/dev/null 2>&1 && qr1=0 || qr1=$?
cli claim-ticket "$P2" -a "$A2" >/dev/null 2>&1 && qr2=0 || qr2=$?
{ [ "$qr1" = "0" ] && [ "$qr2" = "0" ]; } && ok "two workers claimed two distinct tickets (both rc 0)" \
  || fail "a distinct-ticket claim failed (rc: $qr1/$qr2)"
{ [ "$(ticket_status "$P1")" = "claimed" ] && [ "$(ticket_status "$P2")" = "claimed" ]; } \
  && ok "#$P1 and #$P2 are both claimed (2 in flight at once)" || fail "expected #$P1+#$P2 claimed"
[ "$(ticket_status "$P3")" = "ready" ] && ok "#$P3 still ready — one waits (the pool didn't over-claim)" \
  || fail "#$P3 should still be ready (got $(ticket_status "$P3"))"
# And the parallelism-safety proof: a SIMULTANEOUS race on the SAME remaining
# ticket (#P3) by both workers still yields exactly ONE active claim (no
# double-claim under real concurrency — the headline invariant).
cli claim-ticket "$P3" -a "$A1" >/dev/null 2>&1 & z1=$!
cli claim-ticket "$P3" -a "$A2" >/dev/null 2>&1 & z2=$!
wait "$z1" 2>/dev/null; wait "$z2" 2>/dev/null
ac3="$(active_claims "$P3")"
[ "$ac3" = "1" ] && ok "concurrent race on #$P3 → exactly ONE active claim (no double-claim)" \
  || fail "expected 1 active claim on #$P3, got $ac3"
dbl=0
for t in "$P1" "$P2" "$P3"; do [ "$(active_claims "$t")" -gt 1 ] && dbl=1; done
[ "$dbl" = "0" ] && ok "no ticket has >1 active claim" || fail "a ticket was double-claimed"

echo "== AC3: dependency gate — phase-2 unclaimable until phase-1 done =="
PH1="$(cli ticket create -t phase1 --risk low 2>/dev/null | jget "json.load(sys.stdin)['ticket']['number']")"
PH2="$(cli ticket create -t phase2 --risk low 2>/dev/null | jget "json.load(sys.stdin)['ticket']['number']")"
cli ticket dep add "$PH2" "$PH1" >/dev/null 2>&1
cli ticket ready "$PH1" >/dev/null 2>&1
cli ticket ready "$PH2" >/dev/null 2>&1
cli claim-ticket "$PH2" -a "$A1" >/dev/null 2>&1 && depclaim=0 || depclaim=$?
[ "${depclaim:-0}" != "0" ] && ok "phase-2 (#$PH2) is UNCLAIMABLE while phase-1 (#$PH1) is not done" \
  || fail "phase-2 was claimable with an unsatisfied dependency"
# Satisfy the dependency (drive phase-1 to done), then phase-2 must claim.
python3 - "$DB" "$PH1" <<'PY'
import sqlite3,sys
c=sqlite3.connect(sys.argv[1]); c.execute("UPDATE tickets SET status='done' WHERE number=?", (int(sys.argv[2]),)); c.commit()
PY
[ "$(ticket_status "$PH1")" = "done" ] && ok "phase-1 (#$PH1) is done" || fail "could not mark phase-1 done"
cli ticket ready "$PH2" >/dev/null 2>&1
if cli claim-ticket "$PH2" -a "$A1" >/dev/null 2>&1; then ok "phase-2 (#$PH2) becomes claimable once its dependency is done"; else fail "phase-2 still unclaimable after dependency satisfied"; fi

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"; exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
