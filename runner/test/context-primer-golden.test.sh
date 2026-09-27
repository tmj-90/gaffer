#!/usr/bin/env bash
# =====================================================================
# CONTEXT PRIMER RENDER — gaffer_prime_context_block / gaffer_product_context_block
# (lib/context-primer.sh) render the file-cards and product-context blocks through
# the typed renderer (packages/crew renderContextPrimerCli.js). Their output for
# the stubbed memory packets is pinned to the checked-in goldens under
# packages/crew/test/fixtures/tick-context/ (captured by capture-context-golden.sh
# from the live tick, and formerly proven byte-identical to the bash python+printf
# framing by the parity test). Fail-soft is pinned too: an empty or unparseable
# packet yields an EMPTY block, never an error that blocks a delivery.
# Run: bash runner/test/context-primer-golden.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
FIXTURES="$ROOT/packages/crew/test/fixtures/tick-context"
RENDER_CLI="$ROOT/packages/crew/dist/runtime/context/renderContextPrimerCli.js"
FC_GOLDEN="$FIXTURES/file-cards-block.golden.txt"
PC_GOLDEN="$FIXTURES/product-context-block.golden.txt"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
[ -f "$RENDER_CLI" ] || { echo "SKIP: crew not built ($RENDER_CLI) — run pnpm -C packages/crew build"; exit 0; }
for f in "$FIXTURES/cards-packet.json" "$FIXTURES/lore-rows.json" "$FC_GOLDEN" "$PC_GOLDEN"; do
  [ -f "$f" ] || { echo "SKIP: context fixtures missing ($f) — run capture-context-golden.sh"; exit 0; }
done
WORK="$(mktemp -d "${TMPDIR:-/tmp}/context-primer-golden.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
export GAFFER_DATA="$WORK/data" DISPATCH_DB="$WORK/data/dispatch.sqlite" MEMORY_DB="$WORK/data/memory.sqlite"
mkdir -p "$GAFFER_DATA"
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh"
# shellcheck source=../lib/context-primer.sh
source "$RUNNER_DIR/lib/context-primer.sh"
REPO="$WORK/fixture-app"; mkdir -p "$REPO"

# Stub the memory CLI. LG_MODE switches the payload for the fail-soft cases.
LG_MODE="normal"
lg() {
  case "${1:-}" in
    repo-canonical) printf 'example.com/fixture/fixture-app\n' ;;
    cards-for-scope) case "$LG_MODE" in empty) return 0 ;; badjson) printf 'not json at all {' ;; *) cat "$FIXTURES/cards-packet.json" ;; esac ;;
    search)          case "$LG_MODE" in empty) printf '[]' ;; badjson) printf 'nope' ;; *) cat "$FIXTURES/lore-rows.json" ;; esac ;;
    *) return 1 ;;
  esac
}
pass=0; fail=0
ok() { echo "  ok   $1"; pass=$((pass + 1)); }
no() { echo "  FAIL $1"; fail=$((fail + 1)); }

printf '%s' "$(gaffer_prime_context_block "$REPO" "fixture-app" "Add password reset flow")" > "$WORK/fc"
cmp -s "$WORK/fc" "$FC_GOLDEN" && ok "file-cards block matches the checked-in golden" || { diff "$FC_GOLDEN" "$WORK/fc" >&2 || true; no "file-cards block != golden"; }
grep -q "a card is a guide, never authoritative source" "$WORK/fc" && ok "file-cards framing phrase present verbatim" || no "framing phrase missing"
grep -q "<untrusted-file-cards>" "$WORK/fc" && ok "file-cards data is quarantined in its envelope" || no "envelope missing"

printf '%s' "$(gaffer_product_context_block "fixture-app")" > "$WORK/pc"
cmp -s "$WORK/pc" "$PC_GOLDEN" && ok "product-context block matches the checked-in golden" || { diff "$PC_GOLDEN" "$WORK/pc" >&2 || true; no "product-context block != golden"; }
grep -q "<untrusted-product-context>" "$WORK/pc" && ok "product-context data is quarantined in its envelope" || no "envelope missing"

# Fail-soft: empty / bad packets → empty blocks (the emptiness gate short-circuits before the render).
LG_MODE="empty"
[ -z "$(gaffer_prime_context_block "$REPO" "fixture-app" "query")" ] && ok "file-cards (empty packet) → empty block" || no "file-cards empty packet rendered something"
[ -z "$(gaffer_product_context_block "fixture-app")" ] && ok "product-context (empty rows) → empty block" || no "product-context empty rows rendered something"
LG_MODE="badjson"
[ -z "$(gaffer_prime_context_block "$REPO" "fixture-app" "query")" ] && ok "file-cards (bad JSON) → empty block" || no "file-cards bad JSON rendered something"
[ -z "$(gaffer_product_context_block "fixture-app")" ] && ok "product-context (bad JSON) → empty block" || no "product-context bad JSON rendered something"

# Without the crew build the render must not silently produce an unframed block:
# the seam exits non-zero and the caller ($(...) capture) sees an empty block.
LG_MODE="normal"
out="$(CREW_DIR="$WORK/nope" gaffer_prime_context_block "$REPO" "fixture-app" "query" 2>/dev/null)"; rc=$?
[ "$rc" -ne 0 ] && [ -z "$out" ] && ok "missing crew dist → non-zero, empty block (never an unframed render)" || no "missing dist: rc=$rc out=${#out} bytes"

echo ""; echo "context-primer-golden: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
