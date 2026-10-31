#!/usr/bin/env bash
# Gaffer — RE-GATE a conflict resolution (bin/dod-regate.sh). The delivery's
# Definition-of-Done gates (tests · typecheck · lint, lib/dod.sh) ran ONCE, on the
# delivered branch. A conflict resolution (bin/merge-ticket.mjs: the resolver agent
# merges the default branch INTO the delivery branch) is NEW code that nothing had
# gated: a resolution that broke the tests went back to review with the stale
# pre-resolution PASS as its evidence, the reviewer was told to trust that, and it
# landed on the default branch. merge-ticket.mjs runs THIS script BEFORE it reopens
# the ticket for re-review, on a FRESH DETACHED CHECKOUT of the branch's committed head
# (never the resolver's own worktree, whose uncommitted/untracked leftovers would be
# gated but not landed); a FAIL keeps the resolution off the branch and holds the
# ticket for a human.
#
#   dod-regate.sh <worktree> <repo-label> <test_cmd|-> <lint_cmd|-> [base-ref] [allow]
#
# GATE INTEGRITY: with a base-ref (the merge gate's gated target head, the conflict
# re-gate's default-branch tip) the gate row carries it as lib/dod.sh's base_ref, so
# each gate's package.json script is read from that commit (a branch that rewrote
# `scripts.test` cannot redirect the merge gate either) and an `integrity` row compares
# the base with the gated tree: PASS or FLAG, never FAIL, never an executed gate.
# allow is "1" when a human set allow_test_changes on the ticket (FLAG → PASS + note).
#
# Same gate runner, same per-gate toggles (GAFFER_DOD_TESTS / _TYPECHECK / _LINT,
# GAFFER_DOD_TYPECHECK_CMD), the SAME typecheck command as the delivery gate
# (gaffer_dod_typecheck_cmd: the override, else the repo's package.json typecheck
# script auto-detected from <base-ref> first — the merge gate passes the gated target
# head, the conflict re-gate the default branch's tip — so a branch cannot drop the
# gate by deleting the script), same pre-gate dependency install and the same
# zero-gates rule (GAFFER_ALLOW_NO_DOD) as the delivery gate in tick.sh. The gate
# commands run under the same OS sandbox decision as the delivery's (STRICT_MODE /
# GAFFER_STRICT_REQUIRE → lib/sandbox.sh, write root = this worktree; GAFFER_DOD_SANDBOX=0
# opts out); a required sandbox the host cannot supply FAILS the gate (fail closed).
#
# STDOUT: the evidence summary (lib/dod.sh gaffer_dod_evidence_summary — first line
#         "DoD: PASS|FAIL", then the JSON checklist), or one "DoD: OFF" line.
# EXIT:   0 every gate passed · 1 a gate failed / the gate could not run · 3 DoD is
#         OFF (GAFFER_DOD=0): nothing ran, the caller decides.
# shellcheck shell=bash
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WT="${1:-}" LABEL="${2:-repo}" TEST_CMD="${3:--}" LINT_CMD="${4:--}" BASE="${5:-}" ALLOW="${6:-0}"
[ "$ALLOW" = "1" ] || ALLOW=0
fail_line() {
  printf 'DoD: FAIL\n{"dod":"FAIL","gates":[{"gate":"config","repo":"%s","status":"FAIL","rc":"-","note":"%s"}]}\n' "$LABEL" "$1"
  exit 1
}
[ -n "$WT" ] && [ -d "$WT" ] || fail_line "no resolved worktree to gate"
# shellcheck source=../factory.config.sh
source "$HERE/factory.config.sh" >/dev/null 2>&1 || fail_line "factory.config.sh could not be sourced"
{ declare -F gaffer_run_dod_gates && declare -F gaffer_dod_typecheck_cmd; } >/dev/null 2>&1 || fail_line "the DoD gate runner (lib/dod.sh) is not available"
if ! gaffer_dod_enabled; then printf 'DoD: OFF\n'; exit 3; fi

# Sandbox: the gate runs the resolver's code. Decide the wrap for THIS worktree (an
# inherited GAFFER_DOD_WRAP names the delivery's roots, not ours).
export GAFFER_DOD_WRAP=""
if [ "${STRICT_MODE:-0}" = "1" ] || { declare -F _sandbox_strict_required >/dev/null 2>&1 && _sandbox_strict_required; }; then
  _WRAP=""
  if ! _WRAP="$(sandbox_wrap_cmd "$WT" "" 2>/dev/null)"; then
    fail_line "an OS sandbox is required (GAFFER_STRICT_REQUIRE) and none is available on this host — the gates were not run (fail closed)"
  fi
  case "${GAFFER_DOD_SANDBOX:-1}" in
    0|false|no|off) : ;;
    *) GAFFER_DOD_WRAP="$_WRAP" ;;
  esac
fi
trap 'rm -f "$GAFFER_DATA"/sandbox-write-roots.$$.* "$GAFFER_DATA"/sandbox-read-roots.$$.* "$GAFFER_DATA"/strict-profile.$$.* "${RESULTS:-}" 2>/dev/null || true' EXIT

[ -n "${TEST_CMD// /}" ] || TEST_CMD="-"
[ -n "${LINT_CMD// /}" ] || LINT_CMD="-"
# typecheck has no dispatch field: resolve it exactly as tick.sh's delivery gate does.
# Reading only GAFFER_DOD_TYPECHECK_CMD here SKIPPED the auto-detected typecheck, so a
# combination that only the repo's `typecheck` script catches passed the merge gate
# and landed red (and a repo whose only gate is that script ran zero gates here).
TC_CMD="$(gaffer_dod_typecheck_cmd "$WT" "$BASE")"; [ -n "${TC_CMD// /}" ] || TC_CMD="-"
if gaffer_dod_install_enabled; then gaffer_dod_install_deps "$WT" >/dev/null 2>&1 || true; fi
RESULTS="$(mktemp "${TMPDIR:-/tmp}/gaffer-regate.XXXXXX")" || fail_line "could not create a results file (mktemp failed)"
OVERALL=PASS
# GATE INTEGRITY: the base ref and the human's allowance ride as the row's trailing
# fields (`-` = no base: the commands run as registered and no integrity row is added).
_BASE_COL="$BASE"; [ -n "${_BASE_COL// /}" ] || _BASE_COL="-"
printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$LABEL" "$WT" "${GAFFER_DOD_TESTS:-1}" "${GAFFER_DOD_TYPECHECK:-1}" \
  "${GAFFER_DOD_LINT:-1}" "$TEST_CMD" "$TC_CMD" "$LINT_CMD" "$_BASE_COL" "$ALLOW" | gaffer_run_dod_gates "$RESULTS" || OVERALL=FAIL
# The integrity verdict goes to stderr (no tick `log` here); stdout stays the evidence.
gaffer_dod_log_integrity "$RESULTS" || true
if [ "$OVERALL" = PASS ] && [ "$(gaffer_dod_executed_count "$RESULTS")" -eq 0 ] && [ "${GAFFER_ALLOW_NO_DOD:-0}" != "1" ]; then
  # The delivery gate's rule: zero executed gates is not a verification.
  fail_line "zero DoD gates executed on the resolution (no test_command, lint_command or typecheck script configured; GAFFER_ALLOW_NO_DOD=1 waives)"
fi
gaffer_dod_evidence_summary "$RESULTS" "$OVERALL"; printf '\n'
[ "$OVERALL" = PASS ]
