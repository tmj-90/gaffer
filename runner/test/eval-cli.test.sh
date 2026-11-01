#!/usr/bin/env bash
# =====================================================================
# `gaffer eval` — the operator's view of the eval ledger (docs/eval-harness.md).
# Drives the REAL dispatcher + crew CLIs over a seeded temp ledger:
#   A  help lists the subcommand and names the memory score gap (never 'memory lift')
#   B  empty ledger → friendly enable-hint, exit 0
#   C  seeded ledger → human view carries pass rate, memory score gap, cost/pass
#   D  --json emits the raw summary (parses; gap matches)
#   E  cost per accepted change counts every attempt (parked, failed, abandoned)
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

echo "== E. every attempt counted: cost per accepted change (external review #9) =="
# The judge only saw tickets 1 and 2 above. The usage ledger holds every attempt: #1
# reached done after two delivery attempts and a review; #2 was parked after three
# attempts; #3 was abandoned after one. None of #2's or #3's spend is in cost/pass.
D="$ROOT/packages/dispatch/dist/cli/index.js"
if [ -f "$D" ]; then
  DB="$GAFFER_DATA/dispatch.sqlite"
  node "$D" --db "$DB" init >/dev/null 2>&1
  for t in done-one parked-two abandoned-three; do node "$D" --db "$DB" ticket create -t "$t" -d x >/dev/null 2>&1; done
  node --no-warnings -e '
const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1]);
db.prepare("UPDATE tickets SET status = ? WHERE number = 1").run("done");
db.prepare("UPDATE tickets SET status = ? WHERE number = 2").run("blocked");
db.prepare("UPDATE tickets SET status = ? WHERE number = 3").run("cancelled");' "$DB"
  U="$GAFFER_DATA/usage-ledger.jsonl"
  {
    printf '{"ts":"2026-08-24T00:00:00Z","ticket":1,"kind":"delivery","attempt_id":"c1/1","measured":true,"total_cost_usd":1.0}\n'
    printf '{"ts":"2026-08-24T00:10:00Z","ticket":1,"kind":"delivery","attempt_id":"c1/2","measured":true,"total_cost_usd":1.0}\n'
    printf '{"ts":"2026-08-24T00:20:00Z","ticket":1,"kind":"review","measured":true,"total_cost_usd":0.5}\n'
    printf '{"ts":"2026-08-24T01:00:00Z","ticket":2,"kind":"delivery","attempt_id":"c2/1","measured":true,"total_cost_usd":1.0}\n'
    printf '{"ts":"2026-08-24T01:10:00Z","ticket":2,"kind":"delivery","attempt_id":"c2/2","measured":true,"total_cost_usd":1.0}\n'
    printf '{"ts":"2026-08-24T01:20:00Z","ticket":2,"kind":"delivery","attempt_id":"c2/3","measured":true,"total_cost_usd":1.0}\n'
    printf '{"ts":"2026-08-24T02:00:00Z","ticket":3,"kind":"delivery","attempt_id":"c3/1","measured":true,"total_cost_usd":0.5}\n'
    printf '{"ts":"2026-08-24T02:30:00Z","kind":"onboard","measured":true,"total_cost_usd":2.0}\n'
  } > "$U"
  OUT="$(bash "$RUNNER_DIR/gaffer" eval 2>&1)"
  grep -q 'per accepted change \$6.00 (every attempt counted: \$6.00 over 1 done; \$3.50 of it on parked, failed or abandoned tickets) / 6 attempts each' <<<"$OUT" \
    && ok "gaffer eval: \$6.00 per accepted change, 6 attempts each, the parked and abandoned spend named" || no "no accepted-change line: $OUT"
  S="$(node "$D" --db "$DB" stats --json 2>/dev/null)"
  printf '%s' "$S" | node -e '
const s = JSON.parse(require("fs").readFileSync(0, "utf8")).acceptedChange;
const want = { accepted_changes: 1, attributed_spend_usd: 6, unattributed_usd: 2, cost_per_accepted_change_usd: 6, accepted_only_cost_per_change_usd: 2.5, attempts_per_accepted_change: 6 };
for (const [k, v] of Object.entries(want)) if (s[k] !== v) { console.error(k, s[k]); process.exit(1); }
if (s.by_outcome.parked_or_failed.spend_usd !== 3 || s.by_outcome.abandoned.spend_usd !== 0.5) process.exit(1);
if (!Array.isArray(s.limits) || s.limits.length < 3) process.exit(1);' \
    && ok "wg stats --json: every attempt over accepted changes; parked/abandoned spend and the onboarding spend reported apart" || no "wg stats acceptedChange wrong: $(printf '%s' "$S" | head -c 600)"
  grep -q 'Cost per accepted change: \$6.00 (all attempts' <<<"$(node "$D" --db "$DB" stats 2>/dev/null)" \
    && ok "wg stats prints the cost per accepted change" || no "wg stats text has no accepted-change line"
else
  echo "  ok SKIP E: dispatch not built"
fi

echo ""
echo "eval-cli: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
