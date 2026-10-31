# Gaffer — LANDING a delivered ticket (lib/land.sh). The ONE place a delivery branch
# lands on its repo's default branch and the ticket is marked done: the agent review
# pass calls it on a ship verdict (lib/review.sh), and the MERGE LANE (lib/merge-lane.sh)
# calls it for a ticket that reached ready_for_merge by any other route — a human's
# approve, the independent tester's PASS, a merge gate that was held and has since
# been earned. Before the lane existed those tickets waited for the dashboard's Merge
# button even in autonomous mode (a live run stalled with nine dependents starving
# behind a human-approved bootstrap). Extracted verbatim from review.sh's ship branch.
#   gaffer_land_delivery <num> <repo_dir> <branch> <default_branch> <ticket-show-json> [who]
#     → 0 merged + marked done; non-zero: held (conflict / dirty checkout / could not run
#       / the MERGE GATE: the combined code failed the gates on the target),
#       with the reason logged under the <who> prefix (AFK for the review pass, MERGE
#       for the lane). Relies on tick.sh runtime globals (log, wg, jget, GAFFER_DATA,
#       RUNNER_DIR, gaffer_auto_merge, gaffer_pr_merge, gaffer_refresh_cards, …).
# shellcheck shell=bash
# shellcheck disable=SC2154  # globals provided by tick.sh at call time
# ACCEPTANCE GATE — _gaffer_land_tester_binding <num> <repo> <branch>
# The landing decision lives in ONE place, lib/tester-binding.mjs, shared with
# bin/merge-ticket.mjs (the dashboard / `gaffer merge` path), and reads the dispatch DB —
# never ticket JSON an agent could shape. → 0 land (sets _TB_PIN: the exact commit to
# merge) · 1 hold. Fail CLOSED: node or the helper missing, an unreadable DB, an unknown
# ticket or an unresolvable branch head all HOLD. Sets _TB_KIND / _TB_REASON /
# _TB_TESTED / _TB_REVIEWED / _TB_HEAD for the caller's log line.
_gaffer_land_tester_binding() {
  local num="$1" repo="$2" branch="$3" out rc=0
  _TB_PIN=""; _TB_KIND=""; _TB_REASON=""; _TB_TESTED=""; _TB_REVIEWED=""; _TB_HEAD=""
  local helper="${RUNNER_DIR:-}/lib/tester-binding.mjs"
  if [ ! -f "$helper" ] || ! command -v node >/dev/null 2>&1; then
    _TB_KIND="unavailable"; _TB_REASON="the landing check (lib/tester-binding.mjs) cannot run"
    return 1
  fi
  out="$(node "$helper" landing --db "${DISPATCH_DB:-}" --ticket "$num" --repo "$repo" --branch "$branch" 2>/dev/null)" || rc=$?
  _TB_PIN="$(printf '%s' "$out" | jget 'd.pin || ""' 2>/dev/null || echo '')"
  _TB_KIND="$(printf '%s' "$out" | jget 'd.kind || ""' 2>/dev/null || echo '')"
  _TB_REASON="$(printf '%s' "$out" | jget 'd.reason || ""' 2>/dev/null || echo '')"
  _TB_TESTED="$(printf '%s' "$out" | jget 'd.tested || ""' 2>/dev/null || echo '')"
  _TB_REVIEWED="$(printf '%s' "$out" | jget 'd.reviewed || ""' 2>/dev/null || echo '')"
  _TB_HEAD="$(printf '%s' "$out" | jget 'd.head || ""' 2>/dev/null || echo '')"
  [ "$rc" -eq 0 ] && [ -n "$_TB_PIN" ] && return 0
  [ -n "$_TB_KIND" ] || { _TB_KIND="unreadable"; _TB_REASON="the landing check produced no decision (rc=$rc)"; }
  return 1
}

gaffer_land_delivery() {
  local RNUM="$1" RREPO="$2" RBRANCH="$3" RDEFAULT="$4" RSHOW="${5:-}" _WHO="${6:-AFK}"
  local _CR_BASE _RPR _MERGED_VIA _mrc _prc _mgrc
  [ -n "$RNUM" ] && [ -n "$RREPO" ] && [ -n "$RBRANCH" ] && [ -n "$RDEFAULT" ] || { log "$_WHO: land: missing ticket/repo/branch/default — refusing"; return 2; }
  # ACCEPTANCE GATE: never land code the tester did not run, and merge exactly the commit
  # the decision names (_TB_PIN) — see lib/tester-binding.mjs, shared with merge-ticket.mjs.
  if ! _gaffer_land_tester_binding "$RNUM" "$RREPO" "$RBRANCH"; then
    case "$_TB_KIND" in
      moved) log "$_WHO: #$RNUM HELD — $RBRANCH moved since the tester's PASS (tested ${_TB_TESTED:0:12}, head is now ${_TB_HEAD:0:12}); re-test the branch (move it back to in_review) or record a human verdict" ;;
      moved-since-review) log "$_WHO: #$RNUM HELD — $RBRANCH moved since the review approved it (reviewed ${_TB_REVIEWED:0:12}, head is now ${_TB_HEAD:0:12}${_TB_TESTED:+, tested ${_TB_TESTED:0:12}}); nobody reviewed the new commits — move it back to in_review for a re-review" ;;
      *)     log "$_WHO: #$RNUM HELD — landing check: ${_TB_KIND:-?}: ${_TB_REASON:-no decision}; nothing merged" ;;
    esac
    return 4
  fi
  case "$_TB_KIND" in
    waived) log "$_WHO: #$RNUM landing on a HUMAN tester waiver (pinned ${_TB_PIN:0:12})" ;;
    legacy-unbound) log "$_WHO: #$RNUM tester PASS predates commit binding — landing the current head ${_TB_PIN:0:12}" ;;
  esac
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
    # MERGE GATE, PR MODE: gate the merge of the pin onto the remote target as just
    # fetched (the local default when the fetch fails). GitHub merges the PR, so the
    # compare-and-land upstream is the repo's branch protection ("require branches to
    # be up to date" + required checks); gaffer's part is never to ask for a merge whose
    # combination failed the gates.
    local _pr_target="refs/heads/$RDEFAULT"
    git -C "$RREPO" fetch --quiet "${GAFFER_PR_REMOTE:-origin}" "$RDEFAULT" >/dev/null 2>&1 && _pr_target="FETCH_HEAD"
    _gaffer_merge_gate "$RNUM" "$RREPO" "$RBRANCH" "$RDEFAULT" "$_TB_PIN" "$RSHOW" "$_pr_target" "$_WHO"; _mgrc=$?
    case "$_mgrc" in
      0) ;;
      1) _mrc=1 ;;   # the combination conflicts: the resolver path below, no PR merge
      4) _gaffer_merge_gate_hold "$RNUM" "$RBRANCH" "$RDEFAULT" "$_WHO"; return 4 ;;
      *) log "$_WHO: #$RNUM HELD — the merge gate could not run (${_MG_REASON:-unknown}); nothing merged"; return 2 ;;
    esac
  fi
  if [ -n "$_RPR" ] && [ -z "$_mrc" ]; then
    gaffer_pr_merge "$RREPO" "$_RPR" "$RDEFAULT" "$_TB_PIN"; _prc=$?
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
  # LOCAL LANDING through the MERGE GATE: construct the merge of the pin onto the
  # CURRENT target in a scratch worktree, run the repo's DoD gates on THAT result, and land
  # exactly the gated merge commit only while the target still is the commit that was
  # gated (compare-and-land); a target that moved is re-gated. A red combination is held
  # for a human with the gate output as evidence; the target is never touched.
  if [ -z "$_mrc" ]; then
    local _mg_try=0 _mg_max="${GAFFER_MERGE_GATE_RETRIES:-2}" _lrc
    while :; do
      _gaffer_merge_gate "$RNUM" "$RREPO" "$RBRANCH" "$RDEFAULT" "$_TB_PIN" "$RSHOW" "refs/heads/$RDEFAULT" "$_WHO"; _mgrc=$?
      case "$_mgrc" in
        0) ;;
        1) _mrc=1; break ;;
        4) _gaffer_merge_gate_hold "$RNUM" "$RBRANCH" "$RDEFAULT" "$_WHO"; return 4 ;;
        *) log "$_WHO: #$RNUM HELD — the merge gate could not run (${_MG_REASON:-unknown}); nothing merged"; return 2 ;;
      esac
      _gaffer_land_gated "$RREPO" "$RDEFAULT" "$_MG_TARGET" "$_MG_MERGE" "$RBRANCH" "$_TB_PIN"; _lrc=$?
      case "$_lrc" in
        7)
          _mg_try=$((_mg_try + 1))
          if [ "$_mg_try" -gt "$_mg_max" ]; then
            log "$_WHO: #$RNUM HELD — $RDEFAULT kept moving while the merge was gated ($_mg_try attempts); nothing merged, tried again next run"
            return 4
          fi
          log "$_WHO: #$RNUM $RDEFAULT moved after the merge gate (gated ${_MG_TARGET:0:12}) — re-gating on the new target ($_mg_try/$_mg_max)"
          continue ;;
        *) _mrc="$_lrc"; break ;;
      esac
    done
  fi
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
        local _push_rc=0
        gaffer_auto_push "$RREPO" "$RDEFAULT" || _push_rc=$?
        case "$_push_rc" in
          0) log "$_WHO: pushed $RDEFAULT to origin" ;;
          # rc 2 = the repo has no origin (a greenfield repo the factory created, a local-only
          # checkout): there is nothing to push to, so this is not a failure — say so instead
          # of logging a rejected push on every merge of an autonomous run.
          2) log "$_WHO: $RDEFAULT merged locally — no origin remote, nothing to push" ;;
          *) log "$_WHO: push of $RDEFAULT failed (rejected/offline) — merged locally, left to push" ;;
        esac
      fi
      # The delivery branch is now fully merged: drop it so branches don't pile
      # up (mirrors merge-ticket.mjs). The reviewer is done, so tear its (detached)
      # worktree down first (idempotent; the exit trap re-runs it).
      # `-d` refuses an unmerged branch, so this can never lose work.
      declare -F _review_cleanup >/dev/null 2>&1 && _review_cleanup
      if [ "$_MERGED_VIA" = "pr-stale" ]; then
        log "$_WHO: merged branch $RBRANCH left in place (local $RDEFAULT is stale — delete after pulling)"
      elif git -C "$RREPO" branch -d "$RBRANCH" >/dev/null 2>&1 \
           || { git -C "$RREPO" merge-base --is-ancestor "$_TB_PIN" "$RDEFAULT" 2>/dev/null \
                && git -C "$RREPO" update-ref -d "refs/heads/$RBRANCH" "$_TB_PIN" >/dev/null 2>&1; }; then
        # (`branch -d` checks "merged into HEAD"; with the target not checked out the
        # gated landing moved only its ref — delete the branch only if it still points at
        # the landed pin, which is now in the target's history: nothing can be lost.)
        log "$_WHO: deleted merged branch $RBRANCH"
      else
        log "$_WHO: merged branch $RBRANCH left in place (not deletable right now)"
      fi
      ;;
    3) log "$_WHO: #$RNUM approved but merge REFUSED — '$RDEFAULT' is checked out with uncommitted changes or untracked files the merge would overwrite; left in ready_for_merge for a human (never merge over live edits)" ;;
    6) log "$_WHO: #$RNUM HELD — $RBRANCH moved between the landing check and the merge (approved ${_TB_PIN:0:12}); nothing merged"
       _mrc=4 ;;
    1)
      # CONFLICT: the branch forked before a sibling landed on the same files (two
      # tickets in flight touching one module). Under autonomy this used to be the end
      # of the run — the ticket held at ready_for_merge, every dependent starved behind
      # it, and the loop stopped on empty polls. Hand it to the conflict resolver
      # (bin/merge-ticket.mjs, the dashboard Merge button's path): it merges the default
      # branch INTO the delivery branch in a throwaway worktree, resolves preserving both
      # sides, and reopens the ticket for RE-REVIEW of the resolved diff — never a
      # silent landing. Once per ticket; a second conflict after a resolver pass waits
      # for a human.
      if _gaffer_land_conflict_resolve "$RNUM" "$RREPO" "$RBRANCH" "$RDEFAULT" "$_WHO"; then
        _mrc=5
      else
        log "$_WHO: #$RNUM approved but merge hit a CONFLICT — left on $RBRANCH for a human"
      fi ;;
    *) log "$_WHO: #$RNUM approved but merge could not run (rc=$_mrc) — left in ready_for_merge for a human" ;;
  esac
  return "${_mrc:-1}"
}

# ── MERGE GATE ────────────────────────────────────────────────────────────────────
# The branch passed its gates and the target passed its gates, but nothing had ever run
# the COMBINATION: a clean textual merge of a field rename (one side changed which field
# is read, the other removed it) landed, the ticket went done, and the same test failed on
# main. _gaffer_merge_gate builds the proposed merge of the PIN onto the CURRENT target in
# a scratch worktree (detached at the target head, nothing of the live checkout) and runs
# the repo's DoD gates on that merge result through bin/dod-regate.sh — the conflict
# resolution's re-gate: same gate runner, toggles, install step, sandbox and zero-gates
# rule as the delivery gate, and the same gates (test_command, lint_command and the
# typecheck command gaffer_dod_typecheck_cmd resolves, detected from the target head).
#   _gaffer_merge_gate <num> <repo> <branch> <default> <pin> <show-json> <target-ref> [who]
#     → 0 the merge passed (or DoD is OFF — GAFFER_DOD=0, logged) · 1 the merge CONFLICTS
#       · 4 the merge FAILS its gates · 2 the gate could not run (held, fail closed).
#     Sets _MG_TARGET (the gated target head), _MG_MERGE (the gated merge commit),
#     _MG_EVIDENCE (the gate's checklist) and _MG_REASON.
_gaffer_merge_gate() {
  local num="$1" repo="$2" branch="$3" def="$4" pin="$5" show="$6" target_ref="$7" who="${8:-MERGE}"
  _MG_TARGET=""; _MG_MERGE=""; _MG_EVIDENCE=""; _MG_REASON=""
  [ -n "$pin" ] || { _MG_REASON="no pinned commit to gate"; return 2; }
  _MG_TARGET="$(git -C "$repo" rev-parse --verify --quiet "$target_ref^{commit}" 2>/dev/null)" \
    || { _MG_TARGET=""; _MG_REASON="the target $target_ref cannot be resolved"; return 2; }
  local wt="${GAFFER_DATA:-${TMPDIR:-/tmp}}/worktrees/merge-gate-$num-$$" ids=() rc out label tcmd lcmd allow
  mkdir -p "$(dirname "$wt")" 2>/dev/null || true
  git -C "$repo" worktree remove --force "$wt" >/dev/null 2>&1 || true; rm -rf "$wt"
  if ! git -C "$repo" worktree add --quiet --detach --force "$wt" "$_MG_TARGET" >/dev/null 2>&1; then
    _MG_REASON="a scratch checkout of the target could not be created"; return 2
  fi
  # The merge needs an identity; the repo's own when it has one.
  git -C "$repo" config user.email >/dev/null 2>&1 || ids=(-c user.name=gaffer -c user.email=gaffer@localhost)
  if ! git -C "$wt" ${ids[@]+"${ids[@]}"} merge --quiet --no-edit -m "Merge branch '$branch'" "$pin" >/dev/null 2>&1; then
    git -C "$wt" merge --abort >/dev/null 2>&1 || true
    git -C "$repo" worktree remove --force "$wt" >/dev/null 2>&1 || true; rm -rf "$wt"; git -C "$repo" worktree prune >/dev/null 2>&1 || true
    _MG_REASON="the merge onto ${_MG_TARGET:0:12} conflicts"; return 1
  fi
  _MG_MERGE="$(git -C "$wt" rev-parse HEAD 2>/dev/null)"
  # The repo's gate commands, from the ticket (the same fields the delivery gate reads).
  label="$(basename "$repo")"
  tcmd="$(printf '%s' "$show" | GAFFER_MG_REPO="$repo" jget '(((d.repositories||[]).find(r => r.local_path === process.env.GAFFER_MG_REPO)) || {}).test_command || ""' 2>/dev/null || true)"
  lcmd="$(printf '%s' "$show" | GAFFER_MG_REPO="$repo" jget '(((d.repositories||[]).find(r => r.local_path === process.env.GAFFER_MG_REPO)) || {}).lint_command || ""' 2>/dev/null || true)"
  # GATE INTEGRITY: a human's allow_test_changes on the ticket (fails closed to 0); the
  # merge gate's integrity row (target head vs the merge) then reads PASS with a note.
  allow="$(printf '%s' "$show" | jget '(d.ticket && d.ticket.allow_test_changes === 1) ? 1 : 0' 2>/dev/null || echo 0)"
  [ "$allow" = "1" ] || allow=0
  log "$who: #$num MERGE GATE — gating the merge of ${pin:0:12} onto $def@${_MG_TARGET:0:12} (merge ${_MG_MERGE:0:12}) in a scratch worktree"
  # The gated target head is the base the typecheck script is detected from (as the
  # delivery gate reads its base branch first): the branch cannot drop that gate. It is
  # also the gate-integrity base: the gate scripts are read from it and the evidence
  # carries an integrity row (PASS/FLAG, never FAIL) for the merged tree.
  out="$(bash "${RUNNER_DIR:-.}/bin/dod-regate.sh" "$wt" "$label" "${tcmd:--}" "${lcmd:--}" "$_MG_TARGET" "$allow" 2>/dev/null)"; rc=$?
  git -C "$repo" worktree remove --force "$wt" >/dev/null 2>&1 || true; rm -rf "$wt"; git -C "$repo" worktree prune >/dev/null 2>&1 || true
  _MG_EVIDENCE="$out"
  case "$rc" in
    0) log "$who: #$num MERGE GATE PASS — the combined code passes the gates on $def@${_MG_TARGET:0:12}"; return 0 ;;
    3) log "$who: #$num MERGE GATE OFF (GAFFER_DOD=0) — the combination was NOT gated"; return 0 ;;
    *) _MG_REASON="the merge of ${pin:0:12} onto $def@${_MG_TARGET:0:12} fails the Definition-of-Done gates"; return 4 ;;
  esac
}

# The red merge gate's HOLD: the gate output becomes evidence on the ticket and the
# ticket leaves the merge lane for the human queue (ready_for_merge → blocked, reason
# merge_gate_red). The target was never touched.
_gaffer_merge_gate_hold() {
  local num="$1" branch="$2" def="$3" who="${4:-MERGE}"
  wg attach-evidence "$num" --type test_output \
    --summary "MERGE GATE FAILED: $_MG_REASON"$'\n\n'"${_MG_EVIDENCE:-DoD: FAIL}" >/dev/null 2>&1 || true
  if wg ticket hold "$num" --reason-code merge_gate_red --as system \
       --reason "The merge of $branch onto $def@${_MG_TARGET:0:12} fails its gates (each side passed alone); $def was not touched — see the merge-gate evidence. Rework the branch on the current $def, then re-approve." >/dev/null 2>&1; then
    log "$who: #$num HELD for a human — $_MG_REASON; $def untouched, gate output attached as evidence (blocked, merge_gate_red)"
  else
    log "$who: #$num HELD — $_MG_REASON; $def untouched (could not move it to the human queue: left in ready_for_merge)"
  fi
}

# COMPARE-AND-LAND: put exactly the gated merge commit on the target, and only while the
# target still IS the commit that was gated.
#   _gaffer_land_gated <repo> <default> <gated-target> <gated-merge> <branch> <pin>
#     → 0 landed · 3 refused (the target is checked out dirty, or in another worktree)
#       · 6 the branch moved off the pin · 7 the target moved since it was gated (re-gate)
_gaffer_land_gated() {
  local repo="$1" def="$2" target="$3" merge="$4" branch="$5" pin="$6" head_branch now wtl
  [ -n "$target" ] && [ -n "$merge" ] || return 2
  [ "$(git -C "$repo" rev-parse --verify --quiet "refs/heads/$branch^{commit}" 2>/dev/null)" = "$pin" ] || return 6
  head_branch="$(git -C "$repo" symbolic-ref --quiet --short HEAD 2>/dev/null || echo '')"
  if [ "$head_branch" = "$def" ]; then
    # The target is the live checkout: only over a clean tracked tree (never over edits),
    # and a fast-forward to the gated merge only (refuses whatever is not its ancestor).
    [ -z "$(git -C "$repo" status --porcelain --untracked-files=no 2>/dev/null)" ] || return 3
    [ "$(git -C "$repo" rev-parse HEAD 2>/dev/null)" = "$target" ] || return 7
    git -C "$repo" merge --quiet --ff-only "$merge" >/dev/null 2>&1 && return 0
    [ "$(git -C "$repo" rev-parse HEAD 2>/dev/null)" = "$target" ] || return 7
    return 3   # an untracked file in the way: a refusal, not a conflict
  fi
  # Checked out in ANOTHER worktree: moving the ref would desync that checkout — refuse.
  wtl="$(git -C "$repo" worktree list --porcelain 2>/dev/null)"
  if grep -qx "branch refs/heads/$def" <<<"$wtl"; then return 3; fi
  # Not checked out: an atomic compare-and-swap of the ref (old value = the gated target).
  git -C "$repo" update-ref -m "gaffer: land the gated merge of $branch" "refs/heads/$def" "$merge" "$target" >/dev/null 2>&1 && return 0
  now="$(git -C "$repo" rev-parse --verify --quiet "refs/heads/$def" 2>/dev/null)"
  [ "$now" = "$target" ] && return 3
  return 7
}

# _gaffer_land_conflict_resolve <num> <repo_dir> <branch> <default_branch> [who]
# The conflict failure-mode of a landing. Spawns the resolver through bin/merge-ticket.mjs
# (its own conflict-safe merge attempt, then the resolve-merge-conflict agent in a
# throwaway worktree of the branch, then `wg ticket reopen-for-review` → in_review).
#   → 0  the resolver ran and the ticket is back in review (or the helper landed it)
#   → 1  not attempted (lane off, DRY_RUN, second conflict for this ticket) or the
#        resolver did not resolve — the caller holds the ticket for a human.
# Bounded: GAFFER_MERGE_TIMEOUT_MS kills the resolver; $GAFFER_DATA/.merge-conflict-resolved
# remembers every ticket that had its one resolver pass (NOT reset per run — a ticket that
# conflicts again after a resolution is a human's, not a loop).
_gaffer_land_conflict_resolve() {
  local RNUM="$1" RREPO="$2" RBRANCH="$3" RDEFAULT="$4" _WHO="${5:-AFK}"
  case "$(printf '%s' "${GAFFER_CONFLICT_RESOLVER:-1}" | tr '[:upper:]' '[:lower:]')" in
    0|false|no|off) log "$_WHO: #$RNUM conflict — the resolver lane is off (GAFFER_CONFLICT_RESOLVER=0)"; return 1 ;;
  esac
  if [ "${DRY_RUN:-0}" = "1" ]; then log "DRY_RUN: $_WHO would spawn the conflict resolver for #$RNUM ($RBRANCH ← $RDEFAULT)"; return 1; fi
  local _marker="$GAFFER_DATA/.merge-conflict-resolved"
  touch "$_marker" 2>/dev/null || true
  if grep -qx "$RNUM" "$_marker" 2>/dev/null; then
    log "$_WHO: #$RNUM conflicted AGAIN after a resolver pass — not spawning a second resolver"
    return 1
  fi
  _gaffer_locked .skip.lock _gaffer_append_line "$_marker" "$RNUM"
  log "$_WHO: #$RNUM conflict — spawning the conflict resolver (bin/merge-ticket.mjs): merge $RDEFAULT into $RBRANCH on the branch, then reopen for re-review"
  local _out _rc _phase
  _out="$(env GAFFER_DATA="$GAFFER_DATA" DISPATCH_DB="$DISPATCH_DB" MEMORY_DB="$MEMORY_DB" \
      node "$RUNNER_DIR/bin/merge-ticket.mjs" --ticket "$RNUM" --timeout-ms "${GAFFER_MERGE_TIMEOUT_MS:-600000}" \
      2>>"$GAFFER_DATA/merge-digest.log")"; _rc=$?
  _phase="$(printf '%s' "$_out" | tail -n 1 | jget 'd.phase || ""' 2>/dev/null || echo '')"
  case "$_phase" in
    merged)
      log "$_WHO: #$RNUM landed by the merge helper after all (phase=merged)"; return 0 ;;
    conflict_resolved_pending_reapproval)
      # Success ONLY when the reopen really happened: an older helper reported this phase
      # with reapproval.ok=false, and the unreviewed resolution then landed next tick.
      if [ "$(printf '%s' "$_out" | tail -n 1 | jget 'd.reapproval && d.reapproval.ok === true ? "1" : ""' 2>/dev/null || echo '')" = "1" ]; then
        log "$_WHO: #$RNUM conflict resolved ON $RBRANCH by the resolver — reopened for re-review (→ in_review); the review pass re-reads the resolved diff and it lands after approval"
        return 0
      fi
      log "$_WHO: #$RNUM conflict resolved ON $RBRANCH but the ticket was NOT reopened for re-review — HELD for a human; do not merge the resolution unreviewed"
      return 1 ;;
    *)
      log "$_WHO: #$RNUM conflict resolver did not resolve (rc=$_rc, phase='${_phase:-?}') — left on $RBRANCH for a human: $(printf '%s' "$_out" | tail -n 1 | cut -c1-300)"
      return 1 ;;
  esac
}
