#!/usr/bin/env bash
# =====================================================================
# Gaffer factory — RECOVERABLE-DELIVERY + ASK-ON-CAP primitives.
# ---------------------------------------------------------------------
# Pure, side-effect-light helpers the tick.sh delivery loop uses to:
#
#   GUARD B (recoverable delivery): tell RECOVERABLE failures (the agent
#     produced ≥1 commit but a downstream gate — DoD / hygiene / minimalism /
#     empty-but-committed — failed) apart from UNRECOVERABLE ones (no commit /
#     empty / crash / safety). A RECOVERABLE failure must PRESERVE the delivery
#     branch and re-invoke the agent on the SAME branch with the gate's feedback,
#     bounded by GAFFER_MAX_DELIVERY_ATTEMPTS; only after attempts exhaust is the
#     ticket parked to `refining` WITH the branch + feedback. The load-bearing
#     INVARIANT: a delivery with ≥1 commit NEVER has its branch deleted by the
#     failure path.
#
#   GUARD C (ask-on-cap): detect a mid-delivery cap-hit from the captured
#     `claude -p --output-format json` (num_turns at/over the cap, or a max-turns
#     stop_reason). On a cap-hit the tick preserves the branch, emits a
#     `ticket_parked` notify (ticket#, spend, dashboard URL — redaction honoured
#     by the dispatch notifier via GAFFER_NOTIFY_REDACT), and parks the ticket as
#     needs-human-review.
#
# These helpers NEVER tear down a worktree/branch themselves and NEVER move a
# ticket — they only READ the captured JSON and COMPUTE classifications, so they
# are trivially testable in isolation and cannot, on their own, lose work.
# tick.sh owns the loop, the branch teardown, and the ticket transitions.
# =====================================================================

# gaffer_branch_has_commits <repo-or-worktree> <base-branch>
# True (exit 0) iff HEAD carries ≥1 commit beyond <base> — i.e. the agent
# produced deliverable work on the branch. This is the RECOVERABLE/UNRECOVERABLE
# discriminator: a branch with commits is salvageable and its branch must never
# be dropped by a failure path. A non-git path or an unreadable diff is treated
# as "no commits" (fail closed to the safe, unrecoverable side).
gaffer_branch_has_commits() {
  local dir="$1" base="${2:-main}"
  [ -n "$dir" ] || return 1
  git -C "$dir" rev-parse --git-dir >/dev/null 2>&1 || return 1
  # rev-list count of commits reachable from HEAD but not from base.
  local n
  n="$(git -C "$dir" rev-list --count "$base"..HEAD 2>/dev/null || echo 0)"
  [ -n "$n" ] && [ "$n" -gt 0 ] 2>/dev/null
}

# gaffer_any_branch_has_commits <wt-rows>
# Across all write-repo rows (id\tname\tpath\tbase\tworktree), true iff ANY
# write repo's branch carries ≥1 commit. Used to classify a multi-repo delivery:
# RECOVERABLE if any repo produced a commit.
gaffer_any_branch_has_commits() {
  local rows="$1"
  local _rid _rname _rpath _rbase _rwt
  while IFS=$'\t' read -r _rid _rname _rpath _rbase _rwt; do
    [ -n "$_rwt" ] || continue
    _rbase="${_rbase:-main}"
    if gaffer_branch_has_commits "$_rwt" "$_rbase"; then return 0; fi
  done <<< "$rows"
  return 1
}

# --- Result-parser seam (Spec 3 / Phase 2) -----------------------------------
# The claude-JSON envelope schema is owned by lib/worker.mjs's parseResult. The cap
# / spend helpers below are thin FORMATTERS over its `parse-result` CLI, so bash and
# the mjs ledger read the SAME parse (no second JSON dialect). Resolve the seam
# relative to THIS file so the helpers work whether sourced by factory.config.sh or
# directly by a unit test; an operator/test override wins.
_GAFFER_DR_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${GAFFER_WORKER_MJS:=$_GAFFER_DR_LIB/worker.mjs}"

# gaffer_cap_num_turns <json-file>
# Echo the integer num_turns from the captured claude JSON, or empty if absent /
# unparseable. Delegates to the worker seam's parseResult so the SAME ground-truth
# field the ledger records drives cap detection.
gaffer_cap_num_turns() {
  local jsonfile="$1"
  [ -f "$jsonfile" ] || return 0
  command -v node >/dev/null 2>&1 || return 0
  node "$GAFFER_WORKER_MJS" parse-result num-turns --json-file "$jsonfile" 2>/dev/null || true
}

# gaffer_cap_stop_reason_is_maxturns <json-file>
# True (exit 0) iff the captured JSON carries a stop/finish reason that signals the
# turn cap was reached (max_turns / max-turns / turn limit across the known shapes).
# Absent/unparseable → not a max-turns stop (false). Delegates to the worker seam.
gaffer_cap_stop_reason_is_maxturns() {
  local jsonfile="$1"
  [ -f "$jsonfile" ] || return 1
  command -v node >/dev/null 2>&1 || return 1
  node "$GAFFER_WORKER_MJS" parse-result stopreason-maxturns --json-file "$jsonfile" 2>/dev/null
}

# gaffer_is_cap_hit <json-file> <rc>
# RECOVERABLE-vs-CAP classification (GUARD C). True (exit 0) iff the call hit a
# turn cap: either num_turns ≥ GAFFER_CAP_DETECT_TURNS, OR a max-turns stop
# reason was reported. A non-zero rc that is the timeout sentinel (124) is NOT a
# turn cap — that is the wall-clock guard, handled as a normal failure — so we
# only treat rc==0 OR an explicit max-turns reason as a cap-hit. Empty/absent
# num_turns → not a cap-hit (we never INVENT a cap from missing data).
gaffer_is_cap_hit() {
  local jsonfile="$1" rc="${2:-0}"
  local cap="${GAFFER_CAP_DETECT_TURNS:-${GAFFER_MAX_TURNS:-60}}"
  # An explicit max-turns stop reason is authoritative regardless of rc/count.
  if gaffer_cap_stop_reason_is_maxturns "$jsonfile"; then return 0; fi
  # Otherwise compare the reported turn count against the cap. A timeout (rc=124)
  # is the wall-clock guard, not a turn cap — do not classify it as cap-hit here.
  [ "$rc" = "124" ] && return 1
  local turns; turns="$(gaffer_cap_num_turns "$jsonfile")"
  [ -n "$turns" ] || return 1
  [ -n "$cap" ] && [ "$turns" -ge "$cap" ] 2>/dev/null
}

# gaffer_delivery_spend <json-file>
# Echo Claude Code's own total_cost_usd for the call (relayed verbatim, never
# computed), or the literal "unknown" when the JSON carried no cost figure — so a
# cap-hit notify never reads as "$0" when the spend was simply unmeasured.
gaffer_delivery_spend() {
  local jsonfile="$1"
  [ -f "$jsonfile" ] || { printf 'unknown'; return 0; }
  command -v node >/dev/null 2>&1 || { printf 'unknown'; return 0; }
  node "$GAFFER_WORKER_MJS" parse-result spend --json-file "$jsonfile" 2>/dev/null || printf 'unknown'
}
