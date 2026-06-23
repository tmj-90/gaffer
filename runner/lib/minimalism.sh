# Gaffer minimalism post-condition (sourced by factory.config.sh).
# shellcheck shell=bash
#
# For every COMPLETED delivery the runner requires a minimalism record:
#   • smallest-change note   (MANDATORY — missing → post-condition FAILS)
#   • files-changed count     (computed from the diff)
#   • lines-changed count     (computed from the diff)
#   • why-each-file, tests-run, evidence (recorded by the agent's self-review)
#
# A MISSING smallest-change note FAILS the post-condition so an unjustified change
# cannot glide through (park/flag). An OVERSIZED diff does NOT fail — it flags the
# ticket `needs_human_review: oversized_diff` visibly so a human can suggest a
# split, but is allowed to proceed.
#
# Pure functions: they compute over a git diff and a note string; they record
# nothing themselves (the caller persists the outcome via Dispatch). Returns:
#   gaffer_diff_stats        → echoes "<files> <lines>"
#   gaffer_check_minimalism  → echoes one verdict token, sets the global
#                             GAFFER_MINIMALISM_REASON, returns 0/1/2.

# Echo "<files-changed> <lines-changed>" for a branch diff. Lines = added+deleted
# (the total churn — the number the oversized cap is expressed against). Counts
# come straight from `git diff --numstat`; binary files (numstat "-") count as a
# changed file but contribute 0 lines.
#   gaffer_diff_stats <worktree> <base>
gaffer_diff_stats() {
  local worktree="$1" base="${2:-main}"
  git -C "$worktree" rev-parse --git-dir >/dev/null 2>&1 || { echo "0 0"; return 0; }
  git -C "$worktree" diff --numstat "$base"...HEAD 2>/dev/null | awk '
    { files++ }
    $1 ~ /^[0-9]+$/ { added += $1 }
    $2 ~ /^[0-9]+$/ { deleted += $2 }
    END { printf "%d %d\n", files+0, added+deleted+0 }
  '
}

# Assess a completed delivery against the minimalism post-condition.
#   gaffer_check_minimalism <files> <lines> <smallest-change-note>
# Echoes ONE verdict token to stdout and sets GAFFER_MINIMALISM_REASON:
#   "ok"             — note present, diff within size caps               (return 0)
#   "missing_note"   — no smallest-change note → post-condition FAILS    (return 1)
#   "oversized_diff" — note present but diff over a cap → FLAG, not fail  (return 2)
# When MINIMALISM_ENFORCE=0 a missing note is downgraded to a non-fatal flag so the
# guard can be observed without blocking (debugging only — default is enforce).
gaffer_check_minimalism() {
  local files="$1" lines="$2" note="$3" changed="${4:-}"
  local max_lines="${OVERSIZED_MAX_LINES:-400}" max_files="${OVERSIZED_MAX_FILES:-12}"
  GAFFER_MINIMALISM_REASON=""

  # Smallest-change note is MANDATORY. Treat whitespace-only as missing.
  local trimmed
  trimmed="$(printf '%s' "$note" | tr -d '[:space:]')"
  if [ -z "$trimmed" ]; then
    GAFFER_MINIMALISM_REASON="missing smallest-change note (required for every completed delivery)"
    if [ "${MINIMALISM_ENFORCE:-1}" = "1" ]; then
      echo "missing_note"; return 1
    fi
    # Enforcement off → surface but do not fail.
    echo "missing_note"; return 2
  fi

  # Relevance: a note that references NONE of the actually-changed files looks like
  # boilerplate (agents have pasted an unrelated note verbatim to satisfy the
  # check). Flag for human review — this surfaces gaming without hard-failing a
  # note that is legitimately conceptual. Matches a file's basename or its stem
  # (>=4 chars, so "run-summary" matches "run-summary.sh"). Skipped when no
  # changed-file list is supplied.
  if [ -n "$changed" ]; then
    local nlc referenced=0 f bn stem
    nlc="$(printf '%s' "$note" | tr 'A-Z' 'a-z')"
    for f in $changed; do
      bn="$(basename "$f" | tr 'A-Z' 'a-z')"
      [ -n "$bn" ] || continue
      case "$nlc" in *"$bn"*) referenced=1; break;; esac
      stem="${bn%.*}"
      [ "${#stem}" -ge 4 ] && case "$nlc" in *"$stem"*) referenced=1; break;; esac
    done
    if [ "$referenced" = 0 ]; then
      GAFFER_MINIMALISM_REASON="smallest-change note references no changed file (possible boilerplate): \"$(printf '%s' "$note" | tr -d '\n' | cut -c1-80)\""
      echo "unverified_note"; return 2
    fi
  fi

  # Oversized diff → flag (never fail). A cap of 0 disables that dimension.
  if { [ "${max_lines:-0}" -gt 0 ] && [ "${lines:-0}" -gt "$max_lines" ]; } \
     || { [ "${max_files:-0}" -gt 0 ] && [ "${files:-0}" -gt "$max_files" ]; }; then
    GAFFER_MINIMALISM_REASON="oversized_diff: ${files} files / ${lines} lines (caps: ${max_files} files / ${max_lines} lines) — suggest a split"
    echo "oversized_diff"; return 2
  fi

  GAFFER_MINIMALISM_REASON="minimal: ${files} files / ${lines} lines within caps; smallest-change note present"
  echo "ok"; return 0
}
