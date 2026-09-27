#!/usr/bin/env bash
# =====================================================================
# SECURITY SECOND OPINION — a second, independent reviewer agent lane.
# ---------------------------------------------------------------------
# After the primary reviewer APPROVEs, a HIGH-RISK ticket (or one whose diff
# touches a security-sensitive path) gets a second agent pass with the
# security-review lens. Its verdict combines conservatively:
#   A. primary APPROVE + security CHANGES → the ticket is reworked (→ ready) with the
#      security findings as the feedback; nothing ships.
#   B. primary APPROVE + security APPROVE → ships (merge → done) under full grants.
#   C. the qualifier: a medium-risk plain diff gets NO second pass; a delivery touching
#      an auth path qualifies and the live pass spawns the second reviewer — and even
#      when both agents approve, dispatch's observed-risk escalation still holds the
#      ticket for a human (the lane adds a check, never removes one).
#   D. GAFFER_SECURITY_REVIEW=0 → the lane is off even for risk=high.
# Real dispatch + real tick.sh; the stub `claude` tells the two reviewers apart by
# the "SECURITY REVIEWER" line in its prompt. Run: bash runner/test/security-review-lane.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }
for f in packages/dispatch/dist/cli/index.js packages/memory/dist/bin/memory.js packages/crew/dist/cli/index.js; do
  [ -f "$ROOT/$f" ] || { echo "SKIP: $f not built (run pnpm -r build)"; exit 0; }
done

PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/sec-review-lane.XXXXXX")"; WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/data" "$WORK/bin"

R="$WORK/repo"; mkdir -p "$R/src" "$R/test"
( cd "$R" && git init -q -b main
  printf '{ "name": "r", "version": "0.1.0", "private": true, "type": "module", "scripts": { "test": "node --test", "lint": "node -e 0" } }\n' > package.json
  printf 'export function addTask(l, t) { return [...l, { t }]; }\n' > src/tasks.js
  printf 'import test from "node:test"; import assert from "node:assert/strict";\nimport { addTask } from "../src/tasks.js";\ntest("adds", () => { assert.equal(addTask([], "a").length, 1); });\n' > test/tasks.test.js
  git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init )

# Stub worker. Delivery: commits a helper. Reviewer prompts: the primary always
# APPROVEs; the SECURITY reviewer answers per the mode file (approve | changes) and
# records every invocation so the test can count how often the lane ran.
SEC_MODE="$WORK/sec-mode"; echo approve > "$SEC_MODE"
SEC_LOG="$WORK/sec-calls.log"; : > "$SEC_LOG"
cat > "$WORK/bin/claude" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
prompt=""; prev=""
for a in "$@"; do [ "$prev" = "-p" ] && prompt="$a"; prev="$a"; done
case "$prompt" in
  *"SECURITY REVIEWER"*)
    echo "security" >> "__SEC_LOG__"
    if [ "$(cat "__SEC_MODE__")" = "changes" ]; then
      printf '{"type":"result","subtype":"success","is_error":false,"result":"Finding: src/tasks.js line 2 builds a shell command from the task title (injection). Fix: pass an argv array.\\nRECOMMEND CHANGES\\n{\\"verdict\\":\\"CHANGES\\"}","total_cost_usd":0.01,"num_turns":2}\n'
    else
      printf '{"type":"result","subtype":"success","is_error":false,"result":"No blocking finding.\\nRECOMMEND APPROVE\\n{\\"verdict\\":\\"APPROVE\\"}","total_cost_usd":0.01,"num_turns":2}\n'
    fi
    exit 0 ;;
  *"REVIEWER agent"*)
    echo "primary" >> "__SEC_LOG__"
    printf '{"type":"result","subtype":"success","is_error":false,"result":"RECOMMEND APPROVE\\n{\\"verdict\\":\\"APPROVE\\"}","total_cost_usd":0.01,"num_turns":2}\n'; exit 0 ;;
esac
if [ -e .git ] && [ -f package.json ]; then
  fn="helper${GAFFER_TICKET:-0}"
  # With the marker present the delivery ALSO touches an auth path (a security-sensitive file).
  [ -e "__TOUCH_AUTH__" ] && { mkdir -p src/auth; printf 'export const check = () => true;\n' > "src/auth/$fn.js"; }
  grep -q "$fn" src/tasks.js || { printf 'export function %s(l){return l;}\n' "$fn" >> src/tasks.js; git -c user.email=s@s -c user.name=s add -A >/dev/null; git -c user.email=s@s -c user.name=s commit -qm "feat: $fn" >/dev/null; }
  printf '{"type":"result","subtype":"success","is_error":false,"result":"done.\\n\\nSmallest-change note: modified src/tasks.js only.","total_cost_usd":0.02,"num_turns":3}\n'; exit 0
fi
printf '{"type":"result","subtype":"success","is_error":false,"result":"ok"}\n'
STUB
TOUCH_AUTH="$WORK/touch-auth"
sed -i.bak "s|__SEC_MODE__|$SEC_MODE|; s|__SEC_LOG__|$SEC_LOG|; s|__TOUCH_AUTH__|$TOUCH_AUTH|" "$WORK/bin/claude" && rm -f "$WORK/bin/claude.bak"; chmod +x "$WORK/bin/claude"

export GAFFER_DATA="$WORK/data" CLAUDE_BIN="$WORK/bin/claude" CLAUDE_FLAGS="" \
       GAFFER_TICK_TIMEOUT=60 GAFFER_MAX_TURNS=10 GAFFER_CARD_MODEL=stub GAFFER_PLAN_MODEL=stub GAFFER_IMPL_MODEL=stub \
       REVIEW_MODE=human DRY_RUN=0 GAFFER_MAINTENANCE=0
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
wg init >/dev/null 2>&1; lg init >/dev/null 2>&1
wg repo add -n repo --path "$R" --branch main --test "npm test" --lint "npm run lint" >/dev/null 2>&1

run_tick() { ( cd "$RUNNER_DIR" && bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep '^TICK_RESULT=' ; }
st() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.status'; }
sec_calls() { local n; n="$(grep -c '^security$' "$SEC_LOG" 2>/dev/null)"; printf '%s' "${n:-0}"; }
review_tick() {
  rm -f "$GAFFER_DATA/.reviewed-tickets"
  ( cd "$RUNNER_DIR" && REVIEW_MODE=agent DISPATCH_ALLOW_AGENT_APPROVE=1 AUTO_MERGE=1 MERGE_ON_AGENT_REVIEW=1 GAFFER_STRICT_REQUIRE=0 \
      bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep '^TICK_RESULT='
}
new_ticket() { # $1 title, $2 risk
  local n
  n="$(wg ticket create -t "$1" -d "deliver a helper" --risk "$2" 2>/dev/null | jget 'd.ticket.number')"
  wg ac add "$n" -t "helper added" >/dev/null 2>&1
  wg ticket repo-access set "$n" repo --access write --relation confirmed >/dev/null 2>&1
  wg ticket ready "$n" >/dev/null 2>&1
  printf '%s' "$n"
}

echo "== A. high-risk: security reviewer's CHANGES overrides the primary APPROVE =="
N1="$(new_ticket "Risky change" high)"
run_tick >/dev/null; [ "$(st "$N1")" = "in_review" ] && ok "A: #$N1 delivered → in_review" || fail "A: delivery failed, status=$(st "$N1")"
echo changes > "$SEC_MODE"; : > "$SEC_LOG"
OUTA="$(review_tick)"
echo "$OUTA" | grep -q '^TICK_RESULT=reviewed$' && ok "A: review pass ran" || fail "A: tick result $OUTA"
[ "$(sec_calls)" = "1" ] && ok "A: the security reviewer ran exactly once" || fail "A: security reviewer calls = $(sec_calls)"
grep -q "SECURITY-REVIEW: #$N1 qualifies.*risk=high" "$GAFFER_DATA/factory.log" && ok "A: qualified on risk=high" || fail "A: no qualify log: $(grep SECURITY "$GAFFER_DATA/factory.log" | tail -2 | tr '\n' '|')"
grep -q "SECURITY-REVIEW: #$N1 security reviewer found a defect" "$GAFFER_DATA/factory.log" && ok "A: CHANGES logged as overriding the primary approve" || fail "A: no override log"
[ "$(st "$N1")" = "ready" ] && ok "A: #$N1 reworked → ready (not shipped)" || fail "A: #$N1 is '$(st "$N1")'"
grep -q "CHANGES; re-queued" "$GAFFER_DATA/factory.log" && ok "A: re-queued for rework with feedback (the security findings)" || fail "A: no rework log line"

echo "== B. high-risk: both reviewers APPROVE → ships =="
run_tick >/dev/null; [ "$(st "$N1")" = "in_review" ] && ok "B: #$N1 re-delivered → in_review" || fail "B: re-delivery failed, status=$(st "$N1")"
echo approve > "$SEC_MODE"; : > "$SEC_LOG"
OUTB="$(review_tick)"
echo "$OUTB" | grep -q '^TICK_RESULT=reviewed$' && ok "B: review pass ran" || fail "B: tick result $OUTB"
[ "$(sec_calls)" = "1" ] && ok "B: the security reviewer ran once" || fail "B: security reviewer calls = $(sec_calls)"
grep -q "SECURITY-REVIEW: #$N1 security reviewer concurs" "$GAFFER_DATA/factory.log" && ok "B: concurrence logged" || fail "B: no concurrence log"
[ "$(st "$N1")" = "done" ] && ok "B: #$N1 merged and done" || fail "B: #$N1 is '$(st "$N1")'"

echo "== C. the qualifier: medium risk + no sensitive path → no second pass; a diff touching an auth path → yes =="
# A plain throwaway branch (helper only) against a medium-risk ticket: does not qualify.
( cd "$R" && git checkout -q -b plain-probe && printf 'export const p = 1;\n' > src/plain.js && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm probe && git checkout -q main ) 2>/dev/null
N2="$(new_ticket "Auth-adjacent change" medium)"
if gaffer_needs_security_review "$N2" "$R" main plain-probe; then fail "C: a medium-risk plain diff qualified ($GAFFER_SECURITY_REVIEW_REASON)"; else ok "C: medium risk + no sensitive path → no security pass"; fi
# The real delivery of #N2 touches src/auth/ → qualifies on the path, and the live pass spawns the second reviewer.
touch "$TOUCH_AUTH"
run_tick >/dev/null; rm -f "$TOUCH_AUTH"
[ "$(st "$N2")" = "in_review" ] && ok "C: #$N2 delivered → in_review" || fail "C: delivery failed, status=$(st "$N2")"
B2="$(git -C "$R" branch --list "gaffer/ticket-$N2-*" | tr -d ' *' | head -1)"
if gaffer_needs_security_review "$N2" "$R" main "$B2"; then ok "C: the auth-touching diff qualifies ($GAFFER_SECURITY_REVIEW_REASON)"; else fail "C: sensitive path not detected on $B2"; fi
printf '%s' "$GAFFER_SECURITY_REVIEW_REASON" | grep -q "sensitive-path: src/auth" && ok "C: reason names the sensitive path" || fail "C: reason '$GAFFER_SECURITY_REVIEW_REASON'"
: > "$SEC_LOG"; review_tick >/dev/null
[ "$(sec_calls)" = "1" ] && ok "C: the live review pass spawned the security reviewer for the auth-touching diff" || fail "C: security reviewer calls = $(sec_calls)"
# Defence in depth: both agents approved, but dispatch OBSERVES the sensitive path as
# high risk against the declared medium and holds the auto-approve for a human
# (OBSERVED_RISK_ESCALATED). The lane never overrides the server's own gate.
[ "$(st "$N2")" = "in_review" ] && grep -q "OBSERVED_RISK_ESCALATED" "$GAFFER_DATA/factory.log" \
  && ok "C: dispatch still holds the auth-touching diff for a human (observed risk high > declared medium) — the lane adds a check, never removes one" \
  || fail "C: #$N2 is '$(st "$N2")' — $(grep "#$N2" "$GAFFER_DATA/factory.log" | tail -3 | tr '\n' '|' | cut -c1-400)"

echo "== D. GAFFER_SECURITY_REVIEW=0 disables the lane even for risk=high =="
N3="$(wg ticket create -t "Risky, lane off" -d "x" --risk high 2>/dev/null | jget 'd.ticket.number')"
if GAFFER_SECURITY_REVIEW=0 gaffer_needs_security_review "$N3" "$R" main main; then fail "D: lane off still qualified"; else ok "D: GAFFER_SECURITY_REVIEW=0 → does not qualify"; fi
if GAFFER_SECURITY_REVIEW=1 gaffer_needs_security_review "$N3" "$R" main main; then ok "D: lane on → risk=high qualifies ($GAFFER_SECURITY_REVIEW_REASON)"; else fail "D: risk=high did not qualify with the lane on"; fi

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
