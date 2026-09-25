# Gaffer MACHINE-CHECKABLE acceptance criteria — the runner executes each AC's
# `check_command` in the delivery worktree and records the verdict.
# shellcheck shell=bash
#
# WHY. Acceptance criteria were prose: the agent wrote whatever evidence it liked via
# record_ac_evidence and the done gate only required a non-empty diff + a passing
# generic test command. An AC that carries a `check_command` is now verified by the
# RUNNER (never the agent): the command runs in the primary write worktree after the
# DoD gates, bounded by GAFFER_DOD_TIMEOUT, and the result is recorded through the
# trusted `wg ac check-result` path — exit 0 ⇒ the AC is `satisfied` with
# verified_by=runner:check (+ a test_output evidence row carrying the exit code and a
# bounded output tail); non-zero ⇒ `failed`, and the delivery is auto-rejected back to
# rework exactly like a failing DoD gate (the failing output becomes the next
# attempt's feedback). Dispatch's done gate refuses a checked AC that the runner has
# not passed, so an agent cannot talk its way past a check.
#
# CONTRACT (mirrors gaffer_run_dod_gates so the same summary/evidence/distill helpers
# read the results file):
#   gaffer_run_ac_checks <ticket-number> <ticket-json> <worktree> <results-file>
#     Appends one GATE row per checked AC:
#       GATE<TAB>ac-check<TAB><ac-label><TAB>PASS|FAIL<TAB>rc<TAB>note
#     and, for a FAIL, the framed output tail (---DOD-OUTPUT ac-check@<label>--- …).
#     Returns 0 when every check passed (or there were none), 1 when ANY failed.
#   gaffer_ac_check_count <ticket-json>   → number of ACs carrying a check_command
#
# Fail-soft on INFRASTRUCTURE (an unparseable ticket payload, missing python3): no
# checks run and the function returns 0 with a logged warning — the DoD gates and the
# human review still stand. Fail-CLOSED on the checks themselves: a check that cannot
# spawn is a FAIL (rc 127), never a skip.

# Emit `<ac-id>\t<check_command>\t<label>` per checked AC (TABs/newlines in the
# command collapsed to spaces so the row stays one line). Empty output ⇒ none.
_gaffer_ac_check_rows() {
  printf '%s' "$1" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(3)
acs = d.get("acceptanceCriteria") or d.get("acceptance_criteria") or []
n = 0
for i, ac in enumerate(acs, 1):
    cmd = (ac.get("check_command") or "").strip()
    if not cmd:
        continue
    n += 1
    cmd = cmd.replace("\t", " ").replace("\n", " ").replace("\r", " ")
    text = (ac.get("text") or "").replace("\t", " ").replace("\n", " ")[:60]
    print("%s\t%s\tAC%d: %s" % (ac.get("id", ""), cmd, i, text))
' 2>/dev/null
}

gaffer_ac_check_count() {
  local rows
  rows="$(_gaffer_ac_check_rows "$1")" || { echo 0; return 0; }
  [ -n "$rows" ] && printf '%s\n' "$rows" | grep -c . || echo 0
}

gaffer_run_ac_checks() {
  local num="$1" show="$2" wt="$3" results="$4"
  local rows
  if ! rows="$(_gaffer_ac_check_rows "$show")"; then
    log "AC-check: WARN — could not parse the ticket payload for #$num; no acceptance checks run"
    return 0
  fi
  [ -n "$rows" ] || return 0
  [ -d "$wt" ] || { log "AC-check: WARN — worktree '$wt' missing for #$num; no acceptance checks run"; return 0; }
  local tmpout any_fail=0 ac_id cmd label rc note t0 t1
  if ! tmpout="$(mktemp "${TMPDIR:-/tmp}/gaffer-accheck.XXXXXX")"; then
    printf 'GATE\tac-check\t-\tFAIL\t1\tcould not create a temp file for check output (mktemp failed)\n' >> "$results"
    return 1
  fi
  while IFS=$'\t' read -r ac_id cmd label; do
    [ -n "$ac_id" ] && [ -n "$cmd" ] || continue
    t0="$(date +%s)"
    gaffer_dod_run_one "$wt" "$tmpout" "$cmd"
    rc=$?
    t1="$(date +%s)"
    # RUNNER-OWNED record (system actor): status + evidence land server-side. A failed
    # record is logged loudly — the done gate will then hold the ticket (unverified),
    # which is the safe direction.
    if ! wg ac check-result "$ac_id" --ticket "$num" --exit "$rc" --command "$cmd" \
         --output-file "$tmpout" --duration "$((t1 - t0))" >/dev/null 2>&1; then
      log "AC-check: WARNING — could not record the check result for $label on #$num (rc=$rc); the done gate will hold this AC as unverified"
    fi
    if [ "$rc" -eq 0 ]; then
      printf 'GATE\tac-check\t%s\tPASS\t0\t%s\n' "$label" "$cmd" >> "$results"
    else
      any_fail=1
      case "$rc" in
        124) note="timed out after ${GAFFER_DOD_TIMEOUT}s: $cmd" ;;
        127) note="command could not be run (spawn/exit 127): $cmd" ;;
        *)   note="exited $rc: $cmd" ;;
      esac
      printf 'GATE\tac-check\t%s\tFAIL\t%s\t%s\n' "$label" "$rc" "$note" >> "$results"
      printf -- '---DOD-OUTPUT ac-check@%s---\n' "$label" >> "$results"
      gaffer_dod_distill_output "$tmpout" "$GAFFER_DOD_OUTPUT_TAIL" >> "$results" 2>/dev/null \
        || tail -n "$GAFFER_DOD_OUTPUT_TAIL" "$tmpout" 2>/dev/null >> "$results" || true
      printf -- '\n---END-DOD-OUTPUT---\n' >> "$results"
    fi
  done <<< "$rows"
  rm -f "$tmpout"
  [ "$any_fail" -eq 0 ]
}
