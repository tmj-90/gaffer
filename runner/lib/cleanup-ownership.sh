# Gaffer — CLEANUP OWNERSHIP (lib/cleanup-ownership.sh; external review #8).
# shellcheck shell=bash
# The worktree path ($GAFFER_DATA/worktrees/ticket-<N>/…) and the delivery branch
# (gaffer/ticket-<N>-<slug>) are per TICKET, so two attempts at one ticket share them: an
# old worker whose lease expired (or that was stopped and slow to tear down) can run its
# exit trap after a REPLACEMENT claimed the ticket, committed and submitted it for review.
# The trap used to delete that branch: the ticket read in_review with nothing to review.
#
# A tick now removes a worktree or a branch only while it still OWNS it, checked against
# Dispatch immediately before each destructive step:
#   • the ticket's newest claim (`claim.created`) must still be this run's own claim
#     (captured right after this run claimed: gaffer_note_own_claim). A newer claim is
#     another attempt — its worktree and branch are left alone;
#   • a branch is never deleted while the ticket is a submitted review candidate
#     (in_review / in_testing / ready_for_merge / done): that branch is what review and
#     merge read, whoever submitted it;
#   • an UNKNOWN answer (Dispatch unreadable) keeps everything: nothing is deleted
#     without positive evidence (the external review #4 rule, extended to ownership).
# A kept resource is logged with the reason ("belongs to another attempt").
#
# Dispatch access is injected via GAFFER_WG_SHOW_CMD (prints `ticket show <ref>` JSON;
# the ref is appended), defaulting to tick.sh's `wg`, so tests can run hermetically.
_GAFFER_GCO_JSON_TOOL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/json-tool.mjs"
_GAFFER_OWN_CLAIM_ID="${_GAFFER_OWN_CLAIM_ID:-}"
_GCO_WHY=""

_gco_wg_show() {
  if [ -n "${GAFFER_WG_SHOW_CMD:-}" ]; then
    local -a c; read -ra c <<<"$GAFFER_WG_SHOW_CMD"; "${c[@]}" "$1"
  else
    wg ticket show "$1"
  fi
}

# Remember the claim this run holds (the newest claim.created on the ticket, read while
# this run holds the claim, so no other attempt can have claimed in between).
#   gaffer_note_own_claim <num>
gaffer_note_own_claim() {
  local out
  out="$(_gco_wg_show "$1" 2>/dev/null)" || out=""
  _GAFFER_OWN_CLAIM_ID="$(printf '%s' "$out" | node "$_GAFFER_GCO_JSON_TOOL" latest-claim-id 2>/dev/null || true)"
  return 0
}

# 0 when this run still owns ticket <num>'s <worktree|branch>; 1 otherwise, with the
# reason in _GCO_WHY. No ticket number (nothing claimed yet) is owned: there is no other
# attempt to compare against.
#   gaffer_cleanup_owned <num> <worktree|branch>
gaffer_cleanup_owned() {
  local num="${1:-}" what="${2:-branch}" out rc=0 verdict
  _GCO_WHY=""
  [ -n "$num" ] || return 0
  out="$(_gco_wg_show "$num" 2>/dev/null)" || rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$out" ]; then
    _GCO_WHY="Dispatch could not be read (rc=$rc), so ownership is unknown"
    return 1
  fi
  verdict="$(printf '%s' "$out" | node "$_GAFFER_GCO_JSON_TOOL" cleanup-owner --claim "${_GAFFER_OWN_CLAIM_ID:-}" --what "$what" 2>/dev/null || true)"
  case "$verdict" in
    owned) return 0 ;;
    foreign*|unknown*) _GCO_WHY="${verdict#*	}" ;;
    *) _GCO_WHY="the ownership check produced no answer" ;;
  esac
  return 1
}
