#!/usr/bin/env bash
# =====================================================================
# PACKAGE H1, END TO END: a person's tester waiver needs a principal, and the build it
# accepts reads "accepted with 1 waiver". Real dispatch, real tick.sh (delivery, the
# tester lane, the agent review), real git, `gaffer approve` and `gaffer merge`; stub
# agents (no model). An epic of one implementation ticket (not tester-gated) and its
# acceptance ticket (always tester-gated):
#   1. the implementation is delivered, agent-reviewed, approved by a person and lands;
#   2. the acceptance ticket is delivered and sent to the tester, whose stub gives no
#      verdict: the ticket is HELD in_testing for a person;
#   3. the tokenless waiver (`gaffer wg ticket tester-pass --as human`) is refused, and so
#      is `--as admin`; nothing moves;
#   4. the principal's waiver (GAFFER_PRINCIPAL_TOKEN) is accepted: back to in_review,
#      recorded as the principal and bound to the head;
#   5. the single agent review and the person's approval follow, and it lands (done);
#   6. `gaffer status` and `wg stats` read "accepted with 1 waiver";
#   7. the principal token, exported in the operator's shell for every tick, reached no
#      agent process (each stub agent dumped its env).
# Run: bash runner/test/waiver-principal-e2e.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
[ -f "$ROOT/packages/dispatch/dist/cli/index.js" ] || { echo "SKIP: dispatch CLI not built"; exit 0; }
[ -f "$ROOT/packages/crew/dist/runtime/context/renderPromptCli.js" ] || { echo "SKIP: crew not built"; exit 0; }
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/waiver-e2e.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
[ "${KEEP:-0}" = 1 ] && echo "keeping $WORK" || trap 'gaffer_test_rm_work "$WORK"' EXIT
mkdir -p "$WORK/data" "$WORK/bin" "$WORK/envdumps"
R="$WORK/repo"; mkdir -p "$R/src" "$R/test"
gitc() { git -c user.email=t@t -c user.name=t "$@"; }
( cd "$R" && git init -q -b main
  printf '{ "name": "r", "version": "0.1.0", "private": true, "type": "module", "scripts": { "test": "node --test", "lint": "node -e 0" } }\n' > package.json
  printf 'export const v = 1;\n' > src/v.js
  printf 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { v } from "../src/v.js";\ntest("smoke", () => { assert.equal(v, 1); });\n' > test/smoke.test.js
  gitc add -A && gitc commit -qm init ) >/dev/null

# Stub agent: dumps its env first (the principal token must never be in it), then
#   tester: no verdict (the tester lane HOLDS the ticket for a person);
#   reviewer: RECOMMEND APPROVE with the verdict line;
#   delivery (in a checkout): one new line in docs/change.md, committed.
cat > "$WORK/bin/claude" <<STUB
#!/usr/bin/env bash
DUMPS="$WORK/envdumps"
STUB
cat >> "$WORK/bin/claude" <<'STUB'
case "${1:-}" in --version) echo "stub 1.0 (Claude Code)"; exit 0 ;; esac
env > "$DUMPS/$$.$RANDOM.env"
prompt=""; prev=""; for a in "$@"; do [ "$prev" = "-p" ] && prompt="$a"; prev="$a"; done
case "$prompt" in
  *"INDEPENDENT TESTER"*)
    printf '{"type":"result","subtype":"success","is_error":false,"result":"I could not observe criterion 1 on this host.","total_cost_usd":0.01,"num_turns":1}\n'; exit 0 ;;
  *"RECOMMEND APPROVE"*)
    printf '{"type":"result","subtype":"success","is_error":false,"result":"Reviewed the diff. RECOMMEND APPROVE\\n{\\"verdict\\":\\"APPROVE\\"}","total_cost_usd":0.01,"num_turns":1}\n'; exit 0 ;;
esac
if [ -e .git ]; then
  mkdir -p docs; printf 'change %s %s\n' "$$" "$RANDOM" >> docs/change.md
  git -c user.email=s@s -c user.name=s add -A >/dev/null; git -c user.email=s@s -c user.name=s commit -qm "feat: delivery" >/dev/null 2>&1 || true
  printf '{"type":"result","subtype":"success","is_error":false,"result":"done.\\n\\nSmallest-change note: one line.","total_cost_usd":0.01,"num_turns":1}\n'; exit 0
fi
printf '{"type":"result","subtype":"success","is_error":false,"result":"ok"}\n'
STUB
chmod +x "$WORK/bin/claude"

export GAFFER_DATA="$WORK/data" CLAUDE_BIN="$WORK/bin/claude" CLAUDE_FLAGS="" GAFFER_CLAUDE_VERSION="stub" \
       GAFFER_MAX_TURNS=3 GAFFER_TICK_TIMEOUT=120 GAFFER_ROLE_MODELS=card=stub GAFFER_PLAN_MODEL=stub GAFFER_IMPL_MODEL=stub \
       REVIEW_MODE=both DRY_RUN=0 GAFFER_MAINTENANCE=0 GAFFER_STRICT_REQUIRE=0 GAFFER_SECURITY_REVIEW=0 GAFFER_TESTING=1 \
       AUTO_MERGE=0 GAFFER_DAILY_BUDGET_USD=5 GAFFER_DIGEST_DISABLE=1 GAFFER_AUTO_PUSH=0 \
       MAX_OPEN_AGENT_BRANCHES_PER_REPO=12 MAX_OPEN_AGENT_PRS_PER_REPO=12 MAX_IN_REVIEW_PER_REPO=12
unset GAFFER_DOD_TYPECHECK_CMD GAFFER_TESTER_REPLAY GAFFER_PRINCIPAL_TOKEN DISPATCH_DB GAFFER_MODE
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
# shellcheck source=lib/principal.sh
. "$HERE/lib/principal.sh"
wg init >/dev/null 2>&1; lg init >/dev/null 2>&1
wg repo add -n repo --path "$R" --branch main --stack node --test "npm test" --lint "npm run lint" >/dev/null 2>&1
TOKEN="$(gaffer_test_principal_token tom)" && [ -n "$TOKEN" ] && ok "setup: principal tom minted" || fail "setup: no principal token"
# Every tick and gaffer command runs with the token exported in the operator's shell.
run_tick() { ( cd "$RUNNER_DIR" && GAFFER_PRINCIPAL_TOKEN="$TOKEN" bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep '^TICK_RESULT=' ; }
gaffer() { GAFFER_PRINCIPAL_TOKEN="${GTOKEN:-}" bash "$RUNNER_DIR/gaffer" "$@"; }
st() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.status'; }
head_of() { git -C "$R" rev-parse "refs/heads/$(wg ticket show "$1" 2>/dev/null | jget 'd.ticket.branch_name || "none"')" 2>/dev/null; }
# A person's approval names the commit they reviewed (no terminal to confirm on).
approve() { GTOKEN="" gaffer approve "$1" --commit "repo=$(head_of "$1")"; }
# tick_until <ticket> <status> [max]: run ticks until the ticket reaches the status.
tick_until() {
  local n="$1" want="$2" max="${3:-6}" i=0
  while [ "$i" -lt "$max" ]; do
    [ "$(st "$n")" = "$want" ] && return 0
    run_tick >/dev/null; i=$((i + 1))
  done
  [ "$(st "$n")" = "$want" ]
}

printf '%s' '{"epic":{"name":"Widgets","description":"a widget"},"tickets":[{"title":"Widget","description":"add a line","acceptanceCriteria":["v stays 1"],"repo":"repo","risk_level":"low","testable":false}]}' > "$WORK/plan.json"
EP="$(wg epic create "$WORK/plan.json" 2>/dev/null)"
IMPL="$(printf '%s' "$EP" | jget 'd.ticket_numbers[0]')"
ACC="$(printf '%s' "$EP" | jget 'd.acceptance_ticket_number')"
[ -n "$IMPL" ] && [ -n "$ACC" ] && ok "setup: epic with implementation #$IMPL and acceptance #$ACC" || fail "setup: epic create: $EP"
for n in "$IMPL" "$ACC"; do
  wg ticket repo-access set "$n" repo --access write --relation confirmed >/dev/null 2>&1
  wg ticket ready "$n" >/dev/null 2>&1
done

echo "== 1: the implementation is delivered, agent-reviewed, approved and lands =="
tick_until "$IMPL" in_review && ok "#$IMPL delivered (in_review)" || fail "#$IMPL status=$(st "$IMPL") $(tail -3 "$GAFFER_DATA/factory.log" 2>/dev/null | tr '\n' '|')"
run_tick >/dev/null   # the agent review
approve "$IMPL" >"$WORK/approve1.out" 2>&1 && ok "#$IMPL approved by a person" || fail "approve #$IMPL: $(tail -3 "$WORK/approve1.out")"
GTOKEN="" gaffer merge "$IMPL" >"$WORK/merge1.out" 2>&1
[ "$(st "$IMPL")" = done ] && ok "#$IMPL landed (done)" || fail "#$IMPL status=$(st "$IMPL"): $(tail -5 "$WORK/merge1.out" | tr '\n' '|')"

echo "== 2: the acceptance ticket is held by the tester =="
tick_until "$ACC" in_testing && ok "#$ACC delivered and sent to the tester" || fail "#$ACC status=$(st "$ACC")"
run_tick >/dev/null   # the tester lane: no verdict, held
run_tick >/dev/null
[ "$(st "$ACC")" = in_testing ] && ok "#$ACC is held in_testing for a person (no verdict)" || fail "#$ACC status=$(st "$ACC")"
wg ticket show "$ACC" 2>/dev/null | grep -q 'tester held' && ok "the hold is on the ticket's record" || fail "no 'tester held' note on #$ACC"

echo "== 3: the tokenless waiver is refused =="
for as in human admin; do
  OUT="$(GTOKEN="" gaffer wg ticket tester-pass "$ACC" --summary "I checked it" --as "$as" 2>&1)"; rc=$?
  [ "$rc" -ne 0 ] && grep -q 'ACTOR_NOT_PERMITTED' <<<"$OUT" && grep -q 'principal create' <<<"$OUT" \
    && ok "tokenless --as $as is refused and says how to make a principal" || fail "tokenless --as $as: rc=$rc $OUT"
done
[ "$(st "$ACC")" = in_testing ] && ok "nothing moved (#$ACC still in_testing)" || fail "#$ACC moved to $(st "$ACC")"

echo "== 4: the principal's waiver is accepted =="
OUT="$(GTOKEN="$TOKEN" gaffer wg ticket tester-pass "$ACC" --summary "criterion 1 holds in a real browser" 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "the waiver with the principal's token is recorded" || fail "principal waiver: rc=$rc $OUT"
[ "$(st "$ACC")" = in_review ] && ok "#$ACC is back in review" || fail "#$ACC status=$(st "$ACC")"
LABEL="$(wg ticket show "$ACC" 2>/dev/null | jget '(d.testerWaiver && d.testerWaiver.label) || ""')"
HEAD_ACC="$(head_of "$ACC")"
case "$LABEL" in "tester verdict waived by tom for criteria "*" on ${HEAD_ACC:0:12}: criterion 1 holds in a real browser (recorded without OS isolation)") ok "the ticket shows the waiver: $LABEL" ;; *) fail "waiver label: '$LABEL' (head ${HEAD_ACC:0:12})" ;; esac

echo "== 5: the agent review and the person's approval follow, and it lands =="
run_tick >/dev/null   # the single agent review of the waived commit
REVIEWS="$(wg ticket show "$ACC" 2>/dev/null | jget '(d.events||[]).filter(e => e.event_type === "ticket.lane_verdict" && /"lane":"agent-review"/.test(e.payload_json||"")).length')"
[ "${REVIEWS:-0}" = 1 ] && ok "one agent review of the waived commit" || fail "agent reviews of #$ACC: $REVIEWS"
approve "$ACC" >"$WORK/approve2.out" 2>&1 && ok "#$ACC approved by a person" || fail "approve #$ACC: $(tail -3 "$WORK/approve2.out")"
GTOKEN="" gaffer merge "$ACC" >"$WORK/merge2.out" 2>&1
[ "$(st "$ACC")" = done ] && ok "#$ACC landed (done)" || fail "#$ACC status=$(st "$ACC"): $(tail -5 "$WORK/merge2.out" | tr '\n' '|')"

echo "== 6: gaffer status and wg stats read 'accepted with 1 waiver' =="
LBL="$(wg stats --json 2>/dev/null | jget '((d.acceptance||{}).epics||[]).map(e => e.label).join(",")')"
[ "$LBL" = "accepted with 1 waiver" ] && ok "wg stats: the epic reads '$LBL'" || fail "wg stats label: '$LBL'"
STATUS="$(GTOKEN="" gaffer status 2>&1)"
grep -q 'Widgets: accepted with 1 waiver' <<<"$STATUS" && ok "gaffer status: 'Widgets: accepted with 1 waiver'" || fail "gaffer status: $(grep -A3 'builds (acceptance)' <<<"$STATUS" | tr '\n' '|')"
grep -q 'human verdicts: agents run without OS isolation' <<<"$STATUS" && ok "gaffer status warns that human verdicts are guarded by the safety hook only" || fail "no isolation warning in gaffer status"

echo "== 7: no agent process held the principal token =="
n_dumps="$(find "$WORK/envdumps" -name '*.env' | wc -l | tr -d ' ')"
[ "$n_dumps" -ge 4 ] && ok "the stub agents ran $n_dumps times (deliveries, tester, reviews)" || fail "only $n_dumps agent runs"
leaks="$(grep -l -F "$TOKEN" "$WORK"/envdumps/*.env 2>/dev/null | wc -l | tr -d ' ')"
[ "${leaks:-0}" = 0 ] && ok "the principal token reached none of them" || fail "the principal token reached $leaks agent process(es)"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "waiver-principal-e2e: all $PASS checks passed"
  exit 0
fi
echo "waiver-principal-e2e: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
