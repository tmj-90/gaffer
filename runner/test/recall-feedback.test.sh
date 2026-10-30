#!/usr/bin/env bash
# =====================================================================
# Memory Feedback Loop — runner wiring assertions.
# ---------------------------------------------------------------------
# Proves the runner closes the loop between WHAT memory served into a
# ticket's context and HOW the ticket turned out:
#
#   A. context-primer forwards GAFFER_RECALL_TICKET as `--ticket` so memory
#      LOGS the read-event edge for the delivery recall (and only then).
#   B. tick.sh defines a fail-soft `gaffer_recall_feedback` helper (delivery
#      NEVER affected by a feedback error) that calls `lg recall-feedback`.
#   C. tick.sh sets GAFFER_RECALL_TICKET on the DELIVERY prime, and calls the
#      feedback helper at BOTH outcome sites: clean/reworked at submit, blocked
#      at the rework-exhausted park.
#   D. LIVE end-to-end (when memory is built): lore that cards-for-scope merely
#      packs (the primer renders only cards) gets NO outcome credit; lore the
#      agent FETCHED through the memory MCP server's get_lore under
#      GAFFER_RECALL_TICKET does — recall-feedback blocked flags exactly that
#      record and `flagged` surfaces it.
#
# Requires nothing but bash + grep for A–C; D is skipped if memory isn't built.
# Run:  perl -e 'alarm 120; exec @ARGV' /bin/bash runner/test/recall-feedback.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
GAFFER_HOME="$(cd "$RUNNER_DIR/.." && pwd)"
TICK="$RUNNER_DIR/tick.sh"
PRIMER_SH="$RUNNER_DIR/lib/context-primer.sh"
PRIMER_MJS="$RUNNER_DIR/lib/context-primer.mjs"
MEMORY_CLI="$GAFFER_HOME/packages/memory/dist/bin/memory.js"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

echo "== A. context-primer forwards GAFFER_RECALL_TICKET as --ticket =="
if grep -q 'GAFFER_RECALL_TICKET' "$PRIMER_SH" && grep -q -- '--ticket' "$PRIMER_SH"; then
  ok "context-primer.sh forwards --ticket from GAFFER_RECALL_TICKET"
else
  fail "context-primer.sh does not forward --ticket from GAFFER_RECALL_TICKET"
fi
if grep -q 'GAFFER_RECALL_TICKET' "$PRIMER_MJS" && grep -q -- '--ticket' "$PRIMER_MJS"; then
  ok "context-primer.mjs forwards --ticket from GAFFER_RECALL_TICKET"
else
  fail "context-primer.mjs does not forward --ticket from GAFFER_RECALL_TICKET"
fi

echo "== B. tick.sh defines a fail-soft recall-feedback helper =="
if grep -q 'gaffer_recall_feedback()' "$TICK"; then
  ok "gaffer_recall_feedback helper defined"
else
  fail "gaffer_recall_feedback helper missing"
fi
if grep -q 'lg recall-feedback --repo' "$TICK"; then
  ok "helper calls the memory CLI via lg recall-feedback"
else
  fail "helper does not call lg recall-feedback"
fi
# Fail-soft: the helper must swallow errors (never fatal to delivery).
if grep -A14 'gaffer_recall_feedback()' "$TICK" | grep -q 'non-fatal'; then
  ok "helper is fail-soft (non-fatal on error)"
else
  fail "helper is not documented/implemented as fail-soft"
fi

echo "== C. tick.sh sets the recall ticket on delivery + calls feedback at both outcomes =="
if grep -q 'GAFFER_RECALL_TICKET="\$NUM" gaffer_prime_context_block' "$TICK"; then
  ok "delivery prime exports GAFFER_RECALL_TICKET=\$NUM"
else
  fail "delivery prime does not export GAFFER_RECALL_TICKET=\$NUM"
fi
# clean/reworked branch at the submit site.
if grep -q 'gaffer_recall_feedback reworked' "$TICK" && grep -q 'gaffer_recall_feedback clean' "$TICK"; then
  ok "submit site distinguishes clean vs reworked"
else
  fail "submit site does not call clean/reworked feedback"
fi
# blocked branch at the rework-exhausted park.
if grep -q 'gaffer_recall_feedback blocked' "$TICK"; then
  ok "blocked-park calls blocked feedback"
else
  fail "blocked-park does not call blocked feedback"
fi
# The blocked feedback call must sit next to the rework_exhausted park.
if grep -A3 'gaffer_release_delivery blocked' "$TICK" | grep -q 'gaffer_recall_feedback blocked'; then
  ok "blocked feedback is wired at the rework_exhausted park"
else
  fail "blocked feedback is not adjacent to the rework_exhausted park"
fi

echo "== D. LIVE — only lore the agent fetched is credited; blocked flags it =="
MEMORY_MCP="$GAFFER_HOME/packages/memory/dist/bin/memory-mcp.js"
if [ ! -f "$MEMORY_CLI" ] || [ ! -f "$MEMORY_MCP" ]; then
  echo "  SKIP: memory not built ($MEMORY_CLI missing — run: pnpm -C packages/memory build)"
else
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  export MEMORY_DB="$TMP/memory.sqlite" MEMORY_AUDIT_LOG="$TMP/audit.jsonl"
  node "$MEMORY_CLI" add --title "Frobnicate rule" --summary "frobnicate policy" \
    --body "always frobnicate" --repo app --confidence low >/dev/null 2>&1
  LORE_ID="$(node "$MEMORY_CLI" search frobnicate --json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s)[0].id)}catch{}})')"
  # Packed into the scope packet, never rendered → no credit, no flag.
  node "$MEMORY_CLI" cards-for-scope --canonical /repos/app --repo app \
    --query frobnicate --ticket 554 --json >/dev/null 2>&1
  FB0="$(node "$MEMORY_CLI" recall-feedback --repo app --ticket 554 --outcome blocked 2>&1)"
  case "$FB0" in
    *"adjusted: 0"*) ok "packet lore the primer never renders is not adjusted" ;;
    *) fail "recall-feedback adjusted lore the agent never saw (got: ${FB0:0:120})" ;;
  esac
  node "$MEMORY_CLI" cards-for-scope --canonical /repos/app --repo app \
    --query frobnicate --ticket 555 --json >/dev/null 2>&1
  # The delivery agent pulls the record through its memory MCP server (stdio,
  # newline-delimited JSON-RPC), with the env tick.sh renders into .mcp.json.
  GAFFER_FACTORY=1 GAFFER_TICKET_REPOS=app GAFFER_RECALL_TICKET=555 LORE_ID="$LORE_ID" \
    MEMORY_MCP="$MEMORY_MCP" node -e '
      const { spawn } = require("node:child_process");
      const p = spawn(process.execPath, [process.env.MEMORY_MCP], { stdio: ["pipe", "pipe", "ignore"] });
      const send = (m) => p.stdin.write(JSON.stringify(m) + "\n");
      let buf = "";
      p.stdout.on("data", (d) => {
        buf += d;
        for (const line of buf.split("\n").slice(0, -1)) {
          const m = JSON.parse(line);
          if (m.id === 1) {
            send({ jsonrpc: "2.0", method: "notifications/initialized" });
            send({ jsonrpc: "2.0", id: 2, method: "tools/call",
                   params: { name: "get_lore", arguments: { id: process.env.LORE_ID } } });
          } else if (m.id === 2) { p.stdin.end(); p.kill(); }
        }
        buf = buf.slice(buf.lastIndexOf("\n") + 1);
      });
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
      setTimeout(() => { p.kill(); process.exit(1); }, 20000);
    ' >/dev/null 2>&1
  FB="$(node "$MEMORY_CLI" recall-feedback --repo app --ticket 555 --outcome blocked 2>&1)"
  case "$FB" in
    *"adjusted: 1"*) ok "recall-feedback adjusted the lore the agent fetched (blocked)" ;;
    *) fail "recall-feedback did not adjust the fetched lore (got: ${FB:0:120})" ;;
  esac
  FL="$(node "$MEMORY_CLI" flagged --repo app 2>&1)"
  case "$FL" in
    *"Frobnicate rule"*) ok "flagged surfaces the demoted lore" ;;
    *) fail "flagged did not surface the demoted lore (got: ${FL:0:120})" ;;
  esac
  # Idempotency: a second identical outcome is a no-op.
  FB2="$(node "$MEMORY_CLI" recall-feedback --repo app --ticket 555 --outcome blocked 2>&1)"
  case "$FB2" in
    *"already applied"*) ok "recall-feedback is idempotent per (ticket, outcome)" ;;
    *) fail "recall-feedback re-applied (not idempotent) (got: ${FB2:0:120})" ;;
  esac
fi

echo "== E. memory MCP env carries the recall ticket for the ROI read path =="
MCP_JSON="$RUNNER_DIR/.mcp.json"
# The memory server env must forward GAFFER_RECALL_TICKET (one-hop plumbing, same
# pattern as GAFFER_TICKET_REPOS) so the read path can attribute a retrieval.
if grep -q '"GAFFER_RECALL_TICKET": "\${GAFFER_RECALL_TICKET}"' "$MCP_JSON"; then
  ok ".mcp.json memory env forwards GAFFER_RECALL_TICKET"
else
  fail ".mcp.json memory env does not forward GAFFER_RECALL_TICKET"
fi
# The runtime .mcp.json is now rendered through the gaffer_render_mcp_runtime
# seam (the P1b ts-cutover replaced the inline 6-`e` sed chains). The seam's
# THIRD positional arg is the recall ticket, so the delivery render binds it to
# the ticket number ($NUM) and the bootstrap render passes it empty. Match the
# seam call (whitespace-tolerant) rather than the retired inline sed.
if grep -Eq 'gaffer_render_mcp_runtime[[:space:]]+"\$MCP_CONFIG"[[:space:]]+"\$MCP_RUNTIME"[[:space:]]+"\$NUM"' "$TICK"; then
  ok "delivery render sets GAFFER_RECALL_TICKET to \$NUM (seam recall arg)"
else
  fail "delivery render does not set GAFFER_RECALL_TICKET to \$NUM"
fi
# The BOOTSTRAP render leaves it empty (no delivery-recall context → inert).
if grep -Eq 'gaffer_render_mcp_runtime[[:space:]]+"\$MCP_CONFIG"[[:space:]]+"\$MCP_RUNTIME"[[:space:]]+""' "$TICK"; then
  ok "bootstrap render leaves GAFFER_RECALL_TICKET empty (inert, seam recall arg)"
else
  fail "bootstrap render does not leave GAFFER_RECALL_TICKET empty"
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
