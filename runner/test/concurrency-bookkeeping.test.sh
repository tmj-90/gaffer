#!/usr/bin/env bash
# =====================================================================
# GAFFER_CONCURRENCY>1 — runner-owned bookkeeping stays isolated per worker.
# ---------------------------------------------------------------------
# Under GAFFER_CONCURRENCY>1, loop.sh spawns N worker.sh, each running a SEPARATE
# `bash tick.sh` process against the SAME dispatch DB. The DB is the ONLY arbiter.
# `claim-token-isolation.test.sh` proves the per-tick MCP runtime FILE is isolated;
# this test proves the DB-level BOOKKEEPING invariants two racing workers rely on,
# by driving the REAL dispatch CLI with genuinely concurrent processes:
#
#   PART A  NO DOUBLE-CLAIM AT SCALE: many workers race across many ready tickets.
#     Every ticket ends with AT MOST ONE active claim; every issued token is
#     distinct; the number of claims equals the number of tickets (each claimed
#     exactly once — nothing double-claimed, nothing lost).
#
#   PART B  CROSS-TOKEN ISOLATION (the behavioral twin of the runtime-file bug):
#     worker A holds ticket #A's token, worker B holds ticket #B's token. A token
#     is bound to ITS ticket + claim — so A's token can NEITHER record evidence NOR
#     submit B's ticket (CLAIM_INVALID), and vice-versa. A worker that read the
#     WRONG token (the runtime-file clobber) would therefore be REJECTED by the DB,
#     not silently corrupt another worker's delivery. Control: each worker's OWN
#     token DOES work on its OWN ticket.
#
#   PART C  PARALLEL DELIVERIES STAY ISOLATED + FAIL SAFE: two workers concurrently
#     run the record-evidence → submit sequence for their OWN claimed tickets.
#     Each delivery only ever touches ITS OWN ticket/claim/evidence — never the
#     other's — and each ticket ends `in_review` with ITS OWN AC satisfied and its
#     claim completed. See the NOTE below on the SQLITE_BUSY-under-parallelism
#     limitation this exercises (a REPORTED bug), and why the delivery helper
#     retries a transient lock.
#
# NOTE — REPORTED BUG (dispatch `inTransaction` uses a DEFERRED transaction):
#   packages/dispatch/src/db/connection.ts `inTransaction` wraps writes in
#   `db.transaction(fn)` (DEFERRED) though its JSDoc says "immediate". Two worker
#   PROCESSES sharing one SQLite DB then intermittently hit
#   `SQLITE_BUSY: database is locked` on a concurrent read-modify-write (evidence /
#   submit / transition) EVEN WITH busy_timeout=5000ms, because SQLite does not run
#   the busy handler when a deferred txn must UPGRADE its read lock to a write lock
#   (SQLITE_BUSY_SNAPSHOT). It fails SAFE — the txn rolls back, so no partial or
#   cross-ticket write lands and the ticket stays cleanly claimed + retryable — but
#   it causes spurious delivery failures / wasted rework under GAFFER_CONCURRENCY>1.
#   Fix (production, out of scope for this additive test): `.immediate()` on the
#   transaction. This test therefore asserts the guarantees the system ACTUALLY
#   makes under parallelism — isolation + fail-closed + recover-on-retry — and its
#   delivery helper retries the transient lock exactly as the runner's repeated
#   ticks / park-and-retry would. It never retries a REAL rejection (wrong token).
#
# Requires the dispatch CLI to be built. SKIPs (exit 0) if it isn't.
# Run: bash test/concurrency-bookkeeping.test.sh
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

WORK="$(mktemp -d "${TMPDIR:-/tmp}/concurrency-bk.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
DB="$WORK/dispatch.sqlite"
wg()   { node "$CLI_JS" --db "$DB" "$@"; }
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }
status_of() { wg ticket show "$1" 2>/dev/null | jget "d['ticket']['status']" 2>/dev/null || echo ''; }
ac_status_of() { wg ticket show "$1" 2>/dev/null | jget "d['acceptanceCriteria'][0]['status']" 2>/dev/null || echo ''; }

# DB-level claim ledger queries (the DB is the arbiter under contention).
claims_active_total() {
  python3 - "$DB" <<'PY'
import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
print(c.execute("SELECT count(*) FROM ticket_claims WHERE status='active'").fetchone()[0])
PY
}
max_active_claims_per_ticket() {
  python3 - "$DB" <<'PY'
import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
rows=c.execute("SELECT ticket_id,count(*) FROM ticket_claims WHERE status='active' GROUP BY ticket_id").fetchall()
print(max((r[1] for r in rows), default=0))
PY
}
# Count evidence rows attributed to a ticket whose summary matches a tag — proves a
# ticket only ever carries ITS OWN evidence (no cross-write from the other worker).
evidence_count_matching() {  # $1 ticket number, $2 summary substring
  python3 - "$DB" "$1" "$2" <<'PY'
import sqlite3,sys
db,num,tag=sys.argv[1],int(sys.argv[2]),sys.argv[3]
c=sqlite3.connect(db)
row=c.execute("SELECT id FROM tickets WHERE number=?",(num,)).fetchone()
if not row: print(0); raise SystemExit
n=c.execute("SELECT count(*) FROM evidence WHERE ticket_id=? AND summary LIKE ?",(row[0],f"%{tag}%")).fetchone()[0]
print(n)
PY
}

wg init >/dev/null 2>&1
A1="$(wg agent register -n w1 --max-risk high 2>/dev/null | jget "d['agent']['id']")"
A2="$(wg agent register -n w2 --max-risk high 2>/dev/null | jget "d['agent']['id']")"
[ -n "$A1" ] && [ -n "$A2" ] || { echo "SKIP: could not register agents"; exit 0; }

# The EXACT candidate-loop claim step from tick.sh: claim; capture the token; an
# empty token ⇒ the tick would `continue` (skip this candidate). Byte-identical to
# factory.config.sh's wg/jget wrappers, so this is what two worker ticks run.
runner_claim() {  # $1 ticket number, $2 agent id → echoes the captured token (may be empty)
  local _cand="$1" AGENT="$2" GAFFER_CLAIM_TTL=900 _j _t
  _j="$(wg claim-ticket "$_cand" --agent "$AGENT" --ttl "$GAFFER_CLAIM_TTL" 2>/dev/null || true)"
  _t="$(printf '%s' "$_j" | jget "d.get('claimToken','')" 2>/dev/null || echo '')"
  printf '%s' "$_t"
}

echo "== PART A: N workers race across M ready tickets → no double-claim, none lost =="
TICKETS=12          # ready tickets on the board
WORKERS=6           # concurrent workers hammering the SAME board (>1: the point)
for n in $(seq 1 "$TICKETS"); do
  wg ticket create -t "T$n" --risk low >/dev/null 2>&1
  wg ac add "$n" -t "AC$n" >/dev/null 2>&1
  wg ticket ready "$n" >/dev/null 2>&1
done
# Each worker sweeps EVERY ticket number trying to claim it (exactly the candidate
# scan two worker.sh ticks do against the shared board). Real workers tick REPEATEDLY,
# so a ticket a worker couldn't take this pass (lost the race, or a transient claim
# lock) is retried on a later pass — mirror that with bounded re-sweeps so the board
# is fully drained deterministically. Tokens captured go to a per-(worker,ticket)
# file so we can prove global uniqueness afterwards.
worker_sweep() {  # $1 worker index, $2 agent id
  local w="$1" ag="$2" n tok pass
  for pass in 1 2 3 4 5; do
    local any_ready=0
    for n in $(seq 1 "$TICKETS"); do
      [ -f "$WORK/tok.$w.$n" ] && continue                 # already ours
      [ "$(status_of "$n")" = "ready" ] || continue        # taken by someone / not ready
      any_ready=1
      tok="$(runner_claim "$n" "$ag")"
      [ -n "$tok" ] && printf '%s\n' "$tok" > "$WORK/tok.$w.$n"
    done
    [ "$any_ready" -eq 0 ] && break
  done
}
pids=()
for w in $(seq 1 "$WORKERS"); do
  ag="$A1"; [ $((w % 2)) -eq 0 ] && ag="$A2"
  worker_sweep "$w" "$ag" & pids+=("$!")
done
for p in "${pids[@]}"; do wait "$p"; done

# Every issued token must be globally distinct (no two workers hold the same claim).
TOTAL_TOKENS="$(cat "$WORK"/tok.* 2>/dev/null | wc -l | tr -d ' ')"
DISTINCT_TOKENS="$(cat "$WORK"/tok.* 2>/dev/null | sort -u | wc -l | tr -d ' ')"
[ "$TOTAL_TOKENS" = "$DISTINCT_TOKENS" ] && [ "$TOTAL_TOKENS" = "$TICKETS" ] \
  && ok "each of $TICKETS tickets claimed exactly once — $TOTAL_TOKENS distinct tokens, no double-claim, none lost" \
  || fail "claim ledger wrong: total=$TOTAL_TOKENS distinct=$DISTINCT_TOKENS expected=$TICKETS"
[ "$(max_active_claims_per_ticket)" = "1" ] \
  && ok "no ticket carries more than ONE active claim (partial-unique index held under contention)" \
  || fail "a ticket has >1 active claim — the index did not arbitrate the race"
[ "$(claims_active_total)" = "$TICKETS" ] \
  && ok "exactly $TICKETS active claims in the DB (one per ticket)" \
  || fail "expected $TICKETS active claims, got $(claims_active_total)"
STILL_READY=0
for n in $(seq 1 "$TICKETS"); do [ "$(status_of "$n")" = "ready" ] && STILL_READY=$((STILL_READY+1)); done
[ "$STILL_READY" = "0" ] \
  && ok "no ticket starved — all $TICKETS moved ready → claimed" \
  || fail "$STILL_READY ticket(s) left ready after the race"

echo "== PART B: a token is bound to ITS ticket — cross-token writes are REJECTED =="
NA="$(wg ticket create -t "iso-A" --risk low | jget "d['ticket']['number']")"
ACA="$(wg ac add "$NA" -t "A works" | jget "d['ac_id']")"; wg ticket ready "$NA" >/dev/null
NB="$(wg ticket create -t "iso-B" --risk low | jget "d['ticket']['number']")"
ACB="$(wg ac add "$NB" -t "B works" | jget "d['ac_id']")"; wg ticket ready "$NB" >/dev/null
TOKA="$(runner_claim "$NA" "$A1")"
TOKB="$(runner_claim "$NB" "$A2")"
[ -n "$TOKA" ] && [ -n "$TOKB" ] || fail "PART B setup: could not claim both tickets"

# A's token on B's ticket must fail (this is exactly the failure a runtime-file
# clobber would trigger — the DB rejects it rather than corrupting B's delivery).
if wg evidence "$NB" --token "$TOKA" --type test_output --summary x --ac "$ACB" >/dev/null 2>&1; then
  fail "B1: worker A's token WRONGLY recorded evidence on worker B's ticket"
else
  ok "B1: worker A's token is REJECTED recording evidence on B's ticket (CLAIM_INVALID)"
fi
if wg submit "$NB" --token "$TOKA" --reason x >/dev/null 2>&1; then
  fail "B2: worker A's token WRONGLY submitted worker B's ticket"
else
  ok "B2: worker A's token is REJECTED submitting B's ticket (CLAIM_INVALID)"
fi
if wg evidence "$NA" --token "$TOKA" --type test_output --summary "OWN-A" --ac "$ACA" >/dev/null 2>&1; then
  ok "B3 control: worker A's OWN token records evidence on A's OWN ticket"
else
  fail "B3 control: worker A's own token failed on its own ticket"
fi

echo "== PART C: two parallel deliveries stay isolated + fail closed + recover =="
# Fresh dedicated tickets so the active-claim bookkeeping is exact for this part.
NC="$(wg ticket create -t "dlv-C" --risk low | jget "d['ticket']['number']")"
ACC="$(wg ac add "$NC" -t "C works" | jget "d['ac_id']")"; wg ticket ready "$NC" >/dev/null
ND="$(wg ticket create -t "dlv-D" --risk low | jget "d['ticket']['number']")"
ACD="$(wg ac add "$ND" -t "D works" | jget "d['ac_id']")"; wg ticket ready "$ND" >/dev/null
TOKC="$(runner_claim "$NC" "$A1")"
TOKD="$(runner_claim "$ND" "$A2")"
BEFORE_ACTIVE="$(claims_active_total)"   # includes the two we just took + Part A/B leftovers

# Deliver a ticket with ITS OWN token: record evidence (tagged so we can prove
# attribution) then submit. Retries ONLY the transient SQLITE_BUSY lock (the reported
# deferred-transaction limitation), exactly as the runner's repeated ticks would; a
# real rejection (wrong token, illegal state) is NOT a lock and is not retried.
deliver_with_retry() {  # $1 num, $2 token, $3 acId, $4 tag, $5 result-file
  local num="$1" tok="$2" ac="$3" tag="$4" out="$5" try eout
  eout="$WORK/e.$num"
  for try in 1 2 3 4 5 6; do
    if wg evidence "$num" --token "$tok" --type test_output --summary "$tag" --ac "$ac" >"$eout" 2>&1; then break; fi
    grep -qi "SQLITE_BUSY\|database is locked" "$eout" || break   # a REAL rejection: stop, don't mask
    sleep 0.15
  done
  for try in 1 2 3 4 5 6; do
    if wg submit "$num" --token "$tok" --reason "done $num" >"$eout" 2>&1; then echo ok > "$out"; return 0; fi
    grep -qi "SQLITE_BUSY\|database is locked" "$eout" || { echo err > "$out"; return 0; }
    sleep 0.15
  done
  echo err > "$out"
}
deliver_with_retry "$NC" "$TOKC" "$ACC" "OWN-C" "$WORK/dlv.C" &
pC=$!
deliver_with_retry "$ND" "$TOKD" "$ACD" "OWN-D" "$WORK/dlv.D" &
pD=$!
wait "$pC"; wait "$pD"

{ [ "$(cat "$WORK/dlv.C")" = ok ] && [ "$(cat "$WORK/dlv.D")" = ok ]; } \
  && ok "C1: both parallel deliveries completed (fail-closed lock was transient + recoverable on retry)" \
  || fail "C1: a parallel delivery did not recover (C=$(cat "$WORK/dlv.C" 2>/dev/null) D=$(cat "$WORK/dlv.D" 2>/dev/null))"
{ [ "$(status_of "$NC")" = in_review ] && [ "$(status_of "$ND")" = in_review ]; } \
  && ok "C2: both tickets reached in_review (each claim completed by its own token)" \
  || fail "C2: expected both in_review (C=$(status_of "$NC") D=$(status_of "$ND"))"
{ [ "$(ac_status_of "$NC")" = satisfied ] && [ "$(ac_status_of "$ND")" = satisfied ]; } \
  && ok "C3: each ticket's AC satisfied by ITS OWN evidence" \
  || fail "C3: AC not satisfied per-ticket (C=$(ac_status_of "$NC") D=$(ac_status_of "$ND"))"
# ISOLATION: each ticket carries ONLY its own tag, and NONE of the other's.
{ [ "$(evidence_count_matching "$NC" OWN-C)" -ge 1 ] && [ "$(evidence_count_matching "$NC" OWN-D)" = 0 ] \
  && [ "$(evidence_count_matching "$ND" OWN-D)" -ge 1 ] && [ "$(evidence_count_matching "$ND" OWN-C)" = 0 ]; } \
  && ok "C4: no cross-contamination — each ticket holds only its own evidence, never the other worker's" \
  || fail "C4: evidence cross-contamination detected (C-own=$(evidence_count_matching "$NC" OWN-C) C-foreign=$(evidence_count_matching "$NC" OWN-D) D-own=$(evidence_count_matching "$ND" OWN-D) D-foreign=$(evidence_count_matching "$ND" OWN-C))"
# Both claims completed → the active count dropped by exactly the two we took.
EXPECT_AFTER=$((BEFORE_ACTIVE - 2))
[ "$(claims_active_total)" = "$EXPECT_AFTER" ] \
  && ok "C5: both claims completed on submit — active-claim count fell by exactly 2 ($BEFORE_ACTIVE → $EXPECT_AFTER)" \
  || fail "C5: active-claim count is $(claims_active_total), expected $EXPECT_AFTER"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "concurrency-bookkeeping: ALL $PASS checks passed"
  exit 0
fi
echo "concurrency-bookkeeping: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
