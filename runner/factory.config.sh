# Gaffer factory configuration — source-controlled defaults; override any with env.
# shellcheck shell=bash

# This file lives in runner/ of the Gaffer monorepo, so RUNNER_DIR is its own dir
# and GAFFER_HOME is the mono root — which holds runner/ alongside
# packages/{dispatch,crew,memory}. Derive both from the script location
# so the suite works under any checkout root — no hardcoded /Users/<name> path.
# Still env-overridable: a side-by-side (non-mono) checkout can point these elsewhere.
: "${RUNNER_DIR:=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
: "${GAFFER_HOME:=$(cd "$RUNNER_DIR/.." && pwd)}"
: "${GAFFER_DATA:=$GAFFER_HOME/.gaffer}"                       # factory state (dbs, logs, agent id)

# UI-editable settings. The dashboard Settings panel persists a flat {"KEY":"value"}
# map to $GAFFER_DATA/settings.json. Apply them as defaults HERE — before the config
# defaults below — with `:=` so a real env var ALWAYS overrides the file (env wins).
# Keys are validated to env-var-name shape so a tampered file can't inject anything;
# values are bash vars (never eval'd), tabs/newlines stripped.
if [ -f "$GAFFER_DATA/settings.json" ] && command -v node >/dev/null 2>&1; then
  while IFS=$'\t' read -r _sk _sv; do
    # eval KEPT: this is a dynamic-NAME `:=` default assignment (env always wins),
    # not a command seam. The key is shape-validated above; the value is only ever
    # *assigned* to that var, never re-parsed as a command. No argv form expresses
    # "assign-if-unset to a variable whose name is in $_sk".
    case "$_sk" in
      [A-Z_][A-Z0-9_]*) eval ": \${$_sk:=\$_sv}" ;;
    esac
  done < <(node -e 'try{const s=require(process.argv[1]);for(const[k,v]of Object.entries(s))process.stdout.write(k+"\t"+String(v).replace(/[\t\n\r]/g," ")+"\n")}catch{}' "$GAFFER_DATA/settings.json")
  unset _sk _sv
fi

# Product locations (mono layout: packages/* under the repo root)
: "${DISPATCH_DIR:=$GAFFER_HOME/packages/dispatch}"
: "${CREW_DIR:=$GAFFER_HOME/packages/crew}"
: "${MEMORY_DIR:=$GAFFER_HOME/packages/memory}"   # memory-mcp, vendored into the mono

# Shared databases (the two MCP servers read these)
: "${DISPATCH_DB:=$GAFFER_DATA/dispatch.sqlite}"
: "${MEMORY_DB:=$GAFFER_DATA/memory.sqlite}"
: "${CREW_CONFIG:=$GAFFER_DATA/crew.yaml}"

# Claude Code wiring
: "${MCP_CONFIG:=$RUNNER_DIR/.mcp.json}"
: "${CLAUDE_SETTINGS:=$RUNNER_DIR/claude/settings.json}"
: "${SKILLS_DIR:=$RUNNER_DIR/skills}"
: "${CLAUDE_BIN:=claude}"                                   # headless `claude -p`
: "${CLAUDE_FLAGS:=--permission-mode acceptEdits}"          # tune to your Claude Code version

# Model tiering: a strong model PLANS, a fast model IMPLEMENTS + TESTS. Set either
# to empty to fall back to the Claude default for that step. The steps split as:
#   PLAN  → decompose (plan-build), clarify, product-owner   (deep reasoning)
#   IMPL  → delivery, greenfield bootstrap, merge-conflict resolve (write code + tests)
# The .mjs steps read GAFFER_PLAN_MODEL / GAFFER_IMPL_MODEL from the env (exported
# below); the bash call sites use the pre-split *_FLAG vars.
# No colon: default only when UNSET, so an explicit empty value disables tiering
# (falls back to the Claude default) rather than being re-defaulted.
#
# I1 routing: the static defaults below (opus/sonnet) are NOT treated as routing
# overrides — they are the registry-equivalent baseline, so the router runs by
# default and reproduces today's tiers (plan=opus / implement=sonnet) for a normal
# ticket. An override is an EXPLICIT operator-set value: we capture "was it set
# before config applied a default?" HERE, before the `=` default, so the router
# (gaffer_route_model) can honour a pinned model while still routing otherwise.
[ -n "${GAFFER_PLAN_MODEL+x}" ] && GAFFER_PLAN_MODEL_EXPLICIT=1 || GAFFER_PLAN_MODEL_EXPLICIT=0
[ -n "${GAFFER_IMPL_MODEL+x}" ] && GAFFER_IMPL_MODEL_EXPLICIT=1 || GAFFER_IMPL_MODEL_EXPLICIT=0
export GAFFER_PLAN_MODEL_EXPLICIT GAFFER_IMPL_MODEL_EXPLICIT
: "${GAFFER_PLAN_MODEL=opus}"
: "${GAFFER_IMPL_MODEL=sonnet}"
export GAFFER_PLAN_MODEL GAFFER_IMPL_MODEL
GAFFER_PLAN_MODEL_FLAG=""; [ -n "${GAFFER_PLAN_MODEL:-}" ] && GAFFER_PLAN_MODEL_FLAG="--model $GAFFER_PLAN_MODEL"
GAFFER_IMPL_MODEL_FLAG=""; [ -n "${GAFFER_IMPL_MODEL:-}" ] && GAFFER_IMPL_MODEL_FLAG="--model $GAFFER_IMPL_MODEL"

# --- Intelligent, data-driven MODEL ROUTING (audit item I1) -------------------
# The static GAFFER_PLAN_MODEL / GAFFER_IMPL_MODEL tiers above give EVERY ticket
# the same model regardless of risk/complexity/history. I1 layers a deterministic,
# CONFIG-DRIVEN ROUTER on top: a pure function (bin/route-model.mjs) maps a routing
# context (phase, risk, AC count, stack, attempt, budget) to a concrete model id,
# reading a named-tier REGISTRY (runner/model-registry.json). The decision is made
# in CODE, never by an agent, and every decision is logged (gaffer_route_model →
# the "ROUTE #N …" factory-log line) so an operator can answer "why did ticket N
# use opus?". ADDING A MODEL/PROVIDER OR CHANGING A TIER IS A CONFIG EDIT in that
# JSON (or GAFFER_MODEL_REGISTRY pointing elsewhere) — not a code change.
#
# BACKWARD COMPATIBLE: the default registry resolves a normal ticket to
# plan=strong=opus / implement=mid=sonnet — exactly today's tiers — so a normal
# ticket is unchanged. An OPERATOR-SET GAFFER_PLAN_MODEL / GAFFER_IMPL_MODEL still
# pins the model (the override path in gaffer_route_model); the config's own
# opus/sonnet DEFAULTS are the routing baseline, not an override, so they don't
# suppress risk/attempt-aware routing (see GAFFER_*_MODEL_EXPLICIT above).
: "${GAFFER_MODEL_REGISTRY:=$RUNNER_DIR/model-registry.json}"
# H1 cost/budget visibility knobs.
# GAFFER_BUDGET_USD — operator spending ceiling in USD for the factory's total
#   spend (summed from the usage-ledger). Unset or 0 = unlimited (the default).
#   Example: GAFFER_BUDGET_USD=5.00 (stop routing to expensive models at $5).
: "${GAFFER_BUDGET_USD:=}"
export GAFFER_BUDGET_USD

# GAFFER_BUDGET_REMAINING — live USD headroom. Recomputed here from the ledger
# so the I1 router (gaffer_route_model) and Guard C (ask-on-cap) can read a
# real figure instead of "unlimited". Empty = unlimited (GAFFER_BUDGET_USD unset
# or ledger unreadable). Updated every time factory.config.sh is sourced (once
# per tick at source-time in tick.sh / loop.sh).
if [ -n "${GAFFER_BUDGET_USD:-}" ] && command -v node >/dev/null 2>&1 \
   && [ -n "${GAFFER_USAGE_LEDGER:-}${GAFFER_DATA:-}" ]; then
  _gaffer_budget_remaining="$(node - <<'__BUDGET_JS__' 2>/dev/null || true
const fs = require('fs');
const path = require('path');
const ledger = process.env.GAFFER_USAGE_LEDGER ||
  (process.env.GAFFER_DATA ? path.join(process.env.GAFFER_DATA, 'usage-ledger.jsonl') : '');
if (!ledger) { process.stdout.write(''); process.exit(0); }
let spend = 0;
try {
  const lines = fs.readFileSync(ledger, 'utf8').split('\n');
  for (const ln of lines) {
    const t = ln.trim(); if (!t) continue;
    try {
      const r = JSON.parse(t);
      const c = r.total_cost_usd;
      if (typeof c === 'number' && Number.isFinite(c) && c >= 0) spend += c;
    } catch { /* skip malformed */ }
  }
} catch { /* missing ledger = 0 spend */ }
const budget = parseFloat(process.env.GAFFER_BUDGET_USD || '0');
if (budget <= 0) { process.stdout.write(''); process.exit(0); }
const remaining = Math.max(0, budget - spend);
process.stdout.write(remaining.toFixed(6));
__BUDGET_JS__
)"
  : "${GAFFER_BUDGET_REMAINING:=$_gaffer_budget_remaining}"
  unset _gaffer_budget_remaining
else
  # No budget configured or node unavailable → unlimited (the pre-H1 default).
  : "${GAFFER_BUDGET_REMAINING:=}"
fi
# GAFFER_BUDGET_LOW_THRESHOLD — the USD headroom at/under which the router biases
# one tier CHEAPER (the "cost-as-control" downgrade). Promoting cost to a real
# CONTROL (not just an observed number): when a budget IS configured but no explicit
# threshold is set, DERIVE one as a fraction of the budget so the downgrade actually
# fires as the factory approaches its ceiling — spend then steers routing instead of
# only being reported. Unset budget → 0 (inert, the pre-H1 default). An explicit
# operator value always wins.
if [ -z "${GAFFER_BUDGET_LOW_THRESHOLD:-}" ] && [ -n "${GAFFER_BUDGET_USD:-}" ] \
   && command -v awk >/dev/null 2>&1; then
  # Default: bias cheaper once headroom drops below 20% of the configured budget.
  GAFFER_BUDGET_LOW_THRESHOLD="$(awk "BEGIN{b=${GAFFER_BUDGET_USD}+0; if(b>0) printf \"%.6f\", b*${GAFFER_BUDGET_LOW_FRACTION:-0.20}; else print 0}" 2>/dev/null || echo 0)"
fi
: "${GAFFER_BUDGET_LOW_THRESHOLD:=0}"
# GAFFER_CHEAP_PHASES — cost-as-control class knob (Settings). A comma/space list of
# PHASES whose work the operator wants biased toward the cheap tier (e.g.
# "self-review,test,onboarding"). The router (route-model.mjs cheapClassFromEnv)
# reads this and biases one tier cheaper for a matching phase — but never overrides a
# high/critical-risk escalation. Empty (default) = no class is force-cheapened.
: "${GAFFER_CHEAP_PHASES:=}"
export GAFFER_MODEL_REGISTRY GAFFER_BUDGET_REMAINING GAFFER_BUDGET_LOW_THRESHOLD GAFFER_CHEAP_PHASES

# gaffer_route_model <phase> <risk> <ac_count> <stack> <attempt> [ticket]
# Deterministic per-phase model routing. Echoes the resolved MODEL ID on stdout
# (empty → no model id; caller falls back to the Claude default), and LOGS one
# auditable "ROUTE #<ticket> …" line with the inputs + chosen tier/model/reasons.
# An OPERATOR-SET GAFFER_<PHASE>_MODEL override wins (backward-compat): for an
# implement/test phase GAFFER_IMPL_MODEL wins; for decompose/plan GAFFER_PLAN_MODEL
# wins — exactly the two knobs that exist today (honoured only when *_EXPLICIT=1,
# i.e. the operator set it — not the config default). Best-effort + fail-safe: if node
# or the router is somehow unavailable the function echoes the matching static tier
# and never aborts the tick.
gaffer_route_model() {
  local phase="${1:-implement}" risk="${2:-}" ac="${3:-0}" stack="${4:-}" attempt="${5:-1}" ticket="${6:-}" worktree="${7:-}"
  # Backward-compatible EXPLICIT overrides (the two knobs that exist today). They
  # win ONLY when the operator set them in the environment — NOT when they hold the
  # config's own opus/sonnet defaults (those are the registry-equivalent baseline,
  # so the router runs and reproduces today's tiers). *_EXPLICIT is captured in the
  # model block above, before the `=` default is applied. An explicit empty value
  # ("disable tiering") is honoured too: it routes to the Claude default for the
  # phase. We still emit an audit line recording the override.
  local override="" overrode=0
  case "$phase" in
    decompose|plan) [ "${GAFFER_PLAN_MODEL_EXPLICIT:-0}" = 1 ] && { override="${GAFFER_PLAN_MODEL:-}"; overrode=1; } ;;
    *)              [ "${GAFFER_IMPL_MODEL_EXPLICIT:-0}" = 1 ] && { override="${GAFFER_IMPL_MODEL:-}"; overrode=1; } ;;
  esac
  if [ "$overrode" = 1 ]; then
    log "ROUTE${ticket:+ #$ticket} phase=$phase risk=${risk:-medium} ac=$ac attempt=$attempt budget=${GAFFER_BUDGET_REMAINING:-unlimited} → model=$override (explicit GAFFER_*_MODEL override)"
    printf '%s' "$override"
    return 0
  fi
  local node_bin; node_bin="$(command -v node 2>/dev/null || true)"
  if [ -z "$node_bin" ] || [ ! -f "$RUNNER_DIR/bin/route-model.mjs" ]; then
    # Fail-safe: no router available → fall back to the static tier for this phase.
    case "$phase" in
      decompose|plan) printf '%s' "${GAFFER_PLAN_MODEL:-}" ;;
      *)              printf '%s' "${GAFFER_IMPL_MODEL:-}" ;;
    esac
    return 0
  fi
  # DIFFICULTY signals (3b): feed the router the MEASURED difficulty of this ticket so
  # a hard one routes stronger FROM THE START (not only after an attempt fails). The
  # always-available signal is this ticket's accumulated measured spend (a costly area
  # is a hard area); when a delivery worktree with commits exists (rework), we ALSO
  # measure the accumulated diff size + file count. All best-effort — a missing signal
  # simply doesn't vote (scoreDifficulty reads "medium").
  local _diff_args=()
  if [ -n "$ticket" ]; then
    # Only a POSITIVE measured spend is a difficulty signal — $0 means "no history
    # yet" (a fresh ticket), which must read as unknown/medium, never as "easy".
    local _hist; _hist="$(gaffer_ticket_rework_spend "$ticket" 2>/dev/null || echo 0)"
    if [ -n "$_hist" ] && awk "BEGIN{exit !(${_hist:-0}+0 > 0)}" 2>/dev/null; then
      _diff_args+=(--historical-cost "$_hist")
    fi
  fi
  if [ -n "$worktree" ] && [ -d "$worktree/.git" -o -f "$worktree/.git" ] \
     && command -v git >/dev/null 2>&1; then
    local _db _fc
    _db="$(git -C "$worktree" diff --stat=10000 HEAD 2>/dev/null | wc -c | tr -d ' ' || echo 0)"
    _fc="$(git -C "$worktree" diff --name-only HEAD 2>/dev/null | grep -c . || echo 0)"
    [ "${_db:-0}" -gt 0 ] 2>/dev/null && _diff_args+=(--diff-bytes "$_db")
    [ "${_fc:-0}" -gt 0 ] 2>/dev/null && _diff_args+=(--file-count "$_fc")
  fi
  local json
  json="$(GAFFER_MODEL_REGISTRY="$GAFFER_MODEL_REGISTRY" \
          GAFFER_BUDGET_REMAINING="${GAFFER_BUDGET_REMAINING:-}" \
          GAFFER_BUDGET_LOW_THRESHOLD="${GAFFER_BUDGET_LOW_THRESHOLD:-0}" \
          GAFFER_CHEAP_PHASES="${GAFFER_CHEAP_PHASES:-}" \
          "$node_bin" "$RUNNER_DIR/bin/route-model.mjs" \
            --phase "$phase" --risk "$risk" --ac-count "$ac" \
            --stack "$stack" --attempt "$attempt" \
            ${_diff_args[@]+"${_diff_args[@]}"} --json 2>/dev/null || true)"
  if [ -z "$json" ]; then
    # Router crashed/empty → fall back to the static tier, never break the tick.
    case "$phase" in
      decompose|plan) printf '%s' "${GAFFER_PLAN_MODEL:-}" ;;
      *)              printf '%s' "${GAFFER_IMPL_MODEL:-}" ;;
    esac
    return 0
  fi
  local model tier reasons
  model="$(printf '%s' "$json" | jget "d.get('model','') or ''" 2>/dev/null || true)"
  tier="$(printf '%s' "$json" | jget "d.get('tier','') or ''" 2>/dev/null || true)"
  reasons="$(printf '%s' "$json" | jget "'; '.join(d.get('reasons',[]))" 2>/dev/null || true)"
  log "ROUTE${ticket:+ #$ticket} phase=$phase risk=${risk:-medium} ac=$ac attempt=$attempt budget=${GAFFER_BUDGET_REMAINING:-unlimited} → tier=$tier model=$model [${reasons}]"
  printf '%s' "$model"
  return 0
}

# Optional two-model PLANNING DEBATE (decompose only). When ON *and* the work is
# big enough (the size gate below), bin/decompose.mjs gaffers the epic via a
# BOUNDED adversarial debate between two DIFFERENT models instead of one call:
#   round 1  → proposer (model A) drafts the plan
#   each later round → critic (model B) is given the plan + an ADVERSARIAL prompt
#                      ("find the real weaknesses — do NOT just agree"); proposer
#                      then revises, folding in valid critiques.
#   stop at GAFFER_PLAN_DEBATE_MAX_ROUNDS or when the critic raises nothing material.
# The final plan flows through the SAME validator/output contract as today, and
# EVERY turn is captured in the usage ledger (kind=decompose) under the existing
# per-call caps (GAFFER_TICK_TIMEOUT / GAFFER_MAX_TURNS).
#
# HONEST/COST: a debate is N× the single-agent planning cost. That is why it is
# OFF by default, SIZE-GATED, and ROUND-CAPPED. With every knob unset, decompose
# behaviour is byte-for-byte identical to the single-agent path.
: "${GAFFER_PLAN_DEBATE:=0}"                 # 1/true/yes/on to enable; default OFF
: "${GAFFER_PLAN_DEBATE_MODELS:=opus,sonnet}" # proposer,critic (empty slot → Claude default)
: "${GAFFER_PLAN_DEBATE_MAX_ROUNDS:=2}"      # total plan-producing rounds (draft = round 1)
# SIZE GATE: only debate when the work is big enough to justify N× the spend.
# Signal (documented in bin/decompose.mjs sizeGate): the spend estimate when the
# usage ledger is reachable + has enough measured `decompose` history (median
# predicted INPUT TOKENS for a decompose call); otherwise a cheap fallback proxy
# = brief length (chars) + requested ticket count × 40. Below the gate → single
# agent even when DEBATE=1. Unset/0 → any positive signal passes (gate disabled).
: "${GAFFER_PLAN_DEBATE_MIN_ESTIMATE:=0}"    # min size signal to trigger a debate (0 = off)
export GAFFER_PLAN_DEBATE GAFFER_PLAN_DEBATE_MODELS GAFFER_PLAN_DEBATE_MAX_ROUNDS GAFFER_PLAN_DEBATE_MIN_ESTIMATE

# --- Per-call resource caps (P1 denial-of-wallet / token runaway) ------------
# Every headless `claude -p` call (delivery, bootstrap, agent-review, clarify) —
# and the whole tick.sh from loop.sh — runs under TWO bounds so a single runaway
# call can't burn unbounded wall-clock OR unbounded tokens:
#   GAFFER_TICK_TIMEOUT — wall-clock seconds before the call is killed (SIGTERM).
#   GAFFER_MAX_TURNS    — agent turn cap, passed to `claude --max-turns`. Bounds the
#                        number of model round-trips (the real token-spend driver).
# macOS ships NO GNU `timeout`, so gaffer_timeout is a portable shim built on perl's
# alarm(): `gaffer_timeout <secs> <cmd> [args…]` runs <cmd> and kills it after <secs>.
# If perl is somehow absent it falls back to GNU `timeout`/`gtimeout` when present,
# else runs the command unbounded (best-effort — never breaks the call).
: "${GAFFER_TICK_TIMEOUT:=1800}"   # 30 min hard wall-clock cap per claude -p call
: "${GAFFER_MAX_TURNS:=200}"        # max agent turns per claude -p call
GAFFER_MAX_TURNS_FLAG=""; [ -n "${GAFFER_MAX_TURNS:-}" ] && GAFFER_MAX_TURNS_FLAG="--max-turns $GAFFER_MAX_TURNS"
export GAFFER_TICK_TIMEOUT GAFFER_MAX_TURNS

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
: "${GAFFER_CLAIM_TTL:=$(( ${GAFFER_MAX_DELIVERY_ATTEMPTS:-3} * ${GAFFER_TICK_TIMEOUT:-1800} + 300 ))}"
export GAFFER_MAX_DELIVERY_ATTEMPTS GAFFER_CLAIM_TTL

# ESCALATION: the model the FINAL rework attempt escalates to (stronger reasoning
# for the hardest cases before a human is pulled in). Empty → keep the routed model
# (no escalation). Defaults to the plan tier (opus) so the last attempt reasons as
# hard as the planner does.
: "${GAFFER_REWORK_STRONG_MODEL:=${GAFFER_PLAN_MODEL:-opus}}"
export GAFFER_REWORK_STRONG_MODEL

# DOUBLE-BOUND: a per-ticket rework COST ceiling (USD). The rework loop stops at
# whichever hits FIRST — the attempt cap (above) OR this cumulative per-ticket spend
# — then parks to `blocked` (rework_exhausted). Prevents unbounded token burn on one
# stubborn ticket even when attempts remain. Defaults to the factory-wide
# GAFFER_BUDGET_USD (a single ticket may not consume the whole budget on rework);
# empty/0 → no per-ticket ceiling (attempt cap alone bounds it).
: "${GAFFER_REWORK_BUDGET_USD:=${GAFFER_BUDGET_USD:-}}"
export GAFFER_REWORK_BUDGET_USD

# --- Recoverable-delivery guard (GUARD B) ------------------------------------
# When the agent produced ≥1 commit but a DOWNSTREAM gate (DoD / hygiene /
# minimalism / empty-but-committed) failed, the delivery is RECOVERABLE: the
# branch holds salvageable work, so the failure path PRESERVES the branch
# (tears down only the disposable worktree), attaches the gate output to the
# ticket as a rework note, and RE-INVOKES the delivery agent on the SAME branch
# with that feedback — bounded by this cap. Only after the attempts (OR the
# per-ticket rework budget, GAFFER_REWORK_BUDGET_USD) are exhausted is the ticket
# parked to the VISIBLE `blocked` column WITH the branch + full feedback trail (a
# structured `rework_exhausted` reason) — never silently discarded, never lost to
# the board. Set to 1 to disable retry (one attempt, then park).
: "${GAFFER_MAX_DELIVERY_ATTEMPTS:=3}"   # total delivery attempts per tick (≥1)
export GAFFER_MAX_DELIVERY_ATTEMPTS

# gaffer_ticket_rework_spend <ticket>
# Sum this ticket's measured delivery spend (total_cost_usd) from the usage ledger
# — the DOUBLE-BOUND's cost side. Prints a decimal USD figure (0 when unmeasured or
# no ledger). Unmeasured ("unknown") records contribute 0 (honest: we never invent
# a cost), so the ceiling is only ever tripped by REAL measured spend.
gaffer_ticket_rework_spend() {
  local ticket="$1"
  command -v node >/dev/null 2>&1 || { printf '0'; return 0; }
  local ledger="${GAFFER_USAGE_LEDGER:-${GAFFER_DATA:+$GAFFER_DATA/usage-ledger.jsonl}}"
  [ -n "$ledger" ] && [ -f "$ledger" ] || { printf '0'; return 0; }
  GAFFER_RW_TICKET="$ticket" GAFFER_RW_LEDGER="$ledger" node -e '
    const fs=require("fs");
    const want=String(process.env.GAFFER_RW_TICKET);
    let spend=0;
    try {
      for (const ln of fs.readFileSync(process.env.GAFFER_RW_LEDGER,"utf8").split("\n")) {
        const t=ln.trim(); if(!t) continue;
        let r; try { r=JSON.parse(t); } catch { continue; }
        if (r.kind!=="delivery") continue;
        if (String(r.ticket)!==want) continue;
        const c=r.total_cost_usd;
        if (typeof c==="number" && Number.isFinite(c) && c>=0) spend+=c;
      }
    } catch {}
    process.stdout.write(spend.toFixed(6));
  ' 2>/dev/null || printf '0'
}
export -f gaffer_ticket_rework_spend 2>/dev/null || true

# --- Ask-on-cap guard (GUARD C) ----------------------------------------------
# When a mid-delivery agent call HITS a cap rather than failing a gate — it ran
# to the turn cap (num_turns at/over GAFFER_MAX_TURNS) or Claude reported a
# max-turns stop reason — the work is incomplete-but-not-broken. Instead of
# silently discarding it, the tick PRESERVES the branch, emits a `ticket_parked`
# notify event (ticket#, spend, dashboard URL; redaction honours
# GAFFER_NOTIFY_REDACT), and parks the ticket as needs-human-review. This cap is
# the turn count at/above which a call is treated as cap-hit; it defaults to the
# turn cap itself so a call that consumed every turn is caught.
: "${GAFFER_CAP_DETECT_TURNS:=${GAFFER_MAX_TURNS:-60}}"   # num_turns ≥ this ⇒ cap-hit
export GAFFER_CAP_DETECT_TURNS

# --- Pause-on-cap (PAUSE-ON-CAP) ---------------------------------------------
# On a mid-delivery cap-hit (turn cap) or budget-cap with committed work, PAUSE the
# delivery IN PLACE instead of tearing the worktree down: keep the worktree + branch
# alive, set the ticket `paused`, persist the resume context, notify, and wait for a
# human's one-click Continue (re-enter the SAME worktree) / Stop (tear down + abandon).
# Set to 0 to fall back to the legacy park-to-refining + teardown behaviour.
: "${GAFFER_PAUSE_ON_CAP:=1}"        # 1 = pause+keep worktree (default); 0 = legacy park+teardown
export GAFFER_PAUSE_ON_CAP
# How many resume-requested paused tickets the loop re-enters per tick (≥1). Bounds
# the per-tick resume work so a backlog of Continue presses doesn't starve new claims.
: "${GAFFER_MAX_RESUMES_PER_TICK:=1}"
export GAFFER_MAX_RESUMES_PER_TICK
# Dashboard base URL embedded in the cap-hit / park notify so the operator can
# click straight through to the ticket. Defaults to the local dashboard.
: "${GAFFER_DASHBOARD_URL:=http://127.0.0.1:${DISPATCH_API_PORT:-8787}}"
export GAFFER_DASHBOARD_URL

# Portable wall-clock timeout. Usage: gaffer_timeout <seconds> <command> [args...]
# Exit 124 on timeout (matching GNU timeout's convention) so callers can detect it.
gaffer_timeout() {
  local secs="$1"; shift
  if [ -z "$secs" ] || [ "$secs" -le 0 ] 2>/dev/null; then "$@"; return $?; fi
  if command -v perl >/dev/null 2>&1; then
    # perl alarm() + fork: the child does setpgrp() (its own process group, so a
    # spawned `claude -p` AND all its MCP/child processes share the child's PGID)
    # then exec's the command; the parent arms alarm($t) and waits.
    #
    # ORPHAN-REAP (wallet-drain fix): a timed-out or killed agent must never leave
    # an orphaned `claude -p` burning tokens. On ANY teardown path — SIGALRM
    # (timeout), or the parent itself receiving SIGTERM/SIGINT (the tick's crash
    # trap, or the outer per-tick timeout) — we tear down the WHOLE child process
    # group and ESCALATE TERM -> KILL after a short grace, so a signal-ignoring
    # agent cannot survive. Forwarding on TERM/INT is what stops the child being
    # orphaned when the PARENT is killed (perl's default SIGTERM would just die and
    # leave the child group running). Optionally records the child PGID to
    # $GAFFER_TIMEOUT_PGID_FILE so a belt-and-braces tick-exit trap can reap a
    # survivor; the file is removed on normal completion so it never goes stale.
    perl -e '
      use POSIX ":sys_wait_h";
      my $t = shift;
      my $pid = fork();
      die "fork: $!" unless defined $pid;
      if ($pid == 0) { setpgrp(0,0); exec @ARGV or exit 127; }
      my $pf = $ENV{GAFFER_TIMEOUT_PGID_FILE};
      if ($pf) { if (open(my $fh, ">", $pf)) { print $fh $pid; close $fh; } }
      my $clear = sub { unlink $pf if $pf; };
      my $reap = sub {
        my ($code) = @_;
        kill "TERM", -$pid; kill "TERM", $pid;
        my $gone = 0;
        for (1..20) { if (waitpid($pid, WNOHANG) == $pid) { $gone = 1; last } select(undef,undef,undef,0.1); }
        unless ($gone) { kill "KILL", -$pid; kill "KILL", $pid; }
        $clear->();
        exit $code;
      };
      $SIG{ALRM} = sub { $reap->(124) };
      $SIG{TERM} = sub { $reap->(143) };
      $SIG{INT}  = sub { $reap->(130) };
      alarm $t;
      waitpid($pid, 0);
      my $st = $?;
      $clear->();
      exit($st >> 8 ? $st >> 8 : ($st & 127 ? 128 + ($st & 127) : 0));
    ' "$secs" "$@"
    return $?
  fi
  # GNU/BSD timeout fallbacks: `-s TERM -k <grace>` escalates to SIGKILL after the
  # grace if the command ignores TERM, so a runaway agent is still reaped.
  if command -v timeout >/dev/null 2>&1; then timeout -s TERM -k 10 "$secs" "$@"; return $?; fi
  if command -v gtimeout >/dev/null 2>&1; then gtimeout -s TERM -k 10 "$secs" "$@"; return $?; fi
  # FAIL CLOSED (R-10): no timeout primitive (perl / timeout / gtimeout) is
  # available. Running the command unbounded here is the denial-of-wallet hole —
  # a runaway `claude -p` could burn unbounded wall-clock and tokens. Refuse to
  # run the command, emit a clear setup error, and return 127 so every caller
  # treats it as a fatal setup fault (see gaffer_timeout_preflight, which aborts
  # the run up front rather than relying on each call site to notice).
  echo "gaffer_timeout: FATAL — no timeout primitive (perl, timeout, or gtimeout) found; refusing to run '$1' unbounded. Install perl or coreutils." >&2
  return 127
}

# Preflight (R-10): assert a timeout primitive exists BEFORE any agent call.
# gaffer_timeout fails closed (returns 127) when none is present, but a runaway
# call should never even be attempted — so callers (loop.sh, tick.sh) run this
# once at startup and ABORT the whole run with a setup error if it fails. Returns
# 0 when a primitive is available, 127 (with a stderr message) when not.
gaffer_timeout_preflight() {
  if command -v perl >/dev/null 2>&1 \
    || command -v timeout >/dev/null 2>&1 \
    || command -v gtimeout >/dev/null 2>&1; then
    return 0
  fi
  echo "gaffer: FATAL SETUP ERROR — no wall-clock timeout primitive available (need perl, timeout, or gtimeout). Refusing to start: agent calls cannot be bounded and could run away. Install perl or GNU coreutils." >&2
  return 127
}

# --- Portable file lock (A-1 parallel execution) -----------------------------
# Serialise a critical section across concurrent worker.sh processes. Mirrors the
# gaffer_timeout shim's discipline: prefer the best primitive, fall back portably,
# NEVER skip the lock silently. macOS ships NO `flock`, so the universal fallback
# is an atomic `mkdir` spinlock — `mkdir` is an atomic create-or-fail syscall on
# every POSIX filesystem, so exactly one racer creates the lock dir and the rest
# spin until it's released. A stale lock (a worker killed mid-section) is reaped
# by age so the factory can never wedge on a dead holder's lock.
#
# Usage: gaffer_with_lock <lockfile> <command> [args...]
#   The command runs while the caller holds an EXCLUSIVE lock keyed on <lockfile>.
#   Returns the command's own exit status (so callers see real failures), or 1 if
#   the lock could not be acquired within the bound.
: "${GAFFER_LOCK_TIMEOUT:=30}"     # max seconds to wait for a contended lock
: "${GAFFER_LOCK_STALE:=120}"      # mkdir-lock older than this is treated as stale

# True iff flock(1) is present AND bash supports dynamic fds ({fd}>>, bash >=4.1).
# Both are required for the flock path; otherwise the portable mkdir path is used.
_gaffer_can_flock() {
  command -v flock >/dev/null 2>&1 || return 1
  local maj="${BASH_VERSINFO[0]:-0}" min="${BASH_VERSINFO[1]:-0}"
  [ "$maj" -gt 4 ] 2>/dev/null && return 0
  [ "$maj" -eq 4 ] 2>/dev/null && [ "$min" -ge 1 ] 2>/dev/null && return 0
  return 1
}
gaffer_with_lock() {
  local lockfile="$1"; shift
  [ -n "$lockfile" ] || { "$@"; return $?; }
  # Prefer flock(1) ONLY when both flock and bash's dynamic-fd syntax ({fd}>>) are
  # available — i.e. flock present AND bash >= 4.1. macOS ships bash 3.2 with no
  # flock, so it always takes the portable mkdir path below; a Linux/CI box has
  # flock + bash 4+. This guard keeps the {fd}>> form from ever being parsed on an
  # interpreter that can't handle it.
  if _gaffer_can_flock; then
    # flock(1) (Linux/CI): hold an exclusive lock on a dedicated fd, run the
    # command, release on close. -w bounds the wait so a wedged holder can't hang
    # the worker forever. Exit 1 specifically signals "couldn't acquire".
    # Hold the lock on fd 9 inside a SUBSHELL so the lock descriptor NEVER exists in
    # the parent shell. The earlier form opened a dynamic `{fd}>>` in the parent and
    # ran the command there — but lock-wrapped log()/skip/ledger calls fire inside the
    # tick's own `while read`/process-substitution loops, and a parent-held descriptor
    # collided with / leaked into those loops, silently breaking candidate selection on
    # the flock (Linux) path. The subshell scopes fd 9 to itself and auto-closes it on
    # exit (releasing the lock); every lock-wrapped call is an external file write, so
    # running it in a subshell is behaviour-preserving. `exit 75` is flock's
    # couldn't-acquire signal (EX_TEMPFAIL; the wrapped writers never return it).
    ( flock -w "$GAFFER_LOCK_TIMEOUT" 9 || exit 75; "$@" ) 9>>"$lockfile"
    local rc=$?
    if [ "$rc" = 75 ]; then
      echo "gaffer_with_lock: could not acquire $lockfile within ${GAFFER_LOCK_TIMEOUT}s" >&2
      return 1
    fi
    return "$rc"
  fi
  # Portable fallback: atomic mkdir spinlock (the macOS path — no flock there).
  # GUARD: a locked section must finish well WITHIN GAFFER_LOCK_STALE — the
  # liveness check below means a *live* holder is never reaped, but a section that
  # outlives both the holder's death AND the staleness window would still be a bug.
  local lockdir="${lockfile}.d"
  local waited=0
  while ! mkdir "$lockdir" 2>/dev/null; do
    # Reap an ABANDONED lock — but only when its holder is provably gone. Staleness
    # alone (mtime, set once at mkdir and never refreshed) wrongly reaps a live but
    # slow holder, breaking mutual exclusion. Liveness, by holder PID, is
    # authoritative:
    #   • readable PID, still alive (kill -0 ok) → NOT stale, however long held: wait.
    #   • readable PID, dead                     → reap immediately (holder gone).
    #   • no readable PID                        → fall back to the mtime-stale check
    #     (a holder killed before it wrote its pid, or a lost pid file).
    local pid
    pid="$(cat "$lockdir/pid" 2>/dev/null)"
    if [ -n "$pid" ]; then
      if kill -0 "$pid" 2>/dev/null; then
        :   # holder is alive — never reap, just wait
      else
        rm -rf "$lockdir" 2>/dev/null || true   # holder PID is dead — abandoned
        continue
      fi
    else
      local age
      age="$(_gaffer_lock_age "$lockdir")"
      if [ "${age:-0}" -ge "$GAFFER_LOCK_STALE" ] 2>/dev/null; then
        rm -rf "$lockdir" 2>/dev/null || true
        continue
      fi
    fi
    sleep 0.1
    waited=$((waited + 1))
    if [ "$waited" -ge "$((GAFFER_LOCK_TIMEOUT * 10))" ]; then
      echo "gaffer_with_lock: could not acquire $lockdir within ${GAFFER_LOCK_TIMEOUT}s" >&2
      return 1
    fi
  done
  # Record the holder PID so waiters can tell a live-but-slow holder from a dead one.
  echo $$ > "$lockdir/pid" 2>/dev/null || true
  # Hold the lock for the duration of the command; always release, even on failure.
  "$@"; local rc=$?
  rmdir "$lockdir" 2>/dev/null || rm -rf "$lockdir" 2>/dev/null || true
  return $rc
}

# Seconds since a lock dir was created (its mtime). Portable across GNU/BSD stat.
# Used only as the FALLBACK staleness signal when a lock has no live holder PID
# (the live-holder check is authoritative; mtime is the last resort for an
# abandoned lock left by a killed holder that never wrote — or had its pid file
# lost).
_gaffer_lock_age() {
  local d="$1" mtime now
  mtime="$(stat -f %m "$d" 2>/dev/null || stat -c %Y "$d" 2>/dev/null || echo "")"
  [ -n "$mtime" ] || { echo 0; return 0; }
  now="$(date +%s)"
  echo $((now - mtime))
}

# --- Agent child-env scrub (C1/M2/M3) ----------------------------------------
# The live `claude -p` launches (delivery, bootstrap, agent-review, clarify) run
# in a subshell that, by default, INHERITS the full parent environment. That env
# carries ambient credentials the runner needs but the AGENT does not —
# GITHUB_TOKEN, AWS_* keys, DISPATCH_API_TOKEN, anything matching
# *_TOKEN / *_SECRET / *_KEY / *_PASSWORD, AND the runner's own outbound-endpoint
# vars (GAFFER_NOTIFY_*, *_WEBHOOK*, *_SLACK*, *_URL). A prompt-injected agent
# that can read its own environment could exfiltrate credentials OR post to a
# notify webhook it found in GAFFER_NOTIFY_WEBHOOK_URL.
# The agentChildEnv() function in bin/product-owner-run.mjs now also drops these
# outbound-endpoint classes (keeping ANTHROPIC_BASE_URL as the sole *_URL
# exception, for API routing), RESTORING true parity between the two code paths.
# This function is an ALLOWLIST rather than a denylist: we start from nothing
# (`env -i`) and hand the agent ONLY what `claude -p`, its MCP tools, and the
# per-call boundary vars need. Nothing else can leak by accident, including
# credentials we haven't thought of yet.
#
# Usage:
#   gaffer_agent_env                       # populates the GAFFER_AGENT_ENV array
#   ( cd "$dir" && env -i "${GAFFER_AGENT_ENV[@]}" VAR=val … \
#       gaffer_timeout … "$CLAUDE_BIN" -p … )
#
# What we KEEP (and why):
#   - PATH, HOME, SHELL, USER, LOGNAME, TMPDIR — a working shell so `claude`
#     resolves its binary, reads ~/.claude credentials, and child tools run.
#     (PWD is intentionally NOT carried: the caller cd's first and env -i runs in
#     that cwd; passing the parent's PWD would hand the agent a stale directory.)
#   - LANG / LC_* / TERM / TZ — locale + terminal sanity.
#   - ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL,
#     ANTHROPIC_MODEL, CLAUDE_CODE_* and other CLAUDE_*  — claude -p AUTH and
#     config. NOTE: ANTHROPIC_API_KEY is deliberately the ONE *_KEY we keep; the
#     allowlist below names it explicitly so the generic *_KEY strip can't take it.
#   - AWS_REGION / AWS_DEFAULT_REGION — needed for Bedrock-backed claude; these
#     are NON-secret (the AWS_*_KEY / AWS_SESSION_TOKEN credentials are NOT kept).
#   - MCP_CONFIG, DISPATCH_DB, MEMORY_DB, DISPATCH_MCP_BIN, MEMORY_MCP_BIN — the
#     agent's MCP servers + their DB paths (its only data-plane reach).
#   - GAFFER_* knobs the agent or its hooks read (models, caps, write/read roots,
#     skill/quarantine wiring). EXCEPTION: GAFFER_NOTIFY_* vars (notification
#     webhooks / Slack endpoints) are blocked by the deny case above even though
#     they match this prefix — the agent must not read its own exfiltration channel.
#     The per-call boundary vars are layered on top by the caller AFTER this array,
#     so they always win.
#   - npm_config_* — the scoped/locked bootstrap install knobs.
# Everything NOT named here is dropped — in particular GITHUB_TOKEN, AWS access
# keys/secrets/session tokens, DISPATCH_API_TOKEN, any *_TOKEN / *_SECRET /
# *_KEY (besides ANTHROPIC_API_KEY) / *_PASSWORD, and the outbound-endpoint class
# (GAFFER_NOTIFY_*, *_WEBHOOK*, *_SLACK*, *_URL — except ANTHROPIC_BASE_URL).
GAFFER_AGENT_ENV=()
gaffer_agent_env() {
  GAFFER_AGENT_ENV=()
  # Exact var names the agent legitimately needs. ANTHROPIC_API_KEY is listed
  # explicitly so it survives despite ending in _KEY.
  local keep_exact=(
    PATH HOME SHELL USER LOGNAME TMPDIR TMP TEMP
    LANG LC_ALL LC_CTYPE LC_MESSAGES LC_NUMERIC TERM TZ COLUMNS LINES
    ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL ANTHROPIC_MODEL
    AWS_REGION AWS_DEFAULT_REGION
    MCP_CONFIG DISPATCH_DB MEMORY_DB DISPATCH_MCP_BIN MEMORY_MCP_BIN
    GAFFER_WRITE_ROOTS GAFFER_READ_ROOTS
  )
  # Prefixes whose whole namespace the agent (or its hooks/tools) may read.
  # CLAUDE_*  → claude -p config/auth (CLAUDE_BIN, CLAUDE_CODE_*, CLAUDE_FLAGS…).
  # GAFFER_*  → factory knobs (models, caps, skill/quarantine wiring, boundary).
  # npm_config_* → the scoped, lifecycle-disabled bootstrap install knobs.
  local keep_prefix=( CLAUDE_ GAFFER_ npm_config_ )
  local name val
  # compgen -e enumerates EXPORTED (i.e. environment) variable names, one per
  # line. Names can never contain a newline or '=', so line-reading is safe; the
  # VALUE is read separately via indirect expansion and preserved verbatim.
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    # Drop the credential-shaped AND outbound-endpoint vars even if a keep-prefix
    # would re-admit them. A prompt-injected agent must not be able to read the
    # runner's own exfiltration channels (notify webhooks, Slack URL, dashboard URL).
    case "$name" in
      # Explicitly kept despite matching deny patterns below — claude -p auth:
      ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL) : ;;
      # Credential-shaped vars — never reach the agent:
      *_TOKEN|*_SECRET|*_KEY|*_PASSWORD|*_PASSWD|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|GITHUB_TOKEN|GH_TOKEN|DISPATCH_API_TOKEN)
        continue ;;
      # Outbound endpoint / notify config — runner-only; the agent must not read
      # its own potential exfiltration channel:
      GAFFER_NOTIFY_*|*_WEBHOOK*|*_SLACK*|*_URL)
        continue ;;
    esac
    local matched=0
    local k
    for k in "${keep_exact[@]}"; do [ "$name" = "$k" ] && { matched=1; break; }; done
    if [ "$matched" -eq 0 ]; then
      local p
      for p in "${keep_prefix[@]}"; do case "$name" in "$p"*) matched=1; break;; esac; done
    fi
    [ "$matched" -eq 1 ] || continue
    # Read the value via indirect expansion; preserve it verbatim.
    val="${!name}"
    GAFFER_AGENT_ENV+=( "$name=$val" )
  done < <(compgen -e)
}

# NOTE on the DISPATCH_*_CMD defaults below: these are plain command STRINGS that
# Dispatch's parseCommand whitespace-splits. The space-safe form is a JSON argv
# array (e.g. ["node","/abs path/x.mjs"]) which parseCommand also accepts — and
# `runner/gaffer dashboard` builds exactly that from $RUNNER_DIR when it exports
# these into the dashboard's env, so the supported launch path is space-safe. The
# string defaults here assume a $RUNNER_DIR with no spaces; if you launch the
# Dispatch API directly from a checkout path containing spaces, set these to JSON
# argv arrays yourself.

# The dashboard's "Suggest work" button (POST /product-owner/runs) spawns this
# command (detached, with DISPATCH_PRODUCT_OWNER_REPO in its env naming the repo to
# suggest work for). It runs the product-owner skill headlessly and files draft
# tickets into the backlog. `gaffer dashboard` exports this into the dashboard's env;
# set it here for a fresh setup. Absolute path so the detached child resolves it.
: "${DISPATCH_PRODUCT_OWNER_CMD:=node $RUNNER_DIR/bin/product-owner-run.mjs}"

# The dashboard Memory view's "Onboard a repo" button (POST /repos/onboard) spawns
# this command (detached, with DISPATCH_ONBOARD_REPO in its env naming the repo —
# a registered name/id OR a local path — to onboard). The wrapper resolves the
# target to an on-disk path and runs crew's real `repo onboard <path>
# --standalone`, so the repo is scanned, registered in Dispatch, and its digest +
# feature inventory land in the memory store the Memory views read. `gaffer
# dashboard` exports this into the dashboard's env; set it here for a fresh setup.
# Absolute path so the detached child resolves it.
: "${DISPATCH_ONBOARD_CMD:=node $RUNNER_DIR/bin/onboard-run.mjs}"

# BBT-001: the independent black-box tester runner. When GAFFER_TESTING is on and a
# ticket is approved+testable, the dispatch state machine routes it in_review ->
# in_testing; this command is the seam that assembles a CONTRACT-ONLY context (AC +
# test_contract — never the diff) and would spawn the tester agent, recording the
# pass/fail verdict back through dispatch. Mirrors DISPATCH_MERGE_CMD /
# DISPATCH_ONBOARD_CMD: a fixed operator command, no shell, absolute path so the
# detached child resolves it. The live `claude -p` tester is the documented
# follow-up; the seam + context assembly + verdict→transition wiring are real today.
: "${DISPATCH_TESTER_CMD:=node $RUNNER_DIR/bin/tester-run.mjs}"

# Factory identity + bookkeeping
: "${GAFFER_AGENT_NAME:=gaffer-factory}"
: "${GAFFER_AGENT_ID_FILE:=$GAFFER_DATA/agent_id}"
: "${GAFFER_LOG:=$GAFFER_DATA/factory.log}"

# --- Self-operation ban (refuse to deliver to Gaffer's own source) ------------
# When Gaffer is open-sourced and someone points the factory at a Gaffer component
# (dispatch / crew / memory / the runner itself), the factory ends up
# editing its OWN source — a footgun and a weird self-modifying recursion. So by
# default the runner REFUSES any delivery (or greenfield bootstrap) whose target
# IS, or is INSIDE, one of the factory's own component dirs (DISPATCH_DIR,
# CREW_DIR, MEMORY_DIR, RUNNER_DIR — all defined above, so this works in
# BOTH the mono layout and the side-by-side layout). First-party dogfooding
# overrides it: set GAFFER_ALLOW_SELF_DELIVERY=1 to restore today's behaviour
# exactly. NOTE: not bulletproof — the check is in-tree and removable — but it
# stops the casual case, which is the accepted bar.
: "${GAFFER_ALLOW_SELF_DELIVERY:=0}"

# gaffer_is_self_target <path>
# Returns success (0) when <path> IS, or is INSIDE, any of the factory's own
# component dirs (DISPATCH_DIR / CREW_DIR / MEMORY_DIR / RUNNER_DIR).
# Both sides are CANONICALISED (symlinks resolved via `cd … && pwd -P`, trailing
# slashes normalised) before an equal-or-subdir match (`case "$canon/" in
# "$comp/"*)`). Empty/missing component vars are skipped. A non-existent or
# non-resolvable <path> can't match (returns 1) — the guard is additive and must
# never misfire on a normal repo.
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
  done
  return 1
}

# --- Safety / stop conditions ------------------------------------------------
# DRY_RUN=1 prints what it WOULD do and never invokes Claude or mutates a repo.
# Flip to 0 only when you've reviewed everything and want it live.
: "${DRY_RUN:=1}"
: "${MAX_TICKS:=5}"           # hard cap on ticks per loop run (cost guard)
: "${EMPTY_POLL_LIMIT:=2}"    # stop after this many consecutive no-work polls
: "${TICK_SLEEP:=30}"         # seconds between ticks
# Per-CALENDAR-DAY tick cap across loop.sh runs (overnight cost guard): MAX_TICKS
# bounds one run, but launchd re-runs loop.sh, so this bounds the whole day's
# spend. The count persists in DAILY_COUNTER_FILE and resets each day. 0 = off.
: "${MAX_TICKS_PER_DAY:=50}"
: "${DAILY_COUNTER_FILE:=$GAFFER_DATA/.daily-ticks}"

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

# --- Honest USAGE LEDGER (per agent invocation) ------------------------------
# Every headless `claude -p` call is switched to `--output-format json` and its
# real usage (tokens verbatim, dollars RELAYED from Claude Code's own
# total_cost_usd / modelUsage[*].costUSD — never computed from a price table) is
# appended as one JSONL record to the usage ledger. Mirrors the safety-block
# ledger: best-effort, gated on GAFFER_DATA, fully swallowed — a ledger failure
# NEVER fails or alters a tick. A call that can't be measured (timeout / crash /
# missing/unparseable JSON / no usage field) is recorded as "unknown", never 0,
# so a partial run can't read as "cheap". run-summary.sh renders the run-scoped
# Usage section. Override the ledger PATH here (mirrors GAFFER_BLOCK_LEDGER's
# run-summary default); empty/unset → $GAFFER_DATA/usage-ledger.jsonl.
: "${GAFFER_USAGE_LEDGER:=$GAFFER_DATA/usage-ledger.jsonl}"
export GAFFER_USAGE_LEDGER

# gaffer_usage_record <kind> <ticket-or-empty> <rc> <captured-json-file>
# Hands the captured `--output-format json` stdout to the usage-ledger CLI, which
# PRINTS the agent's `.result` text to stdout (so the caller keeps a
# human-readable log) and appends one ledger record. Fully swallowed: a missing
# module / node error must never affect the tick (we still emit nothing and
# return 0). Stdout of this function is the agent's text only.
#
# A-1 (parallel execution): the ledger is a SHARED append-only JSONL file. Under
# GAFFER_CONCURRENCY>1 several workers record usage concurrently; a record can
# exceed the OS atomic-append size (PIPE_BUF), so two appends could interleave and
# corrupt a line. We serialise the whole record call under .ledger.lock when
# gaffer_with_lock is defined (always, via this file). gaffer_with_lock runs the
# command in-process with inherited stdout, so the agent's `.result` passthrough is
# preserved. At concurrency 1 the lock is uncontended → behaviour is unchanged.
gaffer_usage_record() {
  local kind="$1" ticket="${2:-}" rc="${3:-0}" jsonfile="$4"
  local mod="$RUNNER_DIR/lib/usage-ledger.mjs"
  [ -f "$mod" ] || return 0
  # R-4: an append failure used to be doubly hidden — node stderr went to /dev/null
  # here AND the tick.sh call sites discard stderr too. The ledger module now emits a
  # WARNING line on a real append failure (a measurement gap), so route the module's
  # stderr to the factory log ($GAFFER_LOG) instead of dropping it. The append itself
  # stays best-effort (the trailing `|| true` keeps a ledger problem from failing the
  # tick), but the WARNING is now VISIBLE in the log.
  if declare -F gaffer_with_lock >/dev/null 2>&1; then
    gaffer_with_lock "$GAFFER_DATA/.ledger.lock" \
      node "$mod" --kind "$kind" ${ticket:+--ticket "$ticket"} --rc "$rc" --json-file "$jsonfile" 2>>"$GAFFER_LOG" || true
  else
    node "$mod" --kind "$kind" ${ticket:+--ticket "$ticket"} --rc "$rc" --json-file "$jsonfile" 2>>"$GAFFER_LOG" || true
  fi
}

# Who reviews in_review tickets before they can be approved to done:
#   human → only a person approves (dispatch review approve, or the board)
#   agent → a reviewer AGENT (≠ the implementer) reviews via the review-ticket skill
#   both  → an agent screens first, then a human confirms
: "${REVIEW_MODE:=human}"

# Auto-merge an approved (done) ticket's branch into the repo's default branch.
# 0 = off (DEFAULT — humans run the merge themselves), 1 = on (opt in per-run).
# Auto-merge ONLY fires after a ticket reaches an APPROVED done-state via a HUMAN
# (or server-side) approval. Agent reviews never trigger a merge — they are advisory
# and the ticket stays in_review — unless MERGE_ON_AGENT_REVIEW=1 (see below; not a
# safe unattended posture).
# Conflict-safe: a clean merge lands on approval; a CONFLICT does NOT force-merge —
# it spawns a resolver agent + re-queues the ticket for re-approval (with the
# resolved diff). Never pushes.
: "${AUTO_MERGE:=0}"

# A MERGE REQUIRES A HUMAN APPROVAL. Even with AUTO_MERGE=1, an AGENT review
# (REVIEW_MODE=agent/both) is ADVISORY ONLY — the reviewer records a verdict via
# the scoped MCP and the ticket STAYS in_review; it does NOT mint an approval and
# does NOT auto-merge. Only a HUMAN approval (the dashboard Approve action →
# merge-ticket, or a human `dispatch review approve`) crosses the final gate.
#
# MERGE_ON_AGENT_REVIEW=1 is NOT A SAFE UNATTENDED POSTURE. It removes the human
# merge gate entirely: an agent-driven 'done' may merge to the default branch with
# NO human in the loop, so a single prompt-injected or mistaken review can land
# code unreviewed. Do NOT set it for any factory you would leave running
# overnight. Keep it 0 (the default) unless you are actively supervising a
# fully-autonomous experiment and accept that risk. The tick logs a WARNING on
# every merge it performs under this flag.
: "${MERGE_ON_AGENT_REVIEW:=0}"

# --- Strict execution mode (OPTIONAL OS-level containment) -------------------
# Best-effort OS-level containment layered ON TOP OF the worktree isolation +
# the deterministic safety hook. NOT a security guarantee — see STRICT_MODE.md.
# Default OFF: behaviour is byte-for-byte as before unless explicitly enabled.
: "${STRICT_MODE:=0}"          # 1 = wrap the live `claude -p` in the OS sandbox provider
# Which provider supplies the OS-level containment. This is a PROVIDER SEAM, not
# a hard dependency on any one tool: `sandbox-exec` is the one a spike proved on
# macOS today; `docker`/`lima`/VM are future providers (currently fall back to
# no extra containment). `none` disables OS wrapping while keeping STRICT_MODE
# semantics togglable. A new provider = a new case in lib/sandbox.sh.
: "${SANDBOX_PROVIDER:=sandbox-exec}"
# Allow outbound network from inside the sandbox. IMPORTANT HONEST NOTE: because
# strict mode wraps the WHOLE `claude -p` process, network CANNOT be denied
# without breaking Claude's own API calls — so this defaults to 1 (allow). True
# per-subprocess network isolation (deny the agent's children network while
# Claude itself reaches the API) is a FUTURE-PROVIDER capability (docker/lima/VM),
# not something `sandbox-exec` wrapping the whole process can deliver.
: "${STRICT_ALLOW_NETWORK:=1}"
# Space-separated HOME paths the sandbox may WRITE to even though they live
# outside the worktree. Claude Code keeps state/cache here; denying them would
# break legitimate runtime writes. Add per-host paths as needed.
: "${STRICT_ALLOW_HOME:=$HOME/.claude $HOME/.cache}"

# --- Stabilisation / hardening (post unattended-run leak findings) -----------
# These guards harden the delivery lifecycle against the real leaks an overnight
# factory run produced (a copied src tree in a repo root, a leaked
# .crew/events.jsonl, self-referential node_modules / .claude/skills
# symlinks committed onto a delivery branch, node_modules deleted during salvage).
# Each is configurable; the defaults below are the ones the run-summary report,
# tick lifecycle, and tests use.

# (1) Worktree HYGIENE assertion (HARD FAIL). After delivery, BEFORE submitting
# for review, the branch diff is asserted hygienic; a violation PARKS the ticket
# (review reject --to refining) and fails the tick — it is never submitted. The
# real main checkout is also asserted clean after worktree teardown. 1 = enforce
# (default), 0 = log-only (skip the hard fail — for debugging, not production).
: "${HYGIENE_ENFORCE:=1}"
# Newline/space-separated glob fragments that, if ADDED or DELETED by the diff,
# fail the hygiene check. Defaults cover every leak class seen in the wild:
#   node_modules        — a copied/symlinked or deleted node_modules path
#   .crew/              — a leaked crew events/state dir
#   *.events.jsonl      — any leaked events log
#   .claude/            — project-local Claude config injected per worktree (never deliver)
#   CLAUDE.factory.md   — the factory's own agent brief (never deliver)
#   .mcp.json / mcp-runtime.json — runtime MCP wiring (never deliver)
# MUST match the library fallback in lib/hygiene.sh — keep the two in sync.
: "${HYGIENE_FORBIDDEN_PATHS:=node_modules .crew/ *.events.jsonl .claude/ CLAUDE.factory.md .mcp.json mcp-runtime.json}"

# (2) MINIMALISM hard post-condition. Every completed delivery MUST record a
# smallest-change note (+ files/lines counts computed from the diff, why-each-file,
# tests-run, evidence). A MISSING smallest-change note FAILS the post-condition
# (park/flag — must not glide through). An oversized diff does NOT fail but flags
# the ticket `needs_human_review: oversized_diff` visibly.
: "${MINIMALISM_ENFORCE:=1}"          # 1 = a missing smallest-change note fails the post-condition
: "${OVERSIZED_MAX_LINES:=400}"       # > this many changed lines → flag (not fail) oversized_diff
: "${OVERSIZED_MAX_FILES:=12}"        # > this many changed files → flag (not fail) oversized_diff

# (4) GREENFIELD bootstrap ("create-a-repo") mode. A dispatch `bootstrap` ticket
# has no repo to branch — the runner CREATES one at <root>/<name>, git-inits it,
# runs the delivery agent there to scaffold the stack + initial commit, then
# registers + onboards it into the factory (so the now-done bootstrap unblocks the
# dependent feature tickets, which then target the new repo via the normal flow).
# A non-empty existing target dir is REFUSED (we never clobber existing work). A
# fresh scaffold may legitimately be larger than a normal change, so the oversized
# minimalism HARD-fail is exempted for bootstrap tickets (the note is still
# recorded; an oversized scaffold is flagged needs_human_review, not failed).
: "${GAFFER_BOOTSTRAP_ROOT:=$HOME/git}"   # parent dir new bootstrap repos are created under
# During a bootstrap delivery the runner additionally exports, FOR THAT TICK ONLY,
# GAFFER_BOOTSTRAP_INSTALL=1 and GAFFER_BOOTSTRAP_DIR=<new repo dir> so the safety
# hook permits exactly the first dependency install INSIDE that fresh dir
# (bootstrap-only relaxation — every other ticket keeps installs hard-blocked).
# These are set per-tick by the runner, never globally; documented here only.

# (3) Per-repo BACKPRESSURE. Before claiming/delivering for a repo, its outstanding
# work is counted (unmerged gaffer/* branches + in_review tickets + active claims).
# At/over ANY cap the repo is in BACKPRESSURE: new claims for it are skipped and
# review/merge/cleanup/blocked work is prioritised, so the loop never piles up more
# than the cap per repo. 0 = that dimension is unlimited.
: "${MAX_OPEN_AGENT_BRANCHES_PER_REPO:=3}"   # unmerged gaffer/* branches in the real repo
: "${MAX_OPEN_AGENT_PRS_PER_REPO:=3}"        # in_review tickets targeting the repo
# The third backpressure dimension — active (claimed/in_progress) tickets per repo
# — is MAX_CONCURRENT_TICKETS_PER_REPO, defined once above (default 1). It is NOT
# re-defaulted here: a second `:=` would be dead (the value is already set) and any
# different number in it would be a silently-ignored lie.

# CLI helpers (use the built dist bins)
# memory-mcp uses its own bin layout + the MEMORY_DB env var (no --db flag).
: "${MEMORY_CLI_BIN:=$MEMORY_DIR/dist/bin/memory.js}"
: "${MEMORY_MCP_BIN:=$MEMORY_DIR/dist/bin/memory-mcp.js}"
: "${DISPATCH_MCP_BIN:=$DISPATCH_DIR/dist/mcp/bin.js}"   # substituted into .mcp.json by tick.sh

# --- DB-var fail-CLOSED guard (P1-B) -----------------------------------------
# The .mcp.json ships "${DISPATCH_DB}" / "${MEMORY_DB}" placeholders that
# tick.sh sed-substitutes, and the lg/wg wrappers + the memory server launch
# pass these through to the MCP servers. If either var is EMPTY/unset, the sed
# substitution writes a literal value and a stray DB file named e.g.
# `${MEMORY_DB}` gets created in cwd — and the MCP servers silently point at
# the wrong (empty-named) database. Fail CLOSED instead: assert both are
# non-empty before any consumption, with a clear, actionable error.
#
# Call this immediately before a sed-substitution of the MCP config OR before
# launching anything (lg/wg/memory server) that relies on these vars.
gaffer_assert_db_vars() {
  local missing=()
  [ -n "${DISPATCH_DB:-}" ] || missing+=("DISPATCH_DB")
  [ -n "${MEMORY_DB:-}" ]  || missing+=("MEMORY_DB")
  if [ "${#missing[@]}" -gt 0 ]; then
    printf 'gaffer: refusing to run — required DB var(s) empty/unset: %s\n' "${missing[*]}" >&2
    printf 'gaffer: set them (factory.config.sh defaults to $GAFFER_DATA/*.sqlite) so the MCP\n' >&2
    printf 'gaffer: servers point at a real database and no literal-named ${...} DB file is\n' >&2
    printf 'gaffer: created in the working directory.\n' >&2
    return 1
  fi
  return 0
}

wg() { gaffer_assert_db_vars || return 1; node "$DISPATCH_DIR/dist/cli/index.js" --db "$DISPATCH_DB" "$@"; }
fg() { node "$CREW_DIR/dist/cli/index.js" -c "$CREW_CONFIG" "$@"; }
lg() { gaffer_assert_db_vars || return 1; MEMORY_DB="$MEMORY_DB" node "$MEMORY_CLI_BIN" "$@"; }

# Tiny JSON field reader (python3): jget '<expr starting with d>' <<< "$json"
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }

# Strict-execution-mode provider seam (defines sandbox_wrap_cmd). Sourced last so
# it can read the GAFFER_DATA / STRICT_* config above. Best-effort: a missing file
# must not break the suite, but it ships in-tree so this is just defensive.
# shellcheck source=lib/sandbox.sh
[ -f "$RUNNER_DIR/lib/sandbox.sh" ] && source "$RUNNER_DIR/lib/sandbox.sh"

# Per-day cost guard helpers (gaffer_day_count / gaffer_bump_day_count /
# gaffer_day_cap_ok). Sourced after the config above so they read MAX_TICKS_PER_DAY
# and DAILY_COUNTER_FILE.
# shellcheck source=lib/budget.sh
[ -f "$RUNNER_DIR/lib/budget.sh" ] && source "$RUNNER_DIR/lib/budget.sh"

# Auto-merge helper (defines gaffer_auto_merge). In-tree, so this is defensive.
# shellcheck source=lib/automerge.sh
[ -f "$RUNNER_DIR/lib/automerge.sh" ] && source "$RUNNER_DIR/lib/automerge.sh"

# Prompt quarantine (defines gaffer_quarantine + QUARANTINE_NOTICE) — wraps
# untrusted ticket-derived fields in a delimited envelope before they reach the
# agent prompt (P1 prompt-injection). In-tree, so this is defensive.
# shellcheck source=lib/quarantine.sh
[ -f "$RUNNER_DIR/lib/quarantine.sh" ] && source "$RUNNER_DIR/lib/quarantine.sh"

# Delivery-hygiene assertions (defines gaffer_assert_clean_delivery /
# gaffer_assert_repo_clean). HARD-FAIL guard against the unattended-run leaks.
# shellcheck source=lib/hygiene.sh
[ -f "$RUNNER_DIR/lib/hygiene.sh" ] && source "$RUNNER_DIR/lib/hygiene.sh"

# Minimalism post-condition (defines gaffer_diff_stats / gaffer_check_minimalism).
# shellcheck source=lib/minimalism.sh
[ -f "$RUNNER_DIR/lib/minimalism.sh" ] && source "$RUNNER_DIR/lib/minimalism.sh"

# Shared file-card context primer (defines gaffer_prime_context_block).
# Sourced after the config above so it can use lg / MEMORY_CLI_BIN / MEMORY_DB.
# shellcheck source=lib/context-primer.sh
[ -f "$RUNNER_DIR/lib/context-primer.sh" ] && source "$RUNNER_DIR/lib/context-primer.sh"

# Definition-of-Done gate (I3): defines gaffer_run_dod_gates / gaffer_dod_enabled /
# gaffer_dod_run_one / gaffer_dod_summary_line / gaffer_dod_evidence_summary. The
# enforced, runner-run gate (tests/typecheck/lint) every delivery clears BEFORE the
# human review lane. In-tree, so this is defensive.
# GAFFER_ALLOW_NO_DOD=1 — waiver for repos with genuinely no runnable gates: a
# delivery that passes with ZERO gates executed is otherwise a hard fail (the work
# was never verified). Set only when test_command and lint_command are deliberately
# absent; without it the delivery is parked for the operator to investigate.
# shellcheck source=lib/dod.sh
[ -f "$RUNNER_DIR/lib/dod.sh" ] && source "$RUNNER_DIR/lib/dod.sh"

# Recoverable-delivery + ask-on-cap primitives (GUARD B / GUARD C): defines
# gaffer_branch_has_commits / gaffer_any_branch_has_commits (recoverable-vs-
# unrecoverable discriminator), gaffer_is_cap_hit / gaffer_cap_num_turns /
# gaffer_delivery_spend (cap detection + spend for the ask-on-cap notify).
# shellcheck source=lib/delivery-recovery.sh
[ -f "$RUNNER_DIR/lib/delivery-recovery.sh" ] && source "$RUNNER_DIR/lib/delivery-recovery.sh"

# Per-repo backpressure (defines gaffer_repo_pressure / gaffer_repo_in_backpressure).
# shellcheck source=lib/backpressure.sh
[ -f "$RUNNER_DIR/lib/backpressure.sh" ] && source "$RUNNER_DIR/lib/backpressure.sh"

# Orphaned-worktree recovery (defines gaffer_cleanup_orphaned_worktrees) — sweeps
# stale per-ticket worktrees left by killed workers (A-1 parallel execution).
# shellcheck source=lib/orphan-recovery.sh
[ -f "$RUNNER_DIR/lib/orphan-recovery.sh" ] && source "$RUNNER_DIR/lib/orphan-recovery.sh"

# Dashboard process tracking (defines gaffer_dashboard_pid / _pidfile / _write_pid):
# precise running-detection via a recorded+validated PID instead of a broad pgrep.
# shellcheck source=lib/dashboard.sh
[ -f "$RUNNER_DIR/lib/dashboard.sh" ] && source "$RUNNER_DIR/lib/dashboard.sh"

# Greenfield bootstrap helpers (defines gaffer_bootstrap_repo_name / _repo_dir /
# _target_ok / _init / _onboard) — the create-a-repo delivery mode for bootstrap
# tickets. In-tree, so this is defensive.
# shellcheck source=lib/greenfield.sh
[ -f "$RUNNER_DIR/lib/greenfield.sh" ] && source "$RUNNER_DIR/lib/greenfield.sh"

# Clarify gate: when idle (nothing ready), run a headless clarify pass over an
# un-specified DRAFT. OFF by default — clarifying spends tokens every idle tick.
# Set to 1 for a factory you want actively refining its own backlog while idle.
: "${CLARIFY_DRAFTS_WHEN_IDLE:=0}"
: "${IDLE_DRAFT_WHEN_IDLE:=0}"

# --- H4: real PR creation (opt-in) -------------------------------------------
# When GAFFER_CREATE_PR=1 AND the primary write repo has a GitHub remote, the
# runner runs `gh pr create` after a successful delivery and records the resulting
# URL back as pr_url on the ticket. Off by default — opt in per-run or globally.
# The `gh` binary is injectable via GAFFER_GH_BIN (default: `gh`) so tests can
# stub it without a real remote.
: "${GAFFER_CREATE_PR:=0}"   # 1/true/yes/on to enable real PR creation; default OFF
: "${GAFFER_GH_BIN:=gh}"     # injectable gh binary (for tests)
export GAFFER_CREATE_PR GAFFER_GH_BIN

# --- H3: CI-aware review gate (opt-in) ----------------------------------------
# When GAFFER_REQUIRE_CI=1, after the delivery branch/PR exists the runner polls
# `gh pr checks <branch>` until checks are green, then lets the ticket enter the
# human review lane. If CI goes red, the ticket is auto-rejected back to rework
# with the failing check (name + url) as evidence. On poll timeout the gate
# surfaces "CI still pending" and proceeds rather than hanging forever.
# Off by default — fully backward-compatible when unset.
: "${GAFFER_REQUIRE_CI:=0}"            # 1/true/yes/on to require CI green before review
: "${GAFFER_CI_POLL_ATTEMPTS:=20}"     # max poll cycles before "still pending" timeout
: "${GAFFER_CI_POLL_INTERVAL_SECS:=30}" # seconds between polls
export GAFFER_REQUIRE_CI GAFFER_CI_POLL_ATTEMPTS GAFFER_CI_POLL_INTERVAL_SECS

# H4 PR-creation helper (defines gaffer_create_pr / gaffer_pr_create_enabled /
# gaffer_has_github_remote / gaffer_build_pr_body). Sourced here so the functions
# are available in tick.sh which sources factory.config.sh.
# shellcheck source=lib/pr-create.sh
[ -f "$RUNNER_DIR/lib/pr-create.sh" ] && source "$RUNNER_DIR/lib/pr-create.sh"

# H3 CI-gate helper (defines gaffer_ci_gate / gaffer_ci_gate_enabled /
# gaffer_parse_checks). Sourced here for the same reason.
# shellcheck source=lib/ci-gate.sh
[ -f "$RUNNER_DIR/lib/ci-gate.sh" ] && source "$RUNNER_DIR/lib/ci-gate.sh"
