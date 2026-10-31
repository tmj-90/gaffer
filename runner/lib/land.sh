# Gaffer — LANDING a delivered ticket (lib/land.sh). The ONE place a delivery branch
# lands on its repo's default branch and the ticket is marked done: the agent review
# pass calls it on a ship verdict (lib/review.sh), and the MERGE LANE (lib/merge-lane.sh)
# calls it for a ticket that reached ready_for_merge by any other route — a human's
# approve, the independent tester's PASS, a merge gate that was held and has since
# been earned. Before the lane existed those tickets waited for the dashboard's Merge
# button even in autonomous mode (a live run stalled with nine dependents starving
# behind a human-approved bootstrap). Extracted verbatim from review.sh's ship branch.
#   gaffer_land_delivery <num> <repo_dir> <branch> <default_branch> <ticket-show-json> [who]
#     <repo_dir>/<branch>/<default_branch> name the PRIMARY repo; a multi-repo ticket lands
#     every write repo's approved commit (the show JSON's `landing.repos`), primary first.
#     → 0 merged in EVERY repo + marked done; non-zero: held (conflict / dirty checkout /
#       could not run / a partial landing — the landed repos are recorded, the rest retry),
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
  local num="$1" repo="$2" branch="$3" repo_id="${4:-}" secondary="${5:-0}" out rc=0
  _TB_PIN=""; _TB_KIND=""; _TB_REASON=""; _TB_TESTED=""; _TB_REVIEWED=""; _TB_HEAD=""
  local helper="${RUNNER_DIR:-}/lib/tester-binding.mjs"
  if [ ! -f "$helper" ] || ! command -v node >/dev/null 2>&1; then
    _TB_KIND="unavailable"; _TB_REASON="the landing check (lib/tester-binding.mjs) cannot run"
    return 1
  fi
  local -a _xargs=()
  [ -n "$repo_id" ] && _xargs+=( --repo-id "$repo_id" )
  [ "$secondary" = "1" ] && _xargs+=( --secondary )
  out="$(node "$helper" landing --db "${DISPATCH_DB:-}" --ticket "$num" --repo "$repo" --branch "$branch" ${_xargs[@]+"${_xargs[@]}"} 2>/dev/null)" || rc=$?
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

# PER-REPOSITORY LANDING (external review #3). A ticket with write access to several
# repositories is approved as one change and lands as one merge PER repo. The plan is the
# ticket's approved revisions (`landing.repos` on `wg ticket show`: one review pin per
# write repo, with its checkout, default branch and delivery branch), primary repo first.
# A legacy approval with no per-repo pins lands the one repo the caller named, as before.
#   _gaffer_land_plan <ticket-show-json> <primary-repo-dir> <primary-branch> <primary-default>
#     → TAB rows: repo_id  name  local_path  branch  default_branch  landed(0|1)  secondary(0|1)
_gaffer_land_plan() {
  local show="$1" prepo="$2" pbranch="$3" pdef="$4" rows
  rows="$(printf '%s' "$show" | P="$prepo" jget '((d.landing && d.landing.repos) || []).filter(r => r.localPath).sort((a, b) => (b.localPath === process.env.P) - (a.localPath === process.env.P)).map(r => [r.repoId, r.repo, r.localPath, r.branch || "-", r.defaultBranch || "main", r.landed ? 1 : 0, r.localPath === process.env.P ? 0 : 1].join("\t")).join("\n")' 2>/dev/null || true)"
  # Use the plan only when every row is well formed (7 fields, an on-disk checkout);
  # anything else lands the named primary repo exactly as before.
  if [ -n "$rows" ] && printf '%s\n' "$rows" | awk -F'\t' 'NF != 7 { bad = 1 } END { exit bad }' \
     && printf '%s\n' "$rows" | { _ok=0; while IFS=$'\t' read -r _ _ _p _; do [ -d "$_p" ] || _ok=1; done; exit "$_ok"; }; then
    printf '%s\n' "$rows"; return 0
  fi
  # Empty fields are the sentinel `-`: TAB is IFS whitespace, so `read` would collapse them.
  printf -- '-\t%s\t%s\t%s\t%s\t0\t0\n' "$(basename "$prepo")" "$prepo" "$pbranch" "$pdef"
}

# Record one repo's landing in dispatch (system evidence; idempotent). A failure is
# logged, never fatal: the done gate re-verifies a local landing from git.
_gaffer_land_record() {
  local num="$1" repo_id="$2" sha="$3" via="$4" who="$5"
  [ -n "$repo_id" ] && [ -n "$sha" ] || return 0
  if wg ticket record-landing "$num" --repo "$repo_id" --commit "$sha" --via "$via" --as system >/dev/null 2>&1; then
    log "$who: #$num recorded the landing of ${sha:0:12} in repo $repo_id"
  else
    log "$who: #$num could not record the landing of ${sha:0:12} in repo $repo_id (the done gate re-checks git)"
  fi
}

gaffer_land_delivery() {
  local RNUM="$1" RREPO="$2" RBRANCH="$3" RDEFAULT="$4" RSHOW="${5:-}" _WHO="${6:-AFK}"
  [ -n "$RNUM" ] && [ -n "$RREPO" ] && [ -n "$RBRANCH" ] && [ -n "$RDEFAULT" ] || { log "$_WHO: land: missing ticket/repo/branch/default — refusing"; return 2; }
  local _plan _rid _rname _rpath _rbr _rdef _rlanded _rsec _rc=0 _n=0 _done=0 _pending="" _landed_names="" _fresh=""
  # The plan reads the approval's per-repo pins, so read the ticket NOW: a show captured
  # before the approve (the review pass) carries no pins and would land only one repo.
  _fresh="$(wg ticket show "$RNUM" 2>/dev/null || true)"
  [ -n "$_fresh" ] && RSHOW="$_fresh"
  _plan="$(_gaffer_land_plan "$RSHOW" "$RREPO" "$RBRANCH" "$RDEFAULT")"
  _n="$(printf '%s\n' "$_plan" | grep -c .)"
  [ "$_n" -gt 1 ] && log "$_WHO: #$RNUM lands in $_n repositories (one merge per approved revision)"
  local -a _LANDED_REPOS=() _LANDED_BRANCHES=() _LANDED_VIA=()
  while IFS=$'\t' read -r _rid _rname _rpath _rbr _rdef _rlanded _rsec; do
    [ -n "$_rpath" ] || continue
    [ "$_rid" = "-" ] && _rid=""
    { [ -n "$_rbr" ] && [ "$_rbr" != "-" ]; } || _rbr="$RBRANCH"
    if [ "$_rlanded" = "1" ]; then
      log "$_WHO: #$RNUM ${_rname}: its approved commit already landed — not merged again"
      _done=$((_done + 1)); _landed_names="${_landed_names:+$_landed_names, }$_rname"
      _LANDED_REPOS+=("$_rpath"); _LANDED_BRANCHES+=("$_rbr"); _LANDED_VIA+=("earlier")
      continue
    fi
    _gaffer_land_one "$RNUM" "$_rpath" "$_rbr" "$_rdef" "$RSHOW" "$_WHO" "$_rid" "$_rsec"; _rc=$?
    if [ "$_rc" -ne 0 ]; then
      _pending="${_pending:+$_pending, }$_rname"
      break
    fi
    _done=$((_done + 1)); _landed_names="${_landed_names:+$_landed_names, }$_rname"
    _LANDED_REPOS+=("$_rpath"); _LANDED_BRANCHES+=("$_rbr"); _LANDED_VIA+=("$_MERGED_VIA")
  done <<EOF
$_plan
EOF
  if [ "$_rc" -eq 0 ] && [ "$_done" -eq 0 ]; then
    log "$_WHO: #$RNUM has no repository to land (empty landing plan) — nothing merged, not marked done"
    return 2
  fi
  if [ "$_rc" -ne 0 ]; then
    # A partial landing is a HELD state: the ticket stays ready_for_merge (the human queue
    # shows it as "Partly merged"), the landed repos are recorded, and the next run lands
    # the rest without re-merging what already landed.
    [ "$_done" -gt 0 ] && log "$_WHO: #$RNUM PARTLY MERGED — landed in ${_landed_names}; ${_pending} did not land (rc=$_rc) — held in ready_for_merge; a retry lands the rest"
    return "$_rc"
  fi
  # Every approved revision landed → done (the server re-checks every repo).
  if wg ticket mark-merged "$RNUM" --as system >/dev/null 2>&1; then
    if [ "$_done" -eq 1 ]; then
      log "$_WHO: #$RNUM merged (${_LANDED_BRANCHES[0]} → $RDEFAULT, via ${_LANDED_VIA[0]}) and marked done"
    else
      log "$_WHO: #$RNUM merged in $_done repositories (${_landed_names}) and marked done"
    fi
  else
    log "$_WHO: #$RNUM merged but mark-merged failed — verify state (wg ticket landing $RNUM)"
  fi
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
  # The delivery branches are now fully merged: drop them so branches don't pile up
  # (mirrors merge-ticket.mjs) — only now, once EVERY repo landed, so a partial landing
  # keeps every branch for its retry. The reviewer is done, so tear its (detached)
  # worktree down first (idempotent; the exit trap re-runs it). `-d` refuses an
  # unmerged branch, so this can never lose work.
  declare -F _review_cleanup >/dev/null 2>&1 && _review_cleanup
  local _i=0
  while [ "$_i" -lt "${#_LANDED_REPOS[@]}" ]; do
    if [ "${_LANDED_VIA[$_i]}" = "pr-stale" ]; then
      log "$_WHO: merged branch ${_LANDED_BRANCHES[$_i]} left in place in ${_LANDED_REPOS[$_i]} (local default is stale — delete after pulling)"
    elif git -C "${_LANDED_REPOS[$_i]}" branch -d "${_LANDED_BRANCHES[$_i]}" >/dev/null 2>&1; then
      log "$_WHO: deleted merged branch ${_LANDED_BRANCHES[$_i]} in ${_LANDED_REPOS[$_i]}"
    else
      log "$_WHO: merged branch ${_LANDED_BRANCHES[$_i]} left in place in ${_LANDED_REPOS[$_i]} (not deletable right now)"
    fi
    _i=$((_i + 1))
  done
  return 0
}

# Land ONE repository of a ticket: the landing check, the PR or local merge of the pinned
# commit, the landing record, the card refresh and the push. Sets _MERGED_VIA.
#   _gaffer_land_one <num> <repo_dir> <branch> <default> <show-json> <who> [repo_id] [secondary]
#     → 0 landed · 3 dirty checkout · 4 held · 5 conflict resolved, back in review · other: not landed
_gaffer_land_one() {
  local RNUM="$1" RREPO="$2" RBRANCH="$3" RDEFAULT="$4" RSHOW="${5:-}" _WHO="${6:-AFK}" _RID="${7:-}" _RSEC="${8:-0}"
  local _CR_BASE _RPR _mrc _prc
  _MERGED_VIA="local"
  # ACCEPTANCE GATE: never land code the tester did not run, and merge exactly the commit
  # the decision names (_TB_PIN) — see lib/tester-binding.mjs, shared with merge-ticket.mjs.
  if ! _gaffer_land_tester_binding "$RNUM" "$RREPO" "$RBRANCH" "$_RID" "$_RSEC"; then
    case "$_TB_KIND" in
      moved) log "$_WHO: #$RNUM HELD — $RBRANCH moved since the tester's PASS (tested ${_TB_TESTED:0:12}, head is now ${_TB_HEAD:0:12}); re-test the branch (move it back to in_review) or record a human verdict" ;;
      moved-since-review) log "$_WHO: #$RNUM HELD — $RBRANCH moved since the review approved it (reviewed ${_TB_REVIEWED:0:12}, head is now ${_TB_HEAD:0:12}${_TB_TESTED:+, tested ${_TB_TESTED:0:12}}); nobody reviewed the new commits — move it back to in_review for a re-review" ;;
      *)     log "$_WHO: #$RNUM HELD — landing check: ${_TB_KIND:-?}: ${_TB_REASON:-no decision}; nothing merged" ;;
    esac
    return 4
  fi
  case "$_TB_KIND" in
    already-landed) log "$_WHO: #$RNUM $(basename "$RREPO"): approved commit ${_TB_PIN:0:12} already landed — not merged again"; _MERGED_VIA="earlier"; return 0 ;;
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
  # failing/absent falls back to the local merge with the reason logged. The ticket's
  # pr_url belongs to its PRIMARY repo; a secondary repo lands locally.
  _RPR=""
  [ "$_RSEC" = "1" ] || _RPR="$(echo "$RSHOW" | jget 'd.ticket.pr_url || ""' 2>/dev/null)"
  _mrc=""
  if [ -n "$_RPR" ]; then
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
  if [ -z "$_mrc" ]; then gaffer_auto_merge "$RREPO" "$RBRANCH" "$RDEFAULT" "$_TB_PIN"; _mrc=$?; fi
  case "$_mrc" in
    0)
      log "$_WHO: #$RNUM merged $RBRANCH → $RDEFAULT in $RREPO (via $_MERGED_VIA)"
      _gaffer_land_record "$RNUM" "$_RID" "$_TB_PIN" "$_MERGED_VIA" "$_WHO"
      # MEMORY FRESHNESS: write-through the delivered change into the file cards
      # (refresh changed, add new, drop deleted, advance the watermark) so priming
      # stays current instead of decaying. Fail-soft — never blocks the merge.
      # (Skipped when the local default branch is stale after a PR merge — the
      # range would be wrong; the next merge re-cards it.)
      [ "$_MERGED_VIA" = "pr-stale" ] || \
      gaffer_refresh_cards "$RREPO" "$(basename "$RREPO")" "$_CR_BASE" "$RBRANCH" \
        "$(git -C "$RREPO" rev-parse "$RDEFAULT" 2>/dev/null || true)" || true
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
