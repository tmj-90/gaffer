#!/usr/bin/env bash
# =====================================================================
# REWORK COST, LIVE — a reviewer's send-back counts as rework, and the correction's
# spend is charged to it. Third external review, MEDIUM rework costs: a $1 first
# attempt, a reviewer sending the ticket back, then a $3 correction read as $4 total
# and one shipped ticket but $0 rework and 0% sent back — review rejections and the
# runner's internal retries are recorded separately and the report counted only the
# latter. Proven against the REAL tick.sh, dispatch CLI and dispatch API with a stub
# delivery agent that reports $1 and then $3:
#   • every delivery ledger row carries its attempt (a claim hash + attempt number,
#     never the claim token) and its spawn time;
#   • GET /api/health: total $4, one shipped, rework $3 (75% of spend), the ticket
#     listed with one review send-back and one rework attempt;
#   • the referee's rework rate reads 1 of 1 merged tickets sent back.
# Run: bash runner/test/rework-cost-live.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
CLI_JS="$ROOT/packages/dispatch/dist/cli/index.js"
API_JS="$ROOT/packages/dispatch/dist/api/bin.js"
[ -f "$CLI_JS" ] && [ -f "$API_JS" ] || { echo "SKIP: dispatch not built"; exit 0; }
[ -f "$ROOT/packages/crew/dist/runtime/context/renderPromptCli.js" ] || { echo "SKIP: crew not built"; exit 0; }
command -v curl >/dev/null 2>&1 || { echo "SKIP: curl required"; exit 0; }

PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/rework-cost.XXXXXX")"; WORK="$(cd "$WORK" && pwd -P)"
API_PID=""
cleanup(){ [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null; [ "${KEEP:-0}" = 1 ] || rm -rf "$WORK"; }
trap cleanup EXIT
mkdir -p "$WORK/data" "$WORK/bin"

R="$WORK/repo"; mkdir -p "$R/src" "$R/test"
( cd "$R" && git init -q -b main
  printf '{ "name": "r", "version": "0.1.0", "private": true, "type": "module", "scripts": { "test": "node --test", "lint": "node -e 0" } }\n' > package.json
  printf 'export function a() { return 1; }\n' > src/a.js
  printf 'import test from "node:test"; import assert from "node:assert/strict";\nimport { a } from "../src/a.js";\ntest("a", () => { assert.equal(a(), 1); });\n' > test/a.test.js
  git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init )

# Stub delivery agent: each delivery commits one more line and reports $1, then $3.
cat > "$WORK/bin/claude" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
N_FILE="__WORK__/deliveries"
if [ -e .git ]; then
  n="$(cat "$N_FILE" 2>/dev/null || echo 0)"; n=$((n + 1)); echo "$n" > "$N_FILE"
  cost=1; [ "$n" -ge 2 ] && cost=3
  printf 'export const v%s = %s;\n' "$n" "$n" >> src/a.js
  git -c user.email=s@s -c user.name=s add -A >/dev/null; git -c user.email=s@s -c user.name=s commit -qm "feat: attempt $n" >/dev/null 2>&1 || true
  printf '{"type":"result","subtype":"success","is_error":false,"result":"done.\\n\\nSmallest-change note: one line.","total_cost_usd":%s,"num_turns":2,"duration_ms":1500,"modelUsage":{"stub-model":{"inputTokens":10,"outputTokens":5,"cacheReadInputTokens":0,"cacheCreationInputTokens":0,"costUSD":%s}}}\n' "$cost" "$cost"; exit 0
fi
printf '{"type":"result","subtype":"success","is_error":false,"result":"ok"}\n'
STUB
sed -i.bak "s|__WORK__|$WORK|" "$WORK/bin/claude" && rm -f "$WORK/bin/claude.bak"; chmod +x "$WORK/bin/claude"

export GAFFER_DATA="$WORK/data" CLAUDE_BIN="$WORK/bin/claude" CLAUDE_FLAGS="" \
       GAFFER_MAX_TURNS=3 GAFFER_TICK_TIMEOUT=60 GAFFER_CARD_MODEL=stub GAFFER_PLAN_MODEL=stub GAFFER_IMPL_MODEL=stub \
       REVIEW_MODE=human DRY_RUN=0 GAFFER_MAINTENANCE=0 GAFFER_STRICT_REQUIRE=0 GAFFER_SECURITY_REVIEW=0 GAFFER_TESTING=0 \
       MAX_OPEN_AGENT_BRANCHES_PER_REPO=10 MAX_IN_REVIEW_PER_REPO=10
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
wg init >/dev/null 2>&1; lg init >/dev/null 2>&1
wg repo add -n repo --path "$R" --branch main --stack node --test "npm test" --lint "npm run lint" >/dev/null 2>&1
LEDGER="$GAFFER_USAGE_LEDGER"

run_tick() { ( cd "$RUNNER_DIR" && bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep '^TICK_RESULT=' ; }
st() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.status'; }
approve_heads() { wg ticket diff "$1" --heads 2>/dev/null | sed 's/^/--commit /' | tr '\n' ' '; }

echo "== deliver, send back, correct, approve, merge =="
T="$(wg ticket create -t "Export header row" -d "the CSV export writes a header row" --risk low 2>/dev/null | jget 'd.ticket.number')"
wg ac add "$T" -t "header row present" >/dev/null 2>&1
wg ticket repo-access set "$T" repo --access write --relation confirmed >/dev/null 2>&1
wg ticket ready "$T" >/dev/null 2>&1
AUTO_MERGE=0 run_tick >/dev/null
[ "$(st "$T")" = "in_review" ] && ok "#$T first attempt → in_review" || fail "first attempt: status=$(st "$T")"
wg review reject "$T" --to ready --reason "the export drops the header row" --reviewer human1 >/dev/null 2>&1
[ "$(st "$T")" = "ready" ] && ok "#$T sent back by the reviewer → ready" || fail "send-back: status=$(st "$T")"
AUTO_MERGE=0 run_tick >/dev/null
[ "$(st "$T")" = "in_review" ] && ok "#$T correction → in_review" || fail "correction: status=$(st "$T")"
# Approval names the reviewed commit (a stale or unnamed revision is refused).
wg review approve "$T" $(approve_heads "$T") --reviewer human1 >/dev/null 2>&1
GAFFER_MODE=autonomous AUTO_MERGE=1 DISPATCH_ALLOW_AGENT_APPROVE=1 MERGE_ON_AGENT_REVIEW=1 run_tick >/dev/null
[ "$(st "$T")" = "done" ] && ok "#$T merged → done" || fail "merge: status=$(st "$T")"

echo "== the ledger knows which attempt each dollar paid for =="
ROWS="$(node -e '
  const rows = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").map(JSON.parse)
    .filter((r) => r.kind === "delivery");
  console.log(JSON.stringify(rows.map((r) => ({ cost: r.total_cost_usd, attempt: r.attempt_id ?? null, started: r.started_at ?? null }))));
' "$LEDGER" 2>/dev/null)"
node -e '
  const rows = JSON.parse(process.argv[1]);
  const ok = rows.length === 2 && rows[0].cost === 1 && rows[1].cost === 3
    && rows.every((r) => /^c[0-9a-f]{12}\/1$/.test(r.attempt || "") && !Number.isNaN(Date.parse(r.started || "")))
    && rows[0].attempt !== rows[1].attempt;
  process.exit(ok ? 0 : 1);
' "$ROWS" && ok "two delivery rows (\$1, \$3), each with its own attempt id and spawn time" \
  || fail "delivery rows lack attempt identity: $ROWS"
CLAIM_TOKENS="$(node -e '
  const D = require(process.argv[1]); const db = new D(process.argv[2], { readonly: true });
  console.log(db.prepare("SELECT COUNT(*) AS n FROM ticket_claims").get().n);' \
  "$ROOT/packages/dispatch/node_modules/better-sqlite3" "$DISPATCH_DB" 2>/dev/null)"
[ "${CLAIM_TOKENS:-0}" -ge 2 ] && ok "two claims were taken (one per attempt)" || fail "claims: $CLAIM_TOKENS"
case "$(cat "$LEDGER")" in *claim_token*|*"\"token\""*) fail "a ledger row carries claim-token material" ;; *) ok "no claim token in the ledger" ;; esac

echo "== GET /api/health =="
PORT="$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
TOK="rework-cost-test-token-0123456789"
DISPATCH_API_TOKEN="$TOK" GAFFER_USAGE_LEDGER="$LEDGER" node "$API_JS" --db "$DISPATCH_DB" --port "$PORT" >"$WORK/api.log" 2>&1 &
API_PID=$!
curl -s --retry 30 --retry-connrefused --retry-delay 1 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1
curl -s -H "Authorization: Bearer $TOK" "http://127.0.0.1:$PORT/api/health" > "$WORK/health.json"
check(){ node -e "const h=JSON.parse(require('fs').readFileSync('$WORK/health.json','utf8')); process.exit(($1) ? 0 : 1)" 2>/dev/null; }
check 'h.total_usd === 4 && h.shipped_count === 1' && ok "total \$4, one shipped" || fail "totals: $(head -c 300 "$WORK/health.json")"
check 'h.rework.total_rework_cost_usd === 3 && h.rework.rework_cost_share_pct === 75' \
  && ok "rework \$3 (75% of spend): the correction's spend" || fail "rework: $(node -e "console.log(JSON.stringify(JSON.parse(require('fs').readFileSync('$WORK/health.json','utf8')).rework))")"
check "h.rework.by_ticket.length === 1 && h.rework.by_ticket[0].ticket === $T && h.rework.by_ticket[0].review_send_backs === 1 && h.rework.by_ticket[0].rework_attempts === 1 && h.rework.by_ticket[0].basis === 'attempt'" \
  && ok "#$T listed: one review send-back, one rework attempt, measured by attempt" || fail "by_ticket wrong"
check 'h.governance.reworkRate.numerator === 1 && h.governance.reworkRate.denominator === 1' \
  && ok "rework rate: 1 of 1 merged tickets sent back" || fail "rework rate: $(node -e "console.log(JSON.stringify(JSON.parse(require('fs').readFileSync('$WORK/health.json','utf8')).governance.reworkRate))")"

echo
echo "rework-cost-live: $PASS passed, ${#FAILURES[@]} failed"
[ "${#FAILURES[@]}" -eq 0 ]
