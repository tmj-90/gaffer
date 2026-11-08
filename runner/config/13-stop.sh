# shellcheck shell=bash
# runner/config/13-stop.sh: safety and stop conditions: the self-operation ban, DRY_RUN, the tick and day
# caps, the daily USD cap, parallel execution and the candidate bound.
# Sourced by runner/factory.config.sh only, in its fixed order, never directly or on
# its own: it reads what the parts before it set. Lines moved verbatim from
# factory.config.sh. The last line tells factory.config.sh this part loaded whole.

# --- Self-operation ban (refuse to deliver to Gaffer's own source) ------------
# When Gaffer is open-sourced and someone points the factory at a Gaffer component
# (dispatch / crew / memory / the runner itself), the factory ends up
# editing its OWN source — a footgun and a weird self-modifying recursion. So by
# default the runner REFUSES any delivery (or greenfield bootstrap) whose target
# IS, is INSIDE, or CONTAINS one of the factory's own component dirs (DISPATCH_DIR,
# CREW_DIR, MEMORY_DIR, RUNNER_DIR — all defined above, so this works in
# BOTH the mono layout and the side-by-side layout) — so the monorepo root is
# covered — or is a worktree of the runner's own git repository. Every write repo
# of a multi-repo ticket is checked, not only the first. First-party dogfooding
# overrides it: set GAFFER_ALLOW_SELF_DELIVERY=1 to restore today's behaviour
# exactly. NOTE: not bulletproof — the check is in-tree and removable — but it
# stops the casual case, which is the accepted bar.
: "${GAFFER_ALLOW_SELF_DELIVERY:=0}"

# gaffer_is_self_target <path>
# Returns success (0) when <path> IS, is INSIDE, or CONTAINS any of the factory's
# own component dirs (DISPATCH_DIR / CREW_DIR / MEMORY_DIR / RUNNER_DIR), or is a
# checkout (main or linked worktree) of the same git repository RUNNER_DIR lives
# in. The CONTAINS case is what catches the obvious registration — the gaffer
# monorepo ROOT (`gaffer onboard ~/gaffer`) — and any directory above it: a
# delivery there can edit every component. The same-repo case catches a linked
# worktree of the gaffer checkout registered as a "repo".
# Both sides are CANONICALISED (symlinks resolved via `cd … && pwd -P`, trailing
# slashes normalised) before an equal-or-subdir match (`case "$canon/" in
# "$comp/"*)`) and the reverse ancestor match. Empty/missing component vars are
# skipped. A non-existent <path> can only match by its literal path.
gaffer_is_self_target() {
  local target="${1:-}"
  [ -n "$target" ] || return 1
  # Canonicalise the target (resolve symlinks, strip trailing slash). If it
  # doesn't resolve to a real dir, fall back to a literal trailing-slash strip so
  # we still compare something sane rather than silently passing.
  local canon
  if canon="$(cd "$target" 2>/dev/null && pwd -P)"; then :; else
    canon="${target%/}"
  fi
  local comp comp_canon
  for comp in "${DISPATCH_DIR:-}" "${CREW_DIR:-}" "${MEMORY_DIR:-}" "${RUNNER_DIR:-}"; do
    [ -n "$comp" ] || continue
    if comp_canon="$(cd "$comp" 2>/dev/null && pwd -P)"; then :; else
      comp_canon="${comp%/}"
    fi
    [ -n "$comp_canon" ] || continue
    case "$canon/" in
      "$comp_canon"/*) return 0 ;;
    esac
    # Reverse match: the target is an ANCESTOR of a component (the monorepo
    # root, or anything above it). "${canon%/}/" keeps "/" as "/".
    case "$comp_canon/" in
      "${canon%/}"/*) return 0 ;;
    esac
  done
  # Same git repository as the runner (a linked worktree of the gaffer checkout,
  # or its root reached by another path): compare the canonical common git dirs.
  if [ -n "${RUNNER_DIR:-}" ] && [ -d "$canon" ]; then
    local self_common target_common
    self_common="$(git -C "$RUNNER_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
    target_common="$(git -C "$canon" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
    if [ -n "$self_common" ] && [ -n "$target_common" ]; then
      self_common="$(cd "$self_common" 2>/dev/null && pwd -P || printf '%s' "$self_common")"
      target_common="$(cd "$target_common" 2>/dev/null && pwd -P || printf '%s' "$target_common")"
      [ "$self_common" = "$target_common" ] && return 0
    fi
  fi
  return 1
}

# --- Safety / stop conditions ------------------------------------------------
# DRY_RUN=1 prints what it WOULD do and never invokes Claude or mutates a repo.
# Flip to 0 only when you've reviewed everything and want it live.
: "${DRY_RUN:=1}"
: "${MAX_TICKS:=5}"           # hard cap on ticks per loop run (cost guard)
: "${EMPTY_POLL_LIMIT:=2}"    # stop after this many consecutive empty polls (no_work, or an idle maintenance tick that filed nothing)
: "${TICK_SLEEP:=30}"         # seconds between ticks
# Per-CALENDAR-DAY tick cap across loop.sh runs (overnight cost guard): MAX_TICKS
# bounds one run, but launchd re-runs loop.sh, so this bounds the whole day's
# spend. The count persists in DAILY_COUNTER_FILE and resets each day. 0 = off.
: "${MAX_TICKS_PER_DAY:=50}"
DAILY_COUNTER_FILE="${DAILY_COUNTER_FILE:-$GAFFER_DATA/.daily-ticks}"
# Per-CALENDAR-DAY (UTC) USD spend ceiling (Part B). MAX_TICKS_PER_DAY bounds the
# NUMBER of ticks; this bounds the DOLLARS spent in a UTC day, summed from the usage
# ledger (measured total_cost_usd PLUS killed/timeout estimated_cost_usd, so a run
# that keeps timing out still counts against the cap). Before a tick starts new paid
# work, if the UTC-day ledger spend is already at/over this cap the tick halts
# cleanly (logs why, exits 0) exactly like the MAX_TICKS_PER_DAY stop — the daemon
# then backs off to the next day. Empty or 0 = OFF (the default → the CAP is
# byte-identical to today). Note: killed/timeout cost accounting (Part A,
# GAFFER_KILL_ESTIMATE_USD) is a SEPARATE default-on honesty change — set it to 0
# for the old $0 behaviour. Example: GAFFER_DAILY_BUDGET_USD=20.00.
: "${GAFFER_DAILY_BUDGET_USD:=}"
export GAFFER_DAILY_BUDGET_USD

# --- Parallel ticket execution (A-1) -----------------------------------------
# How many worker processes deliver tickets at once. The DEFAULT of 1 is a hard
# requirement: at 1 the loop runs the exact single-tick path it always has —
# byte-identical behaviour, fully backward-compatible — and ONLY branches into a
# worker pool when an operator opts into N>1. Parallelism is safe because each
# ticket is claimed atomically (a partial unique index → exactly one winner under
# a race), dependency-gated transactionally, and delivered in its own
# deterministic per-ticket worktree on its own branch; the genuinely shared
# mutable state (day-cap counter, usage ledger, skip-file, log) is serialised with
# gaffer_with_lock (below).
: "${GAFFER_CONCURRENCY:=1}"
# Per-repo concurrency cap: aim to never have more than this many tickets in flight
# for a single repo at once (avoids a merge stampede / cross-ticket churn on one
# repo). Enforced via the existing backpressure system (lib/backpressure.sh counts
# active in-flight tickets — claimed + in_progress — per repo). It is the same
# value as the backpressure "claims" cap, so the two stay consistent by
# construction.
#
# CONCURRENCY (RUNNER-OWNED-BOOKKEEPING): selection AND claim are now one atomic step —
# the runner claims the chosen candidate in tick.sh (via `wg claim-ticket`) BEFORE any
# worktree or agent, and skips to the next candidate if the claim loses the race. The
# per-ticket double-claim invariant is enforced transactionally in Dispatch (a ticket is
# claimed at most once), so a ticket is never worked by two ticks. The per-repo cap here
# is still read at selection time (a throttle, not a transactional bound): under
# GAFFER_CONCURRENCY>1 two ticks can each pass the pressure probe for the same under-cap
# repo before either claims, so the cap can be momentarily exceeded by up to the in-flight
# count — but each ticket is still claimed at most once.
: "${MAX_CONCURRENT_TICKETS_PER_REPO:=1}"
# Upper bound on how many ready candidates a single tick scans before giving up
# and yielding no_work. Bounds the per-tick candidate walk (each candidate costs a
# `ticket show` + pressure probe) so a large ready queue can't make every tick do
# O(queue) work. 0 = unlimited (scan the whole ready list, the pre-A-1 behaviour).
: "${MAX_CANDIDATES:=25}"
export GAFFER_CONCURRENCY MAX_CONCURRENT_TICKETS_PER_REPO MAX_CANDIDATES

_GAFFER_CONFIG_PART=13-stop
