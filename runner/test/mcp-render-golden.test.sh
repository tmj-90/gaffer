#!/usr/bin/env bash
# =====================================================================
# MCP RUNTIME RENDER — gaffer_render_mcp_runtime (factory.config.sh) renders the
# per-tick .mcp.json through the typed renderer (packages/crew renderMcpCli.js →
# renderMcpRuntimeConfig). Its output for delivery / bootstrap / review-clarify
# inputs, an empty claim token, sed-hostile paths and colon-joined repos is pinned
# to fixtures/typed-seams/mcp-render/<case>.txt — captured from the bash sed the
# renderer replaced (proven byte-identical by the former parity test). The
# renderer FAILS CLOSED on a leftover placeholder and without the crew build.
# Run: bash runner/test/mcp-render-golden.test.sh   (SEAM_GOLDEN_CAPTURE=1 to re-pin)
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
RENDER_CLI="$ROOT/packages/crew/dist/runtime/context/renderMcpCli.js"
TEMPLATE="$RUNNER_DIR/.mcp.json"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
[ -f "$RENDER_CLI" ] || { echo "SKIP: crew not built ($RENDER_CLI) — run pnpm -C packages/crew build"; exit 0; }
[ -f "$TEMPLATE" ] || { echo "FAIL: template missing ($TEMPLATE)" >&2; exit 1; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/mcp-render-golden.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
export GAFFER_DATA="$WORK/data" DISPATCH_DB="$WORK/data/dispatch.sqlite" MEMORY_DB="$WORK/data/memory.sqlite"
mkdir -p "$GAFFER_DATA"
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh"
# shellcheck source=lib/seam-golden.sh
source "$HERE/lib/seam-golden.sh"
pass=0; fail=0
ok() { echo "  ok   $1"; pass=$((pass + 1)); }
no() { echo "  FAIL $1"; fail=$((fail + 1)); }

render_case() { # <name> <label> <db> <mdb> <dbin> <mbin> <token> <repos> <recall>
  local name="$1" label="$2"
  DISPATCH_DB="$3" MEMORY_DB="$4" DISPATCH_MCP_BIN="$5" MEMORY_MCP_BIN="$6" CLAIM_TOKEN="$7" GAFFER_TICKET_REPOS="$8"
  if ! gaffer_render_mcp_runtime "$TEMPLATE" "$WORK/out.json" "$9"; then no "$label — render exited non-zero"; return; fi
  seam_golden mcp-render "$name" "$WORK/out.json" "$label"
}
DB="/data/gaffer/dispatch.sqlite"; MDB="/data/gaffer/memory.sqlite"
DBIN="/opt/gaffer/dispatch-mcp/bin.js"; MBIN="/opt/gaffer/memory-mcp/bin.js"; TOK="fixture-claim-token"
render_case delivery        "delivery (recall=77)"                        "$DB" "$MDB" "$DBIN" "$MBIN" "$TOK" "fixture-app" "77"
render_case bootstrap       "bootstrap (recall empty)"                    "$DB" "$MDB" "$DBIN" "$MBIN" "$TOK" "fixture-app" ""
render_case empty-token     "empty claim token"                           "$DB" "$MDB" "$DBIN" "$MBIN" ""     "fixture-app" "42"
TRICKY='/data/di#r/w&x$&$'\''z.sqlite'
render_case escaping        "escaping torture (# & \$& \$')"              "$TRICKY" "$MDB" "$DBIN" "$MBIN" "$TOK" "fixture-app" "77"
render_case colon-repos     "colon-joined repos (a:b:c)"                  "$DB" "$MDB" "$DBIN" "$MBIN" "$TOK" "a:b:c" "77"
render_case review-clarify  "review/clarify (recall empty, repos empty)"  "$DB" "$MDB" "$DBIN" "$MBIN" "$TOK" "" ""

# No placeholder may survive a render (the pre-seam inline sed leaked ${GAFFER_TICKET_REPOS}).
DISPATCH_DB="$DB" MEMORY_DB="$MDB" DISPATCH_MCP_BIN="$DBIN" MEMORY_MCP_BIN="$MBIN" CLAIM_TOKEN="$TOK" GAFFER_TICKET_REPOS=""
gaffer_render_mcp_runtime "$TEMPLATE" "$WORK/rc.json" "" && ! grep -q '\${' "$WORK/rc.json" \
  && ok "review/clarify render leaves no \${…} placeholder behind" || no "placeholder leaked in the review/clarify render"

# Negative controls: leftover placeholder → fail closed; missing crew dist → fail closed.
BROKEN="$WORK/broken.mcp.json"
printf '%s' '{"mcpServers":{"dispatch":{"env":{"DISPATCH_DB":"${DISPATCH_DB}"}},"memory":{"env":{"MEMORY_DB":"${MEMROY_DB}"}}}}' > "$BROKEN"
GAFFER_TICKET_REPOS="fixture-app"
if gaffer_render_mcp_runtime "$BROKEN" "$WORK/broken.out" "77" 2>/dev/null; then no "negative control — did NOT fail closed on a leftover placeholder"; else ok "negative control — fails closed on a leftover placeholder"; fi
if CREW_DIR="$WORK/nope" gaffer_render_mcp_runtime "$TEMPLATE" "$WORK/nodist.out" "77" 2>/dev/null; then no "missing crew dist did NOT fail closed"; else ok "missing crew dist → non-zero (fail closed, no agent launched on an unrendered config)"; fi

echo ""; echo "mcp-render-golden: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
