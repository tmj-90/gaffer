# Gaffer H4 — real PR creation (sourced by factory.config.sh).
# shellcheck shell=bash
_GAFFER_JSON_TOOL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/json-tool.mjs"
#
# When GAFFER_CREATE_PR=1 AND the primary write repo has a GitHub remote, runs
# `gh pr create` with a body assembled from the ticket's evidence bundle (AC list
# + per-AC evidence + diff summary + test/DoD output). Records the resulting URL
# back as `pr_url` on the ticket via `wg delivery-artifact`.
#
# The `gh` binary is injectable via GAFFER_GH_BIN (default: `gh`) so unit tests
# can point it at a stub without a real remote.
#
# Usage:
#   gaffer_create_pr <ticket_num> <repo_dir> <branch> <default_branch> <title>
#     → 0  PR created; prints the PR URL to stdout.
#     → 1  PR creation skipped or failed (logged; never aborts the tick).
#
# This is ALWAYS best-effort: a PR-creation failure is logged and returns 1, but
# the tick still marks `result worked` — delivery is not rolled back.
#
# KNOBS (set in factory.config.sh or environment):
#   GAFFER_CREATE_PR=0      off by default; set to 1 to opt in.
#   GAFFER_GH_BIN=gh        which `gh` binary to call (injectable for tests).
#   GAFFER_PR_REMOTE=origin which remote to push the delivery branch to before
#                           creating the PR (default: origin).

: "${GAFFER_GH_BIN:=gh}"
: "${GAFFER_PR_REMOTE:=origin}"

# True when PR creation is opted in.
gaffer_pr_create_enabled() {
  case "${GAFFER_CREATE_PR:-0}" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

# Detect whether a git repo has a GitHub remote (any remote whose URL contains
# "github.com"). Returns 0 when a GitHub remote exists, 1 otherwise.
gaffer_has_github_remote() {
  local repo_dir="$1"
  git -C "$repo_dir" remote -v 2>/dev/null | grep -qiF 'github.com'
}

# Build the PR body from the evidence bundle on the ticket.
# Prints the body to stdout. Best-effort; never fatal.
gaffer_build_pr_body() {
  local ticket_num="$1"
  node "$_GAFFER_JSON_TOOL" pr-body "$ticket_num" 2>/dev/null || printf 'Delivered ticket #%s\n' "$ticket_num"
}

# Create a PR for a ticket delivery. Returns 0 on success (and prints the PR URL
# to stdout), 1 on skip/failure. NEVER fatal.
#
#   gaffer_create_pr <ticket_num> <repo_dir> <branch> <default_branch> <title>
gaffer_create_pr() {
  local num="$1" repo_dir="$2" branch="$3" def_branch="$4" title="$5"
  [ -n "$num" ] && [ -n "$repo_dir" ] && [ -n "$branch" ] || return 1

  if ! gaffer_pr_create_enabled; then
    log "H4: GAFFER_CREATE_PR off — skipping PR creation for #$num"
    return 1
  fi

  if ! gaffer_has_github_remote "$repo_dir"; then
    log "H4: no GitHub remote in $repo_dir — skipping PR creation for #$num (no-op)"
    return 1
  fi

  if ! command -v "$GAFFER_GH_BIN" >/dev/null 2>&1; then
    log "H4: '$GAFFER_GH_BIN' not found — skipping PR creation for #$num"
    return 1
  fi

  local body_file
  body_file="$(mktemp "${TMPDIR:-/tmp}/gaffer-pr-body.XXXXXX")" || return 1

  # Build the PR body from the evidence bundle. Written to a temp file so the
  # body can contain newlines and the gh call stays safe (no shell interpolation).
  gaffer_build_pr_body "$num" > "$body_file"

  local base="${def_branch:-main}"
  local pr_title="${title:-Deliver #$num}"

  # Push the delivery branch to the remote before creating the PR.
  # gh pr create does NOT push — the remote ref must exist first.
  # Suppress both stdout and stderr: git outputs "branch set up to track" to
  # stdout on some platforms, and we must not pollute the pr_url return value.
  if ! git -C "$repo_dir" push --set-upstream "$GAFFER_PR_REMOTE" "$branch:$branch" >/dev/null 2>&1; then
    log "H4: git push failed for #$num (remote=$GAFFER_PR_REMOTE branch=$branch) — skipping PR creation (non-fatal)"
    rm -f "$body_file"
    return 1
  fi

  local pr_out=""
  pr_out="$(
    cd "$repo_dir" 2>/dev/null &&
    "$GAFFER_GH_BIN" pr create \
      --title "$pr_title" \
      --body-file "$body_file" \
      --base "$base" \
      --head "$branch" 2>&1
  )" || true
  rm -f "$body_file"

  # gh pr create may print warnings or info lines before/after the URL.
  # Extract ONLY the https:// URL line; take the last match in case there are
  # multiple (e.g. "View pull request" banners duplicating the URL).
  local pr_url=""
  pr_url="$(printf '%s\n' "$pr_out" | grep -E '^https://[^[:space:]]+$' | tail -1)"

  if [ -n "$pr_url" ]; then
    log "H4: created PR for #$num → $pr_url"
    # Persist the PR URL back onto the ticket (best-effort; non-fatal).
    wg delivery-artifact "$num" --branch "$branch" --pr "$pr_url" --as system >/dev/null 2>&1 \
      && log "H4: recorded pr_url=$pr_url on #$num" \
      || log "H4: could not record pr_url on #$num (non-fatal)"
    printf '%s' "$pr_url"
    return 0
  else
    log "H4: gh pr create failed for #$num (output: $(printf '%s\n' "$pr_out" | head -3)) — non-fatal"
    return 1
  fi
}
