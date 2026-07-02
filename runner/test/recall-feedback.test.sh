#!/usr/bin/env bash
# =====================================================================
# Memory Feedback Loop — runner wiring assertions.
# ---------------------------------------------------------------------
# Proves the runner closes the loop between WHAT memory served into a
# ticket's context and HOW the ticket turned out:
#
#   A. context-primer forwards GAFFER_RECALL_TICKET as `--ticket` so memory
#      LOGS the read-event edge for the delivery recall (and only then).
#   B. tick.sh defines a fail-soft `gaffer_recall_feedback` helper (delivery
#      NEVER affected by a feedback error) that calls `lg recall-feedback`.
#   C. tick.sh sets GAFFER_RECALL_TICKET on the DELIVERY prime, and calls the
#      feedback helper at BOTH outcome sites: clean/reworked at submit, blocked
#      at the rework-exhausted park.
#   D. LIVE end-to-end (when memory is built): cards-for-scope --ticket logs a
#      served lore item; recall-feedback blocked flags it; `flagged` surfaces it.
#
# Requires nothing but bash + grep for A–C; D is skipped if memory isn't built.
# Run:  perl -e 'alarm 120; exec @ARGV' /bin/bash runner/test/recall-feedback.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
GAFFER_HOME="$(cd "$RUNNER_DIR/.." && pwd)"
TICK="$RUNNER_DIR/tick.sh"
PRIMER_SH="$RUNNER_DIR/lib/context-primer.sh"
PRIMER_MJS="$RUNNER_DIR/lib/context-primer.mjs"
MEMORY_CLI="$GAFFER_HOME/packages/memory/dist/bin/memory.js"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

echo "== A. context-primer forwards GAFFER_RECALL_TICKET as --ticket =="
if grep -q 'GAFFER_RECALL_TICKET' "$PRIMER_SH" && grep -q -- '--ticket' "$PRIMER_SH"; then
  ok "context-primer.sh forwards --ticket from GAFFER_RECALL_TICKET"
else
  fail "context-primer.sh does not forward --ticket from GAFFER_RECALL_TICKET"
fi
if grep -q 'GAFFER_RECALL_TICKET' "$PRIMER_MJS" && grep -q -- '--ticket' "$PRIMER_MJS"; then
  ok "context-primer.mjs forwards --ticket from GAFFER_RECALL_TICKET"
else
  fail "context-primer.mjs does not forward --ticket from GAFFER_RECALL_TICKET"
fi

echo "== B. tick.sh defines a fail-soft recall-feedback helper =="
if grep -q 'gaffer_recall_feedback()' "$TICK"; then
  ok "gaffer_recall_feedback helper defined"
else
  fail "gaffer_recall_feedback helper missing"
fi
if grep -q 'lg recall-feedback --repo' "$TICK"; then
  ok "helper calls the memory CLI via lg recall-feedback"
else
  fail "helper does not call lg recall-feedback"
fi
# Fail-soft: the helper must swallow errors (never fatal to delivery).
if grep -A14 'gaffer_recall_feedback()' "$TICK" | grep -q 'non-fatal'; then
  ok "helper is fail-soft (non-fatal on error)"
else
  fail "helper is not documented/implemented as fail-soft"
fi

echo "== C. tick.sh sets the recall ticket on delivery + calls feedback at both outcomes =="
if grep -q 'GAFFER_RECALL_TICKET="\$NUM" gaffer_prime_context_block' "$TICK"; then
  ok "delivery prime exports GAFFER_RECALL_TICKET=\$NUM"
else
  fail "delivery prime does not export GAFFER_RECALL_TICKET=\$NUM"
fi
# clean/reworked branch at the submit site.
if grep -q 'gaffer_recall_feedback reworked' "$TICK" && grep -q 'gaffer_recall_feedback clean' "$TICK"; then
  ok "submit site distinguishes clean vs reworked"
else
  fail "submit site does not call clean/reworked feedback"
fi
# blocked branch at the rework-exhausted park.
if grep -q 'gaffer_recall_feedback blocked' "$TICK"; then
  ok "blocked-park calls blocked feedback"
else
  fail "blocked-park does not call blocked feedback"
fi
# The blocked feedback call must sit next to the rework_exhausted park.
if grep -A3 'gaffer_release_delivery blocked' "$TICK" | grep -q 'gaffer_recall_feedback blocked'; then
  ok "blocked feedback is wired at the rework_exhausted park"
else
  fail "blocked feedback is not adjacent to the rework_exhausted park"
fi

echo "== D. LIVE — served item is logged, blocked flags it, flagged surfaces it =="
if [ ! -f "$MEMORY_CLI" ]; then
  echo "  SKIP: memory not built ($MEMORY_CLI missing — run: pnpm -C packages/memory build)"
else
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  export MEMORY_DB="$TMP/memory.sqlite"
  node "$MEMORY_CLI" add --title "Frobnicate rule" --summary "frobnicate policy" \
    --body "always frobnicate" --repo app --confidence low >/dev/null 2>&1
  node "$MEMORY_CLI" cards-for-scope --canonical /repos/app --repo app \
    --query frobnicate --ticket 555 --json >/dev/null 2>&1
  FB="$(node "$MEMORY_CLI" recall-feedback --repo app --ticket 555 --outcome blocked 2>&1)"
  case "$FB" in
    *"adjusted: 1"*) ok "recall-feedback adjusted the served lore (blocked)" ;;
    *) fail "recall-feedback did not adjust the served lore (got: ${FB:0:120})" ;;
  esac
  FL="$(node "$MEMORY_CLI" flagged --repo app 2>&1)"
  case "$FL" in
    *"Frobnicate rule"*) ok "flagged surfaces the demoted lore" ;;
    *) fail "flagged did not surface the demoted lore (got: ${FL:0:120})" ;;
  esac
  # Idempotency: a second identical outcome is a no-op.
  FB2="$(node "$MEMORY_CLI" recall-feedback --repo app --ticket 555 --outcome blocked 2>&1)"
  case "$FB2" in
    *"already applied"*) ok "recall-feedback is idempotent per (ticket, outcome)" ;;
    *) fail "recall-feedback re-applied (not idempotent) (got: ${FB2:0:120})" ;;
  esac
fi

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS ($PASS checks)"
  exit 0
else
  echo "FAILED (${#FAILURES[@]} of $((PASS + ${#FAILURES[@]})) checks):"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
