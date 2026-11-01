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
#     every write repo's approved commit (the show JSON's `landing.repos`), primary first,
#     and EVERY repo's landing goes through the MERGE GATE on that repo's current target.
#     → 0 merged in EVERY repo + marked done; non-zero: held (conflict / dirty checkout /
#       could not run / the MERGE GATE: the combined code failed the gates on the target /
#       a partial landing — the landed repos are recorded, the rest retry),
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
# EVERY WRITE REPO (external review #7): the plan also lists a write repo the approval did
# not pin (`pinned: false` — it has no approved commit), so the landing HOLDS on it instead
# of merging the others and calling the ticket done; and a write repo with no checkout
# here (or one that is unreadable) is never dropped from it: the landing holds on that too.
#   _gaffer_land_plan <ticket-show-json> <primary-repo-dir> <primary-branch> <primary-default>
#     → TAB rows: repo_id  name  local_path  branch  default_branch  landed(0|1)  secondary(0|1)  pinned(0|1)
_gaffer_land_plan() {
  local show="$1" prepo="$2" pbranch="$3" pdef="$4" rows
  rows="$(printf '%s' "$show" | P="$prepo" jget '((d.landing && d.landing.repos) || []).sort((a, b) => (b.localPath === process.env.P) - (a.localPath === process.env.P)).map(r => [r.repoId, r.repo, r.localPath || "-", r.branch || "-", r.defaultBranch || "main", r.landed ? 1 : 0, r.localPath === process.env.P ? 0 : 1, r.pinned === false ? 0 : 1].join("\t")).join("\n")' 2>/dev/null || true)"
  # Use the plan only when every row is well formed (8 fields); anything else lands the
  # named primary repo exactly as before. (A row without a readable checkout stays in the
  # plan: its landing holds, so the ticket is never done without it.)
  if [ -n "$rows" ] && printf '%s\n' "$rows" | awk -F'\t' 'NF != 8 { bad = 1 } END { exit bad }'; then
    printf '%s\n' "$rows"; return 0
  fi
  # Empty fields are the sentinel `-`: TAB is IFS whitespace, so `read` would collapse them.
  printf -- '-\t%s\t%s\t%s\t%s\t0\t0\t1\n' "$(basename "$prepo")" "$prepo" "$pbranch" "$pdef"
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

# TESTER REPLAY (external review #4): the merge gate replayed the independent tester's test
# files on the exact merge candidate and that candidate landed — record WHICH assertions
# passed on WHICH landed revision (system evidence, uri gaffer-tester-replayed:<sha>). The
# epic is counted as accepted only on this record (`wg stats`), and `gaffer status` and the
# dashboard ticket page read it. Only when the gate set _MG_REPLAY_RECORD (a bound tester
# PASS is why this ticket lands). A failure is logged, never fatal: the merge has landed,
# and the epic then reads "not replayed" — never accepted on a record that is missing.
# WHICH revision landed: a local landing lands exactly the gated merge (compare-and-land).
# A PR landing lands whatever GitHub made of the PR (a merge, squash or rebase commit, on
# the remote default as it stood then): the record names the local default's head after the
# fast-forward, and only when its TREE equals the candidate's the gate replayed on (the
# remote default did not move in between) — otherwise, or when the local default was not
# fast-forwarded (pr-stale), nothing here can show the replay ran on what landed: no record.
_gaffer_land_replay_record() {
  local num="$1" repo_id="$2" merge="$3" pin="$4" via="$5" who="$6" repo="${7:-}" def="${8:-}"
  [ "${_MG_REPLAY_RECORD:-0}" = "1" ] && [ -n "$merge" ] && [ -n "$pin" ] || return 0
  local landed="$merge" _lt _mt
  case "$via" in
    local) ;;
    pr)
      landed="$(git -C "$repo" rev-parse --verify --quiet "refs/heads/$def^{commit}" 2>/dev/null || true)"
      _lt="$(git -C "$repo" rev-parse --verify --quiet "$landed^{tree}" 2>/dev/null || true)"
      _mt="$(git -C "$repo" rev-parse --verify --quiet "$merge^{tree}" 2>/dev/null || true)"
      if [ -z "$landed" ] || [ -z "$_lt" ] || [ "$_lt" != "$_mt" ]; then
        log "$who: #$num NO tester replay record — the PR landed $def@${landed:0:12}, whose tree is not the candidate ${merge:0:12} the tester's tests passed on (the remote default moved, or the merge method changed the result); the epic is not counted as accepted"
        return 0
      fi ;;
    *)
      log "$who: #$num NO tester replay record — the landed revision cannot be verified (via $via: the local $def was not fast-forwarded); the epic is not counted as accepted"
      return 0 ;;
  esac
  local -a _rr=()
  [ -n "$repo_id" ] && _rr=(--repo "$repo_id")
  if wg ticket record-tester-replay "$num" --commit "$landed" --pin "$pin" --files-json "${_MG_REPLAY_FILES:-[]}" \
       --via "$via" --note "${_MG_REPLAY_NOTE:-}" ${_rr[@]+"${_rr[@]}"} --as system >/dev/null 2>&1; then
    log "$who: #$num recorded the tester replay: ${_MG_REPLAY_COUNT:-0} tester test file(s) passed on the landed revision ${landed:0:12}"
  else
    log "$who: #$num could not record the tester replay on ${landed:0:12} — the epic is not counted as accepted until it is"
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
  local -a _LANDED_REPOS=() _LANDED_BRANCHES=() _LANDED_DEFAULTS=() _LANDED_VIA=()
  while IFS=$'\t' read -r _rid _rname _rpath _rbr _rdef _rlanded _rsec _rpinned; do
    [ -n "$_rpath" ] || continue
    [ "$_rid" = "-" ] && _rid=""
    { [ -n "$_rbr" ] && [ "$_rbr" != "-" ]; } || _rbr="$RBRANCH"
    if [ "$_rlanded" != "1" ] && [ "${_rpinned:-1}" = "0" ]; then
      log "$_WHO: #$RNUM HELD — ${_rname} is a write repository with NO approved commit (the approval did not cover it); nothing more merged — move the ticket back to review and approve every repository together"
      _rc=4; _pending="${_pending:+$_pending, }$_rname"
      break
    fi
    if [ "$_rlanded" != "1" ] && { [ "$_rpath" = "-" ] || [ ! -d "$_rpath" ]; }; then
      log "$_WHO: #$RNUM HELD — ${_rname}'s checkout is not available (${_rpath}); nothing more merged — the ticket is done only when every write repository has landed"
      _rc=4; _pending="${_pending:+$_pending, }$_rname"
      break
    fi
    if [ "$_rlanded" = "1" ]; then
      log "$_WHO: #$RNUM ${_rname}: its approved commit already landed — not merged again"
      _done=$((_done + 1)); _landed_names="${_landed_names:+$_landed_names, }$_rname"
      _LANDED_REPOS+=("$_rpath"); _LANDED_BRANCHES+=("$_rbr"); _LANDED_DEFAULTS+=("$_rdef"); _LANDED_VIA+=("earlier")
      continue
    fi
    # stdin is the plan: the landing (the merge gate runs the repo's own gate commands)
    # must never read it, or a later repo's row would vanish from the loop.
    _gaffer_land_one "$RNUM" "$_rpath" "$_rbr" "$_rdef" "$RSHOW" "$_WHO" "$_rid" "$_rsec" </dev/null; _rc=$?
    if [ "$_rc" -ne 0 ]; then
      _pending="${_pending:+$_pending, }$_rname"
      break
    fi
    _done=$((_done + 1)); _landed_names="${_landed_names:+$_landed_names, }$_rname"
    _LANDED_REPOS+=("$_rpath"); _LANDED_BRANCHES+=("$_rbr"); _LANDED_DEFAULTS+=("$_rdef"); _LANDED_VIA+=("$_MERGED_VIA")
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
    [ "$_done" -gt 0 ] && log "$_WHO: #$RNUM PARTLY MERGED — landed in ${_landed_names}; ${_pending} did not land (rc=$_rc) — held (ready_for_merge, or the human queue when the merge gate held it); the landed repos are recorded and a retry lands the rest"
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
  local _i=0 _tip
  while [ "$_i" -lt "${#_LANDED_REPOS[@]}" ]; do
    if [ "${_LANDED_VIA[$_i]}" = "pr-stale" ]; then
      log "$_WHO: merged branch ${_LANDED_BRANCHES[$_i]} left in place in ${_LANDED_REPOS[$_i]} (local default is stale — delete after pulling)"
    elif git -C "${_LANDED_REPOS[$_i]}" branch -d "${_LANDED_BRANCHES[$_i]}" >/dev/null 2>&1 \
         || { _tip="$(git -C "${_LANDED_REPOS[$_i]}" rev-parse --verify --quiet "refs/heads/${_LANDED_BRANCHES[$_i]}^{commit}" 2>/dev/null)" \
              && [ -n "$_tip" ] \
              && git -C "${_LANDED_REPOS[$_i]}" merge-base --is-ancestor "$_tip" "refs/heads/${_LANDED_DEFAULTS[$_i]}" 2>/dev/null \
              && git -C "${_LANDED_REPOS[$_i]}" update-ref -d "refs/heads/${_LANDED_BRANCHES[$_i]}" "$_tip" >/dev/null 2>&1; }; then
      # (`branch -d` checks "merged into HEAD"; with the target not checked out the gated
      # landing moved only its ref — delete the branch only when its tip is in that repo's
      # target history, compare-and-delete on that tip: nothing can be lost.)
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
  local _CR_BASE _RPR _mrc _prc _mgrc
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
  # PROVENANCE TRAILERS on the merge commit (this repo's gated merge commit, or its PR's
  # merge): the ticket, the approving actor and the gate verdicts, read from the
  # dispatch DB (lib/provenance-trailers.mjs; empty when GAFFER_PROVENANCE_TRAILERS=0).
  # Fail-soft: no trailers never holds a landing.
  local _TRAILERS=""
  _TRAILERS="$(node "$RUNNER_DIR/lib/provenance-trailers.mjs" --db "${DISPATCH_DB:-}" --ticket "$RNUM" 2>/dev/null || true)"
  if [ -n "$_RPR" ]; then
    # MERGE GATE, PR MODE: gate the merge of the pin onto the remote target as just
    # fetched (the local default when the fetch fails). GitHub merges the PR, so the
    # compare-and-land upstream is the repo's branch protection ("require branches to
    # be up to date" + required checks); gaffer's part is never to ask for a merge whose
    # combination failed the gates.
    local _pr_target="refs/heads/$RDEFAULT"
    git -C "$RREPO" fetch --quiet "${GAFFER_PR_REMOTE:-origin}" "$RDEFAULT" >/dev/null 2>&1 && _pr_target="FETCH_HEAD"
    _gaffer_merge_gate "$RNUM" "$RREPO" "$RBRANCH" "$RDEFAULT" "$_TB_PIN" "$RSHOW" "$_pr_target" "$_WHO" "" "$_RSEC"; _mgrc=$?
    case "$_mgrc" in
      0) ;;
      1) _mrc=1 ;;   # the combination conflicts: the resolver path below, no PR merge
      4) _gaffer_merge_gate_hold "$RNUM" "$RBRANCH" "$RDEFAULT" "$_WHO"; return 4 ;;
      *) log "$_WHO: #$RNUM HELD — the merge gate could not run (${_MG_REASON:-unknown}); nothing merged"; return 2 ;;
    esac
  fi
  if [ -n "$_RPR" ] && [ -z "$_mrc" ]; then
    gaffer_pr_merge "$RREPO" "$_RPR" "$RDEFAULT" "$_TB_PIN" "$_TRAILERS"; _prc=$?
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
      _gaffer_merge_gate "$RNUM" "$RREPO" "$RBRANCH" "$RDEFAULT" "$_TB_PIN" "$RSHOW" "refs/heads/$RDEFAULT" "$_WHO" "$_TRAILERS" "$_RSEC"; _mgrc=$?
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
      log "$_WHO: #$RNUM merged $RBRANCH → $RDEFAULT in $RREPO (via $_MERGED_VIA)"
      _gaffer_land_record "$RNUM" "$_RID" "$_TB_PIN" "$_MERGED_VIA" "$_WHO"
      # TESTER REPLAY: which tester assertions passed on which landed revision.
      _gaffer_land_replay_record "$RNUM" "$_RID" "$_MG_MERGE" "$_TB_PIN" "$_MERGED_VIA" "$_WHO" "$RREPO" "$RDEFAULT"
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
      # The resolver works on the PRIMARY repo; a secondary repo's conflict is a human's.
      if [ "$_RSEC" = "1" ]; then
        log "$_WHO: #$RNUM merge of $RBRANCH in $(basename "$RREPO") hit a CONFLICT (a secondary repository; the resolver handles the primary only) — held for a human"
      elif _gaffer_land_conflict_resolve "$RNUM" "$RREPO" "$RBRANCH" "$RDEFAULT" "$_WHO"; then
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
# TESTER REPLAY (external review #4): the independent tester's assertions describe the
# commit it tested; after the target moved, the merge passed the repo's own suite yet failed
# the tester's saved assertion, and landed. So once the repo's gates pass on the merge (or
# DoD is OFF), the PRIMARY repo's gate also replays the tester's test files from
# gaffer-tests/ticket-<n> on that same scratch merge (_gaffer_merge_gate_tester_replay); a
# failure is a red gate (rc 4, _MG_KIND=tester_replay_red, naming the files).
#   _gaffer_merge_gate <num> <repo> <branch> <default> <pin> <show-json> <target-ref> [who] [trailers] [secondary]
#     [trailers] — the provenance trailer block (lib/provenance-trailers.mjs) for the gated
#     merge commit, which is the commit that lands: with it the merge is `--no-ff`, so a
#     merge commit exists to carry them; without it a fast-forward stays possible ("" in
#     PR mode, where GitHub makes the merge commit).
#     [secondary] — "1" for a ticket's secondary repo (no tester replay: the tester's verdict
#     describes the primary).
#     → 0 the merge passed (or DoD is OFF — GAFFER_DOD=0, logged) · 1 the merge CONFLICTS
#       · 4 the merge FAILS its gates or the tester's replay · 2 the gate could not run
#       (held, fail closed).
#     Sets _MG_TARGET (the gated target head), _MG_MERGE (the gated merge commit),
#     _MG_EVIDENCE (the gate's checklist), _MG_REASON, _MG_KIND (merge_gate_red |
#     tester_replay_red | tester_replay_unverified on a held gate) and, for the replay
#     record, _MG_REPLAY_RECORD (1 when a bound tester PASS's tests ran and passed on
#     _MG_MERGE), _MG_REPLAY_FILES (JSON array: the files proven to have run) and
#     _MG_REPLAY_COUNT.
_gaffer_merge_gate() {
  local num="$1" repo="$2" branch="$3" def="$4" pin="$5" show="$6" target_ref="$7" who="${8:-MERGE}" trailers="${9:-}" secondary="${10:-0}"
  local msg="Merge branch '$branch'" ffopt=()
  if [ -n "$trailers" ]; then msg="$msg"$'\n\n'"$trailers"; ffopt=(--no-ff); fi
  _MG_TARGET=""; _MG_MERGE=""; _MG_EVIDENCE=""; _MG_REASON=""; _MG_KIND=""
  _MG_REPLAY_RECORD=0; _MG_REPLAY_FILES="[]"; _MG_REPLAY_COUNT=0; _MG_REPLAY_NOTE=""
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
  if ! git -C "$wt" ${ids[@]+"${ids[@]}"} merge --quiet --no-edit ${ffopt[@]+"${ffopt[@]}"} -m "$msg" "$pin" >/dev/null 2>&1; then
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
  # carries an integrity row (PASS/FLAG, never FAIL) for the merged tree. The scratch
  # worktree stays until the tester replay below has run on the same merge.
  out="$(bash "${RUNNER_DIR:-.}/bin/dod-regate.sh" "$wt" "$label" "${tcmd:--}" "${lcmd:--}" "$_MG_TARGET" "$allow" 2>/dev/null)"; rc=$?
  _MG_EVIDENCE="$out"
  local trc=0
  case "$rc" in
    0) log "$who: #$num MERGE GATE PASS — the combined code passes the gates on $def@${_MG_TARGET:0:12}" ;;
    3) log "$who: #$num MERGE GATE OFF (GAFFER_DOD=0) — the combination was NOT gated" ;;
    *) _MG_KIND="merge_gate_red"; _MG_REASON="the merge of ${pin:0:12} onto $def@${_MG_TARGET:0:12} fails the Definition-of-Done gates"; trc=4 ;;
  esac
  # TESTER REPLAY on the same merge candidate (the primary repo: the tester's verdict
  # describes it; a secondary repo lands only its own pin).
  if [ "$trc" -eq 0 ] && [ "$secondary" != "1" ]; then
    _gaffer_merge_gate_tester_replay "$num" "$repo" "$pin" "$wt" "$label" "$tcmd" "$def" "$who" "$rc"; trc=$?
  fi
  git -C "$repo" worktree remove --force "$wt" >/dev/null 2>&1 || true; rm -rf "$wt"; git -C "$repo" worktree prune >/dev/null 2>&1 || true
  return "$trc"
}

# TESTER REPLAY on the merge candidate — the scratch merge worktree <wt> (detached at the
# gated merge _MG_MERGE). lib/tester-replay.mjs decides from the dispatch DB whether a
# bound tester PASS of exactly <pin> is why this lands, and checks the tester's test files
# (only those it added or changed on gaffer-tests/ticket-<n>, never its wiring) out into
# <wt>'s working tree — the gated merge COMMIT is unchanged, so the tester's files are
# run, never landed. PROOF OF EXECUTION (external review #7): the files run explicitly
# with the stack's runner where a file-scoped invocation is well defined (`node --test
# <files…>`, vitest/jest by path, pytest, go, cargo), else the registered command runs, in
# both cases through bin/dod-regate.sh (tests only; the same runner, sandbox and timeouts
# as the merge gate); then the runner's own per-file evidence is read. A registered
# `node --test test/label.test.mjs` never executed the tester's file, the run passed and
# the record named that file as passed: now a file with no proof HOLDS the landing.
#   → 0 passed and every file proven, or nothing to replay (no tester PASS on record: the
#     ticket was not in the testing lane) · 4 the tester's tests FAIL on the candidate
#     (red; _MG_KIND tester_replay_red) or a file shows no evidence it ran (_MG_KIND
#     tester_replay_unverified, the files named) · 2 the replay could not be prepared
#     (held, fail closed).
_gaffer_merge_gate_tester_replay() {
  local num="$1" repo="$2" pin="$3" wt="$4" label="$5" tcmd="$6" def="$7" who="$8" dodrc="${9:-0}"
  local helper="${RUNNER_DIR:-}/lib/tester-replay.mjs" out rc run record files reason rout rrc
  local inv icmd irunner imode iout inodeopt ikey proof unproven ran
  if [ ! -f "$helper" ] || ! command -v node >/dev/null 2>&1; then
    _MG_REASON="the tester replay (lib/tester-replay.mjs) cannot run"; return 2
  fi
  out="$(node "$helper" apply --db "${DISPATCH_DB:-}" --ticket "$num" --repo "$repo" --pin "$pin" --worktree "$wt" \
           --test-cmd "${tcmd:--}" --base "${_MG_TARGET:-}" 2>/dev/null)"; rc=$?
  reason="$(printf '%s' "$out" | jget 'd.reason || ""' 2>/dev/null || echo '')"
  if [ "$rc" -ne 0 ]; then
    _MG_REASON="the tester's tests could not be prepared for a replay on the merge (${reason:-rc=$rc})"; return 2
  fi
  record="$(printf '%s' "$out" | jget 'd.record ? "1" : ""' 2>/dev/null || echo '')"
  if [ "$record" != "1" ]; then
    log "$who: #$num TESTER REPLAY — nothing to replay (${reason:-no tester PASS on record})"
    return 0
  fi
  run="$(printf '%s' "$out" | jget 'd.run ? "1" : ""' 2>/dev/null || echo '')"
  files="$(printf '%s' "$out" | jget '(d.files || []).join(", ")' 2>/dev/null || echo '')"
  _MG_REPLAY_FILES="$(printf '%s' "$out" | jget 'JSON.stringify(d.files || [])' 2>/dev/null || echo '[]')"
  _MG_REPLAY_COUNT="$(printf '%s' "$out" | jget 'String((d.files || []).length)' 2>/dev/null || echo 0)"
  _MG_REPLAY_NOTE="$reason"
  if [ "$run" != "1" ]; then
    log "$who: #$num TESTER REPLAY — no tester test files to replay (${reason}); the merge gate's suite is what the tester ran"
    _MG_REPLAY_RECORD=1; return 0
  fi
  if [ -z "${tcmd// /}" ]; then
    _MG_KIND="tester_replay_red"
    _MG_REASON="the independent tester's tests ($files) cannot be replayed on the merge of ${pin:0:12} onto $def@${_MG_TARGET:0:12}: the repo has no test command"
    _MG_EVIDENCE="DoD: FAIL (no test command to replay the tester's tests)"
    return 4
  fi
  inv="$(printf '%s' "$out" | jget 'JSON.stringify(d.invocation || null)' 2>/dev/null || echo 'null')"
  icmd="$(printf '%s' "$out" | jget '(d.invocation && d.invocation.command) || ""' 2>/dev/null || echo '')"
  irunner="$(printf '%s' "$out" | jget '(d.invocation && d.invocation.runner) || ""' 2>/dev/null || echo '')"
  imode="$(printf '%s' "$out" | jget '(d.invocation && d.invocation.mode) || ""' 2>/dev/null || echo '')"
  iout="$(printf '%s' "$out" | jget '(d.invocation && d.invocation.proof && d.invocation.proof.output) || ""' 2>/dev/null || echo '')"
  inodeopt="$(printf '%s' "$out" | jget '(d.invocation && d.invocation.env && d.invocation.env.NODE_OPTIONS) || ""' 2>/dev/null || echo '')"
  # The node:test reporter's signing key: in the run's environment only (the reporter
  # deletes it before any test file starts) and handed to the proof step on stdin.
  ikey="$(printf '%s' "$out" | jget '(d.invocation && d.invocation.env && d.invocation.env.GAFFER_REPLAY_PROOF_KEY) || ""' 2>/dev/null || echo '')"
  if [ -z "$icmd" ] || [ -z "$iout" ]; then
    _MG_REASON="the tester replay produced no invocation for the tester's tests ($files)"; return 2
  fi
  log "$who: #$num TESTER REPLAY — running the tester's $_MG_REPLAY_COUNT test file(s) ($files) on the merge candidate ${_MG_MERGE:0:12} ($irunner, $([ "$imode" = files ] && echo "by path" || echo "the registered command"))"
  local -a _renv=(GAFFER_DOD=1 GAFFER_DOD_TESTS=1 GAFFER_DOD_TYPECHECK=0 GAFFER_DOD_LINT=0 "GAFFER_DOD_TESTS_OUTPUT=$iout")
  [ -n "$inodeopt" ] && _renv+=("NODE_OPTIONS=$inodeopt")
  [ -n "$ikey" ] && _renv+=("GAFFER_REPLAY_PROOF_KEY=$ikey")
  # The merge gate already installed this worktree's dependencies.
  [ "$dodrc" = "0" ] && _renv+=(GAFFER_DOD_INSTALL=0)
  rout="$(env "${_renv[@]}" bash "${RUNNER_DIR:-.}/bin/dod-regate.sh" "$wt" "$label:tester-replay" "$icmd" - "$_MG_TARGET" 2>/dev/null)"; rrc=$?
  if [ "$rrc" -ne 0 ]; then
    _MG_KIND="tester_replay_red"
    _MG_EVIDENCE="$rout"
    _MG_REASON="the independent tester's tests ($files) fail on the merge of ${pin:0:12} onto $def@${_MG_TARGET:0:12} (the repo's own gates pass)"
    return 4
  fi
  # PROOF: every tester file must show the runner's own evidence that it ran. Unreadable
  # proof proves nothing (every file unproven).
  proof="$(printf '%s' "$inv" | node "$helper" proof --worktree "$wt" --invocation - --files-json "$_MG_REPLAY_FILES" 2>/dev/null)" \
    || proof=""
  unproven="$(printf '%s' "$proof" | jget '(d.unproven || []).join(", ")' 2>/dev/null || echo '')"
  ran="$(printf '%s' "$proof" | jget 'JSON.stringify(d.ran || [])' 2>/dev/null || echo '[]')"
  [ -n "$proof" ] || { unproven="$files"; ran="[]"; }
  if [ -n "$unproven" ]; then
    _MG_KIND="tester_replay_unverified"
    _MG_EVIDENCE="$rout"
    _MG_REASON="the independent tester's test file(s) did not run in the replay on the merge of ${pin:0:12} onto $def@${_MG_TARGET:0:12}: $unproven (no evidence from the runner that they executed; replayed with $irunner, $([ "$imode" = files ] && echo "by path" || echo "the registered test command"))"
    return 4
  fi
  # The record lists only the files proven to have run (and the run passed).
  _MG_REPLAY_FILES="$ran"
  _MG_REPLAY_COUNT="$(printf '%s' "$ran" | jget 'String(d.length)' 2>/dev/null || echo 0)"
  log "$who: #$num TESTER REPLAY PASS — the tester's tests ($files) ran and pass on the merge candidate ${_MG_MERGE:0:12}"
  _MG_REPLAY_RECORD=1; return 0
}

# The red merge gate's HOLD: the gate output becomes evidence on the ticket and the
# ticket leaves the merge lane for the human queue (ready_for_merge → blocked, reason
# merge_gate_red | tester_replay_red | tester_replay_unverified). The target was never
# touched.
_gaffer_merge_gate_hold() {
  local num="$1" branch="$2" def="$3" who="${4:-MERGE}" code="${_MG_KIND:-merge_gate_red}" head why
  if [ "$code" = "tester_replay_red" ]; then
    head="TESTER REPLAY FAILED"
    why="The independent tester's tests fail on the merge of $branch onto $def@${_MG_TARGET:0:12} ($_MG_REASON); $def was not touched — see the tester-replay evidence. Rework the branch on the current $def, then re-approve."
  elif [ "$code" = "tester_replay_unverified" ]; then
    # PROOF OF EXECUTION: a tester file the replay cannot show ran is not a pass.
    head="TESTER REPLAY UNVERIFIED"
    why="Tester replay unverified: $_MG_REASON. Nothing landed and no replay record was written; $def was not touched. Make the repo's test command run the tester's files (or register one whose runner gaffer can run by path), then re-approve."
  else
    code="merge_gate_red"; head="MERGE GATE FAILED"
    why="The merge of $branch onto $def@${_MG_TARGET:0:12} fails its gates (each side passed alone); $def was not touched — see the merge-gate evidence. Rework the branch on the current $def, then re-approve."
  fi
  wg attach-evidence "$num" --type test_output \
    --summary "$head: $_MG_REASON"$'\n\n'"${_MG_EVIDENCE:-DoD: FAIL}" >/dev/null 2>&1 || true
  if wg ticket hold "$num" --reason-code "$code" --as system --reason "$why" >/dev/null 2>&1; then
    log "$who: #$num HELD for a human — $_MG_REASON; $def untouched, gate output attached as evidence (blocked, $code)"
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
