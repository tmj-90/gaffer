#!/usr/bin/env bash
# Proves the P1b context-dump block (docs/tick-sh-runtime-migration.md) is
# present in tick.sh, DEFAULT-OFF (guarded on GAFFER_CONTEXT_DUMP_DIR being
# non-empty, so both vars unset ⇒ byte-identical behaviour), render-only when
# GAFFER_CONTEXT_DUMP_ONLY=1, and that tick.sh still parses. Pattern follows
# tick-prompt-wiring.test.sh (static wiring assertions, no live run).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TICK="$HERE/../tick.sh"
pass=0
fail=0
ok() {
  echo "  ok   $1"
  pass=$((pass + 1))
}
no() {
  echo "  FAIL $1"
  fail=$((fail + 1))
}
# Assert a FIXED string is present in file $2.  usage: has <label> <file> <needle>
has() { if grep -qF -- "$3" "$2"; then ok "$1"; else no "$1"; fi; }

# The dump block exists and is guarded default-off on the dir var.
has "dump block is guarded on GAFFER_CONTEXT_DUMP_DIR (default-off)" "$TICK" \
  'if [ -n "${GAFFER_CONTEXT_DUMP_DIR:-}" ]; then'
has "dump writes the assembled PROMPT verbatim" "$TICK" \
  'printf '"'"'%s'"'"' "$PROMPT" > "$GAFFER_CONTEXT_DUMP_DIR/prompt.txt"'
has "dump copies the rendered MCP runtime config" "$TICK" \
  'cp -f "$MCP_RUNTIME" "$GAFFER_CONTEXT_DUMP_DIR/mcp-runtime.json"'
has "render-only exit is guarded on GAFFER_CONTEXT_DUMP_ONLY=1 (default-off)" "$TICK" \
  'if [ "${GAFFER_CONTEXT_DUMP_ONLY:-0}" = "1" ]; then'
has "render-only exit releases the claim back to ready first" "$TICK" \
  'gaffer_release_delivery ready "context-dump render-only exit (P1b fixture capture)"'

# The dump must run AFTER the MCP render (it copies $MCP_RUNTIME) and BEFORE
# the agent-boundary wiring — i.e. between chmod 600 and the FG-007 comment.
if awk '/chmod 600 "\$MCP_RUNTIME"/{seen=1} /GAFFER_CONTEXT_DUMP_DIR/{if(seen){found=1; exit}} END{exit !found}' "$TICK"; then
  ok "dump block sits after the MCP runtime render"
else
  no "dump block sits after the MCP runtime render"
fi

if bash -n "$TICK"; then ok "tick.sh parses (bash -n)"; else no "tick.sh parses (bash -n)"; fi

echo "context-dump: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
