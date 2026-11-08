#!/usr/bin/env bash
# =====================================================================
# The config diet: families collapsed into one knob keep every default, and the old
# names still work for one release.
# ---------------------------------------------------------------------
# docs/CONFIG.md used to list 270 rows. Families of knobs that only make sense
# together became one knob each (docs/CONFIG.md "Deprecated" lists the old names).
# For each family this pins, with a clean environment and the real config:
#   1. the DEFAULT is the old default (the effective value every reader gets);
#   2. the new knob sets what it names and leaves the rest at their defaults;
#   3. each deprecated name still sets its value, the new knob wins over it, and the
#      config says it is deprecated on stderr once per process tree (a child that
#      sources the config again stays quiet), naming the replacement;
#   4. no old name is still defaulted or exported by the config.
# Zero deps beyond node. Run: bash runner/test/config-diet.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
CFG="$RUNNER_DIR/factory.config.sh"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(gaffer_test_tmpdir config-diet)" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
mkdir -p "$WORK/home" "$WORK/data"

# cfg [VAR=value ...] -- <snippet>: run the snippet in a clean env after sourcing the
# real config (its stderr goes to $WORK/err).
cfg() {
  local -a vars=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do vars+=("$1"); shift; done
  shift
  env -i PATH="$PATH" HOME="$WORK/home" GAFFER_DATA="$WORK/data" ERRF="$WORK/err" ${vars[@]+"${vars[@]}"} \
    bash --norc --noprofile -c 'source "$0" 2>"$ERRF"; eval "$1"' "$CFG" "$1"
}
# warned <name>: the deprecation line for <name> is on stderr exactly once.
warned() { [ "$(grep -c "gaffer: $1 is deprecated" "$WORK/err")" = "1" ]; }

echo "== no deprecated name is defaulted or exported by the config =="
EXP="$(cfg -- 'env | cut -d= -f1 | sort | tr "\n" " "')"
for n in GAFFER_REVIEW_MAX_TURNS GAFFER_SECURITY_REVIEW_MAX_TURNS GAFFER_CLARIFY_MAX_TURNS GAFFER_JUDGE_MAX_TURNS \
  GAFFER_TESTER_MAX_TURNS GAFFER_MERGE_MAX_TURNS GAFFER_RESOLVER_MAX_TURNS GAFFER_PO_MAX_TURNS GAFFER_SCOUT_MAX_TURNS \
  GAFFER_CAP_DETECT_TURNS GAFFER_REWORK_STRONG_MODEL GAFFER_SCOUT_MODEL_FLAG; do
  case " $EXP " in *" $n "*) fail "$n is still exported by the config" ;; *) ok "$n is not exported by the config" ;; esac
done
[ ! -s "$WORK/err" ] && ok "a clean source prints nothing on stderr (no deprecation line without an old name)" \
  || fail "clean source stderr: $(cat "$WORK/err")"

echo "== F1: per-role turn caps -> GAFFER_ROLE_MAX_TURNS =="
V="$(cfg -- 'for r in review:60 security_review:40 clarify:40 judge:2 tester:80 merge:60 po:60 scout:6 onboard:60; do printf "%s " "$(gaffer_role_turns "$(gaffer_role_cap "${r%%:*}" "${r#*:}")")"; done')"
[ "$V" = "60 40 40 2 80 60 60 6 60 " ] && ok "defaults: review 60, security_review 40, clarify 40, judge 2, tester 80, merge 60, po 60, scout 6, onboard 60" || fail "F1 defaults: $V"
V="$(cfg GAFFER_ROLE_MAX_TURNS="review=30,tester=500" -- 'printf "%s %s %s" "$(gaffer_role_turns "$(gaffer_role_cap review 60)")" "$(gaffer_role_turns "$(gaffer_role_cap tester 80)")" "$(gaffer_role_turns "$(gaffer_role_cap clarify 40)")"')"
[ "$V" = "30 200 40" ] && ok "the knob sets the roles it names (tester=500 still clamped to GAFFER_MAX_TURNS 200); clarify keeps 40" || fail "F1 knob: $V"
V="$(cfg GAFFER_REVIEW_MAX_TURNS=25 -- 'printf "%s" "$(gaffer_role_cap review 60)"')"
[ "$V" = "25" ] && warned GAFFER_REVIEW_MAX_TURNS && grep -q 'GAFFER_ROLE_MAX_TURNS="review=N"' "$WORK/err" \
  && ok "GAFFER_REVIEW_MAX_TURNS still sets the cap and warns once, naming the replacement" || fail "F1 alias: $V / $(cat "$WORK/err")"
V="$(cfg GAFFER_REVIEW_MAX_TURNS=25 GAFFER_ROLE_MAX_TURNS=review=30 -- 'printf "%s" "$(gaffer_role_cap review 60)"')"
[ "$V" = "30" ] && ok "the new knob wins over the deprecated name" || fail "F1 precedence: $V"
V="$(cd "$RUNNER_DIR" && env -i PATH="$PATH" GAFFER_TESTER_MAX_TURNS=90 node --input-type=module -e 'import { roleTurns } from "./lib/worker.mjs"; process.stdout.write([roleTurns("tester", 80), roleTurns("tester", 80, { GAFFER_ROLE_MAX_TURNS: "tester=70" }), roleTurns("po", 60, {})].join(" "))')"
[ "$V" = "90 70 60" ] && ok "the .mjs reader agrees: deprecated name, then the knob wins, then the default" || fail "F1 mjs: $V"

echo "== F2: ask-on-cap follows GAFFER_MAX_TURNS =="
V="$(cfg -- 'printf "%s|%s" "${GAFFER_CAP_DETECT_TURNS:-unset}" "$GAFFER_MAX_TURNS"')"
[ "$V" = "unset|200" ] && ok "no separate threshold: a call is cap-hit at GAFFER_MAX_TURNS (200)" || fail "F2 default: $V"
cfg GAFFER_CAP_DETECT_TURNS=50 -- ':' >/dev/null
warned GAFFER_CAP_DETECT_TURNS && ok "a set GAFFER_CAP_DETECT_TURNS warns once" || fail "F2 warning: $(cat "$WORK/err")"

echo "== F3: per-role models -> GAFFER_ROLE_MODELS =="
V="$(cfg -- 'printf "%s|%s|%s" "$_GAFFER_REWORK_MODEL" "$(gaffer_role_model scout)" "$(gaffer_role_model judge)"')"
[ "$V" = "opus||" ] && ok "defaults: the final rework attempt escalates to the plan tier (opus); scout and judge keep their routing" || fail "F3 defaults: $V"
V="$(cfg GAFFER_ROLE_MODELS="rework=off scout=haiku" -- 'printf "%s|%s" "$_GAFFER_REWORK_MODEL" "$(gaffer_role_model scout)"')"
[ "$V" = "|haiku" ] && ok "rework=off turns the escalation off; scout=haiku names the scout's model" || fail "F3 knob: $V"
V="$(cfg GAFFER_REWORK_STRONG_MODEL=sonnet -- 'printf "%s" "$_GAFFER_REWORK_MODEL"')"
[ "$V" = "sonnet" ] && warned GAFFER_REWORK_STRONG_MODEL && ok "GAFFER_REWORK_STRONG_MODEL still names the rework model and warns once" || fail "F3 alias: $V / $(cat "$WORK/err")"
cfg GAFFER_JUDGE_MODEL_FLAG="--model x" -- ':' >/dev/null
warned GAFFER_JUDGE_MODEL_FLAG && grep -q 'a model id, not a flag' "$WORK/err" && ok "a deprecated FLAG variable warns that the knob takes a model id" || fail "F3 flag warning: $(cat "$WORK/err")"
V="$(cd "$RUNNER_DIR" && env -i PATH="$PATH" GAFFER_CARD_MODEL=c1 node --input-type=module -e 'import { roleModel } from "./lib/worker.mjs"; process.stdout.write([roleModel("card"), roleModel("card", { GAFFER_CARD_MODEL: "c1", GAFFER_ROLE_MODELS: "card=c2" }), roleModel("synth", {}) || "-"].join(" "))')"
[ "$V" = "c1 c2 -" ] && ok "the .mjs reader agrees: deprecated name, then the knob wins, then the caller's default" || fail "F3 mjs: $V"

echo "== F4: GAFFER_SLACK_WEBHOOK -> GAFFER_NOTIFY_SLACK_URL =="
grep -q '_gaffer_deprecated GAFFER_SLACK_WEBHOOK "set GAFFER_NOTIFY_SLACK_URL' "$RUNNER_DIR/status.sh" \
  && grep -qF '"$GAFFER_SLACK_WEBHOOK" >/dev/null' "$RUNNER_DIR/status.sh" \
  && ok "status.sh still posts to GAFFER_SLACK_WEBHOOK and says it is deprecated" || fail "F4: status.sh legacy channel"
V="$(cfg GAFFER_SLACK_WEBHOOK=https://hooks.invalid/x -- '_gaffer_deprecated GAFFER_SLACK_WEBHOOK "set GAFFER_NOTIFY_SLACK_URL instead" 2>>"$ERRF"')"
warned GAFFER_SLACK_WEBHOOK && ok "the warning names it once" || fail "F4 warning: $(cat "$WORK/err")"

echo "== the warning is said once per process tree =="
cfg GAFFER_PO_MAX_TURNS=30 -- 'bash --norc --noprofile -c "source \"\$0\"" "$0" 2>>"$ERRF"' >/dev/null
warned GAFFER_PO_MAX_TURNS && ok "a second source in a child stays quiet (one line for the tree)" || fail "repeat warning: $(cat "$WORK/err")"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "config-diet: ALL $PASS checks passed"
  exit 0
fi
echo "config-diet: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
