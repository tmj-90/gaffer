#!/usr/bin/env bash
# =====================================================================
# FINDING-12 — a BOOTSTRAP failure must park VISIBLY, never invisibly.
# ---------------------------------------------------------------------
# The four bootstrap-failure parks (agent rc≠0, no initial commit, hygiene
# violation, missing minimalism note) were downgraded from the visible
# `wg block` (ticket.blocked event + attention count) to `refining` — a column
# that selection, clarify, status.sh and the human queue ALL ignore, so a
# failed bootstrap silently vanished from every human surface.
#
# The fix routes them through gaffer_release_delivery `blocked` with the
# structured reason code `bootstrap_failed`. This test proves, with the REAL
# dispatch CLI + DB and the REAL gaffer_release_delivery extracted verbatim
# from tick.sh:
#   AC1  a bootstrap-failure park lands the ticket in `blocked`;
#   AC2  last_review_feedback carries code=bootstrap_failed (the card shows WHY);
#   AC3  a ticket.blocked event with reason_code=bootstrap_failed is appended
#        (the paging surface);
#   AC4  `wg stats` ticketsByStatus.blocked counts it — EXACTLY the figure
#        status.sh folds into its "a human is needed" attention count;
#   AC5  NEGATIVE CONTROL: the pre-fix park (→ refining) never appears in that
#        blocked count — proves the old behaviour was invisible and this bites;
#   AC6  WIRING: every bootstrap failure park in tick.sh targets `blocked`
#        with the bootstrap_failed reason code; none targets `refining`.
#
# Requires the dispatch CLI to be built. SKIPs (exit 0) if it isn't.
# Run: bash runner/test/bootstrap-park-visible.test.sh
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

WORK="$(mktemp -d "${TMPDIR:-/tmp}/bootstrap-park.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
DB="$WORK/dispatch.sqlite"

# The runner wraps the CLI as `wg`; jget reads stdin JSON as `d` — byte-identical
# to factory.config.sh so the extracted function runs EXACTLY as it does in tick.sh.
wg()   { node "$CLI_JS" --db "$DB" "$@"; }
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }
LOGF="$WORK/log.txt"; : > "$LOGF"
log()  { printf '%s\n' "$*" >> "$LOGF"; }

status_of()    { wg ticket show "$1" 2>/dev/null | jget "d['ticket']['status']" 2>/dev/null || echo ''; }
blocked_count() { wg stats --json 2>/dev/null | jget "(d.get('ticketsByStatus') or {}).get('blocked', 0)" 2>/dev/null || echo ''; }
feedback_of() {
  python3 - "$DB" "$1" <<'PY'
import sqlite3,sys
db,num=sys.argv[1],int(sys.argv[2])
c=sqlite3.connect(db)
row=c.execute("SELECT last_review_feedback FROM tickets WHERE number=?",(num,)).fetchone()
print(row[0] or '' if row else '')
PY
}
blocked_events() {  # $1 = num, $2 = reason_code
  python3 - "$DB" "$1" "$2" <<'PY'
import sqlite3,sys
db,num,code=sys.argv[1],int(sys.argv[2]),sys.argv[3]
c=sqlite3.connect(db)
n=c.execute("SELECT count(*) FROM work_events we JOIN tickets t ON t.id=we.entity_id "
            "WHERE t.number=? AND we.event_type='ticket.blocked' "
            "AND we.payload_json LIKE ?",(num,'%'+code+'%')).fetchone()[0]
print(n)
PY
}

# ── The REAL gaffer_release_delivery, extracted verbatim from tick.sh ────────
extract_fn() {
  awk -v fn="$1" '
    $0 ~ "^" fn "\\(\\) \\{" {print; if ($0 ~ /\}[[:space:]]*$/) exit; p=1; next}
    p {print; if ($0 ~ /^\}/) exit}
  ' "$TICK"
}
SRC="$WORK/real-fns.sh"
extract_fn "gaffer_release_delivery" > "$SRC"
grep -q '^gaffer_release_delivery() {' "$SRC" \
  || { echo "FAIL: could not extract real 'gaffer_release_delivery' from tick.sh"; exit 1; }
# shellcheck disable=SC1090
source "$SRC"
DRY_RUN=0

# One ready, claimable bootstrap-shaped ticket → echoes its number.
AGENT="$(wg init >/dev/null 2>&1; wg agent register -n fac --max-risk high 2>/dev/null | jget "d['agent']['id']")"
[ -n "$AGENT" ] || { echo "SKIP: could not register agent"; exit 0; }
make_claimed_ticket() {  # $1 = title → sets NUM + CLAIM_TOKEN
  NUM="$(wg ticket create -t "$1" --risk low 2>/dev/null | jget "d['ticket']['number']")"
  wg ac add "$NUM" -t "AC" >/dev/null 2>&1
  wg ticket ready "$NUM" >/dev/null 2>&1
  CLAIM_TOKEN="$(wg claim-ticket "$NUM" --agent "$AGENT" --ttl 900 2>/dev/null | jget "d['claimToken']" 2>/dev/null || echo '')"
  [ -n "$NUM" ] && [ -n "$CLAIM_TOKEN" ]
}

echo "== AC1-AC4: a bootstrap failure parks VISIBLY to blocked =="
make_claimed_ticket "greenfield bootstrap" || fail "setup: could not create+claim a ticket"
BASE_BLOCKED="$(blocked_count)"
# The exact park shape tick.sh's bootstrap rc-failure path now uses.
gaffer_release_delivery blocked "bootstrap failed (rc=1) — scaffold left at /tmp/x for inspection" bootstrap_failed
[ "$(status_of "$NUM")" = "blocked" ] \
  && ok "AC1: bootstrap failure park landed #$NUM in blocked (was refining — invisible)" \
  || fail "AC1: #$NUM is '$(status_of "$NUM")' (want blocked)"
printf '%s' "$(feedback_of "$NUM")" | grep -q 'bootstrap_failed' \
  && ok "AC2: last_review_feedback carries code=bootstrap_failed (card shows WHY)" \
  || fail "AC2: last_review_feedback lacks bootstrap_failed (got '$(feedback_of "$NUM")')"
[ "$(blocked_events "$NUM" bootstrap_failed)" -ge 1 ] 2>/dev/null \
  && ok "AC3: ticket.blocked event with reason_code=bootstrap_failed appended (pages a human)" \
  || fail "AC3: no ticket.blocked/bootstrap_failed event recorded"
NOW_BLOCKED="$(blocked_count)"
[ -n "$NOW_BLOCKED" ] && [ "$NOW_BLOCKED" -gt "${BASE_BLOCKED:-0}" ] 2>/dev/null \
  && ok "AC4: wg stats blocked count rose ($BASE_BLOCKED → $NOW_BLOCKED) — the figure status.sh pages on" \
  || fail "AC4: blocked count did not rise ($BASE_BLOCKED → $NOW_BLOCKED)"

echo "== AC5: NEGATIVE CONTROL — the pre-fix refining park is invisible to that count =="
make_claimed_ticket "greenfield bootstrap (control)" || fail "setup: could not create+claim the control ticket"
BASE_BLOCKED="$(blocked_count)"
gaffer_release_delivery refining "bootstrap failed (rc=1) — pre-fix shape"
[ "$(status_of "$NUM")" = "refining" ] || fail "AC5 setup: control ticket not in refining"
CTRL_BLOCKED="$(blocked_count)"
[ "$CTRL_BLOCKED" = "$BASE_BLOCKED" ] \
  && ok "AC5: a refining park never reaches the blocked/attention count (the invisibility this fixes)" \
  || fail "AC5: refining park unexpectedly changed the blocked count ($BASE_BLOCKED → $CTRL_BLOCKED)"

echo "== AC6: WIRING — every tick.sh bootstrap failure park targets blocked =="
N_BLOCKED_PARKS="$(grep -c 'gaffer_release_delivery blocked "bootstrap' "$TICK" 2>/dev/null || echo 0)"
# Three real bootstrap FAILURES park to blocked: rc≠0, no-commit, hygiene. The minimalism
# lens is NOT one of them — a greenfield scaffold has no pre-existing code to make a
# "smallest change" against, so a missing smallest-change note is FLAGGED for human review,
# never a park (blocking a valid scaffold is the bug that flag replaced).
[ "$N_BLOCKED_PARKS" -eq 3 ] 2>/dev/null \
  && ok "all 3 bootstrap failure parks (rc≠0 / no-commit / hygiene) target blocked" \
  || fail "expected 3 'gaffer_release_delivery blocked \"bootstrap' parks in tick.sh (found $N_BLOCKED_PARKS)"
if grep -q 'gaffer_release_delivery refining "bootstrap' "$TICK"; then
  fail "tick.sh still parks a bootstrap failure to refining (invisible)"
else
  ok "no bootstrap failure park targets refining any more"
fi
grep -c 'bootstrap_failed' "$TICK" | grep -q '^3$' \
  && ok "each bootstrap park carries the structured bootstrap_failed reason code" \
  || fail "expected the bootstrap_failed reason code on all 3 parks (found $(grep -c 'bootstrap_failed' "$TICK"))"
# The minimalism lens must stay a FLAG (needs_human_review), not a park — lock that in so a
# future edit can't silently turn a valid greenfield scaffold back into a blocked ticket.
grep -q 'EXEMPT (fresh scaffold); flagging not failing' "$TICK" \
  && ok "bootstrap minimalism is FLAGGED (needs_human_review), never parked" \
  || fail "bootstrap minimalism no longer flags-not-fails — a valid scaffold could be blocked again"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "bootstrap-park-visible: ALL $PASS checks passed"
  exit 0
fi
echo "bootstrap-park-visible: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
