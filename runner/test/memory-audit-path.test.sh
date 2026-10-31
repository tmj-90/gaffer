#!/bin/bash
# =====================================================================
# The memory audit log lives inside the factory's $GAFFER_DATA.
# ---------------------------------------------------------------------
# Regression (audit: memory-audit-outside-gaffer-data): memory's audit log
# defaulted to $HOME/.memory/audit.jsonl and nothing in the runner pinned
# MEMORY_AUDIT_LOG, so every factory on a machine shared one trail, deleting
# .gaffer did not start fresh, and in the container it sat outside the data
# volume. factory.config.sh now pins MEMORY_AUDIT_LOG=$GAFFER_DATA/
# memory-audit.jsonl (not audit.jsonl — dispatch's trail) and gaffer_agent_env
# keeps it, so:
#
#   A. `lg doctor` (operator / status pane) names $GAFFER_DATA/memory-audit.jsonl;
#   B. the delivery agent's memory-mcp, started with the env -i'd
#      GAFFER_AGENT_ENV plus the MEMORY_DB the rendered .mcp.json passes,
#      writes its tool-call audit rows there too — not under $HOME.
#
# Skips B when memory is not built. Run: bash runner/test/memory-audit-path.test.sh
# =====================================================================
# shellcheck shell=bash
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
GAFFER_HOME="$(cd "$RUNNER_DIR/.." && pwd)"
MEMORY_MCP="$GAFFER_HOME/packages/memory/dist/bin/memory-mcp.js"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

[ -f "$MEMORY_MCP" ] || { echo "SKIP: memory not built ($MEMORY_MCP missing — run: pnpm -C packages/memory build)"; exit 0; }

TMP="$(mktemp -d)"
gaffer_test_check_tmp "$TMP" || exit 70
trap 'gaffer_test_rm_work "$TMP"' EXIT
mkdir -p "$TMP/home" "$TMP/data"

run_factory() {
  env -i PATH="$PATH" HOME="$TMP/home" SHELL=/bin/bash RUNNER_DIR="$RUNNER_DIR" \
    GAFFER_DATA="$TMP/data" MEMORY_MCP="$MEMORY_MCP" \
    /bin/bash -c 'source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1; '"$1"
}

echo "== A. lg doctor names the audit log under \$GAFFER_DATA =="
DOC="$(run_factory 'lg doctor 2>&1')"
case "$DOC" in
  *"$TMP/data/memory-audit.jsonl"*) ok "doctor reports \$GAFFER_DATA/memory-audit.jsonl" ;;
  *) fail "doctor does not report \$GAFFER_DATA/memory-audit.jsonl (got: $(printf '%s' "$DOC" | grep -i 'audit' | head -1))" ;;
esac
case "$DOC" in
  *".memory/audit.jsonl"*) fail "doctor still points at \$HOME/.memory/audit.jsonl" ;;
  *) ok "doctor no longer points at \$HOME/.memory" ;;
esac

echo "== B. the agent's memory-mcp (env -i'd agent env) audits under \$GAFFER_DATA =="
# shellcheck disable=SC2016  # expanded by the inner bash, after sourcing the config
run_factory '
  gaffer_agent_env
  env -i "${GAFFER_AGENT_ENV[@]}" MEMORY_DB="$MEMORY_DB" GAFFER_FACTORY=1 node -e "
    const { spawn } = require(\"node:child_process\");
    const p = spawn(process.execPath, [process.argv[1]], { stdio: [\"pipe\", \"pipe\", \"ignore\"] });
    const send = (m) => p.stdin.write(JSON.stringify(m) + \"\\n\");
    let buf = \"\";
    p.stdout.on(\"data\", (d) => {
      buf += d;
      for (const line of buf.split(\"\\n\").slice(0, -1)) {
        const m = JSON.parse(line);
        if (m.id === 1) {
          send({ jsonrpc: \"2.0\", method: \"notifications/initialized\" });
          send({ jsonrpc: \"2.0\", id: 2, method: \"tools/call\",
                 params: { name: \"search_lore\", arguments: { query: \"anything\" } } });
        } else if (m.id === 2) { p.stdin.end(); p.kill(); }
      }
      buf = buf.slice(buf.lastIndexOf(\"\\n\") + 1);
    });
    send({ jsonrpc: \"2.0\", id: 1, method: \"initialize\", params: {
      protocolVersion: \"2025-06-18\", capabilities: {}, clientInfo: { name: \"t\", version: \"0\" } } });
    setTimeout(() => { p.kill(); process.exit(1); }, 20000);
  " "$MEMORY_MCP"
' >/dev/null 2>&1
if [ -s "$TMP/data/memory-audit.jsonl" ] && grep -q '"search_lore"' "$TMP/data/memory-audit.jsonl"; then
  ok "memory-mcp wrote its search_lore audit row to \$GAFFER_DATA/memory-audit.jsonl"
else
  fail "memory-mcp audit row missing from \$GAFFER_DATA/memory-audit.jsonl"
fi
if [ -e "$TMP/home/.memory/audit.jsonl" ]; then
  fail "memory-mcp still wrote \$HOME/.memory/audit.jsonl"
else
  ok "nothing written to \$HOME/.memory/audit.jsonl"
fi

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS ($PASS checks)"
  exit 0
else
  echo "FAILED (${#FAILURES[@]} of $((PASS + ${#FAILURES[@]})) checks):"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
