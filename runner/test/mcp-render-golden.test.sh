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
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
RENDER_CLI="$ROOT/packages/crew/dist/runtime/context/renderMcpCli.js"
TEMPLATE="$RUNNER_DIR/.mcp.json"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
[ -f "$RENDER_CLI" ] || { echo "SKIP: crew not built ($RENDER_CLI) — run pnpm -C packages/crew build"; exit 0; }
[ -f "$TEMPLATE" ] || { echo "FAIL: template missing ($TEMPLATE)" >&2; exit 1; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/mcp-render-golden.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT
export GAFFER_DATA="$WORK/data" DISPATCH_DB="$WORK/data/dispatch.sqlite" MEMORY_DB="$WORK/data/memory.sqlite"
mkdir -p "$GAFFER_DATA"
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh"
# shellcheck source=lib/seam-golden.sh
source "$HERE/lib/seam-golden.sh"
pass=0; fail=0
ok() { echo "  ok   $1"; pass=$((pass + 1)); }
no() { echo "  FAIL $1"; fail=$((fail + 1)); }

render_case() { # <name> <label> <db> <mdb> <dbin> <mbin> <token> <repos> <recall> <scope>
  local name="$1" label="$2"
  DISPATCH_DB="$3" MEMORY_DB="$4" DISPATCH_MCP_BIN="$5" MEMORY_MCP_BIN="$6" CLAIM_TOKEN="$7" GAFFER_TICKET_REPOS="$8"
  if ! gaffer_render_mcp_runtime "$TEMPLATE" "$WORK/out.json" "$9" "${10}"; then no "$label — render exited non-zero"; return; fi
  seam_golden mcp-render "$name" "$WORK/out.json" "$label"
}
DB="/data/gaffer/dispatch.sqlite"; MDB="/data/gaffer/memory.sqlite"
DBIN="/opt/gaffer/dispatch-mcp/bin.js"; MBIN="/opt/gaffer/memory-mcp/bin.js"; TOK="fixture-claim-token"
render_case delivery        "delivery (recall=77)"                        "$DB" "$MDB" "$DBIN" "$MBIN" "$TOK" "fixture-app" "77" "77"
render_case bootstrap       "bootstrap (recall empty, scope=77)"          "$DB" "$MDB" "$DBIN" "$MBIN" "$TOK" "fixture-app" ""   "77"
render_case empty-token     "empty claim token"                           "$DB" "$MDB" "$DBIN" "$MBIN" ""     "fixture-app" "42" "42"
TRICKY='/data/di#r/w&x$&$'\''z.sqlite'
render_case escaping        "escaping torture (# & \$& \$')"              "$TRICKY" "$MDB" "$DBIN" "$MBIN" "$TOK" "fixture-app" "77" "77"
render_case colon-repos     "colon-joined repos (a:b:c)"                  "$DB" "$MDB" "$DBIN" "$MBIN" "$TOK" "a:b:c" "77" "77"
render_case review-clarify  "review/clarify (recall empty, repos empty)"  "$DB" "$MDB" "$DBIN" "$MBIN" "$TOK" "" "" ""

# The scope ticket is a template placeholder (not a post-render JSON edit), so it lands
# in the dispatch server env and the rest of the render keeps the template's bytes.
DISPATCH_DB="$DB" MEMORY_DB="$MDB" DISPATCH_MCP_BIN="$DBIN" MEMORY_MCP_BIN="$MBIN" CLAIM_TOKEN="$TOK" GAFFER_TICKET_REPOS="fixture-app"
gaffer_render_mcp_runtime "$TEMPLATE" "$WORK/scope.json" "77" "77" \
  && [ "$(node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).mcpServers.dispatch.env.GAFFER_SCOPE_TICKET))' "$WORK/scope.json")" = "77" ] \
  && ok "scope ticket lands in the dispatch server env (GAFFER_SCOPE_TICKET=77)" || no "scope ticket missing from the dispatch server env"
gaffer_render_mcp_runtime "$TEMPLATE" "$WORK/noscope.json" "77" && grep -q '"GAFFER_SCOPE_TICKET": ""' "$WORK/noscope.json" \
  && ok "omitted scope ticket renders empty (binds nothing — fail closed)" || no "omitted scope ticket did not render empty"

# The card-canonical binding (GAFFER_REPO_CANONICALS, a JSON object) is JSON-escaped
# into the memory env, so a canonical with quotes / backslashes / # & round-trips.
DISPATCH_DB="$DB" MEMORY_DB="$MDB" DISPATCH_MCP_BIN="$DBIN" MEMORY_MCP_BIN="$MBIN" CLAIM_TOKEN="$TOK" GAFFER_TICKET_REPOS="fixture-app"
_CANON_MAP='{"fixture-app":"/repos/fi\\x \"q\" #&$1","b":"github.com/acme/b"}'
GAFFER_REPO_CANONICALS="$_CANON_MAP" gaffer_render_mcp_runtime "$TEMPLATE" "$WORK/canon.json" "77" "77" \
  && [ "$(node -e 'const f=require("node:fs");const e=JSON.parse(f.readFileSync(process.argv[1],"utf8")).mcpServers.memory.env;process.stdout.write(String(JSON.stringify(JSON.parse(e.GAFFER_REPO_CANONICALS))===JSON.stringify(JSON.parse(process.argv[2]))&&e.MEMORY_AUTO_APPROVE==="0"))' "$WORK/canon.json" "$_CANON_MAP")" = "true" ] \
  && ok "repo-canonical map round-trips into the memory env; MEMORY_AUTO_APPROVE pinned 0" || no "repo-canonical map / auto-approve pin wrong in the memory env"
# The delivery + bootstrap sites set the binding before their render.
[ "$(grep -c 'GAFFER_REPO_CANONICALS="$(.*gaffer_repo_canonicals_json)"' "$RUNNER_DIR/tick.sh")" -eq 2 ] \
  && ok "delivery + bootstrap bind the repo-canonical map" || no "tick.sh does not bind GAFFER_REPO_CANONICALS at both render sites"

# Call sites: bootstrap + delivery (tick.sh) and clarify bind their ticket through the
# render's scope argument, and nothing re-edits the rendered JSON to add it (a
# post-render edit re-serialises the file, drifting the bash render from the TS golden).
grep -Eq 'gaffer_render_mcp_runtime "\$MCP_CONFIG" "\$MCP_RUNTIME" "" "\$NUM"' "$RUNNER_DIR/tick.sh" \
  && ok "bootstrap render binds scope ticket \$NUM" || no "bootstrap render does not pass the scope ticket"
grep -Eq 'gaffer_render_mcp_runtime "\$MCP_CONFIG" "\$MCP_RUNTIME" "\$NUM" "\$NUM"' "$RUNNER_DIR/tick.sh" \
  && ok "delivery render binds scope ticket \$NUM" || no "delivery render does not pass the scope ticket"
grep -Eq 'gaffer_render_mcp_runtime "\$MCP_CONFIG" "\$MCP_RUNTIME" "" "\$CNUM"' "$RUNNER_DIR/lib/clarify.sh" \
  && ok "clarify render binds scope ticket \$CNUM" || no "clarify render does not pass the scope ticket"
if grep -Rq 'gaffer_mcp_runtime_set_env[^#]*GAFFER_SCOPE_TICKET' "$RUNNER_DIR/tick.sh" "$RUNNER_DIR/lib"; then
  no "GAFFER_SCOPE_TICKET is still bound by a post-render JSON edit"
else
  ok "GAFFER_SCOPE_TICKET is never bound by a post-render JSON edit"
fi

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
