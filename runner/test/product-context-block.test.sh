#!/usr/bin/env bash
# =====================================================================
# Product-context injection + lore-reflection nudge + anti-pattern SEAL
# (Track 1c, live-path backport).
# ---------------------------------------------------------------------
#   B. context-primer.sh defines gaffer_product_context_block; tick.sh builds
#      PRODUCT_CONTEXT_BLOCK and injects it into BOTH delivery prompts, right
#      after FILE_CARDS_BLOCK. LIVE: the block is present, QUARANTINED, and
#      empty/fail-soft when there is no intent.
#   C. tick.sh appends the lore-reflection nudge (suggest_lore, explicit kind)
#      to BOTH delivery briefs.
#   D. SEAL: crew's mock loop + `run` command are commented mock-only and point
#      at runner/tick.sh; runner/CLAUDE.md carries the "features must land here" rule.
#
# Run:  perl -e 'alarm 120; exec @ARGV' /bin/bash runner/test/product-context-block.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
GAFFER_HOME="$(cd "$RUNNER_DIR/.." && pwd)"
TICK="$RUNNER_DIR/tick.sh"
PRIMER_SH="$RUNNER_DIR/lib/context-primer.sh"
RUNNER_CLAUDE="$RUNNER_DIR/CLAUDE.md"
CREW_LOOP="$GAFFER_HOME/packages/crew/src/loops/implementationLoop.ts"
CREW_CLI="$GAFFER_HOME/packages/crew/src/cli/index.ts"
MEMORY_CLI="$GAFFER_HOME/packages/memory/dist/bin/memory.js"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

echo "== B. WIRING — primer function + injection into both delivery prompts =="
grep -q 'gaffer_product_context_block()' "$PRIMER_SH" \
  && ok "context-primer.sh defines gaffer_product_context_block" \
  || fail "gaffer_product_context_block missing from context-primer.sh"
grep -q -- '--kind decision,requirement,non-goal' "$PRIMER_SH" \
  && ok "primer queries product-intent kinds only" \
  || fail "primer does not restrict to product-intent kinds"
grep -q 'gaffer_quarantine product-context' "$PRIMER_SH" \
  && ok "primer QUARANTINES the rendered block (untrusted envelope)" \
  || fail "primer does not quarantine the product-context block"
CNT_PC="$(grep -c '^\$PRODUCT_CONTEXT_BLOCK$' "$TICK" 2>/dev/null || echo 0)"
[ "$CNT_PC" = "2" ] \
  && ok "PRODUCT_CONTEXT_BLOCK injected into both delivery prompts (x$CNT_PC)" \
  || fail "PRODUCT_CONTEXT_BLOCK not injected into both prompts (found $CNT_PC, want 2)"
if grep -A1 '^\$FILE_CARDS_BLOCK$' "$TICK" | grep -q '^\$PRODUCT_CONTEXT_BLOCK$'; then
  ok "product-context is injected AFTER the file-cards block"
else
  fail "product-context is not injected immediately after the file-cards block"
fi

echo "== C. WIRING — lore-reflection nudge appended to both briefs =="
grep -q 'LORE_REFLECTION_NUDGE' "$TICK" \
  && grep -q 'suggest_lore' "$TICK" \
  && ok "tick.sh defines the suggest_lore reflection nudge" \
  || fail "tick.sh missing the suggest_lore reflection nudge"
CNT_NUDGE="$(grep -c '\$LORE_REFLECTION_NUDGE' "$TICK" 2>/dev/null || echo 0)"
[ "$CNT_NUDGE" = "2" ] \
  && ok "nudge injected into both delivery prompts (x$CNT_NUDGE)" \
  || fail "nudge not injected into both prompts (found $CNT_NUDGE, want 2)"
grep -qi 'decision / requirement / non-goal\|decision (why\|requirement (what\|non-goal (what' "$TICK" \
  && ok "nudge names the durable intent kinds (decision/requirement/non-goal)" \
  || fail "nudge does not name the intent kinds"

echo "== D. SEAL — crew mock loop + run command commented mock-only; runner/CLAUDE.md rule =="
grep -qi 'mock' "$CREW_LOOP" && grep -q 'runner/tick.sh' "$CREW_LOOP" \
  && ok "implementationLoop.ts is sealed (mock-only + points at runner/tick.sh)" \
  || fail "implementationLoop.ts is not sealed with the mock-only note"
grep -qi 'MockAgentRuntime' "$CREW_CLI" && grep -q 'runner/tick.sh' "$CREW_CLI" \
  && ok "crew run command notes it wires MockAgentRuntime (not the live agent)" \
  || fail "crew run command is not annotated as mock"
if [ -f "$RUNNER_CLAUDE" ] && grep -q 'runner/tick.sh' "$RUNNER_CLAUDE" && grep -qi 'must land' "$RUNNER_CLAUDE"; then
  ok "runner/CLAUDE.md carries the 'features must land in tick.sh' rule"
else
  fail "runner/CLAUDE.md missing the production-delivery-features rule"
fi

echo "== B. LIVE — the block renders product intent, quarantined; empty when none =="
if [ ! -f "$MEMORY_CLI" ]; then
  echo "  SKIP: memory not built ($MEMORY_CLI missing — run: pnpm --filter memory-mcp build)"
else
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  export MEMORY_DB="$TMP/memory.sqlite"
  lg() { MEMORY_DB="$MEMORY_DB" node "$MEMORY_CLI" "$@"; }

  # Source the SHIPPING primer (also self-sources quarantine.sh for the envelope).
  # shellcheck disable=SC1090
  source "$PRIMER_SH"

  # Seed an ACTIVE product-intent record (a decision) for repo 'app'.
  lg add --title "Decision: single-writer memory" \
    --summary "Memory is the only writer of durable knowledge" \
    --body "rationale" --repo app --kind decision >/dev/null 2>&1

  BLOCK="$(gaffer_product_context_block app 2>/dev/null || true)"
  case "$BLOCK" in
    *"PRODUCT CONTEXT"*) ok "block carries the PRODUCT CONTEXT framing" ;;
    *) fail "block missing PRODUCT CONTEXT framing (got: ${BLOCK:0:80})" ;;
  esac
  case "$BLOCK" in
    *"why this work exists"*) ok "framing states WHY the work exists" ;;
    *) fail "framing does not state why the work exists" ;;
  esac
  case "$BLOCK" in
    *"<untrusted-product-context>"*) ok "block is QUARANTINED (untrusted envelope)" ;;
    *) fail "block is not quarantined" ;;
  esac
  case "$BLOCK" in
    *"Decision: single-writer memory"*) ok "block surfaces the seeded decision record" ;;
    *) fail "block does not surface the seeded record" ;;
  esac

  # FINDING 14: the "[kind] title — summary" separator must be a REAL em dash,
  # never the mojibake "â€”" the old "\xe2\x80\x94" Python byte-escape produced
  # in every product-intent line injected into agent prompts.
  if printf '%s' "$BLOCK" | grep -q "$(printf '\xc3\xa2')"; then
    fail "product-context block contains mojibake bytes (\\xc3\\xa2 — the old â€” em-dash bug)"
  else
    ok "product-context block carries no mojibake bytes"
  fi
  case "$BLOCK" in
    *"$(printf ' \xe2\x80\x94 ')"*) ok "summary separator renders as a clean UTF-8 em dash" ;;
    *) fail "summary separator missing/garbled (expected ' — ' between title and summary)" ;;
  esac

  # Empty / fail-soft: a repo with no intent yields an EMPTY block, not an error.
  EMPTY="$(gaffer_product_context_block no-intent-repo 2>/dev/null || true)"
  [ -z "$EMPTY" ] \
    && ok "no product intent → empty block (delivery proceeds unchanged)" \
    || fail "expected empty block for a repo with no intent (got: ${EMPTY:0:60})"

  # Fail-soft: memory CLI absent → empty block.
  ABSENT="$( ( unset -f lg; gaffer_product_context_block app ) 2>/dev/null || true )"
  [ -z "$ABSENT" ] \
    && ok "memory CLI absent → empty block (fail-soft)" \
    || fail "expected empty block when lg is unavailable"
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
