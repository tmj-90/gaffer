#!/usr/bin/env bash
# =====================================================================
# Worker Abstraction Seam — Phase 1 routing assertion (Spec 3).
# ---------------------------------------------------------------------
# Proves that EVERY headless claude invocation now flows through the ONE worker
# seam, and that no open-coded invocation remains outside it:
#   • bash: the only `"$CLAUDE_BIN" -p` lives in lib/worker.sh (worker_deliver), and so
#           does the only command-worker spawn (GAFFER_WORKER_PROVIDER=command);
#           tick.sh routes all four agent turns through worker_deliver and has
#           zero open-coded launches. factory.config.sh sources the seam.
#   • mjs:  decompose.mjs + product-owner-run.mjs no longer open-code spawnSync;
#           they import the seam and call Worker.deliver. merge-ticket.mjs,
#           tester-run.mjs and lib/onboard-analyze.mjs (which legitimately spawn
#           git / the memory CLI) route their AGENT spawn through Worker.deliver and
#           never spawnSync the claude binary directly — the merge-conflict resolver
#           used to, outside the containment seam.
# Structural (grep) proof — matches the task's "grep-assert that no open-coded
# claude -p remains outside the worker module". Zero deps.
# Run: bash test/worker-seam-routing.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

TICK="$RUNNER_DIR/tick.sh"
WORKER_SH="$RUNNER_DIR/lib/worker.sh"
WORKER_MJS="$RUNNER_DIR/lib/worker.mjs"
CONFIG="$RUNNER_DIR/factory.config.sh"
DECOMPOSE="$RUNNER_DIR/bin/decompose.mjs"
PO="$RUNNER_DIR/bin/product-owner-run.mjs"

echo "== bash: the invocation lives ONLY in the worker seam =="
[ -f "$WORKER_SH" ] && ok "lib/worker.sh exists" || fail "lib/worker.sh is missing"
grep -qE '^worker_deliver\(\)' "$WORKER_SH" \
  && ok "lib/worker.sh defines worker_deliver()" || fail "worker_deliver() not defined in lib/worker.sh"

WORKER_INVOKES="$(grep -cE '"\$CLAUDE_BIN" -p' "$WORKER_SH" || true)"
[ "$WORKER_INVOKES" = "1" ] && ok "exactly 1 claude -p invocation in lib/worker.sh" \
  || fail "expected exactly 1 claude -p in lib/worker.sh (got $WORKER_INVOKES)"

# The command provider's spawn is the seam's second (and only other) invocation.
CMD_INVOKES="$(grep -cE '"\$_cmd_run" </dev/null' "$WORKER_SH" || true)"
[ "$CMD_INVOKES" = "1" ] && ok "exactly 1 command-worker invocation in lib/worker.sh" \
  || fail "expected exactly 1 command-worker invocation in lib/worker.sh (got $CMD_INVOKES)"
for _f in "$TICK" "$RUNNER_DIR/lib/review.sh" "$RUNNER_DIR/lib/clarify.sh" "$RUNNER_DIR/lib/eval-judge.sh"; do
  grep -qE 'GAFFER_WORKER_COMMAND"? ' "$_f" \
    && fail "$(basename "$_f") open-codes a command-worker spawn outside the seam" \
    || ok "$(basename "$_f") never spawns GAFFER_WORKER_COMMAND itself"
done

TICK_INLINE="$(grep -cE '"\$CLAUDE_BIN" -p' "$TICK" || true)"
[ "$TICK_INLINE" = "0" ] && ok "tick.sh open-codes NO claude -p invocation" \
  || fail "tick.sh still open-codes $TICK_INLINE claude -p invocation(s)"

# B-H3 (monolith paydown): the review + clarify agent turns were extracted into
# lib/review.sh + lib/clarify.sh (sourced by tick.sh). Count the routes across
# tick.sh AND the two extracted passes — the four agent turns are unchanged.
TICK_ROUTES=0
for _rf in "$TICK" "$RUNNER_DIR/lib/review.sh" "$RUNNER_DIR/lib/clarify.sh"; do
  TICK_ROUTES=$(( TICK_ROUTES + $(grep -cE '^[[:space:]]*(GAFFER_LAUNCH_KIND=[a-z-]+ )?worker_deliver ' "$_rf" 2>/dev/null || true) ))
done
[ "$TICK_ROUTES" = "5" ] && ok "tick.sh + review/clarify libs route all 5 agent turns through worker_deliver" \
  || fail "expected 5 worker_deliver routes across tick.sh + review/clarify libs (delivery, bootstrap, reviewer, SECURITY reviewer, clarify) (got $TICK_ROUTES)"

grep -qE 'source "\$RUNNER_DIR/lib/worker.sh"' "$CONFIG" \
  && ok "factory.config.sh sources the worker seam" || fail "factory.config.sh does not source lib/worker.sh"

echo "== mjs: both runners route through Worker.deliver, none open-code the spawn =="
[ -f "$WORKER_MJS" ] && ok "lib/worker.mjs exists" || fail "lib/worker.mjs is missing"
grep -qE 'export function deliver' "$WORKER_MJS" \
  && ok "lib/worker.mjs exports deliver()" || fail "lib/worker.mjs does not export deliver()"

for f in "$DECOMPOSE" "$PO"; do
  name="$(basename "$f")"
  # No open-coded spawn: a bare `spawnSync(` call must not remain (a comment may mention it).
  CALLS="$(grep -cE '[^.a-zA-Z_]spawnSync\(' "$f" || true)"
  [ "$CALLS" = "0" ] && ok "$name has no open-coded spawnSync( call" \
    || fail "$name still open-codes $CALLS spawnSync( call(s)"
  grep -qE 'from "\.\./lib/worker\.mjs"' "$f" \
    && ok "$name imports the worker seam" || fail "$name does not import lib/worker.mjs"
  grep -qE 'Worker\.deliver\(' "$f" \
    && ok "$name calls Worker.deliver()" || fail "$name does not call Worker.deliver()"
done

echo "== mjs: the autonomy-time agent spawns (resolver / tester / onboarding analysis) use the seam =="
for f in "$RUNNER_DIR/bin/merge-ticket.mjs" "$RUNNER_DIR/bin/tester-run.mjs" "$RUNNER_DIR/lib/onboard-analyze.mjs"; do
  name="$(basename "$f")"
  # These runners spawn git / the memory CLI legitimately, so the pin is narrower: the
  # CLAUDE binary is never handed to spawnSync directly.
  BARE="$(grep -cE 'spawnSync\((CONFIG\.)?claudeBin' "$f" || true)"
  [ "$BARE" = "0" ] && ok "$name never spawnSync()s the claude binary directly" \
    || fail "$name open-codes $BARE bare claude spawn(s) outside the seam"
  grep -qE 'from "\.\./lib/worker\.mjs"|from "\./worker\.mjs"' "$f" \
    && ok "$name imports the worker seam" || fail "$name does not import lib/worker.mjs"
  grep -qE 'Worker\.deliver\(' "$f" \
    && ok "$name calls Worker.deliver()" || fail "$name does not call Worker.deliver()"
done
# spec-author.mjs keeps its direct claude-code spawn, but every OTHER provider goes
# through Worker.deliver (command → the contract + containment rule; unknown → refused),
# so GAFFER_WORKER_PROVIDER means the same thing at every launcher.
SA="$RUNNER_DIR/bin/spec-author.mjs"
grep -qE 'workerProvider\(\) === DEFAULT_WORKER_PROVIDER' "$SA" && grep -qE 'Worker\.deliver\(' "$SA" \
  && ok "spec-author.mjs routes a non-default provider through Worker.deliver" \
  || fail "spec-author.mjs does not route GAFFER_WORKER_PROVIDER through the seam"
grep -qE 'provider === COMMAND_WORKER_PROVIDER' "$WORKER_MJS" \
  && ok "lib/worker.mjs deliver() dispatches the command provider" || fail "lib/worker.mjs has no command provider dispatch"

grep -qE 'agentChildEnv\(baseEnv\)' "$RUNNER_DIR/bin/merge-ticket.mjs" \
  && ok "merge-ticket.mjs builds the resolver env from the shared agentChildEnv scrub" \
  || fail "merge-ticket.mjs does not start the resolver env from agentChildEnv"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
