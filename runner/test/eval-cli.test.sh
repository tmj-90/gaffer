#!/usr/bin/env bash
# =====================================================================
# `gaffer eval` — the operator's view of the eval ledger (docs/eval-harness.md).
# Drives the REAL dispatcher + crew CLIs over a seeded temp ledger:
#   A  help lists the subcommand and names the memory score gap (never 'memory lift')
#   B  empty ledger → friendly enable-hint, exit 0
#   C  seeded ledger → human view carries pass rate, memory score gap, cost/pass
#   D  --json emits the raw summary (parses; gap matches)
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
CLI="$ROOT/packages/crew/dist/eval/evalLedgerCli.js"

command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 required"; exit 0; }
[ -f "$CLI" ] || { echo "SKIP: crew not built — run pnpm -C packages/crew build"; exit 0; }

pass=0; fail=0
ok() { echo "  ok   $1"; pass=$((pass + 1)); }
no() { echo "  FAIL $1"; fail=$((fail + 1)); }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/eval-cli-t.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT
export GAFFER_DATA="$WORK/gd"; mkdir -p "$GAFFER_DATA"

echo "== A. help lists eval =="
grep -q 'gaffer eval' <<<"$(bash "$RUNNER_DIR/gaffer" help 2>/dev/null)" \
  && ok "help mentions gaffer eval" || no "help missing the eval subcommand"
HELP="$(bash "$RUNNER_DIR/gaffer" help 2>/dev/null)"
grep -q 'memory score gap' <<<"$HELP" && ok "help names the memory score gap" || no "help does not say 'memory score gap'"
if grep -qi 'memory lift' <<<"$HELP"; then no "help still advertises 'memory lift'"; else ok "help never says 'memory lift'"; fi

echo "== B. empty ledger =="
OUT="$(bash "$RUNNER_DIR/gaffer" eval 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && grep -q 'GAFFER_EVAL_JUDGE=1' <<<"$OUT" \
  && ok "empty ledger: exit 0 + enable hint" || no "empty-ledger path wrong (rc=$rc): $OUT"

echo "== C. seeded ledger → human view =="
L="$GAFFER_DATA/eval-ledger.jsonl"
printf '{"ticketId":"1","repo":"api","memoryPresent":true,"overall":"pass","score":4.6,"costUsd":0.42,"dimensions":[{"dimension":"correctness","score":5}]}' \
  | node "$CLI" --mode append --file "$L" --ts 2026-08-24T00:00:00Z
printf '{"ticketId":"2","repo":"api","memoryPresent":false,"overall":"fail","score":1.8,"blocking":true,"costUsd":0.15,"dimensions":[{"dimension":"correctness","score":2}]}' \
  | node "$CLI" --mode append --file "$L" --ts 2026-08-24T01:00:00Z
OUT="$(bash "$RUNNER_DIR/gaffer" eval 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "eval exits 0 on a seeded ledger" || no "eval failed (rc=$rc): $OUT"
grep -q 'deliveries judged   2' <<<"$OUT" && ok "counts the judged deliveries" || no "missing count: $OUT"
grep -q 'memory score gap    +2.80' <<<"$OUT" && ok "surfaces the memory score gap under its honest name" || no "missing memory score gap: $OUT"
grep -q 'not an uplift' <<<"$OUT" && ok "labels it as a gap on submitted work, not an uplift" || no "no 'not an uplift' label: $OUT"
grep -q 'excludes attempts that failed before submission' <<<"$OUT" && ok "names what the judge never sees" || no "no exclusion line: $OUT"
grep -qE 'n=[0-9]+\) vs not primed .*\(n=[0-9]+\)' <<<"$OUT" && ok "shows the sample size of each arm" || no "no sample sizes: $OUT"
grep -q '/passing delivery' <<<"$OUT" && ok "surfaces cost-per-passing-delivery" || no "missing cost/pass: $OUT"

echo "== D. --json parses and matches =="
bash "$RUNNER_DIR/gaffer" eval --json 2>/dev/null | python3 -c '
import json, sys
s = json.load(sys.stdin)
assert s["count"] == 2, s
assert s["memoryLift"]["lift"] == 2.8, s
assert s["cost"]["costPerPass"] == 0.57, s
' && ok "--json emits the parseable summary (lift 2.8, cost/pass 0.57)" || no "--json output wrong"

echo ""
echo "eval-cli: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
