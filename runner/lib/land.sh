# Gaffer — LANDING a delivered ticket (lib/land.sh). The ONE place a delivery branch
# lands on its repo's default branch and the ticket is marked done: the agent review
# pass calls it on a ship verdict (lib/review.sh), and the MERGE LANE (lib/merge-lane.sh)
# calls it for a ticket that reached ready_for_merge by any other route — a human's
# approve, the independent tester's PASS, a merge gate that was held and has since
# been earned. Before the lane existed those tickets waited for the dashboard's Merge
# button even in autonomous mode (a live run stalled with nine dependents starving
# behind a human-approved bootstrap). Extracted verbatim from review.sh's ship branch.
#   gaffer_land_delivery <num> <repo_dir> <branch> <default_branch> <ticket-show-json> [who]
#     → 0 merged + marked done; non-zero: held (conflict / dirty checkout / could not run),
#       with the reason logged under the <who> prefix (AFK for the review pass, MERGE
#       for the lane). Relies on tick.sh runtime globals (log, wg, jget, GAFFER_DATA,
#       RUNNER_DIR, gaffer_auto_merge, gaffer_pr_merge, gaffer_refresh_cards, …).
# shellcheck shell=bash
# shellcheck disable=SC2154  # globals provided by tick.sh at call time
gaffer_land_delivery() {
  local RNUM="$1" RREPO="$2" RBRANCH="$3" RDEFAULT="$4" RSHOW="${5:-}" _WHO="${6:-AFK}"
  local _CR_BASE _RPR _MERGED_VIA _mrc _prc
  [ -n "$RNUM" ] && [ -n "$RREPO" ] && [ -n "$RBRANCH" ] && [ -n "$RDEFAULT" ] || { log "$_WHO: land: missing ticket/repo/branch/default — refusing"; return 2; }
  # Merge gate ALSO earned → safe-merge the delivery branch into the default.
  # Capture the branch fork point BEFORE merging — afterwards RBRANCH is an
  # ancestor of RDEFAULT, so merge-base would collapse to RBRANCH (empty diff).
  _CR_BASE="$(git -C "$RREPO" merge-base "$RBRANCH" "$RDEFAULT" 2>/dev/null || true)"
  # PR MODE: when the delivery opened a PR (GAFFER_CREATE_PR → pr_url on the
  # ticket), land it THROUGH the PR (gaffer_pr_merge: `gh pr merge` + a local
  # fast-forward) — a local merge left the PR open and the branch unpushed. gh
  # failing/absent falls back to the local merge with the reason logged.
  _RPR="$(echo "$RSHOW" | jget 'd.ticket.pr_url || ""' 2>/dev/null)"
  _MERGED_VIA="local"; _mrc=""
  if [ -n "$_RPR" ]; then
    gaffer_pr_merge "$RREPO" "$_RPR" "$RDEFAULT"; _prc=$?
    case "$_prc" in
      0) _mrc=0; _MERGED_VIA=pr
         log "$_WHO: #$RNUM merged THROUGH its PR $_RPR (gh pr merge --${GAFFER_PR_MERGE_METHOD:-merge} --delete-branch); local $RDEFAULT fast-forwarded" ;;
      3|4) _mrc=0; _MERGED_VIA=pr-stale
         log "$_WHO: #$RNUM merged THROUGH its PR $_RPR but the local $RDEFAULT was NOT fast-forwarded (rc=$_prc: checked out dirty, or the fetch failed) — pull it by hand" ;;
      *)
        # PR MODE means "done = the PR merged upstream". A failed PR merge (gh absent,
        # auth failed, PR not mergeable / checks red / review required) must NOT be
        # redefined as success by landing the branch locally — that marks the ticket
        # done while the PR sits open and the remote default branch never gets the
        # change. HOLD at ready_for_merge for a human. GAFFER_PR_LOCAL_FALLBACK=1 is
        # the explicit operator choice to keep the old local fallback.
        if _gaffer_flag_on "${GAFFER_PR_LOCAL_FALLBACK:-0}"; then
          log "$_WHO: #$RNUM has PR $_RPR but the PR merge did not run (rc=$_prc: '${GAFFER_GH_BIN:-gh}' failed or unavailable) — GAFFER_PR_LOCAL_FALLBACK=1: falling back to a LOCAL merge; the PR stays open, close it by hand"
        else
          log "$_WHO: #$RNUM has PR $_RPR but the PR merge FAILED (rc=$_prc: '${GAFFER_GH_BIN:-gh}' failed, unauthenticated or the PR is not mergeable) — HELD in ready_for_merge for a human; merge the PR by hand (or set GAFFER_PR_LOCAL_FALLBACK=1 to land locally instead)"
          return 4
        fi ;;
    esac
  fi
  if [ -z "$_mrc" ]; then gaffer_auto_merge "$RREPO" "$RBRANCH" "$RDEFAULT"; _mrc=$?; fi
  case "$_mrc" in
    0)
      wg ticket mark-merged "$RNUM" --as system >/dev/null 2>&1 \
        && log "$_WHO: #$RNUM merged ($RBRANCH → $RDEFAULT, via $_MERGED_VIA) and marked done" \
        || log "$_WHO: #$RNUM merged but mark-merged failed — verify state"
      # MEMORY FRESHNESS: write-through the delivered change into the file cards
      # (refresh changed, add new, drop deleted, advance the watermark) so priming
      # stays current instead of decaying. Fail-soft — never blocks the merge.
      # (Skipped when the local default branch is stale after a PR merge — the
      # range would be wrong; the next merge re-cards it.)
      [ "$_MERGED_VIA" = "pr-stale" ] || \
      gaffer_refresh_cards "$RREPO" "$(basename "$RREPO")" "$_CR_BASE" "$RBRANCH" \
        "$(git -C "$RREPO" rev-parse "$RDEFAULT" 2>/dev/null || true)" || true
      # POST-MERGE MEMORY WORK — the SAME step the dashboard merge (merge-ticket.mjs)
      # runs: apply the digest delta the delivery agent prepared (or stamp
      # freshness) and advance the linked feature → shipped. Without this the
      # unattended AFK merge left the Repo Digest stale and the feature at
      # `building` in every autonomous mode. Best-effort, never blocks the merge.
      if [ "${GAFFER_DIGEST_DISABLE:-0}" != "1" ]; then
        if node "$RUNNER_DIR/bin/merge-ticket.mjs" --ticket "$RNUM" --apply-digest-only \
             >>"$GAFFER_DATA/merge-digest.log" 2>&1; then
          log "$_WHO: #$RNUM digest/feature applied post-merge (see merge-digest.log)"
        else
          log "$_WHO: #$RNUM digest/feature apply did not run (rc=$?) — memory not updated for this merge; see merge-digest.log"
        fi
      fi
      # A PR merge already landed upstream: nothing to push (and never push a
      # stale local default over it).
      if [ "$_MERGED_VIA" = "local" ] && _gaffer_flag_on "${GAFFER_AUTO_PUSH:-0}"; then
        gaffer_auto_push "$RREPO" "$RDEFAULT" \
          && log "$_WHO: pushed $RDEFAULT to origin" \
          || log "$_WHO: push of $RDEFAULT failed (rejected/offline) — merged locally, left to push"
      fi
      # The delivery branch is now fully merged: drop it so branches don't pile
      # up (mirrors merge-ticket.mjs). The review worktree still has it checked
      # out (git refuses to delete a checked-out branch), and the reviewer is done,
      # so tear the worktree down first (idempotent; the exit trap re-runs it).
      # `-d` refuses an unmerged branch, so this can never lose work.
      declare -F _review_cleanup >/dev/null 2>&1 && _review_cleanup
      if [ "$_MERGED_VIA" = "pr-stale" ]; then
        log "$_WHO: merged branch $RBRANCH left in place (local $RDEFAULT is stale — delete after pulling)"
      elif git -C "$RREPO" branch -d "$RBRANCH" >/dev/null 2>&1; then
        log "$_WHO: deleted merged branch $RBRANCH"
      else
        log "$_WHO: merged branch $RBRANCH left in place (not deletable right now)"
      fi
      ;;
    3) log "$_WHO: #$RNUM approved but merge REFUSED — '$RDEFAULT' is checked out with uncommitted changes; left in ready_for_merge for a human (never merge over live edits)" ;;
    1) log "$_WHO: #$RNUM approved but merge hit a CONFLICT — left on $RBRANCH for a human" ;;
    *) log "$_WHO: #$RNUM approved but merge could not run (rc=$_mrc) — left in ready_for_merge for a human" ;;
  esac
  return "${_mrc:-1}"
}
