# shellcheck shell=bash
# runner/config/06-routing.sh: model routing: gaffer_route_model and its decision record, and the planning
# debate knobs.
# Sourced by runner/factory.config.sh only, in its fixed order, never directly or on
# its own: it reads what the parts before it set. Lines moved verbatim from
# factory.config.sh. The last line tells factory.config.sh this part loaded whole.

# gaffer_route_model <phase> <risk> <ac_count> <stack> <attempt> [ticket] [worktree] [repo] [branch] [base]
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
  local phase="${1:-implement}" risk="${2:-}" ac="${3:-0}" stack="${4:-}" attempt="${5:-1}" ticket="${6:-}" worktree="${7:-}" repo="${8:-}" branch="${9:-}" base="${10:-main}"
  # MF3: the decision is also written for the usage ledger (gaffer_route_record), so a
  # row says which tier the router chose and why. A path that does not route clears it.
  gaffer_route_record "$ticket" "$phase" "" "" ""
  # Backward-compatible EXPLICIT overrides (the two knobs that exist today). They
  # win ONLY when the operator set them in the environment — NOT when they hold the
  # config's own opus/sonnet defaults (those are the registry-equivalent baseline,
  # so the router runs and reproduces today's tiers). *_EXPLICIT is captured in the
  # model block above, before the `=` default is applied. An explicit empty value
  # ("disable tiering") is honoured too: it routes to the Claude default for the
  # phase. We still emit an audit line recording the override.
  local override="" overrode=0
  case "$phase" in
    decompose|plan|clarify) [ "${GAFFER_PLAN_MODEL_EXPLICIT:-0}" = 1 ] && { override="${GAFFER_PLAN_MODEL:-}"; overrode=1; } ;;
    *)              [ "${GAFFER_IMPL_MODEL_EXPLICIT:-0}" = 1 ] && { override="${GAFFER_IMPL_MODEL:-}"; overrode=1; } ;;
  esac
  if [ "$overrode" = 1 ]; then
    log "ROUTE${ticket:+ #$ticket} phase=$phase risk=${risk:-medium} ac=$ac attempt=$attempt budget=${GAFFER_BUDGET_REMAINING:-unlimited} → model=$override (explicit GAFFER_*_MODEL override)"
    gaffer_route_record "$ticket" "$phase" override "$override" '["explicit GAFFER_*_MODEL override"]'
    printf '%s' "$override"
    return 0
  fi
  local node_bin; node_bin="$(command -v node 2>/dev/null || true)"
  if [ -z "$node_bin" ] || [ ! -f "$RUNNER_DIR/bin/route-model.mjs" ]; then
    # Fail-safe: no router available → fall back to the static tier for this phase.
    case "$phase" in
      decompose|plan|clarify) printf '%s' "${GAFFER_PLAN_MODEL:-}" ;;
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
    local _hist; _hist="$(gaffer_ticket_delivery_spend "$ticket" 2>/dev/null || echo 0)"
    if [ -n "$_hist" ] && awk "BEGIN{exit !(${_hist:-0}+0 > 0)}" 2>/dev/null; then
      _diff_args+=(--historical-cost "$_hist")
    fi
  fi
  local _db="" _fc=""
  if [ -n "$worktree" ] && { [ -d "$worktree/.git" ] || [ -f "$worktree/.git" ]; } \
     && command -v git >/dev/null 2>&1; then
    # Measure the REAL diff SIZE in bytes — the raw patch, NOT a `--stat` summary. A
    # `--stat` line is a handful of bytes whatever the change ("file | 500 +++---"),
    # so a 40 KB diff measured that way reads as ~60 B and NEVER crosses the
    # HIGH_DIFF_BYTES difficulty mark — "big diff → route stronger" would never fire.
    _db="$(git -C "$worktree" diff HEAD 2>/dev/null | wc -c | tr -d ' ' || echo 0)"
    _fc="$(git -C "$worktree" diff --name-only HEAD 2>/dev/null | grep -c . || true)"
  fi
  # FINDING-9: on a REWORK attempt the worktree does not exist yet at routing time
  # (tick.sh routes BEFORE worktree creation) — and even when it does, `git diff HEAD`
  # only sees UNCOMMITTED work, never the COMMITTED rework accumulated on the
  # preserved branch. When the worktree gave no signal, measure the ACCUMULATED
  # rework diff from the real repo instead: `git diff base...branch` (merge-base
  # semantics) over the preserved gaffer/ branch. Best-effort — a missing repo,
  # branch, or base simply yields no signal.
  if ! [ "${_db:-0}" -gt 0 ] 2>/dev/null && [ -n "$repo" ] && [ -n "$branch" ] \
     && command -v git >/dev/null 2>&1 \
     && git -C "$repo" rev-parse --verify --quiet "refs/heads/$branch" >/dev/null 2>&1; then
    _db="$(git -C "$repo" diff "$base...$branch" -- 2>/dev/null | wc -c | tr -d ' ' || echo 0)"
    _fc="$(git -C "$repo" diff --name-only "$base...$branch" -- 2>/dev/null | grep -c . || true)"
  fi
  [ "${_db:-0}" -gt 0 ] 2>/dev/null && _diff_args+=(--diff-bytes "$_db")
  [ "${_fc:-0}" -gt 0 ] 2>/dev/null && _diff_args+=(--file-count "$_fc")
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
      decompose|plan|clarify) printf '%s' "${GAFFER_PLAN_MODEL:-}" ;;
      *)              printf '%s' "${GAFFER_IMPL_MODEL:-}" ;;
    esac
    return 0
  fi
  local model tier reasons
  model="$(printf '%s' "$json" | jget 'd.model || ""' 2>/dev/null || true)"
  tier="$(printf '%s' "$json" | jget 'd.tier || ""' 2>/dev/null || true)"
  reasons="$(printf '%s' "$json" | jget '(d.reasons || []).join("; ")' 2>/dev/null || true)"
  log "ROUTE${ticket:+ #$ticket} phase=$phase risk=${risk:-medium} ac=$ac attempt=$attempt budget=${GAFFER_BUDGET_REMAINING:-unlimited} → tier=$tier model=$model [${reasons}]"
  gaffer_route_record "$ticket" "$phase" "$tier" "$model" "$(printf '%s' "$json" | jget 'JSON.stringify(d.reasons || [])' 2>/dev/null || echo '[]')"
  printf '%s' "$model"
  return 0
}

# gaffer_route_record <ticket> <phase> <tier> <model> <reasons-json>
# MF3: write the router's decision for this ticket and phase to
# $GAFFER_DATA/.route/<ticket>.<phase>.json, where gaffer_usage_record hands it to the
# usage ledger (route_tier, route_reasons, route_phase on the row). An empty tier removes
# the file, so a call that was not routed never carries an older decision. Labels only;
# fail-soft (a write failure only loses the label).
gaffer_route_record() {
  local ticket="${1:-}" phase="${2:-}" tier="${3:-}" model="${4:-}" reasons="${5:-[]}"
  [ -n "$ticket" ] && [ -n "$phase" ] && [ -n "${GAFFER_DATA:-}" ] || return 0
  # Spelled out, not a range: a bracket range follows the locale's collation in bash 3.2.
  case "$ticket$phase" in *[!0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-]*) return 0 ;; esac
  local f="$GAFFER_DATA/.route/$ticket.$phase.json"
  if [ -z "$tier" ]; then rm -f "$f" 2>/dev/null; return 0; fi
  mkdir -p "$GAFFER_DATA/.route" 2>/dev/null || return 0
  PHASE="$phase" TIER="$tier" MODEL="$model" REASONS="$reasons" node -e '
    let r = []; try { r = JSON.parse(process.env.REASONS || "[]"); } catch { r = []; }
    process.stdout.write(JSON.stringify({ phase: process.env.PHASE, tier: process.env.TIER,
      model: process.env.MODEL || null, reasons: Array.isArray(r) ? r : [] }));' > "$f.tmp" 2>/dev/null \
    && mv -f "$f.tmp" "$f" 2>/dev/null || rm -f "$f.tmp" 2>/dev/null
  return 0
}

# gaffer_route_phase_of <ledger-kind> — the routing phase whose decision governs a call.
gaffer_route_phase_of() {
  case "${1:-}" in
    delivery) printf implement ;;
    review|security-review) printf review ;;
    clarify) printf clarify ;;
    *) printf '' ;;
  esac
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
# DASHBOARD WALL CLOCK: the dashboard's "Plan a build" spawns decompose and kills
# it after GAFFER_PLAN_BUILD_TIMEOUT_MS (milliseconds). Unset, the cap is derived:
# 200 s single-agent, or with the debate ON (2 × MAX_ROUNDS − 1) turns × the
# helper's per-turn GAFFER_DECOMPOSE_TIMEOUT_MS (default 180 s) + 20 s slack —
# so a healthy 3-turn debate is never reaped by a single-turn budget. Deliberately
# NOT defaulted here: a fixed value would override that debate-aware scaling. Read
# by packages/dispatch/src/api/planBuild.ts on every plan-build request, so a
# Settings-panel debate toggle widens the cap without a dashboard restart.

_GAFFER_CONFIG_PART=06-routing
