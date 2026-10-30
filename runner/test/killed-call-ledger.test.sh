#!/usr/bin/env bash
# =====================================================================
# Killed / timed-out calls never read as FREE in the usage ledger.
# ---------------------------------------------------------------------
# Before: the .mjs helpers (decompose, spec-author, product-owner, tester,
# onboarding, merge resolver) booked a timeout as an all-"unknown" row with no
# estimate, which every spend summation reads as $0; the bash path booked only the
# cheapest-decile P10 whatever the call's run time; and estimate-usage refused the
# spec-author / onboard-review kinds the factory books. Proves, with a fake
# `claude` that sleeps past the timeout (no live model):
#   1. decompose.mjs + spec-author.mjs timeouts book estimated:true with a positive
#      estimated_cost_usd (the GAFFER_KILL_ESTIMATE_USD default floor, 0.05).
#   2. the REAL worker_deliver records the call's run time, and gaffer_usage_record
#      hands it to the ledger (--elapsed-ms) so a long killed call is booked from
#      the measured $/ms history, not the P10.
#   3. estimate-usage accepts spec-author, onboard-review and inherit.
# Run: bash test/killed-call-ledger.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/killed-ledger.XXXXXX")"; WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT

SLOW="$WORK/slow-claude"
printf '#!/bin/sh\nsleep 5\necho "{}"\n' > "$SLOW"; chmod +x "$SLOW"
# The last ledger row's field (empty when absent).
last_field() { node -e '
  const fs = require("fs"); const rows = fs.readFileSync(process.argv[1], "utf8").trim().split("\n");
  const r = JSON.parse(rows[rows.length - 1]); const v = r[process.argv[2]];
  process.stdout.write(v === undefined ? "" : String(v));' "$1" "$2" 2>/dev/null; }

echo "== 1: .mjs helper timeouts book a labelled estimate, never \$0 =="
for helper in decompose spec-author; do
  D="$WORK/$helper"; mkdir -p "$D"
  env -u GAFFER_KILL_ESTIMATE_USD -u GAFFER_USAGE_LEDGER GAFFER_DATA="$D" CLAUDE_BIN="$SLOW" \
    node "$RUNNER_DIR/bin/$helper.mjs" --brief x --timeout-ms 1000 >/dev/null 2>&1 </dev/null
  L="$D/usage-ledger.jsonl"
  [ "$(last_field "$L" kind)" = "$helper" ] && [ "$(last_field "$L" measured)" = "false" ] \
    && [ "$(last_field "$L" estimated)" = "true" ] && [ "$(last_field "$L" estimated_cost_usd)" = "0.05" ] \
    && ok "$helper timeout → estimated:true, estimated_cost_usd 0.05 (kind $helper)" \
    || fail "$helper timeout row wrong: $(tail -1 "$L" 2>/dev/null)"
done

echo "== 2: the bash path hands the call's run time to the ledger =="
export GAFFER_DATA="$WORK/bash/.gaffer"; mkdir -p "$GAFFER_DATA"
export GAFFER_LOG="$WORK/factory.log"
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
L="$GAFFER_DATA/usage-ledger.jsonl"
# History: 5 measured deliveries at $0.10 per 60 s; a call killed after N s should
# be booked at the median rate, clamped to the P90 cost ($0.46).
for k in 1 2 3 4 5; do
  printf '{"kind":"delivery","measured":true,"total_cost_usd":%s,"duration_ms":%s}\n' \
    "$(awk -v k="$k" 'BEGIN{print 0.1*k}')" "$((60000 * k))" >> "$L"
done
SLEEPY="$WORK/sleepy-claude"
printf '#!/bin/sh\nsleep 2\nexit 1\n' > "$SLEEPY"; chmod +x "$SLEEPY"
CWD="$WORK/cwd"; mkdir -p "$CWD"; MCP="$WORK/mcp.json"; printf '{"mcpServers":{}}' > "$MCP"
WORKER_CALL_ENV=( GAFFER_KILL_TEST=1 )
CLAUDE_BIN="$SLEEPY" worker_deliver "$CWD" "p" "" "$MCP" "$WORK/out.json" "" >/dev/null 2>&1; rc=$?
[ "${WORKER_LAST_ELAPSED_MS:-0}" -ge 1000 ] 2>/dev/null \
  && ok "worker_deliver records the run time (WORKER_LAST_ELAPSED_MS=$WORKER_LAST_ELAPSED_MS)" \
  || fail "worker_deliver did not record the run time (got '${WORKER_LAST_ELAPSED_MS:-}')"
gaffer_usage_record delivery 9 "$rc" "$WORK/out.json" >/dev/null 2>&1
[ "$(last_field "$L" estimate_basis)" = "history-rate" ] && [ "$(last_field "$L" estimated)" = "true" ] \
  && ok "the killed delivery is booked from the measured \$/ms history (basis history-rate)" \
  || fail "killed delivery row wrong: $(tail -1 "$L")"
[ -z "${WORKER_LAST_ELAPSED_MS:-}" ] && ok "gaffer_usage_record consumes the run time (no reuse by a later record)" \
  || fail "WORKER_LAST_ELAPSED_MS left set ('$WORKER_LAST_ELAPSED_MS')"
gaffer_usage_record delivery 9 124 /dev/null 1800000 >/dev/null 2>&1
[ "$(last_field "$L" estimated_cost_usd)" = "0.46" ] \
  && ok "a call killed at the 30-min wall clock books the P90 cap (\$0.46), not the P10 (\$0.14)" \
  || fail "30-min kill booked $(last_field "$L" estimated_cost_usd)"

echo "== 3: estimate-usage accepts every booked kind =="
for k in spec-author onboard-review inherit; do
  out="$(GAFFER_DATA="$WORK/empty" node "$RUNNER_DIR/bin/estimate-usage.mjs" --kind "$k" 2>&1)"
  case "$out" in *"unknown kind"*) fail "estimate-usage rejects '$k'" ;; *) ok "estimate-usage accepts '$k'" ;; esac
done

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
