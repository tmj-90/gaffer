#!/usr/bin/env bash
# =====================================================================
# LOAD-BEARING byte-identity test (docs/tick-sh-runtime-migration.md P1b).
# ---------------------------------------------------------------------
# This is the test that was MISSING: it drives the SINGLE render seam
# gaffer_render_mcp_runtime (factory.config.sh) BOTH ways on the SAME
# inputs — the legacy bash sed (GAFFER_RUNTIME=bash) and the typed node
# renderer (GAFFER_RUNTIME=ts, renderMcpCli.js → renderMcpRuntimeConfig)
# — and asserts the two outputs are BYTE-IDENTICAL (cmp, incl. ordering,
# whitespace, escaping, and the trailing newline). Because tick.sh's
# delivery + bootstrap ticks both render through this same seam, byte
# parity here is byte parity live. This is the guard that stops the two
# render paths drifting again (the class of bug that shipped an
# unsubstituted ${GAFFER_RECALL_TICKET}).
#
# The crew golden test (packages/crew/test/tick-context-assembly.test.ts)
# proves the TS render FUNCTION matches the bash-captured golden; this
# test proves the live node ENTRYPOINT + the live bash sed agree end to
# end, through the exact function tick.sh calls, on both recall-set and
# recall-empty inputs.
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
CREW_DIR="$ROOT/packages/crew"
RENDER_CLI="$CREW_DIR/dist/runtime/context/renderMcpCli.js"
TEMPLATE="$RUNNER_DIR/.mcp.json"

command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
[ -f "$RENDER_CLI" ] || { echo "SKIP: crew not built ($RENDER_CLI) — run pnpm -C packages/crew build"; exit 0; }
[ -f "$TEMPLATE" ] || { echo "FAIL: template missing ($TEMPLATE)" >&2; exit 1; }

# The seam under test + its sed helper live in factory.config.sh. Source it
# with the DB vars set (mirrors capture-context-golden.sh) so its top-level
# defaults resolve without side effects.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/mcp-render-parity.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
export GAFFER_DATA="$WORK/data" DISPATCH_DB="$WORK/data/dispatch.sqlite" MEMORY_DB="$WORK/data/memory.sqlite"
mkdir -p "$GAFFER_DATA"
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh"

pass=0
fail=0
ok() { echo "  ok   $1"; pass=$((pass + 1)); }
no() { echo "  FAIL $1"; fail=$((fail + 1)); }

# render_case <label> <dispatchDb> <memoryDb> <dispatchBin> <memoryBin> \
#             <claimToken> <ticketRepos> <recall>
# Sets the six ambient globals the seam reads, renders BOTH branches, and
# asserts the two files are byte-identical (cmp -s covers the trailing \n).
render_case() {
  local label="$1"
  DISPATCH_DB="$2" MEMORY_DB="$3" DISPATCH_MCP_BIN="$4" MEMORY_MCP_BIN="$5" \
    CLAIM_TOKEN="$6" GAFFER_TICKET_REPOS="$7"
  local recall="$8"
  local out_bash="$WORK/out.bash.json" out_ts="$WORK/out.ts.json"

  if ! GAFFER_RUNTIME=bash gaffer_render_mcp_runtime "$TEMPLATE" "$out_bash" "$recall"; then
    no "$label — bash render exited non-zero"; return
  fi
  if ! GAFFER_RUNTIME=ts gaffer_render_mcp_runtime "$TEMPLATE" "$out_ts" "$recall"; then
    no "$label — ts render exited non-zero"; return
  fi
  if cmp -s "$out_bash" "$out_ts"; then
    ok "$label — bash sed and ts renderer are byte-identical"
  else
    echo "----- diff (bash left, ts right) -----" >&2
    diff "$out_bash" "$out_ts" >&2 || true
    no "$label — bash sed and ts renderer DIVERGED"
  fi
}

DB="/data/gaffer/dispatch.sqlite"
MDB="/data/gaffer/memory.sqlite"
DBIN="/opt/gaffer/dispatch-mcp/bin.js"
MBIN="/opt/gaffer/memory-mcp/bin.js"
TOK="ct_live_9f3a7b21c0"

# 1. Delivery-shaped: recall set to a ticket number, single repo, real token.
render_case "delivery (recall=77)" "$DB" "$MDB" "$DBIN" "$MBIN" "$TOK" "fixture-app" "77"

# 2. Bootstrap-shaped: recall EMPTY (the exact placeholder-leak bug class the
#    slice kills — bootstrap renders ${GAFFER_RECALL_TICKET} as "").
render_case "bootstrap (recall empty)" "$DB" "$MDB" "$DBIN" "$MBIN" "$TOK" "fixture-app" ""

# 3. Empty claim token (resumed delivery / dry-run — no runner-held token).
render_case "empty claim token" "$DB" "$MDB" "$DBIN" "$MBIN" "" "fixture-app" "42"

# 4. Escaping torture: a db path with sed-special (#, &) and replace-special
#    ($&, $') characters — proves _gaffer_sed_repl (sed) and split/join (ts)
#    agree on the literal substitution.
TRICKY='/data/di#r/w&x$&$'\''z.sqlite'
render_case "escaping torture (# & \$& \$')" "$TRICKY" "$MDB" "$DBIN" "$MBIN" "$TOK" "fixture-app" "77"

# 5. Colon-joined multi-repo scope (the delivery WT_ROWS shape).
render_case "colon-joined repos (a:b:c)" "$DB" "$MDB" "$DBIN" "$MBIN" "$TOK" "a:b:c" "77"

# 6. Review/clarify shape: recall EMPTY *and* ticket-repos EMPTY (non-delivery
#    ticks — reviewer/clarify hold no delivery claim scope and do no scope-bound
#    memory direct-apply writes). Proves bash≡ts on the exact inputs review.sh /
#    clarify.sh now feed the seam.
render_case "review/clarify (recall empty, repos empty)" "$DB" "$MDB" "$DBIN" "$MBIN" "$TOK" "" ""

# ── Negative control: the ts branch must FAIL CLOSED on a drifted template
# with an unsubstituted placeholder (the bash sed would silently pass it
# through — the divergence this migration exists to kill). Proves the live
# entrypoint rejects a broken render rather than launching an agent with it.
BROKEN="$WORK/broken.mcp.json"
# A minimal valid-shape template whose memory DB carries a misspelled token.
printf '%s' '{"mcpServers":{"dispatch":{"env":{"DISPATCH_DB":"${DISPATCH_DB}"}},"memory":{"env":{"MEMORY_DB":"${MEMROY_DB}"}}}}' > "$BROKEN"
DISPATCH_DB="$DB" MEMORY_DB="$MDB" DISPATCH_MCP_BIN="$DBIN" MEMORY_MCP_BIN="$MBIN" \
  CLAIM_TOKEN="$TOK" GAFFER_TICKET_REPOS="fixture-app"
if GAFFER_RUNTIME=ts gaffer_render_mcp_runtime "$BROKEN" "$WORK/broken.out" "77" 2>/dev/null; then
  no "negative control — ts render did NOT fail closed on a leftover placeholder"
else
  ok "negative control — ts render fails closed on a leftover placeholder"
fi

echo "mcp-render-parity: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
