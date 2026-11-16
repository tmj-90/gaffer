#!/usr/bin/env bash
# =====================================================================
# The fourteen settings: strict values, precedence, what each preset derives, and the
# migration of a settings.json written before them.
# ---------------------------------------------------------------------
# With a clean environment and the real config, this pins:
#   A. strict validation: an unknown value for any setting in settings.json stops the
#      config (non-zero, the setting and its accepted values named; a URL never shown);
#      so does one in the environment for the newer settings; the older names keep their
#      environment reading (GAFFER_MODE=yolo warns and runs supervised);
#   B. precedence: a real environment variable for a derived name beats every setting;
#      a setting in the environment beats settings.json; a derived value from a
#      non-default preset is exported;
#   C. every figure of every non-default preset;
#   D. a realistic pre-change settings.json: each old key is ignored with ONE warning
#      naming the setting that decides it now, except where it is stricter than what
#      the settings derive (then it still applies), never widening autonomy or spend;
#      a child that sources the config again is quiet;
#   E. autonomy: an environment override more permissive than the mode keeps today's
#      behaviour (the containment rule still turns the sandbox requirement on).
# Run: bash runner/test/settings-fourteen.test.sh
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

WORK="$(gaffer_test_tmpdir settings-fourteen)" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
mkdir -p "$WORK/home" "$WORK/data"

# cfg [VAR=value ...] -- <snippet>: the snippet after sourcing the real config in a clean
# env; stderr to $WORK/err; the config's own exit status is the snippet's when it stops.
cfg() {
  local -a vars=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do vars+=("$1"); shift; done
  shift
  env -i PATH="$PATH" HOME="$WORK/home" GAFFER_DATA="$WORK/data" ERRF="$WORK/err" ${vars[@]+"${vars[@]}"} \
    bash --norc --noprofile -c 'source "$0" 2>"$ERRF"; eval "$1"' "$CFG" "$1"
}
file() { printf '%s\n' "$1" > "$WORK/data/settings.json"; }
nofile() { rm -f "$WORK/data/settings.json"; }
# vals <names...>: a snippet printing NAME=value (or NAME unset) per name, space-joined.
vals() { local n s=''; for n in "$@"; do s="$s"'printf "%s=%s " '"$n"' "${'"$n"'-<unset>}"; '; done; printf '%s' "$s"; }
exported() { printf 'for n in %s; do case " $(compgen -e | tr "\\n" " ") " in *" $n "*) printf "%%s:x " "$n" ;; *) printf "%%s:- " "$n" ;; esac; done' "$*"; }

echo "== A: strict validation =="
for kv in GAFFER_MODE=yolo GAFFER_EFFORT=huge GAFFER_SANDBOX=none GAFFER_GATES=lax GAFFER_LANDING=push \
  GAFFER_TESTING=maybe GAFFER_IDLE=sometimes GAFFER_MODELS=gpt GAFFER_CONCURRENCY=0 GAFFER_CONCURRENCY=65 \
  GAFFER_DAILY_BUDGET_USD=abc GAFFER_BUDGET_USD=-3 DISPATCH_API_PORT=99999 GAFFER_NOTIFY=ftp://x; do
  k="${kv%%=*}"; v="${kv#*=}"
  file "{\"$k\":\"$v\"}"
  OUT="$(cfg -- 'echo REACHED')"; RC=$?
  if [ "$RC" != 0 ] && [[ "$OUT" != *REACHED* ]] && grep -q "gaffer: settings.json sets $k=" "$WORK/err" && grep -q 'fail closed' "$WORK/err"; then
    ok "settings.json $kv stops the config and names it"
  else
    fail "settings.json $kv: rc=$RC out=$OUT err=$(cat "$WORK/err")"
  fi
done
file '{"GAFFER_EFFORT":"huge"}'; cfg -- ':' >/dev/null
grep -q 'is not one of: small, standard, large' "$WORK/err" && ok "the message lists the accepted values" || fail "accepted values not named: $(cat "$WORK/err")"
file '{"GAFFER_NOTIFY":"https://hooks.example.invalid/secret-token x"}'; cfg -- ':' >/dev/null
grep -q 'secret-token' "$WORK/err" && fail "a notify URL was printed: $(cat "$WORK/err")" || ok "a refused GAFFER_NOTIFY never prints its URL"
file '{"GAFFER_GATES":"tests,lint"}'; OUT="$(cfg -- 'echo REACHED')"
[[ "$OUT" != *REACHED* ]] && grep -q 'only the environment may do that' "$WORK/err" \
  && ok "a gate list from settings.json stops the config (it would turn gates off)" || fail "gate list from file: $OUT $(cat "$WORK/err")"
file '{"GAFFER_DATA":"/elsewhere"}'; V="$(cfg -- 'printf "%s" "$GAFFER_DATA"')"
[ "$V" = "$WORK/data" ] && grep -q 'ignoring GAFFER_DATA from settings.json' "$WORK/err" \
  && ok "GAFFER_DATA from settings.json is ignored (the file lives inside it), said once" || fail "GAFFER_DATA from file: $V $(cat "$WORK/err")"
nofile
for kv in GAFFER_EFFORT=huge GAFFER_SANDBOX=none GAFFER_GATES=lax GAFFER_LANDING=push GAFFER_IDLE=x GAFFER_MODELS=a,b GAFFER_NOTIFY=mailto:x \
  GAFFER_TESTING=maybe "GAFFER_TESTING= on"; do
  OUT="$(cfg "$kv" -- 'echo REACHED')"; RC=$?
  [ "$RC" != 0 ] && [[ "$OUT" != *REACHED* ]] && grep -q "gaffer: the environment sets ${kv%%=*}=" "$WORK/err" \
    && ok "environment $kv stops the config" || fail "environment $kv: rc=$RC $OUT $(cat "$WORK/err")"
done
V="$(cfg GAFFER_MODE=yolo -- "$(vals REVIEW_MODE AUTO_MERGE)")"
[ "$V" = "REVIEW_MODE=human AUTO_MERGE=0 " ] && grep -q "GAFFER_MODE='yolo' is not a mode" "$WORK/err" \
  && ok "an unknown GAFFER_MODE in the environment keeps its old reading: warned, supervised" || fail "env yolo: $V $(cat "$WORK/err")"
V="$(cfg GAFFER_TESTING=No GAFFER_DAILY_BUDGET_USD=abc -- 'printf "%s|%s" "$GAFFER_TESTING" "$GAFFER_DAILY_BUDGET_USD"')"
[ "$V" = "No|abc" ] && ok "older names keep their environment reading (the tester lane and the spend gate judge them, as before)" || fail "older env names: $V"
V="$(cfg GAFFER_GATES="tests, lint" -- "$(vals GAFFER_DOD_TESTS GAFFER_DOD_LINT GAFFER_DOD_TYPECHECK)")"
[ "$V" = "GAFFER_DOD_TESTS=1 GAFFER_DOD_LINT=1 GAFFER_DOD_TYPECHECK=0 " ] && ok "a gate list in the environment runs only the gates it names" || fail "env gate list: $V"

# A setting the dashboard cleared is stored as "" (writeSettings): it is the default,
# never a value that stops the config.
file '{"GAFFER_MODE":"","GAFFER_TESTING":"","GAFFER_CONCURRENCY":"","GAFFER_EFFORT":"","GAFFER_MODELS":"","DISPATCH_API_PORT":"","GAFFER_GATES":"","GAFFER_SANDBOX":""}'
V="$(cfg -- "$(vals GAFFER_MODE GAFFER_TICK_TIMEOUT GAFFER_IMPL_MODEL REVIEW_MODE)")"; RC=$?
[ "$RC" = 0 ] && [ "$V" = "GAFFER_MODE=supervised GAFFER_TICK_TIMEOUT=1800 GAFFER_IMPL_MODEL=sonnet REVIEW_MODE=human " ] \
  && ok "a cleared setting (\"\" in settings.json) is the default, it does not stop the config" || fail "cleared settings: rc=$RC $V $(cat "$WORK/err")"
nofile

echo "== B: precedence =="
file '{"GAFFER_EFFORT":"large"}'
V="$(cfg GAFFER_TICK_TIMEOUT=100 -- "$(vals GAFFER_TICK_TIMEOUT GAFFER_MAX_TURNS)")"
[ "$V" = "GAFFER_TICK_TIMEOUT=100 GAFFER_MAX_TURNS=300 " ] && ok "an environment variable for a derived name beats the setting; the rest follow the setting" || fail "env override: $V"
V="$(cfg GAFFER_EFFORT=small -- "$(vals GAFFER_EFFORT GAFFER_TICK_TIMEOUT)")"
[ "$V" = "GAFFER_EFFORT=small GAFFER_TICK_TIMEOUT=900 " ] && ok "a setting in the environment beats settings.json" || fail "env setting: $V"
V="$(cfg -- "$(exported GAFFER_EFFORT GAFFER_TICK_TIMEOUT GAFFER_DOD_TIMEOUT GAFFER_CI_POLL_ATTEMPTS)")"
[ "$V" = "GAFFER_EFFORT:x GAFFER_TICK_TIMEOUT:x GAFFER_DOD_TIMEOUT:x GAFFER_CI_POLL_ATTEMPTS:x " ] \
  && ok "the setting from the file and what its preset derived are exported (children and other processes see them)" || fail "exports: $V"
V="$(cfg -- 'printf "%s" "$GAFFER_MAX_TURNS_FLAG"')"
[ "$V" = "--max-turns 300" ] && ok "values computed from a derived one follow it (--max-turns 300)" || fail "flag: $V"
nofile

echo "== C: every non-default preset =="
pre() {  # pre <setting=value> <expected> <names...>
  local kv="$1" want="$2"; shift 2
  local got; got="$(cfg "$kv" -- "$(vals "$@")")"
  [ "$got" = "$want" ] && ok "$kv: $want" || fail "$kv: got '$got' want '$want' ($(cat "$WORK/err"))"
}
EFF="GAFFER_TICK_TIMEOUT GAFFER_MAX_TURNS GAFFER_MAX_DELIVERY_ATTEMPTS GAFFER_DOD_TIMEOUT GAFFER_CI_POLL_ATTEMPTS DISPATCH_MAX_ATTEMPTS GAFFER_MAX_NOCOMMIT_FAILURES GAFFER_CLAIM_TTL GAFFER_TICK_OUTER_TIMEOUT"
# shellcheck disable=SC2086
pre GAFFER_EFFORT=small "GAFFER_TICK_TIMEOUT=900 GAFFER_MAX_TURNS=100 GAFFER_MAX_DELIVERY_ATTEMPTS=2 GAFFER_DOD_TIMEOUT=600 GAFFER_CI_POLL_ATTEMPTS=10 DISPATCH_MAX_ATTEMPTS=2 GAFFER_MAX_NOCOMMIT_FAILURES=2 GAFFER_CLAIM_TTL=2100 GAFFER_TICK_OUTER_TIMEOUT=1920 " $EFF
# shellcheck disable=SC2086
pre GAFFER_EFFORT=large "GAFFER_TICK_TIMEOUT=3600 GAFFER_MAX_TURNS=300 GAFFER_MAX_DELIVERY_ATTEMPTS=4 GAFFER_DOD_TIMEOUT=1800 GAFFER_CI_POLL_ATTEMPTS=40 DISPATCH_MAX_ATTEMPTS=4 GAFFER_MAX_NOCOMMIT_FAILURES=4 GAFFER_CLAIM_TTL=14700 GAFFER_TICK_OUTER_TIMEOUT=14520 " $EFF
pre GAFFER_GATES=strict "GAFFER_DOD_FLAKY_RERUN=0 MINIMALISM_REQUIRE_NOTE=1 OVERSIZED_MAX_LINES=250 OVERSIZED_MAX_FILES=8 GAFFER_REVIEW_RULE_REPEAT=2 GAFFER_DOD_TESTS=1 HYGIENE_ENFORCE=1 " \
  GAFFER_DOD_FLAKY_RERUN MINIMALISM_REQUIRE_NOTE OVERSIZED_MAX_LINES OVERSIZED_MAX_FILES GAFFER_REVIEW_RULE_REPEAT GAFFER_DOD_TESTS HYGIENE_ENFORCE
pre GAFFER_LANDING=pr "GAFFER_CREATE_PR=1 GAFFER_REQUIRE_CI=1 GAFFER_PR_MERGE_METHOD=merge GAFFER_PR_LOCAL_FALLBACK=0 " \
  GAFFER_CREATE_PR GAFFER_REQUIRE_CI GAFFER_PR_MERGE_METHOD GAFFER_PR_LOCAL_FALLBACK
IDLE="CLARIFY_DRAFTS_WHEN_IDLE IDLE_DRAFT_WHEN_IDLE GAFFER_MAINTENANCE GAFFER_IDLE_FEATURE_BACKLOG"
# shellcheck disable=SC2086
pre GAFFER_IDLE=off "CLARIFY_DRAFTS_WHEN_IDLE=0 IDLE_DRAFT_WHEN_IDLE=0 GAFFER_MAINTENANCE=0 GAFFER_IDLE_FEATURE_BACKLOG=0 " $IDLE
# shellcheck disable=SC2086
pre GAFFER_IDLE=maintenance "CLARIFY_DRAFTS_WHEN_IDLE=0 IDLE_DRAFT_WHEN_IDLE=0 GAFFER_MAINTENANCE=1 GAFFER_IDLE_FEATURE_BACKLOG=0 " $IDLE
# shellcheck disable=SC2086
pre GAFFER_IDLE=backlog "CLARIFY_DRAFTS_WHEN_IDLE=0 IDLE_DRAFT_WHEN_IDLE=0 GAFFER_MAINTENANCE=0 GAFFER_IDLE_FEATURE_BACKLOG=1 " $IDLE
# shellcheck disable=SC2086
pre GAFFER_IDLE=all "CLARIFY_DRAFTS_WHEN_IDLE=1 IDLE_DRAFT_WHEN_IDLE=1 GAFFER_MAINTENANCE=1 GAFFER_IDLE_FEATURE_BACKLOG=1 " $IDLE
V="$(cfg GAFFER_IDLE=backlog -- "$(exported GAFFER_IDLE_FEATURE_BACKLOG)")"
[ "$V" = "GAFFER_IDLE_FEATURE_BACKLOG:x " ] && ok "the backlog switch is exported for crew" || fail "backlog export: $V"
pre GAFFER_SANDBOX=docker "SANDBOX_PROVIDER=docker " SANDBOX_PROVIDER
pre GAFFER_SANDBOX=sandbox-exec "SANDBOX_PROVIDER=sandbox-exec " SANDBOX_PROVIDER
# economy moves only the strong tier: implementation and the reviewer agent (its APPROVE
# ships work in the autonomous modes) stay on the standard model.
pre GAFFER_MODELS=economy "GAFFER_PLAN_MODEL=sonnet GAFFER_IMPL_MODEL=sonnet GAFFER_MODEL_TIERS=strong=sonnet,mid=sonnet,cheap=haiku GAFFER_PLAN_DEBATE_MODELS=sonnet,sonnet GAFFER_PLAN_MODEL_EXPLICIT=0 _GAFFER_REWORK_MODEL=sonnet " \
  GAFFER_PLAN_MODEL GAFFER_IMPL_MODEL GAFFER_MODEL_TIERS GAFFER_PLAN_DEBATE_MODELS GAFFER_PLAN_MODEL_EXPLICIT _GAFFER_REWORK_MODEL
pre GAFFER_MODELS=strong "GAFFER_PLAN_MODEL=opus GAFFER_IMPL_MODEL=opus GAFFER_MODEL_TIERS=strong=opus,mid=opus,cheap=sonnet GAFFER_PLAN_DEBATE_MODELS=opus,opus " \
  GAFFER_PLAN_MODEL GAFFER_IMPL_MODEL GAFFER_MODEL_TIERS GAFFER_PLAN_DEBATE_MODELS
pre GAFFER_MODELS=m-strong,m-mid,m-cheap "GAFFER_PLAN_MODEL=m-strong GAFFER_IMPL_MODEL=m-mid GAFFER_MODEL_TIERS=strong=m-strong,mid=m-mid,cheap=m-cheap GAFFER_PLAN_DEBATE_MODELS=m-strong,m-mid GAFFER_IMPL_MODEL_EXPLICIT=0 " \
  GAFFER_PLAN_MODEL GAFFER_IMPL_MODEL GAFFER_MODEL_TIERS GAFFER_PLAN_DEBATE_MODELS GAFFER_IMPL_MODEL_EXPLICIT
V="$(cd "$RUNNER_DIR" && env -i PATH="$PATH" GAFFER_MODEL_TIERS=strong=sonnet,mid=sonnet,cheap=haiku node bin/route-model.mjs --phase review --json | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).model))')"
[ "$V" = sonnet ] && ok "under economy the reviewer agent stays on sonnet (review -> the mid tier)" || fail "economy review tier: $V"
for kv in "GAFFER_MODELS=--settings,x,y" "GAFFER_MODELS=a,-b,c"; do
  OUT="$(cfg "$kv" -- 'echo REACHED')"; RC=$?
  [ "$RC" != 0 ] && [[ "$OUT" != *REACHED* ]] && ok "a model id that starts with a dash is refused ($kv): it would read as a flag after --model" || fail "dash model id: $kv rc=$RC $OUT"
done
V="$(cd "$RUNNER_DIR" && env -i PATH="$PATH" GAFFER_MODEL_TIERS="mid=--dangerously-skip-permissions" node bin/route-model.mjs --phase implement --json | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).model))')"
[ "$V" = sonnet ] && ok "the router skips a tier model that starts with a dash" || fail "router dash tier: $V"
V="$(cd "$RUNNER_DIR" && env -i PATH="$PATH" GAFFER_MODEL_TIERS="strong=m-strong,mid=m-mid,cheap=m-cheap" node bin/route-model.mjs --phase implement --json | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).model))')"
[ "$V" = m-mid ] && ok "the router routes over the tiers GAFFER_MODELS names (implement -> m-mid)" || fail "router tiers: $V"
pre GAFFER_CONCURRENCY=3 "MAX_CANDIDATES=75 MAX_CONCURRENT_TICKETS_PER_REPO=1 MAX_TICKS_PER_DAY=50 " MAX_CANDIDATES MAX_CONCURRENT_TICKETS_PER_REPO MAX_TICKS_PER_DAY
pre GAFFER_CONCURRENCY=8 "MAX_CANDIDATES=100 " MAX_CANDIDATES
pre "GAFFER_NOTIFY=https://hooks.slack.com/services/T/B/x, https://example.invalid/hook desktop" \
  "GAFFER_NOTIFY_SLACK_URL=https://hooks.slack.com/services/T/B/x GAFFER_NOTIFY_WEBHOOK_URL=https://example.invalid/hook GAFFER_NOTIFY_DESKTOP=1 " \
  GAFFER_NOTIFY_SLACK_URL GAFFER_NOTIFY_WEBHOOK_URL GAFFER_NOTIFY_DESKTOP
V="$(cfg GAFFER_NOTIFY=desktop -- "$(exported GAFFER_NOTIFY_DESKTOP); $(vals GAFFER_NOTIFY_WEBHOOK_URL)")"
[ "$V" = "GAFFER_NOTIFY_DESKTOP:x GAFFER_NOTIFY_WEBHOOK_URL=<unset> " ] && ok "notify channels are exported for the dispatch notifier; an unnamed one stays unset" || fail "notify export: $V"

echo "== D: a settings.json written before the fourteen =="
# What the old Settings page wrote for an operator who turned autonomy on but kept a
# few safeguards, tuned spend and alerts, and flipped some lanes.
file '{"GAFFER_MODE":"autonomous","DISPATCH_ALLOW_AGENT_APPROVE":"0","REVIEW_MODE":"both",
 "MAX_TICKS_PER_DAY":"20","GAFFER_DAILY_BUDGET_USD":"25","GAFFER_TICK_TIMEOUT":"3600","GAFFER_MAX_TURNS":"150",
 "GAFFER_NOTIFY_SLACK_URL":"https://hooks.slack.com/services/T0/B0/tok3n","GAFFER_NOTIFY_DESKTOP":"1",
 "GAFFER_CREATE_PR":"1","GAFFER_REQUIRE_CI":"1","SANDBOX_PROVIDER":"none","STRICT_ALLOW_NETWORK":"1",
 "MAX_CONCURRENT_TICKETS_PER_REPO":"2","GAFFER_CONCURRENCY":"2","GAFFER_PLAN_DEBATE":"1","HYGIENE_ENFORCE":"0",
 "GAFFER_TESTING":"1","GAFFER_IDLE_FEATURE_BACKLOG":"1","GAFFER_MAINTENANCE":"0","GAFFER_REWORK_BUDGET_USD":"40"}'
V="$(cfg -- "$(vals GAFFER_MODE DISPATCH_ALLOW_AGENT_APPROVE AUTO_MERGE REVIEW_MODE MAX_TICKS_PER_DAY GAFFER_DAILY_BUDGET_USD GAFFER_TICK_TIMEOUT GAFFER_MAX_TURNS GAFFER_MAX_TURNS_FLAG GAFFER_NOTIFY_SLACK_URL GAFFER_NOTIFY_DESKTOP GAFFER_CREATE_PR GAFFER_REQUIRE_CI MAX_CONCURRENT_TICKETS_PER_REPO GAFFER_CONCURRENCY GAFFER_PLAN_DEBATE HYGIENE_ENFORCE GAFFER_TESTING GAFFER_IDLE_FEATURE_BACKLOG GAFFER_MAINTENANCE GAFFER_REWORK_BUDGET_USD GAFFER_STRICT_REQUIRE)")"
WANT="GAFFER_MODE=autonomous DISPATCH_ALLOW_AGENT_APPROVE=0 AUTO_MERGE=1 REVIEW_MODE=both MAX_TICKS_PER_DAY=20 GAFFER_DAILY_BUDGET_USD=25 GAFFER_TICK_TIMEOUT=1800 GAFFER_MAX_TURNS=150 GAFFER_MAX_TURNS_FLAG=--max-turns 150 GAFFER_NOTIFY_SLACK_URL=https://hooks.slack.com/services/T0/B0/tok3n GAFFER_NOTIFY_DESKTOP=1 GAFFER_CREATE_PR=1 GAFFER_REQUIRE_CI=1 MAX_CONCURRENT_TICKETS_PER_REPO=1 GAFFER_CONCURRENCY=2 GAFFER_PLAN_DEBATE=0 HYGIENE_ENFORCE=1 GAFFER_TESTING=1 GAFFER_IDLE_FEATURE_BACKLOG=<unset> GAFFER_MAINTENANCE=0 GAFFER_REWORK_BUDGET_USD=40 GAFFER_STRICT_REQUIRE=1 "
[ "$V" = "$WANT" ] && ok "the stricter reading wins for every old key (settings apply; nothing widens autonomy or spend)" || fail "old file: got  $V
                 want $WANT"
grep -q 'GAFFER_REWORK_BUDGET_USD' "$WORK/err" && ok "an old key with no derived ceiling (rework budget, nothing derives one without GAFFER_BUDGET_USD) is still a stricter reading and applies" || fail "rework budget not said"
for k in DISPATCH_ALLOW_AGENT_APPROVE REVIEW_MODE MAX_TICKS_PER_DAY GAFFER_TICK_TIMEOUT GAFFER_MAX_TURNS GAFFER_NOTIFY_SLACK_URL \
  GAFFER_NOTIFY_DESKTOP GAFFER_CREATE_PR GAFFER_REQUIRE_CI SANDBOX_PROVIDER STRICT_ALLOW_NETWORK MAX_CONCURRENT_TICKETS_PER_REPO \
  GAFFER_PLAN_DEBATE HYGIENE_ENFORCE GAFFER_IDLE_FEATURE_BACKLOG GAFFER_MAINTENANCE; do
  [ "$(grep -c "settings.json key $k is no longer a setting" "$WORK/err")" = 1 ] && ok "$k: one warning" || fail "$k: not exactly one warning: $(grep "$k" "$WORK/err")"
done
for pair in "DISPATCH_ALLOW_AGENT_APPROVE:GAFFER_MODE" "REVIEW_MODE:GAFFER_MODE" "MAX_TICKS_PER_DAY:GAFFER_CONCURRENCY" "GAFFER_TICK_TIMEOUT:GAFFER_EFFORT" \
  "GAFFER_NOTIFY_SLACK_URL:GAFFER_NOTIFY" "GAFFER_CREATE_PR:GAFFER_LANDING" "SANDBOX_PROVIDER:GAFFER_SANDBOX" "HYGIENE_ENFORCE:GAFFER_GATES" "GAFFER_IDLE_FEATURE_BACKLOG:GAFFER_IDLE"; do
  grep "settings.json key ${pair%%:*} " "$WORK/err" | grep -q "${pair#*:}" && ok "${pair%%:*}: the warning names ${pair#*:}" || fail "${pair%%:*}: $(grep "${pair%%:*}" "$WORK/err")"
done
grep 'key DISPATCH_ALLOW_AGENT_APPROVE ' "$WORK/err" | grep -q 'stricter than what GAFFER_MODE derives' && ok "a stricter old value says it still applies" || fail "kept wording: $(grep DISPATCH_ALLOW "$WORK/err")"
grep 'key GAFFER_TICK_TIMEOUT ' "$WORK/err" | grep -q 'more permissive or costlier' && ok "a costlier old value says the stricter derived one applies" || fail "costlier wording: $(grep TICK_TIMEOUT "$WORK/err")"
grep 'key SANDBOX_PROVIDER ' "$WORK/err" | grep -q 'more permissive or costlier' && ok "SANDBOX_PROVIDER=none from the file is never applied (the sandbox stays)" || fail "none: $(grep SANDBOX_PROVIDER "$WORK/err")"
grep -q 'tok3n' "$WORK/err" && fail "a webhook token was printed: $(grep tok3n "$WORK/err")" || ok "no warning prints a URL"
cfg -- 'bash --norc --noprofile -c "source \"\$0\"" "$0" 2>"$ERRF.child"' >/dev/null
! grep -q 'no longer a setting' "$WORK/err.child" && ok "a child that sources the config again is quiet (one warning per process tree)" || fail "child repeats: $(cat "$WORK/err.child")"
V="$(cfg -- 'printf "%s" "$_GAFFER_MIGRATION_LOG" | awk -F"\t" '"'"'$1=="DISPATCH_ALLOW_AGENT_APPROVE"||$1=="GAFFER_TICK_TIMEOUT"||$1=="GAFFER_CREATE_PR" {print $1 ":" $3 ":" $5}'"'"' | sort | tr "\n" " "')"
[ "$V" = "DISPATCH_ALLOW_AGENT_APPROVE:GAFFER_MODE:kept GAFFER_CREATE_PR:GAFFER_LANDING:kept GAFFER_TICK_TIMEOUT:GAFFER_EFFORT:stricter-derived " ] \
  && ok "the machine-readable migration log records each decision" || fail "migration log: $V"
V="$(cfg DISPATCH_ALLOW_AGENT_APPROVE=1 -- "$(vals DISPATCH_ALLOW_AGENT_APPROVE)")"
[ "$V" = "DISPATCH_ALLOW_AGENT_APPROVE=1 " ] && grep 'key DISPATCH_ALLOW_AGENT_APPROVE ' "$WORK/err" | grep -q 'the environment sets' \
  && ok "a real environment variable still wins over an old key (and the warning says so)" || fail "env over old key: $V $(grep DISPATCH "$WORK/err")"
file '{"AUTO_MERGE":"1","MERGE_ON_AGENT_REVIEW":"1","GAFFER_AUTO_PUSH":"1","MEMORY_AUTO_APPROVE":"1"}'
V="$(cfg -- "$(vals AUTO_MERGE MERGE_ON_AGENT_REVIEW GAFFER_AUTO_PUSH MEMORY_AUTO_APPROVE)")"
[ "$V" = "AUTO_MERGE=0 MERGE_ON_AGENT_REVIEW=0 GAFFER_AUTO_PUSH=0 MEMORY_AUTO_APPROVE=0 " ] \
  && ok "old ship flags turned on in settings.json do not ship anything under supervised" || fail "old ship flags: $V"
# An old pull-request delivery with CI required keeps its pull request: the CI gate reads
# its checks from the pull request, so dropping GAFFER_CREATE_PR would skip the gate.
file '{"GAFFER_CREATE_PR":"1","GAFFER_REQUIRE_CI":"1"}'
V="$(cfg -- "$(vals GAFFER_CREATE_PR GAFFER_REQUIRE_CI)")"
[ "$V" = "GAFFER_CREATE_PR=1 GAFFER_REQUIRE_CI=1 " ] && ok "an old file with pull requests and CI required keeps both (the CI gate is not skipped)" || fail "old PR + CI: $V"
# A 0 that is the strictest value is never read as "no limit".
file '{"MAX_TICKS":"0","GAFFER_MAX_DELIVERY_ATTEMPTS":"0"}'
V="$(cfg -- "$(vals MAX_TICKS GAFFER_MAX_DELIVERY_ATTEMPTS)")"
[ "$V" = "MAX_TICKS=0 GAFFER_MAX_DELIVERY_ATTEMPTS=0 " ] && ok "MAX_TICKS=0 (no tick) and GAFFER_MAX_DELIVERY_ATTEMPTS=0 (one attempt) from an old file still apply" || fail "zero caps: $V"
# An old event filter keeps limiting what is sent to the webhook (GAFFER_NOTIFY has none).
file '{"GAFFER_NOTIFY_EVENTS":"gate_failed"}'
V="$(cfg -- "$(vals GAFFER_NOTIFY_EVENTS)")"
[ "$V" = "GAFFER_NOTIFY_EVENTS=gate_failed " ] && ok "an old GAFFER_NOTIFY_EVENTS filter still applies" || fail "notify events: $V"
# A switch value no reader takes the same way (padded, a typo) is never kept as "stricter":
# bash readers do not trim it (off) while the dispatch server does (on).
file '{"DISPATCH_ALLOW_AGENT_APPROVE":" 1","AUTO_MERGE":"1;x","MEMORY_AUTO_APPROVE":"TRUE ","HYGIENE_ENFORCE":"off","GAFFER_AUTO_PUSH":"False"}'
V="$(cfg -- "$(vals DISPATCH_ALLOW_AGENT_APPROVE AUTO_MERGE MEMORY_AUTO_APPROVE HYGIENE_ENFORCE GAFFER_AUTO_PUSH)")"
[ "$V" = "DISPATCH_ALLOW_AGENT_APPROVE=0 AUTO_MERGE=0 MEMORY_AUTO_APPROVE=0 HYGIENE_ENFORCE=1 GAFFER_AUTO_PUSH=0 " ] \
  && ok "padded or garbage switch values from an old file are ignored; plain ones compare (False reads as 0)" || fail "switch values: $V"
V="$(cfg GAFFER_MODE=autonomous -- "$(vals DISPATCH_ALLOW_AGENT_APPROVE AUTO_MERGE GAFFER_AUTO_PUSH)")"
[ "$V" = "DISPATCH_ALLOW_AGENT_APPROVE=1 AUTO_MERGE=1 GAFFER_AUTO_PUSH=0 " ] \
  && ok "under autonomous a plain old False still turns auto push off (applied as 0); the garbage ones are ignored" || fail "switch values autonomous: $V"
# A cleared old key ("" in settings.json) was the default before the fourteen (the
# mode's `:=` filled it): it is not a 0 that turns an autonomous factory's merging off.
file '{"GAFFER_MODE":"autonomous","AUTO_MERGE":"","GAFFER_AUTO_PUSH":"","MERGE_ON_AGENT_REVIEW":""}'
V="$(cfg -- "$(vals AUTO_MERGE GAFFER_AUTO_PUSH MERGE_ON_AGENT_REVIEW)")"
[ "$V" = "AUTO_MERGE=1 GAFFER_AUTO_PUSH=1 MERGE_ON_AGENT_REVIEW=1 " ] && ok "a cleared old switch is the mode's value, as before" || fail "cleared old switch: $V"
nofile

echo "== E: autonomy is never widened by accident =="
V="$(cfg GAFFER_STRICT_REQUIRE= AUTO_MERGE=1 -- "$(vals AUTO_MERGE GAFFER_STRICT_REQUIRE STRICT_MODE)")"
[ "$V" = "AUTO_MERGE=1 GAFFER_STRICT_REQUIRE=1 STRICT_MODE=1 " ] && ok "an environment ship flag over supervised is honoured as before, and containment follows it" || fail "env ship flag: $V"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "settings-fourteen: ALL $PASS checks passed"
  exit 0
fi
echo "settings-fourteen: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
