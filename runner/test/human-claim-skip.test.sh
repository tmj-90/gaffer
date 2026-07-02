#!/usr/bin/env bash
# =====================================================================
# TRACK-2b — a factory tick STRUCTURALLY skips a human-owned ticket.
# ---------------------------------------------------------------------
# When a human takes a ticket "by hand" (`wg human-claim`) it moves ready ->
# in_progress OWNED BY THE HUMAN. The factory tick must never select or claim it.
# This drives the EXACT selection primitives tick.sh uses against the real dispatch
# CLI (no worktree/agent needed):
#
#   (a) CANDIDATE SCAN: tick.sh builds its candidate list from `wg ticket list -s
#       ready`. A human-owned ticket is in_progress, so it is ABSENT from that list —
#       the candidate loop can never even consider it.
#   (b) ATOMIC CLAIM: the runner's `wg claim-ticket` (claim-at-selection) REFUSES a
#       human-owned ticket → no token → the tick would skip it.
#   (c) CLAIM-NEXT: `wg claim` (next ready) never returns the human-owned ticket; it
#       picks the OTHER ready one and leaves the human's alone.
#   (d) HAND-BACK: `wg human-release` returns it to ready → the agent CAN claim it.
#   (e) WIRING: tick.sh selects candidates from `wg ticket list -s ready` (grep-proof).
#
# Requires the dispatch CLI to be built. SKIPs (exit 0) if it isn't.
# Run: bash test/human-claim-skip.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
CLI_JS="$ROOT/packages/dispatch/dist/cli/index.js"
TICK="$RUNNER_DIR/tick.sh"

command -v node    >/dev/null 2>&1 || { echo "SKIP: node required";    exit 0; }
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 required"; exit 0; }
[ -f "$CLI_JS" ] || { echo "SKIP: dispatch CLI not built ($CLI_JS) — run pnpm -C packages/dispatch build"; exit 0; }

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/human-claim-skip.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
DB="$WORK/dispatch.sqlite"
wg()   { node "$CLI_JS" --db "$DB" "$@"; }
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }
status_of() { wg ticket show "$1" 2>/dev/null | jget "d['ticket']['status']" 2>/dev/null || echo ''; }

# The EXACT candidate list tick.sh builds: numbers from `wg ticket list -s ready`.
ready_numbers() { wg ticket list -s ready 2>/dev/null | jget "' '.join(str(t['number']) for t in d)" 2>/dev/null || echo ''; }
# The EXACT claim-at-selection step (empty token ⇒ the tick skips the candidate).
runner_claim() { # $1 = number, $2 = agent → echoes captured token ('' ⇒ skip)
  local j; j="$(wg claim-ticket "$1" --agent "$2" --ttl 900 2>/dev/null || true)"
  printf '%s' "$j" | jget "d.get('claimToken','')" 2>/dev/null || echo ''
}

wg init >/dev/null 2>&1
# #1 = the human's by-hand ticket; #2 = an agent-shaped ticket.
for i in 1 2; do
  wg ticket create -t "T$i" --risk low >/dev/null 2>&1
  wg ac add "$i" -t "T$i AC" >/dev/null 2>&1
  wg ticket ready "$i" >/dev/null 2>&1
done
A1="$(wg agent register -n w1 --max-risk high 2>/dev/null | jget "d['agent']['id']")"
[ -n "$A1" ] || { echo "SKIP: could not register agent"; exit 0; }

echo "== human takes #1 by hand =="
wg human-claim 1 >/dev/null 2>&1
[ "$(status_of 1)" = "in_progress" ] && ok "#1 moved ready → in_progress (human-owned)" || fail "#1 not in_progress after human-claim (got '$(status_of 1)')"

echo "== (a) CANDIDATE SCAN: the human-owned ticket is absent from the ready list =="
RN="$(ready_numbers)"
case " $RN " in *" 1 "*) fail "#1 (human-owned) STILL appears in 'ticket list -s ready' → a tick could select it" ;; *) ok "#1 is NOT in the tick's candidate list (ready set: '${RN:-<empty>}')" ;; esac
case " $RN " in *" 2 "*) ok "#2 (agent-shaped) IS a candidate" ;; *) fail "#2 missing from the ready candidate list" ;; esac

echo "== (b) ATOMIC CLAIM: claim-at-selection refuses the human-owned ticket =="
TOK="$(runner_claim 1 "$A1")"
[ -z "$TOK" ] && ok "wg claim-ticket #1 captured NO token → the tick skips it" || fail "claim-ticket #1 captured a token '$TOK' — the runner claimed human-owned work"
[ "$(status_of 1)" = "in_progress" ] && ok "#1 is still human-owned in_progress (untouched by the claim attempt)" || fail "#1 status changed after a claim attempt (got '$(status_of 1)')"

echo "== (c) CLAIM-NEXT: the loop picks the OTHER ready ticket, never the human's =="
CLAIMED="$(wg claim --agent "$A1" --ttl 900 2>/dev/null | jget "d.get('ticketId','') or (d.get('claimed') and '') or ''" 2>/dev/null || echo '')"
# Resolve the claimed ticket's NUMBER via its status flip: #2 should now be claimed, #1 still human.
[ "$(status_of 2)" = "claimed" ] && ok "claim-next selected #2 (the agent-shaped ticket)" || fail "#2 not claimed by claim-next (got '$(status_of 2)')"
[ "$(status_of 1)" = "in_progress" ] && ok "claim-next left the human's #1 alone" || fail "#1 was disturbed by claim-next (got '$(status_of 1)')"

echo "== (d) HAND-BACK: releasing #1 makes it agent-claimable again =="
wg human-release 1 >/dev/null 2>&1
[ "$(status_of 1)" = "ready" ] && ok "#1 handed back → ready" || fail "#1 not ready after human-release (got '$(status_of 1)')"
RN2="$(ready_numbers)"
case " $RN2 " in *" 1 "*) ok "#1 is back in the tick's candidate list after hand-back" ;; *) fail "#1 not back in the ready candidate list after hand-back" ;; esac
TOK2="$(runner_claim 1 "$A1")"
[ -n "$TOK2" ] && ok "an agent CAN claim #1 once handed back (no longer human-owned)" || fail "agent could not claim #1 after hand-back"

echo "== (e) WIRING: tick.sh builds its candidate list from 'ticket list -s ready' =="
grep -q 'wg ticket list -s ready' "$TICK" \
  && ok "tick.sh selects candidates from the ready list (human-owned in_progress tickets are structurally excluded)" \
  || fail "tick.sh no longer sources candidates from 'ticket list -s ready' — re-verify the human-skip seam"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
fi
printf 'FAILURES (%d):\n' "${#FAILURES[@]}"
for f in "${FAILURES[@]}"; do printf '  - %s\n' "$f"; done
exit 1
