#!/usr/bin/env bash
# =====================================================================
# RUN-SUMMARY report validation (run-summary.sh).
# ---------------------------------------------------------------------
# Proves, with Dispatch access STUBBED (SUMMARY_LIST_CMD / SUMMARY_SHOW_CMD)
# and a planted backpressure file, that the end-of-run report renders every
# required section with the right data:
#   AC1  landed / failed-safe / parked / re-queued counts come from status lists
#   AC2  parked (refining) tickets surface their park reason
#   AC3  oversized-flagged tickets are listed
#   AC4  per-repo pressure reads the backpressure file (outstanding vs cap)
#   AC5  cleanup state flags a hygiene-leak note
#   AC6  loop.sh prints the run summary at the end of a run
#
# Zero deps beyond bash + python3. Run: bash test/run-summary.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/runsummary-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# Stub `ticket list -s <status>` and `ticket show <ref>`.
cat > "$WORK/list.sh" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  done)      echo '[{"number":1,"title":"landed thing"},{"number":2,"title":"another"}]' ;;
  blocked)   echo '[{"number":3,"title":"failed safe"}]' ;;
  refining)  echo '[{"number":4,"title":"parked thing"}]' ;;
  ready)     echo '[{"number":5,"title":"requeued thing"}]' ;;
  in_review) echo '[{"number":6,"title":"oversized thing"}]' ;;
  *) echo '[]' ;;
esac
EOF
cat > "$WORK/show.sh" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  4) echo '{"ticket":{"title":"parked thing"},"events":[{"summary":"PARKED: delivery hygiene violation (not submitted): forbidden path node_modules"}]}' ;;
  6) echo '{"ticket":{"title":"oversized thing"},"evidence":[{"summary":"needs_human_review: oversized_diff — 20 files / 900 lines"}]}' ;;
  *) echo '{"ticket":{"title":"x"},"events":[],"evidence":[]}' ;;
esac
EOF
chmod +x "$WORK/list.sh" "$WORK/show.sh"

# A planted backpressure file (the tick would write this during a run).
mkdir -p "$WORK/.gaffer"
printf 'repo-a\t3/2/1\tbranches 3/3\n' > "$WORK/.gaffer/.backpressure-repos"

# NOTE: bash runs each $( … ) command substitution in a subshell that INHERITS
# this script's EXIT trap. Without clearing it, every substitution's exit fires
# `rm -rf "$WORK"`, deleting the fixture mid-test (the later ACs re-plant ledger
# files into $WORK and would race the cleanup). `trap - EXIT` inside each subshell
# disarms the inherited trap so only the parent's real EXIT cleans up once.
OUT="$(trap - EXIT; env \
  GAFFER_DATA="$WORK/.gaffer" \
  DISPATCH_DB="$WORK/wg.sqlite" \
  SUMMARY_LIST_CMD="$WORK/list.sh" \
  SUMMARY_SHOW_CMD="$WORK/show.sh" \
  GAFFER_BP_FILE="$WORK/.gaffer/.backpressure-repos" \
  bash "$RUNNER_DIR/run-summary.sh" 2>&1)"

echo "== AC1: outcome counts =="
printf '%s' "$OUT" | grep -Eq 'landed:.*2 done'      && ok "landed = 2 done" || fail "landed count wrong"
printf '%s' "$OUT" | grep -Eq 'failed-safe:.*1 blocked' && ok "failed-safe = 1 blocked" || fail "failed-safe wrong"
printf '%s' "$OUT" | grep -Eq 'parked:.*1 refining' && ok "parked = 1 refining" || fail "parked wrong"
printf '%s' "$OUT" | grep -Eq 're-queued:.*1 ready' && ok "re-queued = 1 ready" || fail "re-queued wrong"

echo "== AC2: parked reasons =="
printf '%s' "$OUT" | grep -qi 'hygiene violation' && ok "parked ticket surfaces its hygiene park reason" || fail "park reason missing"

echo "== AC3: oversized-flagged =="
printf '%s' "$OUT" | grep -q '#6 (oversized_diff)' && ok "oversized ticket #6 listed" || fail "oversized flag missing"

echo "== AC4: per-repo pressure =="
printf '%s' "$OUT" | grep -q 'repo-a' && printf '%s' "$OUT" | grep -q '3/2/1' \
  && ok "per-repo pressure shows repo-a outstanding 3/2/1 vs cap" || fail "per-repo pressure missing"
printf '%s' "$OUT" | grep -Eq 'caps: branches=3' && ok "caps printed for context" || fail "caps line missing"

echo "== AC5: cleanup state =="
printf '%s' "$OUT" | grep -qi 'hygiene-leak note' && ok "cleanup state flags the hygiene-leak note (#4)" || fail "cleanup leak flag missing"

echo "== AC6: loop.sh wires the report =="
grep -q 'run-summary.sh' "$RUNNER_DIR/loop.sh" && ok "loop.sh prints run-summary at end of run" || fail "loop.sh does not call run-summary.sh"

echo "== AC7: safety section (block ledger, run-scoped) =="
printf '%s' "$OUT" | grep -qiE 'safety .*hook blocks' && ok "safety section present" || fail "safety section missing"
printf '%s' "$OUT" | grep -qiE 'no blocks recorded|nothing blocked' && ok "clean run (no ledger) → nothing blocked" || fail "clean-run safety line missing"
# Plant a ledger: one pre-run entry (must be excluded) + two in-run (must count).
cat > "$WORK/.gaffer/safety-blocks.jsonl" <<'EOF'
{"ts":"2000-01-01T00:00:00.000Z","category":"secret-read"}
{"ts":"2999-01-01T00:00:00.000Z","category":"out-of-scope-write"}
{"ts":"2999-01-01T00:00:01.000Z","category":"secret-read"}
EOF
OUT2="$(trap - EXIT; env GAFFER_DATA="$WORK/.gaffer" DISPATCH_DB="$WORK/wg.sqlite" \
  SUMMARY_LIST_CMD="$WORK/list.sh" SUMMARY_SHOW_CMD="$WORK/show.sh" \
  SUMMARY_SINCE="2500-01-01T00:00:00.000Z" \
  bash "$RUNNER_DIR/run-summary.sh" 2>&1)"
# Assert on the un-coloured category lines (the count itself is colour-wrapped).
printf '%s' "$OUT2" | grep -Eq 'attempt\(s\) blocked this run' && ok "run-scoped block header present" || fail "run-scoped header missing"
printf '%s' "$OUT2" | grep -Eq 'out-of-scope-write +1' && ok "in-run out-of-scope-write counted (1)" || fail "out-of-scope count wrong"
printf '%s' "$OUT2" | grep -Eq 'secret-read +1' && ok "run-scoped: only the in-run secret-read counted, pre-run excluded" || fail "run-scoping wrong"
printf '%s' "$OUT2" | grep -qi 'secret-read attempt' && ok "secret-read attempts flagged for review" || fail "secret flag missing"
grep -q 'SUMMARY_SINCE' "$RUNNER_DIR/loop.sh" && ok "loop.sh passes SUMMARY_SINCE for run-scoping" || fail "loop.sh does not wire SUMMARY_SINCE"

echo "== AC8: usage section (honest sums + labels + unknowns, run-scoped) =="
# Clean run (no ledger) → says so plainly.
printf '%s' "$OUT" | grep -qiE 'usage .*headless agent' && ok "usage section present" || fail "usage section missing"
printf '%s' "$OUT" | grep -qiE 'no agent usage recorded' && ok "clean run (no ledger) → no usage recorded, said plainly" || fail "clean-run usage line missing"
# Plant a usage ledger: one PRE-run measured row (must be excluded by SUMMARY_SINCE),
# one in-run MEASURED row (opus + sonnet), one in-run UNKNOWN row (must NOT read as 0).
cat > "$WORK/.gaffer/usage-ledger.jsonl" <<'EOF'
{"ts":"2000-01-01T00:00:00.000Z","ticket":1,"kind":"delivery","measured":true,"models":{"claude-opus-4-8":{"input":99999,"output":99999,"cache_read":0,"cache_create":0,"cost_usd":99}},"total_cost_usd":99,"num_turns":1,"duration_ms":1}
{"ts":"2999-01-01T00:00:00.000Z","ticket":42,"kind":"delivery","measured":true,"models":{"claude-opus-4-8":{"input":500,"output":300,"cache_read":1000,"cache_create":50,"cost_usd":0.09},"claude-sonnet-4-6":{"input":1000,"output":500,"cache_read":4000,"cache_create":150,"cost_usd":0.0334}},"total_cost_usd":0.1234,"num_turns":7,"duration_ms":42000}
{"ts":"2999-01-01T00:00:01.000Z","ticket":9,"kind":"clarify","measured":false,"unknown_reason":"timeout","models":"unknown","total_cost_usd":"unknown","num_turns":"unknown","duration_ms":"unknown"}
EOF
OUT3="$(trap - EXIT; env GAFFER_DATA="$WORK/.gaffer" DISPATCH_DB="$WORK/wg.sqlite" \
  SUMMARY_LIST_CMD="$WORK/list.sh" SUMMARY_SHOW_CMD="$WORK/show.sh" \
  SUMMARY_SINCE="2500-01-01T00:00:00.000Z" \
  bash "$RUNNER_DIR/run-summary.sh" 2>&1)"
# measured-vs-unknown shown, run-scoped: 1 measured (the in-run row), 1 unknown.
printf '%s' "$OUT3" | grep -Eq '1 measured, 1 unknown' && ok "measured-vs-unknown shown (run-scoped: pre-run row excluded)" || fail "measured/unknown count wrong"
# Honesty: 'unknown' must be labelled NOT zero.
printf '%s' "$OUT3" | grep -qiE "unknown.*NOT zero" && ok "'unknown' explicitly labelled not-zero (partial run can't read as cheap)" || fail "unknown-not-zero label missing"
# Tokens are the in-run row's verbatim values (pre-run 99999 row excluded by scoping).
printf '%s' "$OUT3" | grep -Eq 'tokens: in=1500 out=800 cache_read=5000 cache_create=200' && ok "tokens summed from measured rows, verbatim (pre-run excluded)" || fail "token sum wrong"
# opus-plan vs sonnet-impl split present.
printf '%s' "$OUT3" | grep -Eq 'opus-plan +800 tokens' && ok "opus-plan split shown" || fail "opus-plan split missing"
printf '%s' "$OUT3" | grep -Eq 'sonnet-impl +1500 tokens' && ok "sonnet-impl split shown" || fail "sonnet-impl split missing"
# API-equivalent cost RELAYED (the in-run total, NOT the excluded $99) + labelled + caveated.
printf '%s' "$OUT3" | grep -qF 'API-equivalent cost (Claude Code'"'"'s own figure): $0.1234' && ok "cost relayed verbatim + labelled (not the pre-run \$99)" || fail "cost label/value wrong"
printf '%s' "$OUT3" | grep -qiE 'Max/Pro subscription the marginal cost is the flat plan fee' && ok "subscription caveat present" || fail "subscription caveat missing"
# A run where EVERY row is unknown must NOT report a cheap/zero figure.
cat > "$WORK/.gaffer/usage-ledger.jsonl" <<'EOF'
{"ts":"2999-01-01T00:00:00.000Z","ticket":9,"kind":"clarify","measured":false,"unknown_reason":"timeout","models":"unknown","total_cost_usd":"unknown","num_turns":"unknown","duration_ms":"unknown"}
EOF
OUT4="$(trap - EXIT; env GAFFER_DATA="$WORK/.gaffer" DISPATCH_DB="$WORK/wg.sqlite" \
  SUMMARY_LIST_CMD="$WORK/list.sh" SUMMARY_SHOW_CMD="$WORK/show.sh" \
  SUMMARY_SINCE="2500-01-01T00:00:00.000Z" \
  bash "$RUNNER_DIR/run-summary.sh" 2>&1)"
printf '%s' "$OUT4" | grep -qiE 'nothing measurable this run' && ok "all-unknown run → 'nothing measurable', no token/cost figure" || fail "all-unknown run still reported numbers"
printf '%s' "$OUT4" | grep -Eq 'tokens: in=' && fail "all-unknown run wrongly printed a token figure" || ok "all-unknown run prints NO token figure (honest)"
grep -q 'GAFFER_USAGE_LEDGER' "$RUNNER_DIR/factory.config.sh" && ok "factory.config.sh defines GAFFER_USAGE_LEDGER knob (mirrors GAFFER_BLOCK_LEDGER)" || fail "GAFFER_USAGE_LEDGER knob missing"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
