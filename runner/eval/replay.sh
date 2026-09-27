#!/usr/bin/env bash
# =====================================================================
# runner/eval/replay.sh — golden gate fixtures: recorded deliveries replayed
# through the REAL post-delivery gate pipeline, verdicts compared to expectations.
# ---------------------------------------------------------------------
# WHY. The gates (hygiene · minimalism · Definition of Done · acceptance checks)
# decide what ships without a human. Their unit tests pin single functions; this
# harness pins the PIPELINE: for each fixture a base repo is built, the recorded
# delivery patch is committed on a work branch, and the same library functions
# tick.sh calls run in the same order over that branch. Every verdict — and the
# outcome tick.sh would take (submit / rework:<gate>) — must match the fixture's
# `expected` block. A gate that starts letting a known-bad delivery through, or
# bouncing a known-good one, fails here before it fails on a real ticket.
#
# WHAT RUNS. The libraries themselves, not a re-implementation:
#   gaffer_assert_clean_delivery   (lib/hygiene.sh)   → hygiene ok | violation
#   gaffer_diff_stats + gaffer_check_minimalism (lib/minimalism.sh)
#                                                   → ok | missing_note | oversized_diff | unverified_note
#   gaffer_run_dod_gates           (lib/dod.sh)       → PASS | FAIL (+ the failing gates)
#   gaffer_run_ac_checks           (lib/ac-checks.sh) → PASS | FAIL | none
# The outcome mirrors tick.sh's policy for a committed delivery: a hygiene
# violation, a failing DoD gate, zero executed gates (unless GAFFER_ALLOW_NO_DOD=1),
# a failing acceptance check, or a missing note under MINIMALISM_REQUIRE_NOTE=1 is
# `rework:<gate>` (the recoverable path); missing/boilerplate notes and oversized
# diffs are FLAGS the delivery carries into review; otherwise `submit`. Every gate
# runs on every fixture (they are pure) so the report shows all verdicts, while the
# outcome follows the first failure in tick order.
#
# WHAT IS STUBBED. Only the control plane: `wg` (the dispatch CLI the AC-check
# library records verdicts through) is a recorder writing to wg-calls.log, so the
# replay needs no database, no model and no network. `gaffer_timeout` is the same
# perl-alarm bound the factory uses.
#
# USAGE
#   bash runner/eval/replay.sh [--fixtures <dir>] [--out <dir>] [--only <name>] [-v]
# Exit 0 when every fixture matches, 1 on any mismatch, 2 on a harness error.
# Writes <out>/results.json (per-fixture expected/actual/mismatches + gate rows)
# and keeps each fixture's gate results + wg-calls.log under <out>/<name>/.
#
# ADDING A FIXTURE — see runner/eval/README.md.
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
FIXTURES="$HERE/fixtures"
OUT=""
ONLY=""
VERBOSE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --fixtures) FIXTURES="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    -v|--verbose) VERBOSE=1; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "replay: unknown argument $1" >&2; exit 2 ;;
  esac
done
for _bin in node git perl python3; do
  command -v "$_bin" >/dev/null 2>&1 || { echo "replay: $_bin is required (the acceptance-check library parses the ticket with python3)" >&2; exit 2; }
done
[ -d "$FIXTURES" ] || { echo "replay: fixtures dir not found: $FIXTURES" >&2; exit 2; }
FIXTURES="$(cd "$FIXTURES" && pwd)"
if [ -z "$OUT" ]; then
  OUT="$(mktemp -d "${TMPDIR:-/tmp}/gaffer-eval-replay.XXXXXX")" || exit 2
  # No --out: the scratch dir is disposable — keep only results.json's summary on stdout.
  trap 'rm -rf "$OUT"' EXIT
fi
mkdir -p "$OUT" || exit 2
OUT="$(cd "$OUT" && pwd)"
FX="$HERE/fixture.mjs"

# ── The runtime the libraries expect (same shims the runner tests use) ────────
log() { [ "$VERBOSE" = 1 ] && printf '    log: %s\n' "$*" >&2; return 0; }
gaffer_timeout() {
  local secs="$1"; shift
  if [ -z "$secs" ] || [ "$secs" -le 0 ] 2>/dev/null; then "$@"; return $?; fi
  perl -e 'alarm shift; exec @ARGV' "$secs" "$@"
}
# The dispatch CLI, as a recorder: the AC-check library calls `wg ac check-result …`
# for every check; the replay keeps the argv so the record path is observable.
wg() { printf '%s\n' "$*" >> "${REPLAY_WG_LOG:-/dev/null}"; return 0; }
export GAFFER_DOD_TIMEOUT="${GAFFER_DOD_TIMEOUT:-120}"
export GAFFER_DOD_OUTPUT_TAIL="${GAFFER_DOD_OUTPUT_TAIL:-40}"
# shellcheck source=../lib/dod.sh
source "$RUNNER_DIR/lib/dod.sh"
# shellcheck source=../lib/hygiene.sh
source "$RUNNER_DIR/lib/hygiene.sh"
# shellcheck source=../lib/minimalism.sh
source "$RUNNER_DIR/lib/minimalism.sh"
# shellcheck source=../lib/ac-checks.sh
source "$RUNNER_DIR/lib/ac-checks.sh"

GIT_ID=(-c user.name=gaffer-eval -c user.email=eval@gaffer.invalid -c commit.gpgsign=false)

# Build the base repo + committed delivery branch for one fixture.
#   build_delivery <fixture-dir> <fixture.json> <repo-dir>   → 0, or 1 with a reason on stdout
build_delivery() {
  local dir="$1" json="$2" repo="$3" base patch
  base="$(node "$FX" read "$json" base)"
  [ -n "$base" ] || base="_base/taskflow-mini"
  case "$base" in /*) ;; *) base="$FIXTURES/$base" ;; esac
  [ -d "$base" ] || { echo "base repo not found: $base"; return 1; }
  patch="$(node "$FX" read "$json" delivery)"; [ -n "$patch" ] || patch="delivery.patch"
  [ -f "$dir/$patch" ] || { echo "delivery patch not found: $dir/$patch"; return 1; }
  mkdir -p "$repo" || return 1
  cp -R "$base/." "$repo/" || return 1
  git -C "$repo" init -q -b main 2>/dev/null || { git -C "$repo" init -q && git -C "$repo" checkout -q -b main; } || return 1
  git -C "$repo" "${GIT_ID[@]}" add -A >/dev/null || return 1
  git -C "$repo" "${GIT_ID[@]}" commit -q -m "base: $(basename "$base")" >/dev/null || { echo "could not commit the base repo"; return 1; }
  git -C "$repo" checkout -q -b gaffer/eval-delivery || return 1
  # --index stages adds/deletes/mode changes; a hand-edited patch that no longer applies
  # is a fixture bug, reported as such rather than as a gate verdict.
  if ! git -C "$repo" apply --index --whitespace=nowarn "$dir/$patch" 2>"$repo/.apply.err"; then
    echo "delivery patch does not apply: $(tr '\n' ' ' < "$repo/.apply.err" | cut -c1-200)"; return 1
  fi
  rm -f "$repo/.apply.err"
  git -C "$repo" "${GIT_ID[@]}" commit -q --allow-empty -m "deliver: $(node "$FX" read "$json" title)" >/dev/null || { echo "could not commit the delivery"; return 1; }
  return 0
}

# Run every gate over one built delivery and append the record.
#   replay_fixture <name> <fixture-dir>
replay_fixture() {
  local name="$1" dir="$2" json="$2/fixture.json"
  local work="$OUT/$name" repo="$OUT/$name/repo" t0 t1 err=""
  rm -rf "$work"; mkdir -p "$work"
  t0="$(date +%s%N 2>/dev/null || date +%s)"
  local hygiene="-" minimalism="-" dod="-" ac="-" outcome="-" flags=() dod_failed=() gate_rows=""
  if ! err="$(build_delivery "$dir" "$json" "$repo")"; then
    err="${err:-fixture could not be built}"
  else
    err=""
    # Fixture-scoped policy knobs (MINIMALISM_REQUIRE_NOTE, GAFFER_ALLOW_NO_DOD,
    # OVERSIZED_MAX_LINES …) apply in a subshell so fixtures cannot leak into each other.
    (
      set -uo pipefail
      while IFS= read -r kv; do [ -n "$kv" ] && export "${kv?}"; done < <(node "$FX" env "$json")
      export REPLAY_WG_LOG="$work/wg-calls.log"; : > "$REPLAY_WG_LOG"
      base_branch=main
      # 1 · hygiene — same call and same base...HEAD diff as tick.sh.
      if gaffer_assert_clean_delivery "$repo" "$base_branch" > "$work/hygiene.txt"; then hygiene=ok; else hygiene=violation; fi
      # 2 · minimalism — stats from the branch diff, the note from the fixture (in the
      #     factory it is the agent's recorded smallest-change evidence).
      read -r mz_files mz_lines <<< "$(gaffer_diff_stats "$repo" "$base_branch")"
      mz_note="$(node "$FX" read "$json" note)"
      mz_changed="$(git -C "$repo" diff --name-only "$base_branch"...HEAD 2>/dev/null | tr '\n' ' ')"
      GAFFER_MINIMALISM_REASON=""
      # In THIS shell (stdout → file, not a $() subshell) so the reason global survives — as tick.sh does.
      gaffer_check_minimalism "${mz_files:-0}" "${mz_lines:-0}" "$mz_note" "$mz_changed" > "$work/.mz-verdict" 2>/dev/null || true
      minimalism="$(tr -d '\n' < "$work/.mz-verdict")"; rm -f "$work/.mz-verdict"
      printf 'files=%s lines=%s verdict=%s reason=%s\n' "$mz_files" "$mz_lines" "$minimalism" "${GAFFER_MINIMALISM_REASON:-}" > "$work/minimalism.txt"
      # 3 · Definition of Done — the TAB-row contract, in the delivery worktree.
      dod_results="$work/dod.results"
      if node "$FX" gate-row "$json" "$repo" | gaffer_run_dod_gates "$dod_results"; then dod=PASS; else dod=FAIL; fi
      dod_failed_csv="$(awk -F'\t' '$1=="GATE" && $4=="FAIL" {print $2}' "$dod_results" | paste -sd, -)"
      executed="$(gaffer_dod_executed_count "$dod_results")"
      # 4 · acceptance checks — the ticket payload the library parses, `wg` recording.
      ticket_json="$(node "$FX" ticket-json "$json")"
      ac_results="$work/ac.results"; : > "$ac_results"
      if [ "$(gaffer_ac_check_count "$ticket_json")" -gt 0 ]; then
        if gaffer_run_ac_checks 1 "$ticket_json" "$repo" "$ac_results"; then ac=PASS; else ac=FAIL; fi
      else
        ac=none
      fi
      # ── outcome: tick.sh's policy, first failure in tick order ──
      flags_csv=""
      outcome=submit
      if [ "$hygiene" = violation ]; then outcome="rework:hygiene"; fi
      case "$minimalism" in
        missing_note)
          if [ "${MINIMALISM_REQUIRE_NOTE:-0}" = "1" ]; then
            [ "$outcome" = submit ] && outcome="rework:minimalism"
          else flags_csv="${flags_csv}missing_note,"; fi ;;
        oversized_diff) flags_csv="${flags_csv}oversized_diff," ;;
        unverified_note) flags_csv="${flags_csv}unverified_note," ;;
      esac
      if gaffer_dod_enabled; then
        if [ "$dod" = FAIL ]; then
          [ "$outcome" = submit ] && outcome="rework:definition-of-done"
        elif [ "${executed:-0}" -eq 0 ]; then
          if [ "${GAFFER_ALLOW_NO_DOD:-0}" = "1" ]; then flags_csv="${flags_csv}zero_gates_waived,"
          else flags_csv="${flags_csv}zero_gates,"; [ "$outcome" = submit ] && outcome="rework:definition-of-done"; fi
        fi
      else
        flags_csv="${flags_csv}dod_disabled,"
      fi
      if [ "$ac" = FAIL ] && [ "$outcome" = submit ]; then outcome="rework:acceptance-check"; fi
      # Hand the verdicts back to the parent shell as a TAB record.
      # `-` for an empty column: TAB is IFS whitespace, so an empty field would collapse on read.
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$hygiene" "$minimalism" "$dod" "$ac" "$outcome" "${flags_csv%,}" "$dod_failed_csv" \
        | sed 's/\t\t/\t-\t/g; s/\t\t/\t-\t/g; s/\t$/\t-/' > "$work/verdict.tsv"
      { cat "$dod_results"; cat "$ac_results"; } | awk -F'\t' '$1=="GATE"' > "$work/gate-rows.tsv"
    ) || err="gate pipeline errored (see $work)"
    if [ -z "$err" ] && [ -s "$work/verdict.tsv" ]; then
      local flags_csv dod_failed_csv
      IFS=$'\t' read -r hygiene minimalism dod ac outcome flags_csv dod_failed_csv < "$work/verdict.tsv"
      [ "$flags_csv" = "-" ] && flags_csv=""; [ "$dod_failed_csv" = "-" ] && dod_failed_csv=""
      IFS=, read -r -a flags <<< "$flags_csv"
      IFS=, read -r -a dod_failed <<< "$dod_failed_csv"
      gate_rows="$(cat "$work/gate-rows.tsv" 2>/dev/null)"
    fi
    # Leave the built repo only when the caller keeps the output dir (--out).
    [ -n "${KEEP_REPOS:-}" ] || rm -rf "$repo"
  fi
  t1="$(date +%s%N 2>/dev/null || date +%s)"
  local ms=0
  case "$t0$t1" in *[!0-9]*) ;; *) ms=$(( (t1 - t0) / 1000000 )) ;; esac
  [ "$ms" -lt 0 ] && ms=0
  # One JSON record per fixture; node does the quoting so a note or path can't break it.
  REC_NAME="$name" REC_H="$hygiene" REC_M="$minimalism" REC_D="$dod" REC_A="$ac" REC_O="$outcome" \
  REC_FLAGS="$(IFS=,; echo "${flags[*]:-}")" REC_DF="$(IFS=,; echo "${dod_failed[*]:-}")" REC_ERR="$err" REC_MS="$ms" REC_ROWS="$gate_rows" \
  node -e '
    const e = process.env; const csv = (s) => (s ? s.split(",").filter(Boolean) : []);
    const rows = (e.REC_ROWS || "").split("\n").filter(Boolean).map((l) => { const c = l.split("\t"); return { gate: c[1], repo: c[2], status: c[3], rc: Number(c[4]), note: c[5] }; });
    const actual = { hygiene: e.REC_H, minimalism: e.REC_M, dod: e.REC_D, ac: e.REC_A, outcome: e.REC_O, flags: csv(e.REC_FLAGS), dod_failed: csv(e.REC_DF) };
    const rec = { name: e.REC_NAME, actual, duration_ms: Number(e.REC_MS), gate_rows: rows };
    if (e.REC_ERR) rec.error = e.REC_ERR;
    process.stdout.write(JSON.stringify(rec) + "\n");
  ' >> "$OUT/records.ndjson"
  if [ -n "$err" ]; then printf '  ERR  %s — %s\n' "$name" "$err"; fi
}

: > "$OUT/records.ndjson"
count=0
for dir in "$FIXTURES"/*/; do
  dir="${dir%/}"; name="$(basename "$dir")"
  case "$name" in _*) continue ;; esac           # _base/… are shared inputs, not fixtures
  [ -f "$dir/fixture.json" ] || continue
  if [ -n "$ONLY" ] && [ "$name" != "$ONLY" ]; then continue; fi
  count=$((count + 1))
  replay_fixture "$name" "$dir"
done
[ "$count" -gt 0 ] || { echo "replay: no fixtures found under $FIXTURES" >&2; exit 2; }
echo "== gate replay: $count fixture(s) from $FIXTURES =="
node "$FX" report "$OUT/records.ndjson" "$FIXTURES" "$OUT/results.json"
