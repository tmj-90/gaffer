#!/usr/bin/env bash
# runner/lib/tick-recovery.sh
# Orphan and crash recovery, and resuming a paused delivery: the orphaned-agent reap,
# the crash cleanup the EXIT/signal traps run, the resume abort and resume-begin.
#
# Sourced by runner/tick.sh only (required there: a missing file fails the tick
# closed). Function definitions only, so sourcing it runs nothing. Every body was
# moved verbatim out of tick.sh; the functions read and write tick.sh's globals
# (NUM, SHOW, WT_ROWS, CLAIM_TOKEN, ...) exactly as the inline code did, and the
# gaffer_tick_* / _gaffer_idle_* wrappers declare no locals, so every assignment in
# them stays global. See runner/CLAUDE.md for the map of the tick phases.

# Reap an orphaned agent process group if one is still recorded (see above). TERM
# the whole group, brief grace, then KILL any survivor so no `claude -p` lingers
# burning tokens. Numeric-guarded and fully best-effort — never faults the trap.
gaffer_reap_orphan_agent() {
  local f="${GAFFER_TIMEOUT_PGID_FILE:-}" pgid
  [ -n "$f" ] && [ -f "$f" ] || return 0
  pgid="$(cat "$f" 2>/dev/null || true)"
  rm -f "$f" 2>/dev/null || true
  [ -n "$pgid" ] || return 0
  case "$pgid" in *[!0-9]*) return 0 ;; esac   # numeric PGID only
  kill -TERM "-$pgid" 2>/dev/null || true
  sleep 1
  kill -KILL "-$pgid" 2>/dev/null || true
  return 0
}

gaffer_crash_cleanup() {
  # Reap any orphaned in-flight agent FIRST — before any branch/worktree decision.
  # A runaway `claude -p` must be torn down regardless of how this tick ends
  # (complete, paused, or crashed); on a clean finish this is a no-op because
  # gaffer_timeout already removed the PGID record.
  gaffer_reap_orphan_agent
  # RESERVATION (external review 16): a delivery or bootstrap call admitted this tick but
  # never booked (the tick died mid-agent) still holds its reservation against the
  # dollar caps. Book it now as a killed call, which settles the reservation at the
  # envelope's reported cost or the kill estimate. After the reap, so the agent is gone.
  if declare -F gaffer_usage_settle_crashed >/dev/null 2>&1; then
    gaffer_usage_settle_crashed delivery "${NUM:-}" "${USAGE_JSON:-}"
    gaffer_usage_settle_crashed bootstrap "${NUM:-}" "${B_USAGE_JSON:-}"
  fi
  # REPLAY MANIFEST (lib/replay-manifest.sh): an attempt no outcome completed ends here:
  # `killed` on a signal, `ended` on any other exit. After the reap (a measurement never
  # delays tearing down a runaway agent), before the claim release below (which would
  # otherwise record the sharper `killed` as a plain release). Fail-soft; a no-op when
  # none is open.
  declare -F gaffer_manifest_close >/dev/null 2>&1 && gaffer_manifest_close "${_GAFFER_EXIT_CAUSE:-exit}"
  # B2: remove this tick's per-tick MCP runtime config (it carries the claim
  # token). Best-effort; a leftover file is harmless (next tick has a new PID)
  # but we don't want $GAFFER_DATA to accumulate one per tick.
  [ -n "${MCP_RUNTIME:-}" ] && rm -f "$MCP_RUNTIME" 2>/dev/null || true
  # B25(a): the docker sandbox's per-call root files are named with THIS tick's PID
  # (lib/sandbox.sh) so they can be swept here without touching a concurrent worker's.
  rm -f "$GAFFER_DATA"/sandbox-write-roots.$$.* "$GAFFER_DATA"/sandbox-read-roots.$$.* "$GAFFER_DATA"/strict-profile.$$.* "$GAFFER_DATA"/worker-prompt.$$.* 2>/dev/null || true
  # RESUME ABORT: a resumed delivery (paused → Continue → in_progress) that ends here
  # without completing — a signal, the outer timeout, a fail-closed setup exit, a
  # worktree that could not be reused — used to stay in_progress with nothing left to
  # pick it up (no queue lists it, and the keep-worktree guard below skipped every
  # release). Put it back to `paused` with its resume context so it shows a Continue
  # button again. Guarded inside on the ticket still being in flight, so a resume that
  # re-paused, parked or submitted is left alone. Worktree + branch are untouched.
  if [ "${_RESUMING:-0}" = "1" ] && [ "${GAFFER_DELIVERY_COMPLETE:-0}" != "1" ] \
     && declare -F gaffer_resume_abort >/dev/null 2>&1; then
    gaffer_resume_abort "the resumed tick ended before the delivery finished (${_GAFFER_EXIT_CAUSE:-exit})" || true
  fi
  # A paused delivery keeps its worktree + branch ALIVE for the one-click resume —
  # the crash-cleanup must never tear it down. This is the load-bearing PAUSE-ON-CAP
  # invariant: a paused worktree survives the tick's exit.
  if [ "${GAFFER_PAUSE_KEEP_WORKTREE:-0}" = "1" ]; then return 0; fi
  # CLEANUP: remove this ticket's per-agent skill-mount dirs (delivery-N /
  # bootstrap-N) — factory state that otherwise accumulates one dir per delivered
  # ticket forever. Placed AFTER the pause guard (a paused delivery's preserved
  # worktree keeps its .claude/skills symlink pointing at the mount for the resume)
  # and BEFORE the delivery-complete return so completed deliveries clean up too.
  # The review-N / clarify-N mounts have their own scoped cleanups.
  if [ -n "${NUM:-}" ] && declare -F gaffer_skills_mount_cleanup >/dev/null 2>&1; then
    gaffer_skills_mount_cleanup "delivery-$NUM"
    # BOOTSTRAP: pass the persistent new-repo dir so the mount's `.claude/skills`
    # symlink is dropped from the REAL repo too (a bootstrap runs the agent directly
    # in $B_DIR — there is no throwaway worktree whose `rm -rf` would take the link
    # with it). Without this the link is left dangling and the post-teardown hygiene
    # gate flags the delivery. `${B_DIR:-}` is empty (a safe no-op) for non-bootstrap
    # ticks. The delivery-$NUM mount above lives in a throwaway worktree, so it needs
    # no dest arg — the worktree purge removes the link with the whole checkout.
    gaffer_skills_mount_cleanup "bootstrap-$NUM" "${B_DIR:-}"
  fi
  # A successfully-delivered branch is intentionally kept for review/merge; only tear
  # down on an INCOMPLETE delivery (a crash/signal before the success point).
  if [ "${GAFFER_DELIVERY_COMPLETE:-0}" = "1" ]; then return 0; fi
  # M2: release the runner-held claim on a hard kill (SIGTERM/OOM/Ctrl-C) BEFORE the
  # worktree teardown. Without this, a mid-delivery kill strands the ticket `claimed`
  # until its lease TTL (~65 min) expires before anything can pick it up. A best-effort
  # release back to `ready` hands it straight back for the common kill/OOM case,
  # tightening the strand from ~65 min to near-zero. Strictly guarded: only when the
  # runner actually holds a claim (CLAIM_TOKEN set) AND the ticket number is known
  # (NUM set — there is a narrow window where the token is captured but NUM is not) AND
  # the delivery did not complete / the pause-keep guard is off (both already ensured
  # by the early returns above; re-checked here for defence). Never let a release
  # failure abort the cleanup that follows (`|| true`). Guarded on the helper being
  # defined so a signal arriving before its definition can't fault the trap.
  if [ -n "${CLAIM_TOKEN:-}" ] && [ -n "${NUM:-}" ] \
     && [ "${GAFFER_CLAIM_RESOLVED:-0}" != "1" ] \
     && [ "${GAFFER_DELIVERY_COMPLETE:-0}" != "1" ] \
     && [ "${GAFFER_PAUSE_KEEP_WORKTREE:-0}" != "1" ] \
     && declare -F gaffer_release_delivery >/dev/null 2>&1; then
    # Say WHICH way the tick ended: a signal is a kill, anything else is an exit the
    # normal flow did not resolve (a setup error that bypassed gaffer_abort_setup, a
    # bug). One fixed "runner killed" reason sent operators looking for kills.
    if [ "${_GAFFER_EXIT_CAUSE:-exit}" = "signal" ]; then
      gaffer_release_delivery ready "runner killed mid-delivery (signal) — claim released by crash trap" || true
      # The outer per-tick bound fires as a signal too: without a skip-file entry the
      # loop's very next tick re-claimed this ticket and restarted it from attempt 1.
      [ -n "${SKIP_FILE:-}" ] && declare -F gaffer_skip_ticket >/dev/null 2>&1 && gaffer_skip_ticket "$NUM"
    else
      gaffer_release_delivery ready "tick exited mid-delivery without resolving the claim (${_GAFFER_EXIT_CAUSE:-exit}) — claim released by crash trap" || true
    fi
  fi
  # Nothing to clean until worktree setup has defined the teardown helper + its rows.
  # Before that point (config/candidate/skill/access parsing) this is a safe no-op.
  if declare -F gaffer_cleanup_worktrees >/dev/null 2>&1 && [ -n "${WT_ROWS:-}" ]; then
    # Once the branch is review-visible (KEEP=1) tear down the worktree but PRESERVE
    # the branch; only drop the branch when retention is off (genuine incomplete run).
    if [ "${GAFFER_KEEP_DELIVERY_BRANCH:-0}" = "1" ]; then
      gaffer_cleanup_worktrees
    else
      gaffer_cleanup_worktrees drop-branch
    fi
  fi
  return 0
}

# RESUME ABORT: put a resumed delivery that did not finish back to `paused` through
# the guarded in_progress → paused edge, re-using its own resume context (reason,
# branch, worktree map, attempt, spend), so the human sees the Continue button again.
# The upsert leaves resume_requested=0: a human presses Continue once more rather than
# the loop re-crashing on the same resume every tick. $1 = why (logged + noted).
# Acts only while the ticket is still in flight (in_progress/claimed); best-effort.
gaffer_resume_abort() {
  local why="$1" st ctx
  [ "${DRY_RUN:-0}" = "1" ] && return 0
  [ "${_RESUME_ABORTED:-0}" = "1" ] && return 0
  [ -n "${NUM:-}" ] || return 0
  st="$(wg ticket show "$NUM" 2>/dev/null | jget 'd.ticket.status' 2>/dev/null || echo '')"
  case "$st" in in_progress|claimed) ;; *) return 0 ;; esac
  _RESUME_ABORTED=1
  ctx="$(wg ticket paused-context "$NUM" 2>/dev/null || echo '{}')"
  local _r _b _w _wj _repo _a _sp
  _r="$(printf '%s' "$ctx" | jget '(d.context && d.context.reason) || "timeout"' 2>/dev/null || echo timeout)"
  _b="$(printf '%s' "$ctx" | jget '(d.context && d.context.branch_name) || ""' 2>/dev/null || true)"
  _w="$(printf '%s' "$ctx" | jget '(d.context && d.context.worktree_path) || ""' 2>/dev/null || true)"
  _wj="$(printf '%s' "$ctx" | jget '(d.context && d.context.worktrees_json) || ""' 2>/dev/null || true)"
  _repo="$(printf '%s' "$ctx" | jget '(d.context && d.context.repo) || ""' 2>/dev/null || true)"
  _a="$(printf '%s' "$ctx" | jget 'String((d.context && d.context.attempt) || 0)' 2>/dev/null || echo 0)"
  _sp="$(printf '%s' "$ctx" | jget '(d.context && d.context.spend) || ""' 2>/dev/null || true)"
  if wg ticket pause "$NUM" --reason "$_r" --attempt "${_a:-0}" \
      ${_b:+--branch "$_b"} ${_w:+--worktree "$_w"} ${_wj:+--worktrees-json "$_wj"} \
      ${_repo:+--repo "$_repo"} ${_sp:+--spend "$_sp"} >/dev/null 2>&1; then
    GAFFER_CLAIM_RESOLVED=1
    wg attach-evidence "$NUM" --type manual_note \
      --summary "RESUME ABORTED: $why — re-paused with its worktree + branch kept; press Continue to retry" >/dev/null 2>&1 || true
    log "RESUME: #$NUM did not finish ($why) — re-paused (→ paused); worktree + branch ${_b:-$WORK_BRANCH} kept, Continue to retry"
  else
    log "RESUME: WARNING — #$NUM did not finish ($why) and could not be re-paused; it is still '$st' — needs a human"
  fi
  return 0
}

# Resume a paused delivery the human pressed Continue on. Moved verbatim from tick.sh; called from tick.sh.
gaffer_tick_resume_begin() {
if [ -n "$RESUME_NUM" ]; then
  # Resolve the resume target as the delivery candidate and re-enter delivery in its
  # existing worktree. resume-begin moves it paused -> in_progress (guarded) and keeps
  # the resume context for crash recovery.
  NUM="$RESUME_NUM"
  # "Primary repo" = the first WRITE link with a local path (fallback: any link with a
  # path, then link 0). Links sort by role then name and every access row is role
  # primary, so a bare repositories[0] was merely the alphabetically first repo.
  SHOW="$(wg ticket show "$NUM" 2>/dev/null)"
  REPO_PATH="$(echo "$SHOW" | jget '(((d.repositories||[]).find(r => r.access === "write" && r.local_path) || (d.repositories||[]).find(r => r.local_path) || (d.repositories||[])[0] || {}).local_path) || ""' 2>/dev/null)"
  STACK="$(echo "$SHOW" | jget '(((d.repositories||[]).find(r => r.access === "write" && r.local_path) || (d.repositories||[]).find(r => r.local_path) || (d.repositories||[])[0] || {}).stack) || ""' 2>/dev/null)"
  TITLE="$(echo "$SHOW" | jget 'd.ticket.title' 2>/dev/null)"
  # PREVIEW IS PREVIEW (external review #8): a dry run reports the resume and changes
  # NOTHING — no resume-begin, so no lease, no paused → in_progress, and the human's
  # resume request stays queued for the live tick. Checked BEFORE the lease is taken.
  if [ "${DRY_RUN:-0}" = "1" ]; then
    log "DRY_RUN: would resume paused #$NUM ('$TITLE') in its existing worktree — resume-begin NOT called: no lease taken, the ticket stays paused and its resume request stays queued for the live tick"
    gaffer_dry_mark_previewed "$NUM"
    result previewed; exit 0
  fi
  # The resume is LEASED to this runner (--agent/--ttl): the pause released the old
  # lease, and resume-begin takes a fresh one and prints its token. From here a resumed
  # delivery uses the same token paths as a fresh one — heartbeat, claim-gated submit,
  # token release, MCP evidence — and if this tick dies the lapsed lease returns the
  # ticket to `paused` (worktree kept) instead of stranding it in_progress unleased.
  if _RESUME_JSON="$(wg ticket resume-begin "$NUM" --agent "$AGENT" --ttl "$GAFFER_CLAIM_TTL" 2>/dev/null)"; then
    CLAIM_TOKEN="$(printf '%s' "$_RESUME_JSON" | jget 'd.claim_token ?? ""' 2>/dev/null || echo '')"
    [ -n "$CLAIM_TOKEN" ] || log "RESUME: WARNING — resume-begin returned no lease token for #$NUM; continuing tokenless"
    declare -F gaffer_note_own_claim >/dev/null 2>&1 && gaffer_note_own_claim "$NUM"
    _RESUMING=1
    # Keep the (existing) worktree alive even if THIS resumed tick crashes mid-way —
    # the partial work must never be torn down by the trap. A clean success still tears
    # the worktree down explicitly (branch kept for review); only crashes are affected.
    GAFFER_PAUSE_KEEP_WORKTREE=1
    READY_COUNT=1   # force entry into the delivery branch below
    log "RESUME: re-entering delivery for paused #$NUM ('$TITLE') in its existing worktree"
  else
    log "RESUME: WARNING — could not resume #$NUM (resume-begin failed); skipping it this run"
    gaffer_skip_ticket "$NUM"
    RESUME_NUM=""
  fi
fi
}
