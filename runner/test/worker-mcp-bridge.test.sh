#!/usr/bin/env bash
# =====================================================================
# WORKER SEAM × MCP BRIDGE — under the docker provider the agent is handed a BRIDGED
# MCP config and the real servers run host-side (lib/worker.sh + lib/mcp-bridge.mjs).
# ---------------------------------------------------------------------
# Drives the REAL worker_deliver with a fake `claude` (records its argv + a copy of the
# --mcp-config it was given) and a fake wrap prefix (records GAFFER_MCP_BRIDGE_SOCKET as
# sandbox-docker.sh would see it), no docker. Proves:
#   • the agent's --mcp-config is the .bridge.json (connect stubs, NO env / claim token);
#   • the wrap saw a LIVE socket path in GAFFER_MCP_BRIDGE_SOCKET; the host bridge served it;
#   • after the spawn the socket, the bridged config and the bridge process are gone;
#   • GAFFER_MCP_BRIDGE=0 ⇒ the original config, no socket (legacy layout);
#   • an unrenderable config ⇒ rc 76, NO spawn (fail closed).
# Run: bash test/worker-mcp-bridge.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/worker-bridge.XXXXXX")"; WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT
export GAFFER_DATA="$WORK/.gaffer"; mkdir -p "$GAFFER_DATA"
export GAFFER_LOG="$WORK/factory.log"

# Fake claude: record argv, copy the --mcp-config it received, probe the socket named by
# the wrap, then emit a JSON envelope.
FAKE_CLAUDE="$WORK/fake-claude"
cat > "$FAKE_CLAUDE" <<EOS
#!/usr/bin/env bash
printf '%s\n' "\$@" > "$WORK/claude.argv"
prev=""; for a in "\$@"; do [ "\$prev" = "--mcp-config" ] && cp "\$a" "$WORK/claude.mcp.json" 2>/dev/null; prev="\$a"; done
printf '%s\n' '{"result":"ok","total_cost_usd":0.01,"num_turns":1}'
EOS
chmod +x "$FAKE_CLAUDE"
# Fake wrap prefix (what sandbox_wrap_cmd would return for docker): records the socket
# var and whether it is a live socket, then runs the command.
WRAP="$WORK/fake-wrap"
cat > "$WRAP" <<EOS
#!/usr/bin/env bash
printf '%s\n' "\${GAFFER_MCP_BRIDGE_SOCKET:-<unset>}" > "$WORK/wrap.sock"
if [ -S "\${GAFFER_MCP_BRIDGE_SOCKET:-/nonexistent}" ]; then
  # prove the host bridge is serving: one round trip through connect
  echo '{"probe":1}' | node "$RUNNER_DIR/lib/mcp-bridge.mjs" connect --socket "\$GAFFER_MCP_BRIDGE_SOCKET" --server dispatch > "$WORK/wrap.roundtrip" 2>/dev/null
fi
exec "\$@"
EOS
chmod +x "$WRAP"
STUB="$WORK/stub-server.mjs"
cat > "$STUB" <<'JS'
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
rl.on("line", (l) => process.stdout.write(JSON.stringify({ echo: l, tok: process.env.GAFFER_CLAIM_TOKEN || null }) + "\n"));
rl.on("close", () => process.exit(0));
JS
MCP="$GAFFER_DATA/mcp-runtime.4242.json"
printf '{"mcpServers":{"dispatch":{"command":"%s","args":["%s"],"env":{"GAFFER_CLAIM_TOKEN":"TOPSECRET_CLAIM","DISPATCH_DB":"%s/dispatch.sqlite"}}}}\n' "$(command -v node)" "$STUB" "$GAFFER_DATA" > "$MCP"

export CLAUDE_BIN="$FAKE_CLAUDE" SANDBOX_PROVIDER=docker GAFFER_SANDBOX_CLAUDE_BIN="$FAKE_CLAUDE" GAFFER_SANDBOX_PATH="$PATH"
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
CWD="$WORK/cwd"; mkdir -p "$CWD"
WORKER_CALL_ENV=( GAFFER_BRIDGE_TEST=1 )

echo "== 1: docker wrap + bridge (default on Linux; forced here) =="
rm -f "$WORK"/claude.* "$WORK"/wrap.*
GAFFER_MCP_BRIDGE=1 worker_deliver "$CWD" "the prompt" "" "$MCP" "$WORK/out.json" "$WRAP" 2>"$WORK/err"; rc=$?
[ "$rc" -eq 0 ] && grep -q '"result":"ok"' "$WORK/out.json" && ok "spawn ran and captured the envelope (rc 0)" || fail "spawn should succeed (rc=$rc; err: $(cat "$WORK/err"))"
grep -qx -- "$GAFFER_DATA/mcp-runtime.4242.bridge.json" "$WORK/claude.argv" && ok "claude received the BRIDGED --mcp-config" || fail "claude argv lacks the bridged config: $(tr '\n' ' ' < "$WORK/claude.argv")"
grep -qx -- "$MCP" "$WORK/claude.argv" && fail "claude also received the host config" || ok "the host config (with the token) was not handed to claude"
[ -f "$WORK/claude.mcp.json" ] && grep -q '"connect"' "$WORK/claude.mcp.json" && ok "bridged config server is a mcp-bridge connect stub" || fail "bridged config not a connect stub"
grep -q 'TOPSECRET_CLAIM\|"env"' "$WORK/claude.mcp.json" && fail "bridged config leaks env / the claim token" || ok "bridged config carries no env and no claim token"
sock="$(cat "$WORK/wrap.sock" 2>/dev/null)"
case "$sock" in "$GAFFER_DATA"/mcp-bridge.*.sock) ok "the wrap saw GAFFER_MCP_BRIDGE_SOCKET under GAFFER_DATA" ;; *) fail "wrap saw '$sock'" ;; esac
grep -q '"echo":"{\\"probe\\":1}"' "$WORK/wrap.roundtrip" 2>/dev/null && ok "a round trip through the socket reached the HOST-side server during the spawn" || fail "no round trip through the bridge: $(cat "$WORK/wrap.roundtrip" 2>/dev/null)"
grep -q '"tok":"TOPSECRET_CLAIM"' "$WORK/wrap.roundtrip" 2>/dev/null && ok "…and that server had the claim token from the host config env" || fail "host server lacked the token"
[ ! -e "$sock" ] && ok "socket removed after the spawn" || fail "socket left behind: $sock"
[ ! -e "$GAFFER_DATA/mcp-runtime.4242.bridge.json" ] && ok "bridged config removed after the spawn" || fail "bridged config left behind"
pgrep -f "mcp-bridge.mjs serve --socket $sock" >/dev/null 2>&1 && fail "bridge server still running" || ok "bridge server process gone"
[ -z "${GAFFER_MCP_BRIDGE_SOCKET:-}" ] && ok "GAFFER_MCP_BRIDGE_SOCKET unset after the spawn" || fail "GAFFER_MCP_BRIDGE_SOCKET leaked: $GAFFER_MCP_BRIDGE_SOCKET"

echo "== 2: GAFFER_MCP_BRIDGE=0 ⇒ legacy layout (original config, no socket) =="
rm -f "$WORK"/claude.* "$WORK"/wrap.*
GAFFER_MCP_BRIDGE=0 worker_deliver "$CWD" "p" "" "$MCP" "$WORK/out2.json" "$WRAP" 2>/dev/null; rc=$?
[ "$rc" -eq 0 ] && grep -qx -- "$MCP" "$WORK/claude.argv" && ok "bridge off: claude gets the original config" || fail "bridge off should pass the original config (rc=$rc)"
[ "$(cat "$WORK/wrap.sock")" = "<unset>" ] && ok "bridge off: no GAFFER_MCP_BRIDGE_SOCKET for the wrap" || fail "socket var set with the bridge off: $(cat "$WORK/wrap.sock")"

echo "== 3: no wrap (non-docker) ⇒ untouched even with the bridge on =="
rm -f "$WORK"/claude.* "$WORK"/wrap.*
GAFFER_MCP_BRIDGE=1 worker_deliver "$CWD" "p" "" "$MCP" "$WORK/out3.json" "" 2>/dev/null; rc=$?
[ "$rc" -eq 0 ] && grep -qx -- "$MCP" "$WORK/claude.argv" && ok "no wrap: the original config, no bridge" || fail "no-wrap path changed (rc=$rc)"

echo "== 4: unrenderable config ⇒ fail closed (rc 76, no spawn) =="
rm -f "$WORK"/claude.* "$WORK"/wrap.*
BAD="$GAFFER_DATA/mcp-runtime.bad.json"; printf 'not json\n' > "$BAD"
GAFFER_MCP_BRIDGE=1 worker_deliver "$CWD" "p" "" "$BAD" "$WORK/out4.json" "$WRAP" 2>"$WORK/err4"; rc=$?
[ "$rc" -eq 76 ] && ok "rc 76" || fail "expected rc 76 (got $rc)"
[ ! -f "$WORK/claude.argv" ] && ok "claude was NOT spawned" || fail "claude spawned despite the bridge failure"
grep -q 'fail closed' "$WORK/err4" && ok "the refusal is explained" || fail "no fail-closed message: $(cat "$WORK/err4")"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "worker-mcp-bridge: ALL $PASS checks passed"; exit 0
else echo "worker-mcp-bridge: ${#FAILURES[@]} FAILED (of $((PASS + ${#FAILURES[@]})))"; exit 1; fi
