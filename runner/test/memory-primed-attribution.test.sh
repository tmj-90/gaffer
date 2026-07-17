#!/usr/bin/env bash
# =====================================================================
# PER-DELIVERY MEMORY ATTRIBUTION (PO-r2 #2) — the runner records WHAT memory it
# primed into a delivery agent, so the learn-loop is visible + attributable.
# ---------------------------------------------------------------------
# gaffer_prime_context_block (context-primer.sh), when GAFFER_RECALL_TICKET is set
# (the DELIVERY prime), records the served card paths (+ digest ref) onto the ticket
# as a `memory_primed` evidence entry via `wg attach-evidence`. Deterministic +
# FAIL-SOFT. Asserts (hermetically, stubbing lg + wg, no network/DB):
#   1. a delivery prime with cards → wg attach-evidence <ticket> --type memory_primed
#      with the card paths in the summary;
#   2. NO recall ticket set (review/clarify prime) → NO memory_primed recording;
#   3. an empty packet (no cards, no digest) → NO recording (nothing to attribute).
# Run: bash runner/test/memory-primed-attribution.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
PRIMER="$RUNNER_DIR/lib/context-primer.sh"

command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 required"; exit 0; }
[ -f "$PRIMER" ] || { echo "SKIP: context-primer.sh not found"; exit 0; }

PASS=0
FAILURES=()
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/mem-primed.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
REPO="$WORK/repo"
mkdir -p "$REPO"

# shellcheck source=/dev/null
source "$PRIMER"
type gaffer_prime_context_block >/dev/null 2>&1 || {
  echo "SKIP: gaffer_prime_context_block not defined"
  exit 0
}

WG_LOG="$WORK/wg.log"
: >"$WG_LOG"
# Stub the dispatch CLI: record every invocation.
wg() { printf '%s\n' "$*" >>"$WG_LOG"; }
# Stub the memory CLI: canonical + a cards-for-scope packet.
CARDS_JSON='{"cards":[{"path":"src/auth.ts","tldr":"auth"},{"path":"src/util.ts"}],"digest":{"overview":"the service"}}'
lg() {
  case "$1" in
    repo-canonical) printf 'example.com/o/r\n' ;;
    cards-for-scope) printf '%s\n' "$CARDS_JSON" ;;
    *) : ;;
  esac
}

echo "== 1: delivery prime (GAFFER_RECALL_TICKET set) records memory_primed =="
GAFFER_RECALL_TICKET=42 gaffer_prime_context_block "$REPO" "r" "add reset flow" >/dev/null 2>&1 || true
grep -q 'attach-evidence 42 --type memory_primed' "$WG_LOG" &&
  ok "recorded memory_primed evidence for the delivery ticket" ||
  fail "did not record memory_primed evidence"
grep -q 'src/auth.ts' "$WG_LOG" && ok "primed card paths captured in the summary" ||
  fail "card paths not captured"
grep -q 'repo-digest' "$WG_LOG" && ok "digest presence captured" || fail "digest presence not captured"

echo "== 2: a prime WITHOUT a recall ticket (review/clarify) records nothing =="
: >"$WG_LOG"
gaffer_prime_context_block "$REPO" "r" "some query" >/dev/null 2>&1 || true
grep -q 'memory_primed' "$WG_LOG" && fail "recorded memory_primed with no recall ticket" ||
  ok "no memory_primed recording without GAFFER_RECALL_TICKET"

echo "== 3: an empty packet (no cards, no digest) records nothing =="
: >"$WG_LOG"
CARDS_JSON='{"cards":[],"digest":null}'
GAFFER_RECALL_TICKET=43 gaffer_prime_context_block "$REPO" "r" "q" >/dev/null 2>&1 || true
grep -q 'memory_primed' "$WG_LOG" && fail "recorded memory_primed for an empty packet" ||
  ok "no recording when nothing was primed"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS — $PASS checks passed (per-delivery memory attribution)"
  exit 0
else
  echo "FAILED — ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
