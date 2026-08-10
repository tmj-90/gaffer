#!/usr/bin/env bash
# =====================================================================
# P1b context-primer CLI (docs/tick-sh-runtime-migration.md) — proves the typed
# file-cards + product-context block entrypoint
# (packages/crew/src/runtime/context/renderContextPrimerCli.ts) renders
# BYTE-IDENTICALLY to the REAL bash primer blocks, via the captured goldens.
# ---------------------------------------------------------------------
# The primer analogue of runner/test/prompt-render-cli.test.sh, at the stage
# BEFORE the live seam is wired: the CLI exists and is proven equal to the
# captured bash blocks (packages/crew/test/fixtures/tick-context/
# {file-cards,product-context}-block.golden.txt, captured from the REAL bash
# primer by capture-context-golden.sh over the checked-in packet fixtures) so a
# later, flag-gated slice can route gaffer_prime_context_block /
# gaffer_product_context_block through it with the byte-identity contract already
# green — exactly how renderMcpCli.js / renderPromptCli.js landed before their seams.
#
# Covers: file-cards + product-context byte-identity (--out AND stdout, no
# trailing-newline drift), and the FAIL-SOFT contract (bad JSON / empty packet /
# unknown --kind → EMPTY block, exit 0 — a primer error must never block a
# delivery, unlike the fail-CLOSED prompt/mcp entrypoints).
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
CREW_DIR="$ROOT/packages/crew"
CLI="$CREW_DIR/dist/runtime/context/renderContextPrimerCli.js"
FIXTURES="$CREW_DIR/test/fixtures/tick-context"
CARDS_PACKET="$FIXTURES/cards-packet.json"
LORE_ROWS="$FIXTURES/lore-rows.json"
FC_GOLDEN="$FIXTURES/file-cards-block.golden.txt"
PC_GOLDEN="$FIXTURES/product-context-block.golden.txt"

command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
[ -f "$CLI" ] || { echo "SKIP: crew not built ($CLI) — run pnpm -C packages/crew build"; exit 0; }
for f in "$CARDS_PACKET" "$LORE_ROWS" "$FC_GOLDEN" "$PC_GOLDEN"; do
  [ -f "$f" ] || { echo "SKIP: context fixtures missing ($f) — run capture-context-golden.sh"; exit 0; }
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/context-primer-cli.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0
ok() { echo "  ok   $1"; pass=$((pass + 1)); }
no() { echo "  FAIL $1"; fail=$((fail + 1)); }

# ── A. file-cards: --out is byte-identical to the captured bash golden ─────────
node "$CLI" --kind file-cards --out "$WORK/fc.out" < "$CARDS_PACKET" \
  && cmp -s "$WORK/fc.out" "$FC_GOLDEN" \
  && ok "file-cards block (--out) is byte-identical to the real bash primer golden" \
  || no "file-cards block (--out) diverged from the golden"

# ── B. file-cards stdout mode is byte-identical too (no trailing-newline drift) ─
node "$CLI" --kind file-cards < "$CARDS_PACKET" > "$WORK/fc.stdout"
cmp -s "$WORK/fc.stdout" "$FC_GOLDEN" \
  && ok "file-cards block (stdout) is byte-identical (no trailing-newline drift)" \
  || no "file-cards block (stdout) diverged from the golden"

# ── C. product-context: --out + stdout byte-identical to the golden ───────────
node "$CLI" --kind product-context --out "$WORK/pc.out" < "$LORE_ROWS" \
  && cmp -s "$WORK/pc.out" "$PC_GOLDEN" \
  && ok "product-context block (--out) is byte-identical to the real bash primer golden" \
  || no "product-context block (--out) diverged from the golden"
node "$CLI" --kind product-context < "$LORE_ROWS" > "$WORK/pc.stdout"
cmp -s "$WORK/pc.stdout" "$PC_GOLDEN" \
  && ok "product-context block (stdout) is byte-identical" \
  || no "product-context block (stdout) diverged from the golden"

# ── D. FAIL-SOFT: bad JSON → EMPTY block, exit 0 (a primer error never blocks) ─
printf '%s' 'not json at all {' | node "$CLI" --kind file-cards > "$WORK/bad.out" 2>/dev/null
rc=$?
if [ "$rc" -eq 0 ] && [ ! -s "$WORK/bad.out" ]; then
  ok "bad JSON fails soft (empty block, exit 0)"
else
  no "bad JSON should fail soft (empty, exit 0) — got rc=$rc, $(wc -c < "$WORK/bad.out") bytes"
fi

# ── E. FAIL-SOFT: empty file-cards packet → EMPTY block, exit 0 ───────────────
printf '%s' '{"cards":[],"digest":null}' | node "$CLI" --kind file-cards > "$WORK/empty.out" 2>/dev/null
rc=$?
[ "$rc" -eq 0 ] && [ ! -s "$WORK/empty.out" ] \
  && ok "empty packet fails soft (empty block, exit 0)" \
  || no "empty packet should render the empty block (exit 0)"

# ── F. FAIL-SOFT: empty product-context rows → EMPTY block, exit 0 ────────────
printf '%s' '[]' | node "$CLI" --kind product-context > "$WORK/emptypc.out" 2>/dev/null
rc=$?
[ "$rc" -eq 0 ] && [ ! -s "$WORK/emptypc.out" ] \
  && ok "empty product-context rows fail soft (empty block, exit 0)" \
  || no "empty product-context rows should render the empty block (exit 0)"

# ── G. FAIL-SOFT: unknown --kind → EMPTY block, exit 0 ───────────────────────
node "$CLI" --kind bogus < "$CARDS_PACKET" > "$WORK/unknown.out" 2>/dev/null
rc=$?
[ "$rc" -eq 0 ] && [ ! -s "$WORK/unknown.out" ] \
  && ok "unknown --kind fails soft (empty block, exit 0)" \
  || no "unknown --kind should fail soft (empty, exit 0)"

echo ""
echo "context-primer-cli: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
