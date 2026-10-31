#!/usr/bin/env bash
# =====================================================================
# Per-attempt provenance: WHICH model and WHICH Claude Code CLI ran each attempt
# (lib/worker.sh worker_deliver, lib/claude-version.mjs, lib/usage-ledger.mjs,
# factory.config.sh gaffer_usage_record / gaffer_record_agent_run, tick.sh).
# ---------------------------------------------------------------------
# Every later quality metric (pass rate per model, per CLI release) needs these on
# the record. Proves:
#   1. gaffer_model_from_flag reads `--model X` / `--model=X`, "" for the default.
#   2. claude-version.mjs: a native install (…/versions/<v>) and an npm install
#      (the CLI's package.json) are read WITHOUT running the binary; a non-script
#      binary is asked `--version`; a shell script (a wrapper or a test stub) is
#      NOT run; GAFFER_CLAUDE_VERSION pins it.
#   3. usage-ledger.mjs --attempt/--model/--claude-version stamp the record; without
#      them the record is unchanged.
#   4. END TO END: one real tick.sh delivery with a stub agent writes a ledger row
#      carrying attempt 1, the requested model and the CLI version, and attaches
#      agent-run evidence naming the model that served it; `--version` ran once.
# Run: bash runner/test/attempt-provenance.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
DISPATCH_CLI="$ROOT/packages/dispatch/dist/cli/index.js"
MEMORY_CLI="$ROOT/packages/memory/dist/bin/memory.js"
# shellcheck source=lib/skip.sh
. "$HERE/lib/skip.sh"

PASS=0
FAILS=()
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILS+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/attempt-prov.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT

echo "== 1: gaffer_model_from_flag =="
# shellcheck source=../lib/worker.sh
RUNNER_DIR="$RUNNER_DIR" . "$RUNNER_DIR/lib/worker.sh"
[ "$(gaffer_model_from_flag "--model stub-a")" = "stub-a" ] && ok "--model X" || fail "--model X"
[ "$(gaffer_model_from_flag "--model=stub-b")" = "stub-b" ] && ok "--model=X" || fail "--model=X"
[ -z "$(gaffer_model_from_flag "")" ] && ok "no flag → \"\" (the CLI default)" || fail "empty flag"
[ "$(gaffer_model_from_flag "--max-turns 3 --model stub-c")" = "stub-c" ] && ok "found among other flags" || fail "among flags"

echo "== 2: claude-version.mjs =="
CV="$RUNNER_DIR/lib/claude-version.mjs"
mkdir -p "$WORK/native/versions" "$WORK/bin"
printf '\177ELF-not-really\n' > "$WORK/native/versions/3.4.5"; chmod +x "$WORK/native/versions/3.4.5"
ln -s "$WORK/native/versions/3.4.5" "$WORK/bin/claude-native"
[ "$(node "$CV" "$WORK/bin/claude-native")" = "3.4.5" ] && ok "native install: version from the versions/ path" || fail "native: $(node "$CV" "$WORK/bin/claude-native")"
PKG="$WORK/npm/node_modules/@anthropic-ai/claude-code"; mkdir -p "$PKG"
printf '{"name":"@anthropic-ai/claude-code","version":"6.7.8"}\n' > "$PKG/package.json"
printf '#!/usr/bin/env node\nrequire("fs").writeFileSync(%s,"ran");\n' "\"$WORK/npm-ran\"" > "$PKG/cli.js"; chmod +x "$PKG/cli.js"
ln -s "$PKG/cli.js" "$WORK/bin/claude-npm"
[ "$(node "$CV" "$WORK/bin/claude-npm")" = "6.7.8" ] && ok "npm install: version from the CLI's package.json" || fail "npm: $(node "$CV" "$WORK/bin/claude-npm")"
[ ! -e "$WORK/npm-ran" ] && ok "…without running the binary" || fail "the npm binary was executed"
printf '#!/usr/bin/env node\nconsole.log(process.argv[2]==="--version" ? "1.2.3 (Claude Code)" : "?");\n' > "$WORK/bin/claude-exec"; chmod +x "$WORK/bin/claude-exec"
[ "$(node "$CV" "$WORK/bin/claude-exec")" = "1.2.3 (Claude Code)" ] && ok "other binary: asked --version" || fail "exec: $(node "$CV" "$WORK/bin/claude-exec")"
printf '#!/bin/sh\necho called >> "%s"\necho 0.0.1\n' "$WORK/stub-ran" > "$WORK/bin/claude-sh"; chmod +x "$WORK/bin/claude-sh"
[ "$(node "$CV" "$WORK/bin/claude-sh")" = "unknown (wrapper script)" ] && [ ! -e "$WORK/stub-ran" ] \
  && ok "a shell script is not run (a wrapper or a test stub)" || fail "shell stub: $(node "$CV" "$WORK/bin/claude-sh"); ran=$([ -e "$WORK/stub-ran" ] && echo yes)"
[ "$(node "$CV" "$WORK/bin/nope")" = "unknown (not found)" ] && ok "a missing binary is unknown, not an error" || fail "missing"
v="$(GAFFER_CLAUDE_VERSION="pinned 1.0" bash -c 'RUNNER_DIR="$1"; . "$1/lib/worker.sh"; gaffer_claude_version /nope' _ "$RUNNER_DIR")"
[ "$v" = "pinned 1.0" ] && ok "GAFFER_CLAUDE_VERSION pins the recorded version" || fail "pin: $v"

echo "== 3: usage-ledger.mjs stamps the record =="
UL="$RUNNER_DIR/lib/usage-ledger.mjs"
ENV_JSON='{"type":"result","result":"ok","total_cost_usd":0.01,"num_turns":1,"duration_ms":5}'
printf '%s' "$ENV_JSON" > "$WORK/u.json"
GAFFER_USAGE_LEDGER="$WORK/l1.jsonl" node "$UL" --kind delivery --ticket 4 --rc 0 --attempt 2 --model stub-req --claude-version "1.2.3 (Claude Code)" --json-file "$WORK/u.json" >/dev/null
row="$(cat "$WORK/l1.jsonl")"
node -e 'const r=JSON.parse(process.argv[1]);process.exit(r.attempt===2&&r.model_requested==="stub-req"&&r.claude_version==="1.2.3 (Claude Code)"&&r.measured===true?0:1)' "$row" \
  && ok "attempt, model_requested and claude_version are on the row" || fail "row: $row"
GAFFER_USAGE_LEDGER="$WORK/l2.jsonl" node "$UL" --kind delivery --ticket 4 --rc 124 --attempt 1 --model stub-req --claude-version 9 --kill-estimate 0 --json-file "$WORK/u.json" >/dev/null
node -e 'const r=JSON.parse(process.argv[1]);process.exit(r.attempt===1&&r.model_requested==="stub-req"&&r.measured===false?0:1)' "$(cat "$WORK/l2.jsonl")" \
  && ok "a killed call carries them too" || fail "killed row: $(cat "$WORK/l2.jsonl")"
GAFFER_USAGE_LEDGER="$WORK/l3.jsonl" node "$UL" --kind review --rc 0 --json-file "$WORK/u.json" >/dev/null
node -e 'const r=JSON.parse(process.argv[1]);process.exit(!("attempt" in r)&&!("model_requested" in r)&&!("claude_version" in r)?0:1)' "$(cat "$WORK/l3.jsonl")" \
  && ok "without them the record is unchanged" || fail "bare row: $(cat "$WORK/l3.jsonl")"

echo "== 4: end to end — one real delivery tick =="
command -v git >/dev/null 2>&1 || gaffer_skip "git required"
node --input-type=commonjs -e "require('node:sqlite')" 2>/dev/null || gaffer_skip "node:sqlite requires Node >= 22.5"
[ -f "$DISPATCH_CLI" ] || gaffer_skip "dispatch CLI not built ($DISPATCH_CLI)"
REPO="$WORK/widget"; mkdir -p "$REPO/test"
printf '{"name":"widget","version":"1.0.0","private":true,"scripts":{"test":"node --test"}}\n' >"$REPO/package.json"
printf 'const t=require("node:test");const a=require("node:assert");t.test("baseline",()=>{a.equal(1+1,2);});\n' >"$REPO/test/base.test.js"
git -C "$REPO" init -q -b main
git -C "$REPO" -c user.email=t@e -c user.name=t -c commit.gpgsign=false add -A
git -C "$REPO" -c user.email=t@e -c user.name=t -c commit.gpgsign=false commit -qm init
export GAFFER_DATA="$WORK/data"; mkdir -p "$GAFFER_DATA"
export DISPATCH_DB="$GAFFER_DATA/dispatch.sqlite" MEMORY_DB="$GAFFER_DATA/memory.sqlite"
node "$DISPATCH_CLI" --db "$DISPATCH_DB" init >/dev/null
[ -f "$MEMORY_CLI" ] && node "$MEMORY_CLI" init >/dev/null 2>&1
node "$DISPATCH_CLI" --db "$DISPATCH_DB" repo add -n widget --path "$REPO" --branch main --stack node --test "node --test" >/dev/null
TID="$(node "$DISPATCH_CLI" --db "$DISPATCH_DB" ticket create -t "Add DELIVERED marker" -d "Add DELIVERED.txt at the repo root." --risk low 2>/dev/null |
  node -e 'let r="";process.stdin.on("data",c=>r+=c);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(r).ticket.id)}catch{}})')"
[ -n "$TID" ] || { fail "could not create a ticket"; exit 1; }
node -e '
const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.env.DISPATCH_DB);
const rid=db.prepare("select id from repositories where name=?").get("widget").id;
db.prepare("insert into ticket_repos(ticket_id,repo_id,role,access,relation,source) values(?,?,?,?,?,?)").run(process.argv[1],rid,"primary","write","confirmed","manual");
db.prepare("insert into acceptance_criteria(id,ticket_id,text,sort_order) values(?,?,?,0)").run("ac-1",process.argv[1],"DELIVERED.txt exists");
' "$TID"
node "$DISPATCH_CLI" --db "$DISPATCH_DB" ticket ready "$TID" >/dev/null 2>&1
# A NODE stub agent (not a shell script) so the CLI version is asked with --version,
# the way a real binary would be. Every call is logged: --version must run once.
STUB_LOG="$WORK/stub.log"; : > "$STUB_LOG"
cat > "$WORK/bin/claude" <<JS
#!/usr/bin/env node
const fs = require("fs"), cp = require("child_process");
fs.appendFileSync("$STUB_LOG", (process.argv[2] === "--version" ? "version" : "call") + "\n");
if (process.argv[2] === "--version") { console.log("4.2.0 (Claude Code)"); process.exit(0); }
fs.writeFileSync("DELIVERED.txt", "delivered\n");
cp.execSync('git add -A && git -c user.email=f@a -c user.name=f -c commit.gpgsign=false commit -qm "deliver: add DELIVERED.txt"');
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1,
  result: "Added DELIVERED.txt.", stop_reason: "end_turn", total_cost_usd: 0.0123,
  modelUsage: { "stub-served-model": { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.0123 } } }));
JS
chmod +x "$WORK/bin/claude"
unset GAFFER_CLAUDE_VERSION
CLAUDE_BIN="$WORK/bin/claude" GAFFER_IMPL_MODEL=stub-impl-model GAFFER_PLAN_MODEL=none \
  DRY_RUN=0 GAFFER_ALLOW_UNCAPPED=1 GAFFER_TICK_TIMEOUT=120 \
  bash "$RUNNER_DIR/tick.sh" >"$WORK/tick.log" 2>&1 || true
ROW="$(grep '"kind":"delivery"' "$GAFFER_DATA/usage-ledger.jsonl" 2>/dev/null | tail -1)"
node -e 'const r=JSON.parse(process.argv[1]);process.exit(r.attempt===1&&r.model_requested==="stub-impl-model"&&r.claude_version==="4.2.0 (Claude Code)"&&r.models&&r.models["stub-served-model"]?0:1)' "${ROW:-{\}}" \
  && ok "ledger: the delivery row names attempt 1, the requested model, the serving model and the CLI version" \
  || fail "ledger row: ${ROW:-<none>}"
EV="$(node -e '
const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.env.DISPATCH_DB);
const r=db.prepare("select summary,payload_json from evidence where ticket_id=? and evidence_type=?").all(process.argv[1],"log");
process.stdout.write(JSON.stringify(r));' "$TID")"
node -e '
const rows=JSON.parse(process.argv[1]);const r=rows.find(x=>x.payload_json&&JSON.parse(x.payload_json).kind==="agent_run");
if(!r)process.exit(1);const p=JSON.parse(r.payload_json);
process.exit(p.attempt===1&&p.max_attempts>=1&&p.model_requested==="stub-impl-model"&&p.models_served[0]==="stub-served-model"&&p.claude_version==="4.2.0 (Claude Code)"&&/attempt 1\/\d+: model stub-served-model, CLI 4\.2\.0/.test(r.summary)?0:1)' "${EV:-[]}" \
  && ok "evidence: agent-run evidence names the attempt, the serving model and the CLI version" \
  || fail "agent-run evidence: ${EV:-<none>}"
[ "$(grep -c '^version$' "$STUB_LOG")" = 1 ] && ok "the CLI was asked --version once" || fail "--version calls: $(grep -c '^version$' "$STUB_LOG")"
[ "$(grep -c '^call$' "$STUB_LOG")" = 1 ] && ok "one delivery call" || fail "delivery calls: $(grep -c '^call$' "$STUB_LOG")"

echo
if [ "${#FAILS[@]}" -eq 0 ]; then echo "attempt-provenance: all $PASS passed"; exit 0; fi
echo "attempt-provenance: ${#FAILS[@]} FAILED (of $((PASS + ${#FAILS[@]})))"
for f in "${FAILS[@]}"; do echo "  - $f"; done
echo "--- tick.log tail ---"; tail -30 "$WORK/tick.log" 2>/dev/null
exit 1
