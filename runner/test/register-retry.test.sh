#!/usr/bin/env bash
# The tick registers the factory agent and the reviewer principal on its first run in a
# data dir (lib/tick-claim.sh gaffer_tick_register_agents). Two workers of a pool reach
# that point together and both register at once; the one that lost the database lock
# used to end the whole pool as "SETUP: could not register the reviewer principal"
# (macOS CI, parallel-stop P2). This pins:
#   1. a registration that fails once and then succeeds does not stop the tick, and the
#      log says which attempt registered it;
#   2. a registration that keeps failing still stops the tick (fail closed), after
#      three attempts, and the abort quotes what wg said.
# The dispatch CLI is a stub whose `agent register` fails the first N calls (a counter
# file), so no real database is involved.
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
TICK="$RUNNER_DIR/tick.sh"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/register-retry.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
trap 'gaffer_test_rm_work "$WORK"' EXIT

# ── Stub dispatch CLI: `agent register` fails while the counter is below FAIL_FIRST ──
DISPATCH_DIR="$WORK/dispatch"
mkdir -p "$DISPATCH_DIR/dist/cli"
cat > "$DISPATCH_DIR/dist/cli/index.js" <<'JS'
const fs = require("node:fs");
const a = process.argv.slice(2);
const has = (...t) => t.every((x) => a.includes(x));
const out = (o) => process.stdout.write(JSON.stringify(o));
if (has("agent", "register")) {
  const counter = process.env.REG_COUNTER;
  const n = Number(fs.existsSync(counter) ? fs.readFileSync(counter, "utf8") : "0") + 1;
  fs.writeFileSync(counter, String(n));
  if (n <= Number(process.env.REG_FAIL_FIRST || "0")) {
    process.stderr.write("Error: SQLITE_BUSY: database is locked\n");
    process.exit(1);
  }
  const name = a[a.indexOf("-n") + 1] || "agent";
  out({ agent: { id: `stub-${name}` } });
} else if (has("ticket", "resume-requested")) out([]);
else if (has("ticket", "list")) out([]);
else out({});
JS

# run_tick <fail-first> → combined output of one dry-run tick on a fresh data dir
run_tick() {
  local data="$WORK/data-$1"; rm -rf "$data"; mkdir -p "$data"
  REG_COUNTER="$WORK/counter-$1" REG_FAIL_FIRST="$1" \
  RUNNER_DIR="$RUNNER_DIR" GAFFER_HOME="$WORK" GAFFER_DATA="$data" \
  DISPATCH_DIR="$DISPATCH_DIR" CREW_DIR="$WORK/crew-absent" \
  DRY_RUN=1 CLARIFY_DRAFTS_WHEN_IDLE=0 GAFFER_MAINTENANCE=0 \
  env -u GAFFER_DRY_PREVIEWED_FILE bash "$TICK" 2>&1
}

echo "== 1: one failed registration is retried, the tick goes on =="
OUT1="$(run_tick 1 || true)"
grep -q "TICK_RESULT=setup_error" <<<"$OUT1" \
  && fail "one failed registration stopped the tick: $(grep -E 'SETUP' <<<"$OUT1" | head -2 | tr '\n' ' ')" \
  || ok "the tick did not stop on one failed registration"
grep -q "SETUP: registered the factory agent on attempt 2" <<<"$OUT1" \
  && ok "the log says the factory agent registered on attempt 2" \
  || fail "no attempt line (got: $(grep -E 'SETUP|register' <<<"$OUT1" | head -3 | tr '\n' ' '))"
[ -s "$WORK/data-1/agent_id" ] && [ -s "$WORK/data-1/agent_reviewer_id" ] \
  && ok "both id files were written" \
  || fail "id files: $(ls "$WORK/data-1" 2>/dev/null | tr '\n' ' ')"
[ "$(cat "$WORK/counter-1")" = "3" ] \
  && ok "wg agent register was called three times (one failure, two registrations)" \
  || fail "register calls: $(cat "$WORK/counter-1" 2>/dev/null)"

echo "== 2: a registration that keeps failing stops the tick after three attempts =="
OUT2="$(run_tick 99 || true)"
grep -q "TICK_RESULT=setup_error" <<<"$OUT2" \
  && ok "the tick stops as a setup error (fail closed)" \
  || fail "no setup_error: $(grep -o 'TICK_RESULT=[a-z_]*' <<<"$OUT2" | tail -1)"
grep -q "could not register the factory agent after 3 attempts: .*database is locked" <<<"$OUT2" \
  && ok "the abort names the attempts and quotes wg's error" \
  || fail "abort line: $(grep -E 'SETUP' <<<"$OUT2" | head -2 | tr '\n' ' ')"
[ "$(cat "$WORK/counter-99")" = "3" ] \
  && ok "exactly three attempts were made" \
  || fail "register calls: $(cat "$WORK/counter-99" 2>/dev/null)"
[ ! -s "$WORK/data-99/agent_id" ] && ok "no half-written id file is left behind" || fail "agent_id left: $(cat "$WORK/data-99/agent_id")"

echo
if [ ${#FAILURES[@]} -eq 0 ]; then echo "register-retry: all $PASS checks passed"; exit 0; fi
echo "register-retry: ${#FAILURES[@]} FAILED (of $((PASS + ${#FAILURES[@]})))"; exit 1
