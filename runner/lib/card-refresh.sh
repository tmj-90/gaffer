# Gaffer memory FRESHNESS — write-through file-card refresh after a delivery lands.
# shellcheck shell=bash
#
# File cards are generated once at onboard. Without this, they go STALE as the factory
# edits code: changed files keep describing old content and new files have no card, so
# priming decays with every ticket shipped (moving the intercept, not the slope). This
# closes the loop: when a ticket merges, refresh the cards for EXACTLY the files it
# changed — mechanical re-extract (content_hash / loc / symbols) for added+modified
# files, drop cards for deleted files, and advance the card watermark. The merged content
# is read from a THROWAWAY WORKTREE of the delivery branch (its tree == what merged), so
# it never touches the operator's live checkout and can't collide with it (the delivery
# branch is never the default). FAIL-SOFT by construction: any memory/git error is logged
# and swallowed — a freshness hiccup must NEVER block or fail the merge.
#
# Reuses the existing memory CLI (the design already anticipated incremental refresh):
#   lg card upsert … --repo-root <wt> --path <f>   (mechanical card; model half stays)
#   lg delete-file-card … --path <f>               (removes a deleted file's card)
#   lg card sync … --commit <sha>                  (advances repo_sync watermark)
#
# gaffer_refresh_cards <repo_root> <repo_display> <base_commit> <branch> <watermark_commit>
gaffer_refresh_cards() {
  local root="${1:-}" repo="${2:-}" base="${3:-}" branch="${4:-}" watermark="${5:-}"
  [ -n "$root" ] && [ -d "$root" ] || return 0
  [ -n "$repo" ] && [ -n "$branch" ] || return 0
  command -v git >/dev/null 2>&1 || return 0
  git -C "$root" rev-parse --verify --quiet "$branch" >/dev/null 2>&1 || return 0

  # Canonical identity — the SAME contract onboard + priming use, so the refreshed
  # cards land under the key priming will look up (never derive it a second way).
  local canonical
  canonical="$(lg repo-canonical --repo-root "$root" 2>/dev/null || true)"
  [ -n "$canonical" ] || { log "cards: freshness skipped for #${NUM:-?} — no canonical for $root"; return 0; }

  [ -n "$base" ] || base="$(git -C "$root" merge-base "$branch" HEAD 2>/dev/null || true)"
  [ -n "$base" ] || return 0

  # Throwaway worktree of the delivery branch (its tree = the merged content). The branch
  # is never the default branch, so `worktree add` can't clash with the live checkout.
  local wt
  wt="$(mktemp -d "${TMPDIR:-/tmp}/gaffer-cards.XXXXXX")" || return 0
  if ! git -C "$root" worktree add --detach --quiet "$wt" "$branch" >/dev/null 2>&1; then
    rm -rf "$wt" 2>/dev/null || true
    return 0
  fi

  local up=0 del=0 st path
  # --no-renames so a rename appears as delete(old)+add(new) — both handled below.
  while IFS="$(printf '\t')" read -r st path; do
    [ -n "$path" ] || continue
    case "$st" in
      A*|M*)
        case "$path" in
          *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.java|*.py|*.go|*.rs|*.sql|*.kt|*.rb|*.php|*.swift)
            lg card upsert --canonical "$canonical" --repo "$repo" --repo-root "$wt" \
              --path "$path" --source delivery >/dev/null 2>&1 && up=$((up + 1)) ;;
        esac ;;
      D*)
        lg delete-file-card --canonical "$canonical" --repo "$repo" --path "$path" \
          >/dev/null 2>&1 && del=$((del + 1)) ;;
    esac
  done < <(git -C "$root" diff --no-renames --name-status "$base" "$branch" 2>/dev/null)

  git -C "$root" worktree remove --force "$wt" >/dev/null 2>&1 || true
  git -C "$root" worktree prune >/dev/null 2>&1 || true
  rm -rf "$wt" 2>/dev/null || true

  if [ -n "$watermark" ]; then
    lg card sync --canonical "$canonical" --repo "$repo" --commit "$watermark" >/dev/null 2>&1 || true
  fi
  log "cards: freshness — refreshed $up, removed $del changed file(s) for #${NUM:-?}; watermark → ${watermark:0:8}"
}
