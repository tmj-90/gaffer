#!/usr/bin/env bash
# =====================================================================
# LOAD-BEARING byte-identity test (docs/tick-sh-runtime-migration.md P1b).
# ---------------------------------------------------------------------
# The context-primer twin of runner/test/{mcp,prompt}-render-parity.test.sh. It
# drives the two LIVE primer render sites — gaffer_prime_context_block and
# gaffer_product_context_block (runner/lib/context-primer.sh) — BOTH ways on the
# SAME stubbed memory packets: the legacy inline python + quarantine + printf
# framing (GAFFER_RUNTIME=bash, the live default) and the typed node renderer
# (GAFFER_RUNTIME=ts, renderContextPrimerCli.js → formatFileCardsBlock /
# formatProductContextBlock) — and asserts the two blocks are BYTE-IDENTICAL.
#
# CONSUMED-FORM comparison: both delivery consumers capture the primer output via
# `FILE_CARDS_BLOCK="$( … )"` / `PRODUCT_CONTEXT_BLOCK="$( … )"` (tick.sh), i.e.
# command substitution, which strips trailing newlines. The bash branch emits the
# block with a trailing "\n\n"; the typed CLI emits it without. Both are therefore
# byte-identical AS CONSUMED — so this test compares the $(...)-captured form (the
# exact bytes tick.sh injects into the prompt), not the raw stdout. Each captured
# block is also asserted equal to the checked-in golden.
#
# The stub `lg` mirrors capture-context-golden.sh's block-golden capture: it feeds
# the checked-in cards-packet.json / lore-rows.json fixtures so the render is
# deterministic and offline.
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
CREW_DIR="$ROOT/packages/crew"
RENDER_CLI="$CREW_DIR/dist/runtime/context/renderContextPrimerCli.js"
FIXTURES="$CREW_DIR/test/fixtures/tick-context"
FC_GOLDEN="$FIXTURES/file-cards-block.golden.txt"
PC_GOLDEN="$FIXTURES/product-context-block.golden.txt"

command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 required"; exit 0; }
[ -f "$RENDER_CLI" ] || { echo "SKIP: crew not built ($RENDER_CLI) — run pnpm -C packages/crew build"; exit 0; }
for f in "$FIXTURES/cards-packet.json" "$FIXTURES/lore-rows.json" "$FC_GOLDEN" "$PC_GOLDEN"; do
  [ -f "$f" ] || { echo "SKIP: context fixtures missing ($f) — run capture-context-golden.sh"; exit 0; }
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/context-primer-parity.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
export GAFFER_DATA="$WORK/data" DISPATCH_DB="$WORK/data/dispatch.sqlite" MEMORY_DB="$WORK/data/memory.sqlite"
mkdir -p "$GAFFER_DATA"
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh"
# shellcheck source=../lib/context-primer.sh
source "$RUNNER_DIR/lib/context-primer.sh"
CREW_DIR="$CREW_DIR"   # the seam resolves the CLI from here

REPO="$WORK/fixture-app"; mkdir -p "$REPO"   # prime only needs an existing dir

# Stub the memory CLI. LG_MODE switches the payload for the fail-soft cases.
LG_MODE="normal"
lg() {
  case "${1:-}" in
    repo-canonical) printf 'example.com/fixture/fixture-app\n' ;;
    cards-for-scope)
      case "$LG_MODE" in
        empty) return 0 ;;
        badjson) printf 'not json at all {' ;;
        *) cat "$FIXTURES/cards-packet.json" ;;
      esac ;;
    search)
      case "$LG_MODE" in
        empty) printf '[]' ;;
        badjson) printf 'nope' ;;
        *) cat "$FIXTURES/lore-rows.json" ;;
      esac ;;
    *) return 1 ;;
  esac
}

pass=0
fail=0
ok() { echo "  ok   $1"; pass=$((pass + 1)); }
no() { echo "  FAIL $1"; fail=$((fail + 1)); }

# ── file-cards: bash ≡ ts ≡ golden (consumed form) ───────────────────────────
FCB_BASH="$(GAFFER_RUNTIME=bash gaffer_prime_context_block "$REPO" "fixture-app" "Add password reset flow")"
FCB_TS="$(GAFFER_RUNTIME=ts   gaffer_prime_context_block "$REPO" "fixture-app" "Add password reset flow")"
printf '%s' "$FCB_BASH" > "$WORK/fc.bash"; printf '%s' "$FCB_TS" > "$WORK/fc.ts"
if cmp -s "$WORK/fc.bash" "$WORK/fc.ts"; then
  ok "file-cards — bash python and ts renderer are byte-identical (as consumed)"
else
  echo "----- diff (bash left, ts right) -----" >&2; diff "$WORK/fc.bash" "$WORK/fc.ts" >&2 || true
  no "file-cards — bash and ts DIVERGED"
fi
cmp -s "$WORK/fc.bash" "$FC_GOLDEN" && ok "file-cards — bash branch matches the checked-in golden" || no "file-cards — bash branch != golden"
cmp -s "$WORK/fc.ts"   "$FC_GOLDEN" && ok "file-cards — ts branch matches the checked-in golden"   || no "file-cards — ts branch != golden"

# ── product-context: bash ≡ ts ≡ golden (consumed form) ──────────────────────
PCB_BASH="$(GAFFER_RUNTIME=bash gaffer_product_context_block "fixture-app")"
PCB_TS="$(GAFFER_RUNTIME=ts   gaffer_product_context_block "fixture-app")"
printf '%s' "$PCB_BASH" > "$WORK/pc.bash"; printf '%s' "$PCB_TS" > "$WORK/pc.ts"
if cmp -s "$WORK/pc.bash" "$WORK/pc.ts"; then
  ok "product-context — bash python and ts renderer are byte-identical (as consumed)"
else
  echo "----- diff (bash left, ts right) -----" >&2; diff "$WORK/pc.bash" "$WORK/pc.ts" >&2 || true
  no "product-context — bash and ts DIVERGED"
fi
cmp -s "$WORK/pc.bash" "$PC_GOLDEN" && ok "product-context — bash branch matches the checked-in golden" || no "product-context — bash branch != golden"
cmp -s "$WORK/pc.ts"   "$PC_GOLDEN" && ok "product-context — ts branch matches the checked-in golden"   || no "product-context — ts branch != golden"

# ── FAIL-SOFT parity: an empty / bad packet → EMPTY block on BOTH branches ────
# (the shared emptiness gate short-circuits before the render seam, so a primer
# error never blocks a delivery — identically under bash and ts).
check_empty_both() {
  local label="$1" fn="$2" arg1="$3" arg2="${4:-}"
  local b t
  b="$(GAFFER_RUNTIME=bash "$fn" "$arg1" ${arg2:+"$arg2"} "query")"
  t="$(GAFFER_RUNTIME=ts   "$fn" "$arg1" ${arg2:+"$arg2"} "query")"
  if [ -z "$b" ] && [ -z "$t" ]; then ok "$label — both branches fail soft to empty"; else no "$label — expected empty on both (bash='$b' ts='$t')"; fi
}
LG_MODE="empty"
check_empty_both "file-cards (empty packet)"    gaffer_prime_context_block   "$REPO" "fixture-app"
FCB_E_B="$(GAFFER_RUNTIME=bash gaffer_product_context_block "fixture-app")"; FCB_E_T="$(GAFFER_RUNTIME=ts gaffer_product_context_block "fixture-app")"
{ [ -z "$FCB_E_B" ] && [ -z "$FCB_E_T" ]; } && ok "product-context (empty rows) — both fail soft to empty" || no "product-context (empty rows) — expected empty on both"
LG_MODE="badjson"
check_empty_both "file-cards (bad JSON)"        gaffer_prime_context_block   "$REPO" "fixture-app"
PCB_BJ_B="$(GAFFER_RUNTIME=bash gaffer_product_context_block "fixture-app")"; PCB_BJ_T="$(GAFFER_RUNTIME=ts gaffer_product_context_block "fixture-app")"
{ [ -z "$PCB_BJ_B" ] && [ -z "$PCB_BJ_T" ]; } && ok "product-context (bad JSON) — both fail soft to empty" || no "product-context (bad JSON) — expected empty on both"

echo ""
echo "context-primer-parity: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
