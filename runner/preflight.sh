#!/usr/bin/env bash
# Gaffer factory — preflight / doctor. Verifies everything is in place before a
# trial run and prints a clear PASS / WARN / FAIL report. Non-mutating.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=factory.config.sh
source "$HERE/factory.config.sh"

pass=0; warn=0; fail=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; pass=$((pass+1)); }
wn()   { printf '  \033[33m!\033[0m %s\n' "$*"; warn=$((warn+1)); }
no()   { printf '  \033[31m✗\033[0m %s\n' "$*"; fail=$((fail+1)); }

echo "Gaffer factory preflight"

# Toolchain
command -v node >/dev/null && ok "node $(node -v)" || no "node missing"
command -v pnpm >/dev/null && ok "pnpm $(pnpm -v)" || wn "pnpm missing (needed for setup/builds)"
if command -v "$CLAUDE_BIN" >/dev/null; then ok "claude CLI: $($CLAUDE_BIN --version 2>/dev/null | head -1)"
else wn "claude CLI not on PATH — required for LIVE runs (dry-run works without it)"; fi

# Builds
for pair in "dispatch:$DISPATCH_DIR" "crew:$CREW_DIR"; do
  name="${pair%%:*}"; dir="${pair##*:}"
  [ -f "$dir/dist/cli/index.js" ] && ok "$name built (dist/cli)" || no "$name not built — run setup.sh"
done
[ -f "$MEMORY_CLI_BIN" ] && ok "memory built" || no "memory not built — pnpm -C $MEMORY_DIR build"
[ -f "$DISPATCH_DIR/dist/mcp/bin.js" ] && ok "dispatch-mcp bin present" || no "dispatch-mcp not built"
[ -f "$MEMORY_MCP_BIN" ] && ok "memory-mcp bin present" || no "memory-mcp not built"

# Factory state
[ -f "$DISPATCH_DB" ] && ok "dispatch db" || wn "dispatch db missing (setup.sh creates it)"
[ -f "$MEMORY_DB" ] && ok "memory db" || wn "memory db missing (setup.sh creates it)"
[ -f "$CREW_CONFIG" ] && ok "crew.yaml" || wn "crew.yaml missing (setup.sh creates it)"

# Factory wiring
[ -f "$MCP_CONFIG" ] && ok ".mcp.json (both servers)" || no ".mcp.json missing"
[ -f "$CLAUDE_SETTINGS" ] && ok "claude settings (hook + permissions)" || no "settings.json missing"
node --check "$HERE/safety-hook.mjs" 2>/dev/null && ok "safety hook parses" || no "safety hook broken"
SK=$(find "$SKILLS_DIR" -name SKILL.md 2>/dev/null | wc -l | tr -d ' ')
[ "${SK:-0}" -gt 0 ] && ok "$SK skills installed" || no "no skills found in $SKILLS_DIR"

# Live MCP handshake (best-effort; only if servers are built)
if [ -f "$MEMORY_MCP_BIN" ] && command -v node >/dev/null; then
  PING="$MEMORY_DIR/.preflight-ping.mjs"
  cat > "$PING" <<'EOF'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const [arg,k,v]=process.argv.slice(2);
const c=new Client({name:"pf",version:"0"},{capabilities:{}});
await c.connect(new StdioClientTransport({command:"node",args:[arg],env:{...process.env,[k]:v}}));
console.log((await c.listTools()).tools.length); await c.close();
EOF
  WT=$(node "$PING" "$DISPATCH_DIR/dist/mcp/bin.js" DISPATCH_DB "$DISPATCH_DB" 2>/dev/null || echo 0)
  LT=$(node "$PING" "$MEMORY_MCP_BIN" MEMORY_DB "$MEMORY_DB" 2>/dev/null || echo 0)
  rm -f "$PING"
  [ "${WT:-0}" -ge 1 ] && ok "dispatch-mcp responds ($WT tools)" || no "dispatch-mcp did not respond"
  [ "${LT:-0}" -ge 1 ] && ok "memory-mcp responds ($LT tools)" || no "memory-mcp did not respond"
fi

echo
echo "  $pass passed · $warn warnings · $fail failures · DRY_RUN=$DRY_RUN"
if [ "$fail" -gt 0 ]; then echo "  → fix failures (likely: bash setup.sh)"; exit 1; fi
if command -v "$CLAUDE_BIN" >/dev/null; then echo "  → ready. Try: bash demo.sh   then   DRY_RUN=0 bash loop.sh"
else echo "  → ready for dry-run (bash demo.sh). Install Claude Code for live runs."; fi
