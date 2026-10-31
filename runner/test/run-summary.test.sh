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
#   AC9  retrieval: reads before the first write + file cards served vs Read, joined
#        from delivery-metrics.jsonl and tool-metrics.jsonl (run-scoped); tick.sh
#        writes card paths via json-tool delivery-metric
#
# Zero deps beyond bash + python3. Run: bash test/run-summary.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/runsummary-test.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT

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
grep -Eq 'landed:.*2 done' <<<"$OUT"      && ok "landed = 2 done" || fail "landed count wrong"
grep -Eq 'failed-safe:.*1 blocked' <<<"$OUT" && ok "failed-safe = 1 blocked" || fail "failed-safe wrong"
grep -Eq 'parked:.*1 refining' <<<"$OUT" && ok "parked = 1 refining" || fail "parked wrong"
grep -Eq 're-queued:.*1 ready' <<<"$OUT" && ok "re-queued = 1 ready" || fail "re-queued wrong"

echo "== AC2: parked reasons =="
grep -qi 'hygiene violation' <<<"$OUT" && ok "parked ticket surfaces its hygiene park reason" || fail "park reason missing"

echo "== AC3: oversized-flagged =="
grep -q '#6 (oversized_diff)' <<<"$OUT" && ok "oversized ticket #6 listed" || fail "oversized flag missing"

echo "== AC4: per-repo pressure =="
grep -q 'repo-a' <<<"$OUT" && grep -q '3/2/1' <<<"$OUT" \
  && ok "per-repo pressure shows repo-a outstanding 3/2/1 vs cap" || fail "per-repo pressure missing"
grep -Eq 'caps: branches=3' <<<"$OUT" && ok "caps printed for context" || fail "caps line missing"

echo "== AC5: cleanup state =="
grep -qi 'hygiene-leak note' <<<"$OUT" && ok "cleanup state flags the hygiene-leak note (#4)" || fail "cleanup leak flag missing"

echo "== AC6: loop.sh wires the report =="
grep -q 'run-summary.sh' "$RUNNER_DIR/loop.sh" && ok "loop.sh prints run-summary at end of run" || fail "loop.sh does not call run-summary.sh"

echo "== AC7: safety section (block ledger, run-scoped) =="
grep -qiE 'safety .*hook blocks' <<<"$OUT" && ok "safety section present" || fail "safety section missing"
grep -qiE 'no blocks recorded|nothing blocked' <<<"$OUT" && ok "clean run (no ledger) → nothing blocked" || fail "clean-run safety line missing"
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
grep -Eq 'attempt\(s\) blocked this run' <<<"$OUT2" && ok "run-scoped block header present" || fail "run-scoped header missing"
grep -Eq 'out-of-scope-write +1' <<<"$OUT2" && ok "in-run out-of-scope-write counted (1)" || fail "out-of-scope count wrong"
grep -Eq 'secret-read +1' <<<"$OUT2" && ok "run-scoped: only the in-run secret-read counted, pre-run excluded" || fail "run-scoping wrong"
grep -qi 'secret-read attempt' <<<"$OUT2" && ok "secret-read attempts flagged for review" || fail "secret flag missing"
grep -q 'SUMMARY_SINCE' "$RUNNER_DIR/loop.sh" && ok "loop.sh passes SUMMARY_SINCE for run-scoping" || fail "loop.sh does not wire SUMMARY_SINCE"

echo "== AC8: usage section (honest sums + labels + unknowns, run-scoped) =="
# Clean run (no ledger) → says so plainly.
grep -qiE 'usage .*headless agent' <<<"$OUT" && ok "usage section present" || fail "usage section missing"
grep -qiE 'no agent usage recorded' <<<"$OUT" && ok "clean run (no ledger) → no usage recorded, said plainly" || fail "clean-run usage line missing"
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
grep -Eq '1 measured, 1 unknown' <<<"$OUT3" && ok "measured-vs-unknown shown (run-scoped: pre-run row excluded)" || fail "measured/unknown count wrong"
# Honesty: 'unknown' must be labelled NOT zero.
grep -qiE "unknown.*NOT zero" <<<"$OUT3" && ok "'unknown' explicitly labelled not-zero (partial run can't read as cheap)" || fail "unknown-not-zero label missing"
# Billed tokens headline INCLUDES cache (in 1.5k + out 800 + cache-read 5.0k + cache-write 200 = ~7.5k);
# pre-run 99999 row excluded by scoping. This is the true cost driver, so it leads.
grep -qF 'billed tokens: ~7.5k  (in 1.5k · out 800 · cache-read 5.0k · cache-write 200)' <<<"$OUT3" && ok "billed tokens headline incl. cache, human-readable (pre-run excluded)" || fail "billed tokens line wrong"
# Cache-read (5000/7500 = 67%) is the majority, so the driver line must call it out.
grep -qiE 'dominated by cache-read.*re-reads its cached context' <<<"$OUT3" && ok "cache-read driver explained (cost no longer looks like it came from in+out)" || fail "cache-read driver line missing"
# opus-plan vs sonnet-impl split present.
grep -Eq 'opus-plan +800 tokens' <<<"$OUT3" && ok "opus-plan split shown" || fail "opus-plan split missing"
grep -Eq 'sonnet-impl +1500 tokens' <<<"$OUT3" && ok "sonnet-impl split shown" || fail "sonnet-impl split missing"
# API-equivalent cost RELAYED (the in-run total, NOT the excluded $99) + labelled + caveated.
grep -qF 'API-equivalent cost (Claude Code'"'"'s own figure): $0.1234' <<<"$OUT3" && ok "cost relayed verbatim + labelled (not the pre-run \$99)" || fail "cost label/value wrong"
grep -qiE 'Max/Pro subscription the marginal cost is the flat plan fee' <<<"$OUT3" && ok "subscription caveat present" || fail "subscription caveat missing"
# A run where EVERY row is unknown must NOT report a cheap/zero figure.
cat > "$WORK/.gaffer/usage-ledger.jsonl" <<'EOF'
{"ts":"2999-01-01T00:00:00.000Z","ticket":9,"kind":"clarify","measured":false,"unknown_reason":"timeout","models":"unknown","total_cost_usd":"unknown","num_turns":"unknown","duration_ms":"unknown"}
EOF
OUT4="$(trap - EXIT; env GAFFER_DATA="$WORK/.gaffer" DISPATCH_DB="$WORK/wg.sqlite" \
  SUMMARY_LIST_CMD="$WORK/list.sh" SUMMARY_SHOW_CMD="$WORK/show.sh" \
  SUMMARY_SINCE="2500-01-01T00:00:00.000Z" \
  bash "$RUNNER_DIR/run-summary.sh" 2>&1)"
grep -qiE 'nothing measurable this run' <<<"$OUT4" && ok "all-unknown run → 'nothing measurable', no token/cost figure" || fail "all-unknown run still reported numbers"
grep -Eq 'billed tokens' <<<"$OUT4" && fail "all-unknown run wrongly printed a token figure" || ok "all-unknown run prints NO token figure (honest)"
grep -q 'GAFFER_USAGE_LEDGER' "$RUNNER_DIR/factory.config.sh" && ok "factory.config.sh defines GAFFER_USAGE_LEDGER knob (mirrors GAFFER_BLOCK_LEDGER)" || fail "GAFFER_USAGE_LEDGER knob missing"

echo "== AC9: retrieval section (reads before first write, cards served vs read) =="
grep -qiE 'retrieval \(file cards' <<<"$OUT" && ok "retrieval section present" || fail "retrieval section missing"
grep -qiE 'no deliveries primed' <<<"$OUT" && ok "no ledgers → says nothing was primed" || fail "clean-run retrieval line missing"
# delivery-metric turns a real file-card block into a ledger line WITH the card paths.
GOLDEN="$RUNNER_DIR/../packages/crew/test/fixtures/tick-context/file-cards-block.golden.txt"
if [ -f "$GOLDEN" ]; then
  DM="$(node "$RUNNER_DIR/lib/json-tool.mjs" delivery-metric 7 true 3 < "$GOLDEN")"
  [ "$(printf '%s' "$DM" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(d.card_paths.join(","), d.ticket, d.prime_context_called, d.cards_served)')" \
    = "src/auth/reset.ts,src/auth/email.ts,src/routes/account.ts 7 true 3" ] \
    && ok "delivery-metric extracts the served card paths from the block" || fail "delivery-metric line wrong: $DM"
fi
grep -q 'json-tool.mjs" delivery-metric' "$RUNNER_DIR/tick.sh" && ok "tick.sh writes delivery-metrics through delivery-metric" || fail "tick.sh does not use delivery-metric"
# Three deliveries this run + one pre-run (excluded). #7: 2 reads (one file, twice)
# then a write, and it Read 1 of its 2 served cards. #8: 4 reads then a write, read
# 0 of 1 card. #9: primed, no cards, never wrote.
cat > "$WORK/.gaffer/delivery-metrics.jsonl" <<'JSONL'
{"ts":"2000-01-01T00:00:00Z","ticket":"7","prime_context_called":true,"cards_served":9,"card_paths":["old.ts"]}
{"ts":"2999-01-01T00:00:00Z","ticket":"7","prime_context_called":true,"cards_served":2,"card_paths":["src/a.ts","src/b.ts"]}
{"ts":"2999-01-01T00:00:00Z","ticket":"8","prime_context_called":true,"cards_served":1,"card_paths":["src/c.ts"]}
{"ts":"2999-01-01T00:00:00Z","ticket":"9","prime_context_called":false,"cards_served":0,"card_paths":[]}
JSONL
cat > "$WORK/.gaffer/tool-metrics.jsonl" <<'JSONL'
{"ts":"2000-01-01T00:00:01.000Z","ticket":"7","tool":"Read","kind":"read","target":"/wt/old.ts"}
{"ts":"2999-01-01T00:00:01.000Z","ticket":"7","tool":"Read","kind":"read","target":"/wt/ticket-7/k/src/a.ts"}
{"ts":"2999-01-01T00:00:02.000Z","ticket":"7","tool":"Read","kind":"read","target":"/wt/ticket-7/k/src/a.ts"}
{"ts":"2999-01-01T00:00:03.000Z","ticket":"7","tool":"Edit","kind":"write","target":"/wt/ticket-7/k/src/a.ts"}
{"ts":"2999-01-01T00:00:01.000Z","ticket":"8","tool":"Read","kind":"read","target":"/wt/ticket-8/k/src/x.ts"}
{"ts":"2999-01-01T00:00:02.000Z","ticket":"8","tool":"Read","kind":"read","target":"/wt/ticket-8/k/src/y.ts"}
{"ts":"2999-01-01T00:00:03.000Z","ticket":"8","tool":"Read","kind":"read","target":"/wt/ticket-8/k/src/z.ts"}
{"ts":"2999-01-01T00:00:04.000Z","ticket":"8","tool":"Read","kind":"read","target":"/wt/ticket-8/k/src/w.ts"}
{"ts":"2999-01-01T00:00:05.000Z","ticket":"8","tool":"Write","kind":"write","target":"/wt/ticket-8/k/src/new.ts"}
{"ts":"2999-01-01T00:00:01.000Z","ticket":"9","tool":"Bash","kind":"bash","target":"ls"}
JSONL
OUT5="$(trap - EXIT; env GAFFER_DATA="$WORK/.gaffer" DISPATCH_DB="$WORK/wg.sqlite" \
  SUMMARY_LIST_CMD="$WORK/list.sh" SUMMARY_SHOW_CMD="$WORK/show.sh" \
  SUMMARY_SINCE="2500-01-01T00:00:00.000Z" \
  bash "$RUNNER_DIR/run-summary.sh" 2>&1)"
grep -qF '3 deliveries primed this run — 2 with file cards, 3 card(s) served' <<<"$OUT5" \
  && ok "deliveries + cards served counted, pre-run delivery excluded" || fail "delivery count line wrong: $(grep -i 'primed' <<<"$OUT5")"
grep -qF 'reads before first write: median 3 (2.5 distinct file(s)) over 2 deliveries that wrote; 1 made no write' <<<"$OUT5" \
  && ok "reads-before-first-write headline (median over the deliveries that wrote)" || fail "reads-before-first-write wrong: $(grep -i 'reads before' <<<"$OUT5")"
grep -qF 'file cards read: 1 of 3 served card(s) were then Read by the agent' <<<"$OUT5" \
  && ok "served-vs-read headline" || fail "cards read line wrong: $(grep -i 'cards read' <<<"$OUT5")"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
