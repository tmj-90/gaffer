#!/usr/bin/env bash
# =====================================================================
# THE COMMAND WORKER PROVIDER (GAFFER_WORKER_PROVIDER=command), end to end.
# ---------------------------------------------------------------------
# A second, real worker provider: the runner runs an operator-supplied program
# (GAFFER_WORKER_COMMAND) under the contract in docs/worker-providers.md. It has no
# in-process safety hook (that lives inside `claude -p`), so the containment rule is:
# launching it REQUIRES an OS sandbox wrap, unless the operator sets
# GAFFER_STRICT_REQUIRE=0 to assert containment out-of-band (logged loudly).
#
#   1. config: provider=command defaults GAFFER_STRICT_REQUIRE=1 + STRICT_MODE=1 and
#      says why; an explicit GAFFER_STRICT_REQUIRE=0 is honoured with a loud WARNING.
#   2. seam containment (lib/worker.sh worker_deliver): no sandbox → rc 75, nothing
#      spawned, no envelope, and the refusal names the fix; the opt-out runs with a
#      WARNING; a misconfigured command refuses rc 70; the budget admission refuses
#      rc 77 before the spawn; a worker cannot fake a runner refusal code.
#   3. a REAL tick.sh delivery with a fake OS sandbox (a sandbox-exec that records the
#      call and runs it): the stub command worker edits the worktree, talks to the
#      dispatch MCP server, returns its envelope; the ticket reaches in_review, the DoD
#      gates ran (inside the same wrap), the usage ledger row names the provider and
#      the reported cost, and `claude` was never run.
#   4. the same tick with no sandbox available refuses before the spawn and parks the
#      ticket with strict_require_unavailable.
# Run: bash runner/test/worker-command.test.sh   (bash 3.2 ok)
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
DISPATCH_CLI="$ROOT/packages/dispatch/dist/cli/index.js"
MEMORY_CLI="$ROOT/packages/memory/dist/bin/memory.js"
FIXTURE="$HERE/fixtures/command-worker.mjs"
# shellcheck source=lib/skip.sh
. "$HERE/lib/skip.sh"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/worker-command.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
trap 'gaffer_test_rm_work "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/probe-data"

# A fake OS sandbox: SANDBOX_PROVIDER=sandbox-exec finds this on PATH, and sandbox.sh
# hands back `sandbox-exec -f <profile>` as the wrap. It records every wrapped command
# and runs it (no real containment: a test seam that proves the wrap is APPLIED).
SBX_LOG="$WORK/sandbox-exec.log"; : > "$SBX_LOG"
cat > "$WORK/bin/sandbox-exec" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$SBX_LOG"
[ "\$1" = "-f" ] && shift 2
exec "\$@"
EOF
chmod +x "$WORK/bin/sandbox-exec"
# A tripwire `claude`: the command provider must never run it.
CLAUDE_TRIP="$WORK/claude-ran"
printf '#!/usr/bin/env bash\n: > "%s"\nprintf "{}\\n"\n' "$CLAUDE_TRIP" > "$WORK/bin/claude"
chmod +x "$WORK/bin/claude"
chmod +x "$FIXTURE" 2>/dev/null || true

# ── 1. config defaults ──────────────────────────────────────────────────────
echo "== 1: config — the command provider makes the OS sandbox mandatory =="
probe() {
  env -i PATH="$PATH" HOME="$HOME" GAFFER_DATA="$WORK/probe-data" "$@" \
    bash -c '
      source "'"$RUNNER_DIR"'/factory.config.sh" 2>"'"$WORK"'/probe.err" >/dev/null
      printf "STRICT_MODE=%s STRICT_REQUIRE=%s\n" "${STRICT_MODE:-}" "${GAFFER_STRICT_REQUIRE:-}"
    '
}
got="$(probe)"
[ "$got" = "STRICT_MODE=0 STRICT_REQUIRE=" ] && ok "claude-code (default): no sandbox requirement added" \
  || fail "default provider should not require a sandbox (got: $got)"
got="$(probe GAFFER_WORKER_PROVIDER=command GAFFER_WORKER_COMMAND="$FIXTURE")"
[ "$got" = "STRICT_MODE=1 STRICT_REQUIRE=1" ] && ok "provider=command → STRICT_MODE=1 + GAFFER_STRICT_REQUIRE=1" \
  || fail "provider=command should default the sandbox on and required (got: $got)"
grep -q "GAFFER_WORKER_PROVIDER=command" "$WORK/probe.err" && grep -q "safety hook" "$WORK/probe.err" \
  && ok "…and says why (no in-process safety hook)" || fail "no notice for the command provider default (stderr: $(cat "$WORK/probe.err"))"
got="$(probe GAFFER_WORKER_PROVIDER=command GAFFER_WORKER_COMMAND="$FIXTURE" GAFFER_STRICT_REQUIRE=0)"
[ "$got" = "STRICT_MODE=0 STRICT_REQUIRE=0" ] && ok "explicit GAFFER_STRICT_REQUIRE=0 is honoured" \
  || fail "the opt-out should be honoured (got: $got)"
grep -q "^WARNING: GAFFER_WORKER_PROVIDER=command" "$WORK/probe.err" && grep -q "out-of-band" "$WORK/probe.err" \
  && ok "…and logged loudly (WARNING naming out-of-band containment)" || fail "the opt-out was not logged loudly (stderr: $(cat "$WORK/probe.err"))"

# ── 2. seam containment ─────────────────────────────────────────────────────
echo "== 2: worker_deliver — containment rule at the seam =="
export GAFFER_DATA="$WORK/seam-data"; mkdir -p "$GAFFER_DATA"
export CLAUDE_BIN="$WORK/bin/claude"
unset GAFFER_STRICT_REQUIRE STRICT_MODE
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
unset GAFFER_STRICT_REQUIRE STRICT_MODE
export GAFFER_ALLOW_UNCAPPED=1
MCP="$WORK/mcp.json"; printf '{}' > "$MCP"
CWD="$WORK/cwd"; mkdir -p "$CWD"
CALLS="$GAFFER_DATA/command-worker.jsonl"
run_cmd() {   # run_cmd <env assignments…> — worker_deliver with no caller wrap
  local out="$WORK/out.json" errf="$WORK/err"
  : > "$out"; : > "$CALLS"
  WORKER_CALL_ENV=( "GAFFER_WRITE_ROOTS=$CWD" "GAFFER_READ_ROOTS=" "GAFFER_DATA=$GAFFER_DATA" )
  env "$@" bash -c '
    source "'"$RUNNER_DIR"'/factory.config.sh" >/dev/null 2>&1
    WORKER_CALL_ENV=( "GAFFER_WRITE_ROOTS='"$CWD"'" "GAFFER_READ_ROOTS=" "GAFFER_DATA='"$GAFFER_DATA"'" )
    worker_deliver "'"$CWD"'" "the prompt" "--model stub-model" "'"$MCP"'" "'"$out"'" "" 7
  ' 2>"$errf"
  RC=$?; OUT_SIZE="$(wc -c < "$out" | tr -d ' ')"; ERR="$(cat "$errf")"
  RAN=0; [ -s "$CALLS" ] && RAN=1
}
BASE=( PATH="$WORK/bin:$PATH" GAFFER_WORKER_PROVIDER=command GAFFER_WORKER_COMMAND="$FIXTURE" )

run_cmd "${BASE[@]}" SANDBOX_PROVIDER=none
[ "$RC" = "75" ] && ok "no sandbox available → rc 75 (fail closed)" || fail "expected rc 75 without a sandbox (got $RC; $ERR)"
[ "$RAN" = "0" ] && ok "…the command worker was NOT spawned" || fail "the command worker ran without a sandbox"
[ "$OUT_SIZE" = "0" ] && ok "…no envelope written" || fail "an envelope was written ($OUT_SIZE bytes)"
case "$ERR" in *"GAFFER_WORKER_PROVIDER=command"*"SANDBOX_PROVIDER=docker"*"GAFFER_STRICT_REQUIRE=0"*) ok "…the refusal names the cause and the fix" ;;
  *) fail "the refusal does not name the cause and the fix (got: $ERR)" ;; esac

run_cmd "${BASE[@]}" SANDBOX_PROVIDER=none GAFFER_STRICT_REQUIRE=1
[ "$RC" = "75" ] && [ "$RAN" = "0" ] && ok "GAFFER_STRICT_REQUIRE=1 + no sandbox → rc 75, no spawn" || fail "strict-require + no sandbox should refuse (rc=$RC ran=$RAN)"

mkdir -p "$WORK/baddocker"; printf '#!/usr/bin/env bash\nexit 1\n' > "$WORK/baddocker/docker"; chmod +x "$WORK/baddocker/docker"
run_cmd "${BASE[@]}" SANDBOX_PROVIDER=docker GAFFER_STRICT_REQUIRE=yes PATH="$WORK/baddocker:$WORK/bin:$PATH"
[ "$RC" = "75" ] && [ "$RAN" = "0" ] && ok "docker selected but unavailable → rc 75, no spawn" || fail "docker unavailable should refuse (rc=$RC ran=$RAN)"

run_cmd "${BASE[@]}" SANDBOX_PROVIDER=none GAFFER_STRICT_REQUIRE=0
[ "$RC" = "0" ] && [ "$RAN" = "1" ] && ok "explicit GAFFER_STRICT_REQUIRE=0 → the worker runs (operator asserts out-of-band containment)" \
  || fail "the opt-out should run the worker (rc=$RC ran=$RAN; $ERR)"
case "$ERR" in *"WARNING: GAFFER_WORKER_PROVIDER=command"*"no OS sandbox"*) ok "…logged loudly at the spawn" ;; *) fail "the opt-out spawn was not logged loudly (got: $ERR)" ;; esac

: > "$SBX_LOG"
run_cmd "${BASE[@]}" SANDBOX_PROVIDER=sandbox-exec
[ "$RC" = "0" ] && [ "$RAN" = "1" ] && ok "a sandbox is available → the worker runs (rc 0)" || fail "the sandboxed worker should run (rc=$RC ran=$RAN; $ERR)"
grep -q "^-f .*strict-profile.* $FIXTURE\$" "$SBX_LOG" \
  && ok "…INSIDE the sandbox wrap (sandbox-exec -f <profile> … $(basename "$FIXTURE"))" || fail "the worker did not run under the wrap (log: $(cat "$SBX_LOG"))"
[ ! -e "$CLAUDE_TRIP" ] && ok "…and claude was never run" || fail "the command provider ran claude"

run_cmd PATH="$WORK/bin:$PATH" GAFFER_WORKER_PROVIDER=command SANDBOX_PROVIDER=sandbox-exec
[ "$RC" = "70" ] && [ "$RAN" = "0" ] && ok "GAFFER_WORKER_COMMAND unset → rc 70, no spawn" || fail "unset command should refuse rc 70 (rc=$RC)"
case "$ERR" in *GAFFER_WORKER_COMMAND*) ok "…naming GAFFER_WORKER_COMMAND" ;; *) fail "the misconfig refusal should name GAFFER_WORKER_COMMAND (got: $ERR)" ;; esac
run_cmd PATH="$WORK/bin:$PATH" GAFFER_WORKER_PROVIDER=command GAFFER_WORKER_COMMAND=relative/worker SANDBOX_PROVIDER=sandbox-exec
[ "$RC" = "70" ] && [ "$RAN" = "0" ] && ok "a relative GAFFER_WORKER_COMMAND → rc 70" || fail "relative command should refuse (rc=$RC)"
printf 'not executable\n' > "$WORK/noexec"; chmod -x "$WORK/noexec"
run_cmd PATH="$WORK/bin:$PATH" GAFFER_WORKER_PROVIDER=command GAFFER_WORKER_COMMAND="$WORK/noexec" SANDBOX_PROVIDER=sandbox-exec
[ "$RC" = "70" ] && ok "a non-executable GAFFER_WORKER_COMMAND → rc 70" || fail "non-executable command should refuse (rc=$RC)"

# The budget admission runs BEFORE the containment check and the spawn.
mkdir -p "$WORK/budget-data"
printf '{"ts":"%s","kind":"delivery","measured":true,"total_cost_usd":9}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$WORK/budget-data/usage-ledger.jsonl"
run_cmd "${BASE[@]}" SANDBOX_PROVIDER=sandbox-exec GAFFER_ALLOW_UNCAPPED=0 GAFFER_DAILY_BUDGET_USD=1 GAFFER_USAGE_LEDGER="$WORK/budget-data/usage-ledger.jsonl"
[ "$RC" = "77" ] && [ "$RAN" = "0" ] && ok "daily budget spent → the budget admission refuses rc 77, nothing spawned" \
  || fail "the budget admission should refuse the command worker (rc=$RC ran=$RAN; $ERR)"

run_cmd "${BASE[@]}" SANDBOX_PROVIDER=sandbox-exec GAFFER_TEST_COMMAND_WORKER_EXIT=77
[ "$RC" = "1" ] && ok "a worker exiting 77 cannot pose as the runner's budget refusal (remapped to 1)" || fail "reserved exit code not remapped (rc=$RC)"

GAFFER_WORKER_PROVIDER=made-up worker_deliver "$CWD" "p" "" "$MCP" "$WORK/out.unknown.json" "" 2>"$WORK/err.unknown"
urc=$?
[ "$urc" = "70" ] && grep -q "not yet supported" "$WORK/err.unknown" && ok "an unknown provider still refuses rc 70" \
  || fail "unknown provider should still refuse rc 70 (rc=$urc)"

# ── 3. a real tick.sh delivery ─────────────────────────────────────────────
echo "== 3: tick.sh delivers a ticket through the command worker =="
command -v git >/dev/null 2>&1 || gaffer_skip "git required"
node --input-type=commonjs -e "require('node:sqlite')" 2>/dev/null || gaffer_skip "node:sqlite requires Node >= 22.5"
[ -f "$DISPATCH_CLI" ] || gaffer_skip "dispatch CLI not built ($DISPATCH_CLI)"

setup_world() {   # setup_world <name> → REPO, GAFFER_DATA, DISPATCH_DB, MEMORY_DB, TID
  local n="$1"
  REPO="$WORK/$n-repo"; mkdir -p "$REPO/test"
  printf '{"name":"widget","version":"1.0.0","private":true,"scripts":{"test":"node --test"}}\n' >"$REPO/package.json"
  printf 'const t=require("node:test");const a=require("node:assert");t.test("baseline",()=>{a.equal(1+1,2);});\n' >"$REPO/test/base.test.js"
  git -C "$REPO" init -q -b main
  git -C "$REPO" -c user.email=t@e -c user.name=t -c commit.gpgsign=false add -A
  git -C "$REPO" -c user.email=t@e -c user.name=t -c commit.gpgsign=false commit -qm init
  export GAFFER_DATA="$WORK/$n-data"; mkdir -p "$GAFFER_DATA"
  export DISPATCH_DB="$GAFFER_DATA/dispatch.sqlite" MEMORY_DB="$GAFFER_DATA/memory.sqlite"
  node "$DISPATCH_CLI" --db "$DISPATCH_DB" init >/dev/null
  [ -f "$MEMORY_CLI" ] && node "$MEMORY_CLI" init >/dev/null 2>&1
  node "$DISPATCH_CLI" --db "$DISPATCH_DB" repo add -n widget --path "$REPO" --branch main --stack node --test "node --test" >/dev/null
  TID="$(node "$DISPATCH_CLI" --db "$DISPATCH_DB" ticket create -t "Add DELIVERED marker" -d "Add DELIVERED.txt at the repo root." --risk low 2>/dev/null |
    node -e 'let r="";process.stdin.on("data",c=>r+=c);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(r).ticket.id)}catch{}})')"
  node -e '
const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.env.DISPATCH_DB);
const rid=db.prepare("select id from repositories where name=?").get("widget").id;
db.prepare("insert into ticket_repos(ticket_id,repo_id,role,access,relation,source) values(?,?,?,?,?,?)").run(process.argv[1],rid,"primary","write","confirmed","manual");
db.prepare("insert into acceptance_criteria(id,ticket_id,text,sort_order) values(?,?,?,0)").run("ac-1",process.argv[1],"DELIVERED.txt exists");
' "$TID"
  node "$DISPATCH_CLI" --db "$DISPATCH_DB" ticket ready "$TID" >/dev/null 2>&1
}
ticket_status() { node "$DISPATCH_CLI" --db "$DISPATCH_DB" ticket show "$TID" 2>/dev/null | node "$RUNNER_DIR/lib/json-tool.mjs" expr 'd.ticket.status' 2>/dev/null; }
run_tick() {   # run_tick <log> <env assignments…>
  local log="$1"; shift
  env -u GAFFER_STRICT_REQUIRE -u STRICT_MODE -u ANTHROPIC_API_KEY -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN \
    PATH="$WORK/bin:$PATH" CLAUDE_BIN="$WORK/bin/claude" DRY_RUN=0 GAFFER_ALLOW_UNCAPPED=1 GAFFER_TICK_TIMEOUT=120 \
    GAFFER_IMPL_MODEL=stub-impl-model GAFFER_PLAN_MODEL=none \
    GAFFER_WORKER_PROVIDER=command GAFFER_WORKER_COMMAND="$FIXTURE" "$@" \
    bash "$RUNNER_DIR/tick.sh" >"$log" 2>&1 || true
}

setup_world ok
[ -n "$TID" ] || { fail "could not create a ticket"; exit 1; }
: > "$SBX_LOG"; rm -f "$CLAUDE_TRIP"
# Fake (not real) credentials: the scrub must drop the claude-code auth surface and the
# runner-only GITHUB_TOKEN even when GAFFER_WORKER_COMMAND_ENV names it, and pass the
# worker's own named credential.
run_tick "$WORK/tick-ok.log" SANDBOX_PROVIDER=sandbox-exec \
  ANTHROPIC_API_KEY=sk-test-not-real GITHUB_TOKEN=ghp-test-not-real STUB_WORKER_KEY=stub-key-not-real \
  GAFFER_WORKER_COMMAND_ENV="STUB_WORKER_KEY GITHUB_TOKEN"
CALLS="$GAFFER_DATA/command-worker.jsonl"
[ "$(ticket_status)" = "in_review" ] && ok "the ticket reached in_review (the human gate)" \
  || { fail "ticket not in_review (got '$(ticket_status)')"; tail -25 "$WORK/tick-ok.log"; }
[ -s "$CALLS" ] && ok "the command worker ran" || fail "the command worker never ran"
node -e '
const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n")[0]);
const bad=[];
if(r.contract!=="1")bad.push("contract");
if(r.kind!=="delivery")bad.push("kind="+r.kind);
if(r.model!=="stub-impl-model")bad.push("model="+r.model);
if(!/^\d+$/.test(r.maxTurns||""))bad.push("maxTurns="+r.maxTurns);
if(!r.mcpConfig)bad.push("mcpConfig");
if(r.promptHasTicket!==true)bad.push("prompt");
if(!r.committed)bad.push("not committed");
for(const n of ["ANTHROPIC_API_KEY","GITHUB_TOKEN","DISPATCH_API_TOKEN","CLAUDE_BIN","CLAUDE_FLAGS"]) if(r.envNames.includes(n))bad.push("leaked "+n);
if(!r.envNames.includes("STUB_WORKER_KEY"))bad.push("GAFFER_WORKER_COMMAND_ENV name not passed");
if(bad.length){console.error(bad.join(", "));process.exit(1);}' "$CALLS" 2>"$WORK/contract.err" \
  && ok "it received the contract (prompt, model hint, turn cap, MCP config, kind) under the scrubbed env (its own named key, no Claude or runner secrets), in the worktree" \
  || fail "contract not honoured: $(cat "$WORK/contract.err")"
node -e '
const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n")[0]);
const g=r.mcp.find(m=>m.tool==="get_ticket"&&m.ok);const e=r.mcp.find(m=>m.tool==="record_ac_evidence"&&m.ok);
process.exit(g&&e?0:1);' "$CALLS" \
  && ok "it talked to the dispatch MCP server (get_ticket + record_ac_evidence)" || fail "MCP calls failed: $(head -c 600 "$CALLS")"
EVN="$(node -e '
const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.env.DISPATCH_DB);
process.stdout.write(String(db.prepare("select count(*) n from evidence where ticket_id=? and summary like ?").get(process.argv[1],"command worker:%").n));' "$TID" 2>/dev/null)"
[ "${EVN:-0}" -ge 1 ] && ok "the worker's MCP evidence landed on the ticket" || fail "no command-worker evidence on the ticket ($EVN)"
grep -q " $FIXTURE\$" "$SBX_LOG" && ok "the delivery ran INSIDE the sandbox wrap" || fail "the delivery did not run under the wrap (log: $(cat "$SBX_LOG"))"
grep -q "^-f .*strict-profile.* bash -c node --test\$" "$SBX_LOG" && ok "the DoD tests gate ran too, inside the same wrap" \
  || fail "no DoD gate ran under the wrap (log: $(grep -v GAFFER_WORKER "$SBX_LOG" | head -5))"
grep -q "DoD: #[0-9]* PASSED" "$WORK/tick-ok.log" && ok "tick.log records the DoD gate pass" || fail "no DoD pass in the tick log"
ROW="$(grep '"kind":"delivery"' "$GAFFER_DATA/usage-ledger.jsonl" 2>/dev/null | tail -1)"
node -e 'const r=JSON.parse(process.argv[1]);process.exit(r.worker_provider==="command"&&r.total_cost_usd===0.0123&&r.cost_basis==="reported"&&r.measured===true&&r.num_turns===2&&r.models&&r.models["stub-command-model"]?0:1)' "${ROW:-{\}}" \
  && ok "ledger: the delivery row names the provider, the reported cost, turns and serving model" \
  || fail "ledger row: ${ROW:-<none>}"
[ ! -e "$CLAUDE_TRIP" ] && ok "claude was never run" || fail "claude ran during a command-provider tick"

echo "== 4: the same tick with no sandbox available refuses before the spawn =="
setup_world refuse
: > "$SBX_LOG"
run_tick "$WORK/tick-refuse.log" SANDBOX_PROVIDER=none
[ ! -s "$GAFFER_DATA/command-worker.jsonl" ] && ok "the command worker was NOT spawned" || fail "the command worker ran with no sandbox"
[ "$(ticket_status)" = "blocked" ] && ok "the ticket is parked blocked" || fail "ticket should be blocked (got '$(ticket_status)')"
grep -q "strict_require_unavailable\|refusing to launch the agent" "$WORK/tick-refuse.log" \
  && ok "tick.log says the agent was refused for want of an OS sandbox" || fail "no refusal in the tick log: $(tail -5 "$WORK/tick-refuse.log")"
grep -q "GAFFER_WORKER_PROVIDER=command" "$WORK/tick-refuse.log" \
  && ok "…and names the command provider as the reason the sandbox is required" || fail "the refusal does not name the provider"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "worker-command: all $PASS passed"; exit 0; fi
echo "worker-command: ${#FAILURES[@]} FAILED (of $((PASS + ${#FAILURES[@]})))"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
