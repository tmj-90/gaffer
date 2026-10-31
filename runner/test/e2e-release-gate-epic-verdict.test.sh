#!/usr/bin/env bash
# =====================================================================
# RELEASE GATE 1 — a generated epic reaches an independent verdict, and the tester
# checks what was agreed while planning.
# ---------------------------------------------------------------------
# Operator promise: confirm a plan, and the build is judged by the independent tester
# against the brief AND every requirement agreed while the planner asked its questions.
# Two ways it broke (external review 2):
#   • the factory-generated acceptance ticket rejected itself: its description says the
#     tester works "never from the diff", the tester's packet check scanned the whole
#     ticket for "diff", and an unedited epic stopped at in_testing before the tester ran;
#   • a clarification answer (a 30-minute expiry) the proposed tickets omitted was lost:
#     confirmation kept only the brief, so the tester never heard of it.
#
# Real dispatch (its HTTP API: the plan-sessions + epics endpoints) + tick.sh + the live
# tester lane (bin/tester-run.mjs --live), a stub claude, a fixture repo:
#   1  a canned plan session (brief → planner question → "Links expire after 30 minutes"
#      → a plan whose ticket omits expiry) is confirmed unedited through POST /epics;
#   2  the generated acceptance ticket carries the agreed requirement as a criterion;
#   3  the implementation ticket is delivered, approved by a human and landed; the
#      acceptance ticket is delivered and approved → in_testing;
#   4  the independent tester LAUNCHES on it (the packet check does not refuse it),
#      receives the agreed 30-minute requirement in its prompt, and its verdict is
#      recorded: PASS → ready_for_merge, bound to the tested commit.
# Run: bash runner/test/e2e-release-gate-epic-verdict.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
API_BIN="$ROOT/packages/dispatch/dist/api/bin.js"
[ -f "$API_BIN" ] || { echo "SKIP: dispatch not built"; exit 0; }
[ -f "$ROOT/packages/crew/dist/runtime/context/renderPromptCli.js" ] || { echo "SKIP: crew not built"; exit 0; }
command -v curl >/dev/null 2>&1 || { echo "SKIP: curl required"; exit 0; }
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/rg-epic-verdict.XXXXXX")"; WORK="$(cd "$WORK" && pwd -P)"
API_PID=""
cleanup() { [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null; [ "${KEEP:-0}" = 1 ] || rm -rf "$WORK"; }
trap cleanup EXIT
mkdir -p "$WORK/data" "$WORK/bin" "$WORK/prompts"
R="$WORK/repo"; mkdir -p "$R/src" "$R/test"
( cd "$R" && git init -q -b main
  printf '{ "name": "links", "version": "0.1.0", "private": true, "type": "module", "scripts": { "test": "node --test", "lint": "node -e 0" } }\n' > package.json
  printf 'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("boots", () => { assert.ok(true); });\n' > test/boot.test.js
  git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init )

# Stub agent. TESTER turn (an independent tester prompt): keep the prompt, write one
# black-box test, answer PASS. DELIVERY turn: the shortener (implementation ticket) or
# the acceptance suite (acceptance ticket), committed.
cat > "$WORK/bin/claude" <<'STUB'
#!/usr/bin/env bash
prompt=""; prev=""; for a in "$@"; do [ "$prev" = "-p" ] && prompt="$a"; prev="$a"; done
P="__PROMPTS__"
case "$prompt" in
  *"INDEPENDENT TESTER"*)
    printf '%s' "$prompt" > "$P/tester.txt"
    mkdir -p test
    printf 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { shorten, resolve } from "../src/links.js";\ntest("a link expires after 30 minutes", () => {\n  const code = shorten("https://x.test", 0);\n  assert.equal(resolve(code, 29 * 60 * 1000), "https://x.test");\n  assert.equal(resolve(code, 31 * 60 * 1000), null);\n});\n' > test/bb-expiry.test.js
    printf '{"type":"result","subtype":"success","is_error":false,"result":"Wrote a black-box test for every criterion; npm test passes.\\n\\n{\\"verdict\\":\\"PASS\\"}","total_cost_usd":0.01,"num_turns":3}\n'; exit 0 ;;
esac
if [ -e .git ]; then
  case "$prompt" in
    *"ACCEPTANCE TICKET"*)
      printf '%s' "$prompt" > "$P/acceptance-delivery.txt"
      printf 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { shorten, resolve } from "../src/links.js";\ntest("acceptance: shorten then resolve", () => { assert.equal(resolve(shorten("https://a.test", 0), 1000), "https://a.test"); });\n' > test/acceptance.test.js ;;
    *)
      mkdir -p src
      printf 'const links = new Map();\nlet n = 0;\nconst TTL = 30 * 60 * 1000;\nexport function shorten(url, now = Date.now()) { const code = String(++n); links.set(code, { url, at: now }); return code; }\nexport function resolve(code, now = Date.now()) { const l = links.get(code); return l && now - l.at <= TTL ? l.url : null; }\n' > src/links.js
      printf 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { shorten, resolve } from "../src/links.js";\ntest("shorten", () => { assert.equal(resolve(shorten("https://b.test", 0), 0), "https://b.test"); });\n' > test/links.test.js ;;
  esac
  git -c user.email=s@s -c user.name=s add -A >/dev/null; git -c user.email=s@s -c user.name=s commit -qm "feat: delivery" >/dev/null 2>&1 || true
  printf '{"type":"result","subtype":"success","is_error":false,"result":"done.\\n\\nSmallest-change note: the smallest change.","total_cost_usd":0.01,"num_turns":1}\n'; exit 0
fi
printf '{"type":"result","subtype":"success","is_error":false,"result":"ok"}\n'
STUB
sed -i.bak "s|__PROMPTS__|$WORK/prompts|" "$WORK/bin/claude" && rm -f "$WORK/bin/claude.bak"; chmod +x "$WORK/bin/claude"

export GAFFER_DATA="$WORK/data" CLAUDE_BIN="$WORK/bin/claude" CLAUDE_FLAGS="" \
       GAFFER_MAX_TURNS=3 GAFFER_TICK_TIMEOUT=60 GAFFER_CARD_MODEL=stub GAFFER_PLAN_MODEL=stub GAFFER_IMPL_MODEL=stub \
       REVIEW_MODE=human DRY_RUN=0 GAFFER_MAINTENANCE=0 GAFFER_STRICT_REQUIRE=0 GAFFER_SECURITY_REVIEW=0 GAFFER_TESTING=0 \
       MAX_OPEN_AGENT_BRANCHES_PER_REPO=10 MAX_IN_REVIEW_PER_REPO=10 GAFFER_DIGEST_DISABLE=1
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
wg init >/dev/null 2>&1; lg init >/dev/null 2>&1
wg repo add -n links --path "$R" --branch main --stack node --test "npm test" --lint "npm run lint" >/dev/null 2>&1

# The real dispatch HTTP API (the dashboard's), on a free port, with a known token.
PORT="$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();})')"
TOKEN="rg-epic-$$"
DISPATCH_API_TOKEN="$TOKEN" node "$API_BIN" --db "$DISPATCH_DB" --port "$PORT" >"$WORK/api.log" 2>&1 &
API_PID=$!
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; perl -e 'select(undef,undef,undef,0.2)'; done
api() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' ${3:+--data "$3"} "http://127.0.0.1:$PORT$2"; }

QUESTION="How long should a shortened link stay valid?"
ANSWER="Links expire after 30 minutes"
PLAN='{"epic":{"name":"Shortener","description":"A link shortener"},"tickets":[{"title":"Shorten and resolve links","description":"shorten(url) returns a code; resolve(code) returns the url","acceptanceCriteria":["shorten returns a code","resolve returns the original url"],"dependsOn":[],"repo":"links","access":"write"}]}'

echo "== 1: a canned plan session, confirmed unedited =="
SID="$(api POST /plan-sessions | jget 'd.session.id')"
[ -n "$SID" ] && ok "plan session created through the API ($SID)" || fail "no plan session: $(tail -3 "$WORK/api.log")"
api POST "/plan-sessions/$SID/turns" '{"role":"user","content":"a link shortener","brief":"a link shortener"}' >/dev/null
api POST "/plan-sessions/$SID/turns" "$(node -e 'console.log(JSON.stringify({role:"assistant",content:JSON.stringify({phase:"clarify",questions:[process.argv[1]]})}))' "$QUESTION")" >/dev/null
api POST "/plan-sessions/$SID/turns" "{\"role\":\"user\",\"content\":\"$ANSWER\"}" >/dev/null
api POST "/plan-sessions/$SID/turns" "$(node -e 'const p=JSON.parse(process.argv[1]);console.log(JSON.stringify({role:"assistant",content:JSON.stringify({phase:"plan",plan:p}),plan:p}))' "$PLAN")" >/dev/null
BODY="$(node -e 'const p=JSON.parse(process.argv[1]);p.epic.brief="a link shortener";p.plan_session_id=process.argv[2];console.log(JSON.stringify(p))' "$PLAN" "$SID")"
EPIC="$(api POST /epics "$BODY")"
IMPL="$(printf '%s' "$EPIC" | jget 'd.ticket_numbers[0]')"
ACC="$(printf '%s' "$EPIC" | jget '(d.ticket_numbers || []).slice(-1)[0]')"
[ -n "$IMPL" ] && [ -n "$ACC" ] && [ "$IMPL" != "$ACC" ] && ok "epic confirmed: implementation #$IMPL + acceptance #$ACC" || fail "POST /epics: $EPIC"

echo "== 2: the acceptance contract carries the agreed requirement =="
ACS="$(wg ticket show "$ACC" | jget '(d.acceptanceCriteria || []).map(a => a.text).join("\n")')"
case "$ACS" in *"Agreed during planning: $ANSWER"*) ok "acceptance #$ACC has the criterion 'Agreed during planning: $ANSWER'" ;; *) fail "acceptance criteria lack the agreed requirement: ${ACS:0:400}" ;; esac
case "$(wg ticket show "$IMPL" | jget '(d.acceptanceCriteria || []).map(a => a.text).join("|")')" in *30*) fail "fixture: the plan's ticket already mentions the expiry" ;; *) ok "the planner's own ticket omits the expiry (the requirement lives on the acceptance only)" ;; esac
DESC="$(wg ticket show "$ACC" | jget 'd.ticket.description')"
case "$DESC" in *"never from the diff"*) ok "the generated description is unedited (it still says the tester works 'never from the diff')" ;; *) fail "fixture: generated description changed" ;; esac
wg ticket ready "$IMPL" >/dev/null 2>&1; wg ticket ready "$ACC" >/dev/null 2>&1

echo "== 3: deliver, approve and land the implementation; deliver and approve the acceptance =="
run_tick() { ( cd "$RUNNER_DIR" && bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep '^TICK_RESULT=' ; }
st() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.status'; }
AUTO_MERGE=0 run_tick >/dev/null
[ "$(st "$IMPL")" = "in_review" ] && ok "#$IMPL delivered through its gates" || fail "#$IMPL status=$(st "$IMPL")"
wg review approve "$IMPL" --reviewer human1 >/dev/null 2>&1
GAFFER_MODE=autonomous AUTO_MERGE=1 run_tick >/dev/null
[ "$(st "$IMPL")" = "done" ] && ok "#$IMPL landed (merge gate passed)" || fail "#$IMPL status=$(st "$IMPL") $(grep "#$IMPL" "$GAFFER_DATA/factory.log" | tail -2 | tr '\n' '|' | cut -c1-300)"
[ "$(st "$ACC")" = "in_review" ] || AUTO_MERGE=0 run_tick >/dev/null
[ "$(st "$ACC")" = "in_review" ] && ok "acceptance #$ACC delivered on the integrated main" || fail "acceptance status=$(st "$ACC") $(grep "#$ACC" "$GAFFER_DATA/factory.log" | tail -3 | tr '\n' '|' | cut -c1-400)"
[ -s "$WORK/prompts/acceptance-delivery.txt" ] && ok "the acceptance delivery agent got the acceptance block (it reads the criteria, the agreed one included, through get_ticket)" || fail "the acceptance delivery prompt lacks the acceptance block"
wg review approve "$ACC" --reviewer human1 >/dev/null 2>&1
[ "$(st "$ACC")" = "in_testing" ] && ok "approved acceptance → in_testing (acceptance always goes to the tester)" || fail "acceptance after approve: $(st "$ACC")"

echo "== 4: the independent tester launches, hears the agreed requirement, and records a verdict =="
AUTO_MERGE=0 run_tick >/dev/null
[ -s "$WORK/prompts/tester.txt" ] && ok "the tester LAUNCHED on the generated acceptance ticket (not refused before the worker)" || fail "the tester never ran: $(grep -i 'tester' "$GAFFER_DATA/factory.log" | tail -3 | tr '\n' '|' | cut -c1-400)"
grep -qF "$ANSWER" "$WORK/prompts/tester.txt" 2>/dev/null && ok "the tester's packet carries 'Agreed during planning: $ANSWER'" || fail "the tester's prompt lacks the agreed requirement"
grep -q "implementation pointer" "$GAFFER_DATA/factory.log" && fail "the packet check refused the ticket" || ok "no packet-check refusal in the factory log"
[ "$(st "$ACC")" = "ready_for_merge" ] && ok "verdict recorded: tester PASS → ready_for_merge" || fail "acceptance after the tester: $(st "$ACC") $(grep -i 'TESTER' "$GAFFER_DATA/factory.log" | tail -3 | tr '\n' '|' | cut -c1-400)"
TESTED="$(wg ticket show "$ACC" | jget '((d.evidence || []).filter(e => e.evidence_type === "test_output" && /"verdict":"pass"/.test(e.payload_json || "")).map(e => JSON.parse(e.payload_json).tested_commit).pop()) || ""')"
[ -n "$TESTED" ] && ok "the PASS is bound to the tested commit (${TESTED:0:12})" || fail "the PASS carries no tested commit"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "e2e-release-gate-epic-verdict: ALL $PASS checks passed"; exit 0; fi
echo "e2e-release-gate-epic-verdict: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1
