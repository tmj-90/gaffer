#!/usr/bin/env bash
# =====================================================================
# "THIS CANNOT BE PROVEN ON THIS HOST" IS A HOLD FOR A PERSON (package H3).
# ---------------------------------------------------------------------
# A live supervised run (Nov 9, ticket #7): the tester's verdict on a correct delivery was
# "FAIL: AC5 couldn't be shown. I couldn't press Enter in a real DOM or watch the URL,
# because the safety hook blocked installing jsdom. AC1-AC4 pass, and npm test passes".
# The host had no browser; the FAIL cost a rework that could not fix the host, and in an
# autonomous posture it would loop to the retry cap. The tester now has a third final
# token, {"verdict":"UNPROVABLE","criteria":[...],"needs":"..."}, and it can only ever
# stop the ticket for a person. Pinned here in the AUTONOMOUS posture (the runner may drive
# the review gate: agent approval and auto-merge on, so a tester FAIL reworks), with real
# dispatch, real tick.sh, the real bin/tester-run.mjs and a stub agent counted from its own
# invocation log:
#   1. the live case: UNPROVABLE for criterion 5 with four proven criteria is HELD
#      in_testing (tester_unprovable, criteria, reason, tested commit on the ticket, in the
#      factory log and in `wg stats`): not reworked, not reviewed, not approved, not merged
#   2. a second daemon pass does not run the tester again on the same head
#   3. a new commit on the delivery branch is tested afresh (and held again)
#   4. after a person's PASS on the hold: the single agent review, approval and landing
#   (5-7, which verdict wins: tester-unprovable-verdicts.test.sh; 8-11, malformed,
#   non-final and planted tokens and a declared need the host lacks:
#   tester-unprovable-tokens.test.sh; each on its own copy of the same world)
# Run: bash runner/test/tester-unprovable.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
# shellcheck source=lib/tester-unprovable-world.sh
source "$HERE/lib/tester-unprovable-world.sh"

echo "== 1. the live case: UNPROVABLE for criterion 5, four criteria proven =="
A="$(new_ticket "Enter submits the search" 5 live)"
daemon_pass
HA="$(branch_head "$A")"
[ -n "$HA" ] && ok "setup: #$A delivered (head ${HA:0:12})" || fail "setup: #$A has no delivery head (status $(st "$A"))"
[ "$(calls tester "$A" "$HA")" = 1 ] && ok "1: the tester ran once on ${HA:0:12}" || fail "1: tester calls on the head: $(calls tester "$A" "$HA") ($(tr '\n' '|' < "$CALLS"))"
[ "$(st "$A")" = in_testing ] && ok "1: #$A is HELD in_testing" || fail "1: #$A is $(st "$A") (not held)"
[ "$(lv_field "$A" verdict)" = held ] && [ "$(lv_field "$A" held_code)" = tester_unprovable ] \
  && ok "1: the runner recorded a held tester verdict coded tester_unprovable" || fail "1: tester lane verdict: $(tester_lv "$A")"
[ "$(lv_field "$A" criteria)" = 5 ] && ok "1: it names criterion 5" || fail "1: criteria: $(lv_field "$A" criteria)"
[ "$(lv_field "$A" commit)" = "$HA" ] && ok "1: it names the tested commit" || fail "1: commit: $(lv_field "$A" commit) (head $HA)"
case "$(lv_field "$A" held_reason)" in *"real DOM"*) ok "1: it carries the tester's reason" ;; *) fail "1: reason: $(lv_field "$A" held_reason)" ;; esac
grep -q "^tester held: tester_unprovable: criteria 5 cannot be proven on this host (a real DOM" <<<"$(notes "$A")" \
  && ok "1: the hold, its criteria and reason are on the ticket" || fail "1: no unprovable note on #$A: $(notes "$A" | grep 'tester held' | head -2)"
grep "^tester held: tester_unprovable" <<<"$(notes "$A")" | grep "tested commit ${HA:0:12}" >/dev/null \
  && ok "1: the note names the tested commit" || fail "1: the note lacks the tested commit"
grep -q "TESTER: #$A HELD in_testing for a person: tester_unprovable: criteria 5" "$GAFFER_DATA/factory.log" \
  && ok "1: the factory log says it is held for a person" || fail "1: no hold line in the log: $(grep "TESTER: #$A" "$GAFFER_DATA/factory.log" | tail -2)"
[ "$(calls review "$A")" = 0 ] && ok "1: no reviewer was paid for it" || fail "1: $(calls review "$A") review(s) of #$A"
[ "$(calls deliver "$A")" = 1 ] && ok "1: not reworked (one delivery)" || fail "1: $(calls deliver "$A") deliveries of #$A"
[ "$(merged_on_main "$A")" = 0 ] && ok "1: nothing merged" || fail "1: #$A was merged"
[ "$(tester_verdicts "$A")" = 0 ] && ok "1: no tester verdict was recorded (no PASS, no FAIL)" || fail "1: $(tester_verdicts "$A") tester verdict row(s) on #$A"
[ "$(wg stats --json 2>/dev/null | jget "((d.testerHolds||{}).held||[]).some(h => h.number === $A && h.code === 'tester_unprovable' && h.criteria.join() === '5') ? 'yes' : 'no'")" = yes ] \
  && ok "1: wg stats lists the hold" || fail "1: wg stats does not list #$A"
[ "$(wg stats --json 2>/dev/null | jget '(d.testerHolds||{}).counts.unprovable')" -ge 1 ] && ok "1: wg stats counts it apart" || fail "1: unprovable count missing"

echo "== 2. a second daemon pass does not test the same head again =="
daemon_pass
[ "$(calls tester "$A" "$HA")" = 1 ] && ok "2: still one tester run on ${HA:0:12}" || fail "2: ${HA:0:12} tested $(calls tester "$A" "$HA") times"
[ "$(st "$A")" = in_testing ] && [ "$(calls review "$A")" = 0 ] && ok "2: still held, still unreviewed" || fail "2: #$A is $(st "$A") with $(calls review "$A") reviews"
grep -q "TESTER: #$A is still HELD in_testing for a person on ${HA:0:12}" "$GAFFER_DATA/factory.log" \
  && ok "2: the log says it is still held on that commit" || fail "2: no still-held line"

echo "== 3. a new commit on the delivery branch is tested afresh =="
BR="$(wg ticket show "$A" 2>/dev/null | jget 'd.ticket.branch_name')"
( cd "$R" && git checkout -q "$BR" && printf 'fix\n' >> docs/change.md && gitc commit -qam "a person's fix" && git checkout -q main )
HA2="$(branch_head "$A")"
daemon_pass
[ "$HA2" != "$HA" ] && [ "$(calls tester "$A" "$HA2")" = 1 ] && ok "3: the new head ${HA2:0:12} was tested once" || fail "3: tester calls on ${HA2:0:12}: $(calls tester "$A" "$HA2")"
[ "$(lv_field "$A" commit)" = "$HA2" ] && [ "$(st "$A")" = in_testing ] && ok "3: held again on the new commit" || fail "3: #$A is $(st "$A"), lane verdict $(tester_lv "$A")"
daemon_pass
[ "$(calls tester "$A" "$HA2")" = 1 ] && ok "3: and not tested again on it" || fail "3: ${HA2:0:12} tested $(calls tester "$A" "$HA2") times"

echo "== 4. after a person's PASS on the hold: one agent review, approval and landing =="
person_waives "$A" && ok "4: a person recorded the tester PASS (a waiver)" || fail "4: the person's PASS was refused"
daemon_pass
[ "$(calls review "$A")" = 1 ] && ok "4: exactly one agent review" || fail "4: $(calls review "$A") reviews of #$A"
[ "$(st "$A")" = done ] && ok "4: approved and landed (done)" || fail "4: #$A is $(st "$A")"
[ "$(calls tester "$A")" = 2 ] && ok "4: the tester was not run again" || fail "4: $(calls tester "$A") tester runs on #$A"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "tester-unprovable: ALL $PASS checks passed"; exit 0; fi
echo "tester-unprovable: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1
