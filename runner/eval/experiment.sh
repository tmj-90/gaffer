#!/usr/bin/env bash
# =====================================================================
# runner/eval/experiment.sh: the MATCHED EXPERIMENT runner (`gaffer eval experiment`;
# delta roadmap gap 4, P2; docs/eval-harness.md "Matched-ticket comparison").
# ---------------------------------------------------------------------
# The same tickets under two or more arms (setting overrides: the implement tier or model,
# the worker provider, memory priming, the scout packet, the context mode), every
# (ticket, arm) delivery in a seeded random order, each through the SAME worker seam
# (lib/worker.sh worker_deliver: budget admission as kind `experiment`, the agent-env
# scrub, the safety-hook settings, the timeout) and the SAME gate pipeline tick.sh runs
# (eval/gates.sh: hygiene, minimalism, Definition of Done, acceptance checks), with a
# rework attempt on a failed gate. Every attempt is counted. results.json and report.md
# give the paired difference of each arm against the baseline per ticket (acceptance,
# attempts, spend, the judge score where there is one) and its mean, 95% interval and n.
#
# STUB MODE (the default): the agent is eval/experiment-stub-agent.sh, which applies the
# ticket's recorded change (or, for an arm with stub=noop, nothing). No model, no spend,
# an isolated $GAFFER_DATA under --out: the pipeline is proven in CI for free.
# LIVE MODE (--live, opt-in): the real agent, the factory's own $GAFFER_DATA (its budget
# caps admit every launch, the usage pause stops the run, each call is booked in the usage
# ledger as kind `experiment` with no ticket), a hard per-run USD cap (--max-usd or
# GAFFER_EXPERIMENT_MAX_USD; required) that also caps every call, and a ticket cap
# (--max-tickets or GAFFER_EXPERIMENT_MAX_TICKETS). Live mode re-delivers fixtures only, and
# cannot start from an agent shell (the safety hook denies the entry points, and this
# script refuses when it sees an agent's write roots).
#
# NOTHING IS RECORDED TO DISPATCH, NOTHING LANDS, NOTHING PUSHES: the agent gets an empty
# MCP config, `wg` is a recorder (as in replay.sh), every repo is a scratch copy under --out
# (a fixture's base, or a shared clone of a manifest's repo at its recorded base commit).
#
# USAGE
#   bash runner/eval/experiment.sh [--fixtures <dir> [--only a,b] | --manifests <dir>
#        [--tickets 3,4]] --arm <name[:k=v,...]> --arm <name[:k=v,...]> [...]
#        [--seed N] [--out <dir>] [--max-attempts N] [--max-tickets N] [--margin M]
#        [--live --max-usd X] [-v]
#   Arm settings: tier= model= provider= memory=on|off packet=0|1 context=full|minimal
#   scout=off|auto|on stub=apply|noop|patch:<file>. The first arm is the baseline. --margin is the non-inferiority margin (0 < M < 0.5, default 0.10), stored in results.json.
# Exit 0 when the experiment ran (whatever it found), 2 on a usage or harness error.
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
XP="$HERE/experiment.mjs"
FX="$HERE/fixture.mjs"
FIXTURES="" MANIFESTS="" ONLY="" SEED="" OUT="" LIVE=0 VERBOSE=0 MARGIN=0.10
MAX_USD="${GAFFER_EXPERIMENT_MAX_USD:-}"
MAX_TICKETS="${GAFFER_EXPERIMENT_MAX_TICKETS:-5}"
MAX_ATTEMPTS="${GAFFER_EXPERIMENT_MAX_ATTEMPTS:-2}"
ARMS=()
usage() { sed -n '2,38p' "$0"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --fixtures) FIXTURES="${2:-}"; shift 2 ;;
    --manifests) MANIFESTS="${2:-}"; shift 2 ;;
    --only | --tickets) ONLY="${2:-}"; shift 2 ;;
    --arm) ARMS+=("${2:-}"); shift 2 ;;
    --seed) SEED="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    --max-usd) MAX_USD="${2:-}"; shift 2 ;;
    --max-tickets) MAX_TICKETS="${2:-}"; shift 2 ;;
    --max-attempts) MAX_ATTEMPTS="${2:-}"; shift 2 ;;
    --margin) MARGIN="${2:-}"; shift 2 ;;
    --live) LIVE=1; shift ;;
    -v | --verbose) VERBOSE=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "experiment: unknown argument $1" >&2; exit 2 ;;
  esac
done
for _bin in node git perl; do
  command -v "$_bin" >/dev/null 2>&1 || { echo "experiment: $_bin is required" >&2; exit 2; }
done
[ "${#ARMS[@]}" -ge 2 ] || { echo "experiment: give at least two arms (--arm baseline --arm cheap:tier=cheap)" >&2; exit 2; }
case "$MAX_ATTEMPTS" in '' | *[!0-9]* | 0) echo "experiment: --max-attempts must be a positive integer" >&2; exit 2 ;; esac
case "$MAX_TICKETS" in '' | *[!0-9]* | 0) echo "experiment: --max-tickets must be a positive integer" >&2; exit 2 ;; esac
# The non-inferiority margin: the owner's policy for how much acceptance a cheaper arm may
# give up on this kind of work (experiment.mjs parseMargin checks the same bounds).
case "$MARGIN" in '' | *[!0-9.]* | *.*.*) MARGIN_OK=0 ;; *) MARGIN_OK=1 ;; esac
[ "$MARGIN_OK" = 1 ] && awk -v v="$MARGIN" 'BEGIN { exit !(v + 0 > 0 && v + 0 < 0.5) }' \
  || { echo "experiment: --margin must be a number with 0 < m < 0.5 (got $MARGIN)" >&2; exit 2; }
[ -n "$FIXTURES$MANIFESTS" ] || FIXTURES="$HERE/fixtures"

if [ "$LIVE" = 1 ]; then
  # An agent's own shell carries its write roots or ticket: a live run from there would
  # spend the factory's money outside every gate. The hook denies the entry points; this
  # is the script's own refusal behind it.
  if [ -n "${GAFFER_WRITE_ROOTS:-}${GAFFER_TICKET:-}" ]; then
    echo "experiment: refusing a live experiment from inside an agent's call (GAFFER_WRITE_ROOTS / GAFFER_TICKET is set); a person starts it" >&2
    exit 2
  fi
  if ! awk -v v="$MAX_USD" 'BEGIN { exit !(v + 0 > 0) }'; then
    echo "experiment: --live needs a hard USD cap for the whole run: --max-usd X or GAFFER_EXPERIMENT_MAX_USD" >&2
    exit 2
  fi
  [ -n "${GAFFER_DATA:-}" ] || { echo "experiment: --live needs GAFFER_DATA (the factory's ledger, caps and usage pause)" >&2; exit 2; }
fi

if [ -z "$OUT" ]; then
  if [ "$LIVE" = 1 ]; then OUT="$GAFFER_DATA/experiments/$(date -u +%Y%m%dT%H%M%SZ)-$$"
  else OUT="$(mktemp -d "${TMPDIR:-/tmp}/gaffer-experiment.XXXXXX")" || exit 2; fi
fi
mkdir -p "$OUT" || exit 2
OUT="$(cd "$OUT" && pwd)"
LOGF="$OUT/experiment.log"; : > "$LOGF"

if [ "$LIVE" = 1 ]; then
  MODE=live
else
  MODE=stub
  # Stub mode is sealed off from the factory: its own data dir (ledger, usage pause, no
  # settings), the stub agent, no OS sandbox (the stub is this repo's own script).
  export GAFFER_DATA="$OUT/data"; mkdir -p "$GAFFER_DATA"
  export CLAUDE_BIN="$HERE/experiment-stub-agent.sh" GAFFER_ALLOW_UNCAPPED=1
  export GAFFER_WORKER_PROVIDER=claude-code STRICT_MODE=0 GAFFER_STRICT_REQUIRE=0 SANDBOX_PROVIDER=sandbox-exec
  export GAFFER_TICK_TIMEOUT="${GAFFER_TICK_TIMEOUT:-120}" GAFFER_USAGE_LEDGER="$GAFFER_DATA/usage-ledger.jsonl"
  unset DISPATCH_DB MEMORY_DB
fi
export GAFFER_LOG="$LOGF"

# The factory's runtime: the worker seam, the usage ledger and pause, budget admission,
# the agent env and its safety-hook settings writer.
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>>"$LOGF"
GAFFER_LOG="$LOGF"
# The gate libraries and the shared pipeline (same as replay.sh).
# shellcheck source=../lib/dod.sh
source "$RUNNER_DIR/lib/dod.sh"
# shellcheck source=../lib/hygiene.sh
source "$RUNNER_DIR/lib/hygiene.sh"
# shellcheck source=../lib/minimalism.sh
source "$RUNNER_DIR/lib/minimalism.sh"
# shellcheck source=../lib/ac-checks.sh
source "$RUNNER_DIR/lib/ac-checks.sh"
# shellcheck source=gates.sh
source "$HERE/gates.sh"
# Nothing reaches dispatch: `wg` is a recorder, exactly as in the gate replay.
wg() { printf '%s\n' "$*" >> "${REPLAY_WG_LOG:-$OUT/wg-calls.log}"; return 0; }
log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >> "$LOGF"; [ "$VERBOSE" = 1 ] && printf '    %s\n' "$*" >&2; return 0; }

PLAN_ARGS=(plan --out "$OUT" --mode "$MODE" --max-tickets "$MAX_TICKETS")
[ -n "$FIXTURES" ] && PLAN_ARGS+=(--fixtures "$FIXTURES")
[ -n "$MANIFESTS" ] && PLAN_ARGS+=(--manifests "$MANIFESTS")
[ -n "$ONLY" ] && PLAN_ARGS+=(--only "$ONLY")
[ -n "$SEED" ] && PLAN_ARGS+=(--seed "$SEED")
for _a in "${ARMS[@]}"; do PLAN_ARGS+=(--arm "$_a"); done
if ! node "$XP" "${PLAN_ARGS[@]}" >"$OUT/plan.txt" 2>&1; then
  cat "$OUT/plan.txt" >&2; exit 2
fi
PLAN="$OUT/plan.json"
RUNS="$OUT/runs.ndjson"; : > "$RUNS"
GIT_ID=(-c user.name=gaffer-experiment -c user.email=experiment@gaffer.invalid -c commit.gpgsign=false)
SPENT=0
STOP=""
CAP_WHY=""

# record <ticket> <arm> <order> key=value…: one run's JSON line (node does the quoting).
record() {
  local t="$1" a="$2" o="$3"; shift 3
  node -e '
    const [t, a, o, ...kv] = process.argv.slice(1); const r = { ticket: t, arm: a, order: Number(o) };
    for (const p of kv) { const i = p.indexOf("="); const k = p.slice(0, i), v = p.slice(i + 1);
      r[k] = v === "" || v === "null" ? null : v === "true" ? true : v === "false" ? false
        : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v.startsWith("[") ? JSON.parse(v) : v; }
    process.stdout.write(JSON.stringify(r) + "\n");' "$t" "$a" "$o" "$@" >> "$RUNS"
}

# build_repo <ticket> <repo-dir> → 0, the ticket's base committed on `main` and a work
# branch checked out; 1 with a reason on stdout.
build_repo() {
  local t="$1" repo="$2" src
  src="$(node "$XP" ticket --plan "$PLAN" --ticket "$t" --field source)"
  if [ "$src" = fixture ]; then
    local base; base="$(node "$XP" ticket --plan "$PLAN" --ticket "$t" --field base_dir)"
    [ -d "$base" ] || { echo "base repo not found: $base"; return 1; }
    mkdir -p "$repo" && cp -R "$base/." "$repo/" || return 1
    git -C "$repo" init -q -b main 2>/dev/null || { git -C "$repo" init -q && git -C "$repo" checkout -q -b main; } || return 1
    git -C "$repo" "${GIT_ID[@]}" add -A >/dev/null && git -C "$repo" "${GIT_ID[@]}" commit -q -m "base" >/dev/null || return 1
  else
    local from bc
    from="$(node "$XP" ticket --plan "$PLAN" --ticket "$t" --field repo_path)"
    bc="$(node "$XP" ticket --plan "$PLAN" --ticket "$t" --field base_commit)"
    # A shared clone: the source repo's objects through alternates, its refs untouched.
    git clone -q --shared --no-checkout "$from" "$repo" 2>/dev/null || { echo "could not clone $from"; return 1; }
    git -C "$repo" checkout -q -B main "$bc" 2>/dev/null || { echo "base commit $bc not in $from"; return 1; }
  fi
  git -C "$repo" checkout -q -b gaffer/experiment || return 1
  mkdir -p "$repo/.git/info" && printf '.claude/\n' >> "$repo/.git/info/exclude"
  return 0
}

# run_one <order> <ticket> <arm>
run_one() {
  local order="$1" t="$2" a="$3"
  local work="$OUT/runs/$order-$t-$a" repo fixture stub note patch fdir range="" failure="" t0 t1
  repo="$work/repo"; mkdir -p "$work"
  t0="$(date +%s)"
  local err
  if ! err="$(build_repo "$t" "$repo")"; then
    record "$t" "$a" "$order" ran=false attempts=0 submitted=false accepted=false outcome=harness_error "skipped_reason=" "error=${err:-could not build the repo}" spend_usd=0 judge_score=
    return 0
  fi
  if ! gaffer_write_agent_settings "$repo" 2>>"$LOGF"; then
    record "$t" "$a" "$order" ran=false attempts=0 submitted=false accepted=false outcome=harness_error "error=the safety-hook settings could not be written and verified (fail closed)" spend_usd=0 judge_score=
    return 0
  fi
  fixture="$(node "$XP" ticket --plan "$PLAN" --ticket "$t" --field fixture)"
  fdir="$(node "$XP" ticket --plan "$PLAN" --ticket "$t" --field fixture_dir)"
  patch="$(node "$XP" ticket --plan "$PLAN" --ticket "$t" --field patch)"
  if [ "$(node "$XP" ticket --plan "$PLAN" --ticket "$t" --field source)" = manifest ]; then
    range="$(node "$XP" ticket --plan "$PLAN" --ticket "$t" --field base_commit)..$(node "$XP" ticket --plan "$PLAN" --ticket "$t" --field head_commit)"
  fi
  stub="$(node "$XP" arm-setting --plan "$PLAN" --arm "$a" --key stub)"
  note="$(node "$FX" read "$fixture" note)"
  printf '{"mcpServers":{}}' > "$work/mcp.json"
  local flag; flag="$(node "$XP" model-flag --plan "$PLAN" --ticket "$t" --arm "$a")"
  local provider; provider="$(node "$XP" arm-setting --plan "$PLAN" --arm "$a" --key provider)"
  local attempts=0 submitted=false outcome="" spend=0 unknown=0 rc=0 n env_json pr
  for n in $(seq 1 "$MAX_ATTEMPTS"); do
    if [ "$MODE" = live ] && ! awk -v s="$SPENT" -v m="$MAX_USD" 'BEGIN { exit !(s + 0 < m + 0) }'; then
      outcome="cap"; STOP="the run's USD cap (\$$MAX_USD) was reached"; [ -n "$CAP_WHY" ] && STOP="$CAP_WHY"; break
    fi
    env_json="$work/envelope-$n.json"
    pr="$(node "$XP" prompt --plan "$PLAN" --ticket "$t" --arm "$a" ${failure:+--failure "$failure"})"
    # shellcheck disable=SC2034  # read by worker_deliver
    WORKER_CALL_ENV=("GAFFER_WRITE_ROOTS=$repo" "GAFFER_READ_ROOTS=" "GAFFER_DATA=$GAFFER_DATA"
      "XP_STUB=${stub:-apply}" "XP_PATCH=$patch" "XP_FIXTURE_DIR=$fdir"
      "XP_NOTE=$note" "XP_REPLAY_RANGE=$range")
    local extra=()
    if [ "$MODE" = live ]; then
      extra=(--max-budget-usd "$(awk -v s="$SPENT" -v m="$MAX_USD" 'BEGIN { printf "%.4f", m - s }')")
    fi
    attempts=$n
    GAFFER_WORKER_PROVIDER="${provider:-${GAFFER_WORKER_PROVIDER:-claude-code}}" GAFFER_LAUNCH_KIND=experiment \
      worker_deliver "$repo" "$pr" "$flag" "$work/mcp.json" "$env_json" "" "" ${extra[@]+"${extra[@]}"}
    rc=$?
    case "$rc" in
      77) outcome="budget_refused"; [ "$MODE" = live ] && STOP="the budget admission refused a launch"; attempts=$((n - 1)); break ;;
      70 | 75 | 76) outcome="refused:$rc"; attempts=$((n - 1)); break ;;
    esac
    # Booked like every paid call: the experiment's own ledger in stub mode, the factory's
    # in live mode (kind experiment, no ticket, so no ticket's figures move).
    gaffer_usage_record experiment "" "$rc" "$env_json" >/dev/null 2>&1 || true
    local s; s="$(node "$RUNNER_DIR/lib/worker.mjs" parse-result spend --json-file "$env_json" 2>/dev/null || echo unknown)"
    s="${s#\$}"
    if awk -v v="$s" 'BEGIN { exit !(v ~ /^[0-9.]+$/) }'; then
      spend="$(awk -v a="$spend" -v b="$s" 'BEGIN { printf "%.6f", a + b }')"
      SPENT="$(awk -v a="$SPENT" -v b="$s" 'BEGIN { printf "%.6f", a + b }')"
    else
      unknown=$((unknown + 1))
      # A call whose spend cannot be read (killed, timed out, no envelope) may have spent
      # its whole per-call cap: count that cap against the run, so the hard USD cap stays
      # hard (adding nothing gave every later call the full cap again).
      if [ "$MODE" = live ]; then
        SPENT="$MAX_USD"
        CAP_WHY="a call's spend could not be read (killed, timed out or no envelope), so its whole per-call cap counts against the run's USD cap (\$$MAX_USD)"
      fi
    fi
    if [ "$MODE" = live ] && declare -F gaffer_usage_pause_record >/dev/null 2>&1; then
      gaffer_usage_pause_record "$env_json" "" experiment >/dev/null 2>&1
      case "$?" in 0 | 2) outcome="usage_paused"; STOP="the model's usage window refused a call (the factory is paused)"; break ;; esac
    fi
    if [ "$(git -C "$repo" rev-list --count main..HEAD 2>/dev/null || echo 0)" -eq 0 ]; then
      outcome="empty"; break
    fi
    if [ "$MODE" = live ]; then
      note="$(node "$RUNNER_DIR/lib/worker.mjs" parse-result result-text --json-file "$env_json" 2>/dev/null \
        | grep -i 'smallest-change note' | tail -1 || true)"
    fi
    mkdir -p "$work/a$n"
    if ! eval_gate_pipeline "$fixture" "$repo" "$work/a$n" "$note" 2>>"$LOGF" || [ ! -s "$work/a$n/verdict.tsv" ]; then
      outcome="harness_error"; break
    fi
    local _h _m _d _ac out _f df
    IFS=$'\t' read -r _h _m _d _ac out _f df < "$work/a$n/verdict.tsv"
    outcome="$out"
    if [ "$out" = submit ]; then submitted=true; break; fi
    failure="$work/a$n/failure.txt"
    { printf '%s (failing DoD gates: %s)\n' "$out" "$df"; tail -n 40 "$work/a$n/dod.results" 2>/dev/null; } > "$failure"
  done
  local accepted=false
  if [ "$submitted" = true ]; then
    local hidden; hidden="$(node "$XP" ticket --plan "$PLAN" --ticket "$t" --field acceptance_test)"
    if [ -z "$hidden" ]; then accepted=true
    elif (cd "$repo" && gaffer_timeout "${GAFFER_DOD_TIMEOUT:-300}" bash -c "$hidden") >"$work/acceptance.txt" 2>&1; then accepted=true; fi
  fi
  git -C "$repo" diff main...HEAD > "$work/diff.patch" 2>/dev/null || : > "$work/diff.patch"
  local judge; judge="$(node "$XP" judge-score --plan "$PLAN" --ticket "$t" --diff "$work/diff.patch")"
  # A run a cap, a refusal or the harness cut short did not finish: it is left out of every
  # pair (the report counts it), never read as the arm's failure.
  local ran=true skipped=""
  case "$outcome" in
    cap | budget_refused | refused:* | harness_error | usage_paused) ran=false; skipped="${STOP:-$outcome}" ;;
  esac
  local spend_v="$spend"; [ "$unknown" -gt 0 ] && spend_v=""
  t1="$(date +%s)"
  record "$t" "$a" "$order" "ran=$ran" "attempts=$attempts" "submitted=$submitted" "accepted=$accepted" \
    "outcome=$outcome" "spend_usd=$spend_v" "spend_unknown_calls=$unknown" "judge_score=$judge" \
    "model_flag=$flag" "unapplied=$(node "$XP" unapplied --plan "$PLAN" --arm "$a" --ticket "$t")" \
    "duration_s=$((t1 - t0))" "skipped_reason=$skipped"
  [ -n "${KEEP_REPOS:-}" ] || rm -rf "$repo"
  printf '  %-4s %-28s %-12s attempts=%s outcome=%s accepted=%s\n' "$order" "$t" "$a" "$attempts" "$outcome" "$accepted"
}

echo "== matched experiment ($MODE mode): $(cat "$OUT/plan.txt") =="
while IFS=$'\t' read -r order t a; do
  [ -n "$order" ] || continue
  if [ -n "$STOP" ]; then
    record "$t" "$a" "$order" ran=false attempts=0 submitted=false accepted=false outcome=not_run "skipped_reason=$STOP" spend_usd=0 judge_score=
    continue
  fi
  if [ "$MODE" = live ] && declare -F gaffer_usage_pause_active >/dev/null 2>&1 && gaffer_usage_pause_active >/dev/null 2>&1; then
    STOP="the factory is paused on the usage window"
    record "$t" "$a" "$order" ran=false attempts=0 submitted=false accepted=false outcome=not_run "skipped_reason=$STOP" spend_usd=0 judge_score=
    continue
  fi
  run_one "$order" "$t" "$a"
done < <(node "$XP" pairs --plan "$PLAN")
node "$XP" report --plan "$PLAN" --runs "$RUNS" --out "$OUT" --margin "$MARGIN"
