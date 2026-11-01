#!/usr/bin/env bash
# One factory tick: deliver the next ready ticket via Claude Code + the two MCP
# servers, or (when nothing is ready) run an idle scan that drafts new work.
# Prints a final `TICK_RESULT=worked|previewed|reviewed|clarified|idle_drafted|maintenance_drafted|
# maintenance_ran|merged|parked|no_work|error|setup_error` line (parked: the delivery
# ended with its ticket parked for a human — blocked / refining — on purpose) (previewed: a DRY_RUN tick
# described one delivery and changed nothing) (merged: nothing else to do, but
# the merge lane landed approved work; setup_error: a fail-closed setup check
# refused before any agent launched). On an idle tick: maintenance_drafted / idle_drafted =
# it FILED work (drafts, ingested issues, an epic, lore suggestions); maintenance_ran = it
# ran a model-backed step (feature-backlog planning) but filed nothing — counted against
# the day cap but an empty poll for draining; no_work = nothing claimable and nothing new
# (the deterministic scans cost nothing, so a scan that finds nothing new is no_work);
# auth_error = the delivery call could not authenticate (logged out / a rejected key):
# the claim went back to `ready` without counting an attempt and the run stops;
# usage_paused = the delivery call was refused by the plan's usage window or a rate
# limit: the claim went back to `ready` without counting an attempt and the factory is
# paused until the window resets (lib/usage-pause.mjs).
#
# DRY_RUN=1 (default) prints the plan and never invokes Claude or mutates a repo.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=factory.config.sh
source "$HERE/factory.config.sh"
# Extracted per-mode passes (B-H3: paying down the tick.sh monolith). Sourced
# here so the functions are defined before their call sites below; behaviour is
# identical to the previous inline blocks — the code was relocated verbatim.
# shellcheck source=lib/review.sh
[ -f "$HERE/lib/review.sh" ] && source "$HERE/lib/review.sh"
# shellcheck source=lib/clarify.sh
[ -f "$HERE/lib/clarify.sh" ] && source "$HERE/lib/clarify.sh"
# shellcheck source=lib/tester.sh
[ -f "$HERE/lib/tester.sh" ] && source "$HERE/lib/tester.sh"
# shellcheck source=lib/land.sh
[ -f "$HERE/lib/land.sh" ] && source "$HERE/lib/land.sh"
# shellcheck source=lib/merge-lane.sh
[ -f "$HERE/lib/merge-lane.sh" ] && source "$HERE/lib/merge-lane.sh"
# $GAFFER_DATA holds the DB copies + the per-tick mcp-runtime file (which carries the
# live claim token). Lock it to the owner so another local user can't read the token
# or DBs. 0700 on the dir blocks traversal to any file inside regardless of file mode.
# Create under umask 077 so a freshly-created dir is owner-only even if the explicit
# chmod below can't run, and SURFACE a chmod failure (never silently eat it) — a
# world-traversable data dir would expose the live claim token to other local users.
( umask 077 && mkdir -p "$GAFFER_DATA" ) 2>/dev/null || mkdir -p "$GAFFER_DATA"
if ! chmod 700 "$GAFFER_DATA" 2>/dev/null; then
  echo "gaffer: WARNING — could not chmod 700 $GAFFER_DATA; the live claim token / DB copies inside may be readable by other local users" >&2
fi
# Redirect the crew events log to $GAFFER_DATA so it is never written inside a
# repo worktree (which would trip the delivery-hygiene gate). The GAFFER_* prefix
# means this is automatically included by gaffer_agent_env and inherited by every
# subshell (DoD gates, agent invocations, reviewer, clarifier).
export GAFFER_CREW_EVENTS="${GAFFER_CREW_EVENTS:-$GAFFER_DATA/events.jsonl}"

# ORPHAN-REAP (wallet-drain): every live `claude -p` in this tick runs under
# gaffer_timeout, which records the agent's process-group id here while it is
# in-flight and REMOVES the file the instant the agent returns normally. So this
# file only ever holds a LIVE agent PGID — a survivor of an abnormal tick death.
# The crash-cleanup trap (below) reaps that group as a belt-and-braces backstop to
# gaffer_timeout's own TERM/INT-forwarding + TERM->KILL escalation. Per-tick ($$)
# so concurrent workers never clobber each other's record.
export GAFFER_TIMEOUT_PGID_FILE="$GAFFER_DATA/.agent-pgid.$$"

# PER-TICK MCP RUNTIME CONFIG (B2). tick.sh seds the runner-held
# GAFFER_CLAIM_TOKEN into this file and the agent's `claude -p --mcp-config`
# reads it. Under GAFFER_CONCURRENCY>1, loop.sh runs N worker.sh against the SAME
# $GAFFER_DATA: a single FIXED path let worker B's claim token overwrite worker
# A's file between A writing it and A's claude reading it — so A's agent read B's
# token and every token-gated evidence write failed CLAIM_INVALID (ACs never
# marked, done-gate rejected good deliveries, budget burned). A lock can't fix it
# (claude reads the file asynchronously, long after the tick returns), so each
# tick gets its OWN path — fresh PID per tick.sh process, exactly like the PGID
# file above. Removed on EXIT by the crash-cleanup trap.
MCP_RUNTIME="$GAFFER_DATA/mcp-runtime.$$.json"
# TRACE ID (one per tick). Dispatch stamps it as `correlation_id` on every
# work_event written while it is in the environment — the runner's own `wg` calls
# (claim, submit, gate results, review, merge) AND the agent's MCP writes, since the
# GAFFER_ prefix carries it through gaffer_agent_env into the MCP server's env. So
# every event one tick produced joins on one key (`dispatch events list
# --correlation <id>`), which is what the flat per-file logs never offered. A
# caller (loop.sh, a test) may preset it; otherwise it is time + pid, unique per tick.
GAFFER_TICK_ID="${GAFFER_TICK_ID:-$(date -u +%Y%m%dT%H%M%SZ).$$}"
export GAFFER_TICK_ID
# TICK DEADLINE (factory.config.sh GAFFER_TICK_DEADLINE_GUARD): the tick's own start,
# taken BEFORE the merge lane, so the time left until the outer per-tick bound counts
# resolver time, setup and every attempt's gates — not only agent calls.
_GAFFER_TICK_T0="$(date +%s)"
# Seconds left before the outer bound, less GAFFER_TICK_DEADLINE_MARGIN. Prints a huge
# number when there is no outer bound (0 = unbounded) or the guard is off.
gaffer_tick_remaining() {
  local _ob="${GAFFER_TICK_OUTER_TIMEOUT:-0}" _m="${GAFFER_TICK_DEADLINE_MARGIN:-60}"
  case "$_ob" in ''|*[!0-9]*) _ob=0 ;; esac
  case "$_m" in ''|*[!0-9]*) _m=60 ;; esac
  if [ "$_ob" -le 0 ] || [ "${GAFFER_TICK_DEADLINE_GUARD:-1}" = "0" ]; then echo 999999999; return 0; fi
  echo $(( _GAFFER_TICK_T0 + _ob - _m - $(date +%s) ))
}
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

# ── R-2: crash-cleanup trap installed UP FRONT (covers the whole lifecycle) ─────
# The worktree teardown trap used to be installed only AFTER worktree setup, so a
# crash or signal DURING the earlier candidate / skill / access-boundary parsing
# left no cleanup — orphaning a stale worktree + half-finished gaffer/ branch from a
# PRIOR attempt at the same ticket (the idempotent pre-create cleanup hadn't run
# yet). We install ONE idempotent, unset-var-safe trap here, immediately after the
# config is sourced, so it covers the entire per-ticket flow.
#
# Safety contract:
#   • unset-var-safe: every var/path is guarded (`[ -n "$x" ]` / `[ -d "$x" ]`) and
#     read with `${x:-}` defaults, so it runs cleanly BEFORE any worktree exists
#     under `set -u` (no unbound-variable abort).
#   • idempotent: it only acts once gaffer_cleanup_worktrees + WT_ROWS are defined
#     (after worktree setup); before then it is a deliberate no-op. The underlying
#     teardown is itself idempotent (`git worktree prune` / `branch -D` no-op when
#     there's nothing to remove), so running the trap twice does no harm.
#   • a SUCCESSFULLY-delivered branch is kept: once GAFFER_DELIVERY_COMPLETE=1 the
#     trap returns early and never drops the branch review/merge depends on. The
#     finer-grained GAFFER_KEEP_DELIVERY_BRANCH=1 (raised BEFORE delivery is
#     recorded) keeps the branch while still allowing worktree teardown, so a
#     late signal during the record→complete window can never delete a branch
#     that is already review-visible (FIX-BRANCH).
#   • EXIT vs signal: a returning bash signal trap does NOT end the script. EXIT
#     uses gaffer_on_exit (preserves $?); INT/TERM use gaffer_on_signal which
#     resets the trap and exits 130/143 so termination is never swallowed
#     (FIX-SIGNAL). Both IGNORE further INT/TERM while the cleanup runs: stopping a
#     pool delivers several TERMs (the outer reaper, the worker's group kill), and a
#     second one must not kill the cleanup before the claim is released. The
#     reaper's KILL after GAFFER_REAP_GRACE still bounds a wedged cleanup.
GAFFER_DELIVERY_COMPLETE="${GAFFER_DELIVERY_COMPLETE:-0}"
# Branch-retention seam (FIX-BRANCH): split "keep the delivered branch" from
# "skip cleanup entirely". GAFFER_DELIVERY_COMPLETE=1 means "fully done — the trap
# is a complete no-op". GAFFER_KEEP_DELIVERY_BRANCH=1 means "the worktree may still
# be torn down, but the gaffer/ branch is now review/merge-visible and must NOT be
# deleted". The flag is raised BEFORE the delivery is recorded (below), so there is
# no point after the branch becomes review-visible at which a crash/signal would
# delete it — a salvageable orphan worktree is always preferable to recorded
# evidence pointing at a missing branch.
GAFFER_KEEP_DELIVERY_BRANCH="${GAFFER_KEEP_DELIVERY_BRANCH:-0}"
# PAUSE-ON-CAP retention seam. When an in-flight delivery hits the turn/budget cap it
# is PAUSED IN PLACE: the worktree + branch (committed AND uncommitted work) must
# SURVIVE the tick's normal end-of-run cleanup AND any crash/signal after the pause,
# so the human can one-click Continue back into the SAME worktree. The cap-hit handler
# raises this flag before it exits; the crash-cleanup then becomes a COMPLETE no-op
# (it touches neither worktree nor branch) for this paused ticket.
GAFFER_PAUSE_KEEP_WORKTREE="${GAFFER_PAUSE_KEEP_WORKTREE:-0}"
# CLAIM-RESOLVED seam (N3: no false "runner killed mid-delivery" page). The
# normal flow resolves the claim exactly once — a deliberate park via
# gaffer_release_delivery, or a successful submit via gaffer_submit_delivery.
# Both consume/void the claim token. Without this flag the EXIT trap's
# claim-release block below would then re-attempt the release with the now-void
# token, fail, and log a spurious "needs a human". Once the claim is resolved by
# the normal flow this flag is raised so the crash trap treats it as a clean end
# and does NOT re-release. A genuine crash BEFORE any park/submit leaves it 0, so
# the trap still releases a truly-stranded claim.
GAFFER_CLAIM_RESOLVED="${GAFFER_CLAIM_RESOLVED:-0}"
gaffer_crash_cleanup() {
  # Reap any orphaned in-flight agent FIRST — before any branch/worktree decision.
  # A runaway `claude -p` must be torn down regardless of how this tick ends
  # (complete, paused, or crashed); on a clean finish this is a no-op because
  # gaffer_timeout already removed the PGID record.
  gaffer_reap_orphan_agent
  # B2: remove this tick's per-tick MCP runtime config (it carries the claim
  # token). Best-effort; a leftover file is harmless (next tick has a new PID)
  # but we don't want $GAFFER_DATA to accumulate one per tick.
  [ -n "${MCP_RUNTIME:-}" ] && rm -f "$MCP_RUNTIME" 2>/dev/null || true
  # B25(a): the docker sandbox's per-call root files are named with THIS tick's PID
  # (lib/sandbox.sh) so they can be swept here without touching a concurrent worker's.
  rm -f "$GAFFER_DATA"/sandbox-write-roots.$$.* "$GAFFER_DATA"/sandbox-read-roots.$$.* "$GAFFER_DATA"/strict-profile.$$.* 2>/dev/null || true
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
# FIX-SIGNAL: a bash signal trap that RETURNS normally does NOT terminate the
# script — it cleans up then RESUMES execution past the interrupted point, so a
# cleanup-only handler on INT/TERM would let the runner swallow termination and
# keep going in an inconsistent state. We therefore split EXIT from the signal
# handlers: each resets the trap first (so re-entry can't recurse) then exits with
# the correct status. EXIT preserves the original `$?`; INT exits 130, TERM 143.
# INT/TERM are ignored (not reset to default) for the cleanup itself, so a repeat
# signal cannot kill it half-way and strand the claim, worktree and runtime file.
gaffer_on_exit() {
  local rc=$?
  trap - EXIT; trap '' INT TERM
  _GAFFER_EXIT_CAUSE="${_GAFFER_EXIT_CAUSE:-rc=$rc}"
  gaffer_crash_cleanup
  exit "$rc"
}
gaffer_on_signal() {   # $1 = exit code (130 INT, 143 TERM)
  trap - EXIT; trap '' INT TERM
  _GAFFER_EXIT_CAUSE=signal
  gaffer_crash_cleanup
  exit "$1"
}
trap gaffer_on_exit EXIT
trap 'gaffer_on_signal 130' INT
trap 'gaffer_on_signal 143' TERM

# A-1 (parallel execution): the factory log, the per-run skip-file, and the
# usage ledger are SHARED mutable state. Under GAFFER_CONCURRENCY>1 multiple
# worker.sh processes run tick.sh at once and would interleave their appends. We
# serialise each append under a dedicated portable lock (gaffer_with_lock, from
# factory.config.sh — flock where present, atomic mkdir spinlock on macOS). At
# concurrency 1 there is exactly one writer so every lock is uncontended: it is
# acquired and released with no wait, leaving behaviour byte-identical to before.
#
# _gaffer_locked <lockname> -- <cmd...> runs <cmd> while holding $GAFFER_DATA/<lockname>.
# If gaffer_with_lock isn't defined (it always is via factory.config.sh; this is
# pure defence), the command runs unlocked exactly as it did before.
_gaffer_locked() {
  local lockname="$1"; shift
  if declare -F gaffer_with_lock >/dev/null 2>&1; then
    gaffer_with_lock "$GAFFER_DATA/$lockname" "$@"
  else
    "$@"
  fi
}
# The agent's stderr streams into the same log and its last line may end without a
# newline (claude -p's final text), which glued the next timestamped line onto it in
# `gaffer status` ("…review.2026-09-28T18:32:29 delivery tick …"). Start a fresh line
# when the log's last byte is not one. (`$(tail -c1)` is empty exactly when it is.)
_gaffer_log_line() {
  if [ -s "$GAFFER_LOG" ] && [ -n "$(tail -c1 "$GAFFER_LOG" 2>/dev/null)" ]; then printf '\n' >>"$GAFFER_LOG"; fi
  printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" | tee -a "$GAFFER_LOG" >&2
}
log() { _gaffer_locked .log.lock _gaffer_log_line "$*"; }
# The safety hook, its decision core AND its deny-list sibling must ALL be present
# before we launch a live agent: a missing safety-hook-core.mjs or
# lib/dangerous-commands.mjs would make the hook fail-closed at runtime (blocking
# every tool call), but preflighting them here refuses the tick with a clear cause
# instead. Returns 1 (logged) if any is absent. Callers apply their own fail-closed
# action (exit 1 / return 1).
gaffer_assert_safety_hook() {
  [ -f "$RUNNER_DIR/safety-hook.mjs" ] \
    || { log "SAFETY: hook missing at $RUNNER_DIR/safety-hook.mjs (fail closed)"; return 1; }
  [ -f "$RUNNER_DIR/safety-hook-core.mjs" ] \
    || { log "SAFETY: hook decision core missing at $RUNNER_DIR/safety-hook-core.mjs — the hook cannot decide; refusing (fail closed)"; return 1; }
  [ -f "$RUNNER_DIR/lib/dangerous-commands.mjs" ] \
    || { log "SAFETY: deny-list missing at $RUNNER_DIR/lib/dangerous-commands.mjs — the hook cannot load its rules; refusing (fail closed)"; return 1; }
  return 0
}
# Mark a delivery worktree as a TRUSTED Claude Code workspace so the headless
# `claude -p` agent HONOURS the installed .claude/settings.json permission
# allowlist instead of hanging on a tool-permission prompt no one can answer
# (Claude Code ignores project settings in an untrusted directory, and every
# delivery runs in a fresh, never-trusted worktree). Best-effort: the PreToolUse
# safety-hook is the real boundary, so a failure here only risks the OLD
# prompt-hang behaviour — never a safety regression. Operator-endorsed fix
# (configure ~/.claude.json) rather than --dangerously-skip-permissions.
# Echo the MAIN repo working tree for a git dir: for a LINKED worktree this is the
# directory that holds the shared `.git` (the git-common-dir's parent); for a normal
# repo root it is the dir itself. Empty on a non-git dir / failure. Pure — reads git
# only, mutates nothing — so it is unit-testable in isolation.
gaffer_git_main_worktree() {
  local dir="$1" common
  [ -n "$dir" ] && [ -d "$dir" ] || return 0
  common="$(git -C "$dir" rev-parse --git-common-dir 2>/dev/null)" || return 0
  [ -n "$common" ] || return 0
  case "$common" in
    /*) dirname -- "$common" ;;   # absolute (a linked worktree) → parent of the shared .git
    *)  printf '%s\n' "$dir" ;;   # relative ('.git') → dir is already the repo root
  esac
}

gaffer_trust_workspace() {
  local dir="$1"
  [ -n "$dir" ] && [ -d "$dir" ] || return 0
  # The factory only ever names paths IT controls (a linked delivery worktree, or a
  # full repo it onboarded/created — PRIMARY_REPO, the clarify clone, the greenfield
  # bootstrap). GAFFER_TRUST_ALLOW_REPO=1 vouches for the full-repo shapes; linked
  # worktrees are still validated strictly (under the worktree root) regardless.
  # GAFFER_DATA is passed so the prune of dead worktree entries knows this factory's
  # real worktree root ($GAFFER_DATA/worktrees) under a non-default data dir.
  GAFFER_DATA="${GAFFER_DATA:-}" GAFFER_TRUST_ALLOW_REPO=1 node "$RUNNER_DIR/lib/trust-workspace.mjs" "$dir" 2>>"$GAFFER_LOG" \
    || log "TRUST: could not pre-trust $dir (headless agent may hang on an MCP tool prompt)"
  # Claude Code keys a git WORKTREE's trust on its MAIN repo working tree (the
  # git-common-dir's parent), NOT the worktree path — so trusting only a linked
  # delivery worktree is IGNORED: the agent runs untrusted, the settings allowlist is
  # dropped, and its dispatch/memory MCP tools are never permitted (no evidence /
  # digest / lore writes during delivery). Also trust the main repo root when it
  # differs from the worktree. KEY_ONLY: the agent runs in the worktree (whose own
  # settings.local.json the call above neutralized), so we only write the trust key
  # for the main root — never mutate the onboarded repo's working tree.
  local main
  main="$(gaffer_git_main_worktree "$dir")"
  if [ -n "$main" ] && [ "$main" != "$dir" ] && [ -d "$main" ]; then
    GAFFER_DATA="${GAFFER_DATA:-}" GAFFER_TRUST_ALLOW_REPO=1 GAFFER_TRUST_KEY_ONLY=1 \
      node "$RUNNER_DIR/lib/trust-workspace.mjs" "$main" 2>>"$GAFFER_LOG" \
      || log "TRUST: could not pre-trust main repo root $main (worktree $dir)"
  fi
}
# Append a ticket number to the per-run skip-file under .skip.lock so concurrent
# workers never lose or corrupt an entry (the skip-file stops one bad ticket
# starving the queue; a lost entry would let it be re-claimed forever).
gaffer_skip_ticket() { _gaffer_locked .skip.lock _gaffer_skip_ticket_unlocked "$1"; }
_gaffer_skip_ticket_unlocked() { echo "$1" >> "$SKIP_FILE"; }
# Generic locked single-line append: _gaffer_append_line <file> <line>. Used for
# the per-run reviewed/clarified marker files (same .skip.lock domain — they're
# all per-run bookkeeping appends).
_gaffer_append_line() { echo "$2" >> "$1"; }
# Locked backpressure-report append: _gaffer_bp_record <file> <repo> <triple> <reason>.
_gaffer_bp_record() { printf '%s\t%s\t%s\n' "$2" "$3" "$4" >> "$1"; }
# MERGE LANE (lib/merge-lane.sh): a tick that found nothing else to do but landed approved
# work reports `merged`, never no_work — a landing is work (it frees dependents), and the
# dashboard's Poll for work must not call it empty (external review #7). loop.sh counts it
# as a non-empty poll; worker.sh as reviewed.
_GAFFER_MERGE_LANE_LANDED=0
# PARKED (exploratory finding cli-runner/F-20): a tick that ended by parking its ticket
# for a human (released to blocked / refining: attempts spent, an empty delivery, a gate
# that holds) reports `parked`, not `error` — the park is the designed outcome, and
# "tick → error" sent operators hunting a crash. gaffer_release_delivery sets the flag.
_GAFFER_TICK_PARKED=0
result() {
  if [ "$1" = "no_work" ] && [ "${_GAFFER_MERGE_LANE_LANDED:-0}" -gt 0 ]; then
    echo "TICK_RESULT=merged"; return 0
  fi
  if [ "$1" = "error" ] && [ "${_GAFFER_TICK_PARKED:-0}" = 1 ]; then
    echo "TICK_RESULT=parked"; return 0
  fi
  echo "TICK_RESULT=$1"
}

# DRY RUN preview list (loop.sh exports GAFFER_DRY_PREVIEWED_FILE and empties it at the
# start of a dry run): a ticket previewed once this run is not previewed again.
# Unset (a hand-run dry tick, a dashboard Poll) → no list, every tick previews.
gaffer_dry_previewed() {
  [ "${DRY_RUN:-0}" = "1" ] && [ -n "${GAFFER_DRY_PREVIEWED_FILE:-}" ] && [ -f "$GAFFER_DRY_PREVIEWED_FILE" ] \
    && grep -qxF -- "$1" "$GAFFER_DRY_PREVIEWED_FILE"
}
gaffer_dry_mark_previewed() {
  [ -n "${GAFFER_DRY_PREVIEWED_FILE:-}" ] || return 0
  printf '%s\n' "$1" >> "$GAFFER_DRY_PREVIEWED_FILE" 2>/dev/null || true
}
# SETUP ERROR: one exit for every fail-closed SETUP failure (no agent launched: the
# dispatch CLI unbuilt, no timeout primitive, an unregistrable agent, the safety hook /
# agent env / DB vars / MCP or prompt render refusing). These used to `exit 1` with
# `error`: the crash trap then released the claim as "runner killed mid-delivery" (no
# kill happened), the ticket was re-claimed on the very next tick, and one broken
# install burned the whole MAX_TICKS_PER_DAY on claim/teardown churn. Now the claim is
# released (or a resume re-paused) with the REAL reason, the ticket is skipped for the
# run, the cause is written to $GAFFER_DATA/.setup-error for the loop / daemon, and the
# tick reports `setup_error` — which loop.sh / worker.sh treat as "stop this run" and
# the daemon backs off on (lib/daemon.sh). $1 = tag (SAFETY, MCP-RENDER, …), $2 = msg.
gaffer_abort_setup() {
  local tag="$1" msg="$2"
  log "$tag: $msg"
  _GAFFER_EXIT_CAUSE="setup error: $tag"
  ( umask 077; printf '%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$tag" "$msg" > "$GAFFER_DATA/.setup-error" ) 2>/dev/null || true
  if [ -n "${NUM:-}" ]; then
    if [ "${_RESUMING:-0}" = "1" ] && declare -F gaffer_resume_abort >/dev/null 2>&1; then
      gaffer_resume_abort "setup error: $tag — $msg"
    elif [ -n "${CLAIM_TOKEN:-}" ] && [ "${GAFFER_CLAIM_RESOLVED:-0}" != "1" ] \
         && declare -F gaffer_release_delivery >/dev/null 2>&1; then
      gaffer_release_delivery ready "setup error: $tag — $msg (no agent was launched)"
    fi
    [ -n "${SKIP_FILE:-}" ] && gaffer_skip_ticket "$NUM"
  fi
  result setup_error
  exit 1
}
# Derive an opt-in `--area` from the repo stack label where it is UNAMBIGUOUS, so
# the area-only packs that select-skills now gates (FIX-2) still fire when the
# stack clearly implies a domain. Today only the web/front-end family is safe to
# auto-derive: a react/web/frontend stack → `area=frontend` (so frontend-a11y /
# frontend-component / frontend-responsive / brand fire). Every other stack maps
# to no area (the marketing/product/docs packs stay opt-in for a future
# ticket-type that sets the area explicitly). Echoes the area or nothing.
gaffer_area_for_stack() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    # Mobile RN/Expo is a frontend too. mobile-ui/frontend-design route by stack, but the
    # area-only design packs (brand, frontend-a11y, frontend-responsive, frontend-component)
    # only fire on area=frontend — a mobile app wants those as much as a web app does.
    *react-native*|*expo*|*react*|*frontend*|*web*) printf 'frontend' ;;
    *) ;;
  esac
}
# gaffer_quarantine + QUARANTINE_NOTICE are provided by lib/quarantine.sh (sourced
# via factory.config.sh) — they wrap UNTRUSTED ticket-derived fields (title,
# review feedback) in a delimited envelope before they reach the agent prompt.

[ -f "$DISPATCH_DIR/dist/cli/index.js" ] || gaffer_abort_setup SETUP "dispatch not built — run: pnpm -C $DISPATCH_DIR build"

# R-10: fail closed on a missing timeout primitive. Every live `claude -p` call
# below runs under gaffer_timeout, which now REFUSES to run unbounded when no
# perl/timeout/gtimeout exists. Assert one is present up front and abort the tick
# as a setup error rather than discovering it mid-delivery (a runaway agent must
# never even be launched).
gaffer_timeout_preflight || gaffer_abort_setup SETUP "no timeout primitive — aborting tick (setup error)"

# An existing settings.json that does not parse (or no node to read it) leaves every
# setting it holds — the spend caps included — unknown: factory.config.sh kept the
# inherited values and set _GAFFER_SETTINGS_UNREADABLE. Refuse before any claim or
# spawn, as a setup error (the loop stops, the daemon backs off), never run on
# defaults. DRY_RUN is not exempt: it may be one of the settings that went unread.
if declare -F gaffer_settings_readable >/dev/null 2>&1 && ! gaffer_settings_readable; then
  gaffer_abort_setup SETUP "settings.json ($GAFFER_DATA/settings.json) exists but cannot be parsed (or node is missing) — not starting work until it is fixed"
fi

# Part B (defense-in-depth): before this tick can claim work and spawn ANY paid
# `claude -p`, consult the per-UTC-day USD cap. If the day's ledger spend is already
# at/over GAFFER_DAILY_BUDGET_USD, do NOT start new paid work — halt cleanly like the
# MAX_TICKS_PER_DAY / backpressure stops: log the reason and exit 0 with a no_work
# result so the loop treats it as an empty poll and backs off (no crash, no partial
# spend). DRY_RUN never spends, so it is never gated. Inert when the cap is unset/0.
if [ "${DRY_RUN:-0}" != "1" ] && declare -F gaffer_day_usd_cap_ok >/dev/null 2>&1 \
   && ! gaffer_day_usd_cap_ok; then
  log "BUDGET: UTC-day USD cap reached (spent \$$(gaffer_day_usd_spent) >= \$${GAFFER_DAILY_BUDGET_USD}) — not starting new paid work this tick"
  result no_work; exit 0
fi
# The LIFETIME ceiling (GAFFER_BUDGET_USD), gated the same way before any claim or
# spawn: at $0 headroom a new ready ticket used to get one paid delivery call and only
# THEN pause on budget_cap — one call past the "hard ceiling" per ticket. A resume
# (Continue) waits here too: raising GAFFER_BUDGET_USD is what lets work continue.
if [ "${DRY_RUN:-0}" != "1" ] && declare -F gaffer_budget_headroom_ok >/dev/null 2>&1 \
   && ! gaffer_budget_headroom_ok; then
  log "BUDGET: lifetime budget exhausted (GAFFER_BUDGET_USD=\$${GAFFER_BUDGET_USD}, headroom \$${GAFFER_BUDGET_REMAINING:-unknown}) — not starting new paid work this tick; raise GAFFER_BUDGET_USD to continue"
  result no_work; exit 0
fi
# USAGE WINDOW (lib/usage-pause.sh): a model call was refused by the plan's usage
# window or a rate limit, and $GAFFER_DATA/usage-pause.json says when it resets. Until
# then no tick claims or spawns anything — a refused call would only be refused again.
# `no_work` hands the day-cap slot back (nothing was spent); loop.sh, worker.sh and the
# daemon read the same pause and sleep rather than run ticks into this gate.
if [ "${DRY_RUN:-0}" != "1" ] && declare -F gaffer_usage_pause_active >/dev/null 2>&1 \
   && _USAGE_PAUSE_LINE="$(gaffer_usage_pause_active)"; then
  log "USAGE: $_USAGE_PAUSE_LINE — not starting new paid work this tick"
  result no_work; exit 0
fi

# Ensure a stable factory agent (register once).
if [ ! -s "$GAFFER_AGENT_ID_FILE" ]; then
  wg init >/dev/null 2>&1 || true
  if ! wg agent register -n "$GAFFER_AGENT_NAME" --max-risk high --as system 2>/dev/null | jget 'd.agent.id' > "$GAFFER_AGENT_ID_FILE" 2>/dev/null; then
    gaffer_abort_setup SETUP "could not register factory agent"
  fi
fi
AGENT="$(cat "$GAFFER_AGENT_ID_FILE")"
# The REVIEWER principal (a distinct registered agent) — the review pass approves and
# rejects as this id, never as the delivering agent and never as a bare string.
if [ ! -s "$GAFFER_REVIEWER_ID_FILE" ]; then
  if ! wg agent register -n "${GAFFER_AGENT_NAME}-reviewer" --max-risk high --as system 2>/dev/null | jget 'd.agent.id' > "$GAFFER_REVIEWER_ID_FILE" 2>/dev/null \
     || [ ! -s "$GAFFER_REVIEWER_ID_FILE" ]; then
    rm -f "$GAFFER_REVIEWER_ID_FILE"; gaffer_abort_setup SETUP "could not register the reviewer principal"
  fi
fi
REVIEWER_AGENT="$(cat "$GAFFER_REVIEWER_ID_FILE")"
export REVIEWER_AGENT

# GRADUATED-AUTONOMY: per-repo `auto` policies only act inside the agent review pass;
# under REVIEW_MODE=human they are inert. Say so once per run (factory.config.sh).
declare -F gaffer_inert_policy_check >/dev/null 2>&1 && gaffer_inert_policy_check >/dev/null
# MERGE_ON_AGENT_REVIEW without AUTO_MERGE merges nothing on its own — warn once per run.
declare -F gaffer_half_merge_config_check >/dev/null 2>&1 && gaffer_half_merge_config_check >/dev/null

# ── RUNNER-OWNED-BOOKKEEPING: the runner holds the delivery claim ────────────
# The runner (not the agent) claims the chosen ticket at SELECTION, holds the claim
# token for the whole delivery, submits after ITS gates pass, and releases/parks the
# claim on failure. CLAIM_TOKEN is captured by the candidate-loop claim below, or by
# resume-begin for a resumed delivery (which leases the resume to this runner); it
# stays EMPTY for DRY_RUN (never claims) and only falls back to empty on a resume if
# resume-begin printed no token (the tokenless branches below remain for that case).
CLAIM_TOKEN=""

# Release/park the runner-held delivery claim (RUNNER-OWNED-BOOKKEEPING). $1 =
# ready|refining|blocked, $2 = reason. Optional structured park metadata for the
# board card + the activity trail: $3 = reason-code (e.g. rework_exhausted), $4 =
# attempt reached, $5 = attempt ceiling, $6 = paused-until ISO (reason-code
# usage_limit: the ticket.usage_limited event carries when the window resets). With a token (normal delivery) the matching
# claim is released; without one (a resumed in_progress delivery) the ticket is
# transitioned tokenlessly via the same guarded runner-release path. `blocked` is the
# VISIBLE terminal park for an exhausted rework loop — a human never wonders where the
# ticket went. Best-effort + logged.
gaffer_release_delivery() {
  local to="$1" reason="$2" code="${3:-}" attempt="${4:-}" maxa="${5:-}" until="${6:-}"
  # DRY_RUN never claims, so it never releases — keep it side-effect-free.
  [ "${DRY_RUN:-0}" = "1" ] && return 0
  local extra=()
  [ -n "$code" ]    && extra+=(--reason-code "$code")
  [ -n "$attempt" ] && extra+=(--attempt "$attempt")
  [ -n "$maxa" ]    && extra+=(--max "$maxa")
  [ -n "$until" ]   && extra+=(--paused-until "$until")
  # BOUNDED RETRY. A single failed control-plane call used to be final: the claim
  # stayed live until its TTL, the ticket sat 'claimed' and a human was paged — for
  # what is usually a transient (a busy SQLite writer under GAFFER_CONCURRENCY>1, a
  # slow node start-up). Three attempts with a short back-off self-heal that; a
  # persistent failure is logged WITH the CLI's own error tail so it is diagnosable,
  # not a bare "needs a human". (Seen once on a macOS CI runner: 1 of 4 identical
  # jobs failed the release and stranded the ticket.)
  local _tok=() _verb="released claim on" _fail="could not release claim on" _out="" _try
  if [ -n "${CLAIM_TOKEN:-}" ]; then _tok=(--token="$CLAIM_TOKEN"); else _verb="transitioned"; _fail="could not transition"; fi
  for _try in 1 2 3; do
    if _out="$(wg runner-release "$NUM" --to "$to" ${_tok[@]+"${_tok[@]}"} --reason "$reason" ${extra[@]+"${extra[@]}"} 2>&1)"; then
      local _suffix=""; [ "$_try" -gt 1 ] && _suffix=" after $_try attempts"
      log "$_verb #$NUM → $to ($reason)$_suffix"
      GAFFER_CLAIM_RESOLVED=1
      case "$to" in blocked|refining) _GAFFER_TICK_PARKED=1 ;; esac
      return 0
    fi
    [ "$_try" -lt 3 ] && sleep "$_try"
  done
  # DIAGNOSABLE: a release that fails because the claim is already gone is usually the
  # AGENT having moved the ticket itself (it parked to `blocked` on a decision it opened,
  # which drops the claim). Say so — "needs a human — 3 attempts failed" for a ticket that
  # is already correctly parked and visible sent an operator chasing a phantom.
  local _now_status
  _now_status="$(wg ticket show "$NUM" 2>/dev/null | jget 'd.ticket.status' 2>/dev/null || echo '')"
  case "$_now_status" in
    claimed|in_progress|"")
      log "WARNING — $_fail #$NUM → $to ($reason); needs a human — 3 attempts failed, last error: $(printf '%s' "$_out" | tail -n 3 | tr '\n' ' ' | cut -c1-300)" ;;
    *)
      log "NOTE — $_fail #$NUM → $to: the ticket is already '$_now_status' (moved during the attempt — typically the agent parked it on a decision it opened); nothing further to release. Last error: $(printf '%s' "$_out" | tail -n 1 | cut -c1-200)" ;;
  esac
  # The claim is now resolved by the normal flow (a release we tried and already
  # logged). Mark it so the EXIT crash trap does NOT re-attempt the release with
  # the now-void token and page a spurious "needs a human" (N3).
  GAFFER_CLAIM_RESOLVED=1
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

# ── FINDING-3: CROSS-RUN no-commit failure counter ───────────────────────────
# A per-ticket counter that survives runs (the skip-file is per-run only), kept
# as one small file per ticket under $GAFFER_DATA — the same durability domain
# as the usage ledger the cost bound reads. Dispatch's rework-attempt records
# only cover the in-delivery recoverable loop (wg runner-rework), and this
# failure path must keep working even when the dispatch call itself is what
# failed — so the runner owns this counter locally. Increment is taken under
# the same lock helper as the skip-file so concurrent workers never lose a count.
gaffer_nocommit_file() { printf '%s/.nocommit-failures/%s' "$GAFFER_DATA" "$1"; }
gaffer_nocommit_count() { local _f _n; _f="$(gaffer_nocommit_file "$1")"; _n="$(cat "$_f" 2>/dev/null || echo 0)"; case "$_n" in ''|*[!0-9]*) _n=0 ;; esac; printf '%s' "$_n"; }
_gaffer_nocommit_record_unlocked() { local _f _n; _f="$(gaffer_nocommit_file "$1")"; mkdir -p "${_f%/*}" 2>/dev/null; _n="$(gaffer_nocommit_count "$1")"; _n=$((_n + 1)); printf '%s' "$_n" > "$_f"; printf '%s' "$_n"; }
gaffer_nocommit_record() { _gaffer_locked .nocommit.lock _gaffer_nocommit_record_unlocked "$1"; }
gaffer_nocommit_clear() { rm -f "$(gaffer_nocommit_file "$1")" 2>/dev/null || true; }

# FINDING-3: bounded release for the no-commit / wrong-branch failure paths.
# These paths drop the branch and used to release the claim straight back to
# `ready` — but the skip-file that stops a re-pick is per-RUN, and the per-ticket
# cost ceiling lives in _recover_or_park behind gaffer_any_branch_has_commits,
# which a no-commit crash never reaches. Net: a deterministically-crashing agent
# burned one full `claude -p` per run, forever, at ESCALATING cost (accumulated
# ledger spend feeds the difficulty router). This wrapper applies the SAME
# double-bound as the in-delivery rework loop, but ACROSS runs:
#   • counter < GAFFER_MAX_NOCOMMIT_FAILURES AND spend < the per-ticket ceiling
#     → release to `ready` exactly as before (the recoverable path stays
#     recoverable); the durable counter records the failure;
#   • bound hit (either side) → park VISIBLY to `blocked` via the same
#     rework_exhausted machinery _recover_or_park uses (reason-code on the card,
#     ticket.blocked event, memory demotion) so a human is paged the same way.
# The counter clears here on park, on a successful submit, and on any park out
# of the delivery pipeline — a flaky-then-fixed ticket is never poisoned.
# Numeric-safe awk comparisons. Ticket/config numeric fields (delivery_budget_usd,
# rework spend) originate in the DB, where SQLite NUMERIC affinity can store a
# non-numeric string verbatim — and epics/tickets can be AI-drafted. Passing values
# via `awk -v` (NOT string-interpolated into the program body) means such a value can
# never be parsed as awk source. Empty/garbage coerces to 0. Each returns 0 (success)
# when the comparison holds, matching the previous `awk 'BEGIN{exit !(…)}'` contract.
_num_pos() { awk -v x="${1:-0}" 'BEGIN{exit !(x + 0 > 0)}' 2>/dev/null; }                # x > 0
_num_ge() { awk -v a="${1:-0}" -v b="${2:-0}" 'BEGIN{exit !(a + 0 >= b + 0)}' 2>/dev/null; } # a >= b
_num_le() { awk -v a="${1:-0}" -v b="${2:-0}" 'BEGIN{exit !(a + 0 <= b + 0)}' 2>/dev/null; } # a <= b

gaffer_release_or_park_nocommit() {
  # $2 (optional) = what the parked trail says happened (default: no commits produced).
  local reason="$1" detail="${2:-the agent produced no commits}"
  # DRY_RUN never claims → never releases and never counts; keep it side-effect-free.
  if [ "${DRY_RUN:-0}" = "1" ]; then gaffer_release_delivery ready "$reason"; return 0; fi
  local _max="${GAFFER_MAX_NOCOMMIT_FAILURES:-${GAFFER_MAX_DELIVERY_ATTEMPTS:-3}}"
  [ "$_max" -ge 1 ] 2>/dev/null || _max=3
  local _n; _n="$(gaffer_nocommit_record "$NUM" 2>/dev/null || echo 1)"
  case "$_n" in ''|*[!0-9]*) _n=1 ;; esac
  # Cost side of the double-bound: the SAME effective ceiling _recover_or_park
  # resolves — the ticket's own delivery_budget_usd (TRACK-3a) when set, else the
  # factory-wide GAFFER_REWORK_BUDGET_USD — against the ticket's cumulative
  # MEASURED ledger spend. A crash-looping ticket with real spend past the
  # ceiling parks immediately, even with counter headroom left.
  local _cost_exhausted=0 _ticket_budget _eff_ceiling _spent=0
  _ticket_budget="$(printf '%s' "${SHOW:-}" | jget 'd.ticket.delivery_budget_usd' 2>/dev/null || true)"
  case "$_ticket_budget" in ""|None|null) _ticket_budget="" ;; esac
  if [ -n "$_ticket_budget" ] && _num_pos "$_ticket_budget"; then
    _eff_ceiling="$_ticket_budget"
  else
    _eff_ceiling="${GAFFER_REWORK_BUDGET_USD:-}"
  fi
  if [ -n "$_eff_ceiling" ] && _num_pos "$_eff_ceiling"; then
    _spent="$(gaffer_ticket_rework_spend "$NUM" 2>/dev/null || echo 0)"
    if _num_ge "$_spent" "$_eff_ceiling"; then
      _cost_exhausted=1
      log "NOCOMMIT: #$NUM hit the per-ticket cost ceiling (spent \$${_spent} ≥ \$${_eff_ceiling}) with no committed work — parking to blocked (no unbounded cross-run burn)"
    fi
  fi
  if [ "$_n" -lt "$_max" ] && [ "$_cost_exhausted" -eq 0 ]; then
    gaffer_release_delivery ready "$reason (no-commit failure $_n/$_max across runs)"
    return 0
  fi
  local _why="$_max no-commit failures across runs"
  [ "$_cost_exhausted" -eq 1 ] && _why="the per-ticket cost ceiling (spent \$${_spent} ≥ \$${_eff_ceiling}) with no committed work"
  # Terminal park — same VISIBLE machinery as _recover_or_park's rework_exhausted:
  # the reason-code lands on the board card (last_review_feedback) and the
  # ticket.blocked event pages a human; the durable note records the trail.
  wg attach-evidence "$NUM" --type manual_note \
    --summary "PARKED (rework_exhausted): $reason — after $_why; $detail, needs a human" >/dev/null 2>&1 || true
  gaffer_release_delivery blocked "$reason — parked after $_why; needs a human" rework_exhausted "$_n" "$_max"
  # MEMORY FEEDBACK LOOP: served knowledge did not help this ticket — demote + flag.
  gaffer_recall_feedback blocked
  # Reset the cross-run counter: the ticket has left the delivery pipeline; when a
  # human unblocks it the retry budget starts fresh (never permanently poisoned).
  gaffer_nocommit_clear "$NUM"
  log "NOCOMMIT: parked #$NUM (→ blocked, rework_exhausted) after $_why — VISIBLE on the board; cross-run counter cleared for the post-human retry"
  return 0
}

# PRE-SPAWN BUDGET GATE (C3). Returns 0 (true = EXHAUSTED → do NOT spawn) when the
# ticket's cumulative MEASURED spend has reached its effective ceiling — the ticket's
# own delivery_budget_usd (TRACK-3a) when set, else the factory-wide
# GAFFER_REWORK_BUDGET_USD. No ceiling configured → return 1 (never gate). Sets
# GAFFER_BUDGET_SPENT / GAFFER_BUDGET_CEIL for the caller's message. Mirrors the
# post-attempt rework bound (tick.sh ~1722, kept inline there) but gates BEFORE the
# spawn, closing the cross-run gap: a ticket that already burned its budget in a prior
# run would otherwise spawn one more turn before the post-attempt bound caught it.
gaffer_budget_exhausted() {
  local _num="$1" _tb _ceil _spent
  _tb="$(printf '%s' "${SHOW:-}" | jget 'd.ticket.delivery_budget_usd' 2>/dev/null || true)"
  case "$_tb" in ""|None|null) _tb="" ;; esac
  if [ -n "$_tb" ] && _num_pos "$_tb"; then _ceil="$_tb"; else _ceil="${GAFFER_REWORK_BUDGET_USD:-}"; fi
  { [ -n "$_ceil" ] && _num_pos "$_ceil"; } || return 1
  _spent="$(gaffer_ticket_rework_spend "$_num" 2>/dev/null || echo 0)"
  _num_ge "$_spent" "$_ceil" || return 1
  GAFFER_BUDGET_SPENT="$_spent"; GAFFER_BUDGET_CEIL="$_ceil"; return 0
}

# gaffer_ticket_budget_remaining <num>
# Echo the ticket's remaining USD under its effective ceiling (the same ceiling
# gaffer_budget_exhausted resolves: delivery_budget_usd, else GAFFER_REWORK_BUDGET_USD)
# minus its cumulative spend; nothing when no ceiling is configured. Feeds the
# opt-in per-call cap (gaffer_call_budget_usd) so one call cannot overshoot it.
gaffer_ticket_budget_remaining() {
  local _num="$1" _tb _ceil _spent
  _tb="$(printf '%s' "${SHOW:-}" | jget 'd.ticket.delivery_budget_usd' 2>/dev/null || true)"
  case "$_tb" in ""|None|null) _tb="" ;; esac
  if [ -n "$_tb" ] && _num_pos "$_tb"; then _ceil="$_tb"; else _ceil="${GAFFER_REWORK_BUDGET_USD:-}"; fi
  { [ -n "$_ceil" ] && _num_pos "$_ceil"; } || return 0
  _spent="$(gaffer_ticket_rework_spend "$_num" 2>/dev/null || echo 0)"
  awk -v c="$_ceil" -v s="$_spent" 'BEGIN{printf "%.6f", (c+0)-(s+0)}' 2>/dev/null || true
}

# Submit a passed delivery for review (RUNNER-OWNED-BOOKKEEPING). With a runner-held
# token (normal delivery) it uses the claim-gated submit (claimed → in_review,
# completing the claim; a leased resume goes in_progress → in_review the same way); a
# tokenless resume fallback is moved straight to in_review. $1 = reason. Returns
# non-zero (logged) on failure.
# Derive the delivery-branch slug from a ticket title. SHARED by the normal delivery
# path AND the greenfield bootstrap so both mint the identical `gaffer/ticket-N-<slug>`
# branch shape the reviewer's fallback grep (`gaffer/ticket-$NUM-[a-z0-9-]*`) expects.
# lowercase, non-alnum→'-', collapse repeats, trim, ≤6 words / ~50 chars; empty→'ticket'.
gaffer_ticket_slug() {
  local s
  s="$(printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | tr -c 'a-z0-9' '-' \
    | tr -s '-' \
    | sed -E 's/^-+//; s/-+$//' \
    | cut -d- -f1-6 \
    | cut -c1-50 \
    | sed -E 's/-+$//')"
  [ -n "$s" ] || s="ticket"
  printf '%s' "$s"
}

gaffer_submit_delivery() {
  local reason="$1"
  local _rc _err
  # Capture stderr (discard stdout) so a submit FAILURE reason ("claim expired",
  # "not in a claimable state", "SQLite locked") reaches the log instead of /dev/null —
  # the caller's park path already handles the non-zero rc, but silently losing the
  # WHY made a transient submit failure needlessly hard to triage.
  if [ -n "${CLAIM_TOKEN:-}" ]; then
    _err="$(wg submit "$NUM" --token="$CLAIM_TOKEN" --reason "$reason" 2>&1 >/dev/null)"
    _rc=$?
  else
    _err="$(wg ticket move "$NUM" in_review --as system 2>&1 >/dev/null)"
    _rc=$?
  fi
  [ "$_rc" -ne 0 ] && [ -n "$_err" ] &&
    log "submit for #$NUM failed (rc=$_rc): $(printf '%s' "$_err" | tr '\n' ' ' | cut -c1-300)"
  # VERIFY AFTER WRITE: a submit that reports success but did not land (observed once
  # in the browser regression: rc=0, no transition event, ticket still `claimed`) used
  # to be invisible — the tick logged "submitted" and moved on while the claim stayed
  # live and the ticket never reached review. Re-read the status through a FRESH CLI
  # process; anything but in_review is treated as a failed submit so the caller's
  # park path handles it and the WHY is in the log.
  if [ "$_rc" -eq 0 ]; then
    local _st
    _st="$(wg ticket show "$NUM" 2>/dev/null | jget 'd.ticket.status' 2>/dev/null || echo '')"
    if [ "$_st" != "in_review" ]; then
      log "SUBMIT-VERIFY: #$NUM submit reported success but the ticket reads '${_st:-unknown}' (expected in_review) — treating as a failed submit"
      _rc=1
    fi
  fi
  # On a successful submit the claim is COMPLETED (claimed → in_review): the token
  # is consumed. Mark the claim resolved so the EXIT crash trap doesn't re-release
  # it with the void token and page a spurious "needs a human" (N3). On failure we
  # leave it 0 so the caller's park path (or a genuine crash) still resolves it.
  [ "$_rc" -eq 0 ] && GAFFER_CLAIM_RESOLVED=1
  return "$_rc"
}

# MEMORY FEEDBACK LOOP (RUNNER-OWNED-BOOKKEEPING): close the loop between WHAT
# knowledge memory served into this ticket's context and HOW the ticket turned
# out. The runner knows the outcome; it PASSES it to memory, which adjusts its
# OWN items using its OWN read-event log (memory never reads the dispatch DB).
# $1 = clean | reworked | blocked. Best-effort + logged: a feedback error NEVER
# affects delivery. No-op under DRY_RUN, without the memory CLI, or when this
# delivery logged no recall (RECALL_REPO_NAME unset ⇒ nothing to adjust).
gaffer_recall_feedback() {
  local _fb_outcome="$1"
  [ "${DRY_RUN:-0}" = "1" ] && return 0
  [ -n "${RECALL_REPO_NAME:-}" ] && [ -n "${NUM:-}" ] || return 0
  # `lg` (factory.config.sh) runs the memory CLI with MEMORY_DB in the child env.
  declare -f lg >/dev/null 2>&1 || return 0
  if lg recall-feedback --repo "$RECALL_REPO_NAME" --ticket "$NUM" --outcome "$_fb_outcome" >/dev/null 2>&1; then
    log "memory: recall-feedback #$NUM → $_fb_outcome (served knowledge adjusted)"
  else
    log "memory: recall-feedback #$NUM ($_fb_outcome) failed — non-fatal, delivery unaffected"
  fi
}

# TICKET → LORE DISTILLATION AT CLOSE (Track 1c, live-path backport).
# A ticket's title + acceptance criteria carry the REAL product intent — WHY the
# work exists. At close that intent evaporates: the ticket is marked done and
# nothing durable captures it. This harvests it into a REQUIREMENT lore record
# so the "why" survives the ticket: a human-gated DRAFT by default, promoted ACTIVE
# only under MEMORY_AUTO_APPROVE=1 / GAFFER_MEMORY_AUTO_PROMOTE=1 (below). The text
# is rendered by crew — packages/crew/src/context/ticketIntent.ts::distillTicketIntent
# via runtime/context/distillIntentCli.js, the single source (edit it there). A
# ticket with NO non-blank acceptance criteria has nothing durable to harvest, so
# it is a no-op rather than drafting noise. (The optional DECISION draft the
# distiller can emit needs recorded decisions/reject-reasons, which the live close
# path does not carry, so the CLI emits only the requirement.)
# Best-effort + logged: a distill error NEVER affects delivery (already
# submitted). No-op under DRY_RUN, without the memory CLI or the crew build, or
# with no ticket/repo in scope.
gaffer_distill_ticket_intent() {
  [ "${DRY_RUN:-0}" = "1" ] && return 0
  [ -n "${NUM:-}" ] && [ -n "${RECALL_REPO_NAME:-}" ] || return 0
  declare -f lg >/dev/null 2>&1 || return 0
  [ -n "${SHOW:-}" ] || return 0

  # Build the requirement draft's {title, summary} from the ticket's title + AC.
  # The crew CLI emits ONE JSON line (or nothing when there is no AC). Fail-soft.
  local _distill _distill_cli="${CREW_DIR:-}/dist/runtime/context/distillIntentCli.js"
  if [ ! -f "$_distill_cli" ]; then
    log "memory: crew not built ($_distill_cli missing) — skipping the ticket-intent distillation for #$NUM"
    return 0
  fi
  _distill="$(SHOW="$SHOW" DTITLE="${TITLE:-}" DREPO="$RECALL_REPO_NAME" DNUM="$NUM" node "$_distill_cli" 2>/dev/null || true)"
  [ -n "$_distill" ] || return 0

  local _dt _ds
  _dt="$(printf '%s' "$_distill" | jget 'd.title' 2>/dev/null)" || return 0
  _ds="$(printf '%s' "$_distill" | jget 'd.summary' 2>/dev/null)" || return 0
  [ -n "$_dt" ] || return 0

  # ONCE PER TICKET. This runs on every submit, and a ticket that is reworked is
  # submitted again — so every rework cycle used to draft another copy of the same
  # requirement (and a ticket later rejected still left one). The ticket-<n> tag is
  # the provenance key: if memory already holds a record for this ticket (draft or
  # active), there is nothing new to harvest. Fail-soft: an unreadable lookup drafts
  # as before rather than silently skipping.
  local _existing
  # --no-record-reads: a bookkeeping lookup, not an agent retrieval — it must not
  # count as a read in `memory stats` (top-cited / retirement candidates).
  _existing="$(lg search --repo "$RECALL_REPO_NAME" --tag "ticket-$NUM" --include-drafts --no-record-reads --json 2>/dev/null \
    | jget 'Array.isArray(d) ? d.length : 0' 2>/dev/null || echo 0)"
  if [ "${_existing:-0}" != "0" ]; then
    log "memory: requirement for #$NUM already distilled (${_existing} record(s) tagged ticket-$NUM) — not drafting again"
    return 0
  fi

  # --title/--summary/--body all supplied ⇒ `suggest` never drops into an interactive
  # prompt. Suggest (draft) with an explicit kind so recall can later aim at the "why";
  # tags carry ticket provenance (ticket-<n>).
  #
  # AUTO-PROMOTE follows the memory gate. The distilled text is derived from the ticket
  # title + acceptance criteria — agent-influenceable inputs the factory otherwise treats
  # as untrusted — so landing it ACTIVE without review is exactly the cross-ticket memory
  # poisoning the draft gate exists to stop. Default: promote iff the operator has ALREADY
  # accepted agent-authored memory going live (MEMORY_AUTO_APPROVE=1 — on in the
  # autonomous/strict clusters, off in supervised/lite/graduated). Supervised runs land a
  # DRAFT for `memory review`; the PRODUCT CONTEXT primer surfaces only `active` lore, so
  # ratify the drafts you want priming future agents. GAFFER_MEMORY_AUTO_PROMOTE=1|0
  # overrides either way. The inline var applies only to this `lg` call.
  # Normalised through _gaffer_flag_on (1/true/yes/on), matching what Settings accepts, and
  # handed to the memory CLI as the exact "1"/"0" it reads.
  local _promote
  _promote="$(_gaffer_flag_on "${GAFFER_MEMORY_AUTO_PROMOTE:-${MEMORY_AUTO_APPROVE:-0}}" && echo 1 || echo 0)"
  if MEMORY_AUTO_APPROVE="$_promote" \
      lg suggest --title "$_dt" --summary "$_ds" --body "$_ds" \
      --repo "$RECALL_REPO_NAME" --kind requirement \
      --tag ticket-intent --tag requirement --tag "ticket-$NUM" \
      --author gaffer-distill >/dev/null 2>&1; then
    if [ "$_promote" = "1" ]; then
      log "memory: distilled requirement from #$NUM → ACTIVE (auto-promoted: memory auto-approve is on; GAFFER_MEMORY_AUTO_PROMOTE=0 to gate)"
    else
      log "memory: distilled requirement DRAFT from #$NUM (human-gated — \`memory review\` to ratify; GAFFER_MEMORY_AUTO_PROMOTE=1 to auto-promote)"
    fi
  else
    log "memory: distill #$NUM skipped/failed — non-fatal, delivery unaffected"
  fi
}

# ── Agent-review pass ── extracted to lib/review.sh (B-H3, monolith paydown).
# _gaffer_agent_review_pass is sourced at the top of this file and invoked at two
# sites below: the no_work juncture and the end-of-tick flow.

# ── MERGE LANE ── lib/merge-lane.sh. Land every ready_for_merge ticket the merge
# policy permits (human approve, tester PASS, a held gate since earned) BEFORE the
# candidate scan, so a merge frees its dependents in this same tick. Never exits.
declare -F _gaffer_merge_lane >/dev/null 2>&1 && _gaffer_merge_lane

# ── PAUSE-ON-CAP: resume-requested paused tickets take priority ──────────────
# A human pressed Continue on a paused (cap-hit) delivery: re-enter delivery IN THE
# EXISTING worktree (no new worktree, no re-clone, no lost context). The factory loop
# picks the OLDEST resume-requested paused ticket; the rest of the tick reuses the
# normal delivery machinery, guarded by _RESUMING so the worktree is REUSED (never
# reset) and the prompt is a short continuation. loop.sh's per-run skip-file still
# applies so a resume that fails this run isn't retried forever.
_RESUMING=0
RESUME_NUM=""
if [ "${GAFFER_PAUSE_ON_CAP:-1}" = "1" ]; then
  SKIP_FILE="$GAFFER_DATA/.failed-tickets"; touch "$SKIP_FILE"
  RESUME_NUM="$(wg ticket resume-requested 2>/dev/null | gaffer_json resume-pick "$SKIP_FILE" 2>/dev/null || echo '')"
  # A dry run previews a resume once per run, like a ready ticket.
  [ -n "$RESUME_NUM" ] && gaffer_dry_previewed "$RESUME_NUM" && RESUME_NUM=""
fi

# How many tickets are claimable? DISTINGUISH a real dispatch failure from a genuinely
# empty queue: `2>/dev/null || echo '[]'` would mask a missing `wg` / unreachable or
# corrupt DB as "no ready tickets", silently idling the WHOLE factory indefinitely
# behind a normal-looking no_work log. `wg ticket list` exits 0 on an empty list and
# non-zero only on a real error — so surface that as a VISIBLE tick error, not silence.
_ready_err="$(mktemp "${TMPDIR:-/tmp}/gaffer-ready.XXXXXX" 2>/dev/null || echo /tmp/gaffer-ready.$$)"
if ! READY_JSON="$(wg ticket list -s ready 2>"$_ready_err")"; then
  log "FATAL: 'wg ticket list -s ready' failed (dispatch unavailable / DB error) — NOT treating as an empty queue: $(tr '\n' ' ' <"$_ready_err" 2>/dev/null | cut -c1-300)"
  rm -f "$_ready_err" 2>/dev/null || true
  result error
  exit 1
fi
rm -f "$_ready_err" 2>/dev/null || true
READY_COUNT="$(echo "$READY_JSON" | jget 'd.length' 2>/dev/null || echo 0)"

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

if [ "$READY_COUNT" -gt 0 ]; then
  # PAUSE-ON-CAP: when resuming, NUM/SHOW/REPO_PATH/STACK/TITLE are already set (above)
  # and the ticket is in_progress — skip the ready-candidate scan entirely and go
  # straight to delivery in its existing worktree.
  if [ "$_RESUMING" != "1" ]; then
  # Skip tickets that already failed delivery THIS run so one bad ticket can't
  # starve the queue (otherwise the loop re-claims the same first ready ticket
  # forever). loop.sh clears the skip file at the start of a run.
  SKIP_FILE="$GAFFER_DATA/.failed-tickets"; touch "$SKIP_FILE"

  # ── Stabilisation gate 0: per-repo BACKPRESSURE (skip new claims) ───────────
  # Walk ready candidates (least-recently-failed first) and pick the FIRST whose
  # target repo is NOT in backpressure. A repo is in backpressure once its
  # ACTIVE outstanding work (unmerged gaffer/* branches — excluding branches
  # preserved by parked blocked/refining tickets and the candidate's own branch —
  # + in_review tickets + active claims) hits ANY per-repo cap; we then SKIP new
  # claims for it this tick so the loop never piles up more than the cap.
  # Backpressured repos are recorded in a
  # per-run file (cleared by loop.sh) for the run-summary report. With every ready
  # repo backpressured, the tick yields no_work and the loop prioritises
  # review/merge/cleanup elsewhere instead of claiming more.
  #
  # A-1: under GAFFER_CONCURRENCY>1 this is best-effort, last-writer-wins
  # telemetry (each tick records ITS snapshot of backpressured repos). The append
  # below is taken under .bp.lock so a concurrent worker never tears a half-written
  # line; the per-tick truncate is a single atomic syscall. At concurrency 1 there
  # is one writer so this is byte-identical to before.
  BP_FILE="$GAFFER_DATA/.backpressure-repos"; : > "$BP_FILE"
  NUM=""; SHOW=""; REPO_PATH=""; STACK=""; TITLE=""
  # SCHEDULER: walk CLAIMABLE work (every dependency done), so MAX_CANDIDATES bounds the
  # tickets a claim can take. Walking the raw ready list let 25 higher-priority dependants
  # of one low-priority prerequisite fill the limit every tick (each claim refused on the
  # unmet dependency) and the prerequisite never ran. A failed claimable listing falls
  # back to the full ready list (the previous walk), never to an empty queue.
  if _CLAIMABLE_JSON="$(wg ticket list -s ready --claimable 2>/dev/null)" \
     && [ -n "$(printf '%s' "$_CLAIMABLE_JSON" | jget 'Array.isArray(d) ? "1" : ""' 2>/dev/null)" ]; then
    CANDIDATES="$(echo "$_CLAIMABLE_JSON" | gaffer_json pick-unskipped "$SKIP_FILE" --all)"
  else
    log "candidate scan: the claimable listing failed — walking the full ready list"
    CANDIDATES="$(echo "$READY_JSON" | gaffer_json pick-unskipped "$SKIP_FILE" --all)"
  fi
  # DRY RUN: a ticket this run already previewed is not previewed again (loop.sh keeps
  # the list), so a preview pass shows each ready ticket once and then ends.
  if [ "${DRY_RUN:-0}" = "1" ] && [ -n "${GAFFER_DRY_PREVIEWED_FILE:-}" ] && [ -s "$GAFFER_DRY_PREVIEWED_FILE" ]; then
    CANDIDATES="$(printf '%s\n' "$CANDIDATES" | grep -vxF -f "$GAFFER_DRY_PREVIEWED_FILE" || true)"
  fi
  # A-1: bound the candidate scan. Each candidate costs a `ticket show` + pressure
  # probe; with a per-repo cap (MAX_CONCURRENT_TICKETS_PER_REPO) in force, a tick
  # may legitimately skip several capped repos before finding a free one, so the
  # walk must be allowed to continue PAST a skip — but never past MAX_CANDIDATES.
  _cand_seen=0
  while IFS= read -r _cand; do
    [ -n "$_cand" ] || continue
    _cand_seen=$((_cand_seen + 1))
    if [ "${MAX_CANDIDATES:-0}" -gt 0 ] 2>/dev/null && [ "$_cand_seen" -gt "$MAX_CANDIDATES" ]; then
      log "candidate scan hit MAX_CANDIDATES=$MAX_CANDIDATES without a claimable ticket — yielding"
      break
    fi
    _cshow="$(wg ticket show "$_cand" 2>/dev/null)"
    _crepo="$(echo "$_cshow" | jget '(((d.repositories||[]).find(r => r.access === "write" && r.local_path) || (d.repositories||[]).find(r => r.local_path) || (d.repositories||[])[0] || {}).local_path) || ""' 2>/dev/null)"
    _cdef="$(echo "$_cshow" | jget '(((d.repositories||[]).find(r => r.access === "write" && r.local_path) || (d.repositories||[]).find(r => r.local_path) || (d.repositories||[])[0] || {}).default_branch) || "main"' 2>/dev/null)"
    _cname="$(echo "$_cshow" | jget '(((d.repositories||[]).find(r => r.access === "write" && r.local_path) || (d.repositories||[]).find(r => r.local_path) || (d.repositories||[])[0] || {}).name) || ""' 2>/dev/null)"
    if [ -n "$_crepo" ] && git -C "$_crepo" rev-parse --git-dir >/dev/null 2>&1; then
      # Sweep genuinely-abandoned branches (POSITIVELY cancelled tickets with no
      # delivery record) first so they don't count against the cap. Parked
      # (blocked/refining) tickets' branches are PRESERVED by the sweep and are
      # instead excluded from the pressure count itself, and the candidate's own
      # preserved branch is bypassed (it gets reused, not added) — so parked work
      # never starves the repo. Then measure pressure.
      gaffer_sweep_abandoned_branches "$_crepo" "${_cdef:-main}" >/dev/null 2>&1 || true
      read -r _pb _pr _pc <<< "$(gaffer_repo_pressure "$_crepo" "${_cdef:-main}" "$_cname" "$_cand")"
      if gaffer_repo_in_backpressure "${_pb:-0}" "${_pr:-0}" "${_pc:-0}"; then
        _gaffer_locked .bp.lock _gaffer_bp_record "$BP_FILE" "${_cname:-$_crepo}" "$_pb/$_pr/$_pc" "$GAFFER_BACKPRESSURE_REASON"
        log "BACKPRESSURE: skipping ready #$_cand — repo '${_cname:-$_crepo}' at/over cap ($GAFFER_BACKPRESSURE_REASON)"
        continue
      fi
    fi
    # ── RUNNER-OWNED-BOOKKEEPING: claim the chosen candidate NOW ───────────────
    # Selection AND claim are one atomic step: the runner claims the ticket here,
    # BEFORE any worktree or agent, so the claim itself is the concurrency lock that
    # prevents two ticks from working the same ticket (Dispatch enforces one active
    # claim per ticket transactionally). If the claim fails (lost race / ineligible),
    # do NOT deliver — skip this candidate and keep scanning. DRY_RUN never claims
    # (it must stay side-effect-free). The captured token authorises the runner's
    # later submit and is injected into the agent's MCP env for its evidence writes.
    if [ "$DRY_RUN" != "1" ]; then
      _CLAIM_JSON="$(wg claim-ticket "$_cand" --agent "$AGENT" --ttl "$GAFFER_CLAIM_TTL" 2>/dev/null || true)"
      _CLAIM_TOK="$(printf '%s' "$_CLAIM_JSON" | jget 'd.claimToken ?? ""' 2>/dev/null || echo '')"
      if [ -z "$_CLAIM_TOK" ]; then
        log "candidate #$_cand — claim FAILED (lost race / ineligible); skipping and continuing the scan"
        continue
      fi
      CLAIM_TOKEN="$_CLAIM_TOK"
      log "claimed #$_cand for delivery (runner holds the claim; ttl=${GAFFER_CLAIM_TTL}s)"
      # CONTRACT FREEZE: a ready ticket's contract is editable until this claim, so a
      # person may have changed it since the scan read it. Re-read it now that it is
      # frozen, so the prompt carries the contract the review and the tester hold it to.
      _cshow_frozen="$(wg ticket show "$_cand" 2>/dev/null || true)"
      [ -n "$_cshow_frozen" ] && _cshow="$_cshow_frozen"
    fi
    NUM="$_cand"; SHOW="$_cshow"; REPO_PATH="$_crepo"
    STACK="$(echo "$_cshow" | jget '(((d.repositories||[]).find(r => r.access === "write" && r.local_path) || (d.repositories||[]).find(r => r.local_path) || (d.repositories||[])[0] || {}).stack) || ""' 2>/dev/null)"
    TITLE="$(echo "$_cshow" | jget 'd.ticket.title' 2>/dev/null)"
    break
  done <<< "$CANDIDATES"
  if [ -z "$NUM" ]; then
    if [ -s "$BP_FILE" ]; then
      log "all deliverable ready tickets are in repos under BACKPRESSURE — skipping new claims; prioritising review/merge/cleanup"
    elif [ -n "${_CLAIMABLE_JSON:-}" ] && [ "$(printf '%s' "$_CLAIMABLE_JSON" | jget 'Array.isArray(d) ? d.length : -1' 2>/dev/null)" = "0" ]; then
      log "every ready ticket waits on an unfinished dependency or an open blocking decision — nothing claimable this tick"
    elif [ "${DRY_RUN:-0}" = "1" ] && [ -s "${GAFFER_DRY_PREVIEWED_FILE:-/nonexistent}" ]; then
      log "DRY_RUN: every deliverable ready ticket has been previewed this run"
    else
      log "all ready tickets failed delivery this run — nothing deliverable"
    fi
    # BUGFIX (reviewer deadlock): ready tickets exist but none are deliverable
    # (e.g. all blocked by an unmet dependency whose blocker is itself in_review).
    # Run the agent-review pass here so the blocker can be approved/merged and the
    # chain unblocks; if it resolves a ticket it does `result reviewed; exit 0`,
    # otherwise control returns and the no_work exit below proceeds. No-op in
    # REVIEW_MODE=human (the guarded call is skipped), so supervised is unchanged.
    if [ "$REVIEW_MODE" = "agent" ] || [ "$REVIEW_MODE" = "both" ]; then
      _gaffer_agent_review_pass
    fi
    # The SAME deadlock one lane further: the blocker may be in_testing (approved,
    # waiting for the independent tester). Without this the tester ran only in the
    # end-of-tick flow, which this branch never reaches, so a queue whose every ready
    # ticket depends on an in_testing one stalled until the loop gave up on empty
    # polls (seen live). Exits the tick when it tests one; otherwise falls through.
    declare -F _gaffer_tester_pass >/dev/null 2>&1 && _gaffer_tester_pass
    result no_work; exit 0
  fi
  fi   # end: ready-candidate scan (skipped when _RESUMING=1)

  # ── Greenfield "create-a-repo" delivery mode (bootstrap tickets) ────────────
  # A bootstrap ticket (dispatch ticket.bootstrap == 1) has NO repo to branch.
  # Instead of the worktree flow below, the runner CREATES the repo: derive the
  # target path under GAFFER_BOOTSTRAP_ROOT, refuse a non-empty existing dir,
  # mkdir + git init, run the delivery agent IN the new dir (with the scoped
  # bootstrap install allowance), apply the SAME hygiene gate, record the
  # smallest-change note, then register + onboard the new repo so the now-done
  # bootstrap unblocks its dependent feature tickets. The oversized minimalism
  # HARD-fail is EXEMPTED for bootstrap (a fresh scaffold is legitimately larger)
  # — the note is still required and recorded, oversized is flagged not failed.
  IS_BOOTSTRAP="$(echo "$SHOW" | jget '[1, true].includes(d.ticket.bootstrap) ? 1 : 0' 2>/dev/null || echo 0)"
  # ACCEPTANCE GATE: the epic's build-level acceptance ticket (lib/acceptance.sh) — a
  # normal delivery on the integrated default branch, with an acceptance prompt block.
  IS_ACCEPTANCE="$(echo "$SHOW" | jget '[1, true].includes(d.ticket.acceptance) ? 1 : 0' 2>/dev/null || echo 0)"
  # A resume always re-enters the worktree delivery flow (pause-on-cap only fires in
  # the normal delivery path, never bootstrap), so never route a resume through the
  # create-a-repo bootstrap branch.
  [ "$_RESUMING" = "1" ] && IS_BOOTSTRAP=0
  # WASTE CONTROL — a bootstrap REWORK is a normal delivery. Once the scaffold has
  # been reviewed the repo IS registered (the bootstrap path onboarded it and linked
  # the ticket), so a CHANGES verdict must re-enter the worktree flow: the existing
  # gaffer/ticket-N-… branch is reused with its commits, the prompt carries the
  # reviewer's feedback, and the gates run against the registered repo. The
  # create-a-repo path has no feedback block at all — a live run sent the agent back
  # into it blind, paying for a second scaffold pass that could not know what the
  # reviewer had asked for.
  if [ "$IS_BOOTSTRAP" = "1" ] && [ -n "${REPO_PATH:-}" ] && git -C "$REPO_PATH" rev-parse --git-dir >/dev/null 2>&1; then
    log "BOOTSTRAP #$NUM: repo already registered at $REPO_PATH — rework runs as a normal delivery on the existing branch (reviewer feedback carried)"
    IS_BOOTSTRAP=0
  fi
  if [ "$IS_BOOTSTRAP" = "1" ]; then
    B_NAME="$(gaffer_bootstrap_repo_name "$SHOW")"
    if [ -z "$B_NAME" ]; then
      log "BOOTSTRAP: #$NUM is marked bootstrap but no target repo name could be derived — leaving for a human"
      gaffer_release_delivery ready "bootstrap: no target repo name — leaving for a human"
      gaffer_skip_ticket "$NUM"; result error; exit 0
    fi
    B_DIR="$(gaffer_bootstrap_repo_dir "$B_NAME")" || B_DIR=""
    if [ -z "$B_DIR" ]; then
      log "BOOTSTRAP: #$NUM target repo name '$B_NAME' is unsafe (path traversal) — refusing"
      gaffer_release_delivery ready "bootstrap: unsafe target repo name — refusing"
      gaffer_skip_ticket "$NUM"; result error; exit 0
    fi
    # SELF-OPERATION BAN (greenfield): a bootstrap target that would land IN a
    # Gaffer component must be refused too — same override, same set-aside.
    if [ "${GAFFER_ALLOW_SELF_DELIVERY:-0}" != "1" ] && gaffer_is_self_target "$B_DIR"; then
      log "SELF-OP: refusing bootstrap #$NUM — target '$B_DIR' is (or is inside) a Gaffer component; the factory must not scaffold over its own source. Set GAFFER_ALLOW_SELF_DELIVERY=1 to override (first-party dogfooding only)."
      wg attach-evidence "$NUM" --type manual_note \
        --summary "SELF-OP BAN: refused bootstrap — target '$B_DIR' is a Gaffer component (factory's own source). Override with GAFFER_ALLOW_SELF_DELIVERY=1." >/dev/null 2>&1 || true
      # RUNNER-OWNED-BOOKKEEPING: the runner holds the claim now, so release it first
      # (claimed → ready), THEN un-ready (ready -> draft) so the loop won't re-select it.
      gaffer_release_delivery ready "self-op: bootstrap target is a Gaffer component"
      wg ticket move "$NUM" draft --as system >/dev/null 2>&1 || true
      gaffer_skip_ticket "$NUM"
      log "SELF-OP: set aside bootstrap #$NUM for a human (released claim + un-readied ready→draft + skipped this run)"
      result no_work; exit 0
    fi
    if ! B_REFUSE="$(gaffer_bootstrap_target_ok "$B_DIR")"; then
      log "BOOTSTRAP: #$NUM refused — $B_REFUSE"
      wg attach-evidence "$NUM" --type manual_note \
        --summary "BOOTSTRAP REFUSED: $B_REFUSE" >/dev/null 2>&1 || true
      gaffer_release_delivery ready "bootstrap refused: $B_REFUSE"
      gaffer_skip_ticket "$NUM"; result error; exit 0
    fi
    log "ready=$READY_COUNT → BOOTSTRAP #$NUM ('$TITLE') → create new repo '$B_NAME' at $B_DIR [stack=$STACK]"

    # Recommended skills for the bootstrap: the BOOTSTRAP ROLE profile (`--role
    # bootstrap`) — the normal delivery selection plus the scaffold packs a fresh repo
    # needs (ci-cd-pipeline, docker-development, shell-scripting, the quality lens). A
    # greenfield agent used to get the plain delivery selection, so CI / Docker guidance
    # only reached it when the brief happened to name them.
    # Derive an area from the stack where unambiguous so area-gated packs (FIX-2)
    # still fire for a clearly-domained stack (e.g. a web stack → frontend pack).
    # B30: hand the selector the ticket's title + description head too (`--text`),
    # exactly as the delivery path does — a bootstrap brief that plainly calls for
    # an off-domain pack (a CLI tool, a Terraform module, a docs site) was otherwise
    # unreachable, since the bootstrap passed no text and matched on stack alone.
    # An argv, never a shell string: the untrusted text cannot inject flags.
    B_AREA="$(gaffer_area_for_stack "$STACK")"
    _B_SKILL_TEXT="$(printf '%s\n%s' "${TITLE:-}" "$(echo "$SHOW" | jget '(d.ticket.description || "").slice(0, 600)' 2>/dev/null || true)")"
    B_SKILLS="$(node "$HERE/bin/select-skills.mjs" --role bootstrap --stack "$STACK" ${B_AREA:+--area "$B_AREA"} --text "$_B_SKILL_TEXT" --skills-dir "$SKILLS_DIR" 2>/dev/null || true)"
    [ -n "$B_SKILLS" ] || B_SKILLS="(scaffold the stack from the ticket's ACs)"

    if [ "$DRY_RUN" = "1" ]; then
      log "DRY_RUN: BOOTSTRAP would mkdir + git init $B_DIR with a baseline README commit on main, then branch gaffer/ticket-$NUM-<slug> and run the delivery agent there to scaffold the stack ON THE BRANCH"
      log "DRY_RUN: BOOTSTRAP would export GAFFER_BOOTSTRAP_INSTALL=1 GAFFER_BOOTSTRAP_DIR=$B_DIR so the safety hook permits the FIRST install in the fresh dir only"
      log "DRY_RUN: BOOTSTRAP would assert delivery hygiene (oversized minimalism EXEMPTED for a fresh scaffold), record the smallest-change note, record the delivery branch_name, then register+onboard $B_NAME + submit via the NORMAL claim-gated lane (→ in_review)"
      result worked; exit 0
    fi

    # Fail closed: never run a live agent without the deterministic safety hook.
    gaffer_assert_safety_hook || gaffer_abort_setup SAFETY "refusing live bootstrap (fail closed)"

    # EXECUTION PREFLIGHT (lib/registry-probe.sh): the bootstrap's one permitted
    # install needs the package registry from INSIDE the agent's allowlisted env.
    # Probe it there first — bounded, no model call. A dead registry used to surface
    # only as the agent's npm retrying TLS failures until the 30-min tick timeout,
    # parked as a generic "timeout" (seen live). Clearly non-node stacks skip it.
    case "$(printf '%s' "${STACK:-}" | tr '[:upper:]' '[:lower:]')" in
      python*|go|golang|rust|java|kotlin|ruby|dotnet|csharp|php|elixir|swift|c|cpp|terraform|shell|bash) ;;
      *)
        if declare -F gaffer_registry_probe >/dev/null 2>&1; then
          _PROBE_RC=0; gaffer_registry_probe || _PROBE_RC=$?
          if [ "$_PROBE_RC" -eq 1 ]; then
            _PROBE_WHY="environment: the npm registry is unreachable from the agent env (${GAFFER_REGISTRY_PROBE_CODE:-unknown}) — $(gaffer_registry_probe_hint "${GAFFER_REGISTRY_PROBE_CODE:-}"). No model call was spent; fix the environment (runner/preflight.sh runs the same probe) and move #$NUM back to ready."
            log "BOOTSTRAP: #$NUM parked before spawning — $_PROBE_WHY${GAFFER_REGISTRY_PROBE_DETAIL:+ [$GAFFER_REGISTRY_PROBE_DETAIL]}"
            wg attach-evidence "$NUM" --type manual_note \
              --summary "ENVIRONMENT: $_PROBE_WHY" >/dev/null 2>&1 || true
            gaffer_release_delivery blocked "$_PROBE_WHY" env_registry_unreachable
            gaffer_skip_ticket "$NUM"; result error; exit 0
          fi
        fi ;;
    esac

    # Create + init the new repo dir WITH a baseline README commit on `main` (repo
    # display name + the ticket's intent). A failure here leaves no half-made repo.
    if ! gaffer_bootstrap_init "$B_DIR" "$B_NAME" "$TITLE"; then
      log "BOOTSTRAP: #$NUM could not mkdir/git-init $B_DIR — failing"
      gaffer_skip_ticket "$NUM"; result error; exit 0
    fi

    # Capture the repo's DEFAULT branch (`main`, where the baseline lives) from the
    # freshly-baselined repo — used as the onboard branch + the diff/review base.
    # gaffer_bootstrap_base_branch reads `symbolic-ref --short HEAD` (a clean "main",
    # never the "HEAD\nmain" garbage `rev-parse --abbrev-ref … || echo main` yields on an
    # unborn repo — see the greenfield E2E regression test) — captured HERE, BEFORE we
    # branch off below — and on a RESUME, where HEAD is already the prior attempt's
    # gaffer/ticket-N-… branch, resolves the real base (main) instead of the delivery
    # branch itself (which made the scaffold check below compare HEAD with HEAD and
    # park a complete scaffold as "no scaffold commit").
    B_DEFAULT_BRANCH="$(gaffer_bootstrap_base_branch "$B_DIR")"
    # DELIVER LIKE EVERY OTHER TICKET: create + check out the SAME `gaffer/ticket-N-<slug>`
    # branch shape a normal delivery uses (shared gaffer_ticket_slug), so the scaffold
    # lands on a branch the agent reviewer can diff against `main` and auto-approve+merge
    # — NOT straight onto `main` (which left the reviewer with no branch to review). -B is
    # idempotent on a resume (re-points the branch at the baseline). The agent then commits
    # on the current branch (its prompt already says "commit on the current branch").
    B_SLUG="$(gaffer_ticket_slug "$TITLE")"
    B_WORK_BRANCH="gaffer/ticket-$NUM-$B_SLUG"
    # WASTE CONTROL: on a RESUME the branch may already carry a prior attempt's scaffold
    # commits (auto-committed or the agent's own). `checkout -B` re-points it at HEAD
    # (main after the post-onboard checkout) and silently discards them — a live run
    # lost a complete scaffold that way and paid for it again. Re-enter the existing
    # branch unless GAFFER_RETRY_FRESH_BRANCH=1 asks for the clean-slate reset.
    _B_KEPT=0
    if [ "${GAFFER_RETRY_FRESH_BRANCH:-0}" != "1" ] \
       && git -C "$B_DIR" rev-parse --verify -q "refs/heads/$B_WORK_BRANCH" >/dev/null 2>&1; then
      _B_KEPT="$(git -C "$B_DIR" rev-list --count "$B_DEFAULT_BRANCH..$B_WORK_BRANCH" 2>/dev/null || echo 0)"
    fi
    if [ "${_B_KEPT:-0}" -gt 0 ] 2>/dev/null && git -C "$B_DIR" checkout "$B_WORK_BRANCH" >/dev/null 2>&1; then
      log "BOOTSTRAP #$NUM: re-entered EXISTING branch $B_WORK_BRANCH — $_B_KEPT prior commit(s) kept (set GAFFER_RETRY_FRESH_BRANCH=1 for a clean-slate retry)"
    elif ! git -C "$B_DIR" checkout -B "$B_WORK_BRANCH" >/dev/null 2>&1; then
      log "BOOTSTRAP: #$NUM could not create delivery branch $B_WORK_BRANCH — failing"
      gaffer_skip_ticket "$NUM"; result error; exit 0
    fi

    # Install the project-local config (skills, settings+hook, CLAUDE brief, MCP)
    # into the NEW repo — identical mechanics to normal delivery, just rooted at
    # the fresh dir (which IS the single write-root for this run).
    # Mount ONLY the selected (B_SKILLS) + universal skill subset — not the whole
    # library — so Claude Code doesn't auto-load all ~66 frontmatter blocks.
    # Fail-soft: falls back to the whole library on any error (see skills-mount.sh).
    # The ONE shared installer (lib/agent-env.sh) every other spawn site uses:
    # skills mount + render AND VERIFY .claude/settings.json (the PreToolUse
    # safety-hook wiring) + workspace trust + the CLAUDE.factory.md brief. This site
    # used to render the settings with a bare `sed` and no verification, so a bad
    # template or a full disk could launch the bootstrap agent — the one agent that
    # is also allowed a dependency install — with no deterministic containment
    # boundary. FAIL CLOSED: release the claim back to ready (the scaffold resumes on
    # the next attempt), skip the ticket this run, and never spawn.
    if ! gaffer_install_agent_dir "$B_DIR" "$B_SKILLS" "bootstrap-$NUM"; then
      gaffer_abort_setup SAFETY "agent-env install failed for bootstrap #$NUM (settings/hook wiring unverified) — refusing live bootstrap (fail closed)"
    fi
    MCP_RUNTIME="$GAFFER_DATA/mcp-runtime.$$.json"
    gaffer_assert_db_vars || gaffer_abort_setup DB-VARS "DISPATCH_DB/MEMORY_DB empty — refusing live bootstrap (fail closed)"
    # RUNNER-OWNED-BOOKKEEPING: inject the runner-held claim token into the dispatch
    # MCP server env so the agent's evidence writes resolve it without ever handling
    # the token string. Substituted alongside the DB/bin placeholders.
    #
    # MEMORY-SCOPE BINDING: a bootstrap ticket has exactly one target repo — the
    # fresh repo being scaffolded ($B_NAME) — so that is the sole in-scope name
    # bound into ${GAFFER_TICKET_REPOS}. Paired with GAFFER_FACTORY=1 (template
    # literal) it lets the memory server refuse a direct-apply write against any
    # OTHER repo. (The main-delivery twin at the live run derives this from WT_ROWS.)
    GAFFER_TICKET_REPOS="$B_NAME"
    # CARD-CANONICAL BINDING (see the main-delivery twin): the one fresh repo.
    # shellcheck disable=SC2034  # read by gaffer_render_mcp_runtime (factory.config.sh)
    GAFFER_REPO_CANONICALS="$(printf '%s\t%s\n' "$B_NAME" "$B_DIR" | gaffer_repo_canonicals_json)"
    # MEMORY ROI: a bootstrap has no delivery-recall context, so ${GAFFER_RECALL_TICKET}
    # renders empty — the memory read path then logs no retrieval (inert), matching
    # the standalone posture. The main-delivery twin sets it to the ticket $NUM.
    # Render via the single seam (factory.config.sh → packages/crew renderMcpCli.js).
    # Recall is empty for a bootstrap (no delivery-recall context ⇒ memory read inert).
    # Fail-closed: a render error (ts renderer rejects a broken/drifted template)
    # must abort the bootstrap before the agent launch — the bare sed never did.
    # FACTORY TICKET SCOPE: the scope ticket ($NUM, rendered into the dispatch server's
    # GAFFER_SCOPE_TICKET) makes the server refuse this agent's writes on any OTHER
    # ticket (it does not depend on the claim token alone, which is empty on a resume).
    gaffer_render_mcp_runtime "$MCP_CONFIG" "$MCP_RUNTIME" "" "$NUM" \
      || gaffer_abort_setup MCP-RENDER "failed to render bootstrap runtime .mcp.json — refusing live bootstrap (fail closed)"
    chmod 600 "$MCP_RUNTIME" 2>/dev/null || true  # carries the live claim token — owner-only
    gaffer_exclude_runner_config "$B_DIR"   # keep runner config out of `git add -A`

    # The prompt text (and the title's quarantine envelope) is rendered by crew:
    # packages/crew/src/runtime/context/deliveryPrompt.ts via renderPromptCli.js.
    B_PROMPT="$(gaffer_render_delivery_prompt bootstrap)" \
      || gaffer_abort_setup PROMPT-RENDER "failed to render bootstrap prompt for #$NUM — refusing live bootstrap (fail closed)"

    RUN_LOG_MARK="$(wc -l < "$GAFFER_LOG" 2>/dev/null || echo 0)"
    # The scoped install allowance: GAFFER_BOOTSTRAP_INSTALL=1 + GAFFER_BOOTSTRAP_DIR
    # are exported ONLY for this bootstrap invocation, so the safety hook permits
    # exactly the first install inside $B_DIR. GAFFER_WRITE_ROOTS is the new repo.
    # npm_config_ignore_scripts=true is an env-level kill switch so even the ONE
    # permitted bootstrap install cannot run dependency lifecycle scripts
    # (postinstall ACE) — belt-and-braces with the safety hook's --ignore-scripts
    # requirement. Per-call resource caps (gaffer_timeout + --max-turns) bound the
    # wall-clock and token spend of this headless call.
    # USAGE LEDGER: capture --output-format json stdout for the ledger; stderr →
    # log; agent's `.result` text appended to the log below (preserves the log).
    B_USAGE_JSON="$GAFFER_DATA/.usage-$NUM.json"; : > "$B_USAGE_JSON"
    # C1/M2: strip ambient credentials from the live agent's env (allowlist via
    # env -i) — done inside worker_deliver. The per-call boundary/install vars in
    # WORKER_CALL_ENV are layered on top of the allowlist so they win.
    WORKER_CALL_ENV=(
      "GAFFER_WRITE_ROOTS=$B_DIR" "GAFFER_READ_ROOTS="
      "GAFFER_BOOTSTRAP_INSTALL=1" "GAFFER_BOOTSTRAP_DIR=$B_DIR"
      "npm_config_ignore_scripts=true"
      "DISPATCH_DB=$DISPATCH_DB" "MEMORY_DB=$MEMORY_DB"
    )
    _B_SKILL_SINCE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    GAFFER_LAUNCH_KIND=bootstrap worker_deliver "$B_DIR" "$B_PROMPT" "$GAFFER_IMPL_MODEL_FLAG" "$MCP_RUNTIME" "$B_USAGE_JSON"
    brc=$?
    gaffer_usage_record bootstrap "$NUM" "$brc" "$B_USAGE_JSON" >>"$GAFFER_LOG" 2>/dev/null || true
    gaffer_record_skill_usage "$NUM" bootstrap "$STACK" "$B_SKILLS" "$B_USAGE_JSON" \
      "bootstrap-$NUM" "$B_DIR" "$_B_SKILL_SINCE"
    # USAGE WINDOW: a bootstrap refused by the plan's usage window / a rate limit is not
    # a failed scaffold (same rc 0/1/2 contract as the delivery path below). Record the
    # pause, release the claim to `ready` without parking it for a human, and keep the
    # partial scaffold: the dir stays a resumable bootstrap target for the retry.
    _B_UL_REC="$(gaffer_usage_pause_record "$B_USAGE_JSON" "$NUM" bootstrap)"; _B_UL_RC=$?
    rm -f "$B_USAGE_JSON"
    log "bootstrap delivery for #$NUM finished (rc=$brc)"
    if [ "$_B_UL_RC" != 1 ]; then
      _UL_UNTIL=""; _UL_MSG=""
      IFS=$'\t' read -r _ _UL_UNTIL _ _ _UL_MSG <<<"$_B_UL_REC"
      _UL_LINE="$(gaffer_usage_pause_active || echo "paused: usage limit")"
      gaffer_release_delivery ready \
        "usage limit: ${_UL_MSG:-refused by the usage window}; ${_UL_LINE}; not counted as an attempt (scaffold kept at $B_DIR)" \
        usage_limit "" "" "$_UL_UNTIL"
      if [ "$_B_UL_RC" != 0 ]; then
        gaffer_skip_ticket "$NUM"   # FAIL CLOSED: no pause written, so do not re-claim it this run
        log "USAGE: WARNING — bootstrap #$NUM was refused by a usage/rate limit but the pause could not be written under $GAFFER_DATA; skipping the ticket for the rest of this run"
      fi
      log "USAGE: bootstrap #$NUM refused by the model's usage window (${_UL_MSG:-usage limit}) — released to ready, scaffold kept at $B_DIR; $_UL_LINE"
      result usage_paused; exit 0
    fi
    if [ "$brc" -ne 0 ]; then
      # FINDING-12: park bootstrap failures to the VISIBLE `blocked` column (event +
      # attention count in status.sh / the human queue) — `refining` hid them from
      # selection, clarify, status and the human queue.
      gaffer_release_delivery blocked "bootstrap failed (rc=$brc) — scaffold left at $B_DIR for inspection" bootstrap_failed
      gaffer_skip_ticket "$NUM"
      log "BOOTSTRAP FAILED for #$NUM (rc=$brc) — leaving $B_DIR for inspection; not onboarding"
      result error; exit 0
    fi

    # WASTE CONTROL: the bootstrap agent often writes the whole scaffold and stops
    # without `git commit` (the delivery path has auto-committed that case for a long
    # time; the bootstrap path parked it as "no scaffold commit" and threw the work
    # away — a live run lost a complete four-minute scaffold that way). Commit the
    # uncommitted scaffold first, exactly like the delivery path.
    if gaffer_autocommit_dir "$B_DIR" "deliver #$NUM: $TITLE (scaffold; agent had not committed)"; then
      log "BOOTSTRAP #$NUM: auto-committed the uncommitted scaffold (agent edited but did not commit)"
    fi
    # Empty delivery: the scaffold must add at least one commit ON TOP of the README
    # baseline. The delivery branch HEAD identical to the baseline `main` ⇒ the agent
    # produced nothing to onboard (a bare baseline is not a scaffold).
    if [ "$(git -C "$B_DIR" rev-parse HEAD 2>/dev/null)" = "$(git -C "$B_DIR" rev-parse "$B_DEFAULT_BRANCH" 2>/dev/null)" ]; then
      log "BOOTSTRAP #$NUM produced no scaffold commit (branch == baseline) — parking (no scaffold to onboard)"
      wg attach-evidence "$NUM" --type manual_note \
        --summary "PARKED: bootstrap produced no scaffold commit beyond the baseline — needs clarification" >/dev/null 2>&1 || true
      # FINDING-12: VISIBLE park (see the rc-failure park above).
      gaffer_release_delivery blocked "bootstrap produced no initial commit" bootstrap_failed
      gaffer_skip_ticket "$NUM"; result error; exit 0
    fi

    # ── Hygiene gate (HARD FAIL) — same assertions as normal delivery, run on the
    # initial-commit tree (diff vs the empty tree). Catches a leaked events log,
    # broken symlinks, etc. node_modules added by the install is NOT a hygiene
    # violation for a bootstrap (it is expected), so we relax ONLY the node_modules
    # fragment — all other forbidden paths (.crew/, *.events.jsonl, .claude/,
    # CLAUDE.factory.md, .mcp.json, mcp-runtime) remain forbidden.
    # BUG 3 fix: previously used HYGIENE_FORBIDDEN_PATHS='.crew/ *.events.jsonl'
    # which silently exempted .claude/, CLAUDE.factory.md, .mcp.json and
    # mcp-runtime. Now we build the relaxed list by taking the full default
    # and removing only the node_modules fragment. (The `mcp-runtime.` fragment —
    # trailing dot, finding 11 — covers the generated `mcp-runtime.json` /
    # per-tick `mcp-runtime.<pid>.json` files without rejecting a legit
    # `src/mcp-runtime/` source dir.)
    EMPTY_TREE="$(git -C "$B_DIR" hash-object -t tree /dev/null 2>/dev/null || echo 4b825dc642cb6eb9a060e54bf8d69288fbee4904)"
    _BOOTSTRAP_HYGIENE_PATHS="$(printf '%s\n' ${HYGIENE_FORBIDDEN_PATHS:-node_modules .crew/ *.events.jsonl .claude/ CLAUDE.factory.md .mcp.json mcp-runtime.} | grep -v '^node_modules$' | tr '\n' ' ')"
    B_HYGIENE="$(HYGIENE_FORBIDDEN_PATHS="$_BOOTSTRAP_HYGIENE_PATHS" \
                 gaffer_assert_clean_delivery "$B_DIR" "$EMPTY_TREE" 2>/dev/null)" || true
    if [ -n "$B_HYGIENE" ]; then
      log "BOOTSTRAP HYGIENE: #$NUM scaffold is NOT hygienic:"$'\n'"$B_HYGIENE"
      if [ "${HYGIENE_ENFORCE:-1}" = "1" ]; then
        wg attach-evidence "$NUM" --type manual_note \
          --summary "PARKED: bootstrap hygiene violation (not onboarded):"$'\n'"$B_HYGIENE" >/dev/null 2>&1 || true
        # FINDING-12: VISIBLE park (see the rc-failure park above).
        gaffer_release_delivery blocked "bootstrap hygiene: $(printf '%s' "$B_HYGIENE" | tr '\n' ' ')" bootstrap_failed
        gaffer_skip_ticket "$NUM"
        log "BOOTSTRAP FAILED for #$NUM — hygiene violation; not onboarding"
        result error; exit 0
      else
        log "HYGIENE_ENFORCE=0 — logging the bootstrap hygiene violation but not failing"
      fi
    fi

    # ── Minimalism note: REQUIRED (same as normal delivery) but oversized is
    # EXEMPT for a bootstrap — a fresh scaffold is legitimately large. A missing
    # smallest-change note still FAILS; an oversized scaffold is FLAGGED only.
    # Stats are the scaffold vs the BASELINE branch (what the reviewer diffs): the
    # empty tree is not a commit, so `<empty-tree>...HEAD` has no merge base and the
    # stat silently read "0 files / 0 lines" for every bootstrap.
    read -r _BMZ_FILES _BMZ_LINES <<< "$(gaffer_diff_stats "$B_DIR" "$B_DEFAULT_BRANCH")"
    _BMZ_NOTE="$(wg ticket show "$NUM" 2>/dev/null | gaffer_json smallest-change-note 2>/dev/null || echo '')"
    _BMZ_TRIM="$(printf '%s' "$_BMZ_NOTE" | tr -d '[:space:]')"
    if [ -z "$_BMZ_TRIM" ]; then
      # A greenfield bootstrap creates a repo FROM THE EMPTY TREE — there is no
      # pre-existing code to make a "smallest change" against, so a smallest-change note
      # (a meaningful gate for FEATURE edits) is contradictory here, and being
      # agent-authored it is flaky run-to-run (a valid scaffold otherwise gets parked on
      # a missing note, stranding the whole epic). Consistent with the oversized
      # exemption below — a fresh scaffold is legitimately large — FLAG a missing note
      # for human review, never FAIL the bootstrap on it.
      log "BOOTSTRAP MINIMALISM: #$NUM has no smallest-change note — EXEMPT (fresh scaffold); flagging not failing ($_BMZ_FILES files / $_BMZ_LINES lines)"
      wg attach-evidence "$NUM" --type manual_note \
        --summary "needs_human_review: bootstrap has no smallest-change note (${_BMZ_FILES} files / ${_BMZ_LINES} lines) — exempt from minimalism hard-fail (greenfield scaffold)" >/dev/null 2>&1 || true
    else
      # Note present. Oversized is EXEMPT for bootstrap — flag visibly, never fail.
      if { [ "${OVERSIZED_MAX_LINES:-400}" -gt 0 ] && [ "${_BMZ_LINES:-0}" -gt "${OVERSIZED_MAX_LINES:-400}" ]; } \
         || { [ "${OVERSIZED_MAX_FILES:-12}" -gt 0 ] && [ "${_BMZ_FILES:-0}" -gt "${OVERSIZED_MAX_FILES:-12}" ]; }; then
        log "BOOTSTRAP MINIMALISM: #$NUM scaffold is oversized ($_BMZ_FILES files / $_BMZ_LINES lines) — EXEMPT (fresh scaffold); flagging not failing"
        wg attach-evidence "$NUM" --type manual_note \
          --summary "needs_human_review: oversized bootstrap scaffold (${_BMZ_FILES} files / ${_BMZ_LINES} lines) — exempt from minimalism hard-fail" >/dev/null 2>&1 || true
      else
        log "BOOTSTRAP MINIMALISM: #$NUM within caps ($_BMZ_FILES files / $_BMZ_LINES lines)"
      fi
    fi

    # ── Register + onboard the new repo so the now-done bootstrap unblocks the
    # dependent feature tickets (which target it via the normal worktree flow).
    if gaffer_bootstrap_onboard "$NUM" "$B_NAME" "$B_DIR" "$STACK" "" "$B_DEFAULT_BRANCH"; then
      log "BOOTSTRAP: registered + onboarded new repo '$B_NAME' ($B_DIR) into the factory"
      # FIX-BRANCH invariant: the delivery branch $B_WORK_BRANCH is about to become
      # review-visible via the records below. Raise the branch-retention flag FIRST —
      # strictly BEFORE any delivery record — so no later crash/signal can drop a
      # review-worthy branch (matches the normal-delivery ordering). The bootstrap holds
      # no throwaway worktree, so at runtime this is a no-op belt-and-braces.
      GAFFER_KEEP_DELIVERY_BRANCH=1
      # Link the new repo to the bootstrap ticket + record the delivery so the
      # done-gate/reviewer can resolve it (best-effort, non-fatal).
      wg repo link "$NUM" "$B_NAME" --as system >/dev/null 2>&1 ||
        log "BOOTSTRAP: repo link #$NUM ↔ $B_NAME did not record (non-fatal)"
      # Record the delivery on the NORMAL lane: the diff is the scaffold delta on TOP of
      # the README baseline (main..branch — exactly what the reviewer diffs), and the
      # persisted branch_name is the `gaffer/ticket-N-<slug>` DELIVERY branch (NOT `main`),
      # so the reviewer resolves `d['ticket']['branch_name']`, worktrees the branch, diffs
      # it vs `main`, and can auto-approve+merge — no more "no delivery branch recorded".
      B_DIFFSTAT="$(git -C "$B_DIR" diff "$B_DEFAULT_BRANCH".."$B_WORK_BRANCH" --stat 2>/dev/null | tail -15)"
      B_HEAD_SHA="$(git -C "$B_DIR" rev-parse "$B_WORK_BRANCH" 2>/dev/null || echo '')"
      wg attach-evidence "$NUM" --type diff_summary \
        --summary "Bootstrapped new repo $B_NAME at $B_DIR — delivered on branch $B_WORK_BRANCH (base $B_DEFAULT_BRANCH)"$'\n'"$B_DIFFSTAT" >/dev/null 2>&1 ||
        log "BOOTSTRAP: diff_summary evidence for #$NUM did not record (non-fatal)"
      wg delivery-artifact "$NUM" --branch "$B_WORK_BRANCH" --diff "$B_DIFFSTAT" --as system >/dev/null 2>&1 ||
        log "BOOTSTRAP: delivery-artifact for #$NUM did not record (non-fatal)"
      # Per-repo delivery record (WG-005 parity with the normal lane): the done-gate /
      # reviewer see a review_ready delivery for the new repo on the delivery branch.
      # This row is LOAD-BEARING (the done-gate resolves the delivery from it), so a
      # failure must be visible, never silently swallowed.
      B_SHA_ARG=""; [ -n "$B_HEAD_SHA" ] && B_SHA_ARG="--commit $B_HEAD_SHA"
      # LOAD-BEARING: the done-gate resolves the delivery from this row. If it does not
      # record, submitting anyway strands the ticket in `in_review` forever (the gate can
      # never resolve) while the operator is told bootstrap succeeded. So on failure we
      # surface the real error, park → refining (blocks blind reclaim), skip, and fail the
      # tick for a human handoff — NEVER fall through to gaffer_submit_delivery.
      _B_RD_ERR="$GAFFER_DATA/.bootstrap-rd-err.$$"
      if ! wg ticket repo-delivery record "$NUM" "$B_NAME" --branch "$B_WORK_BRANCH" $B_SHA_ARG --status review_ready --as system 2>"$_B_RD_ERR"; then
        log "BOOTSTRAP: per-repo delivery record for #$NUM ($B_NAME) FAILED — done-gate cannot resolve this delivery; parking → blocked (NOT submitting): $(head -c 400 "$_B_RD_ERR" 2>/dev/null | tr '\n' ' ')"
        rm -f "$_B_RD_ERR"
        # Park VISIBLY to `blocked` (pages a human via the attention count), never
        # `refining` (invisible to every human surface), matching the other bootstrap
        # failure parks. Do NOT fall through to gaffer_submit_delivery: a submit without
        # this load-bearing row strands the ticket in `in_review` forever.
        gaffer_release_delivery blocked "bootstrap per-repo delivery record failed for #$NUM ($B_NAME) — the done-gate cannot resolve this delivery; record it manually before submitting" bootstrap_failed
        gaffer_skip_ticket "$NUM"
        result error; exit 0
      fi
      rm -f "$_B_RD_ERR"
      # Rest the new repo's PRIMARY working tree back on its default branch (`main`), so
      # the delivery branch is a plain ref the reviewer's throwaway worktree can check out
      # cleanly, and dependents branch off a tidy `main` after the scaffold merges.
      git -C "$B_DIR" checkout "$B_DEFAULT_BRANCH" >/dev/null 2>&1 || true
      # Greenfield epics wire themselves up: link the new repo as a WRITE repo to
      # the epic's sibling feature tickets that still lack one, so they become
      # deliverable. Deterministic for the single-bootstrap epic; the planner
      # escalates the genuinely-ambiguous multi-app case to a headless decision.
      # Best-effort/non-fatal + idempotent (re-running never double-links).
      gaffer_inherit_repo "$NUM" || true
    else
      # Registration failed, so there is no repo to link, no branch_name and no per-repo
      # delivery row: submitting would strand the ticket in in_review (the reviewer has
      # nothing to diff, the done-gate cannot resolve it) with every dependent blocked
      # behind it. Park VISIBLY instead, with the cause, keeping the scaffold + branch;
      # a retry resumes the scaffold and counts a now-registered repo as success.
      log "BOOTSTRAP: dispatch registration of '$B_NAME' FAILED (${GAFFER_ONBOARD_ERR:-unknown}) — parking #$NUM → blocked (NOT submitting)"
      GAFFER_KEEP_DELIVERY_BRANCH=1
      gaffer_release_delivery blocked "bootstrap repo registration of '$B_NAME' failed: ${GAFFER_ONBOARD_ERR:-unknown} — register it with 'wg repo add' (scaffold kept at $B_DIR, branch $B_WORK_BRANCH), then unblock it ('gaffer wg unblock $NUM')" bootstrap_failed
      gaffer_skip_ticket "$NUM"
      result error; exit 0
    fi

    # RUNNER-OWNED-BOOKKEEPING: the runner (holding the claim) submits the bootstrap
    # ticket for review now that its gates passed and the delivery is recorded. The
    # agent no longer submits.
    if gaffer_submit_delivery "bootstrapped new repo $B_NAME at $B_DIR — delivered on branch $B_WORK_BRANCH"; then
      log "BOOTSTRAP: submitted #$NUM for review (→ in_review) on branch $B_WORK_BRANCH"
      result worked; exit 0
    fi
    # M1 (data-loss path): the submit FAILED. Do NOT exit "worked" leaving the ticket
    # `claimed` — on TTL expiry it is blindly reclaimed and re-bootstrapped, and the
    # already-recorded delivery evidence then points at a superseded scaffold. Park the
    # runner-held claim to `refining` (blocks the blind reclaim), skip it this run, and
    # fail the tick for a manual review handoff.
    gaffer_release_delivery refining "runner submit failed — needs manual review handoff"
    gaffer_skip_ticket "$NUM"
    log "BOOTSTRAP: WARNING — submit FAILED for #$NUM; parked → refining, NOT exiting worked — needs a human / claim-recovery"
    result error; exit 0
  fi

  # ── Repo-access boundary (FG-007/FG-008): resolve the ticket's WRITE / READ
  # repo partition from the WG-002 access boundary. `wg ticket show` joins each
  # ticket↔repo link to its repo row, so a single payload carries BOTH the
  # access boundary (access + relation) AND the local_path/default_branch/name
  # we need to branch and to feed the runtime safety hook. We mirror Dispatch's
  # workPacketRepos partition here (no extra CLI round-trip):
  #   WRITE  = active relation (confirmed|implicit_single_repo) AND access=='write'
  #   READ   = everything else that is still in-scope context: access read|test,
  #            or relation context_only — i.e. NOT denied (access none) and NOT a
  #            mere suggestion/rejection (those never become roots).
  # Each list is emitted as one absolute local_path per line (the exact format
  # the hook's GAFFER_WRITE_ROOTS/GAFFER_READ_ROOTS parser expects), skipping links
  # with no local_path on disk. The matching default_branch/name/path tuples are
  # emitted as TAB-separated rows for the per-write-repo branch + delivery loop.
  WG_PARTITION="$(echo "$SHOW" | gaffer_json partition 2>/dev/null || true)"
  # Slice the three sections back out (newline-delimited within each marker pair).
  WRITE_ROOTS="$(printf '%s\n' "$WG_PARTITION" | sed -n '/^@@WRITE_PATHS@@$/,/^@@READ_PATHS@@$/p' | sed '1d;$d')"
  READ_ROOTS="$(printf '%s\n' "$WG_PARTITION" | sed -n '/^@@READ_PATHS@@$/,/^@@WRITE_ROWS@@$/p' | sed '1d;$d')"
  WRITE_ROWS="$(printf '%s\n' "$WG_PARTITION" | sed -n '/^@@WRITE_ROWS@@$/,$p' | sed '1d')"

  # R-9: detect a partition PARSE FAILURE (markers absent) vs a legitimately
  # empty partition (markers present, just no write paths — an older ticket or a
  # ticket with only read-only repos). When the partition script crashes
  # or produces no output (the `|| true` swallows the exit code), WG_PARTITION has
  # no section markers, so all three variables above are empty. Distinguish:
  #   • markers PRESENT   → parse succeeded; WRITE_ROOTS empty = legitimate fallback.
  #   • markers ABSENT    → json parse failure; warn so a multi-repo ticket's
  #                         incomplete delivery is visible (not silent single-repo).
  _WG_MARKERS=1
  if ! grep -qF '@@WRITE_PATHS@@' <<<"$WG_PARTITION"; then   # here-string: a pipe can SIGPIPE-miss under pipefail
    _WG_MARKERS=0
    # Parse failure (markers absent = json parse crash). If the ticket actually links
    # MORE THAN ONE repo, the single-repo fallback would silently deliver incomplete work
    # AND hand the safety hook an under-scoped write boundary — so fail CLOSED (park →
    # ready for re-derivation) rather than guess. A single-repo / repo-less ticket's
    # fallback IS correct, so it proceeds unchanged.
    _SHOW_REPO_COUNT="$(echo "$SHOW" | jget '(d.repositories || []).length' 2>/dev/null || echo 0)"
    if [ "${_SHOW_REPO_COUNT:-0}" -gt 1 ]; then
      log "WG-002: access-boundary partition FAILED to parse for MULTI-REPO #$NUM ($_SHOW_REPO_COUNT repos) — refusing to deliver with an under-scoped single-repo boundary; parking → ready"
      gaffer_release_delivery ready "multi-repo access-boundary partition parse failed — needs re-derivation"
      gaffer_skip_ticket "$NUM"
      result error; exit 0
    fi
    log "WG-002 WARNING: access-boundary partition parse yielded no markers for #$NUM (json parse failure or empty ticket show). Falling back to single-repo write root ($REPO_PATH)."
  fi

  # A parsed boundary (markers present) with NO write repo is a ticket with no repo
  # linked at all (the default solo_loose pack lets one go ready with only a
  # REPO_RECOMMENDED warning) or whose repos are all read / test / context-only. It
  # must NOT fall through to the legacy single-repo fallback below — that made the
  # alphabetically-first linked repo WRITABLE (worktree + branch + hook allowing
  # writes) for a ticket the operator had marked read-only. Park it VISIBLY as
  # `blocked` (reason_code no_write_repo — it lands in the human queue) and skip it
  # this run. Releasing it to `ready` instead re-claimed and re-released it on every
  # loop run forever (the skip file is per run), a claim/release pair per run.
  # A write link whose repo has NO local_path (registered with `wg repo add --remote`
  # and no --path) is dropped by `partition` too, so it also arrives here with empty
  # WRITE_ROOTS. That ticket DOES have a write repo — telling the human to "set its
  # access to write" is false and an unblock just re-parks it — so it is parked as
  # no_local_repo_path with the register-or-clone instruction instead.
  # `ready` now refuses a ticket with no confirmed write repo up front (policy
  # WRITE_REPO_REQUIRED / SCOPE_REPO_UNCONFIRMED), so this mostly catches access
  # that changed after the ticket was readied.
  if [ "$_WG_MARKERS" = 1 ] && [ -z "$(printf '%s' "$WRITE_ROOTS" | tr -d '[:space:]')" ]; then
    _NWR_NOPATH="$(echo "$SHOW" | jget '(d.repositories || []).filter((r) => r && ["confirmed", "implicit_single_repo"].includes(r.relation) && r.access === "write" && !String(r.local_path || "").trim()).length' 2>/dev/null || echo 0)"
    if [ "${_NWR_NOPATH:-0}" -gt 0 ] 2>/dev/null; then
      log "ticket #$NUM has no local repo path ($_NWR_NOPATH write repo(s) linked with no local checkout); parking → blocked (no_local_repo_path) for a human"
      gaffer_release_delivery blocked "the write repo has no local checkout on this machine — clone it to its registered path, or register its path by onboarding a checkout ('gaffer onboard <dir>') and giving the ticket write access to that repo ('gaffer wg ticket repo-access set $NUM <repo>'), then unblock it ('gaffer wg unblock $NUM')" no_local_repo_path
      gaffer_skip_ticket "$NUM"
      result no_work; exit 0
    fi
    _NWR_COUNT="$(echo "$SHOW" | jget '(d.repositories || []).length' 2>/dev/null || echo 0)"
    if [ "${_NWR_COUNT:-0}" -gt 0 ]; then
      _NWR_WHY="all $_NWR_COUNT linked repo(s) are read/test/context-only"
    else
      _NWR_WHY="no repo is linked to the ticket"
    fi
    log "WG-002: #$NUM has no WRITE repo ($_NWR_WHY) — refusing to deliver; parking → blocked (no_write_repo) for a human"
    gaffer_release_delivery blocked "no write repo on the ticket ($_NWR_WHY) — link a repo and set its access to write (wg ticket repo-access set <n> <repo> --access write --relation confirmed), then unblock it ('gaffer wg unblock $NUM')" no_write_repo
    gaffer_skip_ticket "$NUM"
    result no_work; exit 0
  fi

  # Back-compat (older tickets with no WG-002 access boundary, i.e. no markers):
  # fall back to the single delivery repo as the sole write repo. This reproduces
  # EXACTLY today's single-repo behaviour — one write root, one gaffer/ branch, no
  # read roots.
  if [ -z "$(printf '%s' "$WRITE_ROOTS" | tr -d '[:space:]')" ]; then
    WRITE_ROOTS="$REPO_PATH"
    READ_ROOTS=""
    DEFAULT_BRANCH_FALLBACK="$(echo "$SHOW" | jget '(((d.repositories||[]).find(r => r.access === "write" && r.local_path) || (d.repositories||[]).find(r => r.local_path) || (d.repositories||[])[0] || {}).default_branch) || "main"' 2>/dev/null || echo main)"
    REPO_NAME_FALLBACK="$(echo "$SHOW" | jget '(((d.repositories||[]).find(r => r.access === "write" && r.local_path) || (d.repositories||[]).find(r => r.local_path) || (d.repositories||[])[0] || {}).name) || ""' 2>/dev/null || echo '')"
    REPO_ID_FALLBACK="$(echo "$SHOW" | jget '(((d.repositories||[]).find(r => r.access === "write" && r.local_path) || (d.repositories||[]).find(r => r.local_path) || (d.repositories||[])[0] || {}).id) || ""' 2>/dev/null || echo '')"
    WRITE_ROWS="$(printf '%s\t%s\t%s\t%s' "$REPO_ID_FALLBACK" "$REPO_NAME_FALLBACK" "$REPO_PATH" "$DEFAULT_BRANCH_FALLBACK")"
    MULTI_REPO=0
  else
    # Count write repos to label the plan (mono-fallback = 1, mapped multi = >1).
    WRITE_REPO_COUNT="$(printf '%s\n' "$WRITE_ROOTS" | grep -c . || true)"
    [ "${WRITE_REPO_COUNT:-0}" -gt 1 ] && MULTI_REPO=1 || MULTI_REPO=0
  fi

  # Recommended skills for this ticket's stack (best-effort; never fatal).
  # Select from the factory's stack/area-tagged SKILL.md library (the one actually
  # mounted into the repo). If the selector prints nothing, fall back to the universal
  # delivery mechanics (GAFFER_UNIVERSAL_SKILLS, skills-mount.sh) — the same set the
  # mount always unions in. The crew registry (`fg skills`) used to be the fallback; it
  # lists role-only skills (create-branch, submit-review…) and names the library does
  # not carry, which the prompt then recommended and the mount silently dropped.
  # Derive an area from the stack where unambiguous so area-gated packs (FIX-2)
  # still fire for a clearly-domained stack (e.g. a web stack → frontend pack).
  # MULTI-REPO STACKS: the skills are selected for the UNION of every write repo's
  # registered stack, not the first write repo's alone — a ticket spanning a TypeScript
  # frontend and a Java service, with no filename or language hint, got frontend skills
  # and no Java pack. Per-path routing below still narrows to the ecosystems a named
  # path touches (every touched path's stack survives the narrowing).
  SKILL_STACKS="$(printf '%s' "$SHOW" | node "$HERE/bin/select-skills.mjs" --ticket-stacks - 2>/dev/null || true)"
  [ -n "$SKILL_STACKS" ] || SKILL_STACKS="$STACK"
  SKILL_AREA="$(gaffer_area_for_stack "$SKILL_STACKS")"
  # TEXT RELEVANCE: hand the selector the ticket's title + description head so an
  # off-domain pack the ticket plainly calls for (a Terraform module, an SEO audit, a
  # runbook) is mounted too — those packs were otherwise unreachable from any runner
  # path. An argv, never a shell string: the untrusted text cannot inject flags.
  _SKILL_TEXT="$(printf '%s\n%s' "${TITLE:-}" "$(echo "$SHOW" | jget '(d.ticket.description || "").slice(0, 600)' 2>/dev/null || true)")"
  # PER-PATH ROUTING: file paths the ticket NAMES narrow the stack to their ecosystems on a
  # mixed repo ("… in api/Shop.Api/Controllers/TasksController.cs" → the C# pack, not the
  # React bar). No path named → the repo's full stack. The full description is scanned
  # (paths are often below the 600-char head the text relevance uses).
  _SKILL_PATHS="$(mktemp "${TMPDIR:-/tmp}/skill-paths.XXXXXX")"
  printf '%s\n%s' "${TITLE:-}" "$(echo "$SHOW" | jget '(d.ticket.description || "")' 2>/dev/null || true)" \
    | grep -oE '[A-Za-z0-9_][A-Za-z0-9_./-]*\.(cs|csproj|sln|razor|cshtml|ts|tsx|js|jsx|mjs|cjs|vue|svelte|py|go|rs|java|kt|kts|swift|rb|sh|bash|html|css|scss)\b' \
    > "$_SKILL_PATHS" 2>/dev/null || : > "$_SKILL_PATHS"
  SKILLS="$(node "$HERE/bin/select-skills.mjs" --stack "$SKILL_STACKS" ${SKILL_AREA:+--area "$SKILL_AREA"} --text "$_SKILL_TEXT" --paths-file "$_SKILL_PATHS" --skills-dir "$SKILLS_DIR" 2>/dev/null || true)"
  # Name each write repo's conventions pack in the prompt when the stacks differ.
  SKILLS_PACK_NOTE="$(printf '%s' "$SHOW" | node "$HERE/bin/select-skills.mjs" --ticket-pack-note - --selected "$SKILLS" --skills-dir "$SKILLS_DIR" 2>/dev/null || true)"
  rm -f "$_SKILL_PATHS"
  [ -n "$SKILLS" ] || SKILLS="$(printf '%s' "${GAFFER_UNIVERSAL_SKILLS:-}" | tr -s ' ' '\n' | grep . | paste -sd, - | sed 's/,/, /g')"
  [ -n "$SKILLS" ] || SKILLS="(choose the skill whose description matches the ticket)"

  # Always-on QUALITY LENSES (frontmatter `area: quality`) — applied to EVERY delivery,
  # not just stack-matched. e.g. `minimalism`. These are injected into the prompt as
  # MANDATORY so a cross-cutting skill is never merely "recommended" among 25 others.
  LENSES="$(for _f in "$SKILLS_DIR"/*/SKILL.md; do grep -qiE '^area:[[:space:]]*quality' "$_f" 2>/dev/null && basename "$(dirname "$_f")"; done | paste -sd, - 2>/dev/null)"
  [ -n "$LENSES" ] || LENSES="minimalism"

  if [ -z "$REPO_PATH" ] || [ ! -d "$REPO_PATH" ]; then
    log "ticket #$NUM has no local repo path; parking → blocked (no_local_repo_path) for a human"
    # Park VISIBLY as `blocked`, never back to `ready`: the skip file only lasts one
    # loop run, so a `ready` release was re-claimed and re-released on every run
    # forever. Skip it for the rest of this run too.
    gaffer_release_delivery blocked "the write repo has no local checkout on this machine — clone it to its registered path, or register its path by onboarding a checkout ('gaffer onboard <dir>') and giving the ticket write access to that repo ('gaffer wg ticket repo-access set $NUM <repo>'), then unblock it ('gaffer wg unblock $NUM')" no_local_repo_path
    gaffer_skip_ticket "$NUM"
    result no_work; exit 0
  fi

  # The agent's working directory (cwd) is the PRIMARY write repo: relative-path
  # edits then land inside a write-root. In single-repo / mono-fallback mode this
  # is exactly REPO_PATH (today's behaviour). In mapped multi-repo mode the first
  # repo in the ticket may be read-only context, so prefer the first WRITE root.
  PRIMARY_REPO="$(printf '%s\n' "$WRITE_ROOTS" | grep . | head -1)"
  [ -n "$PRIMARY_REPO" ] || PRIMARY_REPO="$REPO_PATH"

  # Slug the title once (shared by every write repo's branch name). gaffer_ticket_slug
  # is the SAME derivation the greenfield bootstrap uses, so both mint the identical
  # branch shape the reviewer resolves against.
  SLUG="$(gaffer_ticket_slug "$TITLE")"
  WORK_BRANCH="gaffer/ticket-$NUM-$SLUG"

  # ── SELF-OPERATION BAN (refuse to deliver to Gaffer's own source) ────────────
  # If the delivery target IS, or is INSIDE, one of the factory's own component
  # dirs (dispatch / crew / memory / the runner) or the gaffer checkout itself,
  # refuse: the factory would be editing its own source. Checked here — after
  # REPO_PATH and every write root are resolved, before any worktree is created — so nothing is
  # mutated. GAFFER_ALLOW_SELF_DELIVERY=1 fully restores today's behaviour (for
  # first-party dogfooding). The ticket is BLOCKED (set aside for a human, exactly
  # like the bootstrap "no commit" / hygiene parks) AND recorded in the per-run
  # skip file, so the loop does NOT re-claim the same self-target ticket forever.
  if [ "${GAFFER_ALLOW_SELF_DELIVERY:-0}" != "1" ]; then
    # EVERY write target is checked, not just the first: a multi-repo ticket whose
    # gaffer checkout (or a component dir) is the 2nd+ write repo would otherwise
    # be delivered into. Candidates, in order: each WRITE_ROOTS line, each
    # WRITE_ROWS path column (the rows worktrees are actually added from), then
    # REPO_PATH. First match wins; any match refuses the whole ticket (fail closed).
    SELF_HIT=""
    __self_cands="$(printf '%s\n' "$WRITE_ROOTS"; printf '%s\n' "$WRITE_ROWS" | awk -F'\t' 'NF>=3{print $3}'; printf '%s\n' "$REPO_PATH")"
    while IFS= read -r __self_c; do
      [ -n "$__self_c" ] || continue
      if gaffer_is_self_target "$__self_c"; then SELF_HIT="$__self_c"; break; fi
    done <<< "$__self_cands"
    if [ -n "$SELF_HIT" ]; then
      log "SELF-OP: refusing to deliver #$NUM — target '$SELF_HIT' is (or is inside) a Gaffer component; the factory must not edit its own source. Set GAFFER_ALLOW_SELF_DELIVERY=1 to override (first-party dogfooding only)."
      wg attach-evidence "$NUM" --type manual_note \
        --summary "SELF-OP BAN: refused delivery — target '$SELF_HIT' is a Gaffer component (factory's own source). Override with GAFFER_ALLOW_SELF_DELIVERY=1." >/dev/null 2>&1 || true
      # Set aside for a human. RUNNER-OWNED-BOOKKEEPING: the runner holds the claim
      # now, so release it first (claimed → ready), THEN un-ready it (ready -> draft)
      # so the candidate loop never re-selects it — the "set aside, don't re-claim
      # forever" mechanism the board already provides. SKIP_FILE is belt-and-braces
      # within the current run (loop.sh clears it per run).
      gaffer_release_delivery ready "self-op: target is a Gaffer component"
      wg ticket move "$NUM" draft --as system >/dev/null 2>&1 || true
      gaffer_skip_ticket "$NUM"
      log "SELF-OP: set aside #$NUM for a human (released claim + un-readied ready→draft + skipped this run; not delivered, not re-claimed)"
      result no_work; exit 0
    fi
  fi

  # ── Worktree isolation (delivery happens in throwaway worktrees) ────────────
  # Delivery never touches a real repo's working tree. For each WRITE repo we add
  # a git worktree under $WORKTREES_BASE checked out on the ticket branch. The
  # worktree shares the real repo's object DB, so commits land on the gaffer/
  # branch IN the real repo, while the real repo's main working tree + current
  # branch stay exactly where the human left them. We remember, per write repo,
  # the mapping realRepo→worktreePath so the post-run lifecycle (assert, record,
  # remove, rollback) can act on the right paths.
  #
  # WT_ROWS mirrors WRITE_ROWS but appends a 5th TAB column: the worktree path.
  # Worktree path is derived deterministically from the repo id (fallback name,
  # fallback a positional index) so a re-run targets the same dir (idempotent).
  WORKTREES_BASE="$GAFFER_DATA/worktrees/ticket-$NUM"
  WT_ROWS=""
  __wt_idx=0
  while IFS=$'\t' read -r rid rname rpath rbase; do
    [ -n "$rpath" ] || continue
    rbase="${rbase:-main}"
    # Stable, filesystem-safe leaf for this repo's worktree.
    # Typed leaf derivation (packages/crew worktreeKeyCli.js → worktreeKey; pinned by
    # worktree-key-golden). A missing crew dist yields an empty key → the repo<index>
    # backstop below, so a worktree is always created at a stable path.
    __wt_key="$(node "${CREW_DIR:-}/dist/runtime/worktree/worktreeKeyCli.js" --id "$rid" --name "$rname" --index "$__wt_idx" 2>/dev/null)"
    [ -n "$__wt_key" ] || __wt_key="repo$__wt_idx"
    __wt_path="$WORKTREES_BASE/$__wt_key"
    WT_ROWS+="$(printf '%s\t%s\t%s\t%s\t%s' "$rid" "$rname" "$rpath" "$rbase" "$__wt_path")"$'\n'
    __wt_idx=$((__wt_idx + 1))
  done <<< "$WRITE_ROWS"
  WT_ROWS="${WT_ROWS%$'\n'}"

  # The agent writes in the WORKTREES, not the real repos. Recompute the write
  # roots (one worktree path per line) and the primary cwd accordingly. Read
  # roots stay the real read repos (read-only access is safe against the real
  # checkout). In single-repo / mono-fallback mode this is exactly one worktree.
  WRITE_ROOTS="$(printf '%s\n' "$WT_ROWS" | grep . | awk -F'\t' '{print $5}')"
  PRIMARY_REPO="$(printf '%s\n' "$WRITE_ROOTS" | grep . | head -1)"
  [ -n "$PRIMARY_REPO" ] || PRIMARY_REPO="$WORKTREES_BASE/primary"

  # Prior review feedback: if this ticket was sent back before, the reviewer's
  # reasons ride into the prompt so the agent ADDRESSES them this time. Pulled from
  # ticket.transitioned events whose payload reason records a rejection, newest
  # few, deduped. Only the RAW reasons are captured here: the write/read repo
  # lists, the review-feedback framing and the quarantine envelope around
  # the (untrusted) reasons are all rendered by crew's deliveryPrompt.ts, which
  # reads _RF through _gaffer_prompt_inputs_json (factory.config.sh).
  # The human's answers to decisions on this ticket ride in the same way (_RD, a
  # JSON array the renderer quotes inside an untrusted envelope), so an agent that
  # skips get_ticket's resolved_decisions does not ask the same question again.
  _TSHOW="$(wg ticket show "$NUM" 2>/dev/null || true)"
  _RF="$(printf '%s' "$_TSHOW" | gaffer_json review-feedback 2>/dev/null || true)"
  _RD="$(printf '%s' "$_TSHOW" | gaffer_json resolved-decisions 2>/dev/null || true)"

  # ── PRIOR CONTEXT (file cards) — via shared gaffer_prime_context_block ───────
  # Runner has ALREADY resolved scope (write/read partition above). Pull the
  # repo's file cards for this ticket via the shared primer and PUSH them into
  # the delivery prompt so the agent starts oriented instead of re-scanning.
  # The agent still PULLS more via the memory MCP.
  # FAIL-SOFT: any memory error / no cards → empty block and delivery proceeds
  # exactly as before. Cards are a retrieval AID, never source.
  FILE_CARDS_BLOCK=""
  PRIME_CONTEXT_CALLED=false
  CARDS_SERVED=0
  _CARD_REAL_REPO="$(printf '%s\n' "$WT_ROWS" | grep . | awk -F'\t' 'NR==1{print $3}')"
  [ -n "$_CARD_REAL_REPO" ] || _CARD_REAL_REPO="$REPO_PATH"
  _CARD_REPO_NAME="$(printf '%s\n' "$WT_ROWS" | grep . | awk -F'\t' 'NR==1{print $2}')"
  [ -n "$_CARD_REPO_NAME" ] || _CARD_REPO_NAME="$(basename "$_CARD_REAL_REPO")"
  _CARD_DESC="$(echo "$SHOW" | jget '(d.ticket.description || "").slice(0, 600)' 2>/dev/null || echo '')"
  _CARD_QUERY="$(printf '%s %s' "$TITLE" "$_CARD_DESC")"
  # Remember the display name + ticket used for THIS delivery's recall, so the
  # outcome-feedback call below (submit / blocked-park) targets the exact
  # (repo, ticket) memory logged the served items under. GAFFER_RECALL_TICKET
  # is exported ONLY for the delivery prime (not review/clarify) so memory logs
  # the read-event edge for the items that actually fed the delivered work.
  RECALL_REPO_NAME="$_CARD_REPO_NAME"
  # A DRY_RUN prime is a preview: no recall ticket, so memory logs no read events and
  # no memory_primed evidence lands on the ticket (exploratory finding cli-runner/F-06).
  _RECALL_FOR=""; [ "${DRY_RUN:-0}" = "1" ] || _RECALL_FOR="$NUM"
  FILE_CARDS_BLOCK="$(GAFFER_RECALL_TICKET="$_RECALL_FOR" gaffer_prime_context_block "$_CARD_REAL_REPO" "$_CARD_REPO_NAME" "$_CARD_QUERY" 2>/dev/null || true)"
  if [ -n "$FILE_CARDS_BLOCK" ]; then
    PRIME_CONTEXT_CALLED=true
    # Count card lines only: the recalled-lore section that may follow the cards
    # uses the same "  - [kind]" bullet, so it is cut off before counting.
    CARDS_SERVED="$(printf '%s\n' "$FILE_CARDS_BLOCK" | sed '/Recalled lore for this scope (conventions \/ gotchas):$/,$d' | grep -c "^  - \[" 2>/dev/null || true)"
    # `grep -c` exits 1 on a zero count, so `|| echo 0` captured "0⏎0" (exploratory
    # finding fresh-user/F-18); `|| true` keeps grep's own "0".
    CARDS_SERVED="${CARDS_SERVED:-0}"
    log "cards: primed delivery #$NUM with ${CARDS_SERVED} file card(s)"
  else
    log "cards: no file-card context for #$NUM (none served / memory unavailable) — proceeding without"
  fi
  # METRICS (chunk 2b) — record the mechanically-observable retrieval facts for
  # this delivery: prime_context_called + cards_served + the served cards' paths.
  # Best-effort, gated on GAFFER_DATA, fully swallowed (never affects delivery). The
  # complementary reads-before-first-write signal is captured at the safety-hook
  # tool-call layer ($GAFFER_DATA/tool-metrics.jsonl), keyed by GAFFER_TICKET. The
  # end-of-run summary (run-summary.sh → json-tool summary-retrieval) joins the two:
  # reads before the first write, and how many served cards the agent then Read.
  if [ -n "${GAFFER_DATA:-}" ] && [ "${DRY_RUN:-0}" != "1" ]; then
    {
      printf '%s\n' "$FILE_CARDS_BLOCK" \
        | node "$RUNNER_DIR/lib/json-tool.mjs" delivery-metric "$NUM" "$PRIME_CONTEXT_CALLED" "${CARDS_SERVED:-0}" \
        >> "$GAFFER_DATA/delivery-metrics.jsonl"
    } 2>/dev/null || true
  fi

  # ── PRODUCT CONTEXT (why this work exists) — via gaffer_product_context_block ─
  # Aim recall at the "why": pull the repo's durable product-intent lore
  # (decisions / requirements / non-goals) and inject it AFTER the file cards so
  # the agent starts from intent, not just structure. QUARANTINED like the cards.
  # FAIL-SOFT: none / memory unavailable → empty block, delivery proceeds unchanged.
  PRODUCT_CONTEXT_BLOCK="$(gaffer_product_context_block "$_CARD_REPO_NAME" 2>/dev/null || true)"
  if [ -n "$PRODUCT_CONTEXT_BLOCK" ]; then
    log "product-context: primed delivery #$NUM with product-intent lore"
  fi
  # ACCEPTANCE GATE: the acceptance ticket's instructions ride ahead of the product
  # context (same prompt slot, no renderer change): write the brief-level suite, fix
  # what it finds, never weaken a test. The ticket's own text still arrives quarantined.
  if [ "${IS_ACCEPTANCE:-0}" = "1" ] && declare -F gaffer_acceptance_prompt_block >/dev/null 2>&1; then
    PRODUCT_CONTEXT_BLOCK="$(gaffer_acceptance_prompt_block)${PRODUCT_CONTEXT_BLOCK:+

$PRODUCT_CONTEXT_BLOCK}"
    log "ACCEPTANCE: #$NUM is the epic's acceptance ticket — brief-level acceptance suite against the integrated build; the independent tester decides"
  fi

  # A repo that ships its OWN .claude/skills keeps them: a Gaffer pack of the same name is
  # not mounted over it, and the recommended-skills line says the repo's version wins.
  SKILLS_NOTE="${SKILLS_PACK_NOTE:-}$(gaffer_skills_note "$PRIMARY_REPO" "$SKILLS, $LENSES" 2>/dev/null || true)"

  # The prompt TEXT — the quarantined title, the lore-reflection nudge, the
  # review-feedback block, the repo lists — is LIVE in
  # packages/crew/src/runtime/context/deliveryPrompt.ts; edit it there (and
  # rebuild crew), not here. This file only gathers the raw inputs.
  if [ "$_RESUMING" = "1" ]; then
    # PAUSE-ON-CAP continuation prompt: the prior progress is ALREADY in this worktree
    # (committed and/or working changes) — the agent CONTINUES and FINISHES it with a
    # fresh turn allowance. No re-claim, no re-scaffold; the ticket is already
    # in_progress and the branch already carries the partial work.
    PROMPT="$(gaffer_render_delivery_prompt resume)" \
      || gaffer_abort_setup PROMPT-RENDER "failed to render resume prompt for #$NUM — aborting delivery (fail closed)"
  else
  PROMPT="$(gaffer_render_delivery_prompt fresh)" \
    || gaffer_abort_setup PROMPT-RENDER "failed to render delivery prompt for #$NUM — aborting delivery (fail closed)"
  fi

  if [ "$_RESUMING" = "1" ]; then
    log "resume=#$NUM → re-entering delivery for paused #$NUM ('$TITLE') in $PRIMARY_REPO [stack=$STACK]"
  elif [ "${DRY_RUN:-0}" = "1" ]; then
    # Not "delivering": `gaffer status` lists this line as a dry-run preview.
    log "ready=$READY_COUNT → DRY_RUN: previewed #$NUM ('$TITLE') in $PRIMARY_REPO (nothing claimed, nothing spent) [stack=$STACK]"
  elif [ "$MULTI_REPO" = "1" ]; then
    log "ready=$READY_COUNT → delivering #$NUM ('$TITLE') across $WRITE_REPO_COUNT write repos (multi-repo) [stack=$STACK]"
  else
    log "ready=$READY_COUNT → delivering #$NUM ('$TITLE') in $PRIMARY_REPO (single-repo) [stack=$STACK]"
  fi

  # ── I1: intelligent, data-driven MODEL ROUTING for the implement phase ───────
  # Replace the static GAFFER_IMPL_MODEL_FLAG with a per-ticket routing decision:
  # read the ticket's risk, AC count, and attempt history from the dispatch view,
  # pass them + the repo stack + the budget seam to the deterministic router, and
  # let it pick the cheapest-correct tier. gaffer_route_model logs one auditable
  # "ROUTE #N …" line and echoes the model id; an explicit GAFFER_IMPL_MODEL still
  # wins (backward-compat). With the default registry + a normal ticket this
  # resolves to mid=sonnet — exactly today's implement model.
  ROUTE_RISK="$(echo "$SHOW" | jget 'd.ticket.risk_level || "medium"' 2>/dev/null || echo medium)"
  ROUTE_AC="$(echo "$SHOW" | jget '(d.acceptanceCriteria || []).length' 2>/dev/null || echo 0)"
  # attempt_count is 0-based (0 = first delivery); the router's attempt is 1-based
  # so a prior rejection (attempt_count≥1) escalates. Default 0 if absent.
  ROUTE_ATTEMPT_RAW="$(echo "$SHOW" | jget 'Math.trunc(Number(d.ticket.attempt_count || 0))' 2>/dev/null || echo 0)"
  ROUTE_ATTEMPT=$(( ${ROUTE_ATTEMPT_RAW:-0} + 1 ))
  # Pass the primary worktree so the router can measure diff size / file count when a
  # worktree with UNCOMMITTED work exists (a resumed delivery); on a first attempt no
  # worktree exists yet, so the difficulty signal is the ticket's accumulated measured
  # spend (historical cost).
  # FINDING-9: routing runs BEFORE the worktrees are created, and a rework attempt's
  # accumulated work is COMMITTED on the preserved gaffer/ branch — invisible to a
  # worktree `git diff HEAD` even when one exists. Pass the REAL primary repo, the
  # ticket branch and its base so the router can measure the accumulated rework diff
  # (`git diff base...branch`) straight from the repo when the branch survives.
  ROUTE_REPO="$(printf '%s\n' "$WT_ROWS" | grep . | head -1 | awk -F'\t' '{print $3}')"
  ROUTE_BASE="$(printf '%s\n' "$WT_ROWS" | grep . | head -1 | awk -F'\t' '{print ($4==""?"main":$4)}')"
  DELIVERY_MODEL="$(gaffer_route_model implement "$ROUTE_RISK" "$ROUTE_AC" "$STACK" "$ROUTE_ATTEMPT" "$NUM" "$PRIMARY_REPO" "$ROUTE_REPO" "$WORK_BRANCH" "$ROUTE_BASE")"
  # Per-tick implement flag: the router's model, or empty (→ Claude default) when
  # the registry/override resolves to none. Falls back to the static flag only if
  # routing yielded nothing AND the static tier is set.
  ROUTE_IMPL_FLAG=""
  if [ -n "$DELIVERY_MODEL" ]; then
    ROUTE_IMPL_FLAG="--model $DELIVERY_MODEL"
  elif [ -n "${GAFFER_IMPL_MODEL_FLAG:-}" ]; then
    ROUTE_IMPL_FLAG="$GAFFER_IMPL_MODEL_FLAG"
  fi

  if [ "$DRY_RUN" = "1" ]; then
    # DRY_RUN is strictly side-effect-free: we describe the worktree plan but
    # create NO worktrees, branches, or files.
    log "DRY_RUN: would clean any stale worktrees under $WORKTREES_BASE (+ git worktree prune per write repo)"
    log "DRY_RUN: would add a throwaway worktree per write repo on branch $WORK_BRANCH, then install"
    log "DRY_RUN: project-local .claude/ (settings+hook, skills, CLAUDE.md) + .mcp.json into the PRIMARY worktree, then:"
    log "DRY_RUN:   (cd <primary worktree> && GAFFER_WRITE_ROOTS=<worktree paths> GAFFER_READ_ROOTS=<read roots> DISPATCH_DB=… MEMORY_DB=… $CLAUDE_BIN -p <prompt> $CLAUDE_FLAGS)"
    log "DRY_RUN: write repos (each delivered via a worktree on branch $WORK_BRANCH; the real repo's working tree is never touched):"
    while IFS=$'\t' read -r rid rname rpath rdefault rwt; do
      [ -n "$rpath" ] || continue
      log "DRY_RUN:   WRITE  ${rname:-repo} @ $rpath (base ${rdefault:-main}) → worktree $rwt on $WORK_BRANCH"
    done <<< "$WT_ROWS"
    log "DRY_RUN: primary worktree (agent cwd) = $PRIMARY_REPO"
    if [ -n "$(printf '%s' "$READ_ROOTS" | tr -d '[:space:]')" ]; then
      while IFS= read -r rpath; do [ -n "$rpath" ] && log "DRY_RUN:   READ   $rpath (real repo, read-only context; never branched or worktree'd)"; done <<< "$READ_ROOTS"
    else
      log "DRY_RUN:   READ   (none)"
    fi
    log "DRY_RUN: on success, would assert each worktree HEAD is $WORK_BRANCH, record per-repo delivery, then remove the worktrees (branch + commits PERSIST in the real repo)"
    log "DRY_RUN: on failure, would remove the worktrees AND delete branch $WORK_BRANCH so the real repo stays 100% clean"
    log "DRY_RUN: recommended skills = $SKILLS"
    log "DRY_RUN: routed implement model = ${DELIVERY_MODEL:-<claude default>} (see the ROUTE #$NUM line above for the decision)"
    gaffer_dry_mark_previewed "$NUM"
    result previewed; exit 0
  fi

  # ── Worktree delivery setup (replaces in-place branching) ───────────────────
  # The RUNNER owns the delivery checkout: rather than branching a real repo IN
  # PLACE (which would dirty the human's working tree), we add a throwaway git
  # worktree per WRITE repo, checked out on the ticket branch. Worktrees share
  # the real repo's object DB, so commits land on `gaffer/ticket-$NUM-$slug` IN
  # the real repo while its primary working tree + current branch are untouched.
  #
  # FG-008 preserved: one branch per write repo, each off that repo's OWN default
  # branch; a write repo that exists on disk but cannot be worktree'd FAILS the
  # delivery (fail safely). Single-repo / mono-fallback = exactly one worktree =
  # one gaffer/ branch = today's behaviour, just running in a worktree.
  #
  # DEFAULT_BRANCH = the PRIMARY write repo's base, kept for the existing
  # diff/assertion code paths below (which operate on PRIMARY_REPO = primary wt).
  DEFAULT_BRANCH="$(printf '%s\n' "$WRITE_ROWS" | grep . | head -1 | awk -F'\t' '{print ($4==""?"main":$4)}')"
  [ -n "$DEFAULT_BRANCH" ] || DEFAULT_BRANCH="$(echo "$SHOW" | jget '(((d.repositories||[]).find(r => r.access === "write" && r.local_path) || (d.repositories||[]).find(r => r.local_path) || (d.repositories||[])[0] || {}).default_branch) || "main"')"

  # Helper: tear down every worktree we may have created for this ticket and
  # (optionally) delete the gaffer/ branch. Used for (a) stale cleanup before a
  # run, (b) success removal — keep the branch, (c) failure rollback — drop the
  # branch too, so a botched run leaves the real repo 100% clean. Always defensive
  # (`git worktree prune`) and never fatal.
  # BRANCH RETENTION: `drop-branch` deletes $WORK_BRANCH ONLY in the repos where THIS
  # tick created it (`worktree add -B`, recorded in _BRANCH_CREATED_THIS_TICK by repo
  # path). A branch this tick merely re-attached — a rework's reviewed commits, a
  # resume — predates the tick and is never deleted by any caller: the crash trap
  # (signals, the outer timeout, setup exits, the pre-spawn budget park), the
  # multi-repo setup rollback, or a failure path. Those used to delete reviewed,
  # paid-for commits. A kept branch with commits is logged.
  _BRANCH_CREATED_THIS_TICK=""
  _gaffer_branch_created_here() { grep -qxF -- "$1" <<<"$_BRANCH_CREATED_THIS_TICK"; }
  # GATE INTEGRITY: the commit each `worktree add -B` cut $WORK_BRANCH at, captured at
  # the cut (before any agent runs), by repo path: "<path>\t<sha>" lines, the latest cut
  # last. Reading the branch tip LATER is wrong — on an in-tick retry the tip holds the
  # previous attempt's commits — so the recorded base comes from here, never the tip.
  _BRANCH_CUT_SHAS=""
  _gaffer_note_branch_cut() {
    local _c
    _c="$(git -C "$1" rev-parse --verify --quiet "refs/heads/$WORK_BRANCH^{commit}" 2>/dev/null)" || _c=""
    _BRANCH_CUT_SHAS="$(awk -F'\t' -v p="$1" '$1!=p' <<<"$_BRANCH_CUT_SHAS")"
    [ -n "$_BRANCH_CUT_SHAS" ] && _BRANCH_CUT_SHAS+=$'\n'
    [ -n "$_c" ] && _BRANCH_CUT_SHAS+="$1"$'\t'"$_c"$'\n'
    return 0
  }
  _gaffer_branch_cut_sha() { awk -F'\t' -v p="$1" '$1==p{s=$2} END{if(s!="")print s}' <<<"$_BRANCH_CUT_SHAS"; }
  gaffer_cleanup_worktrees() {
    # $1 = "drop-branch" to also delete $WORK_BRANCH from each real repo where this
    # tick created it (see BRANCH RETENTION above).
    local drop_branch="${1:-}"
    local _rid _rname _rpath _rbase _rwt _kept
    while IFS=$'\t' read -r _rid _rname _rpath _rbase _rwt; do
      [ -n "$_rpath" ] || continue
      git -C "$_rpath" rev-parse --git-dir >/dev/null 2>&1 || { [ -e "$_rwt" ] && rm -rf "$_rwt"; continue; }
      if [ -n "$_rwt" ] && [ -e "$_rwt" ]; then
        # `git worktree remove --force` deregisters the worktree but REFUSES to
        # delete untracked residue — notably the `.claude/` the skill-mount installs.
        # Once gaffer_skills_mount_cleanup drops the mount target, that worktree's
        # `.claude/skills` symlink is left DANGLING, and git leaves the whole
        # `.claude/` dir behind — which then trips the post-teardown hygiene gate
        # (broken symlink: .claude/skills). Always `rm -rf` the worktree path after
        # the git remove so teardown leaves NOTHING behind, dangling links included.
        git -C "$_rpath" worktree remove --force "$_rwt" >/dev/null 2>&1 || true
        rm -rf "$_rwt" 2>/dev/null || true
      fi
      git -C "$_rpath" worktree prune >/dev/null 2>&1 || true
      if [ "$drop_branch" = "drop-branch" ]; then
        if _gaffer_branch_created_here "$_rpath"; then
          git -C "$_rpath" branch -D "$WORK_BRANCH" >/dev/null 2>&1 || true
        else
          _kept="$(git -C "$_rpath" rev-list --count "${_rbase:-main}..$WORK_BRANCH" 2>/dev/null || echo 0)"
          [ "${_kept:-0}" -gt 0 ] 2>/dev/null \
            && log "branch $WORK_BRANCH KEPT in ${_rname:-repo} ($_rpath): it predates this tick ($_kept commit(s) over ${_rbase:-main}); only the worktree was removed"
        fi
      fi
    done <<< "$WT_ROWS"
    # Also remove the (now empty) ticket worktrees base dir if nothing else uses it.
    [ -d "$WORKTREES_BASE" ] && rmdir "$WORKTREES_BASE" >/dev/null 2>&1 || true
  }

  # ── M1/R-2: crash-safe worktree/branch cleanup ──────────────────────────────
  # The explicit success/error paths below tear worktrees down by hand, but a
  # CRASH or signal (the gaffer_timeout SIGTERM, a Ctrl-C, an unexpected `set -e`
  # abort) between worktree creation and one of those paths would ORPHAN the
  # throwaway worktrees and the half-finished `gaffer/ticket-*` branch in every
  # write repo. The EXIT/INT/TERM trap that drops them is already installed UP FRONT
  # (R-2, right after the config is sourced) so it ALSO covers the earlier candidate
  # / skill / access-boundary parsing — but it is unset-var-safe and a no-op until
  # gaffer_cleanup_worktrees + WT_ROWS are defined (i.e. until now). Now that the
  # teardown helper and its rows exist, the trap becomes effective for this ticket.
  # It is GUARDED so a legitimately-delivered branch is never destroyed: on a
  # successful delivery we set GAFFER_DELIVERY_COMPLETE=1 (the branch must survive
  # for review/merge) and the trap then returns early. The cleanup itself is
  # idempotent (`git worktree prune` / `branch -D` are no-ops when there's nothing to
  # remove), so it is safe even when an explicit path already cleaned up.

  # Idempotent re-runs: clear any stale worktrees from a previous attempt at this
  # ticket BEFORE creating fresh ones, and prune dangling worktree admin entries
  # (runs unconditionally — `git worktree prune` is a defensive no-op when clean).
  # PAUSE-ON-CAP: a RESUME must NOT clear the worktree — that is exactly the preserved
  # partial work (committed AND uncommitted) we are re-entering. Skip the stale clean.
  [ "$_RESUMING" = "1" ] || gaffer_cleanup_worktrees

  # Create a throwaway worktree on the ticket branch for each write repo. `-B`
  # gives force semantics: if the branch already exists (e.g. a half-finished
  # prior run), it is reset to the base so the worktree starts clean.
  WT_FAILED=0
  while IFS=$'\t' read -r rid rname rpath rbase rwt; do
    [ -n "$rpath" ] || continue
    rbase="${rbase:-main}"
    if ! git -C "$rpath" rev-parse --git-dir >/dev/null 2>&1; then
      # A configured write repo that is not a git repo on disk: we cannot worktree
      # it, so we cannot safely deliver into it. Fail closed.
      log "FAIL: write repo ${rname:-repo} ($rpath) is not a git repo on disk — cannot worktree #$NUM"
      WT_FAILED=1
      continue
    fi
    git -C "$rpath" worktree prune >/dev/null 2>&1 || true
    mkdir -p "$WORKTREES_BASE"
    # PAUSE-ON-CAP RESUME: the worktree from the paused delivery is still on disk with
    # its committed AND uncommitted work — REUSE it as-is. Never `-B` (which would
    # reset the branch to base and DESTROY the partial work). If the dir survived,
    # accept it; if (defensively) it vanished, re-attach a worktree onto the EXISTING
    # branch (its commits), never off the base.
    if [ "$_RESUMING" = "1" ]; then
      if [ -e "$rwt" ] && git -C "$rwt" rev-parse --git-dir >/dev/null 2>&1; then
        log "RESUME: reusing preserved worktree for ${rname:-repo} ($rpath) at $rwt on branch $WORK_BRANCH for #$NUM"
        _RESUME_WT_OK=1
      elif git -C "$rpath" worktree add "$rwt" "$WORK_BRANCH" >/dev/null 2>&1; then
        log "RESUME: re-attached worktree for ${rname:-repo} ($rpath) at $rwt on EXISTING branch $WORK_BRANCH for #$NUM (dir was missing)"
        _RESUME_WT_OK=1
      else
        log "RESUME: FAIL — could not reuse/re-attach worktree $rwt on $WORK_BRANCH for ${rname:-repo} ($rpath) for #$NUM"
        WT_FAILED=1
        _RESUME_WT_OK=0
      fi
      if [ "${_RESUME_WT_OK:-0}" = "1" ]; then
        # Prime a fresh Node repo's deps (see the created-worktree path below) so the
        # resume symlink resolves too. Idempotent no-op once node_modules exists.
        _pm_primed="$(gaffer_ensure_node_modules "$rpath")"
        case "$_pm_primed" in
          FAILED:*) log "greenfield: WARN — ${_pm_primed#FAILED:} install did not prime ${rname:-repo} deps (resume); test gate may fail #$NUM (see the diagnostic above)" ;;
          ?*) log "greenfield: primed ${rname:-repo} deps via '$_pm_primed install' (resume) for #$NUM" ;;
        esac
        gaffer_link_node_modules "$rpath" "$rwt"
      fi
      continue
    fi
    # A stale checkout of $WORK_BRANCH in another worktree would block -B; cleanup
    # above should have removed ours, but force-prune once more then add.
    # WASTE CONTROL: a retry (review CHANGES rework, a gate retry, a timeout) used to
    # `worktree add -B`, RESETTING the ticket branch to base and discarding the previous
    # attempt's commits — the reviewer's feedback then described a diff that no longer
    # existed and the agent re-implemented from scratch. The existing branch is now kept
    # (the agent builds on it, or resets deliberately); GAFFER_RETRY_FRESH_BRANCH=1
    # restores the old clean-slate reset.
    _KEPT_COMMITS=""
    if [ "${GAFFER_RETRY_FRESH_BRANCH:-0}" != "1" ] \
       && git -C "$rpath" rev-parse --verify --quiet "refs/heads/$WORK_BRANCH" >/dev/null 2>&1; then
      _KEPT_COMMITS="$(git -C "$rpath" rev-list --count "$rbase..$WORK_BRANCH" 2>/dev/null || echo 0)"
    fi
    if [ -n "$_KEPT_COMMITS" ] && [ "$_KEPT_COMMITS" -gt 0 ] 2>/dev/null \
       && git -C "$rpath" worktree add "$rwt" "$WORK_BRANCH" >/dev/null 2>&1; then
      log "reused worktree for ${rname:-repo} ($rpath) at $rwt on EXISTING branch $WORK_BRANCH for #$NUM — $_KEPT_COMMITS prior commit(s) kept (set GAFFER_RETRY_FRESH_BRANCH=1 for a clean-slate retry)"
      _pm_primed="$(gaffer_ensure_node_modules "$rpath")"
      case "$_pm_primed" in
        FAILED:*) log "greenfield: WARN — ${_pm_primed#FAILED:} install did not prime ${rname:-repo} deps (retry); test gate may fail #$NUM (see the diagnostic above)" ;;
        ?*) log "greenfield: primed ${rname:-repo} deps via '$_pm_primed install' (retry) for #$NUM" ;;
      esac
      gaffer_link_node_modules "$rpath" "$rwt"
    elif git -C "$rpath" worktree add -B "$WORK_BRANCH" "$rwt" "$rbase" >/dev/null 2>&1; then
      _BRANCH_CREATED_THIS_TICK+="$rpath"$'\n'   # this tick owns the branch (BRANCH RETENTION)
      _gaffer_note_branch_cut "$rpath"            # GATE INTEGRITY: the cut commit, now
      log "created worktree for ${rname:-repo} ($rpath) at $rwt on branch $WORK_BRANCH off $rbase for #$NUM"
      # GREENFIELD FIRST-RUN: a freshly-bootstrapped repo has a package.json+lockfile
      # but no node_modules, so the symlink below no-ops and the first ticket's test
      # gate dies on missing modules. Prime the primary repo's install ONCE (runner-
      # side, --ignore-scripts) so the symlink resolves. No-op once node_modules exists.
      _pm_primed="$(gaffer_ensure_node_modules "$rpath")"
      case "$_pm_primed" in
        FAILED:*) log "greenfield: WARN — ${_pm_primed#FAILED:} install did not prime ${rname:-repo} deps (fresh repo); test gate may fail #$NUM (see the diagnostic above)" ;;
        ?*) log "greenfield: primed ${rname:-repo} deps via '$_pm_primed install' (fresh repo had no node_modules) for #$NUM" ;;
      esac
      # JS/TS repos can't test/build in a fresh worktree: node_modules is gitignored,
      # lives only in the main checkout, and installs are hook-blocked. Link the real
      # repo's node_modules (root + per-package) in so `pnpm test`/`build` resolve.
      gaffer_link_node_modules "$rpath" "$rwt"
    else
      log "FAIL: could not add worktree $rwt on $WORK_BRANCH (base $rbase) for write repo ${rname:-repo} ($rpath) for #$NUM"
      WT_FAILED=1
    fi
  done <<< "$WT_ROWS"
  if [ "$WT_FAILED" = "1" ]; then
    if [ "$_RESUMING" = "1" ]; then
      # A resume that could not reuse/re-attach its worktree must NOT drop the branch
      # (it may still carry the paused work). Leave everything as-is for a human; keep
      # the worktree-retention flag so nothing is torn down.
      gaffer_skip_ticket "$NUM"
      log "RESUME FAILED for #$NUM — could not reuse the paused worktree; branch $WORK_BRANCH left intact for a human"
      gaffer_resume_abort "the paused worktree could not be reused or re-attached"
      result error; exit 0
    fi
    # Roll back anything partially created so a failed setup leaves no residue, and
    # release the runner-held claim back to `ready` (nothing was produced — a retry is
    # safe on a later tick).
    gaffer_cleanup_worktrees drop-branch
    gaffer_release_delivery ready "worktree setup failed — no work produced; retry"
    gaffer_skip_ticket "$NUM"
    log "delivery FAILED for #$NUM — a write repo could not be worktree'd; not running the agent"
    result error; exit 0
  fi

  # GATE INTEGRITY: fix the commit each delivery branch was cut from NOW, before the
  # agent runs, and record it on the repo delivery (`--base-sha`, no branch, so it is
  # not delivery evidence). The DoD gate reads its package.json scripts from that
  # commit and the integrity scans (the runner's row and dispatch's server-side
  # `test-modified`) diff from it — never from the base branch NAME, which the agent
  # could move from inside its worktree (`git branch -f main HEAD`). The base is the
  # commit captured when `worktree add -B` cut the branch (_BRANCH_CUT_SHAS); a kept or
  # resumed branch — and every in-tick retry that did not re-cut — keeps the commit
  # already known (stored in dispatch, else this tick's earlier pass). A stored base is
  # write-once: dispatch replaces it only on `--base-recut`. Fail-soft: an unrecorded
  # base still pins this tick's gates; the base branch name is the last resort.
  _DELIV_BASE_SHAS=""
  _gaffer_record_delivery_bases() {
    local rid rname rpath rbase rwt _cut _prev _stored _sha _list _prev_map _recut
    _prev_map="$_DELIV_BASE_SHAS"
    _DELIV_BASE_SHAS=""
    _list="$(wg ticket repo-delivery list "$NUM" 2>/dev/null || echo '[]')"
    while IFS=$'\t' read -r rid rname rpath rbase rwt; do
      [ -n "$rpath" ] || continue
      rbase="${rbase:-main}"
      _cut="$(_gaffer_branch_cut_sha "$rpath")"
      _prev="$(awk -F'\t' -v p="$rpath" '$1==p{print $2; exit}' <<<"$_prev_map")"
      _stored="$(printf '%s' "$_list" | RID="$rid" RNAME="$rname" jget '(() => {
        const rows = Array.isArray(d) ? d : [];
        const r = rows.find((x) => (process.env.RID && x.repo_id === process.env.RID) || (process.env.RNAME && x.repo_name === process.env.RNAME));
        return r && typeof r.base_sha === "string" ? r.base_sha : "";
      })()' 2>/dev/null || echo '')"
      _sha="$(gaffer_delivery_base_sha "$rpath" "$rbase" "$WORK_BRANCH" "$_cut" "$_stored" "$_prev")"
      if [ -z "$_sha" ]; then
        log "GATE INTEGRITY: could not resolve the commit $WORK_BRANCH was cut from in ${rname:-repo} ($rpath) for #$NUM — the gates fall back to the base branch $rbase"
        continue
      fi
      _DELIV_BASE_SHAS+="$rpath"$'\t'"$_sha"$'\n'
      [ "$_sha" = "$_stored" ] && continue
      # Only a commit this tick cut the branch at may replace a stored base.
      _recut=""; [ -n "$_cut" ] && [ "$_sha" = "$_cut" ] && [ -n "$_stored" ] && _recut="--base-recut"
      if wg ticket repo-delivery record "$NUM" "${rid:-$rname}" --base-sha "$_sha" $_recut --as system >/dev/null 2>&1; then
        log "GATE INTEGRITY: #$NUM ${rname:-repo} delivery base recorded: $(printf '%s' "$_sha" | cut -c1-12) (off $rbase${_recut:+, branch re-cut})"
      else
        log "GATE INTEGRITY: #$NUM ${rname:-repo} delivery base $(printf '%s' "$_sha" | cut -c1-12) did not record (non-fatal; this tick's gates still use it)"
      fi
    done <<< "$WT_ROWS"
  }
  # The recorded base commit for a write repo (empty when none was resolved).
  _gaffer_delivery_base_for() { awk -F'\t' -v p="$1" '$1==p{print $2; exit}' <<<"$_DELIV_BASE_SHAS"; }
  _gaffer_record_delivery_bases

  # Live: install the factory's MCP servers, safety hook + permissions, skills and
  # brief as PROJECT-LOCAL config so headless Claude auto-loads them, then run. The
  # PreToolUse hook is the safety boundary; env carries the two server DB paths.
  # Fail CLOSED: the safety hook is THE deterministic boundary. If it's missing,
  # never run a live agent — Claude Code would otherwise run with no boundary.
  gaffer_assert_safety_hook || gaffer_abort_setup SAFETY "refusing live run (fail closed)"

  # ── Agent-environment install (runs before EVERY attempt's launch) ──────────
  # Installs the project-local agent environment into the PRIMARY write worktree
  # (the agent's cwd; in single-repo mode PRIMARY_REPO == the one delivery worktree):
  #   • the ticket's skill mount — ONLY the selected SKILLS + quality LENSES + the
  #     universal delivery-mechanics set, not the whole library (~5k fewer
  #     tokens/call). Fail-soft inside: whole-library fallback (skills-mount.sh);
  #   • .claude/settings.json — wires runner/safety-hook.mjs as the PreToolUse
  #     hook, THE deterministic containment boundary. The template ships a
  #     ${RUNNER_DIR} placeholder; copying it verbatim would point at the
  #     author's machine and the hook would FAIL OPEN elsewhere — substitute it;
  #   • CLAUDE.factory.md — the factory brief;
  #   • the git exclude that keeps all of the above off the delivery branch.
  # WHY per-attempt, not once: the rework retry path (GUARD B) tears the
  # worktree down between attempts (gaffer_cleanup_worktrees) and re-adds a
  # FRESH checkout of the preserved branch. All of this config is untracked and
  # git-excluded, so the fresh checkout contains NONE of it — a retry launched
  # without a re-install would run WITHOUT the safety hook wired (uncontained).
  # FAIL-CLOSED: returns non-zero unless the written settings verifiably wire
  # the hook; callers must NOT launch the agent for that attempt on failure —
  # launching without the hook is the one unacceptable outcome.
  gaffer_install_agent_env() {
    gaffer_assert_safety_hook || { log "SAFETY: refusing to prepare the agent env (fail closed)"; return 1; }
    # Skills mount + render/VERIFY settings.json (PreToolUse safety-hook wiring) +
    # workspace trust + the brief — the ONE shared installer (lib/agent-env.sh) the
    # reviewer and clarify sites use too; any failure fails closed.
    gaffer_install_agent_dir "$PRIMARY_REPO" "$SKILLS, $LENSES" "delivery-$NUM" || return 1
    gaffer_exclude_runner_config "$PRIMARY_REPO"   # keep runner config out of `git add -A`
    return 0
  }
  # Attempt 1's install (the retry loop re-runs it for every later attempt).
  gaffer_install_agent_env || gaffer_abort_setup SAFETY "agent-env install failed for #$NUM — refusing live run (fail closed)"
  # Substitute the real DB paths into a RUNTIME copy OUTSIDE the repo. Writing into
  # $PRIMARY_REPO/.mcp.json breaks when the target repo IS the runner itself (source
  # == destination → the redirect truncates the file → "Invalid MCP configuration").
  MCP_RUNTIME="$GAFFER_DATA/mcp-runtime.$$.json"
  gaffer_assert_db_vars || gaffer_abort_setup DB-VARS "DISPATCH_DB/MEMORY_DB empty — refusing live run (fail closed)"
  # RUNNER-OWNED-BOOKKEEPING: inject the runner-held claim token into the dispatch
  # MCP server env (GAFFER_CLAIM_TOKEN) so the agent's token-gated evidence writes
  # resolve it from the server env — the agent never handles the token. A resumed
  # delivery carries the lease token resume-begin took; only a tokenless resume
  # fallback leaves it empty, which the MCP server treats as "no token".
  #
  # MEMORY-SCOPE BINDING: the ticket's in-scope repo NAMES (WT_ROWS col-2, the
  # names sourced from repositories.name in the same rows that produce
  # GAFFER_WRITE_ROOTS) are injected as ${GAFFER_TICKET_REPOS} so the memory MCP
  # server can refuse a DIRECT-APPLY write (digest / feature) targeting a repo
  # this ticket has no scope over. COLON-joined (not newline) so the value stays
  # a single-line, valid JSON string; empty names are skipped (an unnamed repo is
  # not a memory-write target). Paired with GAFFER_FACTORY=1 (a literal in the
  # template) which arms the guard — standalone memory-mcp never sets it.
  # shellcheck disable=SC2034  # read by gaffer_render_mcp_runtime (factory.config.sh)
  GAFFER_TICKET_REPOS="$(printf '%s\n' "$WT_ROWS" | grep . | awk -F'\t' '$2!=""{print $2}' | paste -sd: -)"
  # CARD-CANONICAL BINDING: each ticket repo's name → the canonical its file cards
  # are keyed under (WT_ROWS col-3 is the REAL repo, not the worktree), rendered into
  # the memory server as ${GAFFER_REPO_CANONICALS}. The agent's card tools then find
  # the cards from its worktree without guessing a canonical — for a repo with no
  # remote its guess (the worktree path) matched nothing. Fail-soft: empty ⇒ unbound.
  # shellcheck disable=SC2034  # read by gaffer_render_mcp_runtime (factory.config.sh)
  GAFFER_REPO_CANONICALS="$(printf '%s\n' "$WT_ROWS" | grep . | awk -F'\t' '{print $2 "\t" $3}' | gaffer_repo_canonicals_json)"
  # MEMORY ROI: the delivery ticket ref is injected as ${GAFFER_RECALL_TICKET} so
  # the memory MCP server's READ path can attribute a retrieval to this ticket
  # (best-effort, fail-soft). Empty ⇒ the read path logs nothing (inert), exactly
  # like standalone memory-mcp. Same one-hop plumbing pattern as GAFFER_TICKET_REPOS.
  # Render via the single seam (factory.config.sh → packages/crew renderMcpCli.js).
  # Recall is the ticket $NUM so the memory read path can attribute a retrieval to it.
  # Fail-closed: a render error (ts renderer rejects a broken/drifted template)
  # must abort the delivery before the agent launch — the bare sed never did.
  # FACTORY TICKET SCOPE: the scope ticket ($NUM, rendered into the dispatch server's
  # GAFFER_SCOPE_TICKET) makes the server refuse the agent's writes (ACs, dependencies,
  # test contract, decisions…) on any other ticket — also on a resume, where the claim
  # token is empty.
  gaffer_render_mcp_runtime "$MCP_CONFIG" "$MCP_RUNTIME" "$NUM" "$NUM" \
    || gaffer_abort_setup MCP-RENDER "failed to render delivery runtime .mcp.json — refusing live run (fail closed)"
  chmod 600 "$MCP_RUNTIME" 2>/dev/null || true  # carries the live claim token — owner-only
  # ── P1b GOLDEN CAPTURE (docs/tick-sh-runtime-migration.md) ──────────────────
  # Default-OFF dump of the assembled context (the delivery PROMPT + the rendered
  # MCP runtime config) so the TS renderer (packages/crew/src/runtime/context/)
  # can be byte-compared against this bash path. With GAFFER_CONTEXT_DUMP_ONLY=1
  # the tick additionally exits BEFORE the agent launch (render-only fixture
  # capture: the claim is released back to ready and the EXIT trap tears the
  # worktrees + branch down). Both vars unset ⇒ byte-identical behaviour.
  if [ -n "${GAFFER_CONTEXT_DUMP_DIR:-}" ]; then
    mkdir -p "$GAFFER_CONTEXT_DUMP_DIR" 2>/dev/null || true
    printf '%s' "$PROMPT" > "$GAFFER_CONTEXT_DUMP_DIR/prompt.txt"
    cp -f "$MCP_RUNTIME" "$GAFFER_CONTEXT_DUMP_DIR/mcp-runtime.json"
    if [ "${GAFFER_CONTEXT_DUMP_ONLY:-0}" = "1" ]; then
      gaffer_release_delivery ready "context-dump render-only exit (P1b fixture capture)"
      log "context-dump: wrote prompt + mcp-runtime to $GAFFER_CONTEXT_DUMP_DIR; exiting before agent launch"
      result no_work; exit 0
    fi
  fi
  # Repo-access boundary (FG-007): tell the runtime safety hook the exact set of
  # repos this run may WRITE to (GAFFER_WRITE_ROOTS) and additionally READ from
  # (GAFFER_READ_ROOTS). The hook then deterministically blocks writes/branches
  # outside the write roots and reads outside (write ∪ read) roots — the boundary
  # becomes real enforcement, not prompt text. Roots are newline-separated absolute
  # paths (the format the hook's parser expects). In single-repo / mono-fallback
  # mode WRITE_ROOTS is exactly the one delivery repo and READ_ROOTS is empty, so
  # the hook applies the same single-write-root rule as today.
  # The run log captures any hook BLOCK (stderr → $GAFFER_LOG); we scan that slice
  # afterwards to surface boundary violations (FG-007 AC, best-effort).
  RUN_LOG_MARK="$(wc -l < "$GAFFER_LOG" 2>/dev/null || echo 0)"
  # ── Strict execution mode (OPTIONAL, best-effort OS-level containment) ──────
  # When STRICT_MODE=1 we additionally wrap the live `claude -p` in an OS sandbox
  # PROVIDER (sandbox-exec or docker; a microVM provider is a design sketch) so writes
  # the in-process safety hook can't see (dynamic paths in `python3 -c …`, exec'd
  # children) are refused by the OS, not just by our shell. The provider is fed
  # the SAME write/read roots the safety hook uses. WRAP is a command prefix
  # ("sandbox-exec -f <profile>") or EMPTY (provider none/unsupported → no extra
  # containment; worktree isolation + safety hook still apply). STRICT_MODE=0
  # leaves WRAP empty, so the invocation below is byte-for-byte as before.
  WRAP=""
  # VALIDATION ISOLATION: the DoD gates (tests / typecheck / lint) and the AC check
  # commands run code the agent has just modified — a test file, an import, a config —
  # with the RUNNER's privileges. Sandboxing only `claude -p` left that step bare. The
  # same OS wrap the agent gets is handed to lib/dod.sh (gaffer_dod_run_one) through
  # GAFFER_DOD_WRAP, so under an active provider the gate commands run inside the same
  # container / profile with the same write roots. Empty when no provider wraps the
  # agent (then the gates are only as contained as the agent was — documented in
  # SECURITY.md). GAFFER_DOD_SANDBOX=0 opts a repo out (a gate that cannot run inside
  # the image); the verdict is still recorded by the runner, outside the gate process.
  export GAFFER_DOD_WRAP=""
  # Consult the provider when the sandbox is ON (STRICT_MODE=1) OR REQUIRED
  # (GAFFER_STRICT_REQUIRE — auto-set by every autonomy flag). Gating this on
  # STRICT_MODE alone let `GAFFER_MODE=autonomous` announce "fails closed without an
  # OS sandbox" and then launch uncontained, because nothing here ever asked.
  if [ "${STRICT_MODE:-0}" = "1" ] || _sandbox_strict_required; then
    # C4: sandbox_wrap_cmd returns NON-ZERO only when GAFFER_STRICT_REQUIRE=1 and no OS
    # sandbox provider is available — a hard fail-closed: the operator demanded OS
    # containment this host can't supply, so we do NOT launch the agent uncontained.
    if WRAP="$(sandbox_wrap_cmd "$WRITE_ROOTS" "$READ_ROOTS" 2>>"$GAFFER_LOG")"; then
      if [ -n "$WRAP" ]; then
        log "STRICT_MODE active: wrapping live agent via provider '${SANDBOX_PROVIDER:-sandbox-exec}' ($WRAP)"
        case "${GAFFER_DOD_SANDBOX:-1}" in
          0|false|no|off) log "STRICT_MODE: GAFFER_DOD_SANDBOX=0 — DoD gates + AC checks run OUTSIDE the OS sandbox (operator opt-out)" ;;
          *) export GAFFER_DOD_WRAP="$WRAP"
             log "STRICT_MODE: DoD gates + AC checks will run under the same OS sandbox as the agent" ;;
        esac
      else
        log "STRICT_MODE active but provider '${SANDBOX_PROVIDER:-sandbox-exec}' added no OS sandbox — worktree isolation + safety hook still apply"
      fi
    else
      log "STRICT_REQUIRE: no OS sandbox provider available on this host — refusing to launch the agent (fail closed)"
      wg attach-evidence "$NUM" --type manual_note \
        --summary "PARKED (strict_require_unavailable): GAFFER_STRICT_REQUIRE=1 but no OS sandbox provider is available on this host — the agent was NOT launched (fail closed)" >/dev/null 2>&1 || true
      gaffer_release_delivery blocked "GAFFER_STRICT_REQUIRE=1 but no OS sandbox provider available — fail closed, agent not launched" strict_require_unavailable
      gaffer_skip_ticket "$NUM"
      result error; exit 0
    fi
  fi
  # ── GUARD B: recoverable-delivery attempt loop ──────────────────────────────
  # The agent invocation + every DOWNSTREAM gate (DoD / hygiene / minimalism /
  # empty-but-committed) run inside this bounded loop. A RECOVERABLE failure (the
  # agent produced ≥1 commit but a gate failed) PRESERVES the branch, attaches the
  # gate's output as a rework note, and `continue`s to re-invoke the SAME agent on
  # the SAME branch with that feedback — up to GAFFER_MAX_DELIVERY_ATTEMPTS. When
  # attempts exhaust, the recoverable handler parks the ticket to `refining` WITH
  # the branch + feedback (never silent-discards). UNRECOVERABLE failures (no
  # commit / empty / crash / safety / cap-hit) keep today's behaviour and break
  # out of the loop via their own `exit 0`. The INVARIANT — a delivery with ≥1
  # commit NEVER has its branch deleted by the failure path — is enforced by
  # routing every committed-branch failure through gaffer_cleanup_worktrees with
  # NO drop-branch.
  _MAX_DELIVERY_ATTEMPTS="${GAFFER_MAX_DELIVERY_ATTEMPTS:-3}"
  [ "$_MAX_DELIVERY_ATTEMPTS" -ge 1 ] 2>/dev/null || _MAX_DELIVERY_ATTEMPTS=1
  _DELIV_ATTEMPT=0
  # ESCALATION + REAL FEEDBACK state (RUNNER-OWNED REWORK LOOP):
  #   _REWORK_HISTORY  — the accumulated, distilled real failures from EVERY prior
  #                      attempt (the crux: the actual failing test + assertion, not a
  #                      gate-name summary). Fed into the next attempt's prompt so the
  #                      agent can self-correct; the FINAL attempt sees the full trail.
  #   _REWORK_BLOCK    — the per-attempt prompt suffix built from the history + the
  #                      escalation posture (rethink / stronger model). Empty on attempt 1.
  _REWORK_HISTORY=""
  _REWORK_BLOCK=""
  #   _LAST_REAL_FAILURE — the distilled failure of the previous attempt. An attempt
  #                        that reproduces it BYTE-FOR-BYTE is not converging; the loop
  #                        parks then instead of paying the remaining attempts (WASTE
  #                        CONTROL — a live run paid three turns against one unchanged
  #                        failing assertion).
  _LAST_REAL_FAILURE=""

  # _recover_or_park <gate-name> <feedback-text> [real-failure-detail]
  # A RECOVERABLE gate failure (branch carries ≥1 commit). PRESERVES the branch —
  # tears down ONLY the disposable worktree — records the REAL failure (the distilled
  # failing test + assertion, arg 3 when present; else the summary) for the next
  # attempt, then decides against the DOUBLE-BOUND (attempt cap AND per-ticket cost):
  #   • budget/attempts remain → _DELIV_OUTCOME=retry; the ticket stays VISIBLY
  #     in_progress with "reworking · attempt N/M" + the latest failure on its card
  #     (wg runner-rework), and the caller `continue`s so the loop re-invokes the
  #     escalated agent on the same branch with the accumulated feedback;
  #   • cap OR per-ticket cost ceiling hit → park the ticket to the VISIBLE `blocked`
  #     column (rework_exhausted) WITH the branch + full feedback trail, then
  #     _DELIV_OUTCOME=parked so the caller exits. The branch is NEVER dropped here.
  _recover_or_park() {
    local gate="$1" feedback="$2" detail="${3:-}"
    # TICK DEADLINE: how long this attempt's gates took after the agent returned — the
    # next attempt needs about as much again on top of the agent call.
    _GATE_SECS_LAST=$(( $(date +%s) - ${_T_AGENT_DONE:-$(date +%s)} ))
    # The REAL failure fed to the next attempt: the distilled assertion/error when the
    # caller captured one, else the human summary. This is the crux of (b) — the agent
    # sees the actual failing test, not just "tests@repo failed".
    local real="${detail:-$feedback}"
    # FIX-BRANCH (rework + park): from here on the branch carries ≥1 commit — it is
    # salvageable work whatever happens next (a retry, the park, a kill mid-rework).
    # Raise retention NOW so the EXIT trap tears down only the worktree. The park path
    # used to `exit` with KEEP=0 (retention is otherwise raised just before submit,
    # AFTER the gates), and the trap `drop-branch`ed the very branch the log had just
    # called PRESERVED — a live run lost a five-commit bootstrap branch that way.
    GAFFER_KEEP_DELIVERY_BRANCH=1
    # AGENT-SIDE PARK: the agent may itself have moved the ticket to `blocked` during
    # this attempt (mark_ticket_blocked through the dispatch MCP, typically after opening
    # a human_required decision; the decision alone does not change the status). Its
    # claim is gone with that transition, so another attempt burns a paid agent turn on
    # a ticket that already waits on a human, and the runner's own release then fails
    # CLAIM_INVALID. End the loop instead: keep the branch, drop the worktree, leave the
    # ticket where the agent parked it, and skip it for the rest of this run.
    local _cur_status
    _cur_status="$(wg ticket show "$NUM" 2>/dev/null | jget 'd.ticket.status' 2>/dev/null || echo '')"
    if [ "$_cur_status" = "blocked" ]; then
      GAFFER_CLAIM_RESOLVED=1
      gaffer_cleanup_worktrees
      gaffer_skip_ticket "$NUM"
      log "RECOVER: #$NUM is already 'blocked' (the agent parked it on a decision during attempt $_DELIV_ATTEMPT) — ending the rework loop without another attempt; branch $WORK_BRANCH PRESERVED, worktree removed"
      _DELIV_OUTCOME="parked"
      return 0
    fi
    # NOT CONVERGING: the same distilled failure as the previous attempt (identical text)
    # means the rework changed nothing that mattered. Park now — the next attempt would
    # be a third paid turn against the same wall, and a human is the right reader.
    local _repeat=0
    if [ "$_DELIV_ATTEMPT" -ge 2 ] && [ -n "$_LAST_REAL_FAILURE" ] && [ "$real" = "$_LAST_REAL_FAILURE" ]; then
      _repeat=1
    fi
    _LAST_REAL_FAILURE="$real"
    # Accumulate the full trail so the FINAL (stronger-model) attempt sees every prior
    # failure, not just the latest — bounded so a chatty run can't unbound the prompt.
    _REWORK_HISTORY="${_REWORK_HISTORY}
── attempt $_DELIV_ATTEMPT — $gate ──
$real
"
    _REWORK_HISTORY="$(printf '%s' "$_REWORK_HISTORY" | tail -c "${GAFFER_REWORK_HISTORY_BYTES:-8000}")"
    # NOTE (dedupe): the failure text used to ALSO be attached here as a manual_note
    # evidence record — persisting it twice per attempt. The durable persistence now
    # lives in exactly one place per outcome: the retry path's `wg runner-rework
    # --failure` (appends the full block to the ticket's rework trail + event) and
    # the park path's release reason (last_review_feedback + ticket.blocked event).

    # DOUBLE-BOUND — cost side: stop the loop if this ticket's cumulative measured
    # rework spend has reached the per-ticket ceiling, even when attempts remain. No
    # unbounded token burn on one stubborn ticket.
    local _cost_exhausted=0
    # TRACK-3a: the FIRST-CLASS per-ticket delivery budget (tickets.delivery_budget_usd,
    # inherited from the epic) is the ceiling when set; else the factory-wide env
    # default (GAFFER_REWORK_BUDGET_USD). A per-ticket budget lets an operator cap one
    # expensive ticket without touching the global default.
    local _ticket_budget _eff_ceiling
    _ticket_budget="$(printf '%s' "${SHOW:-}" | jget 'd.ticket.delivery_budget_usd' 2>/dev/null || true)"
    case "$_ticket_budget" in ""|None|null) _ticket_budget="" ;; esac
    if [ -n "$_ticket_budget" ] && _num_pos "$_ticket_budget"; then
      _eff_ceiling="$_ticket_budget"
    else
      _eff_ceiling="${GAFFER_REWORK_BUDGET_USD:-}"
    fi
    if [ -n "$_eff_ceiling" ] \
       && _num_pos "$_eff_ceiling"; then
      local _spent; _spent="$(gaffer_ticket_rework_spend "$NUM" 2>/dev/null || echo 0)"
      if _num_ge "$_spent" "$_eff_ceiling"; then
        _cost_exhausted=1
        local _src="factory default"; [ -n "$_ticket_budget" ] && _src="per-ticket budget"
        log "REWORK: #$NUM hit the ${_src} cost ceiling (spent \$${_spent} ≥ \$${_eff_ceiling}) on attempt $_DELIV_ATTEMPT — parking to blocked (no unbounded burn)"
      fi
    fi

    if [ "$_DELIV_ATTEMPT" -lt "$_MAX_DELIVERY_ATTEMPTS" ] && [ "$_cost_exhausted" -eq 0 ] && [ "$_repeat" -eq 0 ]; then
      # VISIBILITY: keep the ticket in its live column but surface the rework state +
      # the latest real failure on the card ("Reworking · attempt N/M"). No status
      # change — it stays claimed/in_progress (visible), never routed to refining.
      local _next=$((_DELIV_ATTEMPT + 1))
      local _short; _short="$(printf '%s' "$real" | grep -v '^[[:space:]]*$' | head -1)"
      # FAILURE-DIAGNOSIS: pass BOTH the short one-line reason (the board chip) AND
      # the FULL distilled failure ($real — the real failing test + assertion/stack)
      # so the durable per-ticket trail keeps the full block, not the truncated
      # summary. Fail-soft: a persist error never fails the delivery loop.
      [ "${DRY_RUN:-0}" = "1" ] || wg runner-rework "$NUM" --attempt "$_next" --max "$_MAX_DELIVERY_ATTEMPTS" \
        --reason "${gate}: ${_short:-failed}" --gate "$gate" --failure "$real" >/dev/null 2>&1 || true
      # Preserve the branch; tear down only the worktree so the next attempt re-adds
      # a fresh worktree on the SAME branch (the branch ref + its history live in the
      # real repo between attempts).
      gaffer_cleanup_worktrees
      log "RECOVER: #$NUM $gate failed on attempt $_DELIV_ATTEMPT — branch $WORK_BRANCH PRESERVED; re-invoking the agent with the real failure (attempt $_next/$_MAX_DELIVERY_ATTEMPTS)"
      _DELIV_OUTCOME="retry"
      return 0
    fi

    # Cap OR per-ticket cost ceiling hit — park to the VISIBLE `blocked` column WITH
    # the branch + feedback (rework_exhausted). NEVER drop the branch: a delivery with
    # commits keeps its salvageable work. RUNNER-OWNED-BOOKKEEPING: the runner holds
    # the claim and has NOT submitted (the gate ran pre-submit), so the ticket is
    # `claimed`/`in_progress` — release/park it via the runner-release path so the
    # claim is freed AND a human immediately sees it on the board (never `refining`,
    # which hides in the draft column). A stray in_review ticket is unreachable here
    # (the runner submits only AFTER the gate passes); if one ever occurred the
    # runner-release transition is a no-op that logs a loud WARNING — fail-safe.
    local _why="rework budget"; [ "$_cost_exhausted" -eq 0 ] && _why="$_MAX_DELIVERY_ATTEMPTS attempts"
    [ "$_repeat" -eq 1 ] && _why="an identical failure on attempts $((_DELIV_ATTEMPT - 1)) and $_DELIV_ATTEMPT (not converging; $((_MAX_DELIVERY_ATTEMPTS - _DELIV_ATTEMPT)) attempt(s) not spent)"
    local _reason="$gate failed after $_why: $real (branch $WORK_BRANCH preserved)"
    # FAILURE TRAIL: the attempt that used up the bounds failed too, so it goes on the
    # trail like every earlier one (same numbering: the failure of attempt N is filed
    # as N+1), BEFORE the park. `--final` appends the trail row only — no "reworking"
    # card or event; the release below sets the parked card. Without it the ticket page
    # read "Attempt N/N not taken" for an attempt that was tried. Fail-soft.
    local _fshort; _fshort="$(printf '%s' "$real" | grep -v '^[[:space:]]*$' | head -1)"
    [ "${DRY_RUN:-0}" = "1" ] || wg runner-rework "$NUM" --attempt "$((_DELIV_ATTEMPT + 1))" --max "$_MAX_DELIVERY_ATTEMPTS" \
      --reason "${gate}: ${_fshort:-failed}" --gate "$gate" --failure "$real" --final >/dev/null 2>&1 || true
    gaffer_release_delivery blocked "$_reason" rework_exhausted "$_DELIV_ATTEMPT" "$_MAX_DELIVERY_ATTEMPTS"
    # MEMORY FEEDBACK LOOP: this ticket exhausted rework and parked to blocked —
    # the knowledge served into its context did NOT help. Demote + flag it.
    gaffer_recall_feedback blocked
    log "RECOVER: parked #$NUM (→ blocked, rework_exhausted) after $_why — branch $WORK_BRANCH PRESERVED for rework, VISIBLE on the board"
    # Tear down ONLY the worktree; the branch survives for rework.
    gaffer_cleanup_worktrees
    gaffer_skip_ticket "$NUM"
    log "delivery PARKED for #$NUM — $gate not met (rework_exhausted, $_why); worktree removed, branch $WORK_BRANCH PRESERVED, VISIBLE in blocked"
    _DELIV_OUTCOME="parked"
    return 0
  }

  # ESCALATION LADDER — build the per-attempt prompt suffix + implement-model flag.
  # Sets two globals read by the invocation below:
  #   _REWORK_BLOCK       — appended to the base PROMPT so the re-invoked agent sees
  #                         the REAL prior failure(s) + its escalation posture.
  #   _ATTEMPT_IMPL_FLAG  — the model flag for THIS attempt (routed model by default;
  #                         the FINAL attempt escalates to GAFFER_REWORK_STRONG_MODEL).
  # Attempt 1: routed model, no rework suffix (base prompt).
  # Attempt 2..(max-1): RETHINK — same model, but re-plan the approach (the prior
  #                     approach failed the SAME gate; a tweak won't do) with the trail.
  # Attempt max: STRONGER MODEL + the FULL feedback history (the last shot before a
  #              human is pulled in).
  gaffer_build_escalation() {
    local attempt="$1"
    _ATTEMPT_IMPL_FLAG="$ROUTE_IMPL_FLAG"
    _REWORK_BLOCK=""
    [ "$attempt" -le 1 ] && return 0
    local is_final=0
    [ "$attempt" -ge "$_MAX_DELIVERY_ATTEMPTS" ] && is_final=1
    # Model escalation only on the FINAL attempt (and only if a strong model is set
    # and the loop actually has >1 attempt to climb).
    local posture
    if [ "$is_final" = "1" ] && [ "$_MAX_DELIVERY_ATTEMPTS" -gt 1 ] && [ -n "${GAFFER_REWORK_STRONG_MODEL:-}" ]; then
      _ATTEMPT_IMPL_FLAG="--model $GAFFER_REWORK_STRONG_MODEL"
      posture="FINAL REWORK ATTEMPT (attempt $attempt/$_MAX_DELIVERY_ATTEMPTS) — you are the STRONGEST model on this ticket and this is the LAST attempt before it is parked to \`blocked\` for a human. The previous attempts failed the gate below. Do NOT repeat them: read the FULL failure trail, form a correct fix, and make every gate pass."
    else
      posture="RETHINK (attempt $attempt/$_MAX_DELIVERY_ATTEMPTS) — your previous approach FAILED the same gate. Do NOT just tweak it: step back, RE-PLAN the approach from the failure below (optionally narrow the scope to the smallest correct change), then implement and make the gate pass."
    fi
    # The failure trail is UNTRUSTED gate output — quarantine it (same envelope as the
    # prior-review-feedback block) so an injected string in a test name can't steer the agent.
    local _trail_q; _trail_q="$(gaffer_quarantine rework-feedback "$_REWORK_HISTORY" 2>/dev/null || printf '%s' "$_REWORK_HISTORY")"
    _REWORK_BLOCK="
REVIEW FEEDBACK — THIS DELIVERY WAS REWORKED. $posture
The block below is the ACTUAL failure(s) from your prior attempt(s) on this SAME
branch (the failing test name + the assertion/error), not a summary. The prior
attempt's commits are still on this branch — keep what is right and fix what failed.
Fix EXACTLY this:
$_trail_q
"
  }

  # ── TICK DEADLINE GUARD (GAFFER_TICK_DEADLINE_GUARD) ────────────────────────
  # The outer per-tick bound is sized for agent calls only (attempts × timeout + 2 min)
  # but this tick also spent the merge lane, setup and each attempt's install, gates
  # and AC checks; a live run had its FINAL strong-model attempt killed mid-flight —
  # spend wasted, nothing recorded, the branch at the trap's mercy, and the next tick
  # re-claiming from attempt 1. Before starting an attempt, require the time left to
  # cover one full agent call plus what the previous attempt's gates took; otherwise
  # hand the ticket to the next tick with its branch kept (released to ready, bounded
  # across runs through the same counter as a no-commit failure). Gate/AC timeouts
  # are clamped to the time left so a gate cannot outlive the bound either.
  # Attempt 1 is never refused for a short budget (nothing is spent yet, and a slow
  # merge lane or first install would otherwise park a ticket that was never tried):
  # its agent call is instead clamped to the time left, so the call's own timeout
  # (pause-eligible, work kept) fires before the outer bound would kill the tick. It
  # is handed off only when no time is left at all.
  _GATE_SECS_LAST=0; _T_AGENT_DONE=""
  _DOD_TIMEOUT_CFG="${GAFFER_DOD_TIMEOUT:-900}"; _DOD_INSTALL_TIMEOUT_CFG="${GAFFER_DOD_INSTALL_TIMEOUT:-$_DOD_TIMEOUT_CFG}"
  _TICK_TIMEOUT_CFG="${GAFFER_TICK_TIMEOUT:-1800}"; _AGENT_TIMEOUT="$_TICK_TIMEOUT_CFG"
  gaffer_deadline_short() {
    local rem need
    rem="$(gaffer_tick_remaining)"
    need=$(( _TICK_TIMEOUT_CFG + ${_GATE_SECS_LAST:-0} ))
    _AGENT_TIMEOUT="$_TICK_TIMEOUT_CFG"
    [ "$rem" -lt "$need" ] || return 1
    _DEADLINE_REM="$rem"; _DEADLINE_NEED="$need"
    if [ "$_DELIV_ATTEMPT" -le 1 ] && [ "$rem" -ge 1 ]; then
      [ "$rem" -lt "$_AGENT_TIMEOUT" ] && _AGENT_TIMEOUT="$rem"
      log "DEADLINE: #$NUM attempt 1 has ${rem}s before the outer per-tick bound (needs ~${need}s) — starting it with the agent call clamped to ${_AGENT_TIMEOUT}s"
      return 1
    fi
    return 0
  }
  gaffer_deadline_handoff() {
    local why="attempt $_DELIV_ATTEMPT/$_MAX_DELIVERY_ATTEMPTS needs ~${_DEADLINE_NEED}s (GAFFER_TICK_TIMEOUT ${_TICK_TIMEOUT_CFG}s + ${_GATE_SECS_LAST:-0}s of gates) but only ${_DEADLINE_REM}s are left before the outer per-tick bound"
    log "DEADLINE: #$NUM $why — not starting it; the next tick continues on branch $WORK_BRANCH"
    # Keep the branch (a retry already tore the worktree down, so its commits can only
    # be seen on the branch itself); an empty one is simply re-created next tick.
    GAFFER_KEEP_DELIVERY_BRANCH=1
    gaffer_cleanup_worktrees
    if [ "$_RESUMING" = "1" ]; then
      gaffer_resume_abort "tick deadline: $why"
    else
      gaffer_release_or_park_nocommit "tick deadline: $why; branch kept for the next tick" \
        "the rework ladder did not fit inside one tick's outer bound"
    fi
    gaffer_skip_ticket "$NUM"
  }
  gaffer_clamp_gate_timeouts() {
    local rem; rem="$(gaffer_tick_remaining)"
    [ "$rem" -ge 1 ] || rem=1
    GAFFER_DOD_TIMEOUT="$_DOD_TIMEOUT_CFG"; GAFFER_DOD_INSTALL_TIMEOUT="$_DOD_INSTALL_TIMEOUT_CFG"
    [ "$rem" -lt "$GAFFER_DOD_TIMEOUT" ] 2>/dev/null && GAFFER_DOD_TIMEOUT="$rem"
    [ "$rem" -lt "$GAFFER_DOD_INSTALL_TIMEOUT" ] 2>/dev/null && GAFFER_DOD_INSTALL_TIMEOUT="$rem"
    return 0
  }

  while [ "$_DELIV_ATTEMPT" -lt "$_MAX_DELIVERY_ATTEMPTS" ]; do
  _DELIV_ATTEMPT=$((_DELIV_ATTEMPT + 1))
  _DELIV_OUTCOME=""
  if [ "${DRY_RUN:-0}" != "1" ] && gaffer_deadline_short; then
    gaffer_deadline_handoff
    result error; exit 0
  fi
  # RUNNER-OWNED-BOOKKEEPING: heartbeat the runner-held claim at the start of each
  # attempt so the lease covers the whole delivery even across retries (belt-and-
  # braces with the generously-sized GAFFER_CLAIM_TTL). No-op when the runner holds
  # no token (a tokenless resume fallback). Best-effort — a failed heartbeat is logged, and
  # the generous TTL still covers the delivery.
  [ -n "${CLAIM_TOKEN:-}" ] && { wg heartbeat -- "$CLAIM_TOKEN" >/dev/null 2>&1 || log "heartbeat for #$NUM claim failed (non-fatal; TTL still covers the delivery)"; }
  # ESCALATION: pick THIS attempt's implement-model + rework prompt suffix from the
  # ladder (routed model + base prompt on attempt 1; rethink; then stronger model +
  # full failure trail on the final attempt).
  gaffer_build_escalation "$_DELIV_ATTEMPT"
  if [ "$_DELIV_ATTEMPT" -gt 1 ]; then
    log "delivery for #$NUM — re-invoking agent (attempt $_DELIV_ATTEMPT/$_MAX_DELIVERY_ATTEMPTS) on branch $WORK_BRANCH [impl-model: ${_ATTEMPT_IMPL_FLAG:-default}]"
  fi
  # On a retry the prior worktree was torn down (branch preserved); re-add a fresh
  # worktree on the SAME branch so the agent re-delivers from the recorded feedback.
  if [ "$_DELIV_ATTEMPT" -gt 1 ]; then
    while IFS=$'\t' read -r rid rname rpath rbase rwt; do
      [ -n "$rpath" ] || continue
      rbase="${rbase:-main}"
      git -C "$rpath" rev-parse --git-dir >/dev/null 2>&1 || continue
      git -C "$rpath" worktree prune >/dev/null 2>&1 || true
      mkdir -p "$WORKTREES_BASE"
      # Re-checkout the EXISTING branch (no -B reset) so the prior attempt's commits
      # are the starting point for rework. Fall back to -B off base if the branch
      # somehow vanished (defensive — it should always exist).
      if ! git -C "$rpath" worktree add "$rwt" "$WORK_BRANCH" >/dev/null 2>&1; then
        if git -C "$rpath" worktree add -B "$WORK_BRANCH" "$rwt" "$rbase" >/dev/null 2>&1; then
          _BRANCH_CREATED_THIS_TICK+="$rpath"$'\n'
          _gaffer_note_branch_cut "$rpath"        # re-cut off base: a new base commit
        fi
      fi
      gaffer_link_node_modules "$rpath" "$rwt"
    done <<< "$WT_ROWS"
    # A branch re-cut off base above has a new base commit (others keep theirs).
    _gaffer_record_delivery_bases
    # RE-INSTALL the agent environment into the FRESH worktree. The rework
    # teardown destroyed the untracked runner config with the old worktree — a
    # fresh checkout has NO .claude/settings.json (the safety-hook wiring!),
    # no skills mount and no brief. FAIL-CLOSED: never launch an attempt
    # uncontained — an install failure is THIS attempt's failure (retry with
    # the reason, or park when the bounds are spent); the agent is NOT run.
    if ! gaffer_install_agent_env; then
      _recover_or_park "agent-env-install" "could not install the agent environment (safety-hook settings, skills mount, brief) into the retry worktree — the agent was NOT launched for this attempt (fail closed)"
      [ "$_DELIV_OUTCOME" = "retry" ] && continue
      result error; exit 0
    fi
  fi
  # USAGE LEDGER: switch to --output-format json and CAPTURE stdout (the JSON
  # result object) to a temp file so we can ledger the real usage, WITHOUT
  # changing the delivery path — stderr still streams to $GAFFER_LOG, and the
  # agent's text (`.result`) is appended to the log below so the human-readable
  # log is preserved. The agent's actual work is unaffected: it communicates via
  # the MCP servers, and the runner reads ticket state from `wg ticket show`, not
  # from this stdout (which was previously discarded into the log anyway).
  # PRE-SPAWN BUDGET GATE (C3): a ticket whose cumulative measured spend has already
  # reached its ceiling must NOT burn another agent turn — park BEFORE spawning. The
  # post-attempt rework bound below only fires AFTER an attempt has run, so it can't
  # stop the first spawn of a tick for a ticket that already overspent in a prior run.
  if [ "${DRY_RUN:-0}" != "1" ] && gaffer_budget_exhausted "$NUM"; then
    log "BUDGET: #$NUM reached its cost ceiling (spent \$${GAFFER_BUDGET_SPENT} ≥ \$${GAFFER_BUDGET_CEIL}) — NOT spawning another agent turn; parking to blocked (pre-spawn gate)"
    wg attach-evidence "$NUM" --type manual_note \
      --summary "PARKED (budget_exhausted): cumulative spend \$${GAFFER_BUDGET_SPENT} reached the ceiling \$${GAFFER_BUDGET_CEIL} before this attempt — needs a human" >/dev/null 2>&1 || true
    gaffer_release_delivery blocked "cost ceiling reached (spent \$${GAFFER_BUDGET_SPENT} ≥ \$${GAFFER_BUDGET_CEIL}) before spawning — pre-spawn budget gate" budget_exhausted
    gaffer_skip_ticket "$NUM"
    result error; exit 0
  fi
  USAGE_JSON="$GAFFER_DATA/.usage-$NUM.json"; : > "$USAGE_JSON"
  # C1/M2: scrub ambient credentials via an allowlist (env -i) inside worker_deliver.
  # The scrub sits INSIDE the optional OS-sandbox $WRAP so the sandbox still wraps the
  # whole agent; the per-call boundary vars in WORKER_CALL_ENV are layered on top.
  # shellcheck disable=SC2034  # read by worker_deliver (lib/worker.sh)
  WORKER_CALL_ENV=(
    "GAFFER_WRITE_ROOTS=$WRITE_ROOTS" "GAFFER_READ_ROOTS=$READ_ROOTS"
    "GAFFER_DATA=$GAFFER_DATA" "GAFFER_TICKET=$NUM"
    "DISPATCH_DB=$DISPATCH_DB" "MEMORY_DB=$MEMORY_DB"
  )
  # Opt-in per-call dollar cap (GAFFER_MAX_CALL_USD): for a delivery it also carries
  # the ticket's remaining ceiling, so this one call cannot run past it.
  _CALL_BUDGET_ARGS=()
  if [ -n "${GAFFER_MAX_CALL_USD:-}" ]; then
    _CALL_BUDGET="$(gaffer_call_budget_usd "$(gaffer_ticket_budget_remaining "$NUM")")"
    [ -n "$_CALL_BUDGET" ] && _CALL_BUDGET_ARGS=(--max-budget-usd "$_CALL_BUDGET")
  fi
  # What every write repo's refs held at spawn: the branch-switch recovery below only
  # adopts commits the agent made and only deletes a branch the agent created.
  _PRESPAWN_REFS="$(gaffer_snapshot_refs "$WT_ROWS")"
  GAFFER_TICK_TIMEOUT="$_AGENT_TIMEOUT"  # the deadline guard's clamp (attempt 1 only)
  _SKILL_SINCE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"  # skill telemetry: tool-ledger rows from here on
  # REWORK COST: stamp this spawn's attempt + start time onto its delivery ledger row
  # (gaffer_usage_record reads both), so spend after a send-back is charged as rework.
  read -r GAFFER_USAGE_ATTEMPT_ID GAFFER_USAGE_STARTED_AT <<<"$(gaffer_delivery_attempt_stamp "$_DELIV_ATTEMPT")" || true
  export GAFFER_USAGE_ATTEMPT_ID GAFFER_USAGE_STARTED_AT
  GAFFER_LAUNCH_KIND=delivery worker_deliver "$PRIMARY_REPO" "$PROMPT$_REWORK_BLOCK" "$_ATTEMPT_IMPL_FLAG" "$MCP_RUNTIME" "$USAGE_JSON" "$WRAP" \
    "" ${_CALL_BUDGET_ARGS[@]+"${_CALL_BUDGET_ARGS[@]}"}
  rc=$?
  GAFFER_TICK_TIMEOUT="$_TICK_TIMEOUT_CFG"
  _T_AGENT_DONE="$(date +%s)"
  # SKILL TELEMETRY: record which skills were MOUNTED for this delivery (the mount dir:
  # selection + lenses + universal set) and, best-effort, which were APPLIED — named in
  # the agent's output JSON or opened (tool ledger). Fail-soft; captured here before the
  # ledger removes $USAGE_JSON on either the pause or normal path.
  gaffer_record_skill_usage "$NUM" delivery "${SKILL_STACKS:-$STACK}" "$SKILLS, $LENSES" "$USAGE_JSON" \
    "delivery-$NUM" "$PRIMARY_REPO" "$_SKILL_SINCE"
  # PROVENANCE: which model served this attempt and which CLI ran it, as the ticket's
  # agent-run evidence (the ticket page's attempt history reads it). Fail-soft.
  gaffer_record_agent_run "$NUM" "$USAGE_JSON" "$rc" "$_DELIV_ATTEMPT" "$_MAX_DELIVERY_ATTEMPTS"
  # RESUME REPORT: the resume prompt tells the agent to END its message with the AC ->
  # test lines and the smallest-change note (written for the tokenless resume, whose
  # record_ac_evidence calls are refused; a leased resume's evidence writes now land
  # too). Record that final text as evidence (runner-attributed) so the minimalism gate
  # and the reviewer can read it either way. Fail-soft.
  if [ "$_RESUMING" = "1" ]; then
    gaffer_record_resume_report "$NUM" "$USAGE_JSON" \
      || log "RESUME: could not record the resumed agent's report for #$NUM (continuing)"
  fi
  # ── USAGE WINDOW: a usage-limit / rate-limit refusal is NOT a failed delivery ──
  # The agent was refused by the plan's usage window or a rate limit before it could
  # work (lib/worker.mjs detectUsageLimit — the ONE table of matched strings). Read
  # as a failure it went through the no-commit counter / the rework ladder, burned
  # an attempt every tick until the window reset, and parked good tickets overnight.
  # Instead: record the factory-wide pause ($GAFFER_DATA/usage-pause.json, its end
  # from the reset the CLI printed or GAFFER_USAGE_PAUSE_DEFAULT_MIN), keep whatever
  # the agent made before the refusal (WIP checkpoint; the branch is kept when it has
  # commits and the next delivery builds on it), release the claim to `ready` with
  # reason-code usage_limit (a ticket.usage_limited event) WITHOUT counting an
  # attempt, and stop. Every admission point waits for the pause to end. A resumed
  # delivery goes back to `paused` (worktree kept) for its Continue.
  # rc 1 = an ordinary result (also any failure to CLASSIFY — that runs without the
  # pause lock, so a held lock or a crash cannot fake a refusal); rc 0 = a refusal,
  # pause written; rc 2 = a confirmed refusal whose pause could not be written.
  _UL_REC="$(gaffer_usage_pause_record "$USAGE_JSON" "$NUM" delivery)"; _UL_RC=$?
  if [ "$_UL_RC" != 1 ]; then
    _UL_UNTIL=""; _UL_KIND=""; _UL_MSG=""
    IFS=$'\t' read -r _ _UL_UNTIL _UL_KIND _ _UL_MSG <<<"$_UL_REC"
    _UL_LINE="$(gaffer_usage_pause_active || echo "paused: usage limit")"
    gaffer_usage_record delivery "$NUM" "$rc" "$USAGE_JSON" >>"$GAFFER_LOG" 2>/dev/null || true
    rm -f "$USAGE_JSON"
    gaffer_wip_checkpoint "$WT_ROWS" "$NUM" "$TITLE" \
      && log "USAGE: #$NUM had uncommitted work at the refusal — WIP checkpoint committed on $WORK_BRANCH"
    if [ "$_RESUMING" = "1" ]; then
      gaffer_resume_abort "${_UL_KIND:-usage_limit}: ${_UL_MSG:-refused by the usage window}"
      log "USAGE: resumed #$NUM was refused (${_UL_MSG:-usage limit}) — re-paused with its worktree; $_UL_LINE"
      result usage_paused; exit 0
    fi
    if gaffer_any_branch_has_commits "$WT_ROWS"; then
      GAFFER_KEEP_DELIVERY_BRANCH=1
      gaffer_cleanup_worktrees
      _UL_BRANCH="branch $WORK_BRANCH kept for the next attempt"
    else
      gaffer_cleanup_worktrees drop-branch
      _UL_BRANCH="no work to keep"
    fi
    gaffer_release_delivery ready \
      "usage limit: ${_UL_MSG:-refused by the usage window}; ${_UL_LINE}; not counted as an attempt" \
      usage_limit "" "" "$_UL_UNTIL"
    if [ "$_UL_RC" != 0 ]; then
      # FAIL CLOSED: the pause could not be written, so nothing would stop the next
      # tick re-claiming this ticket straight into the same refusal. Skip it for the
      # rest of this run (the next ticket meets the same refusal and is skipped too).
      gaffer_skip_ticket "$NUM"
      log "USAGE: WARNING — #$NUM was refused by a usage/rate limit but the pause could not be written under $GAFFER_DATA; skipping the ticket for the rest of this run"
    fi
    log "USAGE: #$NUM refused by the model's usage window (${_UL_MSG:-usage limit}) — released to ready without counting an attempt ($_UL_BRANCH); $_UL_LINE"
    result usage_paused; exit 0
  fi
  # ── CLAUDE AUTH: a call that could not authenticate is NOT a failed delivery ──
  # The CLI was logged out or its key rejected ("Invalid API key · Please run /login";
  # lib/worker.mjs detectAuthError, error envelopes only), so the agent never worked.
  # Read as a failure it counted toward the no-commit park and GAFFER_MAX_DELIVERY_
  # ATTEMPTS, and three runs parked a good ticket (exploratory finding fresh-user/F-06).
  # Release the claim to `ready` WITHOUT counting an attempt (the branch kept only when
  # it already had commits), say how to log in, and report auth_error: loop.sh and
  # worker.sh stop the run there. A resumed delivery goes back to `paused`.
  _AUTH_MSG=""
  if [ "${DRY_RUN:-0}" != "1" ] && [ -f "$USAGE_JSON" ] \
     && _AUTH_MSG="$(node "$RUNNER_DIR/lib/worker.mjs" parse-result auth-error --json-file "$USAGE_JSON" 2>/dev/null)"; then
    gaffer_usage_record delivery "$NUM" "$rc" "$USAGE_JSON" >>"$GAFFER_LOG" 2>/dev/null || true
    rm -f "$USAGE_JSON"
    _AUTH_HINT="$(gaffer_claude_auth_hint 2>/dev/null || echo 'claude is not logged in: run `claude /login`')"
    if [ "$_RESUMING" = "1" ]; then
      gaffer_resume_abort "claude_auth: ${_AUTH_MSG:-authentication failed}"
      log "AUTH: resumed #$NUM could not authenticate (${_AUTH_MSG:-authentication failed}) — re-paused with its worktree; $_AUTH_HINT"
      result auth_error; exit 0
    fi
    if gaffer_any_branch_has_commits "$WT_ROWS"; then
      GAFFER_KEEP_DELIVERY_BRANCH=1
      gaffer_cleanup_worktrees
    else
      gaffer_cleanup_worktrees drop-branch
    fi
    gaffer_release_delivery ready "claude could not authenticate: ${_AUTH_MSG:-authentication failed}; not counted as an attempt" claude_auth
    log "AUTH: #$NUM — ${_AUTH_MSG:-authentication failed}: $_AUTH_HINT; released to ready without counting an attempt"
    result auth_error; exit 0
  fi
  # ── BUDGET ADMISSION REFUSED: no agent was spawned, so it is not an attempt ──
  # worker_deliver asks lib/budget-admission.mjs right before the launch; a refusal
  # (a daily or lifetime cap reached since the run admitted this tick, a rework attempt
  # past it, no dollar cap at all on a tick run by hand) returns 77 with nothing spent.
  # Read as a failure it counted a no-commit failure and parked a good ticket. Release
  # it to `ready` uncounted (the branch kept only with commits), skip it for this run,
  # and report no_work: nothing was spent, and the loop's own cap check ends the run.
  if [ "${DRY_RUN:-0}" != "1" ] && [ "${WORKER_LAST_BUDGET_REFUSED:-0}" = 1 ]; then
    rm -f "$USAGE_JSON"
    if [ "$_RESUMING" = "1" ]; then
      gaffer_resume_abort "budget_refused: the paid launch was refused by the budget admission"
      log "BUDGET: resumed #$NUM — the paid launch was refused by the budget admission (see the line above) — re-paused with its worktree"
      result no_work; exit 0
    fi
    if gaffer_any_branch_has_commits "$WT_ROWS"; then
      GAFFER_KEEP_DELIVERY_BRANCH=1
      gaffer_cleanup_worktrees
    else
      gaffer_cleanup_worktrees drop-branch
    fi
    gaffer_release_delivery ready "the paid delivery launch was refused by the budget admission (no agent ran); not counted as an attempt" budget_refused
    gaffer_skip_ticket "$NUM"
    log "BUDGET: #$NUM — the paid delivery launch was refused by the budget admission (see the line above); released to ready without counting an attempt"
    result no_work; exit 0
  fi
  # ── GUARD C: PAUSE-ON-CAP detection (BEFORE the ledger removes the JSON) ─────
  # If the agent hit the TURN cap (num_turns at/over the cap, or a max-turns stop
  # reason) OR the BUDGET cap (GAFFER_BUDGET_REMAINING exhausted) mid-delivery AND it
  # produced ≥1 commit, the work is incomplete but salvageable: do NOT silent-fail or
  # tear it down. PAUSE IN PLACE — keep the worktree + branch (committed AND
  # uncommitted work) ALIVE, set the ticket `paused` with the durable resume context,
  # notify the human gate (spend + dashboard URL, via the dispatch notifier), and stop
  # the tick cleanly with NO teardown and NO auto-retry. A human's one-click Continue
  # re-enters the SAME worktree; Stop tears it down + abandons. A cap-hit with NO
  # commit is an empty/unrecoverable delivery and falls through to the normal empty
  # path below (no false pause of a worktree with nothing in it).
  _CAP_HIT=0
  if gaffer_is_cap_hit "$USAGE_JSON" "$rc"; then _CAP_HIT=1; fi
  # WASTE CONTROL: the wall-clock kill (rc 124) used to be a plain failure — the work
  # on the branch survived but the attempt was burned and the retry started over. It is
  # now pause-eligible like a turn cap: the human sees WHY and presses Continue.
  _TIMEOUT_HIT=0
  [ "$rc" = "124" ] && _TIMEOUT_HIT=1
  # Budget is the HARD ceiling: if the live USD headroom is exhausted, pause even when
  # the turn cap wasn't reached, so the factory never silently keeps spending past it.
  # B28(b): GAFFER_BUDGET_REMAINING was summed from the ledger when this tick was
  # sourced — BEFORE this delivery spent. Its own measured spend is not in the ledger
  # yet (gaffer_usage_record runs below), so subtract it here: the pause sees the
  # headroom as it stands AFTER this call, not as it stood before it. A non-numeric
  # spend ("unknown") coerces to 0 in awk, i.e. the pre-call figure (never a crash).
  _BUDGET_HIT=0
  _LIVE_REMAINING="${GAFFER_BUDGET_REMAINING:-}"
  if [ -n "$_LIVE_REMAINING" ]; then
    _LIVE_REMAINING="$(awk -v r="$_LIVE_REMAINING" -v s="$(gaffer_delivery_spend "$USAGE_JSON")" \
      'BEGIN{r+=0; s+=0; d=r-s; if (d<0) d=0; printf "%.6f", d}' 2>/dev/null || printf '%s' "$_LIVE_REMAINING")"
  fi
  if [ -n "$_LIVE_REMAINING" ] && _num_le "$_LIVE_REMAINING" 0; then
    _BUDGET_HIT=1
  fi
  # The call stopped on its own per-call dollar cap (--max-budget-usd): a budget pause,
  # never a turn-cap one, so a Continue is not misread as "it needs more turns". On a
  # Continue the pre-spawn gate re-checks the ticket's ceiling and parks it
  # (budget_exhausted) when that is what ran out, instead of respawning into $0.
  if gaffer_is_budget_stop "$USAGE_JSON"; then _BUDGET_HIT=1; fi
  # WASTE CONTROL: a cap that lands before the agent's first commit used to mean no
  # pause (nothing on the branch to keep) and a from-scratch retry. Checkpoint the
  # uncommitted work first, so the pause below has commits to preserve.
  if { [ "$_CAP_HIT" = "1" ] || [ "$_BUDGET_HIT" = "1" ] || [ "$_TIMEOUT_HIT" = "1" ]; } \
     && [ "${GAFFER_PAUSE_ON_CAP:-1}" = "1" ]; then
    if gaffer_wip_checkpoint "$WT_ROWS" "$NUM" "$TITLE"; then
      log "CAP: #$NUM had uncommitted work at the cap — WIP checkpoint committed on $WORK_BRANCH so the pause keeps it"
    fi
  fi
  if { [ "$_CAP_HIT" = "1" ] || [ "$_BUDGET_HIT" = "1" ] || [ "$_TIMEOUT_HIT" = "1" ]; } \
     && [ "${GAFFER_PAUSE_ON_CAP:-1}" = "1" ] \
     && gaffer_any_branch_has_commits "$WT_ROWS"; then
    _CAP_SPEND="$(gaffer_delivery_spend "$USAGE_JSON")"
    _CAP_TURNS="$(gaffer_cap_num_turns "$USAGE_JSON")"
    _PAUSE_REASON="cap_hit"
    [ "$_TIMEOUT_HIT" = "1" ] && _PAUSE_REASON="timeout"
    [ "$_BUDGET_HIT" = "1" ] && _PAUSE_REASON="budget_cap"
    gaffer_usage_record delivery "$NUM" "$rc" "$USAGE_JSON" "" "$_DELIV_ATTEMPT" >>"$GAFFER_LOG" 2>/dev/null || true
    rm -f "$USAGE_JSON"
    # Serialise the full worktree map (one entry per write repo) so a multi-repo
    # delivery resumes EVERY worktree, not just the primary. WT_ROWS is the runner's
    # TSV: rid \t rname \t rpath \t rbase \t rwt.
    _WT_JSON="$(printf '%s\n' "$WT_ROWS" | gaffer_json worktree-rows-json 2>/dev/null || echo '[]')"
    log "CAP: #$NUM hit the ${_PAUSE_REASON} cap mid-delivery (turns=${_CAP_TURNS:-?}, spend=${_CAP_SPEND}) — PAUSING in place; worktree + branch $WORK_BRANCH kept alive for one-click Continue"
    # Pause the delivery: transition the ticket to `paused`, persist the resume
    # context (branch, primary worktree, full worktree map, repo, attempt, turns,
    # spend), and notify the human gate (the dispatch notifier carries spend +
    # dashboard URL; GAFFER_NOTIFY_REDACT honoured at the dispatch layer).
    if wg ticket pause "$NUM" --reason "$_PAUSE_REASON" \
        --branch "$WORK_BRANCH" --worktree "$PRIMARY_REPO" \
        --worktrees-json "$_WT_JSON" --repo "${REPO_PATH:-}" \
        --attempt "$_DELIV_ATTEMPT" \
        ${_CAP_TURNS:+--turns "$_CAP_TURNS"} --spend "$_CAP_SPEND" >/dev/null 2>&1; then
      log "CAP: paused #$NUM (-> paused) — resume context persisted, human gate notified"
    else
      log "CAP: WARNING — could not pause #$NUM via dispatch; worktree is still kept alive (KEEP flag set) — needs a human"
    fi
    # THE CRUX: keep the worktree alive past this tick's normal end-of-run cleanup AND
    # any crash/signal. Raise the retention flag so the EXIT/INT/TERM trap's
    # gaffer_crash_cleanup becomes a complete no-op for this paused ticket; do NOT call
    # gaffer_cleanup_worktrees here. The worktree survives for the resume.
    GAFFER_PAUSE_KEEP_WORKTREE=1
    gaffer_skip_ticket "$NUM"
    log "delivery PAUSED (cap-hit) for #$NUM — worktree + branch $WORK_BRANCH PRESERVED for one-click resume"
    result paused; exit 0
  fi
  # Ledger the call (best-effort, swallowed) and append the agent's text to the log.
  # Capture the attempt's REAL spend before the envelope is removed — the eval
  # judge attaches it to the quality record at submit time (cost-per-pass metric).
  _DELIVERY_SPEND_USD="$(gaffer_delivery_spend "$USAGE_JSON" 2>/dev/null || true)"
  gaffer_usage_record delivery "$NUM" "$rc" "$USAGE_JSON" "" "$_DELIV_ATTEMPT" >>"$GAFFER_LOG" 2>/dev/null || true
  rm -f "$USAGE_JSON"
  GAFFER_USAGE_ATTEMPT_ID=""; GAFFER_USAGE_STARTED_AT=""
  log "delivery tick for #$NUM finished (rc=$rc)"

  # FG-007 AC ("Dispatch event log records attempted boundary violations"):
  # best-effort. The deterministic boundary lives in the safety hook, which logs
  # every denial as "BLOCKED by gaffer safety hook: …" to stderr → $GAFFER_LOG. If
  # the slice for THIS run contains a write/branch boundary block, record a
  # manual_note on the ticket so the violation is visible in Dispatch's event
  # log. NEVER fatal: if recording is awkward/unavailable we log it as a soft
  # follow-up and carry on (do not fail the build over it).
  VIOLATIONS="$(tail -n "+$((RUN_LOG_MARK + 1))" "$GAFFER_LOG" 2>/dev/null \
    | grep -iE 'BLOCKED by gaffer safety hook:.*(write outside write-roots|branch creation outside write-roots|read outside allowed roots)' \
    | head -5 || true)"
  if [ -n "$VIOLATIONS" ]; then
    log "FG-007: boundary violation(s) BLOCKED during #$NUM — recording a Dispatch note"
    if wg attach-evidence "$NUM" --type manual_note \
         --summary "FG-007 boundary violation(s) blocked by the safety hook during delivery:"$'\n'"$VIOLATIONS" >/dev/null 2>&1; then
      log "FG-007: recorded boundary-violation note on #$NUM"
    else
      log "FG-007: could not record boundary-violation note on #$NUM (soft follow-up) — violations were: $VIOLATIONS"
    fi
  fi

  # A failed delivery (non-zero rc): classify RECOVERABLE vs UNRECOVERABLE.
  #   • UNRECOVERABLE (no commit on any branch / crash / timeout with no work):
  #     roll back the worktrees AND delete the gaffer/ branch so a botched run
  #     leaves the real repo 100% clean — today's behaviour, unchanged.
  #   • RECOVERABLE (≥1 commit produced before the non-zero exit): the branch
  #     holds salvageable work, so PRESERVE the branch, attach the rc as feedback,
  #     and retry-or-park (GUARD B). The INVARIANT: a delivery with ≥1 commit is
  #     never branch-dropped by a failure path.
  if [ "$rc" -ne 0 ]; then
    if gaffer_any_branch_has_commits "$WT_ROWS"; then
      _recover_or_park "agent-exit" "agent exited non-zero (rc=$rc) after committing work — retrying on the same branch with this context"
      [ "$_DELIV_OUTCOME" = "retry" ] && continue
      result error; exit 0
    fi
    gaffer_cleanup_worktrees drop-branch
    # RUNNER-OWNED-BOOKKEEPING: nothing was produced — release the runner-held claim
    # back to `ready` so a later tick can retry cleanly (skip-file prevents a re-pick
    # THIS run), BOUNDED across runs (FINDING-3): after GAFFER_MAX_NOCOMMIT_FAILURES
    # such failures (or once the per-ticket cost ceiling is spent) the wrapper parks
    # to `blocked` (rework_exhausted) instead — a deterministic agent crash can no
    # longer burn one full agent call per run forever.
    gaffer_release_or_park_nocommit "delivery failed: agent exited non-zero (rc=$rc) with no commits; branch dropped for retry"
    gaffer_skip_ticket "$NUM"
    log "delivery FAILED for #$NUM (rc=$rc) — no commits produced; removed worktrees + branch $WORK_BRANCH; skipping it for the rest of this run"
    result error; exit 0
  fi

  # Branch assertion (FG-008: "verifies current branch after agent execution"):
  # the runner created each WORKTREE on the ticket branch, so EACH worktree's HEAD
  # MUST still be on a gaffer/ branch (and NOT the repo's default branch) — recording
  # a delivery on the wrong branch would attribute work to it. In single-repo mode this
  # is exactly today's single-repo assertion, just checked on the worktree.
  # BRANCH-SWITCH RECOVERY: an agent that switched away (`checkout -b x`, `switch -c`,
  # a detached `checkout <sha>`, back onto the default branch) used to get the whole
  # delivery failed with the ticket branch DELETED — a rework's reviewed commits with
  # it — while its own commits were stranded on an unswept branch, and the failure was
  # counted as "no commits". Now, per worktree:
  #   • HEAD still contains $WORK_BRANCH and every commit on top of it was made by the
  #     agent (none was reachable from any ref at spawn, see _PRESPAWN_REFS): fast-
  #     forward $WORK_BRANCH to HEAD and check it out again (same commit, so uncommitted
  #     edits carry over) and carry on to the gates. A branch the agent CREATED is then
  #     deleted once fully contained; a branch that existed before the spawn (the
  #     user's) is never deleted, and if the agent committed on it, it is put back to
  #     its pre-spawn sha (the commits now live on $WORK_BRANCH);
  #   • otherwise (diverged, or HEAD carries commits that existed before the spawn,
  #     e.g. the agent checked out a user's branch): leave $WORK_BRANCH as it was, KEEP
  #     the stray branch (logged with its sha for a human to salvage), put the worktree
  #     back on $WORK_BRANCH so a retry runs on the right branch, and retry-or-park when
  #     the ticket branch carries commits. Only a branch with nothing on it is dropped.
  _BS_FAIL=""; _BS_FAIL_REPO=""
  while IFS=$'\t' read -r rid rname rpath rbase rwt; do
    [ -n "$rwt" ] || continue
    rbase="${rbase:-main}"
    git -C "$rwt" rev-parse --git-dir >/dev/null 2>&1 || continue
    HEAD_BRANCH="$(git -C "$rwt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
    case "$HEAD_BRANCH" in
      "$WORK_BRANCH") continue ;;
      "$rbase"|"") : ;;
      gaffer/*) continue ;;  # on a runner-owned branch as expected
      *) : ;;
    esac
    _bs_head="$(git -C "$rwt" rev-parse --verify --quiet HEAD 2>/dev/null || echo '')"
    _bs_pre=""
    case "$HEAD_BRANCH" in
      ""|HEAD) : ;;
      *) _bs_pre="$(gaffer_snapshot_sha "$_PRESPAWN_REFS" "$rpath" "$HEAD_BRANCH" || true)" ;;
    esac
    _bs_why="does not contain $WORK_BRANCH"
    if [ -n "$_bs_head" ] && git -C "$rwt" merge-base --is-ancestor "$WORK_BRANCH" "$_bs_head" 2>/dev/null; then
      _bs_why="carries commits that existed before the agent ran (not the agent's work)"
      if gaffer_commits_all_new "$_PRESPAWN_REFS" "$rpath" "$WORK_BRANCH" "$_bs_head" \
         && git -C "$rwt" checkout -q -B "$WORK_BRANCH" "$_bs_head" >/dev/null 2>&1; then
        log "RECOVERED branch switch for #$NUM in ${rname:-repo}: the agent left $WORK_BRANCH for '${HEAD_BRANCH:-?}' but only built on it — $WORK_BRANCH fast-forwarded to $(printf '%s' "$_bs_head" | cut -c1-12) and checked out again"
        case "$HEAD_BRANCH" in
          ""|HEAD|gaffer/*) : ;;
          *) if [ -z "$_bs_pre" ]; then
               # The agent created it: delete it once it holds nothing $WORK_BRANCH lacks.
               if [ "$(git -C "$rpath" rev-parse --verify --quiet "refs/heads/$HEAD_BRANCH" 2>/dev/null)" = "$_bs_head" ]; then
                 git -C "$rpath" branch -D "$HEAD_BRANCH" >/dev/null 2>&1 \
                   && log "RECOVERED branch switch for #$NUM: deleted the agent's stray branch '$HEAD_BRANCH' (fully contained in $WORK_BRANCH)"
               fi
             elif [ "$_bs_pre" != "$_bs_head" ] \
                  && ! grep -qxF "branch refs/heads/$HEAD_BRANCH" <<<"$(git -C "$rpath" worktree list --porcelain 2>/dev/null)"; then
               # A pre-existing branch the agent committed on: put it back (compare-and-
               # swap, so a concurrent move by its owner wins) — the commits are on $WORK_BRANCH.
               git -C "$rpath" update-ref "refs/heads/$HEAD_BRANCH" "$_bs_pre" "$_bs_head" >/dev/null 2>&1 \
                 && log "RECOVERED branch switch for #$NUM: restored pre-existing branch '$HEAD_BRANCH' to $(printf '%s' "$_bs_pre" | cut -c1-12) (the agent's commits are on $WORK_BRANCH)"
             fi ;;
        esac
        continue
      fi
    fi
    # Diverged, foreign commits, or HEAD unreadable: never move $WORK_BRANCH; the stray
    # work stays where the agent put it. Re-checkout $WORK_BRANCH so the worktree (and
    # any retry) is on it.
    log "BRANCH SWITCH: #$NUM worktree for ${rname:-repo} ($rwt) is on '${HEAD_BRANCH:-?}' at ${_bs_head:-unknown}, which $_bs_why — $WORK_BRANCH left as it was, '${HEAD_BRANCH:-?}' / ${_bs_head:-?} kept for a human to salvage"
    git -C "$rwt" checkout -q -f "$WORK_BRANCH" >/dev/null 2>&1 || true
    _BS_FAIL="worktree HEAD '${HEAD_BRANCH:-?}' (${_bs_head:-?}) $_bs_why"
    _BS_FAIL_REPO="${rname:-repo} ($rwt)"
  done <<< "$WT_ROWS"
  if [ -n "$_BS_FAIL" ]; then
    if gaffer_any_branch_has_commits "$WT_ROWS"; then
      # The ticket branch carries work (a rework's reviewed commits, or this attempt's):
      # recoverable, never dropped. The feedback tells the agent to stay on the branch.
      _recover_or_park "branch" "you switched branches ($_BS_FAIL in $_BS_FAIL_REPO); commit ONLY on $WORK_BRANCH — never create, switch or detach branches"
      [ "$_DELIV_OUTCOME" = "retry" ] && continue
      result error; exit 0
    fi
    gaffer_cleanup_worktrees drop-branch
    gaffer_release_or_park_nocommit "delivery failed: $_BS_FAIL; $WORK_BRANCH had no commits and was dropped"
    gaffer_skip_ticket "$NUM"
    log "delivery FAILED for #$NUM — $_BS_FAIL in $_BS_FAIL_REPO; $WORK_BRANCH had no commits (removed with the worktrees), not recording delivery"
    result error; exit 0
  fi

  # ── Auto-commit safety net ─────────────────────────────────────────────────
  # Agents sometimes EDIT files but STOP WITHOUT running git commit; the change then
  # vanishes as an "empty" (0-commit) branch and the ticket is
  # parked, losing correct work. If a write-repo worktree has uncommitted changes,
  # commit them on the gaffer/ branch so a forgotten commit never drops the work.
  # Runner config is git-excluded + hygiene-forbidden, so this captures only the
  # real delivery; the minimalism/hygiene gates still inspect the committed diff.
  while IFS=$'\t' read -r rid rname rpath rbase rwt; do
    [ -n "$rwt" ] || continue
    git -C "$rwt" rev-parse --git-dir >/dev/null 2>&1 || continue
    if [ -n "$(git -C "$rwt" status --porcelain 2>/dev/null)" ]; then
      # Exclude non-deliverables at the `git add` itself (pathspec), so this can't be
      # defeated by gitignore gaps (the node_modules SYMLINK the runner creates escapes
      # the `node_modules/` dir-pattern) or by exclude-file state. Deterministic.
      # BUG 4 fix: also exclude nested node_modules (packages/*/node_modules etc.)
      # using the glob pathspec; the top-level ':(exclude)node_modules' alone does
      # NOT match paths like packages/web/node_modules added by workspace symlinks.
      git -C "$rwt" add -A -- . \
        ':(exclude)node_modules' ':(exclude,glob)**/node_modules/**' \
        ':(exclude).claude' ':(exclude)CLAUDE.factory.md' \
        ':(exclude).mcp.json' ':(exclude,glob)mcp-runtime*.json' ':(exclude)dist' ':(exclude)build' \
        ':(exclude).next' ':(exclude)coverage' \
        ':(exclude).terraform' ':(exclude,glob)**/.terraform/**' >/dev/null 2>&1
      if git -C "$rwt" commit -q -m "deliver #$NUM: $TITLE" >/dev/null 2>&1; then
        log "auto-committed uncommitted changes for #$NUM in ${rname:-repo} (agent edited but did not commit)"
      fi
    fi
  done <<< "$WT_ROWS"

  # ── Re-queue/park policy: EMPTY delivery (0 commits / no diff) → PARK ───────
  # A delivery that produced no change is never blind-retried: the agent couldn't
  # action the ticket as specified. RUNNER-OWNED-BOOKKEEPING: the runner holds the
  # claim and has NOT submitted (the gate runs pre-submit), so it releases/parks the
  # held claim to `refining` (needs triage) directly — replacing the old status-probe
  # fallback that existed only because the AGENT used to submit and might not have.
  # Computed across ALL write repos: empty only if EVERY write repo's branch diff is
  # empty.
  ANY_DIFF=0
  while IFS=$'\t' read -r rid rname rpath rbase rwt; do
    [ -n "$rwt" ] || continue
    rbase="${rbase:-main}"
    git -C "$rwt" rev-parse --git-dir >/dev/null 2>&1 || continue
    if [ -n "$(git -C "$rwt" diff --name-only "$rbase"...HEAD 2>/dev/null)" ]; then ANY_DIFF=1; break; fi
  done <<< "$WT_ROWS"
  if [ "$ANY_DIFF" = "0" ]; then
    log "EMPTY delivery for #$NUM — 0 commits / no diff across all write repos; parking (no blind retry)"
    wg attach-evidence "$NUM" --type manual_note \
      --summary "PARKED: empty delivery (no diff produced) — routing to refinement, not retrying blindly" >/dev/null 2>&1 || true
    gaffer_release_delivery refining "empty delivery: agent produced no change — needs clarification/refinement"
    # FINDING-3: the ticket leaves the delivery pipeline (human triage) — reset the
    # cross-run no-commit counter so the post-refinement retry budget starts fresh.
    gaffer_nocommit_clear "$NUM"
    gaffer_cleanup_worktrees drop-branch
    gaffer_skip_ticket "$NUM"
    log "delivery PARKED for #$NUM — empty; removed worktrees + branch $WORK_BRANCH"
    result error; exit 0
  fi

  # ── Stabilisation gate 1: DELIVERY HYGIENE (HARD FAIL) ──────────────────────
  # BEFORE we record/submit the delivery, assert each write repo's branch diff is
  # hygienic. This catches the leaks a large unattended run produced: a copied
  # source tree in a repo root (src.ticket9/), a leaked .crew/events.jsonl,
  # self-referential/broken symlinks (node_modules -> itself, .claude/skills), or
  # any node_modules path added OR deleted. A violation PARKS the ticket (review
  # reject --to refining with the reason, or block as a fallback) and FAILS the
  # tick — the delivery is NEVER submitted/recorded. HYGIENE_ENFORCE=0 downgrades
  # the hard fail to a logged warning (debugging only).
  HYGIENE_REASONS=""
  while IFS=$'\t' read -r rid rname rpath rbase rwt; do
    [ -n "$rwt" ] || continue
    rbase="${rbase:-main}"
    git -C "$rwt" rev-parse --git-dir >/dev/null 2>&1 || continue
    _hy="$(gaffer_assert_clean_delivery "$rwt" "$rbase" 2>/dev/null)" || \
      HYGIENE_REASONS+="[${rname:-repo}] $_hy"$'\n'
  done <<< "$WT_ROWS"
  HYGIENE_REASONS="$(printf '%s' "$HYGIENE_REASONS" | sed '/^$/d')"
  if [ -n "$HYGIENE_REASONS" ]; then
    log "HYGIENE: delivery for #$NUM is NOT hygienic:"$'\n'"$HYGIENE_REASONS"
    if [ "${HYGIENE_ENFORCE:-1}" = "1" ]; then
      # RECOVERABLE (GUARD B): the agent produced commits — a hygiene violation
      # (a leaked path on the branch) is fixable on a re-delivery, and the
      # invariant forbids dropping a committed branch. Preserve the branch, attach
      # the violation as feedback, and retry-or-park. The next attempt re-checks
      # out the SAME branch and the feedback names the offending paths to remove.
      _HY_FLAT="$(printf '%s' "$HYGIENE_REASONS" | tr '\n' ' ')"
      if gaffer_any_branch_has_commits "$WT_ROWS"; then
        _recover_or_park "hygiene" "delivery hygiene violation — remove these leaked paths and re-deliver: $_HY_FLAT"
        [ "$_DELIV_OUTCOME" = "retry" ] && continue
        result error; exit 0
      fi
      # No commits (e.g. a leak that is purely a worktree artifact with no diff):
      # there is nothing salvageable on the branch — drop it. RUNNER-OWNED-
      # BOOKKEEPING: release/park the held claim to refining directly (pre-submit).
      wg attach-evidence "$NUM" --type manual_note \
        --summary "PARKED: delivery hygiene violation (not submitted):"$'\n'"$HYGIENE_REASONS" >/dev/null 2>&1 || true
      gaffer_release_delivery refining "delivery hygiene violation: $_HY_FLAT"
      # FINDING-3: leaves the delivery pipeline — reset the cross-run no-commit counter.
      gaffer_nocommit_clear "$NUM"
      gaffer_cleanup_worktrees drop-branch
      gaffer_skip_ticket "$NUM"
      log "delivery FAILED for #$NUM — hygiene violation, no commits; parked, removed worktrees + branch $WORK_BRANCH, not recording delivery"
      result error; exit 0
    else
      log "HYGIENE_ENFORCE=0 — logging the violation but NOT failing the tick (debugging mode)"
    fi
  fi

  # ── Stabilisation gate 2: MINIMALISM post-condition ─────────────────────────
  # Compute files/lines from the PRIMARY write repo's branch diff and require a
  # recorded smallest-change note. A MISSING note is flagged needs_human_review by
  # default (the human judges minimality from the diff at review); with
  # MINIMALISM_REQUIRE_NOTE=1 it FAILS the post-condition (back to rework) so an
  # unjustified change can't glide through an unsupervised run. An OVERSIZED diff
  # does NOT fail — it flags the ticket needs_human_review: oversized_diff visibly
  # (recorded as an evidence note) and proceeds. Size is judged on its own: a
  # delivery with a missing or boilerplate note that is ALSO over a cap carries
  # both flags (GAFFER_MINIMALISM_OVERSIZED), never just the first one found.
  if git -C "$PRIMARY_REPO" rev-parse --git-dir >/dev/null 2>&1; then
    read -r _MZ_FILES _MZ_LINES <<< "$(gaffer_diff_stats "$PRIMARY_REPO" "$DEFAULT_BRANCH")"
    # The smallest-change note is whatever the agent recorded as evidence: the NEWEST
    # evidence row carrying a "smallest-change"/"smallest change" marker (the
    # minimalism + record-evidence skills emit one; on a resume, the runner-recorded
    # "resume agent report"), never the runner's own flag rows or events.
    _MZ_NOTE="$(wg ticket show "$NUM" 2>/dev/null | gaffer_json smallest-change-note 2>/dev/null || echo '')"
    _MZ_CHANGED="$(git -C "$PRIMARY_REPO" diff --name-only "$DEFAULT_BRANCH"...HEAD 2>/dev/null | tr '\n' ' ')"
    # Run in THIS shell (NOT a $() subshell) so gaffer_check_minimalism's
    # GAFFER_MINIMALISM_REASON / GAFFER_MINIMALISM_VERDICT globals propagate here. A $()
    # subshell loses them, and the references below then hit "unbound variable" under
    # `set -u` — failing the gate OPEN. The verdict is read from the global, never a
    # fixed scratch file: $GAFFER_DATA is shared by every worker under
    # GAFFER_CONCURRENCY>1, and a shared .mz-verdict let one delivery read another's.
    GAFFER_MINIMALISM_VERDICT=""
    gaffer_check_minimalism "${_MZ_FILES:-0}" "${_MZ_LINES:-0}" "$_MZ_NOTE" "$_MZ_CHANGED" >/dev/null 2>&1 || true
    _MZ_VERDICT="${GAFFER_MINIMALISM_VERDICT:-}"
    : "${GAFFER_MINIMALISM_REASON:=minimalism check produced no reason}"   # belt: never unbound under set -u
    case "$_MZ_VERDICT" in
      missing_note)
        # Missing smallest-change note is a FLAG by default (needs_human_review) — the
        # delivery proceeds to REVIEW where the human judges minimality from the actual
        # diff (now visible in the UI). Set MINIMALISM_REQUIRE_NOTE=1 to HARD-FAIL (park)
        # on a missing note instead, for fully-unsupervised runs that need the gate.
        if [ "${MINIMALISM_REQUIRE_NOTE:-0}" = "1" ]; then
          log "MINIMALISM: #$NUM has NO smallest-change note — failing (MINIMALISM_REQUIRE_NOTE=1) ($_MZ_FILES files / $_MZ_LINES lines)"
          # RECOVERABLE (GUARD B): a committed diff with a missing smallest-change
          # note is fixable on a re-delivery (the agent records the note). The diff
          # is non-empty here (asserted earlier), so the branch carries commits —
          # preserve it, attach the reason as feedback, and retry-or-park.
          _recover_or_park "minimalism" "minimalism post-condition failed — $GAFFER_MINIMALISM_REASON (computed: ${_MZ_FILES} files / ${_MZ_LINES} lines); record a smallest-change note and re-deliver"
          [ "$_DELIV_OUTCOME" = "retry" ] && continue
          result error; exit 0
        else
          log "MINIMALISM: #$NUM missing smallest-change note — flagging needs_human_review (not failing); human judges minimality from the diff at review"
          wg attach-evidence "$NUM" --type manual_note \
            --summary "needs_human_review: missing smallest-change note ($GAFFER_MINIMALISM_REASON) — judge minimality from the diff" >/dev/null 2>&1 || true
        fi ;;
      oversized_diff)
        # Visible flag, NOT a fail: record a review note + proceed to submit.
        log "MINIMALISM: #$NUM oversized — flagging needs_human_review:oversized_diff ($GAFFER_MINIMALISM_REASON)"
        wg attach-evidence "$NUM" --type manual_note \
          --summary "needs_human_review: oversized_diff — $GAFFER_MINIMALISM_REASON" >/dev/null 2>&1 \
          && log "MINIMALISM: recorded oversized_diff flag on #$NUM" || true ;;
      check_failed)
        # The typed check could not run (packages/crew not built, or the CLI
        # errored). A gate that cannot decide never waves a delivery through:
        # recoverable, because a rebuilt factory re-runs the same check.
        log "MINIMALISM: #$NUM check could not run — $GAFFER_MINIMALISM_REASON; not submitting"
        _recover_or_park "minimalism" "minimalism check could not run — $GAFFER_MINIMALISM_REASON"
        [ "$_DELIV_OUTCOME" = "retry" ] && continue
        result error; exit 0 ;;
      unverified_note)
        # Note present but references no changed file → likely boilerplate. Flag
        # for human review (not a hard fail — a conceptual note can be legitimate).
        log "MINIMALISM: #$NUM unverified note — flagging needs_human_review:unverified_minimalism_note ($GAFFER_MINIMALISM_REASON)"
        wg attach-evidence "$NUM" --type manual_note \
          --summary "needs_human_review: unverified_minimalism_note — $GAFFER_MINIMALISM_REASON" >/dev/null 2>&1 \
          && log "MINIMALISM: recorded unverified_note flag on #$NUM" || true ;;
      ok)
        log "MINIMALISM: #$NUM within caps ($_MZ_FILES files / $_MZ_LINES lines)" ;;
      *)
        # Empty/unrecognised verdict = gaffer_check_minimalism crashed or produced no
        # output. A crash must NOT be treated as a pass (the `ok` arm above) — that would
        # silently skip the gate. Fail closed: flag for human review, or hard-fail when the
        # note gate is required for unsupervised runs.
        log "MINIMALISM: #$NUM verdict check produced no/unknown output ('$_MZ_VERDICT') — failing closed (NOT treating as within-caps)"
        if [ "${MINIMALISM_REQUIRE_NOTE:-0}" = "1" ]; then
          _recover_or_park "minimalism" "minimalism gate produced no verdict (internal error) — re-deliver"
          [ "$_DELIV_OUTCOME" = "retry" ] && continue
          result error; exit 0
        else
          wg attach-evidence "$NUM" --type manual_note \
            --summary "needs_human_review: minimalism gate produced no verdict (internal error) — judge minimality from the diff" >/dev/null 2>&1 || true
        fi ;;
    esac
    # OVERSIZED alongside a note flag: the verdict token names only the note problem,
    # so the size flag is attached on its own here (an oversized_diff verdict already
    # attached it above).
    case "$_MZ_VERDICT" in
      missing_note|unverified_note)
        if [ -n "${GAFFER_MINIMALISM_OVERSIZED:-}" ]; then
          log "MINIMALISM: #$NUM is ALSO oversized — flagging needs_human_review:oversized_diff ($GAFFER_MINIMALISM_OVERSIZED)"
          wg attach-evidence "$NUM" --type manual_note \
            --summary "needs_human_review: oversized_diff — $GAFFER_MINIMALISM_OVERSIZED" >/dev/null 2>&1 \
            && log "MINIMALISM: recorded oversized_diff flag on #$NUM" || true
        fi ;;
    esac
  fi

  # ── Stabilisation gate 2.5: DEFINITION OF DONE (I3 — HARD FAIL) ─────────────
  # The single biggest "factory, not vibe" lever. The diff is non-empty (asserted
  # above) and the work lives in the throwaway worktrees. BEFORE the ticket is
  # allowed to rest in the human review lane, the RUNNER (never the agent) runs the
  # enabled DoD gates — tests / typecheck / lint — DETERMINISTICALLY in each write
  # repo's delivery worktree, each bounded by gaffer_timeout.
  #   ALL pass/skip → proceed (record + submit as today).
  #   ANY fail      → AUTO-REJECT back to refining/rework (the same path R-6/HYGIENE
  #                   hardened), record the failing gate name + an output tail as
  #                   evidence, drop the branch. A human never sees a failed gate;
  #                   the next attempt gets the gate output as review feedback.
  # A gate with NO configured command is SKIPPED (logged), not failed. A delivery
  # where ZERO gates actually executed is a HARD FAIL by default (the work was not
  # verified); set GAFFER_ALLOW_NO_DOD=1 to waive this for repos with no runnable
  # gates (see factory.config.sh). GAFFER_DOD=0 turns enforcement off entirely.
  # Per-gate toggles
  # (GAFFER_DOD_TESTS/TYPECHECK/LINT, default on) are env-only: crew.yaml's
  # `definition_of_done` block is NOT read here (crew doctor warns when it is
  # changed). Commands come from each repo's dispatch
  # test_command/lint_command; typecheck (no dispatch field) runs
  # GAFFER_DOD_TYPECHECK_CMD, else the command auto-detected from the repo's
  # package.json (gaffer_dod_typecheck_cmd in lib/dod.sh). DoD is best-effort RESILIENT: a gate command that itself
  # errors to spawn is treated as a FAIL with a clear message, never a crash.
  gaffer_clamp_gate_timeouts   # TICK DEADLINE: no gate outlives the outer bound
  # The passing DoD checklist, kept for the eval judge's test_adequacy grading (the
  # results file is removed below, long before the post-submit judge runs).
  _DOD_JUDGE_TESTS=""
  if gaffer_dod_enabled; then
    # Per-repo commands from the dispatch payload, keyed by repo id (fallback name):
    #   id|name <TAB> test_cmd <TAB> lint_cmd
    # First line is the sentinel `@@DOD_PARSE_OK@@` emitted ONLY when the payload
    # parsed — so an unparseable payload is detected, never
    # silently treated as "no commands" (which would fail the gate OPEN).
    # parse failure → no sentinel, non-zero (exit 3)
    DOD_CMD_MAP="$(echo "$SHOW" | gaffer_json dod-cmd-map 2>/dev/null || true)"
    if ! grep -q '^@@DOD_PARSE_OK@@$' <<<"$DOD_CMD_MAP"; then   # here-string: a pipe can SIGPIPE-miss under pipefail
      # Could not parse the dispatch payload. Do NOT
      # fail the gate OPEN by pretending no commands are configured: surface it as a
      # visible WARNING and FAIL the delivery closed so a human looks, rather than
      # silently shipping unverified work.
      log "DoD: WARNING — could not parse the dispatch payload for #$NUM gate commands (malformed SHOW); FAILING CLOSED — parking, not submitting"
      wg attach-evidence "$NUM" --type test_output \
        --summary "DoD: FAIL"$'\n'"$(printf '{"dod":"FAIL","gates":[{"gate":"config","repo":"-","status":"FAIL","rc":"-","note":"could not resolve DoD gate commands from the dispatch payload"}]}')" >/dev/null 2>&1 \
        && log "DoD: recorded config-FAIL evidence on #$NUM" \
        || log "DoD: WARNING — could not attach config-FAIL evidence on #$NUM"
      # RUNNER-OWNED-BOOKKEEPING: release/park the held claim to refining (pre-submit;
      # the branch is preserved for a human to fix the config + re-run).
      gaffer_release_delivery refining "Definition of Done could not run: gate commands unresolved from the dispatch payload"
      # GUARD B invariant: the agent committed work before this CONFIG failure
      # (the diff was asserted non-empty above), so the branch carries salvageable
      # work — PRESERVE it (worktree-only teardown). Re-invoking the agent cannot
      # fix an unresolvable gate-command/env problem, so this does NOT retry; it
      # parks once with the branch kept for a human to resolve the config + re-run.
      # Raise retention BEFORE exiting: the EXIT trap otherwise `drop-branch`es the
      # branch this tick created — the very branch the log calls PRESERVED.
      GAFFER_KEEP_DELIVERY_BRANCH=1
      gaffer_cleanup_worktrees
      gaffer_skip_ticket "$NUM"
      log "delivery FAILED for #$NUM — DoD gate commands unresolvable; parked, removed worktree, branch $WORK_BRANCH PRESERVED (config problem — needs a human), not recording delivery"
      result error; exit 0
    fi
    # Strip the sentinel line; the remainder is the real id<TAB>test<TAB>lint map.
    DOD_CMD_MAP="$(printf '%s\n' "$DOD_CMD_MAP" | grep -v '^@@DOD_PARSE_OK@@$')"
    # Resolved per-gate enables (default ON; mirror the schema default). A loop /
    # orchestrator that read crew.yaml can export these to honour a repo override.
    _DOD_TESTS_ON="${GAFFER_DOD_TESTS:-1}"
    _DOD_TC_ON="${GAFFER_DOD_TYPECHECK:-1}"
    _DOD_LINT_ON="${GAFFER_DOD_LINT:-1}"
    # GATE INTEGRITY: has a HUMAN allowed this ticket to change its tests? Read FRESH
    # (not from the tick-start SHOW) so an allowance set while the agent worked counts.
    # Fails closed: an unreadable ticket means no allowance (the row FLAGs, never FAILs).
    _DOD_ALLOW_TESTS="$(wg ticket show "$NUM" 2>/dev/null \
      | jget '(d.ticket && d.ticket.allow_test_changes === 1) ? 1 : 0' 2>/dev/null || echo 0)"
    [ "$_DOD_ALLOW_TESTS" = "1" ] || _DOD_ALLOW_TESTS=0
    # Build the gate-runner input: one row per write repo with its resolved commands.
    DOD_ROWS=""
    while IFS=$'\t' read -r rid rname rpath rbase rwt; do
      [ -n "$rwt" ] || continue
      git -C "$rwt" rev-parse --git-dir >/dev/null 2>&1 || continue
      _dkey="${rid:-$rname}"
      _dlabel="${rname:-${rid:-repo}}"
      # Look up this repo's commands from the map (exact id/name match).
      _drow="$(printf '%s\n' "$DOD_CMD_MAP" | awk -F'\t' -v k="$_dkey" '$1==k{print; exit}')"
      _dtest="$(printf '%s' "$_drow" | awk -F'\t' '{print $2}')"
      _dlint="$(printf '%s' "$_drow" | awk -F'\t' '{print $3}')"
      # typecheck has no dispatch field: GAFFER_DOD_TYPECHECK_CMD (an override for every
      # repo), else the command auto-detected from this repo's package.json, read from
      # the base branch first so a delivery cannot delete the gate away.
      # GATE INTEGRITY: the commit the delivery was cut from (recorded before the agent
      # ran); the base branch name only when none was resolved.
      _dbase="$(_gaffer_delivery_base_for "$rpath")"
      [ -n "$_dbase" ] || _dbase="$rbase"
      _dtc="$(gaffer_dod_typecheck_cmd "$rwt" "$_dbase")"
      [ -z "${GAFFER_DOD_TYPECHECK_CMD:-}" ] && [ -n "$_dtc" ] && [ "$_DOD_TC_ON" = "1" ] \
        && log "DoD: typecheck gate for ${_dlabel} runs the auto-detected '$_dtc' (package.json script; GAFFER_DOD_TYPECHECK_CMD overrides it)"
      # Empty command fields MUST be the sentinel `-`: TAB is IFS-whitespace, so the
      # gate runner's `read` would collapse adjacent empty tabs and shift columns.
      [ -n "${_dtest// /}" ] || _dtest="-"
      [ -n "${_dtc// /}" ]   || _dtc="-"
      [ -n "${_dlint// /}" ] || _dlint="-"
      # GATE INTEGRITY: the base commit the delivery was cut from (the gate reads each
      # command's package.json script from that commit and appends an integrity row)
      # plus the human's allowance. `-` when unknown: integrity then FLAGs the gap.
      DOD_ROWS+="$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s' \
        "$_dlabel" "$rwt" "$_DOD_TESTS_ON" "$_DOD_TC_ON" "$_DOD_LINT_ON" \
        "$_dtest" "$_dtc" "$_dlint" "${_dbase:--}" "$_DOD_ALLOW_TESTS")"$'\n'
    done <<< "$WT_ROWS"
    DOD_ROWS="${DOD_ROWS%$'\n'}"

    # Pre-gate ENABLER (NOT a gate): a fresh delivery worktree has no node_modules,
    # so the test gate cannot run. Auto-install deps in EACH worktree, bounded +
    # fail-soft, BEFORE the gate runs — inside the SAME validation sandbox as the gates
    # (GAFFER_DOD_WRAP, stripped env; refused under strict-require with no wrap). This never crashes the tick and never passes
    # the gate — on a failed/timed-out install the gate still runs and fails loudly
    # exactly as today. Disable with GAFFER_DOD_INSTALL=0 (or GAFFER_GREENFIELD_INSTALL=0)
    # for byte-identical-to-today behaviour. Separate loop from the row-builder above
    # so the enabler stays visibly distinct from gate-command resolution.
    if gaffer_dod_install_enabled; then
      while IFS=$'\t' read -r _iid _iname _ipath _ibase _iwt; do
        [ -n "$_iwt" ] || continue
        git -C "$_iwt" rev-parse --git-dir >/dev/null 2>&1 || continue
        _pm="$(gaffer_dod_install_deps "$_iwt")"
        case "$_pm" in
          SKIPPED:sandbox_unavailable:*) log "DoD-install: REFUSED — GAFFER_STRICT_REQUIRE=1 and no validation sandbox wraps the ${_pm#SKIPPED:sandbox_unavailable:} install in $_iwt (#$NUM); nothing was executed (fail closed), the test gate will surface missing deps" ;;
          FAILED:timeout:*) log "DoD-install: WARN — ${_pm#FAILED:timeout:} install TIMED OUT in $_iwt (#$NUM); test gate will surface it" ;;
          FAILED:*)         log "DoD-install: WARN — ${_pm#FAILED:} install failed in $_iwt (#$NUM); test gate will surface it" ;;
          ?*)               log "DoD-install: installed ${_iname:-repo} deps via '$_pm' in the worktree for #$NUM" ;;
        esac
      done <<< "$WT_ROWS"
    fi

    if [ -n "$DOD_ROWS" ]; then
      DOD_RESULTS="$GAFFER_DATA/.dod-$NUM.results"
      if printf '%s\n' "$DOD_ROWS" | gaffer_run_dod_gates "$DOD_RESULTS"; then
        log "DoD: #$NUM PASSED — $(gaffer_dod_summary_line "$DOD_RESULTS")"
        gaffer_dod_log_integrity "$DOD_RESULTS"
        # Zero executed gates means no gate commands are configured (all skipped):
        # the delivery was never actually verified. FAIL by default so a
        # misconfigured repo cannot silently ship unverified work. Opt out with
        # GAFFER_ALLOW_NO_DOD=1 only for repos that genuinely have no runnable
        # gates (see factory.config.sh for documentation of this knob).
        if [ "$(gaffer_dod_executed_count "$DOD_RESULTS")" -eq 0 ]; then
          if [ "${GAFFER_ALLOW_NO_DOD:-0}" = "1" ]; then
            log "DoD: WARNING — #$NUM passed with ZERO gates executed (GAFFER_ALLOW_NO_DOD=1 waiver active); configure test_command / lint_command to remove this opt-out"
          else
            log "DoD: FAILING #$NUM — zero DoD gates executed (all skipped); no test_command or lint_command configured. Set GAFFER_ALLOW_NO_DOD=1 to allow deliveries with no runnable gates (see factory.config.sh)"
            rm -f "$DOD_RESULTS"
            _recover_or_park "definition-of-done" "Definition of Done: zero gates executed — no test_command or lint_command configured; configure gate commands or set GAFFER_ALLOW_NO_DOD=1"
            [ "$_DELIV_OUTCOME" = "retry" ] && continue
            result error; exit 0
          fi
        fi
        # Record the green checklist as evidence so the reviewer sees a pre-verified
        # board (the Review view renders it). Best-effort; never blocks a passing
        # delivery.
        _DOD_EV="$(gaffer_dod_evidence_summary "$DOD_RESULTS" PASS)"
        [ -n "$_DOD_EV" ] && wg attach-evidence "$NUM" --type test_output \
          --summary "$_DOD_EV" >/dev/null 2>&1 \
          && log "DoD: recorded PASS checklist evidence on #$NUM" || true
        # FLAKY RERUN (lib/dod.sh): a tests gate that went red under the pool and passed
        # at concurrency 1 did not cost an attempt — flag it for the reviewer.
        if grep -q $'\tflaky-suspected$' "$DOD_RESULTS" 2>/dev/null; then
          log "DoD: #$NUM tests passed only on the rerun at concurrency 1 — flaky suspected; flagging needs_human_review"
          wg attach-evidence "$NUM" --type manual_note \
            --summary "needs_human_review: flaky tests suspected — the tests gate failed under a parallel pool and passed when rerun at concurrency 1 (both runs are in the DoD evidence)" >/dev/null 2>&1 || true
        fi
        _DOD_JUDGE_TESTS="$(tail -c 20000 "$DOD_RESULTS" 2>/dev/null || true)"
        rm -f "$DOD_RESULTS"
      else
        # ── A gate FAILED → auto-reject back to rework (never a human's time) ──
        _DOD_SUM="$(gaffer_dod_summary_line "$DOD_RESULTS")"
        log "DoD: #$NUM FAILED — $_DOD_SUM; auto-rejecting back to rework (not submitting for review)"
        gaffer_dod_log_integrity "$DOD_RESULTS"
        _DOD_EV="$(gaffer_dod_evidence_summary "$DOD_RESULTS" FAIL)"
        # THE CRUX of (b): distil the ACTUAL failure (failing test name + assertion/
        # error), not the gate-name summary, so the next attempt can self-correct.
        # Read it from the results file BEFORE it is removed below.
        _DOD_DETAIL="$(gaffer_dod_extract_failure "$DOD_RESULTS" 2>/dev/null || true)"
        # Record the failing checklist + output tail as evidence FIRST so the next
        # attempt gets it as review feedback (and the board shows why it bounced). A
        # FAILED attach is surfaced (not swallowed) — losing the feedback is a real
        # regression in the learning loop, so the warning must be visible.
        if [ -n "$_DOD_EV" ]; then
          wg attach-evidence "$NUM" --type test_output --summary "$_DOD_EV" >/dev/null 2>&1 \
            && log "DoD: recorded FAIL checklist evidence on #$NUM" \
            || log "DoD: WARNING — could not attach FAIL evidence on #$NUM; the next attempt will have no DoD gate feedback"
        else
          log "DoD: WARNING — empty DoD evidence summary for #$NUM (could not build the checklist); failing closed without recorded feedback"
        fi
        rm -f "$DOD_RESULTS"
        # RECOVERABLE (GUARD B) — THE ticket #64 case: the agent produced commits
        # but a downstream gate (tests / typecheck / lint) failed. This is exactly
        # the failure that must NEVER delete the branch. Preserve the branch,
        # attach the failing checklist as feedback, and retry-or-park: re-invoke
        # the ESCALATED agent on the SAME branch with the REAL failure as feedback, up
        # to GAFFER_MAX_DELIVERY_ATTEMPTS (or the per-ticket cost ceiling), then park to
        # the VISIBLE `blocked` column WITH branch + full feedback trail.
        _recover_or_park "definition-of-done" \
          "Definition of Done failed: $_DOD_SUM — fix the failing gate(s) and re-deliver" \
          "$_DOD_DETAIL"
        [ "$_DELIV_OUTCOME" = "retry" ] && continue
        result error; exit 0
      fi
    fi
  else
    log "DoD: enforcement OFF (GAFFER_DOD=${GAFFER_DOD:-unset}) — skipping the Definition-of-Done gate for #$NUM"
  fi

  # ── MACHINE-CHECKABLE ACCEPTANCE CRITERIA (runner-executed, runner-recorded) ──
  # Every AC carrying a `check_command` is executed HERE, in the primary write
  # worktree, by the runner — never the agent — and its verdict recorded through the
  # trusted `wg ac check-result` path (satisfied/failed + test_output evidence with
  # the exit code and output tail). Dispatch's done gate refuses a checked AC the
  # runner has not passed, so the agent's own record_ac_evidence cannot substitute.
  # A failing check is a RECOVERABLE gate failure exactly like DoD: keep the branch,
  # feed the real failure back, retry-or-park. Runs whether or not DoD is enabled —
  # the checks are per-ticket contracts, not per-repo gate config. See lib/ac-checks.sh.
  gaffer_clamp_gate_timeouts
  if command -v gaffer_run_ac_checks >/dev/null 2>&1 && [ "$(gaffer_ac_check_count "$SHOW")" -gt 0 ]; then
    AC_RESULTS="$GAFFER_DATA/.ac-check-$NUM.results"; : > "$AC_RESULTS"
    if gaffer_run_ac_checks "$NUM" "$SHOW" "$PRIMARY_REPO" "$AC_RESULTS"; then
      log "AC-check: #$NUM PASSED — $(gaffer_dod_summary_line "$AC_RESULTS")"
      rm -f "$AC_RESULTS"
    else
      _AC_SUM="$(gaffer_dod_summary_line "$AC_RESULTS")"
      log "AC-check: #$NUM FAILED — $_AC_SUM; auto-rejecting back to rework (not submitting for review)"
      _AC_DETAIL="$(gaffer_dod_extract_failure "$AC_RESULTS" 2>/dev/null || true)"
      rm -f "$AC_RESULTS"
      _recover_or_park "acceptance-check" \
        "Acceptance check failed: $_AC_SUM — make the acceptance criterion's check command pass and re-deliver" \
        "$_AC_DETAIL"
      [ "$_DELIV_OUTCOME" = "retry" ] && continue
      result error; exit 0
    fi
  fi

  # ── GUARD B: every gate passed → leave the recoverable-attempt loop ─────────
  # Reaching here means the agent delivered AND every downstream gate (empty /
  # hygiene / minimalism / DoD) passed on this attempt. Break out of the retry
  # loop into the success recording below. (Recoverable gate failures `continue`
  # the loop; unrecoverable ones already `exit 0`.)
  break
  done   # end GUARD B recoverable-delivery attempt loop

  # ── RUNNER-OWNED-BOOKKEEPING: submit for review (the runner, not the agent) ──
  # Every gate passed. The runner (which holds the claim) now submits the ticket for
  # review — deterministic + token-free from the agent's perspective. A normal
  # delivery uses the claim-gated `wg submit` (claimed → in_review, completing the
  # claim; a leased resume uses it too); a tokenless resume fallback is moved
  # in_progress → in_review.
  # The delivery-artifact / diff_summary / per-repo records BELOW run as a SYSTEM actor
  # and are status-independent, so submitting first (matching the old agent-submit
  # ordering) keeps the done-gate's PR/diff evidence attached to an in_review ticket.
  #
  # R-6 (data-loss window): SUBMIT itself is the review-visibility point — it moves the
  # ticket claimed → in_review AND resolves the claim (GAFFER_CLAIM_RESOLVED=1). If a
  # signal (the routine outer per-tick timeout SIGTERM, launchd stop, Ctrl-C) lands in
  # the gap between submit and the first delivery record, the crash trap sees
  # KEEP=0 + COMPLETE=0 and runs `drop-branch` — DELETING the review-worthy branch —
  # while CLAIM_RESOLVED=1 suppresses the claim re-release, stranding the ticket
  # in_review with its branch gone and no branch_name recorded yet. Raise retention
  # BEFORE submit: past GUARD B the branch is guaranteed to hold delivered commits, so
  # keeping it is always correct, and the trap now preserves it from the visibility
  # point onward. (Redundantly re-raised on the record path + the submit-fail park.)
  GAFFER_KEEP_DELIVERY_BRANCH=1
  if gaffer_submit_delivery "delivered on branch $WORK_BRANCH; gates passed"; then
    log "submitted #$NUM for review (→ in_review) — runner-owned submit"
    # FINDING-3: this delivery attempt SUCCEEDED — reset the cross-run no-commit
    # failure counter so a flaky-then-fixed ticket is never permanently poisoned.
    gaffer_nocommit_clear "$NUM"
    # MEMORY FEEDBACK LOOP: the delivery shipped for review. Reward the served
    # knowledge when it shipped CLEAN (first attempt, no prior review rejection);
    # otherwise it shipped only after rework — a weaker signal, so demote + flag.
    # _DELIV_ATTEMPT counts in-tick attempts (≥2 ⇒ reworked here); ROUTE_ATTEMPT_RAW
    # is the dispatch attempt_count (≥1 ⇒ a PRIOR review rejection sent it back).
    if [ "${_DELIV_ATTEMPT:-1}" -ge 2 ] || [ "${ROUTE_ATTEMPT_RAW:-0}" -ge 1 ]; then
      gaffer_recall_feedback reworked
    else
      gaffer_recall_feedback clean
    fi
    # TICKET → LORE DISTILLATION (Track 1c): harvest the closed ticket's product
    # intent (title + AC) into a human-gated REQUIREMENT DRAFT so the "why"
    # survives the ticket. Additive + fail-soft; the delivery is already submitted.
    gaffer_distill_ticket_intent
    # EVAL JUDGE (quality telemetry, GAFFER_EVAL_JUDGE=1 opt-in): score the
    # just-submitted delivery against its ACs on the crew rubric and append the
    # verdict + real spend to the eval ledger. memoryPresent = whether durable
    # product-context primed this delivery (the memory score gap's arm flag).
    # Additive + fail-soft telemetry — never gates or delays the submitted work.
    # The judge gets the DoD checklist this delivery passed (GAFFER_EVAL_TEST_OUTPUT)
    # and the REPO NAME for the ledger record ($PRIMARY_REPO is the worktree path,
    # whose basename is a per-ticket key, not the repo).
    if type gaffer_eval_judge_delivery >/dev/null 2>&1; then
      GAFFER_EVAL_TEST_OUTPUT="${_DOD_JUDGE_TESTS:-}" \
        gaffer_eval_judge_delivery "$NUM" "$PRIMARY_REPO" "$DEFAULT_BRANCH" "$WORK_BRANCH" \
        "$([ -n "${PRODUCT_CONTEXT_BLOCK:-}" ] && echo 1 || echo 0)" "${_DELIVERY_SPEND_USD:-}" "${_CARD_REPO_NAME:-}" || true
    fi
  else
    # M1 (data-loss path): the submit FAILED. We must NOT fall through to record the
    # delivery artifacts and exit "worked" — that leaves the ticket `claimed` with
    # recorded evidence, and on TTL expiry a second tick reclaims it and runs
    # `git worktree add -B …`, RESETTING the branch and discarding THIS delivery's
    # commits while the recorded evidence points at now-absent commits. Instead, park
    # the runner-held claim to `refining` (which preserves the branch AND blocks the
    # blind reclaim-and-reset), skip the ticket for this run, and fail the tick for a
    # manual review handoff — BEFORE any delivery-artifact recording below. Raise the
    # branch-retention flag FIRST so the exit/crash trap tears down only the throwaway
    # worktree and never the review-worthy branch.
    GAFFER_KEEP_DELIVERY_BRANCH=1
    gaffer_release_delivery refining "runner submit failed — needs manual review handoff"
    # FINDING-3: leaves the delivery pipeline — reset the cross-run no-commit counter.
    gaffer_nocommit_clear "$NUM"
    gaffer_skip_ticket "$NUM"
    log "WARNING — submit FAILED for #$NUM; parked → refining (branch $WORK_BRANCH PRESERVED), NOT recording delivery — needs a human / claim-recovery"
    result error; exit 0
  fi

  # Per-repo delivery recording (FG-008 / WG-005): for EACH write repo, persist a
  # per-repo delivery artifact (branch + diffstat as the evidence note). Single-repo
  # fallback → exactly one repo-delivery row; multi-repo → one per write repo. This
  # is in ADDITION to the top-level diff_summary + delivery-artifact records below
  # (kept for backwards compatibility / the existing done-gate). Recording is
  # best-effort per repo (never fatal): a write repo whose CLI record fails is
  # logged, not failed.
  # The diff is read from the WORKTREE (where the agent's commits live) while it
  # still exists; the recorded branch name is the gaffer/ branch, which persists in
  # the REAL repo after the worktree is removed below.
  #
  # FIX-BRANCH: the moment a delivery record makes the gaffer/ branch
  # review/merge-visible, deleting that branch on a later crash/signal would leave
  # recorded evidence pointing at a missing branch. Raise the branch-retention flag
  # NOW — strictly BEFORE the first record below — so any crash trap from here on
  # tears down the disposable worktree but PRESERVES the branch. A salvageable
  # orphan branch is always preferable to a dangling delivery record. Retention is
  # already raised above (before submit — the true visibility point); re-affirm it
  # here so this record path stays self-evidently safe. We keep
  # GAFFER_DELIVERY_COMPLETE for the later "fully done, skip all cleanup" case.
  GAFFER_KEEP_DELIVERY_BRANCH=1
  while IFS=$'\t' read -r rid rname rpath rbase rwt; do
    [ -n "$rwt" ] || continue
    rbase="${rbase:-main}"
    git -C "$rwt" rev-parse --git-dir >/dev/null 2>&1 || continue
    R_CUR="$(git -C "$rwt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
    [ -n "$R_CUR" ] && [ "$R_CUR" != "$rbase" ] || continue
    # GRADUATED AUTONOMY: record the delivery HEAD sha so the review-approve path can
    # compute an honest `approved_unchanged` (delivery sha vs the branch head at approval).
    # Without it the signal was permanently null and the auto-merge half never fired.
    R_SHA="$(git -C "$rwt" rev-parse HEAD 2>/dev/null || echo '')"
    R_SHA_ARG=""; [ -n "$R_SHA" ] && R_SHA_ARG="--commit $R_SHA"  # sha is a single token → safe to word-split
    # repoRef accepts the repo id OR name; prefer the stable id, fall back to name.
    R_REF="${rid:-$rname}"
    if [ -n "$R_REF" ]; then
      if wg ticket repo-delivery record "$NUM" "$R_REF" --branch "$R_CUR" $R_SHA_ARG --status review_ready --as system >/dev/null 2>&1; then
        log "recorded per-repo delivery for #$NUM: ${rname:-repo} → $R_CUR (branch lives in $rpath)"
      else
        log "per-repo delivery for #$NUM (${rname:-repo}) did not record (non-fatal)"
      fi
    fi
  done <<< "$WT_ROWS"

  # Deterministically record the TOP-LEVEL delivery so closing never depends on the
  # agent remembering, and the existing done-gate keeps working unchanged. Two
  # distinct, complementary records (the done-gate needs BOTH under
  # factory_strict/regulated, and attach-evidence alone covers team_light):
  #   1. attach-evidence diff_summary → creates the evidence row the done-gate's
  #      hasPrOrDiff check looks for (evidence_type IN pull_request/diff_summary).
  #      System-actor evidence — does NOT satisfy ACs (those stay claim-scoped),
  #      only the PR/diff gate.
  #   2. delivery-artifact --branch → persists branch_name onto the ticket so the
  #      reviewer can resolve the delivered branch from Dispatch (not git grep),
  #      and satisfies the factory_strict/regulated BRANCH_REQUIRED gate. --as
  #      system records tokenlessly (the implementer's claim has already finished).
  #      Its --diff lands in the delivery event payload, NOT an evidence row, so it
  #      does NOT by itself satisfy hasPrOrDiff — hence we keep attach-evidence too.
  # Top-level record is keyed to the PRIMARY write repo (single-repo: == REPO_PATH;
  # multi-repo: the first write repo) — a representative summary; per-repo rows
  # above carry the full per-repo detail (WG-005 AC: top-level remains as summary).
  if git -C "$PRIMARY_REPO" rev-parse --git-dir >/dev/null 2>&1; then
    CUR_BRANCH="$(git -C "$PRIMARY_REPO" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
    if [ -n "$CUR_BRANCH" ] && [ "$CUR_BRANCH" != "$DEFAULT_BRANCH" ]; then
      DIFFSTAT="$(git -C "$PRIMARY_REPO" diff "$DEFAULT_BRANCH"...HEAD --stat 2>/dev/null | tail -15)"
      [ -n "$DIFFSTAT" ] && wg attach-evidence "$NUM" --type diff_summary \
        --summary "Delivered on branch $CUR_BRANCH"$'\n'"$DIFFSTAT" >/dev/null 2>&1 \
        && log "attached delivery diff_summary for #$NUM" || true
      wg delivery-artifact "$NUM" --branch "$CUR_BRANCH" --diff "$DIFFSTAT" --as system >/dev/null 2>&1 \
        && log "recorded delivery-artifact branch_name=$CUR_BRANCH for #$NUM" \
        || log "delivery-artifact for #$NUM did not record (non-fatal)"
    fi
  fi

  # Success: the delivery is RECORDED and the gaffer/ branch now holds work that
  # must survive for review/merge. Tear down the throwaway worktrees FIRST, THEN mark
  # the delivery complete.
  #
  # R-5: the flag used to be set BEFORE this teardown. A signal arriving in the gap
  # between the flag-set and the teardown call made the crash trap a no-op (it sees
  # COMPLETE=1 and returns early) while the worktrees were still on disk — LEAKING
  # them. Setting the flag AFTER the explicit teardown closes that window: by the time
  # COMPLETE=1, the worktrees are already gone, so a trap firing later finds nothing to
  # leak. (The narrow inverse window — a signal landing AFTER teardown but BEFORE the
  # flag is set — is now harmless to the branch too: GAFFER_KEEP_DELIVERY_BRANCH was
  # already raised before delivery was recorded, so the trap in that window tears the
  # worktree only and PRESERVES the now review-visible branch (FIX-BRANCH); the
  # worktree, the thing this fix protects, is already removed, so nothing leaks.)
  #
  # The gaffer/ branch + its commits PERSIST in each real repo for review/merge — only
  # the disposable checkout is removed. The real repo's primary working tree + current
  # branch never moved.
  gaffer_cleanup_worktrees
  GAFFER_DELIVERY_COMPLETE=1
  # PAUSE-ON-CAP: a resumed delivery that completed has left the paused state for
  # good — drop its stale resume context (no-op delete when there is no row).
  [ "$_RESUMING" = "1" ] && wg ticket paused-clear "$NUM" >/dev/null 2>&1 || true
  log "removed delivery worktrees for #$NUM — branch $WORK_BRANCH persists in the real repo(s) for review"

  # ── Stabilisation gate 3: real-repo CLEAN after teardown (HARD FAIL) ────────
  # Teardown must leave the REAL main checkout of each write repo clean — no
  # copied src tree, no leaked events log, no broken symlink, no dirty tree. If
  # teardown leaked an unmanaged artifact into a real repo, fail the tick visibly
  # (record a note on the ticket) so the leak is caught at source, not discovered
  # in a later salvage. HYGIENE_ENFORCE=0 downgrades to a logged warning.
  REPO_DIRTY=""
  while IFS=$'\t' read -r rid rname rpath rbase rwt; do
    [ -n "$rpath" ] || continue
    git -C "$rpath" rev-parse --git-dir >/dev/null 2>&1 || continue
    _rc="$(gaffer_assert_repo_clean "$rpath" 2>/dev/null)" || \
      REPO_DIRTY+="[${rname:-repo} @ $rpath] $_rc"$'\n'
  done <<< "$WT_ROWS"
  REPO_DIRTY="$(printf '%s' "$REPO_DIRTY" | sed '/^$/d')"
  if [ -n "$REPO_DIRTY" ]; then
    log "HYGIENE: real repo NOT clean after teardown for #$NUM:"$'\n'"$REPO_DIRTY"
    if [ "${HYGIENE_ENFORCE:-1}" = "1" ]; then
      wg attach-evidence "$NUM" --type manual_note \
        --summary "POST-TEARDOWN LEAK: real repo not clean after delivery:"$'\n'"$REPO_DIRTY" >/dev/null 2>&1 || true
      gaffer_skip_ticket "$NUM"
      log "delivery FLAGGED for #$NUM — teardown left unmanaged artifacts in a real repo (see note)"
      result error; exit 0
    else
      log "HYGIENE_ENFORCE=0 — logging the post-teardown leak but NOT failing the tick"
    fi
  fi

  # ── H4: real PR creation (opt-in GAFFER_CREATE_PR=1) ─────────────────────────
  # After the delivery is fully recorded and the worktrees are torn down, attempt
  # to open a GitHub PR. This is ALWAYS best-effort: a failure is logged but never
  # rolls back the delivery or changes the ticket status. The `gh` binary is
  # injectable via GAFFER_GH_BIN so the no-op (flag off / no remote) path is clean.
  _PR_URL=""
  if declare -F gaffer_create_pr >/dev/null 2>&1; then
    # The REAL primary repo (the branch persists there), NOT the worktree: this runs
    # after the worktrees are torn down, so the worktree path no longer exists and
    # every remote check on it said "no GitHub remote" — PR creation never fired.
    _PR_URL="$(gaffer_create_pr "$NUM" "${_CARD_REAL_REPO:-$PRIMARY_REPO}" "$WORK_BRANCH" "$DEFAULT_BRANCH" "$TITLE" 2>>"$GAFFER_LOG" || true)"
  else
    log "H4: pr-create.sh not loaded — skipping (GAFFER_CREATE_PR=${GAFFER_CREATE_PR:-0})"
  fi

  # ── H3: CI-aware review gate (opt-in GAFFER_REQUIRE_CI=1) ─────────────────────
  # When enabled, poll CI checks on the delivery branch before letting the ticket
  # enter the human review lane.
  #   green checks            → proceed (rc=0)
  #   red checks              → auto-reject back to rework (rc=2)
  #   timeout / no-PR / no-checks (strict, default) → auto-reject (rc=2)
  #   timeout / no-PR / no-checks (GAFFER_CI_TIMEOUT_POLICY=proceed) → proceed (rc=0)
  #   flag off                → no-op (rc=0)
  #   flag on but GAFFER_CREATE_PR off → SKIP with one warning per run (rc=0): the
  #     checks live on the PR, so without PR creation the gate polled a PR that never
  #     existed and (strict) rejected every delivery at the timeout.
  if declare -F gaffer_ci_gate >/dev/null 2>&1; then
    if declare -F gaffer_ci_gate_needs_pr >/dev/null 2>&1 && gaffer_ci_gate_needs_pr; then
      gaffer_ci_gate_warn_needs_pr "$NUM"; _CI_RC=0
    else
      gaffer_ci_gate "$NUM" "${_CARD_REAL_REPO:-$PRIMARY_REPO}" "$WORK_BRANCH" "${_PR_URL:-}"
      _CI_RC=$?
    fi
    if [ "$_CI_RC" = "2" ]; then
      # CI went red → auto-reject back to rework so a human never sees a broken CI.
      log "H3: CI FAILED for #$NUM — auto-rejecting delivery back to rework (ticket left for re-delivery)"
      _CUR_CI_STATUS="$(wg ticket show "$NUM" 2>/dev/null | jget 'd.ticket.status' 2>/dev/null || echo '')"
      if [ "$_CUR_CI_STATUS" = "in_review" ]; then
        # --as system: a runner (CI) rejection is NOT a human decision — recorded as one, it
        # fed the autonomy recommendations' human-agreement rate.
        wg review reject "$NUM" --to refining --reviewer factory-ci --as system \
          --reason "H3: CI checks failed on branch $WORK_BRANCH — see attached evidence for the failing check" \
          >/dev/null 2>&1 \
          && log "H3: auto-rejected #$NUM (in_review → refining)" \
          || log "H3: WARNING — could not auto-reject #$NUM to refining (non-fatal)"
      else
        # Not in_review any more: dispatch refuses approval without a CI PASS for the
        # candidate, and the recorded FAIL HOLDS an already-approved ticket for a human
        # (ready_for_merge|in_testing → blocked, reason ci_red) — never left landable.
        log "H3: ticket #$NUM is in status '$_CUR_CI_STATUS' (not in_review) — the recorded CI failure holds it for a human (dispatch: blocked, ci_red)"
      fi
      result error; exit 0
    fi
  else
    log "H3: ci-gate.sh not loaded — skipping (GAFFER_REQUIRE_CI=${GAFFER_REQUIRE_CI:-0})"
  fi

  result worked; exit 0
fi

# ── Agent review ─────────────────────────────────────────────────────────────
# If review_mode includes agents, a reviewer agent (NOT the implementer) reviews
# an in_review ticket and approves/rejects via the review CLI. Runs when nothing
# is ready, so delivery is prioritised; a ticket the reviewer doesn't resolve is
# skipped to avoid re-review loops (loop.sh clears the file each run).
_gaffer_agent_review_pass

# ── Independent tester lane ── lib/tester.sh. When GAFFER_TESTING is on, hand the
# next `in_testing` ticket to the black-box tester agent (bin/tester-run.mjs --live);
# PASS → ready_for_merge, FAIL → refining, no verdict → held for a human. Exits the
# tick when it tests one; otherwise returns and the flow falls through.
declare -F _gaffer_tester_pass >/dev/null 2>&1 && _gaffer_tester_pass

# ── Intake clarify gate ── extracted to lib/clarify.sh (B-H3, monolith paydown).
# Runs a headless clarify pass over the next un-clarified DRAFT when nothing is
# ready (a no-op unless CLARIFY_DRAFTS_WHEN_IDLE=1). Exits the tick if it
# clarifies a draft; otherwise returns and the flow falls through to maintenance.
_gaffer_clarify_pass

# The runner's own planner for the idle feature-backlog loop (crew falls back to it
# when crew.yaml sets no decompose_script). Empty when it is missing.
_gaffer_idle_decompose_script() {
  [ -f "$HERE/bin/decompose.mjs" ] && printf '%s' "$HERE/bin/decompose.mjs"
  return 0
}

# ── Idle feature backlog ── the Settings "Feature backlog" toggle
# (GAFFER_IDLE_FEATURE_BACKLOG, else crew.yaml `loops.idle_feature_backlog.enabled`;
# OFF by default). With nothing ready, crew pulls ONE `backlog` feature from the
# memory ledger, advances it to `building`, decomposes it (bin/decompose.mjs, one
# paid plan call, --force-plan) and files a brownfield epic — as DRAFTS behind the
# human gate unless the idle mode says otherwise. It runs BEFORE the maintenance
# lane: it used to be reachable only through `fg idle` (IDLE_DRAFT_WHEN_IDLE=1),
# which never ran on a tick where the maintenance lane did. GAFFER_IDLE_FEATURE_BACKLOG=0
# skips the crew spawn entirely; crew answers `disabled` while the switch is off.
# When this step ran, the later `fg maintain` / `fg idle` get GAFFER_IDLE_FEATURE_BACKLOG=0
# so the loop (and its paid planner call) runs at most once per tick.
# The env prefix wires crew to the FACTORY's memory server + DB and to this runner's
# planner (see the maintenance lane below for why).
_FB_RAN=0
_FB_SPENT=0
if [ "${GAFFER_IDLE_FEATURE_BACKLOG:-}" != "0" ] && [ -f "$CREW_DIR/dist/cli/index.js" ] && [ -f "$CREW_CONFIG" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    [ "${GAFFER_IDLE_FEATURE_BACKLOG:-}" = "1" ] && log "DRY_RUN: would run: fg feature-backlog (plan one backlog feature as an epic)"
  else
    _FB_RAN=1
    FBOUT="$(GAFFER_DATA="$GAFFER_DATA" DISPATCH_DB="${DISPATCH_DB:-}" MEMORY_DB="${MEMORY_DB:-}" MEMORY_MCP_BIN="${MEMORY_MCP_BIN:-}" \
      GAFFER_DECOMPOSE_SCRIPT="$(_gaffer_idle_decompose_script)" CLAUDE_BIN="${CLAUDE_BIN:-claude}" CLAUDE_FLAGS="${CLAUDE_FLAGS:-}" \
      fg feature-backlog 2>>"$GAFFER_LOG")"
    FBSTATUS="$(echo "$FBOUT" | jget '(() => { if (!d || d.ok !== true) return "error"; if (!d.featureBacklog) return "skipped:" + (d.skipped || "none"); return (d.featureBacklog.outcome || {}).status || "none"; })()' 2>/dev/null || echo error)"
    # spent = the planner (a model call) ran, whatever it produced: such a tick counts
    # against MAX_TICKS_PER_DAY even when it filed nothing (see the lane below).
    _FB_SPENT="$(echo "$FBOUT" | jget 'd.spent === true ? 1 : 0' 2>/dev/null || echo 0)"
    # A backlog feature whose plan failed max_plan_failures times is no longer claimed
    # (each try is a paid planner call); say so once, when it is parked.
    if [ "$(echo "$FBOUT" | jget '(d.events || []).includes("feature_backlog_parked") ? 1 : 0' 2>/dev/null || echo 0)" = 1 ]; then
      log "feature backlog: a feature's plan failed on every attempt — it stays in backlog and idle ticks stop claiming it (plan it by hand, or delete its entry in $GAFFER_DATA/feature-backlog-failures.json to let idle ticks retry)"
    fi
    case "$FBSTATUS" in
      skipped:disabled) : ;;  # the switch is off — the common case, stay quiet
      draft_created|ready_created)
        FBDRAFTS="$(echo "$FBOUT" | jget '((d.featureBacklog || {}).outcome || {}).draftCount ?? 0' 2>/dev/null || echo 0)"
        log "no ready tickets → feature backlog planned one feature as an epic ($FBSTATUS, $FBDRAFTS ticket(s))"
        result idle_drafted; exit 0 ;;
      *)
        # A claimed feature whose decompose / create_epic failed: crew releases the
        # claim back to `backlog` (memory's release_feature) and counts the failure;
        # after loops.idle_feature_backlog.max_plan_failures failed plans in a row the
        # feature is parked (no paid decompose on every idle tick). Say so loudly.
        if [ "$(echo "$FBOUT" | jget '(d.events || []).includes("feature_backlog_failed") ? "failed" : ""' 2>/dev/null)" = "failed" ]; then
          log "feature backlog FAILED to plan a claimed feature — it was released back to backlog and is retried until max_plan_failures, then parked (see $GAFFER_CREW_EVENTS for the error; or plan it from the dashboard)"
        else
          log "no ready tickets → feature backlog: $FBSTATUS"
        fi ;;
    esac
  fi
fi
# What the later crew calls get for the feature-backlog switch: off when the step above
# already had its turn this tick, else whatever the operator set (empty = crew.yaml).
_FB_LATER="${GAFFER_IDLE_FEATURE_BACKLOG:-}"
[ "$_FB_RAN" = "1" ] && _FB_LATER=0

# Nothing ready → idle MAINTENANCE LANE (audit item A4). The lane's master switch
# lives in crew.yaml (`loops.maintenance.enabled`, edited from the dashboard's
# Settings → Idle loops panel), so a built crew + a crew.yaml is enough to ASK the
# scheduler; it answers `disabled` (no scan, no cursor advance) while the switch is
# off. GAFFER_MAINTENANCE is the operator's ENV override on top of that: 0 = kill
# switch (never ask crew on an idle tick), 1 = force the lane even when the switch
# is off, empty (default) = crew.yaml decides. When the lane runs, ONE loop is
# chosen by crew's deterministic priority+rotation scheduler (`fg maintain`) —
# security findings first, then test-gaps, then type/tech-debt, then docs —
# rotating so no lane starves. The chosen lane + rationale are logged so the
# decision is auditable. The rotation cursor is persisted under $GAFFER_DATA so the
# cadence survives across ticks. Which loops it rotates through is each idle loop's
# own enabled flag in the crew config.
if [ "${GAFFER_MAINTENANCE:-}" != "0" ] && [ -f "$CREW_DIR/dist/cli/index.js" ] && [ -f "$CREW_CONFIG" ]; then
  _MAINT_ARGS=()
  [ "${GAFFER_MAINTENANCE:-}" = "1" ] && _MAINT_ARGS=(--force)
  log "no ready tickets → maintenance lane (crew.yaml decides; deterministic scheduler picks one loop)"
  if _gaffer_flag_on "${GAFFER_STRICT_REQUIRE:-0}" && ! _gaffer_flag_on "${GAFFER_IDLE_HOST_EXEC:-0}"; then
    log "maintenance lane: GAFFER_STRICT_REQUIRE is on — idle loops will NOT run repo commands (coverage_command, idle_dependencies.audit_command) or the tsc/semgrep oracles unsandboxed on the host (GAFFER_IDLE_HOST_EXEC=1 to allow)"
  fi
  if [ "$DRY_RUN" = "1" ]; then
    log "DRY_RUN: would run: fg maintain${_MAINT_ARGS[0]:+ --force} (scheduler-chosen maintenance loop)"; result no_work; exit 0
  fi
  # Capture crew's rc + stderr: a failed `crew maintain` (invalid crew.yaml, crash,
  # locked DB) prints nothing on stdout, and parsing that empty output as "chose
  # none, no_op" used to report a healthy `maintenance_ran` on every idle tick.
  # The env prefix wires the async idle loops to the FACTORY's memory server + DB
  # and to this runner's planner (lore gap, feature backlog), with no crew.yaml
  # hand-wiring: crew's stdio transport would otherwise drop MEMORY_DB and the
  # loops would read ~/.memory, or not run at all.
  _merr="$(mktemp "${TMPDIR:-/tmp}/gaffer-maint.XXXXXX" 2>/dev/null || echo "/tmp/gaffer-maint.$$")"
  MOUT="$(GAFFER_DATA="$GAFFER_DATA" DISPATCH_DB="${DISPATCH_DB:-}" MEMORY_DB="${MEMORY_DB:-}" MEMORY_MCP_BIN="${MEMORY_MCP_BIN:-}" \
    GAFFER_DECOMPOSE_SCRIPT="$(_gaffer_idle_decompose_script)" CLAUDE_BIN="${CLAUDE_BIN:-claude}" CLAUDE_FLAGS="${CLAUDE_FLAGS:-}" \
    GAFFER_IDLE_FEATURE_BACKLOG="$_FB_LATER" fg maintain ${_MAINT_ARGS[@]+"${_MAINT_ARGS[@]}"} 2>"$_merr")"
  _mrc=$?
  cat "$_merr" >> "$GAFFER_LOG" 2>/dev/null || true
  # MSTATUS is "invalid" unless MOUT is crew's `{ok:true, report}` with either no
  # outcome (nothing was due: no_op) or a status from the registry's outcome enum
  # (IdleLoopRunOutcome in packages/crew/src/loops/idleRegistry.ts).
  MSTATUS="$(echo "$MOUT" | jget '(() => { const r = d && d.ok === true ? d.report : null; if (!r || typeof r !== "object") return "invalid"; const o = r.outcome; if (o == null) return "no_op"; return ["skipped_tickets_ready", "no_repos", "no_findings", "draft_created", "ready_created", "observed", "suggested", "disabled"].includes(o.status) ? o.status : "invalid"; })()' 2>/dev/null || echo invalid)"
  [ "$_mrc" -eq 0 ] || MSTATUS=invalid
  MCHOSEN="$(echo "$MOUT" | jget '(d.report || {}).chosen || "none"' 2>/dev/null || echo none)"
  MREASON="$(echo "$MOUT" | jget '(d.report || {}).reason ?? ""' 2>/dev/null || echo '')"
  # `filed` = everything this tick produced (the lane's drafts + ingested issues + a
  # backlog epic + lore suggestions); older crews only had the lane's draftCount.
  MDRAFTS="$(echo "$MOUT" | jget 'd.filed ?? ((d.report || {}).outcome || {}).draftCount ?? 0' 2>/dev/null || echo 0)"
  case "$MDRAFTS" in ''|*[!0-9]*) MDRAFTS=0 ;; esac
  MSPENT="$(echo "$MOUT" | jget 'd.spent === true ? 1 : 0' 2>/dev/null || echo 0)"
  # Did anything besides the scan lane run (ingest, lore gap, feature backlog)?
  MOTHER="$(echo "$MOUT" | jget 'd.ingest || d.jira || d.loreGap || d.featureBacklog ? 1 : 0' 2>/dev/null || echo 0)"
  if [ "$MSTATUS" = "invalid" ]; then
    # FAILED, not ran: log it loudly and fall through to the legacy scan + the final
    # `no_work`, so workers still drain on EMPTY_POLL_LIMIT and the tick does not
    # count against the day cap (a productive result here made the pool spin).
    log "maintenance lane FAILED (rc=$_mrc): $(grep . "$_merr" 2>/dev/null | head -1 | cut -c1-300) — check $CREW_CONFIG (\`gaffer status\` runs crew doctor)"
  elif [ "$MSTATUS" = "disabled" ]; then
    # The switch is off: say so once per idle tick (it is the most common reason an
    # operator sees "no_work" with lanes enabled) and fall through to the legacy scan.
    log "maintenance lane is OFF in crew.yaml (loops.maintenance.enabled=false) — turn it on in Settings → Idle loops, or GAFFER_MAINTENANCE=1 to force"
  else
    log "maintenance lane chose '$MCHOSEN' ($MREASON) → status=$MSTATUS, filed=$MDRAFTS"
    rm -f "$_merr"
    if [ "$MCHOSEN" = "none" ] && [ "$MDRAFTS" -eq 0 ] && [ "$MOTHER" != 1 ]; then
      # The switch (or GAFFER_MAINTENANCE=1) only turns the lane ON; it rotates through
      # the idle loops you enabled, and with none enabled there is nothing to run.
      log "maintenance lane: no maintenance loop is enabled — turn on at least one lane in Settings → Idle loops (GAFFER_MAINTENANCE=1 only overrides the master switch)"
    elif [ "$MCHOSEN" = "coverage" ] && [ "$MSTATUS" = "no_repos" ]; then
      log "maintenance lane: the coverage lane needs a repo coverage_command — set one with \`wg repo set-commands <repo> --coverage '<cmd>'\` (or in the dashboard's repo settings)"
    fi
    # A backlog feature whose plan failed max_plan_failures times is no longer claimed
    # (each try is a paid planner call); say so once, when it is parked.
    if [ "$(echo "$MOUT" | jget '(d.events || []).includes("feature_backlog_parked") ? 1 : 0' 2>/dev/null || echo 0)" = 1 ]; then
      log "feature backlog: a feature's plan failed on every attempt — it stays in backlog and idle ticks stop claiming it (plan it by hand, or delete its entry in $GAFFER_DATA/feature-backlog-failures.json to let idle ticks retry)"
    fi
    [ "$MDRAFTS" -gt 0 ] && { result maintenance_drafted; exit 0; }
    # Filed nothing. A deterministic scan (or a deduped re-find) calls no model and
    # costs nothing, so it is an EMPTY poll — no_work keeps EMPTY_POLL_LIMIT draining
    # the pool and keeps the zero-cost scan off MAX_TICKS_PER_DAY. Reporting it as a
    # productive maintenance_ran used to fill the day cap with no-op scans and block
    # real deliveries until midnight. Only a tick that ran a model-backed step (the
    # feature-backlog planner, here or in the step above) and filed nothing is
    # maintenance_ran: it may have paid.
    { [ "$MSPENT" = 1 ] || [ "$_FB_SPENT" = 1 ]; } && { result maintenance_ran; exit 0; }
    result no_work; exit 0
  fi
  rm -f "$_merr"
fi

# Nothing ready → idle scan to draft new work (crew). OFF by default: an idle
# factory should just poll + stop, not generate fresh work (and spend tokens) every
# empty tick. Set IDLE_DRAFT_WHEN_IDLE=1 to let it draft new work when the queue is dry.
if [ "${IDLE_DRAFT_WHEN_IDLE:-0}" = "1" ] && [ -f "$CREW_DIR/dist/cli/index.js" ] && [ -f "$CREW_CONFIG" ]; then
  log "no ready tickets → idle scan"
  if [ "$DRY_RUN" = "1" ]; then
    log "DRY_RUN: would run: fg idle"; result no_work; exit 0
  fi
  # The feature-backlog loop already had its turn above this tick — don't run it twice
  # (_FB_LATER is 0 then).
  OUT="$(GAFFER_DATA="$GAFFER_DATA" DISPATCH_DB="${DISPATCH_DB:-}" MEMORY_DB="${MEMORY_DB:-}" MEMORY_MCP_BIN="${MEMORY_MCP_BIN:-}" \
    GAFFER_DECOMPOSE_SCRIPT="$(_gaffer_idle_decompose_script)" CLAUDE_BIN="${CLAUDE_BIN:-claude}" CLAUDE_FLAGS="${CLAUDE_FLAGS:-}" \
    GAFFER_IDLE_FEATURE_BACKLOG="$_FB_LATER" fg idle 2>>"$GAFFER_LOG")"
  # crew idle prints {ok, report:{loops, totalDrafts}, filed, spent, …}. This used to
  # read `outcome.drafts`, a shape crew no longer emits, so every scan logged
  # "0 draft(s)" and reported no_work however much it filed.
  DRAFTS="$(echo "$OUT" | jget 'd.filed ?? (d.report || {}).totalDrafts ?? 0' 2>/dev/null || echo 0)"
  case "$DRAFTS" in ''|*[!0-9]*) DRAFTS=0 ;; esac
  log "idle scan filed $DRAFTS item(s) (drafts, ingested issues, epic tickets, lore suggestions)"
  [ "$DRAFTS" -gt 0 ] && { result idle_drafted; exit 0; }
  [ "$(echo "$OUT" | jget 'd.spent === true ? 1 : 0' 2>/dev/null || echo 0)" = 1 ] && { result maintenance_ran; exit 0; }
fi

# The feature-backlog step paid for a planner call that filed nothing: not an empty
# poll for the day cap (it may have spent), but still an empty poll for draining.
[ "$_FB_SPENT" = 1 ] && { log "no ready tickets; the feature-backlog planner ran but filed nothing"; result maintenance_ran; exit 0; }
log "no ready tickets and nothing to draft"
result no_work
