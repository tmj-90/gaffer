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
# CLI IDENTITY: the runner's own wg calls are the operator's and the system's; a
# principal token inherited from the operator's shell must never make them a
# principal's (whose scope would refuse --as system, repo registration, ...).
unset GAFFER_PRINCIPAL_TOKEN
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
# Tick phases (runner/lib/tick-*.sh), moved out of this file verbatim. Each one is
# REQUIRED: a missing or unreadable file stops the tick here, before any claim, spawn
# or state change (fail closed). They hold function definitions only.
# shellcheck source=lib/tick-helpers.sh
source "$HERE/lib/tick-helpers.sh" || { echo "gaffer: runner/lib/tick-helpers.sh is missing or does not load; refusing to run the tick (fail closed)" >&2; echo "TICK_RESULT=setup_error"; exit 1; }
# shellcheck source=lib/tick-recovery.sh
source "$HERE/lib/tick-recovery.sh" || { echo "gaffer: runner/lib/tick-recovery.sh is missing or does not load; refusing to run the tick (fail closed)" >&2; echo "TICK_RESULT=setup_error"; exit 1; }
# shellcheck source=lib/tick-gates.sh
source "$HERE/lib/tick-gates.sh" || { echo "gaffer: runner/lib/tick-gates.sh is missing or does not load; refusing to run the tick (fail closed)" >&2; echo "TICK_RESULT=setup_error"; exit 1; }
# shellcheck source=lib/tick-claim.sh
source "$HERE/lib/tick-claim.sh" || { echo "gaffer: runner/lib/tick-claim.sh is missing or does not load; refusing to run the tick (fail closed)" >&2; echo "TICK_RESULT=setup_error"; exit 1; }
# shellcheck source=lib/tick-launch.sh
source "$HERE/lib/tick-launch.sh" || { echo "gaffer: runner/lib/tick-launch.sh is missing or does not load; refusing to run the tick (fail closed)" >&2; echo "TICK_RESULT=setup_error"; exit 1; }
# shellcheck source=lib/tick-bootstrap.sh
source "$HERE/lib/tick-bootstrap.sh" || { echo "gaffer: runner/lib/tick-bootstrap.sh is missing or does not load; refusing to run the tick (fail closed)" >&2; echo "TICK_RESULT=setup_error"; exit 1; }
# shellcheck source=lib/tick-close.sh
source "$HERE/lib/tick-close.sh" || { echo "gaffer: runner/lib/tick-close.sh is missing or does not load; refusing to run the tick (fail closed)" >&2; echo "TICK_RESULT=setup_error"; exit 1; }
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
# The safety hook, its decision core, its rule modules and its deny-list sibling must
# ALL be present before we launch a live agent: a missing safety-hook-core.mjs,
# lib/hook/ or lib/dangerous-commands.mjs would make the hook fail-closed at runtime
# (blocking every tool call), but preflighting them here refuses the tick with a clear
# cause instead (lib/hook/decide.mjs stands for the directory; preflight.sh loads
# every module). Returns 1 (logged) if any is absent. Callers apply their own fail-closed
# action (exit 1 / return 1).
gaffer_assert_safety_hook() {
  [ -f "$RUNNER_DIR/safety-hook.mjs" ] \
    || { log "SAFETY: hook missing at $RUNNER_DIR/safety-hook.mjs (fail closed)"; return 1; }
  [ -f "$RUNNER_DIR/safety-hook-core.mjs" ] \
    || { log "SAFETY: hook decision core missing at $RUNNER_DIR/safety-hook-core.mjs — the hook cannot decide; refusing (fail closed)"; return 1; }
  [ -f "$RUNNER_DIR/lib/dangerous-commands.mjs" ] \
    || { log "SAFETY: deny-list missing at $RUNNER_DIR/lib/dangerous-commands.mjs — the hook cannot load its rules; refusing (fail closed)"; return 1; }
  [ -f "$RUNNER_DIR/lib/hook/decide.mjs" ] \
    || { log "SAFETY: hook rule modules missing at $RUNNER_DIR/lib/hook (fail closed)"; return 1; }
  return 0
}
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

# gaffer_quarantine + QUARANTINE_NOTICE are provided by lib/quarantine.sh (sourced
# via factory.config.sh) — they wrap UNTRUSTED ticket-derived fields (title,
# review feedback) in a delimited envelope before they reach the agent prompt.

gaffer_tick_admission   # lib/tick-claim.sh: fail-closed setup checks + spend admission (may exit)

gaffer_tick_register_agents   # lib/tick-claim.sh: the factory agent + reviewer principal (AGENT, REVIEWER_AGENT)

# ── RUNNER-OWNED-BOOKKEEPING: the runner holds the delivery claim ────────────
# The runner (not the agent) claims the chosen ticket at SELECTION, holds the claim
# token for the whole delivery, submits after ITS gates pass, and releases/parks the
# claim on failure. CLAIM_TOKEN is captured by the candidate-loop claim below, or by
# resume-begin for a resumed delivery (which leases the resume to this runner); it
# stays EMPTY for DRY_RUN (never claims) and only falls back to empty on a resume if
# resume-begin printed no token (the tokenless branches below remain for that case).
CLAIM_TOKEN=""








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
  SKIP_FILE="${GAFFER_RUN_STATE_DIR:-$GAFFER_DATA}/.failed-tickets"; touch "$SKIP_FILE"
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

gaffer_tick_resume_begin   # lib/tick-recovery.sh: resume a paused delivery the human pressed Continue on

if [ "$READY_COUNT" -gt 0 ]; then
  gaffer_tick_claim_candidate   # lib/tick-claim.sh: ready-candidate scan + runner-held claim (skipped on a resume)

  gaffer_tick_classify_ticket   # lib/tick-claim.sh: IS_BOOTSTRAP / IS_ACCEPTANCE
  gaffer_tick_bootstrap   # lib/tick-bootstrap.sh: a bootstrap ticket is delivered here and the tick exits

  gaffer_tick_resolve_scope   # lib/tick-claim.sh: write/read partition, skills + lenses, no-local-path park

  gaffer_tick_plan_worktrees   # lib/tick-claim.sh: primary repo, branch name, self-operation ban, WT_ROWS

  gaffer_tick_gather_prompt_inputs   # lib/tick-launch.sh: raw prompt inputs + PROMPT (crew renders the text)

  gaffer_tick_route_model   # lib/tick-launch.sh: model routing; DRY_RUN previews and exits here

  gaffer_tick_create_worktrees   # lib/tick-launch.sh: delivery worktrees + base commits (defines gaffer_cleanup_worktrees)

  # Live: install the factory's MCP servers, safety hook + permissions, skills and
  # brief as PROJECT-LOCAL config so headless Claude auto-loads them, then run. The
  # PreToolUse hook is the safety boundary; env carries the two server DB paths.
  # Fail CLOSED: the safety hook is THE deterministic boundary. If it's missing,
  # never run a live agent — Claude Code would otherwise run with no boundary.
  gaffer_assert_safety_hook || gaffer_abort_setup SAFETY "refusing live run (fail closed)"

  gaffer_tick_prepare_launch   # lib/tick-launch.sh: agent env, MCP runtime, sandbox strictness
  gaffer_tick_delivery_attempts   # lib/tick-gates.sh: GUARD B: the bounded attempt loop, launch + every gate

  gaffer_tick_close_delivery   # lib/tick-close.sh: submit, records, PR / CI gate, tester route; exits worked
fi

# ── Agent review ─────────────────────────────────────────────────────────────
# If review_mode includes agents, a reviewer agent (NOT the implementer) reviews
# an in_review ticket and approves/rejects via the review CLI. Runs when nothing
# is ready, so delivery is prioritised; a ticket the reviewer doesn't resolve is
# skipped to avoid re-review loops (loop.sh clears the file each run).
_gaffer_agent_review_pass

# ── Independent tester lane ── lib/tester.sh. Sends in_review tickets the tester gates
# to it (tester first, REVIEW_MODE=human), then hands the next `in_testing` ticket to the
# black-box tester agent (bin/tester-run.mjs --live); PASS → back to review (or
# ready_for_merge after an agent's approval), FAIL → refining, no verdict → held for a
# human. Exits the tick when it tests one; otherwise returns and the flow falls through.
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
