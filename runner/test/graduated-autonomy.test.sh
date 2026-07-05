#!/usr/bin/env bash
# =====================================================================
# GRADUATED AUTONOMY — the runner's AFK ship gate consults the per-repo/
# risk policy instead of the raw AUTO_MERGE/MERGE_ON_AGENT_REVIEW flags.
# ---------------------------------------------------------------------
# Proves the RUNNER-side wiring of "ship what you've earned, hold the rest"
# with ZERO network + a hermetic stubbed decision surface (no real dispatch
# DB): the CLI's isAutonomyAllowed correctness is pinned separately by the
# dispatch vitest suite; here we pin that the runner
#   1. maps (verdict × approve-gate × merge-gate) to the right action via the
#      pure gaffer_afk_ship_plan (the single source of truth), and
#   2. gaffer_auto_decision PASSES the autonomy env FLOOR into the CLI (the
#      flags are unexported shell vars) and PARSES the decision fail-closed, and
#   3. the three postures fall out end-to-end: supervised HOLDS in_review;
#      graduated ships an EARNED low-risk ticket but HOLDS high-risk / an
#      uncovered repo; autonomous SHIPS everything.
# Hermetic: sourced in a clean env (env -i), factory.config.sh's real `wg`
# is overridden by a stub that emulates isAutonomyAllowed from the env floor +
# a fake policy table. Zero deps beyond bash + python3 (jget). bash 3.2 safe.
# Run: bash runner/test/graduated-autonomy.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
eq()   { [ "$2" = "$3" ] && ok "$1 ($2)" || fail "$1 — expected '$3', got '$2'"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/grad-autonomy.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/data"   # empty → the settings.json loader is inert

# Run a snippet inside a hermetic shell that has sourced factory.config.sh (so the
# new helpers gaffer_afk_ship_plan / gaffer_auto_decision / jget are defined) and
# then installs a STUB `wg` emulating `wg ticket auto-decision`. The stub decides
# from the SAME contract as dispatch's isAutonomyAllowed:
#   allow  ⇔  env floor permits the gate  OR  the fake policy grants it.
# Env floor: approve ⇔ DISPATCH_ALLOW_AGENT_APPROVE=1; merge ⇔ AUTO_MERGE=1 AND
# MERGE_ON_AGENT_REVIEW=1. The fake policy is passed as STUB_POLICY (space list of
# earned gates, e.g. "approve merge"); STUB_POLICY empty ⇒ nothing earned. This lets
# us prove gaffer_auto_decision actually FORWARDS the floor (the stub only sees a flag
# if gaffer_auto_decision exported it) and PARSES the decision.
harness() {
  # $@ = extra NAME=value env assignments (mode floor + STUB_POLICY + inputs)
  env -i PATH="$PATH" HOME="$HOME" GAFFER_DATA="$WORK/data" "$@" \
    bash -c '
      source "'"$RUNNER_DIR"'/factory.config.sh" >/dev/null 2>&1
      # STUB the control-plane CLI: no DB, no network. Emulates isAutonomyAllowed.
      wg() {
        # Only handles: ticket auto-decision <ref> --gate <gate>
        if [ "$1" = "ticket" ] && [ "$2" = "auto-decision" ]; then
          local gate=""
          # crude flag parse (bash 3.2): find --gate <value>
          shift 2
          while [ "$#" -gt 0 ]; do
            case "$1" in --gate) gate="$2"; shift 2;; *) shift;; esac
          done
          local floor=0 policy=0
          case "$gate" in
            approve) [ "${DISPATCH_ALLOW_AGENT_APPROVE:-0}" = "1" ] && floor=1 ;;
            merge)   [ "${AUTO_MERGE:-0}" = "1" ] && [ "${MERGE_ON_AGENT_REVIEW:-0}" = "1" ] && floor=1 ;;
          esac
          case " ${STUB_POLICY:-} " in *" $gate "*) policy=1 ;; esac
          local decision=deny
          { [ "$floor" = "1" ] || [ "$policy" = "1" ]; } && decision=allow
          printf "{\"ok\":true,\"gate\":\"%s\",\"decision\":\"%s\"}\n" "$gate" "$decision"
          return 0
        fi
        return 0
      }
      # Emit: <approve-decision> <merge-decision> <ship-plan>
      A="$(gaffer_auto_decision 42 approve)"
      M="$(gaffer_auto_decision 42 merge)"
      P="$(gaffer_afk_ship_plan "${VERDICT:-approve}" "$A" "$M")"
      printf "%s %s %s\n" "$A" "$M" "$P"
    '
}

echo "== 1: gaffer_afk_ship_plan — the pure ship matrix (single source of truth) =="
plan() { env -i PATH="$PATH" HOME="$HOME" GAFFER_DATA="$WORK/data" bash -c '
  source "'"$RUNNER_DIR"'/factory.config.sh" >/dev/null 2>&1
  gaffer_afk_ship_plan "$1" "$2" "$3"' _ "$1" "$2" "$3"; }
eq "approve + earned approve + earned merge → ship"        "$(plan approve allow allow)" ship
eq "approve + earned approve + HELD merge → approve_hold"  "$(plan approve allow deny)"  approve_hold
eq "approve + DENIED approve → hold (stays in_review)"     "$(plan approve deny allow)"  hold
eq "changes + earned approve → rework"                     "$(plan changes allow allow)" rework
eq "changes + DENIED approve → hold (human handles)"       "$(plan changes deny deny)"   hold
eq "approve + both denied → hold"                          "$(plan approve deny deny)"   hold

echo "== 2: gaffer_auto_decision — parses the CLI + FAILS CLOSED on junk =="
# A malformed / empty CLI response must never read as allow.
badparse() { env -i PATH="$PATH" HOME="$HOME" GAFFER_DATA="$WORK/data" STUB_OUT="$1" bash -c '
  source "'"$RUNNER_DIR"'/factory.config.sh" >/dev/null 2>&1
  wg() { printf "%s" "${STUB_OUT}"; }
  gaffer_auto_decision 42 approve'; }
eq "empty CLI output → deny (fail-closed)"        "$(badparse "")"                              deny
eq "non-JSON CLI output → deny (fail-closed)"     "$(badparse "boom not json")"                 deny
eq "JSON missing 'decision' → deny (fail-closed)" "$(badparse '{"ok":true}')"                   deny
eq "explicit allow → allow"                        "$(badparse '{"decision":"allow"}')"          allow
eq "explicit deny → deny"                          "$(badparse '{"decision":"deny"}')"           deny

echo "== 3: SUPERVISED env floor (no policy) → both gates DENY → HOLD (in_review) =="
OUT="$(harness GAFFER_MODE=supervised STUB_POLICY= VERDICT=approve)"
eq "supervised: approve/merge/plan" "$OUT" "deny deny hold"

echo "== 4: GRADUATED (env floor off) — a low-risk ticket EARNED approve+merge SHIPS =="
# The floor is off (supervised-equivalent); STUB_POLICY carries the earned grants.
OUT="$(harness GAFFER_MODE=graduated STUB_POLICY='approve merge' VERDICT=approve)"
eq "graduated earned low-risk: approve/merge/plan" "$OUT" "allow allow ship"

echo "== 5: GRADUATED — a high-risk / UNCOVERED-repo ticket (no grant) HOLDS =="
OUT="$(harness GAFFER_MODE=graduated STUB_POLICY= VERDICT=approve)"
eq "graduated unearned: approve/merge/plan" "$OUT" "deny deny hold"

echo "== 6: GRADUATED — approve EARNED but merge NOT earned → approve_hold =="
OUT="$(harness GAFFER_MODE=graduated STUB_POLICY='approve' VERDICT=approve)"
eq "graduated approve-only: approve/merge/plan" "$OUT" "allow deny approve_hold"

echo "== 7: GRADUATED — CHANGES verdict on an earned ticket → rework =="
OUT="$(harness GAFFER_MODE=graduated STUB_POLICY='approve merge' VERDICT=changes)"
eq "graduated earned + CHANGES: approve/merge/plan" "$OUT" "allow allow rework"

echo "== 8: AUTONOMOUS env floor → both gates ALLOW → SHIP (no policy needed) =="
OUT="$(harness GAFFER_MODE=autonomous STUB_POLICY= VERDICT=approve)"
eq "autonomous: approve/merge/plan" "$OUT" "allow allow ship"

echo "== 9: proof the FLOOR is actually forwarded — half the merge floor is NOT enough =="
# Only AUTO_MERGE=1 (MERGE_ON_AGENT_REVIEW unset) must NOT satisfy the merge gate: this
# only passes if gaffer_auto_decision forwarded BOTH flags and the stub saw them.
OUT="$(harness GAFFER_MODE=supervised AUTO_MERGE=1 STUB_POLICY= VERDICT=approve)"
eq "half merge floor (AUTO_MERGE only): approve/merge/plan" "$OUT" "deny deny hold"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
