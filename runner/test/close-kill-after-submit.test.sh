#!/usr/bin/env bash
# =====================================================================
# A TICK KILLED RIGHT AFTER THE SUBMIT LEAVES AN APPROVABLE DELIVERY (audit finding 6).
# ---------------------------------------------------------------------
# lib/tick-close.sh wrote the per-repo delivery rows, the diff_summary and branch_name
# only after the submit, the memory feedback, the intent distillation and the eval judge.
# A kill in that window left the ticket in_review with nothing recorded, and the done
# gate refuses approval in every policy pack without a recorded branch
# (PR_OR_DIFF_REQUIRED; factory_strict and regulated also BRANCH_REQUIRED): the only
# exit was a reject and a full re-delivery.
#
# For each pack, the REAL gaffer_tick_close_delivery runs against a real dispatch DB and
# a real worktree; its submit is the real `wg submit` followed by a kill (exit 143), so
# nothing after the submit runs. Then a person approves the delivered commit.
#   K1  solo_loose      K2  team_light      K3  factory_strict      K4  regulated
#   each: the ticket is in_review, the delivery row and branch_name are recorded, and
#   the approval passes (ready_for_merge)
#
# Run: bash test/close-kill-after-submit.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
CLI="$ROOT/packages/dispatch/dist/cli/index.js"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
[ -f "$CLI" ] || { echo "SKIP: build the workspace first (no $CLI)"; exit 0; }
WORK="$(gaffer_test_tmpdir close-kill-after-submit)" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
export DISPATCH_AUDIT_OFF=1 GIT_CONFIG_NOSYSTEM=1 LC_ALL=C
jf() { node "$RUNNER_DIR/lib/json-tool.mjs" expr "$1"; }

n=0
for pack in solo_loose team_light factory_strict regulated; do
  n=$((n + 1))
  echo "== K$n: $pack, killed right after the submit =="
  D="$WORK/$pack"; mkdir -p "$D/home" "$D/data" "$D/repo" "$D/wts"
  export HOME="$D/home" GAFFER_DATA="$D/data" DISPATCH_DB="$D/data/dispatch.sqlite"
  wgd() { node "$CLI" --db "$DISPATCH_DB" "$@"; }
  g() { git -C "$D/repo" "$@"; }
  wgd init >/dev/null
  g init -q -b main; g config user.name F; g config user.email f@example.invalid
  echo base > "$D/repo/base.txt"; g add base.txt; g commit -qm baseline
  wgd repo add -n repoA --path "$D/repo" --branch main --test true >/dev/null
  RID="$(wgd repo list 2>/dev/null | jf '(Array.isArray(d) ? d : (d.repos || [])).find(r => r.name === "repoA").id')"
  wgd ticket create -t "Change" --description d --policy "$pack" --risk low >/dev/null
  AC="$(wgd ac add 1 -t AC --verify test | jf 'd.ac_id')"
  wgd ticket set-reviewer 1 --reviewer op >/dev/null 2>&1
  wgd ticket repo-access set 1 repoA --access write --relation confirmed >/dev/null
  # regulated: a person grants the ready-approval before the ticket may go ready.
  [ "$pack" = regulated ] && wgd ticket approve-ready 1 >/dev/null 2>&1
  wgd ticket ready 1 >/dev/null
  AGENT="$(wgd agent register -n fx --max-risk high | jf 'd.agent.id')"
  TOKEN="$(wgd claim-ticket 1 --agent "$AGENT" --ttl 900 | jf 'd.claimToken')"
  WT="$D/wts/ticket-1"
  g worktree add -q -b gaffer/ticket-1-change "$WT" main
  echo change > "$WT/d.txt"; git -C "$WT" add d.txt; git -C "$WT" -c user.name=F -c user.email=f@example.invalid commit -qm change
  PIN="$(git -C "$WT" rev-parse HEAD)"
  wgd evidence 1 --token "$TOKEN" --type test_output --summary s --ac "$AC" >/dev/null
  # The close path, as the tick runs it, up to a kill right after the submit.
  ( NUM=1 CLAIM_TOKEN="$TOKEN" WORK_BRANCH=gaffer/ticket-1-change PRIMARY_REPO="$WT" DEFAULT_BRANCH=main
    WT_ROWS="$RID"$'\t'"repoA"$'\t'"$D/repo"$'\t'"main"$'\t'"$WT"
    _RESUMING=0 _DELIV_ATTEMPT=1 ROUTE_ATTEMPT_RAW=0
    wg() { node "$CLI" --db "$DISPATCH_DB" "$@"; }
    jget() { jf "$1"; }
    log() { printf '%s\n' "$*" >> "$D/tick.log"; }
    result() { echo "TICK_RESULT=$1" >> "$D/tick.log"; }
    gaffer_manifest_finish() { :; }
    gaffer_nocommit_clear() { :; }
    gaffer_recall_feedback() { :; }
    gaffer_distill_ticket_intent() { :; }
    gaffer_release_delivery() { echo "release $*" >> "$D/tick.log"; }
    gaffer_skip_ticket() { :; }
    gaffer_cleanup_worktrees() { :; }
    gaffer_submit_delivery() {
      wg submit "$NUM" --token "$CLAIM_TOKEN" --reason "$1" >/dev/null 2>&1 || return 1
      exit 143   # the kill: nothing after the submit runs
    }
    # shellcheck source=../lib/tick-close.sh
    source "$RUNNER_DIR/lib/tick-close.sh"
    gaffer_tick_close_delivery ) >/dev/null 2>&1
  rc=$?
  ST="$(wgd ticket show 1 | jf 'd.ticket.status')"
  [ "$rc" = 143 ] && [ "$ST" = in_review ] && ok "K$n the tick died right after the submit; the ticket is in_review" \
    || fail "K$n fixture: rc=$rc status=$ST $(tail -3 "$D/tick.log" 2>/dev/null)"
  BR="$(wgd ticket show 1 | jf 'd.ticket.branch_name || ""')"
  ROWS="$(wgd ticket repo-delivery list 1 2>/dev/null | jf '(Array.isArray(d) ? d : (d.deliveries || [])).map(r => r.branch_name).join(",")' 2>/dev/null)"
  [ "$BR" = gaffer/ticket-1-change ] && ok "K$n branch_name is recorded" || fail "K$n branch_name '$BR'"
  case "$ROWS" in *gaffer/ticket-1-change*) ok "K$n the per-repo delivery row is recorded" ;; *) fail "K$n delivery rows '$ROWS'" ;; esac
  OUT="$(wgd review approve 1 --reviewer op --commit "repoA=$PIN" 2>&1)"
  ST="$(wgd ticket show 1 | jf 'd.ticket.status')"
  [ "$ST" = ready_for_merge ] && ok "K$n a person can approve it ($pack done gate passes)" \
    || fail "K$n approval refused ($ST): $(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-240)"
done

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "close-kill-after-submit: ALL $PASS checks passed"; exit 0
else echo "close-kill-after-submit: ${#FAILURES[@]} FAILED (of $((PASS + ${#FAILURES[@]})))"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1; fi
