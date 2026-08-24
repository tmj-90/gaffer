#!/usr/bin/env bash
# =====================================================================
# eval-judge.sh — post-delivery quality judging into the eval ledger.
# ---------------------------------------------------------------------
# Runs the independent delivery-quality judge (crew: deliveryJudgeCli) over a
# JUST-SUBMITTED delivery and appends the scored verdict to the eval ledger
# ($GAFFER_DATA/eval-ledger.jsonl, crew: evalLedgerCli). This is how the factory
# MEASURES itself: pass rate, per-dimension quality, cost-per-passing-delivery,
# and the memory-lift metric all aggregate from these records.
#
# TELEMETRY, NOT A GATE (this slice): the verdict — including a `blocking`
# judge fail — is recorded and logged, never enforced. The human review gate
# stays the sole arbiter; enforcement would be a later, separately-flagged
# decision after the judge has soaked.
#
# Discipline (runner/CLAUDE.md): additive + FAIL-SOFT. Every failure path —
# missing crew dist, judge model error, unparseable reply, full disk — returns 0
# and at most logs one line. A delivery must never park/fail because judging it
# failed. Opt-in via GAFFER_EVAL_JUDGE=1 (default OFF for a soak cycle);
# DRY_RUN is always a no-op.
#
# The judge's model turn goes through worker_deliver — the factory's SINGLE
# claude -p spawn seam (env-scrubbed, timeout-bounded, safety-hooked) — with an
# empty MCP config (the judge grades text; it gets NO tools). The reply is read
# back via worker.mjs `parse-result result-text` (the one envelope parser).
# =====================================================================

# gaffer_eval_judge_delivery <num> <repo_dir> <base_branch> <work_branch> <memory_present:0|1> [spend_usd]
#   Expects ticket JSON in $SHOW (same contract as gaffer_distill_ticket_intent).
#   Body is a SUBSHELL (note the parens) so the temp-dir EXIT trap is scoped here
#   and cannot collide with the caller's traps.
gaffer_eval_judge_delivery() (
  [ "${GAFFER_EVAL_JUDGE:-0}" = "1" ] || return 0
  [ "${DRY_RUN:-0}" = "1" ] && return 0
  num="$1"; repo_dir="$2"; base="$3"; work="$4"; mem="${5:-0}"; spend="${6:-}"
  [ -n "$num" ] && [ -d "$repo_dir" ] || return 0
  command -v node >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1 || return 0
  type worker_deliver >/dev/null 2>&1 || return 0

  crew_dir="${CREW_DIR:-$RUNNER_DIR/../packages/crew}"
  judge_cli="$crew_dir/dist/eval/deliveryJudgeCli.js"
  ledger_cli="$crew_dir/dist/eval/evalLedgerCli.js"
  worker_mjs="${GAFFER_WORKER_MJS:-$RUNNER_DIR/lib/worker.mjs}"
  [ -f "$judge_cli" ] && [ -f "$ledger_cli" ] && [ -f "$worker_mjs" ] || return 0

  ledger="${GAFFER_EVAL_LEDGER:-$GAFFER_DATA/eval-ledger.jsonl}"
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/eval-judge.XXXXXX")" || return 0
  trap 'rm -rf "$tmp"' EXIT

  # ── 1. The delivery diff (bounded: the judge grades a diff, not a repo dump).
  #      head -c can cut mid-UTF-8/mid-hunk; the python builder re-decodes with
  #      replacement and, when the diff was truncated, appends an explicit
  #      marker so the judge grades a KNOWN-partial diff instead of silently
  #      treating a prefix as the whole delivery (which would let scope/risk
  #      past the cut score as "absent"). ──
  diff_cap="${GAFFER_JUDGE_DIFF_BYTES:-120000}"
  git -C "$repo_dir" diff "$base".."$work" 2>/dev/null > "$tmp/diff.full" || true
  [ -s "$tmp/diff.full" ] || return 0   # nothing to judge
  head -c "$diff_cap" "$tmp/diff.full" > "$tmp/diff" 2>/dev/null || true

  # Test evidence: the DoD gate results the runner just captured (if any) give
  # the judge real ground truth for test_adequacy instead of "(no test output)".
  dod_results="$GAFFER_DATA/.dod-$num.results"
  [ -f "$dod_results" ] && tail -c 20000 "$dod_results" > "$tmp/tests" 2>/dev/null || : > "$tmp/tests"

  # ── 2. Judge input JSON: title + ACs from $SHOW, diff + tests from files. ──
  SHOW="${SHOW:-}" FULL_BYTES="$(wc -c < "$tmp/diff.full" 2>/dev/null || echo 0)" CAP="$diff_cap" \
    python3 - "$tmp/diff" "$tmp/tests" > "$tmp/input.json" 2>/dev/null <<'PY' || return 0
import json, os, sys
try:
    d = json.loads(os.environ.get("SHOW", "") or "{}")
except Exception:
    d = {}
acs = []
for i, a in enumerate(d.get("acceptanceCriteria") or []):
    text = (a.get("text") or "").strip()
    if text:
        acs.append({"id": str(a.get("id") or f"AC{i+1}"), "text": text})
def readf(p):
    try:
        with open(p, "rb") as f:
            return f.read().decode("utf-8", "replace")
    except Exception:
        return ""
diff = readf(sys.argv[1])
try:
    full = int(os.environ.get("FULL_BYTES", "0")); cap = int(os.environ.get("CAP", "0"))
except Exception:
    full = cap = 0
if cap and full > cap:
    diff += ("\n\n[NOTE: delivery diff truncated to %d of %d bytes — you are "
             "grading a PREFIX; treat unseen changes as ungraded, not absent.]" % (cap, full))
tests = readf(sys.argv[2]).strip()
out = {"ticketTitle": (d.get("title") or "").strip(), "acceptanceCriteria": acs, "diff": diff}
if tests:
    out["testOutput"] = tests
print(json.dumps(out))
PY

  # ── 3. Render the judge prompt (quarantined by the CLI), then ONE model turn
  #      through the worker seam with an empty MCP config (no tools). ──
  prompt="$(node "$judge_cli" --mode prompt < "$tmp/input.json" 2>/dev/null)" || return 0
  [ -n "$prompt" ] || return 0
  printf '{"mcpServers":{}}' > "$tmp/mcp.json"
  judge_flag="${GAFFER_JUDGE_MODEL_FLAG:-${GAFFER_IMPL_MODEL_FLAG:-}}"
  worker_deliver "$repo_dir" "$prompt" "$judge_flag" "$tmp/mcp.json" "$tmp/envelope.json" \
    >/dev/null 2>&1 || true   # a failed judge turn is fail-soft; the guard below skips

  # ── 4. Parse reply → verdict. An EMPTY reply means the judge never ran (worker
  #      error / timeout) — record NOTHING rather than a fake quality-fail that
  #      would poison the metric. A NON-empty reply is judge data even when it
  #      grades to fail/blocking (the parse CLI exits 1 then — that's telemetry
  #      here, so tolerate any exit and keep the 4-line output). ──
  reply="$(node "$worker_mjs" parse-result result-text --json-file "$tmp/envelope.json" 2>/dev/null)" || true
  [ -n "$reply" ] || return 0
  verdict_out="$(printf '%s' "$reply" | node "$judge_cli" --mode parse 2>/dev/null)" || true
  overall="$(printf '%s\n' "$verdict_out" | sed -n '1p')"
  # Line 2 is `judged:blocking`. judged=0 means the reply carried NO parseable
  # rubric (a refusal / mid-JSON cut / unrelated JSON) — an infra outcome, not a
  # quality verdict. Recording it would ledger a fake score-0 fail and poison
  # passRate/memoryLift, so skip it (the very thing an empty reply is skipped for).
  judged="$(printf '%s\n' "$verdict_out" | sed -n '2p' | cut -d: -f1)"
  score="$(printf '%s\n' "$verdict_out" | sed -n '3p')"
  verdict_json="$(printf '%s\n' "$verdict_out" | sed -n '4p')"
  [ -n "$verdict_json" ] || return 0
  if [ "$judged" != "1" ]; then
    type log >/dev/null 2>&1 && log "EVAL: judge #$num returned no parseable grading (refusal/garbled) — not recorded" || true
    return 0
  fi

  # ── 5. Compose the ledger record (verdict + delivery context) and append.
  #      judgeModel is recorded so a judge-model swap never silently breaks
  #      longitudinal comparability, and so self-grading (judge == impl model)
  #      is visible in the data rather than hidden. ──
  repo_name="$(basename "$repo_dir")"
  # Extract the value after `--model`/`--model=`; empty when the flag carries no
  # model. `sed -n …/p` prints ONLY on a successful substitution — portable across
  # GNU and BSD/macOS sed. (The `s///; t; s/.*//` idiom is NOT: BSD sed reads the
  # rest of the line after `t` as a label, so `t; s/.*//` errors with "undefined
  # label", the extraction fails, and judgeModel silently goes unrecorded.)
  judge_model="$(printf '%s' "$judge_flag" | sed -n -E 's/.*--model[= ]+([^ ]+).*/\1/p')"
  VJ="$verdict_json" NUM="$num" REPO="$repo_name" MEM="$mem" SPEND="$spend" JMODEL="$judge_model" \
    python3 - > "$tmp/record.json" 2>/dev/null <<'PY' || return 0
import json, os
try:
    v = json.loads(os.environ.get("VJ", "") or "{}")
except Exception:
    v = {}
v["ticketId"] = os.environ.get("NUM", "")
v["repo"] = os.environ.get("REPO", "")
v["memoryPresent"] = os.environ.get("MEM", "0") == "1"
spend = os.environ.get("SPEND", "")
if spend:
    v["costUsd"] = spend  # "$0.1234" / "unknown" — the ledger CLI normalises/omits
jm = os.environ.get("JMODEL", "").strip()
if jm:
    v["judgeModel"] = jm
print(json.dumps(v))
PY
  # The ledger is a shared append under GAFFER_CONCURRENCY>1 (N workers, one
  # $GAFFER_DATA). Route through the runner's append lock like every other
  # shared append so two ticks can't interleave a multi-KB JSONL line; log (not
  # swallow) an append failure so "count:0" can't hide "ran 400×, all failed".
  if type _gaffer_locked >/dev/null 2>&1; then
    _gaffer_locked .eval-ledger.lock node "$ledger_cli" --mode append --file "$ledger" < "$tmp/record.json" \
      || { type log >/dev/null 2>&1 && log "EVAL: ledger append FAILED for #$num (path/disk?) — verdict lost" || true; return 0; }
  else
    node "$ledger_cli" --mode append --file "$ledger" < "$tmp/record.json" \
      || { type log >/dev/null 2>&1 && log "EVAL: ledger append FAILED for #$num — verdict lost" || true; return 0; }
  fi

  if type log >/dev/null 2>&1; then
    log "EVAL: judged #$num → ${overall:-unknown} (score ${score:-?}/5, memory=$mem) → $(basename "$ledger")" || true
  fi
  return 0
)
