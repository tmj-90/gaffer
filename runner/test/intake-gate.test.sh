#!/usr/bin/env bash
# =====================================================================
# INTAKE CLARIFY-GATE wiring test (ticket #16).
# ---------------------------------------------------------------------
# Proves tick.sh auto-runs the clarify skill on an ambiguous DRAFT before
# it can be marked ready — the "clarified-before-ready" intake gate:
#   1. With NOTHING ready/in_review but a DRAFT present, the tick selects the
#      draft for a clarify pass (DRY_RUN logs the intent → TICK_RESULT=clarified).
#   2. The clarify pass never marks the ticket ready (no ready transition is
#      requested by the tick — the stub records every CLI call it receives).
#   3. The per-run skip file makes the draft clarified-once: a second tick in
#      the same run finds nothing to clarify and falls through to no_work.
#
# Hermetic: a stub `dispatch` CLI stands in for the real server, so no real
# factory state is touched and Claude is never invoked (DRY_RUN=1). Zero deps.
# Run: bash test/intake-gate.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/intake-test.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
# Only the MAIN shell cleans up. A $(run_tick) command-substitution runs in a subshell
# that also fires this EXIT trap; without the guard it would rm -rf the fixtures out from
# under the parent test mid-run (BASHPID != $$ inside a subshell).
cleanup() { [ "${BASHPID:-}" = "$$" ] && rm -rf "$WORK"; }
trap cleanup EXIT

REPO="$WORK/repo"; mkdir -p "$REPO"          # the draft's repo (must exist on disk)
GAFFER_DATA="$WORK/gaffer-data"; mkdir -p "$GAFFER_DATA"
CALLS="$GAFFER_DATA/wg-calls.log"; : > "$CALLS"

# ── Stub dispatch CLI ───────────────────────────────────────────────────────
# tick.sh invokes it as: node <stub> --db <db> <subcommand…>. It records every
# call (so we can assert no ready-transition is ever requested) and answers only
# the reads the intake path makes: nothing ready / in_review, one draft, its show.
STUB_DIR="$WORK/dispatch/dist/cli"; mkdir -p "$STUB_DIR"
cat > "$STUB_DIR/index.js" <<JS
const fs = require("fs");
const a = process.argv.slice(2);
fs.appendFileSync(process.env.WG_CALLS, a.join(" ") + "\n");
const has = (...t) => t.every((x) => a.includes(x));
const out = (o) => process.stdout.write(JSON.stringify(o));
if (has("agent", "register")) out({ agent: { id: "stub-agent" } });
else if (has("ticket", "list", "-s", "ready")) out([]);
else if (has("ticket", "list", "-s", "in_review")) out([]);
else if (has("ticket", "list", "-s", "draft")) out([{ number: 7, title: "Vague thing" }]);
else if (has("ticket", "show", "7"))
  out({ ticket: { title: "Vague thing", status: "draft" },
        repositories: [{ local_path: process.env.WG_REPO, stack: "node" }] });
else out({});
JS

run_tick() {
  WG_CALLS="$CALLS" WG_REPO="$REPO" \
  RUNNER_DIR="$RUNNER_DIR" GAFFER_HOME="$WORK" GAFFER_DATA="$GAFFER_DATA" \
  DISPATCH_DIR="$WORK/dispatch" CREW_DIR="$WORK/crew-absent" \
  DRY_RUN=1 REVIEW_MODE=human CLARIFY_DRAFTS_WHEN_IDLE=1 \
    bash "$RUNNER_DIR/tick.sh" 2>>"$GAFFER_DATA/stderr.log"
}

# ── 1. ambiguous draft → clarify pass selected ───────────────────────────────
OUT1="$(run_tick)"
echo "$OUT1" | grep -q '^TICK_RESULT=clarified$' \
  && ok "draft triggers a clarify pass (TICK_RESULT=clarified)" \
  || fail "expected TICK_RESULT=clarified, got: $(echo "$OUT1" | grep '^TICK_RESULT=')"

grep -q 'would run a clarify pass' "$GAFFER_DATA/factory.log" 2>/dev/null \
  && ok "logs the clarify intent for the draft" \
  || fail "clarify intent not logged"

# ── 2. the gate never marks the draft ready ──────────────────────────────────
if grep -Eq 'mark_ticket_ready|to=ready|ready 7|transition.*ready' "$CALLS"; then
  fail "intake must NOT mark the draft ready"
else
  ok "intake never marks the draft ready (no ready transition requested)"
fi

# ── 3. the per-run skip file is honored (clarified-once per run) ──────────────
# A draft already recorded in .clarified-tickets is not picked again, so the tick
# falls through (nothing else ready/in_review/draft) to no_work.
echo "7" > "$GAFFER_DATA/.clarified-tickets"
OUT2="$(run_tick)"
echo "$OUT2" | grep -q '^TICK_RESULT=no_work$' \
  && ok "already-clarified draft is skipped (per-run clarified-once)" \
  || fail "expected TICK_RESULT=no_work when draft already clarified, got: $(echo "$OUT2" | grep '^TICK_RESULT=')"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS ($PASS checks)"; exit 0
else
  printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
fi
