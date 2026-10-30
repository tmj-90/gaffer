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
# claude -p spawn seam (env-scrubbed, timeout-bounded, safety-hooked) — as a TEXT
# GRADER: the diff is in the prompt, so it runs TEXT-ONLY: `--tools ""` (no built-in
# tools) with every built-in tool also denied by name, an empty MCP config under
# --strict-mcp-config (no MCP tools), --disable-slash-commands (no skill listing), no
# acceptEdits, from an EMPTY scratch cwd that is also its only write root (never the
# delivery worktree: the target repo's CLAUDE.md / skills / settings never load, and
# none of the delivery's DB/ticket env reaches it), under GAFFER_JUDGE_MAX_TURNS (2).
# The scratch cwd carries only the factory's verified safety-hook settings
# (gaffer_write_agent_settings); a judge whose settings cannot be verified is skipped.
# It used to inherit the delivery's acceptEdits, the 200-turn delivery cap and the
# worktree as cwd + write root — so a diff carrying a prompt injection could make a
# "one-shot" judge edit the just-submitted delivery.
# The reply is read back via worker.mjs `parse-result result-text` (the one
# envelope parser).
# =====================================================================
_GAFFER_JSON_TOOL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/json-tool.mjs"

# gaffer_eval_judge_delivery <num> <repo_dir> <base_branch> <work_branch> <memory_present:0|1> [spend_usd] [repo_name]
#   Reads the ticket fresh (`wg ticket show <num>`, so the evidence the delivery just
#   recorded is included), falling back to $SHOW (`wg ticket show` JSON). The test
#   output it grades test_adequacy on comes from $GAFFER_EVAL_TEST_OUTPUT (tick.sh
#   passes the DoD checklist the delivery passed), else $GAFFER_DATA/.dod-<num>.results.
#   repo_name is recorded in the ledger (default: basename of repo_dir).
#   Body is a SUBSHELL (note the parens) so the temp-dir EXIT trap is scoped here
#   and cannot collide with the caller's traps.
gaffer_eval_judge_delivery() (
  [ "${GAFFER_EVAL_JUDGE:-0}" = "1" ] || return 0
  [ "${DRY_RUN:-0}" = "1" ] && return 0
  num="$1"; repo_dir="$2"; base="$3"; work="$4"; mem="${5:-0}"; spend="${6:-}"; repo_arg="${7:-}"
  [ -n "$num" ] && [ -d "$repo_dir" ] || return 0
  command -v node >/dev/null 2>&1 || return 0
  type worker_deliver >/dev/null 2>&1 || return 0
  # The judge's scratch cwd gets the verified safety-hook settings (lib/agent-env.sh),
  # like every other spawn site; without the writer the judge is not launched.
  type gaffer_write_agent_settings >/dev/null 2>&1 || return 0

  crew_dir="${CREW_DIR:-$RUNNER_DIR/../packages/crew}"
  judge_cli="$crew_dir/dist/eval/deliveryJudgeCli.js"
  ledger_cli="$crew_dir/dist/eval/evalLedgerCli.js"
  worker_mjs="${GAFFER_WORKER_MJS:-$RUNNER_DIR/lib/worker.mjs}"
  [ -f "$judge_cli" ] && [ -f "$ledger_cli" ] && [ -f "$worker_mjs" ] || return 0

  ledger="${GAFFER_EVAL_LEDGER:-$GAFFER_DATA/eval-ledger.jsonl}"
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/eval-judge.XXXXXX")" || return 0
  trap 'rm -rf "$tmp"' EXIT

  # ── 1. The delivery diff (bounded: the judge grades a diff, not a repo dump).
  #      head -c can cut mid-UTF-8/mid-hunk; the input builder re-decodes with
  #      replacement and, when the diff was truncated, appends an explicit
  #      marker so the judge grades a KNOWN-partial diff instead of silently
  #      treating a prefix as the whole delivery (which would let scope/risk
  #      past the cut score as "absent"). ──
  diff_cap="${GAFFER_JUDGE_DIFF_BYTES:-120000}"
  git -C "$repo_dir" diff "$base".."$work" 2>/dev/null > "$tmp/diff.full" || true
  [ -s "$tmp/diff.full" ] || return 0   # nothing to judge
  head -c "$diff_cap" "$tmp/diff.full" > "$tmp/diff" 2>/dev/null || true

  # Test evidence: the DoD gate results the runner captured give the judge real
  # ground truth for test_adequacy instead of "(no test output)". tick.sh hands them
  # over in GAFFER_EVAL_TEST_OUTPUT (it removes its results file on a PASS, before
  # this post-submit judge runs); the file is the fallback for other callers.
  dod_results="$GAFFER_DATA/.dod-$num.results"
  if [ -n "${GAFFER_EVAL_TEST_OUTPUT:-}" ]; then
    printf '%s\n' "$GAFFER_EVAL_TEST_OUTPUT" | tail -c 20000 > "$tmp/tests" 2>/dev/null || : > "$tmp/tests"
  elif [ -f "$dod_results" ]; then
    tail -c 20000 "$dod_results" > "$tmp/tests" 2>/dev/null || : > "$tmp/tests"
  else
    : > "$tmp/tests"
  fi
  # The ticket as it stands NOW: $SHOW was read before the delivery ran, so its
  # evidence list misses everything the delivery (and its gates) just recorded.
  show_now=""
  type wg >/dev/null 2>&1 && show_now="$(wg ticket show "$num" 2>/dev/null)" || show_now=""
  [ -n "$show_now" ] || show_now="${SHOW:-}"
  # Through a FILE, not the environment: a ticket with a long event history can pass
  # the per-variable env limit, and the spawn would then fail with E2BIG.
  printf '%s' "$show_now" > "$tmp/show.json" 2>/dev/null || return 0

  # ── 2. Judge input JSON: title + ACs + evidence from the ticket, diff + tests from files. ──
  SHOW_FILE="$tmp/show.json" FULL_BYTES="$(wc -c < "$tmp/diff.full" 2>/dev/null || echo 0)" CAP="$diff_cap" \
    node "$_GAFFER_JSON_TOOL" judge-input "$tmp/diff" "$tmp/tests" > "$tmp/input.json" 2>/dev/null || return 0

  # ── 3. Render the judge prompt (quarantined by the CLI), then ONE model turn
  #      through the worker seam, text-only (no tools, no MCP, empty cwd). ──
  prompt="$(node "$judge_cli" --mode prompt < "$tmp/input.json" 2>/dev/null)" || return 0
  [ -n "$prompt" ] || return 0
  printf '{"mcpServers":{}}' > "$tmp/mcp.json"
  mkdir -p "$tmp/cwd" || return 0
  # Render AND verify the safety-hook settings into the scratch cwd. The judge is
  # text-only, so the hook is defence in depth; the delivery worktree it used to run
  # in carried them. A template that cannot be rendered or verified skips judging
  # (fail closed for the spawn, fail soft for the delivery).
  if ! gaffer_write_agent_settings "$tmp/cwd"; then
    type log >/dev/null 2>&1 && log "EVAL: judge #$num skipped — its safety-hook settings could not be rendered and verified" || true
    return 0
  fi
  # The judge's own boundary: its scratch cwd is the only write root (the sandbox
  # wrap, when on, is derived from these), never the caller's delivery roots.
  WORKER_CALL_ENV=("GAFFER_WRITE_ROOTS=$tmp/cwd" "GAFFER_READ_ROOTS=")
  # JUDGE INDEPENDENCE: default the judge to the PLAN-tier (strong) model, not the
  # implementer's — a model grading its own tier's output is the weakest reading the
  # eval can take. GAFFER_JUDGE_MODEL_FLAG still overrides; the implementer flag is the
  # last resort only when no plan flag is configured.
  judge_flag="${GAFFER_JUDGE_MODEL_FLAG:-${GAFFER_PLAN_MODEL_FLAG:-${GAFFER_IMPL_MODEL_FLAG:-}}}"
  # The overrides are local: this function body is a subshell. CLAUDE_FLAGS is REPLACED
  # (no acceptEdits; built-in tools denied by name as defence in depth on top of
  # `--tools ""`); the turn cap is passed per call, so it replaces the 200-turn flag
  # rather than adding a second --max-turns.
  # shellcheck disable=SC2034  # read by worker_deliver
  CLAUDE_FLAGS="--disallowedTools ${GAFFER_JUDGE_DENIED_TOOLS:-Bash,Edit,Write,MultiEdit,NotebookEdit,Read,Grep,Glob,LS,WebFetch,WebSearch,Task,TodoWrite}"
  judge_turns="${GAFFER_JUDGE_MAX_TURNS:-2}"
  type gaffer_role_turns >/dev/null 2>&1 && judge_turns="$(gaffer_role_turns "$judge_turns")"
  worker_deliver "$tmp/cwd" "$prompt" "$judge_flag" "$tmp/mcp.json" "$tmp/envelope.json" "" \
    "$judge_turns" --tools "" --strict-mcp-config --disable-slash-commands \
    >/dev/null 2>&1
  worker_rc=$?   # a failed judge turn is fail-soft; the guard below skips
  # B28(e): the judge's model turn is PAID work — book it in the usage ledger like
  # every other agent call (kind `eval-judge`), so the daemon's day-USD cap, the
  # budget headroom and the dashboard's cost tiles all see it. Best-effort and
  # swallowed (the ledger CLI prints the reply text; we do not want it here) — the
  # envelope file is left in place for the verdict parse below.
  if type gaffer_usage_record >/dev/null 2>&1; then
    gaffer_usage_record eval-judge "$num" "$worker_rc" "$tmp/envelope.json" >/dev/null 2>&1 || true
  fi

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
  # The repo NAME the caller resolved (tick.sh passes the primary write repo's name;
  # repo_dir is a per-ticket worktree whose basename is a key, not the repo).
  repo_name="${repo_arg:-$(basename "$repo_dir")}"
  # Extract the value after `--model`/`--model=`; empty when the flag carries no
  # model. `sed -n …/p` prints ONLY on a successful substitution — portable across
  # GNU and BSD/macOS sed. (The `s///; t; s/.*//` idiom is NOT: BSD sed reads the
  # rest of the line after `t` as a label, so `t; s/.*//` errors with "undefined
  # label", the extraction fails, and judgeModel silently goes unrecorded.)
  judge_model="$(printf '%s' "$judge_flag" | sed -n -E 's/.*--model[= ]+([^ ]+).*/\1/p')"
  VJ="$verdict_json" NUM="$num" REPO="$repo_name" MEM="$mem" SPEND="$spend" JMODEL="$judge_model" \
    node "$_GAFFER_JSON_TOOL" judge-record > "$tmp/record.json" 2>/dev/null || return 0
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
    # ACTIONABLE: a borderline/fail verdict names its weak dimensions WITH the judge's
    # rationale, so the log (and a human reading it) learns WHAT was missing, not just
    # that a number was low. A pass stays a one-liner.
    weak=""
    if [ "${overall:-}" != "pass" ]; then
      weak="$(printf '%s' "$verdict_json" | node -e '
        let d; try { d = JSON.parse(require("fs").readFileSync(0, "utf8")); } catch { process.exit(0); }
        const dims = Array.isArray(d.dimensions) ? d.dimensions : [];
        const weak = dims.filter((x) => typeof x.score === "number" && x.score <= 3)
          .sort((a, b) => a.score - b.score)
          .map((x) => `${x.dimension} ${x.score}/5: ${String(x.rationale || "(no rationale)").replace(/\s+/g, " ").slice(0, 200)}`);
        process.stdout.write(weak.join(" | "));
      ' 2>/dev/null || true)"
    fi
    log "EVAL: judged #$num → ${overall:-unknown} (score ${score:-?}/5, memory=$mem) → $(basename "$ledger")${weak:+ — weak: $weak}" || true
  fi
  return 0
)
