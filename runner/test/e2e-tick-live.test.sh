#!/usr/bin/env bash
# =====================================================================
# E2E LIVE WORKER PATH — the PRODUCTION delivery seam, end to end.
# ---------------------------------------------------------------------
# The keystone the audit asked for: a hermetic run that drives the REAL
# `worker_deliver` seam (lib/worker.sh) — the actual
#   cd <worktree> && env -i <allowlist> "$CLAUDE_BIN" -p … --output-format json
# spawn the live factory uses — with a stub-but-real agent (writes a real file,
# commits it, emits the `{result}` envelope, spends nothing), then runs the REAL
# DoD + hygiene gates on the REAL diff and the REAL token-gated submit.
#
# Why this is different from e2e-lifecycle.test.sh: that test runs the stub agent
# DIRECTLY and hand-composes the steps. This one runs the stub agent THROUGH
# `worker_deliver` — the production spawn seam — so it proves the WIRING: that
# worker_deliver runs the agent in the delivery worktree, under the scrubbed env,
# and that the agent's committed change becomes the reviewable diff the gates see.
# It would catch a worker_deliver that spawned in the wrong dir, dropped the change,
# never ran the agent, or lost the envelope — the "tested-but-not-real" failure mode.
#
# Flow (each step REAL production code):
#   ready ticket + claim (token) → git worktree → worker_deliver (REAL env-i spawn of
#   the stub) → assert real committed diff + captured envelope → REAL DoD gate (dod.sh)
#   + REAL hygiene gate (hygiene.sh) on that diff → REAL token-gated submit → in_review
#   with the claim completed.
#
# Requires the dispatch CLI built + git. SKIPs (exit 0) otherwise.
# Run: bash test/e2e-tick-live.test.sh    (also green under /bin/bash 3.2)
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
CLI_JS="$ROOT/packages/dispatch/dist/cli/index.js"

command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 required"; exit 0; }
[ -f "$CLI_JS" ] || { echo "SKIP: dispatch CLI not built ($CLI_JS)"; exit 0; }

PASS=0
FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/e2e-tick-live.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
DB="$WORK/dispatch.sqlite"
REPO="$WORK/repo"
export GAFFER_DATA="$WORK"

wg()   { node "$CLI_JS" --db "$DB" "$@"; }
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }
status_of() { wg ticket show "$1" 2>/dev/null | jget "d['ticket']['status']" 2>/dev/null || echo ''; }
active_claims() {
  python3 - "$DB" "$1" <<'PY'
import sqlite3,sys
db,num=sys.argv[1],int(sys.argv[2]); c=sqlite3.connect(db)
print(c.execute("SELECT count(*) FROM ticket_claims tc JOIN tickets t ON t.id=tc.ticket_id "
                "WHERE t.number=? AND tc.status='active'",(num,)).fetchone()[0])
PY
}

# ── A real on-disk git repo: main + a test command that PASSES ────────────────
git init -q -b main "$REPO"
git -C "$REPO" config user.email gaffer@test
git -C "$REPO" config user.name gaffer-test
mkdir -p "$REPO/src"
printf 'export const x = 1;\n' > "$REPO/src/x.ts"
git -C "$REPO" add -A
git -C "$REPO" commit -qm "init"

# ── Dispatch: repo + ready ticket + AC + runner claim (token) ────────────────
wg init >/dev/null 2>&1
wg repo add -n demo --path "$REPO" --branch main --test "true" >/dev/null 2>&1
NUM="$(wg ticket create -t "Add a delivered line" --description "the factory delivers a trivial change" --policy team_light --risk low 2>/dev/null | jget "d['ticket']['number']")"
ACID="$(wg ac add "$NUM" -t "the line is added" 2>/dev/null | jget "d['ac_id']")"
wg ticket repo-access set "$NUM" demo --access write --relation confirmed >/dev/null 2>&1
wg ticket ready "$NUM" >/dev/null 2>&1
AGENT="$(wg agent register -n gaffer-factory --max-risk high 2>/dev/null | jget "d['agent']['id']")"
TOKEN="$(wg claim-ticket "$NUM" --agent "$AGENT" --ttl 900 2>/dev/null | jget "d['claimToken']")"
{ [ -n "$NUM" ] && [ -n "$TOKEN" ] && [ "$(status_of "$NUM")" = "claimed" ]; } \
  && ok "setup: #$NUM ready → claimed with a claim token" \
  || fail "setup failed (num=$NUM token=${TOKEN:+set} status=$(status_of "$NUM"))"

# ── The delivery worktree the runner would create ────────────────────────────
BRANCH="gaffer/t$NUM"
WT="$WORK/wt-$NUM"
git -C "$REPO" worktree add -q -b "$BRANCH" "$WT" main

# ── The STUB agent — spawned BY worker_deliver under `env -i` (cwd = worktree).
# It makes a REAL, hygienic, COMMITTED change (tick.sh treats a no-commit delivery
# as unrecoverable) and emits the claude `--output-format json` envelope. No tokens. ─
STUB="$WORK/stub-claude.sh"
cat > "$STUB" <<'STUBSH'
#!/usr/bin/env bash
set -uo pipefail
# worker_deliver cd's here; the change + commit prove the agent ran in the worktree.
printf '// delivered by the live stub worker\n' >> ./src/x.ts
git -c user.email=stub@test -c user.name=stub add -A
git -c user.email=stub@test -c user.name=stub commit -qm "stub: live worker delivery"
printf '{"type":"result","subtype":"success","is_error":false,"result":"delivered"}\n'
STUBSH
chmod +x "$STUB"

# ── Harness for the REAL worker_deliver seam ─────────────────────────────────
# gaffer_timeout: faithful relay (same shim dod-gate uses). gaffer_agent_env: a
# minimal allowlist (PATH+HOME so the stub's bash + git run) — the FULL credential
# scrub is pinned by the agent-env tests; here we exercise worker_deliver's SPAWN
# wiring (cwd, env -i, CLAUDE_BIN, envelope capture), not the allowlist contents.
gaffer_timeout()   { shift; "$@"; return $?; }
gaffer_agent_env() { GAFFER_AGENT_ENV=("PATH=$PATH" "HOME=$HOME"); }
export CLAUDE_BIN="$STUB" CLAUDE_FLAGS="" GAFFER_MAX_TURNS_FLAG="" \
       GAFFER_TICK_TIMEOUT=60 GAFFER_LOG="$WORK/gaffer.log" GAFFER_WORKER_PROVIDER=claude-code
: > "$GAFFER_LOG"
# shellcheck source=../lib/worker.sh
source "$RUNNER_DIR/lib/worker.sh"
MCP="$WORK/mcp.json"; echo '{}' > "$MCP"
OUT="$WORK/out.json"
# The per-call boundary env tick.sh layers on top of the allowlist at the delivery site.
WORKER_CALL_ENV=("GAFFER_WRITE_ROOTS=$WT" "GAFFER_READ_ROOTS=" "GAFFER_DATA=$WORK" "GAFFER_TICKET=$NUM" "DISPATCH_DB=$DB")

echo "== DELIVER: drive the REAL worker_deliver seam (production env-i claude spawn) =="
worker_deliver "$WT" "deliver #$NUM" "" "$MCP" "$OUT"; wrc=$?
[ "$wrc" -eq 0 ] && ok "worker_deliver returned 0 (the stub agent ran under env -i)" || fail "worker_deliver rc=$wrc (log: $(tail -1 "$GAFFER_LOG" 2>/dev/null))"
grep -q '"result"' "$OUT" 2>/dev/null && ok "worker_deliver captured the --output-format json envelope to \$out_json" || fail "no {result} envelope captured (got: $(head -c 80 "$OUT" 2>/dev/null))"
DIFF_LINES="$(git -C "$WT" diff --numstat main...HEAD | wc -l | tr -d ' ')"
[ "$DIFF_LINES" -ge 1 ] \
  && ok "worker_deliver ran the agent IN THE WORKTREE — a real committed diff vs main" \
  || fail "no diff on $BRANCH — worker_deliver did not run the agent in the worktree"

echo "== GATES: the REAL DoD + hygiene gates run on the delivered diff =="
export HYGIENE_FORBIDDEN_PATHS="node_modules .crew/ *.events.jsonl"
# shellcheck source=../lib/dod.sh
source "$RUNNER_DIR/lib/dod.sh"
# shellcheck source=../lib/hygiene.sh
source "$RUNNER_DIR/lib/hygiene.sh"
DOD="$WORK/dod.results"
printf 'demo\t%s\t1\t0\t0\ttrue\t-\t-\n' "$WT" | gaffer_run_dod_gates "$DOD"; drc=$?
{ [ "$drc" -eq 0 ] && grep -q 'GATE	tests	demo	PASS' "$DOD"; } \
  && ok "REAL DoD gate PASSED on the delivered diff (tests gate ran 'true')" \
  || fail "DoD gate did not pass (rc=$drc): $(cat "$DOD" 2>/dev/null)"
gaffer_assert_clean_delivery "$WT" main >/dev/null 2>&1 \
  && ok "REAL hygiene gate PASSED (clean, minimal diff)" \
  || fail "hygiene gate wrongly flagged a clean delivery"

echo "== SUBMIT: the REAL token-gated submit completes the claim → in_review =="
wg ticket repo-delivery record "$NUM" demo --branch "$BRANCH" >/dev/null 2>&1
wg submit "$NUM" --token "$TOKEN" --reason "gates passed" >/dev/null 2>&1
[ "$(status_of "$NUM")" = "in_review" ] \
  && ok "REAL submit moved #$NUM claimed → in_review (the human gate)" \
  || fail "#$NUM not in_review after submit (got '$(status_of "$NUM")')"
[ "$(active_claims "$NUM")" = "0" ] \
  && ok "submit COMPLETED the claim — zero active claims on #$NUM" \
  || fail "claim not completed after submit (active=$(active_claims "$NUM"))"

# ── summary ──────────────────────────────────────────────────────────────────
echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "e2e-tick-live: ALL $PASS checks passed"
  exit 0
fi
echo "e2e-tick-live: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
