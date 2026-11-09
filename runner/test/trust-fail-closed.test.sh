#!/usr/bin/env bash
# =====================================================================
# NO AGENT RUNS UNTRUSTED: a trust write that was skipped stops the launch.
# ---------------------------------------------------------------------
# The live run this pins: trust-workspace.mjs could not take its lock (a stale
# zero-byte lock from an earlier run), skipped the ~/.claude.json write and exited 0;
# gaffer_trust_workspace only logged "TRUST: could not pre-trust", and the delivery
# agent and then the reviewer ran with their project permissions ignored (no
# get_ticket, no npm test, no commit, no evidence), the scaffold was auto-committed
# untested and the reviewer sent it back "because my tools were blocked".
# Real tick.sh + real dispatch, a stub `claude` that logs every invocation, and a
# scratch HOME (the operator's ~/.claude.json and its lock are never touched):
#   A  control: with a writable config the delivery runs and trust is recorded;
#   B  an UNPARSEABLE ~/.claude.json: the review pass HOLDS the in_review ticket for a
#      human (REVIEW-HELD naming trust) and launches no reviewer;
#   C  the same config: a delivery tick ends setup_error with trust_unwritable and the
#      fix, releases the ticket to ready, and spawns no agent;
#   D  a lock held by a LIVE process: the same refusal, the fix names the lock;
#   E  the holder dies: the next tick takes the stale lock over and delivers;
#   F  a stale EMPTY lock (the live run's exact leftover) is taken over too;
#   G  the independent tester (bin/tester-run.mjs --live) refuses to launch untrusted,
#      and with a writable config trusts its worktree and runs.
# Run: bash runner/test/trust-fail-closed.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
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

WORK="$(mktemp -d "${TMPDIR:-/tmp}/trust-fail-closed.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
SLEEPER=""
trap '[ -n "$SLEEPER" ] && kill "$SLEEPER" 2>/dev/null; gaffer_test_rm_work "$WORK"' EXIT
mkdir -p "$WORK/data" "$WORK/bin" "$WORK/home"

# Scratch HOME: trust-workspace.mjs writes $HOME/.claude.json. Never the real one.
REAL_HOME="$(cd ~ 2>/dev/null && pwd -P)"
export HOME="$WORK/home"
[ "$HOME" != "$REAL_HOME" ] || { echo "FAIL: scratch HOME is the real HOME"; exit 1; }
CONF="$HOME/.claude.json"; LOCK="$CONF.gaffer-trust.lock"

R="$WORK/repo"; mkdir -p "$R/src" "$R/test"
( cd "$R" && git init -q -b main
  printf '{ "name": "r", "version": "0.1.0", "private": true, "type": "module", "scripts": { "test": "node --test", "lint": "node -e 0" } }\n' > package.json
  printf 'export function addTask(l, t) { return [...l, { t }]; }\n' > src/tasks.js
  printf 'import test from "node:test"; import assert from "node:assert/strict";\nimport { addTask } from "../src/tasks.js";\ntest("adds", () => { assert.equal(addTask([], "a").length, 1); });\n' > test/tasks.test.js
  git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init )

# Stub agent: every call except --version is LOGGED (one line, the cwd), so "no agent
# was spawned" is an empty delta of this log. MODE file: deliver | approve.
CALLS="$WORK/claude-calls.log"; : > "$CALLS"
MODE_FILE="$WORK/stub-mode"; echo deliver > "$MODE_FILE"
cat > "$WORK/bin/claude" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
[ "${1:-}" = "--version" ] && { echo "0.0.0 (stub)"; exit 0; }
printf '%s\n' "$PWD" >> "__CALLS__"
if [ "$(cat "__MODE_FILE__")" = "approve" ]; then
  printf '{"type":"result","subtype":"success","is_error":false,"result":"RECOMMEND APPROVE\\n{\\"verdict\\":\\"APPROVE\\"}","total_cost_usd":0.01,"num_turns":2}\n'; exit 0
fi
if [ -e .git ] && [ -f package.json ]; then
  fn="helper${GAFFER_TICKET:-0}"
  grep -q "$fn" src/tasks.js || { printf 'export function %s(l){return l;}\n' "$fn" >> src/tasks.js; git -c user.email=s@s -c user.name=s add -A >/dev/null; git -c user.email=s@s -c user.name=s commit -qm "feat: $fn" >/dev/null; }
  printf '{"type":"result","subtype":"success","is_error":false,"result":"done.\\n\\nSmallest-change note: modified src/tasks.js only.","total_cost_usd":0.02,"num_turns":3}\n'; exit 0
fi
printf '{"type":"result","subtype":"success","is_error":false,"result":"ok"}\n'
STUB
sed -i.bak -e "s|__MODE_FILE__|$MODE_FILE|" -e "s|__CALLS__|$CALLS|" "$WORK/bin/claude" && rm -f "$WORK/bin/claude.bak"; chmod +x "$WORK/bin/claude"

export GAFFER_DATA="$WORK/data" CLAUDE_BIN="$WORK/bin/claude" CLAUDE_FLAGS="" \
       GAFFER_TICK_TIMEOUT=60 GAFFER_MAX_TURNS=10 GAFFER_ROLE_MODELS=card=stub GAFFER_PLAN_MODEL=stub GAFFER_IMPL_MODEL=stub \
       REVIEW_MODE=human DRY_RUN=0 GAFFER_MAINTENANCE=0 MAX_OPEN_AGENT_BRANCHES_PER_REPO=10 MAX_OPEN_AGENT_PRS_PER_REPO=10 \
       GAFFER_TRUST_LOCK_TRIES=3 GAFFER_TRUST_LOCK_SLEEP_MS=20
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
wg init >/dev/null 2>&1; lg init >/dev/null 2>&1
wg repo add -n repo --path "$R" --branch main --test "npm test" --lint "npm run lint" >/dev/null 2>&1

if command -v perl >/dev/null 2>&1; then BOUND=(perl -e 'alarm shift; exec @ARGV' 240); else BOUND=(); fi
run_tick() { ( cd "$RUNNER_DIR" && ${BOUND[@]+"${BOUND[@]}"} bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep '^TICK_RESULT=' ; }
st() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.status'; }
ncalls() { wc -l < "$CALLS" | tr -d ' '; }
new_ticket() {
  local n
  n="$(wg ticket create -t "$1" -d "add a helper" 2>/dev/null | jget 'd.ticket.number')"
  wg ac add "$n" -t "helper added" >/dev/null 2>&1
  wg ticket repo-access set "$n" repo --access write --relation confirmed >/dev/null 2>&1
  wg ticket ready "$n" >/dev/null 2>&1
  printf '%s' "$n"
}
trusted() { node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(c.projects?.[process.argv[2]]?.hasTrustDialogAccepted===true?0:1)' "$CONF" "$1" 2>/dev/null; }

echo "== A. control: a writable config → the delivery runs and trust is recorded =="
NA="$(new_ticket "Trust control")"
OUT="$(run_tick)"
[ "$(st "$NA")" = "in_review" ] && ok "A: #$NA delivered → in_review ($OUT)" || fail "A: #$NA is '$(st "$NA")' ($OUT): $(tail -5 "$GAFFER_DATA/factory.log" | tr '\n' '|')"
[ "$(ncalls)" -ge 1 ] && ok "A: the stub agent was spawned ($(ncalls) call(s))" || fail "A: no agent call logged"
trusted "$R" && ok "A: the main repo root is trusted in the scratch ~/.claude.json" || fail "A: no trust entry for $R in $CONF"
[ ! -e "$LOCK" ] && ok "A: no trust lock left behind" || fail "A: a trust lock was left at $LOCK"

echo "== B. unparseable ~/.claude.json → the review pass holds, no reviewer launched =="
echo approve > "$MODE_FILE"; rm -f "$GAFFER_DATA/.reviewed-tickets"
printf '{ "projects": { broken' > "$CONF"; cp "$CONF" "$WORK/conf.junk"
C0="$(ncalls)"
OUT="$(REVIEW_MODE=agent run_tick)"
[ "$(ncalls)" = "$C0" ] && ok "B: no reviewer agent was launched ($OUT)" || fail "B: $(( $(ncalls) - C0 )) agent call(s) made with trust unwritten"
grep -q "REVIEW-HELD: #$NA cannot be agent-reviewed — .*trust" "$GAFFER_DATA/factory.log" \
  && ok "B: REVIEW-HELD names the trust failure" || fail "B: no REVIEW-HELD naming trust: $(grep -E 'REVIEW|TRUST' "$GAFFER_DATA/factory.log" | tail -4 | tr '\n' '|')"
[ "$(st "$NA")" = "in_review" ] && ok "B: #$NA stays in_review for a human" || fail "B: #$NA became '$(st "$NA")'"
cmp -s "$CONF" "$WORK/conf.junk" && ok "B: the unparseable config is left untouched" || fail "B: the config was modified"

echo "== C. the same config → a delivery tick parks before any agent call =="
echo deliver > "$MODE_FILE"
NB="$(new_ticket "Trust blocked")"
C0="$(ncalls)"
OUT="$(run_tick)"
[ "$OUT" = "TICK_RESULT=setup_error" ] && ok "C: the tick ends setup_error" || fail "C: tick → '$OUT'"
[ "$(ncalls)" = "$C0" ] && ok "C: no agent was spawned (stub log unchanged)" || fail "C: $(( $(ncalls) - C0 )) agent call(s) made with trust unwritten"
[ "$(st "$NB")" = "ready" ] && ok "C: #$NB released back to ready (nothing stranded)" || fail "C: #$NB is '$(st "$NB")'"
grep -q "trust_unwritable" "$GAFFER_DATA/.setup-error" 2>/dev/null \
  && ok "C: .setup-error carries trust_unwritable" || fail "C: .setup-error: $(cat "$GAFFER_DATA/.setup-error" 2>/dev/null)"
grep -q "trust_unwritable.*not valid JSON" "$GAFFER_DATA/factory.log" \
  && ok "C: the log quotes trust-workspace's stderr" || fail "C: no trust_unwritable line quoting the cause: $(grep -E 'TRUST' "$GAFFER_DATA/factory.log" | tail -3 | tr '\n' '|')"
grep -q "trust_unwritable.*fix ~/.claude.json" "$GAFFER_DATA/factory.log" \
  && ok "C: the log names the fix" || fail "C: the trust_unwritable line names no fix"
wg ticket show "$NB" 2>/dev/null | grep -q "trust_unwritable" \
  && ok "C: the release reason on the ticket says trust_unwritable" || fail "C: no trust_unwritable in #$NB's trail"

echo "== D. a lock held by a LIVE process → the same refusal, the fix names the lock =="
printf '{ "projects": {} }\n' > "$CONF"
sleep 120 & SLEEPER=$!
printf '{"pid":%s}\n' "$SLEEPER" > "$LOCK"
rm -f "$GAFFER_DATA/.failed-tickets" "$GAFFER_DATA/.setup-error"
C0="$(ncalls)"
OUT="$(run_tick)"
[ "$OUT" = "TICK_RESULT=setup_error" ] && ok "D: the tick ends setup_error" || fail "D: tick → '$OUT'"
[ "$(ncalls)" = "$C0" ] && ok "D: no agent was spawned" || fail "D: $(( $(ncalls) - C0 )) agent call(s) made under a held lock"
[ "$(st "$NB")" = "ready" ] && ok "D: #$NB back to ready" || fail "D: #$NB is '$(st "$NB")'"
grep -q "trust_unwritable.*remove the stale lock" "$GAFFER_DATA/factory.log" \
  && ok "D: the fix names the lock" || fail "D: no lock fix: $(grep -E 'TRUST' "$GAFFER_DATA/factory.log" | tail -2 | tr '\n' '|')"
grep -q "$SLEEPER" "$LOCK" 2>/dev/null && ok "D: the live holder's lock is left alone" || fail "D: the live lock was removed"

echo "== E. the holder dies → the next tick takes the stale lock over and delivers =="
kill "$SLEEPER" 2>/dev/null; wait "$SLEEPER" 2>/dev/null; SLEEPER=""
rm -f "$GAFFER_DATA/.failed-tickets" "$GAFFER_DATA/.setup-error"
C0="$(ncalls)"
OUT="$(run_tick)"
[ "$(st "$NB")" = "in_review" ] && ok "E: #$NB delivered ($OUT)" || fail "E: #$NB is '$(st "$NB")' ($OUT): $(grep -E 'TRUST|SAFETY' "$GAFFER_DATA/factory.log" | tail -3 | tr '\n' '|')"
[ "$(ncalls)" -gt "$C0" ] && ok "E: the agent ran once trust was written" || fail "E: no agent call"
grep -q "took over a stale lock" "$GAFFER_DATA/factory.log" "$GAFFER_DATA/tick.stderr.log" 2>/dev/null \
  && ok "E: one line says the stale lock was taken over" || fail "E: no takeover line logged"
[ ! -e "$LOCK" ] && ok "E: no lock left behind" || fail "E: lock left at $LOCK"

echo "== F. a stale EMPTY lock (the live run's leftover) is taken over =="
NC="$(new_ticket "Trust empty lock")"
: > "$LOCK"; touch -t 202611040000 "$LOCK"
C0="$(ncalls)"
OUT="$(run_tick)"
[ "$(st "$NC")" = "in_review" ] && [ "$(ncalls)" -gt "$C0" ] && ok "F: #$NC delivered over a stale empty lock ($OUT)" \
  || fail "F: #$NC is '$(st "$NC")' ($OUT), calls +$(( $(ncalls) - C0 ))"
[ ! -e "$LOCK" ] && ok "F: the stale empty lock is gone (taken over, then released)" || fail "F: the stale empty lock is still at $LOCK"

echo "== G. the independent tester refuses to launch untrusted too =="
ND="$(wg ticket create -t "Trust tester" -d "add a helper" --risk low 2>/dev/null | jget 'd.ticket.number')"
wg ac add "$ND" -t "helper added" >/dev/null 2>&1
wg ticket repo-access set "$ND" repo --access write --relation confirmed >/dev/null 2>&1
wg ticket set-testable "$ND" >/dev/null 2>&1; wg ticket ready "$ND" >/dev/null 2>&1
OUT="$(GAFFER_TESTING=1 run_tick)"
if [ "$(st "$ND")" = "in_testing" ]; then
  ok "G: #$ND delivered and sent to the tester ($OUT)"
  printf '{ broken' > "$CONF"
  C0="$(ncalls)"
  TOUT="$(cd "$RUNNER_DIR" && ${BOUND[@]+"${BOUND[@]}"} node bin/tester-run.mjs --ticket "$ND" --live 2>&1)"; trc=$?
  [ "$(ncalls)" = "$C0" ] && ok "G: no tester agent was spawned with trust unwritten" || fail "G: $(( $(ncalls) - C0 )) tester agent call(s) made untrusted"
  grep -q "trust_unwritable" <<<"$TOUT" && [ "$trc" -ne 0 ] \
    && ok "G: tester-run refuses with trust_unwritable (exit $trc)" || fail "G: tester-run rc=$trc: $(printf '%s' "$TOUT" | tail -3 | tr '\n' '|' | cut -c1-300)"
  [ ! -e "$GAFFER_DATA/worktrees/tester-$ND" ] && ok "G: the tester workspace is torn down" || fail "G: tester-$ND left behind"
  printf '{ "projects": {} }\n' > "$CONF"
  C0="$(ncalls)"
  TOUT="$(cd "$RUNNER_DIR" && ${BOUND[@]+"${BOUND[@]}"} node bin/tester-run.mjs --ticket "$ND" --live 2>&1)"
  [ "$(ncalls)" -gt "$C0" ] && ok "G: control: with a writable config the tester agent runs" || fail "G: control: no tester call: $(printf '%s' "$TOUT" | tail -3 | tr '\n' '|' | cut -c1-300)"
  node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(Object.keys(c.projects||{}).some(k=>k.endsWith("/tester-"+process.argv[2]))?0:1)' "$CONF" "$ND" \
    && ok "G: control: the tester worktree was trusted" || fail "G: control: no trust entry for the tester worktree"
else
  fail "G: #$ND is '$(st "$ND")' after delivery ($OUT), expected in_testing"
fi

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
