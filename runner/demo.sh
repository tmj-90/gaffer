#!/usr/bin/env bash
# Gaffer factory — self-contained showcase. Seeds the two MCP servers (memory +
# work), proves both are live, and runs ONE dry-run delivery tick end to end.
# Safe: DRY_RUN stays on — no Claude is invoked and no repo is mutated.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Isolated showcase state (set before sourcing config so these win).
DEMO="${DEMO_DIR:-/tmp/gaffer-showcase}"
rm -rf "$DEMO"; mkdir -p "$DEMO/repo"
# Self-contained: set the identity on the commit itself (-c) so the demo works on a
# fresh machine with no global git user.name/email configured.
( cd "$DEMO/repo" && git init -q \
  && git -c user.email=gaffer-demo@example.invalid -c user.name="Gaffer Demo" commit -q --allow-empty -m init )
export GAFFER_DATA="$DEMO" DISPATCH_DB="$DEMO/dispatch.sqlite" MEMORY_DB="$DEMO/memory.sqlite" DRY_RUN=1
# shellcheck source=factory.config.sh
source "$HERE/factory.config.sh"

line() { printf '\n\033[1m%s\033[0m\n' "$*"; }

[ -f "$DISPATCH_DIR/dist/cli/index.js" ] || { echo "build first: pnpm -C $DISPATCH_DIR build"; exit 1; }
[ -f "$MEMORY_CLI_BIN" ] || { echo "build first: pnpm -C $MEMORY_DIR build"; exit 1; }

line "1 ▸ Seed Memory (memory) — your real memory-mcp"
lg init >/dev/null 2>&1 || true
lg demo --force >/dev/null 2>&1 || true   # memory's own 5-record illustrative seed
echo "  ratified records seeded (memory demo)"

line "2 ▸ Seed Dispatch (work) — a ready ticket"
wg init >/dev/null
wg repo add -n demo --path "$DEMO/repo" --stack node --test "pnpm test" >/dev/null
wg ticket create -t "Add a /health endpoint" -d "Expose GET /health returning {status:'ok'}" -p team_light >/dev/null
wg repo link 1 demo >/dev/null
wg ac add 1 -t "GET /health returns 200 with {status:'ok'}" >/dev/null
wg ticket ready 1 >/dev/null
node "$CREW_DIR/dist/cli/index.js" init -d "$GAFFER_DATA" -n showcase >/dev/null 2>&1 || true
echo "  ticket #1 ready, linked to repo 'demo' (node)"

line "3 ▸ The two MCP servers are real (live stdio handshake)"
PING="$MEMORY_DIR/.demo-ping.mjs"
cat > "$PING" <<'EOF'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const [label, arg, k, v] = process.argv.slice(2);
const c = new Client({ name: "ping", version: "0" }, { capabilities: {} });
await c.connect(new StdioClientTransport({ command: "node", args: [arg], env: { ...process.env, [k]: v } }));
const tools = (await c.listTools()).tools.map((t) => t.name);
console.log(`  ${label}: ${tools.length} tools — ${tools.join(", ")}`);
await c.close();
EOF
node "$PING" "dispatch-mcp" "$DISPATCH_DIR/dist/mcp/bin.js" DISPATCH_DB "$DISPATCH_DB"
node "$PING" "memory-mcp" "$MEMORY_MCP_BIN" MEMORY_DB "$MEMORY_DB"
rm -f "$PING"

line "4 ▸ One factory tick (DRY-RUN — nothing is invoked or mutated)"
bash "$HERE/tick.sh" 2>&1 | sed 's/^[0-9T:-]* //; s#'"$HERE"'#runner#g' | grep -vE '^TICK_RESULT'

line "▸ Live run: review factory.config.sh, then  DRY_RUN=0 bash loop.sh"
echo "  Audit trail: dispatch ticket show 1   (or the web UI: dispatch-api)"
