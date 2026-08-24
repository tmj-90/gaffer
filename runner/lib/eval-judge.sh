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

  # ── 1. The delivery diff (bounded: the judge grades a diff, not a repo dump). ──
  git -C "$repo_dir" diff "$base".."$work" 2>/dev/null | head -c 120000 > "$tmp/diff" || true
  [ -s "$tmp/diff" ] || return 0   # nothing to judge

  # ── 2. Judge input JSON: title + ACs from $SHOW, diff from the file. ──
  SHOW="${SHOW:-}" python3 - "$tmp/diff" > "$tmp/input.json" 2>/dev/null <<'PY' || return 0
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
try:
    with open(sys.argv[1], "rb") as f:
        diff = f.read().decode("utf-8", "replace")
except Exception:
    diff = ""
print(json.dumps({
    "ticketTitle": (d.get("title") or "").strip(),
    "acceptanceCriteria": acs,
    "diff": diff,
}))
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
  score="$(printf '%s\n' "$verdict_out" | sed -n '3p')"
  verdict_json="$(printf '%s\n' "$verdict_out" | sed -n '4p')"
  [ -n "$verdict_json" ] || return 0

  # ── 5. Compose the ledger record (verdict + delivery context) and append. ──
  repo_name="$(basename "$repo_dir")"
  VJ="$verdict_json" NUM="$num" REPO="$repo_name" MEM="$mem" SPEND="$spend" \
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
print(json.dumps(v))
PY
  node "$ledger_cli" --mode append --file "$ledger" < "$tmp/record.json" 2>/dev/null || return 0

  if type log >/dev/null 2>&1; then
    log "EVAL: judged #$num → ${overall:-unknown} (score ${score:-?}/5, memory=$mem) → $(basename "$ledger")" || true
  fi
  return 0
)
