#!/usr/bin/env bash
# =====================================================================
# B2 — per-tick MCP runtime config isolates each worker's claim token.
# ---------------------------------------------------------------------
# Under GAFFER_CONCURRENCY>1, loop.sh spawns N worker.sh, each running a
# SEPARATE `bash tick.sh` process against the SAME $GAFFER_DATA. tick.sh
# seds the runner-held GAFFER_CLAIM_TOKEN into an MCP runtime config that
# the agent's `claude -p --mcp-config` reads (asynchronously, long after
# the tick body has moved on).
#
# THE BUG (fixed): tick.sh used a SINGLE fixed path
# ($GAFFER_DATA/mcp-runtime.json). Worker B claiming #20 overwrote the
# file worker A (claim #10) had just written → A's claude read B's token →
# record_ac_evidence(#10) failed CLAIM_INVALID → ACs never marked, good
# deliveries rejected, budget burned. A lock can't fix it (claude reads the
# file after the tick returns). The fix gives each tick its OWN path —
# `mcp-runtime.$$.json`, a fresh PID per tick.sh process.
#
# This drives that behaviour with TWO real concurrent processes (each a
# distinct PID, exactly like two worker.sh-spawned ticks), each rendering
# the REAL runner/.mcp.json template via tick.sh's exact substitution, and
# proves:
#   1. per-PID paths  → each tick reads back ITS OWN token (isolation).
#   2. the OLD fixed path → at least one tick reads the WRONG token
#      (reproduces the corruption the fix removes — proving the test bites).
#   3. tick.sh actually uses the per-PID path (guards against a silent
#      revert of the fix).
#
# A cross-process write-barrier makes the interleaving deterministic on any
# scheduler: both ticks finish WRITING before either READS, so the shared
# path is guaranteed clobbered while the per-PID paths are not.
#
# Zero deps beyond bash + sed. Run: bash test/claim-token-isolation.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
TEMPLATE="$RUNNER_DIR/.mcp.json"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

[ -f "$TEMPLATE" ] || { echo "SKIP: $TEMPLATE not found"; exit 0; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/claim-token.XXXXXX")"
cleanup_tmp() { rm -rf "$WORK"; }
trap cleanup_tmp EXIT

# A single "tick" as its OWN process (so $$ is unique per invocation, exactly
# like `bash tick.sh` spawned by worker.sh). It renders the runtime config with
# tick.sh's EXACT substitution, then — AFTER a barrier that both ticks pass only
# once BOTH have written — reads the token back (simulating claude's async read).
#   $1 mode (perpid|fixed)  $2 token  $3 GAFFER_DATA  $4 result-file  $5 template
cat > "$WORK/tick-sim.sh" <<'SIM'
set -uo pipefail
MODE="$1"; CLAIM_TOKEN="$2"; GAFFER_DATA="$3"; RESULT="$4"; MCP_CONFIG="$5"
if [ "$MODE" = perpid ]; then
  MCP_RUNTIME="$GAFFER_DATA/mcp-runtime.$$.json"   # THE FIX (mirrors tick.sh)
else
  MCP_RUNTIME="$GAFFER_DATA/mcp-runtime.json"      # the OLD shared path (the bug)
fi
# tick.sh's exact substitution (other placeholders → harmless dummies here).
sed -e "s#\${DISPATCH_DB}#/tmp/d.db#g" -e "s#\${MEMORY_DB}#/tmp/m.db#g" \
    -e "s#\${DISPATCH_MCP_BIN}#/tmp/d.js#g" -e "s#\${MEMORY_MCP_BIN}#/tmp/m.js#g" \
    -e "s#\${GAFFER_CLAIM_TOKEN}#${CLAIM_TOKEN}#g" "$MCP_CONFIG" > "$MCP_RUNTIME"
# Cross-process barrier: announce our write, then wait for BOTH ticks to have
# written before anyone reads. Guarantees the async read observes the final
# state (deterministic clobber on the shared path; no clobber on per-PID paths).
touch "$GAFFER_DATA/.wrote.$CLAIM_TOKEN"
for _ in $(seq 1 200); do
  set -- "$GAFFER_DATA"/.wrote.*
  [ "$#" -ge 2 ] && break
  sleep 0.02
done
# Simulate claude reading the config asynchronously.
readback="$(grep -o '"GAFFER_CLAIM_TOKEN": "[^"]*"' "$MCP_RUNTIME" | head -1 | sed 's/.*: "//; s/"$//')"
printf '%s %s\n' "$CLAIM_TOKEN" "$readback" > "$RESULT"
SIM

run_pair() {  # $1 mode → echoes "<mismatches> <distinct-runtime-files>"
  local mode="$1"
  local gd="$WORK/data-$mode"; rm -rf "$gd"; mkdir -p "$gd"
  local rA="$WORK/res-$mode-A" rB="$WORK/res-$mode-B"
  bash "$WORK/tick-sim.sh" "$mode" "TOKEN_A_aaaa" "$gd" "$rA" "$TEMPLATE" &
  local pA=$!
  bash "$WORK/tick-sim.sh" "$mode" "TOKEN_B_bbbb" "$gd" "$rB" "$TEMPLATE" &
  local pB=$!
  wait "$pA"; wait "$pB"
  local mism=0 own rb
  for f in "$rA" "$rB"; do
    read -r own rb < "$f"
    [ "$own" = "$rb" ] || mism=$((mism+1))
  done
  local files; files="$(ls "$gd"/mcp-runtime.*json 2>/dev/null | wc -l | tr -d ' ')"
  printf '%s %s\n' "$mism" "$files"
}

echo "== 1. per-PID paths: each concurrent tick reads back ITS OWN token =="
# bash-3.2-safe capture of run_pair's "<mism> <files>" line (no `< <()` process sub).
set -- $(run_pair perpid); mism="$1"; files="$2"
[ "$mism" -eq 0 ] && ok "no token cross-read under concurrency (0 mismatches)" \
  || fail "per-PID isolation broken — $mism tick(s) read the wrong token"
[ "$files" -ge 2 ] && ok "each tick wrote its own runtime file ($files distinct)" \
  || fail "expected ≥2 distinct per-PID runtime files, saw $files"

echo "== 2. control: the OLD shared path DOES clobber (proves the test bites) =="
set -- $(run_pair fixed); mism_fixed="$1"
[ "$mism_fixed" -ge 1 ] && ok "shared fixed path clobbers a token ($mism_fixed mismatch) — bug reproduced" \
  || fail "shared-path clobber NOT reproduced — the isolation test would not catch a regression"

echo "== 3. tick.sh uses the per-PID path (no silent revert of the fix) =="
grep -q 'MCP_RUNTIME="\$GAFFER_DATA/mcp-runtime\.\$\$\.json"' "$RUNNER_DIR/tick.sh" \
  && ok "tick.sh renders mcp-runtime.\$\$.json (per-tick)" \
  || fail "tick.sh no longer uses a per-PID mcp-runtime path"
! grep -q 'MCP_RUNTIME="\$GAFFER_DATA/mcp-runtime\.json"' "$RUNNER_DIR/tick.sh" \
  && ok "no fixed shared mcp-runtime.json path remains in tick.sh" \
  || fail "a fixed shared mcp-runtime.json path is still present in tick.sh"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "claim-token-isolation: ALL $PASS checks passed"
  exit 0
fi
echo "claim-token-isolation: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
