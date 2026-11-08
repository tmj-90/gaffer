# shellcheck shell=bash
# runner/config/07-limits.sh: limits and timing: per-call wall clock and turn caps, the Definition-of-Done
# gate knobs, sandbox resources, the daemon cadence, delivery attempts, the claim
# TTL, the outer tick bound and deadline guard, rework escalation and its bounds.
# Sourced by runner/factory.config.sh only, in its fixed order, never directly or on
# its own: it reads what the parts before it set. Lines moved verbatim from
# factory.config.sh. The last line tells factory.config.sh this part loaded whole.

# --- Per-call resource caps (P1 denial-of-wallet / token runaway) ------------
# Every headless `claude -p` call (delivery, bootstrap, review, security review,
# clarify, eval judge, and the .mjs helpers: planner, spec author, onboarding,
# product owner, tester, merge resolver) — and the whole tick.sh from loop.sh —
# runs under TWO bounds so a single runaway call can't burn unbounded wall-clock
# OR unbounded tokens:
#   GAFFER_TICK_TIMEOUT — wall-clock seconds before the call is killed (SIGTERM).
#   GAFFER_MAX_TURNS    — agent turn cap, passed to `claude --max-turns`. Bounds the
#                        number of model round-trips (the real token-spend driver).
#                        It is the DELIVERY/BOOTSTRAP cap and a CEILING for every
#                        other role: a role runs under min(its own cap, this), so
#                        the global can lower a role cap but never raise or replace it.
# Per-role caps (each clamped to GAFFER_MAX_TURNS), one knob for all of them:
# GAFFER_ROLE_MAX_TURNS="review=30 tester=120" (commas or spaces) sets the roles it
# names; every other role keeps its built-in cap, listed with gaffer_role_cap below:
# review 60, security_review 40, clarify 40, judge 2, tester 80, merge 60 (the
# conflict resolver), po 60, scout 6, onboard 60, decompose and spec_author (their
# helper's own cap, 20). Sized well above what each role's prompt asks for (the reviewer is told "well under 20 tool calls", the
# security reviewer "under 12") so a normal run never trips them — they only stop
# an agent that has gone off-track. The judge has no tools, so one turn ends it.
# A capped run that stops before its verdict line is HELD for a human (no verdict is
# never an approve; a reviewer cap hit is named in the hold reason), so when tuning a
# cap start near the role's 90th-percentile turn count in usage-ledger.jsonl
# (num_turns), not its mean, or the tail of ordinary runs is held.
# The .mjs helpers read the same knob (lib/worker.mjs roleTurns). The planner's and
# spec author's own GAFFER_DECOMPOSE_MAX_TURNS / GAFFER_SPEC_AUTHOR_MAX_TURNS (20)
# are also their HISTORY ceiling (--max-rounds); decompose= / spec_author= cap their
# agent on its own (still clamped to GAFFER_MAX_TURNS).
# The old per-role variables (GAFFER_REVIEW_MAX_TURNS, GAFFER_TESTER_MAX_TURNS, ...)
# are deprecated: still honoured for a role the knob does not name, with a warning.
# macOS ships NO GNU `timeout`, so gaffer_timeout is a portable shim built on perl's
# alarm(): `gaffer_timeout <secs> <cmd> [args…]` runs <cmd> and kills it after <secs>.
# If perl is somehow absent it falls back to GNU `timeout`/`gtimeout` when present,
# else runs the command unbounded (best-effort — never breaks the call).
: "${GAFFER_TICK_TIMEOUT:=1800}"   # 30 min hard wall-clock cap per claude -p call
: "${GAFFER_MAX_TURNS:=200}"        # max agent turns per delivery call; ceiling for every role
: "${GAFFER_ROLE_MAX_TURNS:=}"   # per-role turn caps as "role=N" pairs (review, security_review, clarify, judge, tester, merge, po, scout, onboard, decompose, spec_author); an unnamed role keeps its built-in cap; all are clamped to GAFFER_MAX_TURNS.
export GAFFER_ROLE_MAX_TURNS

# _gaffer_deprecated <old-name> <what to set instead> — a deprecated variable that is
# set says so on stderr once per process tree (the parent's mark is exported, so a
# child that sources this file again stays quiet). Deprecated names keep working for
# one release; docs/CONFIG.md lists them with their replacement.
_gaffer_deprecated() {
  [ -n "${!1:-}" ] || return 0
  case "${_GAFFER_DEPRECATED_SAID:-}" in *" $1 "*) return 0 ;; esac
  printf 'gaffer: %s is deprecated and goes in the next release; %s\n' "$1" "$2" >&2
  _GAFFER_DEPRECATED_SAID="${_GAFFER_DEPRECATED_SAID:- } $1 "
  export _GAFFER_DEPRECATED_SAID
}
for _gd in REVIEW SECURITY_REVIEW CLARIFY JUDGE TESTER MERGE RESOLVER PO SCOUT DECOMPOSE_AGENT SPEC_AUTHOR_AGENT ONBOARD; do
  case "$_gd" in
    RESOLVER) _gr=merge ;;
    DECOMPOSE_AGENT) _gr=decompose ;;
    SPEC_AUTHOR_AGENT) _gr=spec_author ;;
    *) _gr="$(printf '%s' "$_gd" | tr '[:upper:]' '[:lower:]')" ;;
  esac
  _gaffer_deprecated "GAFFER_${_gd}_MAX_TURNS" "set GAFFER_ROLE_MAX_TURNS=\"$_gr=N\" instead"
done
unset _gd _gr
# Definition-of-Done gate switches + bounds. The consumers (tick.sh, lib/dod.sh,
# lib/ac-checks.sh) carry the SAME fallbacks, so these lines change nothing at
# runtime — they exist so the knobs are documented here (docs/CONFIG.md) and
# settable from one place like every other operator knob.
: "${GAFFER_DOD_TESTS:=1}"           # 1 = run the repo's test gate on every delivery; 0 skips it
: "${GAFFER_DOD_LINT:=1}"            # 1 = run the lint gate
: "${GAFFER_DOD_TYPECHECK:=1}"       # 1 = run the typecheck gate (auto-detected command)
: "${GAFFER_DOD_TYPECHECK_CMD:=}"    # override the auto-detected typecheck command
: "${GAFFER_DOD_TIMEOUT:=900}"       # wall-clock cap (seconds) per gate and per AC check command
# (GAFFER_TEST_PATH_RE, an extra test-path regex that can only widen the gate-integrity
# check, is read by crew's integrity CLI and dispatch's risk annotation from their own
# environment; the empty, unexported default that stood here reached neither.)
# Run the DoD gates + AC check commands under the SAME OS sandbox wrap as the agent
# (they execute agent-modified code). 0 opts out (a gate that cannot run inside the
# image) and is logged; the verdict is always recorded by the runner outside the gate.
: "${GAFFER_DOD_SANDBOX:=1}"
# PR mode: when `gh pr merge` fails or gh is absent, 1 lands the branch LOCALLY (the PR
# stays open — the previous behaviour). Default 0: HOLD the ticket at ready_for_merge
# for a human; "done" means the PR merged upstream.
: "${GAFFER_PR_LOCAL_FALLBACK:=0}"
export GAFFER_DOD_SANDBOX GAFFER_PR_LOCAL_FALLBACK   # read by lib/dod.sh, lib/land.sh and bin/merge-ticket.mjs (a child process)
# docker provider: run the MCP data plane (dispatch + memory servers) on the HOST and
# bridge the container to it over one unix socket (lib/mcp-bridge.mjs), so no database,
# ledger, claim token or settings file is in the worker's filesystem. auto = on, except
# on macOS (Docker Desktop cannot bind-mount a host unix socket) where it is off and the
# wrapper logs that the data plane runs inside. 1 forces on, 0 forces off.
: "${GAFFER_MCP_BRIDGE:=auto}"
export GAFFER_MCP_BRIDGE
GAFFER_DOD_OUTPUT_TAIL="${GAFFER_DOD_OUTPUT_TAIL:-40}"    # lines of gate output kept as evidence / rework feedback
# Docker sandbox resource caps (lib/sandbox-docker.sh) and the daemon cadence (lib/daemon.sh).
: "${GAFFER_SANDBOX_CPUS:=4}"
: "${GAFFER_SANDBOX_MEMORY:=4g}"
: "${GAFFER_SANDBOX_PIDS:=512}"
: "${GAFFER_DAEMON_INTERVAL:=30}"    # seconds between `gaffer run --daemon` cycles
GAFFER_DAEMON_MAX_CYCLES="${GAFFER_DAEMON_MAX_CYCLES:-0}"   # 0 = unbounded
GAFFER_DAEMON_SETUP_BACKOFF_MAX="${GAFFER_DAEMON_SETUP_BACKOFF_MAX:-1800}"   # ceiling (s) of the daemon's doubling wait after a setup-error pass (loop.sh exit 3)
GAFFER_MAX_TURNS_FLAG=""; [ -n "${GAFFER_MAX_TURNS:-}" ] && GAFFER_MAX_TURNS_FLAG="--max-turns $GAFFER_MAX_TURNS"
export GAFFER_TICK_TIMEOUT GAFFER_MAX_TURNS

# gaffer_role_cap <role> <built-in cap>
# Echo one role's own turn cap, before the GAFFER_MAX_TURNS ceiling: its entry in
# GAFFER_ROLE_MAX_TURNS, else its deprecated variable (the resolver spelling before the
# merge one), else the built-in cap. A zero or non-numeric value is skipped. Parity
# with roleTurnsSetting in lib/worker.mjs. Callers clamp it with gaffer_role_turns.
gaffer_role_cap() {
  local role="${1:-}" v="" pair alias
  local -a pairs=()
  IFS=$', \t\n' read -r -a pairs <<<"${GAFFER_ROLE_MAX_TURNS:-}"
  for pair in ${pairs[@]+"${pairs[@]}"}; do
    case "$pair" in "$role="*) v="${pair#*=}"; case "$v" in '' | *[!0-9]* | 0) v="" ;; *) break ;; esac ;; esac
  done
  if [ -z "$v" ]; then
    case "$role" in
      review) alias="GAFFER_REVIEW_MAX_TURNS" ;;
      security_review) alias="GAFFER_SECURITY_REVIEW_MAX_TURNS" ;;
      clarify) alias="GAFFER_CLARIFY_MAX_TURNS" ;;
      judge) alias="GAFFER_JUDGE_MAX_TURNS" ;;
      tester) alias="GAFFER_TESTER_MAX_TURNS" ;;
      merge) alias="GAFFER_RESOLVER_MAX_TURNS GAFFER_MERGE_MAX_TURNS" ;;
      po) alias="GAFFER_PO_MAX_TURNS" ;;
      scout) alias="GAFFER_SCOUT_MAX_TURNS" ;;
      decompose) alias="GAFFER_DECOMPOSE_AGENT_MAX_TURNS" ;;
      spec_author) alias="GAFFER_SPEC_AUTHOR_AGENT_MAX_TURNS" ;;
      onboard) alias="GAFFER_ONBOARD_MAX_TURNS" ;;
      *) alias="" ;;
    esac
    for pair in $alias; do
      v="${!pair:-}"; case "$v" in '' | *[!0-9]* | 0) v="" ;; *) break ;; esac
    done
  fi
  printf '%s' "${v:-${2:-}}"
}

# gaffer_role_turns <role-cap>
# Echo the effective turn cap for one role: min(role cap, GAFFER_MAX_TURNS). A
# non-numeric / empty role cap falls back to the global; an unset global leaves the
# role cap as is. Empty output = no cap (both unset). worker_deliver takes this
# number as its 7th argument (a per-call override of $GAFFER_MAX_TURNS_FLAG).
gaffer_role_turns() {
  local role="${1:-}" glob="${GAFFER_MAX_TURNS:-}"
  case "$role" in '' | *[!0-9]* | 0) role="" ;; esac
  case "$glob" in '' | *[!0-9]* | 0) glob="" ;; esac
  if [ -n "$role" ] && [ -n "$glob" ] && [ "$glob" -lt "$role" ]; then role="$glob"; fi
  printf '%s' "${role:-$glob}"
}

# RUNNER-OWNED-BOOKKEEPING: the runner (not the agent) claims the delivery ticket at
# selection and holds the claim for the whole delivery. The lease TTL must therefore
# cover EVERY attempt of one delivery (up to GAFFER_MAX_DELIVERY_ATTEMPTS agent runs,
# each bounded by GAFFER_TICK_TIMEOUT) plus the runner's own gate/record/submit time —
# so a normal delivery never needs a heartbeat. The runner ALSO heartbeats the claim
# at the start of each retry attempt (belt-and-braces), so even a mis-sized TTL can't
# let the lease lapse mid-delivery. Default: attempts × timeout + 5 min margin.
#
# Default is 3 (was 2) to give the ESCALATION LADDER room to work: attempt 1 delivers
# with the routed model + the real failure fed back; attempt 2 RETHINKS the approach
# (re-plan, optionally narrower scope); attempt 3 escalates to a STRONGER model
# (GAFFER_REWORK_STRONG_MODEL) with the full feedback history. Set to 1 to disable
# rework entirely (one attempt, then park to `blocked`).
: "${GAFFER_MAX_DELIVERY_ATTEMPTS:=3}"
# WASTE CONTROL: a ticket re-entered by a LATER tick (review CHANGES rework, a resumed
# pause, a re-queued retry) keeps its branch's commits; 1 = reset it to base for that
# tick (in-tick rework is never reset). In-tick rework — the up to
# GAFFER_MAX_DELIVERY_ATTEMPTS re-runs inside one tick after a gate failure — always
# continues on the agent's own commits, because its feedback is about that diff.
: "${GAFFER_RETRY_FRESH_BRANCH:=0}"
GAFFER_CLAIM_TTL="${GAFFER_CLAIM_TTL:-$(( ${GAFFER_MAX_DELIVERY_ATTEMPTS:-3} * ${GAFFER_TICK_TIMEOUT:-1800} + 300 ))}"
export GAFFER_MAX_DELIVERY_ATTEMPTS GAFFER_CLAIM_TTL
# DISPATCH_MAX_ATTEMPTS — Dispatch's OWN reject-loop cap (packages/dispatch/src/core.ts
# resolveMaxAttempts): a delivery rejected back into the queue this many times is
# PARKED (blocked) for a human, enforced server-side on every reject transition. It
# is a SECOND attempt cap next to GAFFER_MAX_DELIVERY_ATTEMPTS (the runner's rework
# ladder); B29: it was read by Dispatch but never set or exported here, so the two
# could silently disagree and the dashboard could not show it. Default it to the
# runner's cap so they agree by construction, and EXPORT it so the `wg` CLI, the
# MCP server and the dashboard all read the same value. Settings-UI editable.
: "${DISPATCH_MAX_ATTEMPTS:=$GAFFER_MAX_DELIVERY_ATTEMPTS}"
export DISPATCH_MAX_ATTEMPTS

# FINDING-6 (a): the OUTER per-tick wall-clock bound loop.sh/worker.sh wrap around
# the WHOLE tick.sh. It must mirror the claim-TTL math above, NOT the single-call
# cap: one tick may legitimately run the whole rework ladder (up to
# GAFFER_MAX_DELIVERY_ATTEMPTS agent calls, EACH individually bounded by
# GAFFER_TICK_TIMEOUT). The old GAFFER_TICK_TIMEOUT + 60 sizing forbade the ladder
# — whenever attempt 1 used most of one window, attempts 2..N (including the
# strong-model FINAL attempt) were killed mid-run. Sized attempts × timeout + 2 min:
# the margin covers the runner's own gate/record/submit time while staying safely
# BELOW GAFFER_CLAIM_TTL (+300), so when this bound DOES fire the crash-trap
# claim-release (given GAFFER_REAP_GRACE below) still lands on a live lease. The
# inner per-call caps remain the fine-grained defense; this is only the backstop
# for a tick wedged OUTSIDE an agent call.
GAFFER_TICK_OUTER_TIMEOUT="${GAFFER_TICK_OUTER_TIMEOUT:-$(( ${GAFFER_MAX_DELIVERY_ATTEMPTS:-3} * ${GAFFER_TICK_TIMEOUT:-1800} + 120 ))}"
export GAFFER_TICK_OUTER_TIMEOUT
# TICK DEADLINE GUARD (tick.sh): the outer bound above counts only agent calls, but a
# tick also spends merge-lane resolver time and every attempt's DoD install, gates and
# AC checks. Before each delivery attempt the tick checks the time left until
# (start + GAFFER_TICK_OUTER_TIMEOUT - GAFFER_TICK_DEADLINE_MARGIN); when it is less
# than GAFFER_TICK_TIMEOUT plus the previous attempt's measured gate time, it does NOT
# start an attempt the outer bound would kill — it keeps the branch and releases the
# ticket for the next tick (bounded across runs like a no-commit failure). Attempt 1 is
# never refused this way (nothing is spent yet): its agent call is clamped to the time
# left instead. Gate and AC timeouts are also clamped to the time left. 0 = off (start
# every attempt, as before).
: "${GAFFER_TICK_DEADLINE_GUARD:=1}"
GAFFER_TICK_DEADLINE_MARGIN="${GAFFER_TICK_DEADLINE_MARGIN:-60}"   # seconds kept back for record / release / teardown

# ESCALATION: the model the FINAL rework attempt escalates to (stronger reasoning
# for the hardest cases before a human is pulled in). Empty → keep the routed model
# (no escalation). Defaults to the plan tier (opus) so the last attempt reasons as
# hard as the planner does.
: "${GAFFER_REWORK_STRONG_MODEL:=${GAFFER_PLAN_MODEL:-opus}}"
export GAFFER_REWORK_STRONG_MODEL

# DOUBLE-BOUND: a per-ticket rework COST ceiling (USD). The rework loop stops at
# whichever hits FIRST — the attempt cap (above) OR this cumulative per-ticket spend
# (every agent call booked to the ticket: delivery, review, security review, clarify,
# eval judge, bootstrap, tester, merge resolver) — then parks to `blocked` (rework_exhausted). Prevents unbounded token burn on one
# stubborn ticket even when attempts remain. Defaults to the factory-wide
# GAFFER_BUDGET_USD (a single ticket may not consume the whole budget on rework);
# empty/0 → no per-ticket ceiling (attempt cap alone bounds it).
: "${GAFFER_REWORK_BUDGET_USD:=${GAFFER_BUDGET_USD:-}}"
export GAFFER_REWORK_BUDGET_USD

# FINDING-3: the CROSS-RUN bound on no-commit / wrong-branch delivery failures.
# The per-run skip-file only stops a re-pick WITHIN one run; a ticket whose agent
# deterministically crashes before committing was released back to `ready` and
# re-picked every run — one full `claude -p` burned per run, forever, at
# ESCALATING cost (the accumulated ledger spend feeds the difficulty router).
# tick.sh counts these failures durably (per-ticket, under $GAFFER_DATA) and
# after this many parks the ticket VISIBLY to `blocked` (rework_exhausted) —
# the same double-bound shape as the in-delivery rework loop, so it defaults to
# (and stays aligned with) GAFFER_MAX_DELIVERY_ATTEMPTS. ≥1; the counter resets
# on a successful submit or on any park out of the delivery pipeline.
: "${GAFFER_MAX_NOCOMMIT_FAILURES:=${GAFFER_MAX_DELIVERY_ATTEMPTS:-3}}"
export GAFFER_MAX_NOCOMMIT_FAILURES

_GAFFER_CONFIG_PART=07-limits
