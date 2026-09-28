#!/usr/bin/env bash
# =====================================================================
# MODEL ROUTING — the "explicit operator override" flag survives config re-sourcing.
# ---------------------------------------------------------------------
# factory.config.sh exports the model DEFAULTS (plan=opus, implement=sonnet). Every
# child that sources the config again (tick.sh under loop.sh, the review / tester /
# merge helpers) therefore sees GAFFER_*_MODEL set — and used to conclude the operator
# had pinned a model, so the per-phase router never ran on a normal `bash loop.sh`:
# every tick logged "model=sonnet (explicit GAFFER_*_MODEL override)" (seen on a
# fresh-clone walkthrough). The flag is now decided ONCE in the outermost shell and
# inherited. Proven here with a real parent→child source chain.
# Run: bash runner/test/model-override-inheritance.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
CFG="$RUNNER_DIR/factory.config.sh"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/model-override.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/data"

# parent sources the config, then a CHILD bash sources it again (loop.sh → tick.sh).
chain() {  # $1 = env assignments for the OUTERMOST shell (may be empty)
  env -i PATH="$PATH" HOME="$HOME" GAFFER_DATA="$WORK/data" $1 \
    bash -c 'source "$0" >/dev/null 2>&1; bash -c "source \"$0\" >/dev/null 2>&1; printf \"%s %s %s %s\" \"\$GAFFER_IMPL_MODEL_EXPLICIT\" \"\$GAFFER_PLAN_MODEL_EXPLICIT\" \"\$GAFFER_IMPL_MODEL\" \"\$GAFFER_PLAN_MODEL\"" "$0"' "$CFG"
}

echo "== no operator override: the child still routes (EXPLICIT=0 after re-sourcing) =="
read -r IE PE IM PM <<< "$(chain "")"
[ "$IE" = "0" ] && ok "child: GAFFER_IMPL_MODEL_EXPLICIT=0 (config default is not an override)" || fail "child marked the impl default as explicit (got '$IE')"
[ "$PE" = "0" ] && ok "child: GAFFER_PLAN_MODEL_EXPLICIT=0" || fail "child marked the plan default as explicit (got '$PE')"
[ "$IM" = "sonnet" ] && [ "$PM" = "opus" ] && ok "child still carries the config defaults ($PM / $IM) as the router's baseline" || fail "defaults changed ($PM / $IM)"

echo "== operator pinned a model: the child honours it (EXPLICIT=1, value kept) =="
read -r IE PE IM PM <<< "$(chain "GAFFER_IMPL_MODEL=opus")"
[ "$IE" = "1" ] && [ "$IM" = "opus" ] && ok "child: impl override kept (EXPLICIT=1, model=opus)" || fail "impl override lost (explicit='$IE' model='$IM')"
[ "$PE" = "0" ] && ok "child: plan stays routed when only impl was pinned" || fail "plan wrongly explicit ('$PE')"

echo "== operator pinned an EMPTY value (disable tiering): still explicit in the child =="
read -r IE PE IM PM <<< "$(chain "GAFFER_IMPL_MODEL=")"
[ "$IE" = "1" ] && ok "child: empty impl override is still an explicit override (EXPLICIT=1)" || fail "empty override lost ('$IE')"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "model-override-inheritance: PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
