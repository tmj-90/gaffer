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

echo "== F5: docker sandbox caps -> GAFFER_SANDBOX_LIMITS =="
mkdir -p "$WORK/sbx/wt"; printf '%s\n' "$WORK/sbx/wt" > "$WORK/sbx/w"; : > "$WORK/sbx/r"
caps() {  # the --pids-limit / --memory / --cpus the real wrapper would pass (dry run)
  env -i PATH="$PATH" HOME="$WORK/home" GAFFER_DATA="$WORK/data" GAFFER_SANDBOX_DRY_RUN=1 GAFFER_MCP_BRIDGE=0 "$@" \
    bash "$RUNNER_DIR/lib/sandbox-docker.sh" "$WORK/sbx/w" "$WORK/sbx/r" -- true 2>/dev/null \
    | awk 'p { printf "%s ", $0; p = 0 } /^--(pids-limit|memory|cpus)$/ { printf "%s=", substr($0, 3); p = 1 }'
}
V="$(caps)"
[ "$V" = "pids-limit=512 memory=4g cpus=4 " ] && ok "defaults: pids 512, memory 4g, cpus 4" || fail "F5 defaults: $V"
V="$(caps GAFFER_SANDBOX_LIMITS="cpus=2, pids=99")"
[ "$V" = "pids-limit=99 memory=4g cpus=2 " ] && ok "the knob sets the caps it names; memory keeps 4g" || fail "F5 knob: $V"
V="$(caps GAFFER_SANDBOX_MEMORY=1g GAFFER_SANDBOX_CPUS=3 GAFFER_SANDBOX_LIMITS=cpus=2)"
[ "$V" = "pids-limit=512 memory=1g cpus=2 " ] && ok "a deprecated cap variable still applies; the knob wins over it" || fail "F5 alias: $V"
for bad in "pids=-1" "pids=0" "memory=0" "cpus=0" "cpus=0.0" "cpus=abc" "pids=" "cpu=8"; do
  if env -i PATH="$PATH" HOME="$WORK/home" GAFFER_DATA="$WORK/data" GAFFER_SANDBOX_DRY_RUN=1 GAFFER_MCP_BRIDGE=0 GAFFER_SANDBOX_LIMITS="$bad" \
    bash "$RUNNER_DIR/lib/sandbox-docker.sh" "$WORK/sbx/w" "$WORK/sbx/r" -- true >/dev/null 2>"$WORK/sbx-err"; then
    fail "F5: GAFFER_SANDBOX_LIMITS=$bad was accepted (docker reads a zero or negative cap as none)"
  else
    grep -q "GAFFER_SANDBOX_LIMITS: '$bad'" "$WORK/sbx-err" && ok "F5: a malformed GAFFER_SANDBOX_LIMITS=$bad refuses the run (fails closed)" \
      || fail "F5: $bad refused without naming it: $(cat "$WORK/sbx-err")"
  fi
done
cfg GAFFER_SANDBOX_PIDS=100 -- ':' >/dev/null
warned GAFFER_SANDBOX_PIDS && grep -q 'GAFFER_SANDBOX_LIMITS="pids=N"' "$WORK/err" && ok "GAFFER_SANDBOX_PIDS warns once, naming the replacement" || fail "F5 warning: $(cat "$WORK/err")"

echo "== F6: the experiment caps are the command's flags =="
for n in GAFFER_EXPERIMENT_MAX_USD GAFFER_EXPERIMENT_MAX_TICKETS GAFFER_EXPERIMENT_MAX_ATTEMPTS; do
  case " $EXP " in *" $n "*) fail "$n is still exported by the config" ;; *) ok "$n is not defaulted by the config" ;; esac
done
V="$(env -i PATH="$PATH" HOME="$WORK/home" GAFFER_DATA="$WORK/data" GAFFER_EXPERIMENT_MAX_TICKETS=x \
  bash "$RUNNER_DIR/eval/experiment.sh" --arm a --arm b --out "$WORK/xp" 2>&1)"
grep -q 'GAFFER_EXPERIMENT_MAX_TICKETS is deprecated.*pass --max-tickets instead' <<<"$V" \
  && grep -q -- '--max-tickets must be a positive integer' <<<"$V" \
  && ok "a deprecated GAFFER_EXPERIMENT_MAX_TICKETS still sets the flag's default, and says to pass --max-tickets" || fail "F6 alias: $V"
V="$(env -i PATH="$PATH" HOME="$WORK/home" GAFFER_DATA="$WORK/data" bash "$RUNNER_DIR/eval/experiment.sh" --arm a --arm b --live --out "$WORK/xp2" 2>&1)"
grep -q -- '--live needs a hard USD cap for the whole run: --max-usd X' <<<"$V" \
  && ok "--live still refuses without a dollar cap" || fail "F6 live cap: $V"

echo "== F7: the sensitive-path regexes -> GAFFER_SENSITIVE_PATH_RE =="
V="$(cfg -- 'printf "%s|%s" "$(gaffer_lite_trivial_reason low 5 1 db/migrations/1.sql)" "$(gaffer_lite_trivial_reason low 5 1 src/payments/a.ts)"')"
[ "$V" = "nontrivial:sensitive-path|trivial" ] && ok "default: the built-in list (a migration is sensitive, payments/ is not)" || fail "F7 default: $V"
V="$(cfg GAFFER_SENSITIVE_PATH_RE=payments/ -- 'printf "%s" "$(gaffer_lite_trivial_reason low 5 1 src/payments/a.ts)"')"
[ "$V" = "nontrivial:sensitive-path" ] && ok "the knob replaces the list for the lite classifier" || fail "F7 knob: $V"
grep -qF '_re="${GAFFER_SENSITIVE_PATH_RE:-${GAFFER_SECURITY_REVIEW_RE:-' "$RUNNER_DIR/config/18-review.sh" \
  && ok "the security second opinion reads the same knob first" || fail "F7: security review does not read the knob"
for knob in GAFFER_SENSITIVE_PATH_RE GAFFER_LITE_SENSITIVE_RE; do
  V="$(cfg "$knob=(" -- 'printf "%s" "$(gaffer_lite_trivial_reason low 5 1 src/a.ts)"')"
  [ "$V" = "nontrivial:sensitive-path-regex-invalid" ] && ok "a malformed $knob holds the ticket in lite (fails closed, never 'nothing is sensitive')" || fail "F7 malformed $knob: $V"
done
# The security second opinion: a low-risk ticket touching only src/a.ts.
git init -q "$WORK/sr" && git -C "$WORK/sr" -c user.name=t -c user.email=t@t commit -q --allow-empty -m base \
  && git -C "$WORK/sr" checkout -q -b work && echo x > "$WORK/sr/a.ts" && git -C "$WORK/sr" add a.ts \
  && git -C "$WORK/sr" -c user.name=t -c user.email=t@t commit -q -m work
SR='wg() { printf "%s" "{\"ok\":true,\"data\":{\"ticket\":{\"risk_level\":\"low\"}}}"; }; base="$(git -C "'"$WORK/sr"'" rev-parse work~1)"; gaffer_needs_security_review 1 "'"$WORK/sr"'" "$base" work && printf "review" || printf "skip"'
V="$(cfg -- "$SR")"
[ "$V" = "skip" ] && ok "security review: a low-risk diff on no sensitive path gets no second opinion (default list)" || fail "F7 security default: $V"
V="$(cfg GAFFER_SENSITIVE_PATH_RE='(^|/)a\.ts$' -- "$SR")"
[ "$V" = "review" ] && ok "security review: GAFFER_SENSITIVE_PATH_RE names the paths that get the second opinion" || fail "F7 security knob: $V"
V="$(cfg GAFFER_SENSITIVE_PATH_RE='(' -- "$SR")"
[ "$V" = "review" ] && ok "security review: a malformed GAFFER_SENSITIVE_PATH_RE runs the second opinion (fails closed)" || fail "F7 security malformed: $V"
cfg GAFFER_SECURITY_REVIEW_RE=x -- ':' >/dev/null
warned GAFFER_SECURITY_REVIEW_RE && ok "GAFFER_SECURITY_REVIEW_RE warns once" || fail "F7 warning: $(cat "$WORK/err")"

echo "== F11: the lite bounds -> GAFFER_LITE_MAX_DIFF =="
V="$(cfg -- 'printf "%s|%s|%s" "$(gaffer_lite_trivial_reason low 60 4 a)" "$(gaffer_lite_trivial_reason low 61 1 a)" "$(gaffer_lite_trivial_reason low 1 5 a)"')"
[ "$V" = "trivial|nontrivial:lines=61>60|nontrivial:files=5>4" ] && ok "defaults: 60 lines, 4 files" || fail "F11 defaults: $V"
V="$(cfg GAFFER_LITE_MAX_DIFF="lines=10" GAFFER_LITE_MAX_FILES=2 -- 'printf "%s|%s" "$(gaffer_lite_trivial_reason low 11 1 a)" "$(gaffer_lite_trivial_reason low 1 3 a)"')"
[ "$V" = "nontrivial:lines=11>10|nontrivial:files=3>2" ] && warned GAFFER_LITE_MAX_FILES \
  && ok "the knob sets lines; the deprecated files bound still applies and warns once" || fail "F11: $V / $(cat "$WORK/err")"

echo "== F8: GAFFER_GREENFIELD_INSTALL -> GAFFER_DOD_INSTALL =="
mkdir -p "$WORK/gf"; printf '{"name":"gf","version":"1.0.0"}\n' > "$WORK/gf/package.json"; printf '{"lockfileVersion":3}\n' > "$WORK/gf/package-lock.json"
V="$(cfg GAFFER_DOD_INSTALL=0 -- 'gaffer_dod_install_enabled && printf on || printf off; gaffer_ensure_node_modules "'"$WORK/gf"'" >/dev/null 2>&1; [ -e "'"$WORK/gf"'/node_modules" ] && printf "|installed" || printf "|skipped"')"
[ "$V" = "off|skipped" ] && ok "GAFFER_DOD_INSTALL=0 turns off the pre-gate install and the greenfield prime" || fail "F8: $V"
V="$(cfg -- 'gaffer_dod_install_enabled && printf on || printf off')"
[ "$V" = "on" ] && ok "default: the pre-gate install is on" || fail "F8 default: $V"
cfg GAFFER_GREENFIELD_INSTALL=0 -- ':' >/dev/null
warned GAFFER_GREENFIELD_INSTALL && ok "GAFFER_GREENFIELD_INSTALL warns once" || fail "F8 warning: $(cat "$WORK/err")"

echo "== F9: one command's switch is its flag =="
for pair in "GAFFER_VERBOSE:gaffer onboard --verbose" "DEMO_DIR:gaffer demo --dir" "GAFFER_DAEMON_INTERVAL:gaffer run --daemon --interval"; do
  grep -qF "_gaffer_deprecated ${pair%%:*} \"pass ${pair#*:}" "$RUNNER_DIR/gaffer" \
    && ok "${pair%%:*} is deprecated for \`${pair#*:}\`" || fail "F9: no deprecation for ${pair%%:*}"
done
grep -qF '_gaffer_deprecated GAFFER_PREFLIGHT_LIVE "pass runner/preflight.sh --live' "$RUNNER_DIR/preflight.sh" \
  && ok "GAFFER_PREFLIGHT_LIVE is deprecated for \`runner/preflight.sh --live\`" || fail "F9: no deprecation for GAFFER_PREFLIGHT_LIVE"
case " $EXP " in *" GAFFER_PREFLIGHT_LIVE "* | *" GAFFER_DAEMON_INTERVAL "*) fail "F9: an old switch is still exported" ;; *) ok "neither old switch is defaulted by the config" ;; esac

echo "== F10: GAFFER_SCOUT_PACKET -> GAFFER_SCOUT=none =="
V="$(cfg -- 'printf "%s|%s|%s" "$GAFFER_SCOUT" "${GAFFER_SCOUT_PACKET:-unset}" "$(_gaffer_manifest_packet_on)"')"
[ "$V" = "off|unset|1" ] && ok "default: GAFFER_SCOUT=off and the packet is built (the manifest still records packet 1)" || fail "F10 default: $V"
V="$(cfg GAFFER_SCOUT=none -- 'printf "%s" "$(_gaffer_manifest_packet_on)"')"
[ "$V" = "0" ] && ok "GAFFER_SCOUT=none turns the packet off" || fail "F10 none: $V"
V="$(cfg GAFFER_SCOUT_PACKET=0 -- 'printf "%s" "$(_gaffer_manifest_packet_on)"')"
[ "$V" = "0" ] && warned GAFFER_SCOUT_PACKET && ok "the deprecated GAFFER_SCOUT_PACKET=0 still turns it off and warns once" || fail "F10 alias: $V / $(cat "$WORK/err")"

echo "== removed knobs: a set one is ignored and said once =="
REMOVED_LIST="$(cd "$RUNNER_DIR/.." && node --input-type=module -e 'const { REMOVED } = await import("./scripts/config-reference.mjs"); for (const r of REMOVED) console.log(r.name)')"
[ "$(printf '%s\n' "$REMOVED_LIST" | grep -c .)" = "18" ] && ok "config-reference lists the fifteen removed names and the three renamed paths" || fail "removed list: $REMOVED_LIST"
for n in $REMOVED_LIST; do
  cfg "$n=7" -- 'bash --norc --noprofile -c "source \"\$0\"" "$0" 2>>"$ERRF"' >/dev/null
  [ "$(grep -c "gaffer: $n was removed and its value is ignored; " "$WORK/err")" = "1" ] \
    && ok "$n: one line says it was removed, that the value is ignored, and what happens now" || fail "$n removed warning: $(cat "$WORK/err")"
done
V="$(cfg GAFFER_MERGE_GATE_RETRIES=9 GAFFER_AGENT_NAME=x -- 'printf "%s" "$_GAFFER_AGENT_NAME"')"
[ "$V" = "gaffer-factory" ] && ok "a removed knob's value is ignored (the agent still registers as gaffer-factory)" || fail "removed value applied: $V"

echo "== runner-only paths are _GAFFER_ internals =="
V="$(cfg GAFFER_AGENT_ID_FILE=/x GAFFER_REVIEWER_ID_FILE=/y GAFFER_EVAL_LEDGER=/z -- 'printf "%s|%s|%s" "$_GAFFER_AGENT_ID_FILE" "$_GAFFER_REVIEWER_ID_FILE" "$_GAFFER_EVAL_LEDGER"')"
[ "$V" = "$WORK/data/agent_id|$WORK/data/agent_reviewer_id|$WORK/data/eval-ledger.jsonl" ] \
  && ok "the agent id files and the eval ledger are _GAFFER_ internals under GAFFER_DATA (an old name is ignored)" || fail "renamed internals: $V"
EXP2="$(cfg -- 'env | cut -d= -f1 | tr "\n" " "')"
case " $EXP2 " in *" GAFFER_AGENT_ID_FILE "* | *" GAFFER_REVIEWER_ID_FILE "* | *" GAFFER_EVAL_LEDGER "* | *" _GAFFER_EVAL_LEDGER "*) fail "a renamed path is exported" ;; *) ok "none of them is exported (so none reaches a child or the agent)" ;; esac
LEFT="$(grep -rlwE 'GAFFER_(AGENT_ID_FILE|REVIEWER_ID_FILE|EVAL_LEDGER)' "$RUNNER_DIR" "$RUNNER_DIR/../packages"/*/src 2>/dev/null \
  | grep -vE '/test/|/config/01-settings\.sh$' || true)"
[ -z "$LEFT" ] && ok "no code outside the removed-name list still reads the old names" || fail "old names still read: $LEFT"

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
