#!/usr/bin/env bash
# =====================================================================
# The LAST allowed attempt's failure is on the rework trail.
# ---------------------------------------------------------------------
# tick.sh files each failed attempt on the ticket's rework trail (`wg runner-rework`,
# trail attempt N+1 = the failure of attempt N), but the attempt that used up the cap
# parked the ticket without a trail entry. The ticket page then said "Attempt 3/3 not
# taken" for an attempt that was tried, or listed its run as "No failure recorded".
# Proves, with a real tick.sh delivery and a node stub agent:
#   1. DoD red on every attempt (cap 2): the trail has BOTH failures; the last one is
#      the definition-of-done failure of attempt 2 (trail attempt 3, max 2), recorded
#      before the park. The ticket is parked blocked with rework_exhausted, and the
#      final entry raises no "reworking" event (the ticket is not being reworked).
#   2. The final attempt fails before its agent is launched (the retry's
#      agent-env-install fails closed): the last trail entry is that agent-env-install
#      failure, and the agent ran once.
# Run: bash runner/test/rework-final-trail.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_SRC="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_SRC/.." && pwd)"
DISPATCH_CLI="$ROOT/packages/dispatch/dist/cli/index.js"
MEMORY_CLI="$ROOT/packages/memory/dist/bin/memory.js"
# shellcheck source=lib/skip.sh
. "$HERE/lib/skip.sh"

PASS=0
FAILS=()
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILS+=("$1"); printf '  FAIL %s\n' "$1"; }

command -v git >/dev/null 2>&1 || gaffer_skip "git required"
node --input-type=commonjs -e "require('node:sqlite')" 2>/dev/null || gaffer_skip "node:sqlite requires Node >= 22.5"
[ -f "$DISPATCH_CLI" ] || gaffer_skip "dispatch CLI not built ($DISPATCH_CLI)"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/rework-final.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT

# A private copy of the runner (case 2's stub breaks its safety-hook deny-list), next
# to links to the real packages so GAFFER_HOME resolves the built CLIs.
mkdir -p "$WORK/root"
cp -R "$RUNNER_SRC" "$WORK/root/runner"
ln -s "$ROOT/packages" "$WORK/root/packages"
[ -d "$ROOT/node_modules" ] && ln -s "$ROOT/node_modules" "$WORK/root/node_modules"
[ -f "$ROOT/package.json" ] && ln -s "$ROOT/package.json" "$WORK/root/package.json"
RUNNER_DIR="$WORK/root/runner"

q() { # q <sql> <args…> → JSON rows from the case's dispatch DB
  node -e '
const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.env.DISPATCH_DB,{readOnly:true});
process.stdout.write(JSON.stringify(db.prepare(process.argv[1]).all(...process.argv.slice(2))));' "$@" 2>/dev/null
}
js() { node -e "const r=JSON.parse(process.argv[1]);process.exit(($2)?0:1)" "$1"; }

# run_case <name> <mode: dod|env> → runs one tick.sh delivery with GAFFER_MAX_DELIVERY_ATTEMPTS=2
run_case() {
  local name="$1" mode="$2" C="$WORK/$1"
  mkdir -p "$C/bin" "$C/widget/test"
  local REPO="$C/widget"
  printf '{"name":"widget","version":"1.0.0","private":true,"scripts":{"test":"node --test"}}\n' >"$REPO/package.json"
  printf 'const t=require("node:test");const a=require("node:assert");t.test("baseline",()=>{a.equal(1+1,2);});\n' >"$REPO/test/base.test.js"
  git -C "$REPO" init -q -b main
  git -C "$REPO" -c user.email=t@e -c user.name=t -c commit.gpgsign=false add -A
  git -C "$REPO" -c user.email=t@e -c user.name=t -c commit.gpgsign=false commit -qm init
  export GAFFER_DATA="$C/data"; mkdir -p "$GAFFER_DATA"
  export DISPATCH_DB="$GAFFER_DATA/dispatch.sqlite" MEMORY_DB="$GAFFER_DATA/memory.sqlite"
  node "$DISPATCH_CLI" --db "$DISPATCH_DB" init >/dev/null
  [ -f "$MEMORY_CLI" ] && node "$MEMORY_CLI" init >/dev/null 2>&1
  node "$DISPATCH_CLI" --db "$DISPATCH_DB" repo add -n widget --path "$REPO" --branch main --stack node --test "node --test" >/dev/null
  TID="$(node "$DISPATCH_CLI" --db "$DISPATCH_DB" ticket create -t "Add DELIVERED marker" -d "Add DELIVERED.txt." --risk low 2>/dev/null |
    node -e 'let r="";process.stdin.on("data",c=>r+=c);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(r).ticket.id)}catch{}})')"
  [ -n "$TID" ] || { fail "$name: could not create a ticket"; return 1; }
  node -e '
const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.env.DISPATCH_DB);
const rid=db.prepare("select id from repositories where name=?").get("widget").id;
db.prepare("insert into ticket_repos(ticket_id,repo_id,role,access,relation,source) values(?,?,?,?,?,?)").run(process.argv[1],rid,"primary","write","confirmed","manual");
db.prepare("insert into acceptance_criteria(id,ticket_id,text,sort_order) values(?,?,?,0)").run("ac-1",process.argv[1],"DELIVERED.txt exists");
' "$TID"
  node "$DISPATCH_CLI" --db "$DISPATCH_DB" ticket ready "$TID" >/dev/null 2>&1
  CALLS="$C/calls"; printf '0' >"$CALLS"
  # Every attempt commits a red test. In env mode the first call also removes the
  # runner copy's deny-list, so the retry's agent-env-install fails closed.
  cat >"$C/bin/claude" <<JS
#!/usr/bin/env node
const fs = require("fs"), cp = require("child_process");
if (process.argv[2] === "--version") { console.log("9.8.7 (Claude Code)"); process.exit(0); }
const n = Number(fs.readFileSync("$CALLS", "utf8")) + 1; fs.writeFileSync("$CALLS", String(n));
fs.writeFileSync("DELIVERED.txt", "delivered " + n + "\n");
fs.writeFileSync("test/red.test.js", 'const t=require("node:test");const a=require("node:assert");t.test("red",()=>{a.equal(1,2);});\n');
if ("$mode" === "env" && n === 1) fs.rmSync("$RUNNER_DIR/lib/dangerous-commands.mjs");
cp.execSync('git add -A && git -c user.email=f@a -c user.name=f -c commit.gpgsign=false commit -qm "deliver attempt ' + n + '"');
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1,
  result: "done", stop_reason: "end_turn", total_cost_usd: 0.01,
  modelUsage: { "stub-served": { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 } } }));
JS
  chmod +x "$C/bin/claude"
  CLAUDE_BIN="$C/bin/claude" GAFFER_IMPL_MODEL=stub GAFFER_PLAN_MODEL=none GAFFER_MAX_DELIVERY_ATTEMPTS=2 \
    DRY_RUN=0 GAFFER_ALLOW_UNCAPPED=1 GAFFER_TICK_TIMEOUT=120 GAFFER_DOD_INSTALL=0 \
    bash "$RUNNER_DIR/tick.sh" >"$C/tick.log" 2>&1 || true
  # restore the deny-list for the next case
  [ -f "$RUNNER_DIR/lib/dangerous-commands.mjs" ] || cp "$RUNNER_SRC/lib/dangerous-commands.mjs" "$RUNNER_DIR/lib/dangerous-commands.mjs"
}

echo "== 1: DoD red on the last allowed attempt =="
run_case dod dod
TRAIL="$(q "select attempt, max_attempts, gate, distilled_failure from rework_attempts where ticket_id=? order by created_at, rowid" "$TID")"
js "${TRAIL:-[]}" 'r.length===2' && ok "both failed attempts are on the trail" || fail "trail rows: ${TRAIL:-<none>}"
js "${TRAIL:-[]}" 'r.length>0&&r[r.length-1].attempt===3&&r[r.length-1].max_attempts===2&&r[r.length-1].gate==="definition-of-done"&&/red/.test(r[r.length-1].distilled_failure)' \
  && ok "the last entry is attempt 2's definition-of-done failure (trail attempt 3 of max 2, the failing test quoted)" \
  || fail "last trail entry: ${TRAIL:-<none>}"
T="$(q "select status, last_review_feedback from tickets where id=?" "$TID")"
js "${T:-[]}" 'r[0]&&r[0].status==="blocked"' && ok "the ticket is parked to blocked" || fail "ticket: ${T:-<none>}"
js "${T:-[]}" 'r[0]&&!/"code":"reworking"/.test(r[0].last_review_feedback||"")' \
  && ok "the card does not read 'reworking' after the park" || fail "feedback: ${T:-<none>}"
EV="$(q "select payload_json from work_events where entity_id=? and event_type='ticket.reworking'" "$TID")"
js "${EV:-[]}" 'r.length===1&&JSON.parse(r[0].payload_json).attempt===2' \
  && ok "only the real retry raised a 'reworking' event (none for the final failure)" || fail "reworking events: ${EV:-<none>}"
[ "$(cat "$WORK/dod/calls")" = 2 ] && ok "the agent ran on both attempts" || fail "agent calls: $(cat "$WORK/dod/calls")"
RUNS="$(q "select payload_json from evidence where ticket_id=? and evidence_type='log' and recorded_by_actor_type='system' and payload_json like '%agent_run%'" "$TID")"
js "${RUNS:-[]}" 'r.map(x=>JSON.parse(x.payload_json).attempt).join()==="1,2"' \
  && ok "agent-run evidence for attempts 1 and 2 (the page pairs the final failure with run 2)" || fail "agent runs: ${RUNS:-<none>}"

echo "== 2: the last allowed attempt fails before its agent is launched =="
run_case env env
TRAIL="$(q "select attempt, max_attempts, gate from rework_attempts where ticket_id=? order by created_at, rowid" "$TID")"
js "${TRAIL:-[]}" 'r.length===2&&r[0].gate==="definition-of-done"&&r[1].gate==="agent-env-install"&&r[1].attempt===3' \
  && ok "the last entry is attempt 2's agent-env-install failure (trail attempt 3)" || fail "trail rows: ${TRAIL:-<none>}"
[ "$(cat "$WORK/env/calls")" = 1 ] && ok "the agent was not launched for attempt 2" || fail "agent calls: $(cat "$WORK/env/calls")"
T="$(q "select status from tickets where id=?" "$TID")"
js "${T:-[]}" 'r[0]&&r[0].status==="blocked"' && ok "the ticket is parked to blocked" || fail "ticket: ${T:-<none>}"

echo
if [ "${#FAILS[@]}" -eq 0 ]; then echo "rework-final-trail: all $PASS passed"; exit 0; fi
echo "rework-final-trail: ${#FAILS[@]} FAILED (of $((PASS + ${#FAILS[@]})))"
for f in "${FAILS[@]}"; do echo "  - $f"; done
for c in dod env; do echo "--- $c tick.log tail ---"; tail -15 "$WORK/$c/tick.log" 2>/dev/null; done
exit 1
