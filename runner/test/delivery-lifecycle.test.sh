#!/usr/bin/env bash
# =====================================================================
# Delivery lifecycle integration test — the RUNNER path, no live agent.
# ---------------------------------------------------------------------
# Drives ONE real `tick.sh` delivery against a temp git repo + real dispatch/
# memory DBs, with a FAKE `claude` on CLAUDE_BIN that makes a genuine committed
# change (like a real agent) and prints a `claude -p --output-format json`
# success envelope. Asserts the whole runner delivery machinery works end to end
# WITHOUT a live LLM or tokens:
#   claim → worktree → agent invoke → real diff → DoD gates → runner-owned submit
#   → ticket reaches `in_review` with a per-repo delivery artifact recorded.
#
# This is the deterministic, CI-runnable version of the manual "5-rules" live
# delivery: it catches wiring regressions in the delivery path (the class of bug
# a unit test on any single component would miss) without a 3-minute agent run.
# The crew impl loop already covers the same shape with MockAgentRuntime; this
# covers the runner (tick.sh) path, which had no end-to-end test.
#
# Requirements: bash, git, node >= 22.5 (node:sqlite), a BUILT workspace
# (packages/*/dist). Skips cleanly otherwise.
# Run: bash runner/test/delivery-lifecycle.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
DISPATCH_CLI="$ROOT/packages/dispatch/dist/cli/index.js"
MEMORY_CLI="$ROOT/packages/memory/dist/bin/memory.js"

PASS=0
FAILS=()
ok() {
  PASS=$((PASS + 1))
  printf '  ok   %s\n' "$1"
}
fail() {
  FAILS+=("$1")
  printf '  FAIL %s\n' "$1"
}

command -v git >/dev/null 2>&1 || {
  echo "SKIP: git required"
  exit 0
}
command -v node >/dev/null 2>&1 || {
  echo "SKIP: node required"
  exit 0
}
node --input-type=commonjs -e "require('node:sqlite')" 2>/dev/null || {
  echo "SKIP: node:sqlite requires Node >= 22.5"
  exit 0
}
[ -f "$DISPATCH_CLI" ] || {
  echo "SKIP: dispatch not built ($DISPATCH_CLI) — run pnpm -r build"
  exit 0
}
[ -f "$RUNNER_DIR/loop.sh" ] || {
  echo "SKIP: loop.sh missing"
  exit 0
}

WORK="$(mktemp -d "${TMPDIR:-/tmp}/delivery-lifecycle.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
trap 'pkill -f "$WORK" 2>/dev/null; rm -rf "$WORK"' EXIT

# --- 1. A registered Node repo with a trivial, dependency-free passing test. ---
REPO="$WORK/widget"
mkdir -p "$REPO/test"
printf '{"name":"widget","version":"1.0.0","private":true,"scripts":{"test":"node --test"}}\n' >"$REPO/package.json"
printf 'const t=require("node:test");const a=require("node:assert");t.test("baseline",()=>{a.equal(1+1,2);});\n' >"$REPO/test/base.test.js"
git -C "$REPO" init -q -b main
git -C "$REPO" -c user.email=t@e -c user.name=t -c commit.gpgsign=false add -A
git -C "$REPO" -c user.email=t@e -c user.name=t -c commit.gpgsign=false commit -qm init

# --- 2. Factory state: init DBs, register the repo. --------------------------
export GAFFER_DATA="$WORK/data"
mkdir -p "$GAFFER_DATA"
export DISPATCH_DB="$GAFFER_DATA/dispatch.sqlite"
export MEMORY_DB="$GAFFER_DATA/memory.sqlite"
node "$DISPATCH_CLI" --db "$DISPATCH_DB" init >/dev/null
[ -f "$MEMORY_CLI" ] && MEMORY_DB="$MEMORY_DB" node "$MEMORY_CLI" init >/dev/null 2>&1
node "$DISPATCH_CLI" --db "$DISPATCH_DB" repo add -n widget --path "$REPO" --branch main --stack node --test "node --test" >/dev/null

# --- 3. A ready ticket with an acceptance criterion. -------------------------
TID="$(node "$DISPATCH_CLI" --db "$DISPATCH_DB" ticket create -t "Add DELIVERED marker" -d "Add a DELIVERED.txt file at the repo root." --risk low 2>/dev/null |
  node -e 'let r="";process.stdin.on("data",c=>r+=c);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(r).ticket.id)}catch{process.stdout.write("")}})')"
[ -n "$TID" ] || {
  echo "SKIP: could not create ticket via CLI"
  exit 0
}
RID="$(node -e 'const{DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.env.DISPATCH_DB);process.stdout.write(db.prepare("select id from repositories where name=?").get("widget").id)')"
node -e '
const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync(process.env.DISPATCH_DB);
db.prepare("insert into ticket_repos(ticket_id,repo_id,role,access,relation,source) values(?,?,?,?,?,?)").run(process.argv[1],process.argv[2],"primary","write","confirmed","manual");
db.prepare("insert into acceptance_criteria(id,ticket_id,text,sort_order) values(?,?,?,0)").run("ac-1",process.argv[1],"DELIVERED.txt exists at the repo root");
' "$TID" "$RID"
node "$DISPATCH_CLI" --db "$DISPATCH_DB" ticket ready "$TID" >/dev/null 2>&1
READY="$(node -e 'const{DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.env.DISPATCH_DB);process.stdout.write(db.prepare("select status from tickets where id=?").get(process.argv[1]).status)' "$TID")"
[ "$READY" = "ready" ] || {
  echo "SKIP: ticket did not reach ready (got '$READY') — policy/env drift"
  exit 0
}
ok "ticket set up + marked ready"

# --- 4. Fake `claude` — runs with cwd = the delivery worktree (already on the
#        ticket branch). Makes the committed change a real agent would, then
#        prints a claude -p --output-format json success envelope. ------------
FAKE="$WORK/bin"
mkdir -p "$FAKE"
cat >"$FAKE/claude" <<'SH'
#!/bin/sh
# cwd is the delivery worktree, checked out on gaffer/ticket-N.
printf 'delivered by the fake agent (integration test)\n' > DELIVERED.txt
git add -A >/dev/null 2>&1 || true
git -c user.email=fake@agent -c user.name="fake agent" -c commit.gpgsign=false \
    commit -qm "deliver: add DELIVERED.txt per the acceptance criterion" >/dev/null 2>&1 || true
cat <<'JSON'
{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"Added DELIVERED.txt at the repo root, satisfying the acceptance criterion.","stop_reason":"end_turn","total_cost_usd":0.0123}
JSON
SH
chmod +x "$FAKE/claude"

# --- 5. Run ONE real delivery tick with the fake agent. ----------------------
# Supervised mode (no STRICT_MODE) → the agent runs unwrapped (no OS sandbox), so
# the fake binary drives the real tick.sh delivery deterministically. Bounded.
echo "== running one tick.sh delivery with the fake agent =="
export CLAUDE_BIN="$FAKE/claude"
export GAFFER_PLAN_MODEL=none GAFFER_IMPL_MODEL=none
DRY_RUN=0 GAFFER_MAX_TICKETS=1 GAFFER_TICK_TIMEOUT=120 \
  bash "$RUNNER_DIR/loop.sh" >"$WORK/loop.log" 2>&1 || true

STATUS="$(node -e 'const{DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.env.DISPATCH_DB);const r=db.prepare("select status from tickets where id=?").get(process.argv[1]);process.stdout.write(r?r.status:"gone")' "$TID")"

# --- 6. Assertions: the delivery machinery ran end to end. -------------------
echo "== assertions =="
[ "$STATUS" = "in_review" ] && ok "ticket reached in_review via runner-owned submit" ||
  fail "ticket reached in_review (got '$STATUS')"
grep -q "delivering #" "$WORK/loop.log" && ok "tick claimed + started delivery" || fail "tick started delivery"
grep -qiE "DoD: .*PASSED" "$WORK/loop.log" && ok "DoD gate PASSED against the fake delivery" ||
  fail "DoD gate PASSED"
grep -qiE "submitted #.* for review" "$WORK/loop.log" && ok "runner-owned submit recorded" ||
  fail "runner-owned submit recorded"
# The change the fake agent committed is on the delivery branch (diff computed by the server).
BR="$(git -C "$REPO" branch --list 'gaffer/ticket-*' | head -1 | tr -d ' *')"
[ -n "$BR" ] && git -C "$REPO" cat-file -e "$BR:DELIVERED.txt" 2>/dev/null &&
  ok "agent's committed change is on the delivery branch ($BR)" ||
  fail "agent's committed change is on the delivery branch"
# A per-repo delivery artifact was recorded for the ticket.
ARTIFACT="$(node -e 'const{DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.env.DISPATCH_DB);let n=0;try{n=db.prepare("select count(*) c from ticket_repo_delivery where ticket_id=?").get(process.argv[1]).c}catch{}process.stdout.write(String(n))' "$TID")"
[ "${ARTIFACT:-0}" -ge 1 ] && ok "per-repo delivery artifact recorded" ||
  fail "per-repo delivery artifact recorded (found ${ARTIFACT:-0})"

echo
if [ "${#FAILS[@]}" -eq 0 ]; then
  echo "PASS — $PASS checks passed (runner delivery lifecycle, fake agent)"
  exit 0
else
  echo "FAILED — ${#FAILS[@]} of $((PASS + ${#FAILS[@]}))"
  for f in "${FAILS[@]}"; do echo "  - $f"; done
  echo "--- last 40 lines of loop.log ---"
  tail -40 "$WORK/loop.log" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g'
  exit 1
fi
