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
      log "memory: distilled requirement DRAFT from #$NUM (human-gated — \`gaffer lore review\` to ratify; GAFFER_MEMORY_AUTO_PROMOTE=1 to auto-promote)"
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

    # SANDBOX REQUIREMENT, before anything is created. Under GAFFER_STRICT_REQUIRE (every
    # autonomy flag defaults it) the worker seam refuses to spawn without an OS sandbox.
    # Asked only there, the bootstrap had already git-init'd the new repo and parked as a
    # generic "bootstrap failed (rc=75)". Ask the provider now, and park the way a normal
    # delivery does, with the fix on the card. The wrap files a docker/sandbox-exec probe
    # writes carry this tick's PID, so the exit cleanup sweeps them.
    if _sandbox_strict_required && ! sandbox_wrap_cmd "$B_DIR" "" >/dev/null 2>>"$GAFFER_LOG"; then
      _B_SBX_WHY="$(gaffer_sandbox_unavailable_hint)"
      log "STRICT_REQUIRE: bootstrap #$NUM parked before creating $B_DIR — $_B_SBX_WHY"
      wg attach-evidence "$NUM" --type manual_note \
        --summary "PARKED (strict_require_unavailable): $_B_SBX_WHY" >/dev/null 2>&1 || true
      gaffer_release_delivery blocked "$_B_SBX_WHY" strict_require_unavailable
      gaffer_skip_ticket "$NUM"; result error; exit 0
    fi

    # EXECUTION PREFLIGHT (lib/registry-probe.sh): the bootstrap's one permitted
    # install needs the package registry from INSIDE the agent's allowlisted env.
    # Probe it there first — bounded, no model call. A dead registry used to surface
    # only as the agent's npm retrying TLS failures until the 30-min tick timeout,
    # parked as a generic "timeout" (seen live). Clearly non-node stacks skip it.
    _B_OFFLINE_NOTE=""
    case "$(printf '%s' "${STACK:-}" | tr '[:upper:]' '[:lower:]')" in
      python*|go|golang|rust|java|kotlin|ruby|dotnet|csharp|php|elixir|swift|c|cpp|terraform|shell|bash) ;;
      *)
        if declare -F gaffer_registry_probe >/dev/null 2>&1; then
          _PROBE_RC=0; gaffer_registry_probe || _PROBE_RC=$?
          if [ "$_PROBE_RC" -eq 3 ]; then
            # Offline, but the agent's npm cache is warm: go ahead and install from it
            # (the npm_config_ prefix carries this into the agent's env).
            export npm_config_prefer_offline=true
            log "BOOTSTRAP: #$NUM the npm registry is unreachable (${GAFFER_REGISTRY_PROBE_CODE:-offline}) but the npm cache at ${GAFFER_REGISTRY_PROBE_CACHE:-?} is warm — going ahead offline (npm_config_prefer_offline=true)"
            # Said on the card too, and on any park below: a package the cache does not
            # hold fails the install with the same offline error, and that is the cause.
            _B_OFFLINE_NOTE="the npm registry was unreachable (${GAFFER_REGISTRY_PROBE_CODE:-offline}), so this bootstrap installed offline from the npm cache at ${GAFFER_REGISTRY_PROBE_CACHE:-?}; a package that cache does not hold cannot install: connect to the registry (or warm the cache) and move #$NUM back to ready"
            wg attach-evidence "$NUM" --type manual_note \
              --summary "OFFLINE INSTALL: $_B_OFFLINE_NOTE" >/dev/null 2>&1 || true
          fi
          if [ "$_PROBE_RC" -eq 1 ]; then
            _PROBE_WHY="environment: the npm registry is unreachable from the agent env (${GAFFER_REGISTRY_PROBE_CODE:-unknown}) — $(gaffer_registry_probe_hint "${GAFFER_REGISTRY_PROBE_CODE:-}")${GAFFER_REGISTRY_PROBE_NOTE:+; $GAFFER_REGISTRY_PROBE_NOTE}. No model call was spent; fix the environment (runner/preflight.sh runs the same probe) and move #$NUM back to ready."
            log "BOOTSTRAP: #$NUM parked before spawning — $_PROBE_WHY${GAFFER_REGISTRY_PROBE_DETAIL:+ [$GAFFER_REGISTRY_PROBE_DETAIL]}"
            wg attach-evidence "$NUM" --type manual_note \
              --summary "ENVIRONMENT: $_PROBE_WHY" >/dev/null 2>&1 || true
            gaffer_release_delivery blocked "$_PROBE_WHY" env_registry_unreachable
            gaffer_skip_ticket "$NUM"; result error; exit 0
          fi
        fi ;;
    esac

    # BUDGET ADMISSION, before anything is created. worker_deliver asks it again right
    # before the launch (lib/worker.sh); asked only there, a refused bootstrap had
    # already git-init'd the new repo and parked as "bootstrap failed (rc=77)". Asked
    # here too, a cap that is already spent releases the ticket to ready, uncounted and
    # with nothing made, the same way a refused delivery launch is released.
    if [ "${GAFFER_WORKER_PROVIDER:-claude-code}" = "claude-code" ] \
       && declare -F gaffer_paid_launch_admitted >/dev/null 2>&1 \
       && ! gaffer_paid_launch_admitted bootstrap; then
      gaffer_release_delivery ready "the paid bootstrap launch was refused by the budget admission (no agent ran, nothing created); not counted as an attempt" budget_refused
      gaffer_skip_ticket "$NUM"
      log "BUDGET: bootstrap #$NUM — the paid launch was refused by the budget admission (see the line above); released to ready before creating $B_DIR, not counted as an attempt"
      result no_work; exit 0
    fi

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
    # BUDGET ADMISSION REFUSED at the launch itself (a cap reached since the check
    # above): no agent ran, so it is not a failed scaffold. Release to ready uncounted;
    # the dir stays a resumable bootstrap target for the retry.
    if [ "${WORKER_LAST_BUDGET_REFUSED:-0}" = 1 ]; then
      gaffer_release_delivery ready "the paid bootstrap launch was refused by the budget admission (no agent ran); not counted as an attempt (repo kept at $B_DIR)" budget_refused
      gaffer_skip_ticket "$NUM"
      log "BUDGET: bootstrap #$NUM — the paid launch was refused by the budget admission; released to ready without counting an attempt"
      result no_work; exit 0
    fi
    if [ "$brc" -ne 0 ]; then
      # FINDING-12: park bootstrap failures to the VISIBLE `blocked` column (event +
      # attention count in status.sh / the human queue) — `refining` hid them from
      # selection, clarify, status and the human queue.
      gaffer_release_delivery blocked "bootstrap failed (rc=$brc) — scaffold left at $B_DIR for inspection${_B_OFFLINE_NOTE:+; $_B_OFFLINE_NOTE}" bootstrap_failed
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
      gaffer_release_delivery blocked "bootstrap produced no initial commit${_B_OFFLINE_NOTE:+; $_B_OFFLINE_NOTE}" bootstrap_failed
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
      # A new repo has no remote: with PR mode on, ask the person where it lives before
      # the tickets it serves start (lib/greenfield.sh).
      gaffer_bootstrap_remote_decision "$NUM" "$B_NAME" "$B_DIR" || true
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
  # REQUIRED CI IS RECORDED BEFORE REVIEW (external review #9, finding 4): when CI gates
  # this delivery (GAFFER_REQUIRE_CI with PR creation on), dispatch learns that before the
  # ticket is exposed for review, so an approval in the window before the gate reports
  # (or when it never can: no gh, no GitHub remote) is refused, not waved through.
  declare -F gaffer_ci_require_mark >/dev/null 2>&1 && gaffer_ci_require_mark "$NUM"
  if gaffer_submit_delivery "delivered on branch $WORK_BRANCH; gates passed"; then
    log "submitted #$NUM for review (→ in_review) — runner-owned submit"
    gaffer_manifest_finish submit 0
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

  # TESTER FIRST (lib/tester.sh): the gates passed and nothing reviews it before a person
  # (REVIEW_MODE=human), so a delivery the independent tester gates goes to it now, before
  # the person sees it in Review; its PASS brings it back to review. With a reviewer agent
  # (agent|both) the agent review pass routes it after its verdict instead. Dispatch
  # decides whether the tester gates the ticket; fail-soft.
  if [ "${REVIEW_MODE:-human}" = "human" ] && declare -F gaffer_tester_route >/dev/null 2>&1; then
    gaffer_tester_route "$NUM"
  fi

  result worked; exit 0
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
