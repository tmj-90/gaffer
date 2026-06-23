#!/usr/bin/env bash
# =====================================================================
# MODEL TIERING — a strong model PLANS, a fast model IMPLEMENTS + TESTS.
#   PLAN  → decompose / clarify / product-owner   (GAFFER_PLAN_MODEL, default opus)
#   IMPL  → delivery / bootstrap / merge-resolve  (GAFFER_IMPL_MODEL, default sonnet)
# Proves, against the REAL config + scripts:
#   AC1  factory.config.sh defaults PLAN=opus, IMPL=sonnet + pre-split *_FLAG vars
#   AC2  an empty model var → empty flag (fall back to the Claude default), not "--model"
#   AC3  tick.sh wires the IMPL flag into the delivery calls + the PLAN flag into clarify
#   AC4  product-owner's buildClaudeArgv carries a --model through into the argv
#   AC5  each .mjs reads the model var that matches its step (plan vs impl)
#
# Zero deps; needs only bash + node. Run: bash test/model-tiering.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

echo "== AC1: config defaults + pre-split flags =="
if ( RUNNER_DIR="$RUNNER_DIR"; source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
     [ "${GAFFER_PLAN_MODEL:-}" = opus ] && [ "${GAFFER_IMPL_MODEL:-}" = sonnet ] \
       && [ "${GAFFER_PLAN_MODEL_FLAG:-}" = "--model opus" ] && [ "${GAFFER_IMPL_MODEL_FLAG:-}" = "--model sonnet" ] ); then
  ok "PLAN=opus, IMPL=sonnet + flags pre-split"
else fail "config defaults / pre-split flags wrong"; fi

echo "== AC2: empty model var → empty flag (Claude default) =="
if ( RUNNER_DIR="$RUNNER_DIR" GAFFER_PLAN_MODEL="" GAFFER_IMPL_MODEL=""; source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
     [ -z "${GAFFER_PLAN_MODEL_FLAG:-}" ] && [ -z "${GAFFER_IMPL_MODEL_FLAG:-}" ] ); then
  ok "empty model → no --model flag (use the default)"
else fail "empty model should yield an empty flag"; fi

echo "== AC3: tick.sh wires the per-step flags =="
n=$(grep -c 'GAFFER_IMPL_MODEL_FLAG' "$RUNNER_DIR/tick.sh")
[ "${n:-0}" -ge 3 ] && ok "tick.sh adds the IMPL flag to $n delivery call(s)" || fail "expected >=3 IMPL flag sites, got ${n:-0}"
grep -q 'GAFFER_PLAN_MODEL_FLAG' "$RUNNER_DIR/tick.sh" && ok "tick.sh adds the PLAN flag to the clarify call" || fail "clarify call missing the PLAN flag"

echo "== AC4: each .mjs PREPENDS --model from the matching step's model var =="
# (asserted by source, not import — the .mjs self-execute main() on import)
grep -q 'flags.unshift("--model"' "$RUNNER_DIR/bin/decompose.mjs"  && ok "decompose prepends --model (GAFFER_PLAN_MODEL)" || fail "decompose --model prepend missing"
grep -q '\["--model", m'          "$RUNNER_DIR/bin/product-owner-run.mjs" && ok "product-owner prepends --model" || fail "product-owner --model prepend missing"
grep -q '\["--model", m'          "$RUNNER_DIR/bin/merge-ticket.mjs"      && ok "merge-ticket prepends --model"   || fail "merge-ticket --model prepend missing"

echo "== AC5: each .mjs reads the model var matching its step =="
grep -q 'GAFFER_PLAN_MODEL' "$RUNNER_DIR/bin/decompose.mjs"         && ok "decompose reads GAFFER_PLAN_MODEL (plan)"      || fail "decompose missing GAFFER_PLAN_MODEL"
grep -q 'GAFFER_PLAN_MODEL' "$RUNNER_DIR/bin/product-owner-run.mjs" && ok "product-owner reads GAFFER_PLAN_MODEL (plan)"  || fail "product-owner missing GAFFER_PLAN_MODEL"
grep -q 'GAFFER_IMPL_MODEL' "$RUNNER_DIR/bin/merge-ticket.mjs"      && ok "merge-ticket reads GAFFER_IMPL_MODEL (impl)"   || fail "merge-ticket missing GAFFER_IMPL_MODEL"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"; exit 0
else
  printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
fi
