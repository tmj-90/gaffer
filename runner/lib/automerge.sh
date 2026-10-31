# Gaffer auto-merge helper (sourced by factory.config.sh).
# shellcheck shell=bash
#
# Merge an approved ticket's delivery branch into the repo's default branch when
# AUTO_MERGE=1 (see factory.config.sh — OFF by default), for AFK "full autonomy" runs.
#
# SAFETY — never corrupt a live checkout. The operator may be sitting on the default
# branch with uncommitted work (this is the common case for a solo repo). So:
#   • default branch NOT checked out here → merge in a THROWAWAY WORKTREE; the live
#     working tree is never touched, the branch ref just advances.
#   • default branch IS the checked-out branch AND the tree is CLEAN → merge in place
#     (the operator walked away from a clean checkout; they return to merged work).
#   • default branch IS checked out AND the tracked tree is DIRTY (or an untracked file
#     is in the merge's way) → REFUSE (rc 3), leave the delivery branch for a human. An
#     AFK machine must never merge over active edits.
# Force-free + push-free by construction (a plain `git merge` only) — push is a separate,
# explicitly-gated step (gaffer_auto_push). On conflict it aborts and leaves the delivery
# branch intact for a human.
#
#   gaffer_auto_merge <repo_dir> <branch> <default_branch> [pin_commit] [trailers]
#     [trailers] — the provenance trailer block (lib/provenance-trailers.mjs) for the
#     merge commit's message. When given the merge is `--no-ff`, so there IS a merge
#     commit to carry them; without it the merge is exactly what it always was.
#     → 0  merged cleanly into <default_branch>
#     → 1  conflict — merge aborted, branch left intact for a human
#     → 2  bad arguments / missing ref — nothing attempted
#     → 3  skipped: the default branch is checked out with uncommitted changes, or with an
#          untracked file the merge would overwrite (unsafe; nothing merged)
#     → 6  refused: <branch> no longer points at <pin_commit> (the commit the landing
#          decision approved) — nothing merged
gaffer_auto_merge() {
  local repo="$1" branch="$2" def="$3" pin="${4:-}" trailers="${5:-}"
  [ -n "$repo" ] && [ -n "$branch" ] && [ -n "$def" ] || return 2
  git -C "$repo" rev-parse --verify --quiet "refs/heads/$branch" >/dev/null 2>&1 || return 2
  local msg="Merge branch '$branch'" ffopt=()
  if [ -n "$trailers" ]; then msg="$msg"$'\n\n'"$trailers"; ffopt=(--no-ff); fi
  git -C "$repo" rev-parse --verify --quiet "refs/heads/$def" >/dev/null 2>&1 || return 2
  # PINNED MERGE (acceptance gate): when the landing decision names the exact commit to
  # land, merge THAT commit — and refuse if the branch no longer points at it — instead
  # of whatever the branch name resolves to by the time the merge runs.
  local src="$branch"
  if [ -n "$pin" ]; then
    [ "$(git -C "$repo" rev-parse --verify --quiet "refs/heads/$branch^{commit}" 2>/dev/null)" = "$pin" ] || return 6
    src="$pin"
  fi

  local head_branch
  head_branch="$(git -C "$repo" symbolic-ref --quiet --short HEAD 2>/dev/null || echo '')"

  if [ "$head_branch" = "$def" ]; then
    # The target is the live checked-out branch. ONLY safe if the TRACKED tree is clean.
    # Untracked files (a .DS_Store, a notes file) are not edits a merge could clobber —
    # git itself refuses a merge that would overwrite one — so they no longer hold every
    # landing for the repo (the dashboard merge and gaffer_pr_merge already ignore them).
    if [ -n "$(git -C "$repo" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
      return 3   # dirty live checkout on the target — never merge over active edits
    fi
    local _merr
    if _merr="$(git -C "$repo" merge ${ffopt[@]+"${ffopt[@]}"} --no-edit -m "$msg" "$src" 2>&1 >/dev/null)"; then return 0; fi
    git -C "$repo" merge --abort 2>/dev/null || true
    # An untracked file in the way is a refusal, not a conflict: rc 1 would hand the
    # branch to the conflict resolver (and spend its one pass) on nothing to resolve.
    case "$_merr" in *"untracked working tree files would be overwritten"*) return 3 ;; esac
    return 1
  fi

  # The target is NOT checked out here → merge in a throwaway worktree. The live
  # working tree is untouched; only the `def` ref advances.
  local wt rc=1
  wt="$(mktemp -d "${TMPDIR:-/tmp}/gaffer-merge.XXXXXX")" || return 2
  if git -C "$repo" worktree add --quiet "$wt" "$def" >/dev/null 2>&1; then
    if git -C "$wt" merge ${ffopt[@]+"${ffopt[@]}"} --no-edit -m "$msg" "$src" >/dev/null 2>&1; then
      rc=0
    else
      git -C "$wt" merge --abort 2>/dev/null || true
      rc=1
    fi
    git -C "$repo" worktree remove --force "$wt" >/dev/null 2>&1 || true
  else
    rc=3   # def is checked out (dirty) in another worktree — refuse
  fi
  git -C "$repo" worktree prune >/dev/null 2>&1 || true
  rm -rf "$wt" 2>/dev/null || true
  return "$rc"
}

# PROVENANCE TRAILERS (lib/provenance-trailers.mjs): every landing path writes the
# ticket, the approving actor and the gate verdicts into the merge commit as git
# trailers (Gaffer-Ticket / Gaffer-Reviewed-By / Gaffer-Gates; never a model name). They
# are not signed: they record what the dispatch DB said, for `git log`, not a proof.
: "${GAFFER_PROVENANCE_TRAILERS:=1}"   # 0 = land with the plain merge message (and a fast-forward when one is possible), as before
export GAFFER_PROVENANCE_TRAILERS

# gaffer_pr_merge <repo_dir> <pr_url> <default_branch> [pin_commit] [trailers]
# [trailers] go in the merge commit's body (`gh pr merge --body`); a rebase merge makes
# no merge commit, so it carries none.
# PR MODE: land an approved delivery THROUGH its pull request instead of merging the
# branch locally. When GAFFER_CREATE_PR opened a PR (the ticket carries pr_url), a local
# merge left that PR open forever and the default branch unpushed — the opposite of what
# the Settings help text promised. So: `gh pr merge <url> --<method> --delete-branch`
# (method = GAFFER_PR_MERGE_METHOD: merge (default) | squash | rebase), then FAST-FORWARD
# the local default branch from GAFFER_PR_REMOTE (origin) — `merge --ff-only` when it is
# the checked-out branch (refused if that tree is dirty, rc 3, like gaffer_auto_merge),
# a plain ff refspec update otherwise. Never a local merge, never a force.
#   → 0  PR merged and the local default branch fast-forwarded
#   → 1  gh failed (auth, not mergeable, network…) — caller falls back to gaffer_auto_merge
#   → 2  bad arguments / `gh` (GAFFER_GH_BIN) not available — caller falls back too
#   → 3  PR merged upstream but the local default branch is checked out DIRTY — not touched
#   → 4  PR merged upstream but the local fast-forward failed — pull by hand
gaffer_pr_merge() {
  local repo="$1" pr_url="$2" def="$3" pin="${4:-}" trailers="${5:-}"
  [ -n "$repo" ] && [ -n "$pr_url" ] && [ -n "$def" ] || return 2
  local gh_bin="${GAFFER_GH_BIN:-gh}" remote="${GAFFER_PR_REMOTE:-origin}"
  command -v "$gh_bin" >/dev/null 2>&1 || return 2
  local method
  case "$(printf '%s' "${GAFFER_PR_MERGE_METHOD:-merge}" | tr '[:upper:]' '[:lower:]')" in
    squash) method=squash ;;
    rebase) method=rebase ;;
    *)      method=merge ;;   # default — a typo can never pick an unintended method
  esac
  [ "$method" = rebase ] && trailers=""
  ( cd "$repo" 2>/dev/null && GH_PROMPT_DISABLED=1 "$gh_bin" pr merge "$pr_url" "--$method" --delete-branch ${pin:+--match-head-commit "$pin"} ${trailers:+--body "$trailers"} ) \
    >/dev/null 2>&1 || return 1

  local head_branch
  head_branch="$(git -C "$repo" symbolic-ref --quiet --short HEAD 2>/dev/null || echo '')"
  if [ "$head_branch" = "$def" ]; then
    [ -z "$(git -C "$repo" status --porcelain --untracked-files=no 2>/dev/null)" ] || return 3
    git -C "$repo" fetch "$remote" "$def" >/dev/null 2>&1 || return 4
    git -C "$repo" merge --ff-only FETCH_HEAD >/dev/null 2>&1 || return 4
  else
    # Not checked out here: a non-forced refspec is fast-forward-only by construction.
    git -C "$repo" fetch "$remote" "$def:$def" >/dev/null 2>&1 || return 4
  fi
  return 0
}

# gaffer_auto_push <repo_dir> <default_branch>
# Push the merged default branch to origin — the last step of the AFK cycle. The CALLER
# gates this on GAFFER_AUTO_PUSH=1 (OFF by default). Force-free (a plain push); it runs
# in the RUNNER, not the agent, so it is outside the agent safety hook — it is a deliberate
# autonomy-mode capability, not an agent action.
#   → 0 pushed · 1 push failed (rejected/offline — left local) · 2 bad args / no origin
gaffer_auto_push() {
  local repo="$1" def="$2"
  [ -n "$repo" ] && [ -n "$def" ] || return 2
  git -C "$repo" remote get-url origin >/dev/null 2>&1 || return 2
  git -C "$repo" push origin "$def" >/dev/null 2>&1 && return 0 || return 1
}
