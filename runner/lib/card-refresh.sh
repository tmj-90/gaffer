# Gaffer memory FRESHNESS — write-through file-card refresh after a delivery lands.
# shellcheck shell=bash
#
# File cards are generated once at onboard. Without this, they go STALE as the factory
# edits code: changed files keep describing old content and new files have no card, so
# priming decays with every ticket shipped (moving the intercept, not the slope). This
# closes the loop: when a ticket merges, the cards are brought in line with the MERGED
# COMMIT — the default branch's new tip, not the delivery branch's own view of it.
#
# Why the merged commit: two tickets forked from one main can overlap. Ticket A renames
# archive.ts → ledger.ts; ticket B changes a function in archive.ts. Git merges both
# cleanly and B's change lands in ledger.ts — but B's branch still has archive.ts, so a
# refresh that read B's diff and tree re-carded a path that no longer exists, and memory
# answered with it while recording main as fully indexed (third external review). So:
#   1. diff the last indexed commit (the card watermark, when it is an ancestor of the
#      merged commit; else the delivery's fork point) → the merged commit, WITH rename
#      detection: a rename carries the old card's summary to the new path, then drops it;
#   2. read every file from a THROWAWAY WORKTREE of the merged commit (never the
#      operator's live checkout);
#   3. VERIFY every stored card against that tree (`lg card verify --fix`): a card
#      whose path is gone is removed, one whose content hash differs is re-carded;
#   4. only a clean verification advances the watermark to the merged commit (the same
#      call, `--commit`). A failed verification leaves it where it was, so the next
#      merge re-diffs from there and retries.
# FAIL-SOFT by construction: any memory/git error is logged and swallowed — a freshness
# hiccup must NEVER block or fail the merge.
#
# Reuses the memory CLI (Memory owns its DB; the runner never writes it directly):
#   lg card upsert … --repo-root <wt> --path <f> --keep-model [--carry-from <old>]
#   lg delete-file-card … --path <f>
#   lg card verify … --repo-root <wt> --fix --commit <sha> --json
#
# gaffer_refresh_cards <repo_root> <repo_display> <base_commit> <branch> <merged_commit>
#   merged_commit: the default branch's tip after the merge (falls back to <branch>).
gaffer_refresh_cards() {
  local root="${1:-}" repo="${2:-}" base="${3:-}" branch="${4:-}" target="${5:-}"
  [ -n "$root" ] && [ -d "$root" ] || return 0
  [ -n "$repo" ] && [ -n "$branch" ] || return 0
  command -v git >/dev/null 2>&1 || return 0
  [ -n "$target" ] || target="$branch"
  target="$(git -C "$root" rev-parse --verify --quiet "${target}^{commit}" 2>/dev/null || true)"
  [ -n "$target" ] || return 0

  # Canonical identity — the SAME contract onboard + priming use, so the refreshed
  # cards land under the key priming will look up (never derive it a second way).
  local canonical
  canonical="$(lg repo-canonical --repo-root "$root" 2>/dev/null || true)"
  [ -n "$canonical" ] || { log "cards: freshness skipped for #${NUM:-${RNUM:-?}} — no canonical for $root"; return 0; }

  # Diff from what the index last described: the watermark when it is on the merged
  # commit's history, else the delivery's fork point.
  local from="" wm
  wm="$(lg get-card-watermark --canonical "$canonical" --repo "$repo" --json 2>/dev/null \
        | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).syncedCommit||"")}catch{}})' 2>/dev/null || true)"
  if [ -n "$wm" ] && git -C "$root" merge-base --is-ancestor "$wm" "$target" 2>/dev/null; then
    from="$wm"
  fi
  [ -n "$from" ] || from="$base"
  [ -n "$from" ] || from="$(git -C "$root" merge-base "$branch" "$target" 2>/dev/null || true)"
  [ -n "$from" ] || return 0

  # Throwaway DETACHED worktree of the merged commit (its tree is what landed).
  local wt
  wt="$(mktemp -d "${TMPDIR:-/tmp}/gaffer-cards.XXXXXX")" || return 0
  if ! git -C "$root" worktree add --detach --quiet "$wt" "$target" >/dev/null 2>&1; then
    rm -rf "$wt" 2>/dev/null || true
    return 0
  fi

  local up=0 del=0 st path newpath
  # -M: a rename is ONE record (R<score> old new), so the card can follow the file.
  while IFS="$(printf '\t')" read -r st path newpath; do
    [ -n "$path" ] || continue
    case "$st" in
      R*)
        if _gaffer_card_source "$newpath"; then
          lg card upsert --canonical "$canonical" --repo "$repo" --repo-root "$wt" \
            --path "$newpath" --source delivery --keep-model --carry-from "$path" \
            >/dev/null 2>&1 && up=$((up + 1))
        fi
        lg delete-file-card --canonical "$canonical" --repo "$repo" --path "$path" \
          >/dev/null 2>&1 && del=$((del + 1)) ;;
      C*)
        _gaffer_card_source "$newpath" && lg card upsert --canonical "$canonical" --repo "$repo" \
          --repo-root "$wt" --path "$newpath" --source delivery --keep-model >/dev/null 2>&1 \
          && up=$((up + 1)) ;;
      A*|M*|T*)
        _gaffer_card_source "$path" && lg card upsert --canonical "$canonical" --repo "$repo" \
          --repo-root "$wt" --path "$path" --source delivery --keep-model >/dev/null 2>&1 \
          && up=$((up + 1)) ;;
      D*)
        lg delete-file-card --canonical "$canonical" --repo "$repo" --path "$path" \
          >/dev/null 2>&1 && del=$((del + 1)) ;;
    esac
  done < <(git -C "$root" diff -M --name-status "$from" "$target" 2>/dev/null)

  # Verify-before-complete: every stored card against the merged tree; fix what is
  # missing or stale; the watermark moves to the merged commit only when it is clean.
  local vout vrc=0 vsum
  vout="$(lg card verify --canonical "$canonical" --repo "$repo" --repo-root "$wt" \
            --fix --commit "$target" --json 2>/dev/null)" || vrc=$?
  vsum="$(printf '%s' "$vout" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s);
      process.stdout.write(`${r.checked} card(s); fixed ${r.fixed.deleted} missing, ${r.fixed.refreshed} stale; `+
        `${r.remaining.missing.length + r.remaining.stale.length} left`)}catch{process.stdout.write("no report")}})' 2>/dev/null || true)"

  git -C "$root" worktree remove --force "$wt" >/dev/null 2>&1 || true
  git -C "$root" worktree prune >/dev/null 2>&1 || true
  rm -rf "$wt" 2>/dev/null || true

  if [ "$vrc" = 0 ] && [ -n "$vout" ]; then
    log "cards: freshness — refreshed $up, removed $del changed file(s) for #${NUM:-${RNUM:-?}}; verified $vsum against ${target:0:8}; watermark → ${target:0:8}"
  else
    log "cards: freshness — refreshed $up, removed $del changed file(s) for #${NUM:-${RNUM:-?}}; verification against ${target:0:8} NOT clean ($vsum, rc=$vrc) — watermark held"
  fi
}

# Source files the refresh cards (the extensions onboard cards).
_gaffer_card_source() {
  case "${1:-}" in
    *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.java|*.py|*.go|*.rs|*.sql|*.kt|*.rb|*.php|*.swift) return 0 ;;
  esac
  return 1
}
