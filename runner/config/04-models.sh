# shellcheck shell=bash
# runner/config/04-models.sh: model tiering: the plan / implement models, whether the operator set them
# (the *_EXPLICIT flags), gaffer_model_flag and the model flags, the router registry.
# Sourced by runner/factory.config.sh only, in its fixed order, never directly or on
# its own: it reads what the parts before it set. Lines moved verbatim from
# factory.config.sh. The last line tells factory.config.sh this part loaded whole.

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
# Computed ONCE, in the outermost shell that sources this file. The defaults below are
# exported, so every child that re-sources the config (tick.sh under loop.sh, the
# review/tester/merge helpers) sees GAFFER_*_MODEL set and would otherwise mark the
# config's own default as an operator override — which is exactly what happened: on a
# plain `bash runner/loop.sh` the router never ran and every tick logged
# "model=sonnet (explicit GAFFER_*_MODEL override)". A parent that already decided
# exports the decision; a child keeps it.
if [ -z "${GAFFER_PLAN_MODEL_EXPLICIT+x}" ]; then
  [ -n "${GAFFER_PLAN_MODEL+x}" ] && GAFFER_PLAN_MODEL_EXPLICIT=1 || GAFFER_PLAN_MODEL_EXPLICIT=0
fi
if [ -z "${GAFFER_IMPL_MODEL_EXPLICIT+x}" ]; then
  [ -n "${GAFFER_IMPL_MODEL+x}" ] && GAFFER_IMPL_MODEL_EXPLICIT=1 || GAFFER_IMPL_MODEL_EXPLICIT=0
fi
export GAFFER_PLAN_MODEL_EXPLICIT GAFFER_IMPL_MODEL_EXPLICIT
# GAFFER_MODELS (a setting) picks the three models: a preset column below, or three
# model ids "strong,standard,cheap", which fill the same names here (each only where
# nothing set it before: a real GAFFER_PLAN_MODEL still pins, as above). A model a
# setting derived is NOT an explicit pin: the router still routes, over the tiers
# GAFFER_MODEL_TIERS names (bin/route-model.mjs reads it over model-registry.json).
case "${GAFFER_MODELS:-standard}" in
  standard | economy | strong) ;;
  *)
    IFS=, read -r _gm_s _gm_m _gm_c <<<"$GAFFER_MODELS"
    [ -n "${GAFFER_PLAN_MODEL+x}" ] || { GAFFER_PLAN_MODEL="$_gm_s"; }
    [ -n "${GAFFER_IMPL_MODEL+x}" ] || { GAFFER_IMPL_MODEL="$_gm_m"; }
    [ -n "${GAFFER_MODEL_TIERS:-}" ] || { GAFFER_MODEL_TIERS="strong=$_gm_s,mid=$_gm_m,cheap=$_gm_c"; export GAFFER_MODEL_TIERS; }
    [ -n "${GAFFER_PLAN_DEBATE_MODELS:-}" ] || { GAFFER_PLAN_DEBATE_MODELS="$_gm_s,$_gm_m"; }
    unset _gm_s _gm_m _gm_c ;;
esac
_gaffer_derive GAFFER_MODELS <<'_GAFFER_TABLE_'
#                           standard     economy                           strong
?GAFFER_PLAN_MODEL          opus         sonnet                            opus      # the strong tier: planning, the final rework attempt, the eval judge
?GAFFER_IMPL_MODEL          sonnet       haiku                             opus      # the implement tier: delivery when the router does not pick, review, the tester
GAFFER_MODEL_TIERS          -            strong=sonnet,mid=haiku,cheap=haiku  strong=opus,mid=opus,cheap=sonnet   # the router's tiers over model-registry.json (strong, mid, cheap); unset = the registry's own (opus, sonnet, haiku)
GAFFER_PLAN_DEBATE_MODELS   opus,sonnet  sonnet,haiku                      opus,opus # the planning debate's proposer and critic
GAFFER_ROLE_MODELS          ~            # per-role models as "role=model" pairs (rework, scout, judge, tester, card, synth, inherit); an unnamed role keeps its default, which follows the tiers
GAFFER_PLAN_DEBATE          ~            # 1 turns on the two-model planning debate for a big epic (it multiplies planning cost); 0 = one planner
GAFFER_PLAN_DEBATE_MAX_ROUNDS ~          # plan-producing rounds of a debate (the draft is round 1)
GAFFER_PLAN_DEBATE_MIN_ESTIMATE ~        # the size signal a plan must reach before it is debated; 0 = any size
GAFFER_SCOUT                ~            # the pre-work scout: off (the free deterministic packet only), auto (plus one read-only cheap model call where it helps), none
GAFFER_CLAUDE_AUTH_PROBE    ~            # 1 = preflight asks the worker CLI whether its login works; 0 skips the probe
_GAFFER_TABLE_
export GAFFER_PLAN_MODEL GAFFER_IMPL_MODEL
# Per-role model overrides, one knob for all of them: GAFFER_ROLE_MODELS="card=haiku
# judge=opus" (commas or spaces). A role not named keeps its own default: rework (the
# final rework attempt; the plan tier, `rework=off` keeps the routed model), scout (the
# router's scout phase), judge (the plan tier, else the implement tier), tester (the
# implement tier), card (the registry's onboarding tier), synth (onboarding synthesis:
# the registry's mid tier) and inherit (the inherit classifier: the cheap tier). The
# .mjs helpers read it through lib/worker.mjs roleModel. The old per-role variables
# (GAFFER_REWORK_STRONG_MODEL, GAFFER_CARD_MODEL, ...) are deprecated: still honoured
# for a role the knob does not name, with a warning.
: "${GAFFER_ROLE_MODELS:=}"   # per-role models as "role=model" pairs (rework, scout, judge, tester, card, synth, inherit); an unnamed role keeps its default.
export GAFFER_ROLE_MODELS
for _gd in REWORK_STRONG_MODEL:rework CARD_MODEL:card INHERIT_MODEL:inherit ONBOARD_SYNTH_MODEL:synth TEST_MODEL:tester; do
  _gaffer_deprecated "GAFFER_${_gd%%:*}" "set GAFFER_ROLE_MODELS=\"${_gd#*:}=<model>\" instead"
done
for _gd in SCOUT_MODEL_FLAG:scout JUDGE_MODEL_FLAG:judge; do
  _gaffer_deprecated "GAFFER_${_gd%%:*}" "set GAFFER_ROLE_MODELS=\"${_gd#*:}=<model>\" instead (a model id, not a flag)"
done
unset _gd

# gaffer_role_model <role>
# Echo one role's model from GAFFER_ROLE_MODELS, else from its deprecated variable
# (rework: GAFFER_REWORK_STRONG_MODEL), else nothing (the caller applies the role's
# default). The two deprecated FLAG variables (scout, judge) hold a whole flag and are
# read at their call sites. Parity with roleModel in lib/worker.mjs.
gaffer_role_model() {
  local role="${1:-}" pair v=""
  local -a pairs=()
  IFS=$', \t\n' read -r -a pairs <<<"${GAFFER_ROLE_MODELS:-}"
  for pair in ${pairs[@]+"${pairs[@]}"}; do
    case "$pair" in "$role="?*) v="${pair#*=}"; break ;; esac
  done
  [ -n "$v" ] || case "$role" in rework) v="${GAFFER_REWORK_STRONG_MODEL:-}" ;; esac
  printf '%s' "$v"
}
# Worker-provider-indirected model-FLAG emission (Spec 3 / Phase 3). The model
# NAME is chosen by the registry-driven router (model-registry.json →
# gaffer_route_model, below); this helper is the ONE place that turns a chosen name
# into the worker CLI's model-selection FLAG SYNTAX. Splitting name-choice
# (registry-indirected) from flag-emission (provider-indirected) is the seam: a
# provider with its own flag syntax changes ONLY this `case`. `claude-code` emits
# `--model <name>` — BYTE-IDENTICAL to the historical inline emission; an empty
# name emits nothing (falls back to the worker's own default model).
gaffer_model_flag() {
  local model="${1:-}"
  [ -n "$model" ] || return 0
  case "${GAFFER_WORKER_PROVIDER:-claude-code}" in
    # claude-code: the claude CLI selects a model with `--model <name>`.
    # command: the same string is the seam's internal currency; worker_deliver reads
    # the name back out (gaffer_model_from_flag) and hands it to the worker program as
    # GAFFER_WORKER_MODEL. An unknown provider never spawns, so its flag is moot.
    claude-code|command|*) printf -- '--model %s' "$model" ;;
  esac
}
GAFFER_PLAN_MODEL_FLAG="$(gaffer_model_flag "${GAFFER_PLAN_MODEL:-}")"
GAFFER_IMPL_MODEL_FLAG="$(gaffer_model_flag "${GAFFER_IMPL_MODEL:-}")"

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
GAFFER_MODEL_REGISTRY="${GAFFER_MODEL_REGISTRY:-$RUNNER_DIR/model-registry.json}"
_GAFFER_CONFIG_PART=04-models
