#!/usr/bin/env bash
# =====================================================================
# Per-call resource caps (P1 denial-of-wallet / token runaway).
# ---------------------------------------------------------------------
# Proves the wall-clock + turn caps that bound every headless `claude -p`:
#   1. The knobs (GAFFER_TICK_TIMEOUT / GAFFER_MAX_TURNS) have sane defaults
#      and GAFFER_MAX_TURNS_FLAG is derived from them.
#   2. gaffer_timeout is a portable timeout that actually kills a runaway
#      (exit 124), passes through a fast command's exit status, and is a
#      no-op when the cap is 0/empty.
#   3. Every `claude -p` call site in tick.sh runs under gaffer_timeout and
#      carries --max-turns ($GAFFER_MAX_TURNS_FLAG) — asserted by grep so a
#      future edit that drops the wrap is caught.
#   4. loop.sh wraps the whole tick in gaffer_timeout too.
#   5. decompose.mjs passes --max-turns to the spawned claude.
# Zero deps. Run: bash test/resource-caps.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

# Source the config in a controlled GAFFER_DATA so we don't touch real state.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/rescaps-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
export GAFFER_DATA="$WORK/.gaffer"
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh"

echo "== knob defaults =="
[ -n "${GAFFER_TICK_TIMEOUT:-}" ] && [ "$GAFFER_TICK_TIMEOUT" -gt 0 ] \
  && ok "GAFFER_TICK_TIMEOUT default present (${GAFFER_TICK_TIMEOUT}s)" \
  || fail "GAFFER_TICK_TIMEOUT should default to a positive value"
[ -n "${GAFFER_MAX_TURNS:-}" ] && [ "$GAFFER_MAX_TURNS" -gt 0 ] \
  && ok "GAFFER_MAX_TURNS default present (${GAFFER_MAX_TURNS})" \
  || fail "GAFFER_MAX_TURNS should default to a positive value"
[ "$GAFFER_MAX_TURNS_FLAG" = "--max-turns $GAFFER_MAX_TURNS" ] \
  && ok "GAFFER_MAX_TURNS_FLAG derived from the knob" \
  || fail "GAFFER_MAX_TURNS_FLAG should be '--max-turns \$GAFFER_MAX_TURNS' (got '$GAFFER_MAX_TURNS_FLAG')"

echo "== gaffer_timeout behaviour =="
gaffer_timeout 5 true && ok "fast command passes through (exit 0)" || fail "fast command should exit 0"
gaffer_timeout 5 bash -c 'exit 7'; [ "$?" = "7" ] && ok "relays the command's exit status" || fail "should relay exit status 7"
gaffer_timeout 1 sleep 5; rc=$?
[ "$rc" = "124" ] && ok "kills a runaway and exits 124" || fail "timeout should exit 124 (got $rc)"
out="$(gaffer_timeout 0 echo hi)"; [ "$out" = "hi" ] && ok "cap of 0 disables the timeout (no-op)" || fail "cap 0 should run unbounded"

echo "== tick.sh call sites wrapped =="
# Every headless `claude -p` launch must run under gaffer_timeout AND (C1/M2) under
# an `env -i "${GAFFER_AGENT_ENV[@]}"` allowlist scrub. Since the scrub makes each
# launch a MULTI-LINE subshell (gaffer_timeout … \ env -i … \ "$CLAUDE_BIN" -p …),
# we assert by structural COUNTS rather than a single-line regex: one
# gaffer_timeout-with-tick-cap and one env -i scrub per claude -p site.
TOTAL="$(grep -cE '"\$CLAUDE_BIN" -p' "$RUNNER_DIR/tick.sh" || true)"
WRAPPED="$(grep -cE 'gaffer_timeout "\$GAFFER_TICK_TIMEOUT"' "$RUNNER_DIR/tick.sh" || true)"
SCRUBBED="$(grep -cE 'env -i "\$\{GAFFER_AGENT_ENV\[@\]\}"' "$RUNNER_DIR/tick.sh" || true)"
[ "$TOTAL" -ge 4 ] && ok "found $TOTAL claude -p call sites in tick.sh (>=4)" || fail "expected >=4 claude -p call sites (got $TOTAL)"
[ "$WRAPPED" -ge "$TOTAL" ] && ok "all $TOTAL claude -p sites wrapped in gaffer_timeout ($WRAPPED tick-cap wrappers)" \
  || fail "only $WRAPPED gaffer_timeout tick-cap wrappers for $TOTAL claude -p sites"
[ "$SCRUBBED" = "$TOTAL" ] && ok "all $TOTAL claude -p sites launch via env -i agent-env allowlist (C1/M2)" \
  || fail "only $SCRUBBED of $TOTAL claude -p sites use the env -i allowlist scrub"
# --max-turns stays on the same line as the claude invocation, so the line-bound
# check still holds.
TURNS="$(grep -cE '"\$CLAUDE_BIN" -p.*\$GAFFER_MAX_TURNS_FLAG' "$RUNNER_DIR/tick.sh" || true)"
[ "$TURNS" = "$TOTAL" ] && ok "all $TOTAL claude -p sites carry \$GAFFER_MAX_TURNS_FLAG" \
  || fail "only $TURNS of $TOTAL claude -p sites carry --max-turns"

echo "== bootstrap install can't run lifecycle scripts =="
grep -q 'npm_config_ignore_scripts=true' "$RUNNER_DIR/tick.sh" \
  && ok "tick.sh exports npm_config_ignore_scripts=true for the bootstrap install" \
  || fail "tick.sh should export npm_config_ignore_scripts=true in the bootstrap env"

echo "== loop.sh wraps the whole tick =="
# FINDING-6: the outer bound is GAFFER_TICK_OUTER_TIMEOUT (attempts × timeout +
# margin), not the old single-call cap + slack — see tick-outer-timeout.test.sh.
grep -qE 'gaffer_timeout "\$GAFFER_TICK_OUTER_TIMEOUT" bash "\$HERE/tick.sh"' "$RUNNER_DIR/loop.sh" \
  && ok "loop.sh runs tick.sh under gaffer_timeout" \
  || fail "loop.sh should wrap tick.sh in gaffer_timeout"

echo "== decompose.mjs passes --max-turns =="
grep -q 'args.push("--max-turns"' "$RUNNER_DIR/bin/decompose.mjs" \
  && ok "decompose.mjs passes --max-turns to claude" \
  || fail "decompose.mjs should pass --max-turns to the spawned claude"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
