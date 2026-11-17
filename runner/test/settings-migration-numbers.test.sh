#!/usr/bin/env bash
# =====================================================================
# External review 21, item 2: the settings migration reads every number the old
# dashboard stored the way the old runner read it, and an unreadable cap never becomes
# "no limit".
# ---------------------------------------------------------------------
# Before the fourteen settings, the dashboard API (bf5e305 api/settings.ts) stored:
#   * an `int` key: any value whose TRIM is digits (" 3", "3 ", "03" were stored as
#     typed, padding and leading zeros included; the old runner read them with awk and
#     `[ -ge ]`, both of which take " 3" and "03" as 3);
#   * a `number` key (dollars): `^(\d+(\.\d*)?|\.\d+)$`, so ".5" and "5." too (awk
#     reads them as 0.5 and 5).
# The migration compared old values with `^[0-9]+([.][0-9]+)?$` and ignored every other
# spelling, so a stored ".5" per-ticket cap left the factory with no per-ticket cap.
# The same holds for a switch: the old API trimmed a boolean before checking it and
# stored it as typed, so a stored " 0" (stricter) was ignored and the derived 1 applied.
# Pinned here, for every numeric old key the migration compares (and the switches):
#   1. a table of old key x stored string -> the value in force (and the decision);
#   2. the reviewer's spending case end to end: GAFFER_REWORK_BUDGET_USD ".5" and a
#      fixture spend of $1: the pre-spawn budget gate blocks further work;
#   3. an old value no old reading accepts: a spend cap refuses to start, naming the
#      key; a count or time cap whose setting still derives a limit runs on that limit
#      and says the old value could not be read.
# Zero deps beyond node. Run: bash runner/test/settings-migration-numbers.test.sh
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

WORK="$(gaffer_test_tmpdir settings-migration-numbers)" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
mkdir -p "$WORK/home" "$WORK/data"

# settings <json>: write settings.json.
settings() { printf '%s\n' "$1" > "$WORK/data/settings.json"; }
# cfg <snippet>: source the real config in a clean env, then run the snippet. Prints the
# snippet's output; the config's stderr goes to $WORK/err; the exit status is the
# config's (a refusal) or the snippet's.
cfg() {
  env -i PATH="$PATH" HOME="$WORK/home" GAFFER_DATA="$WORK/data" ERRF="$WORK/err" ${EXTRA:+$EXTRA} \
    bash --norc --noprofile -c 'source "$0" 2>"$ERRF" || exit $?; eval "$1"' "$CFG" "$1"
}
# The decision the migration log records for a key.
DECISION='printf "%s" "$_GAFFER_MIGRATION_LOG" | awk -F"\t" -v k="$K" "\$1 == k { print \$5 }"'
# json_str <raw>: a JSON string literal of raw (tabs and spaces kept).
json_str() { node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' -- "$1"; }

# row KEY STORED EXPECT_VALUE EXPECT_DECISION: stored string -> the value in force.
row() {
  local key="$1" stored="$2" want="$3" wantdec="$4" got rc
  settings "{\"$key\": $(json_str "$stored")}"
  got="$(K="$key" cfg 'printf "%s|" "${'"$key"'-}"; K='"$key"'; '"$DECISION")"; rc=$?
  if [ "$rc" = 0 ] && [ "$got" = "$want|$wantdec" ]; then
    ok "$key stored $(json_str "$stored") -> in force '$want' ($wantdec)"
  else
    fail "$key stored $(json_str "$stored"): want '$want|$wantdec', got '$got' (rc=$rc) $(tr '\n' ' ' < "$WORK/err" | cut -c1-200)"
  fi
}

echo "== count and time caps (old type int: trimmed digits, stored as typed) =="
# KEY  derived default (GAFFER_* settings at their defaults)  policy
while IFS=' ' read -r key dflt pol; do
  [ -n "$key" ] || continue
  if [ "$pol" = more ]; then low=7; else low=1; fi
  if [ "$dflt" = "$low" ]; then dec=same; else dec=kept; fi
  for s in "$low" " $low" "$low " "  $low  " "	$low" "0$low" "00$low"; do
    row "$key" "$s" "$low" "$dec"
  done
  # 0: a real 0 for less0 (kept), no limit for less (the derived limit stays).
  case "$pol" in
    less0) row "$key" "0" "0" kept; row "$key" " 00 " "0" kept ;;
    less) row "$key" "0" "$dflt" stricter-derived ;;
  esac
  # Higher than the derived limit: the derived one is stricter.
  [ "$pol" = more ] || row "$key" " 0099999" "$dflt" stricter-derived
done <<'_KEYS_'
MAX_TICKS 5 less0
MAX_TICKS_PER_DAY 50 less
MAX_CONCURRENT_TICKETS_PER_REPO 1 less
MAX_OPEN_AGENT_BRANCHES_PER_REPO 3 less
MAX_OPEN_AGENT_PRS_PER_REPO 3 less
GAFFER_TICK_TIMEOUT 1800 less
GAFFER_MAX_TURNS 200 less
GAFFER_MAX_DELIVERY_ATTEMPTS 3 less0
DISPATCH_MAX_ATTEMPTS 3 less
GAFFER_MAX_NOCOMMIT_FAILURES 3 less
GAFFER_PLAN_DEBATE_MAX_ROUNDS 2 less
GAFFER_PLAN_DEBATE_MIN_ESTIMATE 0 more
OVERSIZED_MAX_FILES 12 less0
OVERSIZED_MAX_LINES 400 less0
_KEYS_

echo "== dollar amounts (old type number: digits with an optional decimal part) =="
# GAFFER_REWORK_BUDGET_USD: less, derived empty (no per-ticket ceiling) by default.
row GAFFER_REWORK_BUDGET_USD ".5" "0.5" kept
row GAFFER_REWORK_BUDGET_USD "5." "5" kept
row GAFFER_REWORK_BUDGET_USD "0.5" "0.5" kept
row GAFFER_REWORK_BUDGET_USD "05.50" "5.50" kept
row GAFFER_REWORK_BUDGET_USD "5" "5" kept
row GAFFER_REWORK_BUDGET_USD "0" "" same
row GAFFER_REWORK_BUDGET_USD "0." "" same
# GAFFER_BUDGET_LOW_THRESHOLD: more, derived 0 with no lifetime budget.
row GAFFER_BUDGET_LOW_THRESHOLD ".5" "0.5" kept
row GAFFER_BUDGET_LOW_THRESHOLD "5." "5" kept
row GAFFER_BUDGET_LOW_THRESHOLD "2.50" "2.50" kept
row GAFFER_BUDGET_LOW_THRESHOLD "0" "0" same

echo "== the reviewer's case: stored .5, spend \$1: further work is blocked =="
settings '{"GAFFER_REWORK_BUDGET_USD": ".5"}'
GATE="$(mktemp "${TMPDIR:-/tmp}/budget-gate.XXXXXX")"
gaffer_test_check_tmp "$GATE" file || exit 70
{
  awk '/^gaffer_budget_exhausted\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "$RUNNER_DIR/lib/tick-gates.sh"
  grep -E '^_num_(pos|ge|le)\(\)' "$RUNNER_DIR/lib/tick-gates.sh"
} > "$GATE"
V="$(GATE="$GATE" EXTRA="GATE=$GATE" cfg 'source "$GATE"; SHOW="{\"ticket\":{}}"; gaffer_ticket_rework_spend() { echo 1.00; }; if gaffer_budget_exhausted 7; then printf "blocked ceil=%s spent=%s" "$GAFFER_BUDGET_CEIL" "$GAFFER_BUDGET_SPENT"; else printf allowed; fi')"
rm -f "$GATE"
[ "$V" = "blocked ceil=0.5 spent=1.00" ] && ok "stored .5 and spend \$1.00: the pre-spawn budget gate blocks further work" \
  || fail "spending gate with stored .5: $V"

echo "== an old value no old reading accepts =="
for s in "abc" "-1" "1e3" "\$5" "+5" "5 dollars" "0x10"; do
  settings "{\"GAFFER_REWORK_BUDGET_USD\": $(json_str "$s")}"
  V="$(cfg 'printf "started:%s" "${GAFFER_REWORK_BUDGET_USD-}"')"; rc=$?
  if [ "$rc" != 0 ] && grep -q "GAFFER_REWORK_BUDGET_USD" "$WORK/err" && [ -z "$V" ]; then
    ok "spend cap stored $(json_str "$s"): the config refuses to start, naming the key"
  else
    fail "spend cap stored $(json_str "$s"): rc=$rc out='$V' err=$(tr '\n' ' ' < "$WORK/err" | cut -c1-200)"
  fi
done
# With a lifetime budget the setting derives a per-ticket ceiling, but an unreadable
# spend cap still refuses: the person meant a different amount, and money is not guessed.
settings '{"GAFFER_BUDGET_USD": "20", "GAFFER_REWORK_BUDGET_USD": "abc"}'
V="$(cfg 'printf started')"; rc=$?
[ "$rc" != 0 ] && grep -q "GAFFER_REWORK_BUDGET_USD" "$WORK/err" \
  && ok "spend cap unreadable beside a lifetime budget: still refuses to start" \
  || fail "spend cap unreadable with a budget: rc=$rc out='$V'"
for s in "abc" "1.5" "-2" "1e3" " 3 4" "３"; do
  row MAX_TICKS_PER_DAY "$s" "50" unreadable
  row GAFFER_TICK_TIMEOUT "$s" "1800" unreadable
done
row GAFFER_PLAN_DEBATE_MIN_ESTIMATE "abc" "0" unreadable
row GAFFER_BUDGET_LOW_THRESHOLD "abc" "0" unreadable
settings '{"GAFFER_TICK_TIMEOUT": "abc"}'
cfg ':' >/dev/null
grep -q "GAFFER_TICK_TIMEOUT.*could not be read" "$WORK/err" \
  && ok "an unreadable count or time cap is named on stderr (could not be read)" \
  || fail "unreadable warning: $(cat "$WORK/err")"
# An empty value is a setting the dashboard cleared: the default, never unreadable.
row GAFFER_REWORK_BUDGET_USD "" "" same
row MAX_TICKS "" "5" ignored

echo "== switches: the old API trimmed a boolean and stored it as typed =="
# on: an old 1 is stricter (GAFFER_LANDING=local derives GAFFER_CREATE_PR=0).
for s in " 1" "TRUE " " yes " "1"; do row GAFFER_CREATE_PR "$s" "1" kept; done
row GAFFER_CREATE_PR " 0 " "0" same
# off: an old 0 is stricter (GAFFER_MODE=autonomous derives AUTO_MERGE=1).
for s in " 0" "False " " no" "0"; do
  settings "{\"GAFFER_MODE\": \"autonomous\", \"AUTO_MERGE\": $(json_str "$s")}"
  V="$(cfg 'printf "%s|" "$AUTO_MERGE"; K=AUTO_MERGE; '"$DECISION")"
  [ "$V" = "0|kept" ] && ok "AUTO_MERGE stored $(json_str "$s") under autonomous -> in force '0' (kept)" \
    || fail "AUTO_MERGE stored $(json_str "$s") under autonomous: $V $(tr '\n' ' ' < "$WORK/err" | cut -c1-160)"
done
# rank: the idle switches, an old 0 is the strictest level.
row GAFFER_IDLE_FEATURE_BACKLOG " 0" "0" kept

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "settings-migration-numbers: ALL $PASS checks passed"
  exit 0
fi
echo "settings-migration-numbers: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
