#!/usr/bin/env bash
# =====================================================================
# eval-judge.sh — post-delivery quality judging into the eval ledger.
# Proves the seam WITHOUT any live model: worker_deliver is stubbed to emit a
# canned judge reply, so this exercises the real prompt render, envelope parse,
# verdict parse, and ledger append end-to-end.
#   A  wiring: sourced by factory.config.sh; tick.sh calls it post-submit only
#   B  default OFF → no-op (telemetry is opt-in for the soak)
#   C  DRY_RUN → no-op even when enabled
#   D  happy path → ONE ledger record with verdict + context + real spend
#   E  FAIL-SOFT: a dead judge turn (worker rc 70, empty envelope) records
#      NOTHING (an infra failure must not poison the metric) and exits 0
#   F  empty diff → no-op (never spawns the worker)
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
CREW_DIR="$ROOT/packages/crew"

command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 required"; exit 0; }
[ -f "$CREW_DIR/dist/eval/deliveryJudgeCli.js" ] || { echo "SKIP: crew not built — run pnpm -C packages/crew build"; exit 0; }

pass=0; fail=0
ok() { echo "  ok   $1"; pass=$((pass + 1)); }
no() { echo "  FAIL $1"; fail=$((fail + 1)); }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/eval-judge-t.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
export GAFFER_DATA="$WORK/.gaffer"; mkdir -p "$GAFFER_DATA"
export RUNNER_DIR CREW_DIR
LEDGER="$GAFFER_DATA/eval-ledger.jsonl"

echo "== A. wiring =="
grep -q 'lib/eval-judge.sh' "$RUNNER_DIR/factory.config.sh" \
  && ok "factory.config.sh sources lib/eval-judge.sh" || no "factory.config.sh missing the eval-judge source"
grep -q 'gaffer_eval_judge_delivery "\$NUM"' "$RUNNER_DIR/tick.sh" \
  && ok "tick.sh invokes the judge for the submitted ticket" || no "tick.sh missing the judge call"
# The call must live INSIDE the submit-success branch (after gaffer_submit_delivery).
awk '/if gaffer_submit_delivery "delivered on branch/,/^  else$/' "$RUNNER_DIR/tick.sh" \
  | grep -q 'gaffer_eval_judge_delivery' \
  && ok "judge call is inside the submit-success branch (post-submit telemetry)" \
  || no "judge call is not in the submit-success branch"
bash -n "$RUNNER_DIR/lib/eval-judge.sh" && ok "eval-judge.sh parses (bash -n)" || no "eval-judge.sh syntax error"

# ── Fixture: a real repo with a base branch and a delivered work branch. ──
REPO="$WORK/repo"
git init -q -b main "$REPO"
git -C "$REPO" config user.email t@t; git -C "$REPO" config user.name t
printf 'export const x = 1;\n' > "$REPO/app.ts"
git -C "$REPO" add -A && git -C "$REPO" commit -qm base
git -C "$REPO" checkout -qb gaffer/ticket-9
printf 'export const x = 2; // rotated\n' > "$REPO/app.ts"
git -C "$REPO" commit -qam "deliver"
git -C "$REPO" checkout -q main

export SHOW='{"title":"Rotate the constant","acceptanceCriteria":[{"id":"AC1","text":"x becomes 2"}]}'

# ── Stub worker: capture the judge prompt, emit a canned PASS reply envelope. ──
WORKER_CALLS="$WORK/worker-calls"; : > "$WORKER_CALLS"
worker_deliver() { # cwd prompt model_flag mcp out_json [wrap]
  printf '%s\n' "CALLED" >> "$WORKER_CALLS"
  printf '%s' "$2" > "$WORK/last-prompt.txt"
  REPLY_OUT="$5" python3 - <<'PY'
import json, os
reply = "```json\n" + json.dumps({
    "dimensions": [
        {"dimension": d, "score": 5, "rationale": "solid"}
        for d in ["ac_coverage", "correctness", "minimalism", "test_adequacy", "security"]
    ],
    "summary": "minimal and correct",
}) + "\n```"
with open(os.environ["REPLY_OUT"], "w") as f:
    json.dump({"result": reply, "num_turns": 1, "total_cost_usd": 0.02}, f)
PY
}
log() { :; }

# shellcheck source=../lib/eval-judge.sh
source "$RUNNER_DIR/lib/eval-judge.sh"

echo "== B. default OFF → no-op =="
unset GAFFER_EVAL_JUDGE
gaffer_eval_judge_delivery 9 "$REPO" main gaffer/ticket-9 1 '$0.1234'; rc=$?
[ "$rc" -eq 0 ] && [ ! -f "$LEDGER" ] && [ ! -s "$WORKER_CALLS" ] \
  && ok "flag off: exit 0, no ledger, no worker spawn" || no "flag off should be a full no-op (rc=$rc)"

echo "== C. DRY_RUN → no-op =="
export GAFFER_EVAL_JUDGE=1
DRY_RUN=1 gaffer_eval_judge_delivery 9 "$REPO" main gaffer/ticket-9 1 '$0.1234'; rc=$?
[ "$rc" -eq 0 ] && [ ! -f "$LEDGER" ] && [ ! -s "$WORKER_CALLS" ] \
  && ok "DRY_RUN: exit 0, nothing recorded" || no "DRY_RUN should be a no-op (rc=$rc)"

echo "== D. happy path → one scored ledger record =="
gaffer_eval_judge_delivery 9 "$REPO" main gaffer/ticket-9 1 '$0.1234'; rc=$?
[ "$rc" -eq 0 ] && ok "judge run exits 0" || no "judge run failed (rc=$rc)"
[ -s "$LEDGER" ] && [ "$(wc -l < "$LEDGER")" -eq 1 ] \
  && ok "exactly one ledger record appended" || no "expected 1 ledger line (got: $(wc -l < "$LEDGER" 2>/dev/null || echo none))"
python3 - "$LEDGER" <<'PY' && ok "record carries verdict + context + spend" || no "ledger record fields wrong"
import json, sys
r = json.loads(open(sys.argv[1]).read().splitlines()[0])
assert r["ticketId"] == "9", r
assert r["repo"] == "repo", r
assert r["overall"] == "pass" and r["score"] == 5, r
assert r["memoryPresent"] is True, r
assert abs(r["costUsd"] - 0.1234) < 1e-9, r
assert r["dims"]["security"] == 5, r
assert r["ts"], r
PY
grep -q '<untrusted-delivery-diff>' "$WORK/last-prompt.txt" \
  && ok "judge prompt quarantined the diff (untrusted envelope)" || no "prompt missing the quarantine envelope"
grep -q 'AC1' "$WORK/last-prompt.txt" \
  && ok "judge prompt carries the acceptance criteria" || no "prompt missing the ACs"

echo "== E. FAIL-SOFT: dead judge turn records NOTHING =="
worker_deliver() { : > "$5"; return 70; }   # provider fail-closed: empty envelope
gaffer_eval_judge_delivery 9 "$REPO" main gaffer/ticket-9 0 ''; rc=$?
[ "$rc" -eq 0 ] && ok "worker failure: still exit 0 (never blocks the delivery)" || no "worker failure leaked rc=$rc"
[ "$(wc -l < "$LEDGER")" -eq 1 ] \
  && ok "no fake quality-fail recorded on an infra failure" || no "infra failure polluted the ledger"

echo "== F. empty diff → no-op, no spawn =="
: > "$WORKER_CALLS"
worker_deliver() { printf 'CALLED\n' >> "$WORKER_CALLS"; }
gaffer_eval_judge_delivery 9 "$REPO" main main 0 ''; rc=$?
[ "$rc" -eq 0 ] && [ ! -s "$WORKER_CALLS" ] \
  && ok "no diff: exit 0 and the worker is never spawned" || no "empty diff should skip the spawn (rc=$rc)"

echo ""
echo "eval-judge: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
