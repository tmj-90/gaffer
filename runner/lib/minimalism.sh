# Gaffer minimalism post-condition (sourced by factory.config.sh).
# shellcheck shell=bash
# The typed CLIs live in packages/crew; factory.config.sh exports CREW_DIR, and a lib
# sourced standalone (tests, the gate replay) resolves the workspace default itself.
[ -n "${CREW_DIR:-}" ] || CREW_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../packages/crew" 2>/dev/null && pwd)"
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
  local _numstat
  _numstat="$(git -C "$worktree" diff --numstat "$base"...HEAD 2>/dev/null)"
  # Typed (packages/crew minimalismCli.js diff-stats → diffStats); pinned by
  # minimalism-golden. `printf %s` (no added newline) so an EMPTY numstat stays 0
  # records → "0 0". Without the crew dist there is no stat: print "0 0" and return 1
  # so a caller that checks the status sees the gap.
  if [ ! -f "${CREW_DIR:-}/dist/runtime/minimalism/minimalismCli.js" ]; then echo "0 0"; return 1; fi
  printf '%s' "$_numstat" | node "${CREW_DIR}/dist/runtime/minimalism/minimalismCli.js" diff-stats 2>/dev/null || { echo "0 0"; return 1; }
}

# Assess a completed delivery against the minimalism post-condition.
#   gaffer_check_minimalism <files> <lines> <smallest-change-note>
# Echoes ONE verdict token to stdout and sets GAFFER_MINIMALISM_REASON:
#   "ok"             — note present, diff within size caps               (return 0)
#   "missing_note"   — no smallest-change note → post-condition FAILS    (return 1)
#   "oversized_diff" — note present but diff over a cap → FLAG, not fail  (return 2)
#   "check_failed"   — the typed check could not run (crew unbuilt)  → FAIL (return 1)
# When MINIMALISM_ENFORCE=0 a missing note is downgraded to a non-fatal flag so the
# guard can be observed without blocking (debugging only — default is enforce).
gaffer_check_minimalism() {
  local files="$1" lines="$2" note="$3" changed="${4:-}"
  # Size caps + enforce flag (OVERSIZED_MAX_LINES / OVERSIZED_MAX_FILES / MINIMALISM_ENFORCE)
  # are read from the env by minimalismCli.js itself.
  GAFFER_MINIMALISM_REASON=""

  # Typed (packages/crew minimalismCli.js → checkMinimalism); pinned by minimalism-golden.
  # The CLI emits the three observable outputs on three lines — token / return code /
  # reason — plumbed back to stdout, the exit status and GAFFER_MINIMALISM_REASON.
  # FAIL CLOSED: without the crew dist, or on a node error, the verdict is
  # `check_failed` (return 1) — tick.sh parks on it; a gate decision is never invented.
  local _mm_out _mm_tok _mm_code _mm_reason
  if [ ! -f "${CREW_DIR:-}/dist/runtime/minimalism/minimalismCli.js" ]; then
    GAFFER_MINIMALISM_REASON="minimalism check could not run: packages/crew is not built (dist/runtime/minimalism/minimalismCli.js missing) — run pnpm -r build"
    echo "check_failed"; return 1
  fi
  if _mm_out="$(printf '%s' "$note" | node "${CREW_DIR}/dist/runtime/minimalism/minimalismCli.js" --files "$files" --lines "$lines" --changed "$changed" 2>/dev/null)"; then
    _mm_tok="$(printf '%s\n' "$_mm_out" | sed -n 1p)"
    _mm_code="$(printf '%s\n' "$_mm_out" | sed -n 2p)"
    _mm_reason="$(printf '%s\n' "$_mm_out" | sed -n '3,$p')"
    GAFFER_MINIMALISM_REASON="$_mm_reason"
    printf '%s\n' "$_mm_tok"
    return "$_mm_code"
  fi
  GAFFER_MINIMALISM_REASON="minimalism check could not run: minimalismCli.js exited non-zero"
  echo "check_failed"; return 1
}
