# Gaffer auto-merge helper (sourced by factory.config.sh).
# shellcheck shell=bash
#
# Merge an approved ticket's delivery branch into the repo's default branch when
# AUTO_MERGE=1 (see factory.config.sh — OFF by default). Extracted into its own
# function so the behaviour is testable in isolation (test/auto-merge.test.sh)
# rather than buried inside a tick.
#
# SAFETY: force-free and push-free by construction — a plain `git merge` only.
# It performs NO protected-branch force ops (no --force, no reset --hard, no
# push), so it stays within the deterministic safety hook's rules. On conflict
# it aborts the merge (restoring the default branch) and leaves the delivery
# branch and its commits untouched for a human to resolve.
#
#   gaffer_auto_merge <repo_dir> <branch> <default_branch>
#     → 0  merged cleanly into <default_branch>
#     → 1  conflict — merge aborted, branch left intact for a human
#     → 2  bad arguments — nothing attempted
gaffer_auto_merge() {
  local repo="$1" branch="$2" def="$3"
  [ -n "$repo" ] && [ -n "$branch" ] && [ -n "$def" ] || return 2
  if git -C "$repo" checkout "$def" >/dev/null 2>&1 \
     && git -C "$repo" merge --no-edit "$branch" >/dev/null 2>&1; then
    return 0
  fi
  git -C "$repo" merge --abort 2>/dev/null || true
  return 1
}
