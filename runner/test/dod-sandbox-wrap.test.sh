#!/usr/bin/env bash
# =====================================================================
# VALIDATION ISOLATION — the DoD gates run under the agent's OS sandbox.
# ---------------------------------------------------------------------
# The gate commands (tests / typecheck / lint, and AC check commands via the same
# runner) execute code the agent has just modified, with the runner's privileges.
# Sandboxing only `claude -p` left that step bare. tick.sh now exports the SAME wrap
# prefix it gave the agent as GAFFER_DOD_WRAP, and gaffer_dod_run_one runs every gate
# through it. Proven with a recording wrap stub (no real sandbox needed) + source pins.
# Run: bash test/dod-sandbox-wrap.test.sh   (bash 3.2 safe)
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/dod-wrap.XXXXXX")"; WORK="$(cd "$WORK" && pwd -P)"; trap 'rm -rf "$WORK"' EXIT   # canonical: macOS TMPDIR ends in "/" and /var → /private/var

gaffer_timeout() { shift; "$@"; }   # the gate runner's timeout seam — inert here
export GAFFER_DOD_TIMEOUT=30
# shellcheck source=../lib/dod.sh
source "$RUNNER_DIR/lib/dod.sh"

WT="$WORK/wt"; mkdir -p "$WT"
# A wrap stub: records that it ran + its cwd, then executes the wrapped command.
cat > "$WORK/wrap.sh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "wrapped cwd=$(pwd -P) argv=$*" >> "${WRAP_LOG:?}"
exec "$@"
STUB
chmod +x "$WORK/wrap.sh"
export WRAP_LOG="$WORK/wrap.log"

echo "== 1: no wrap ⇒ the bare invocation (unchanged) =="
: > "$WRAP_LOG"; unset GAFFER_DOD_WRAP
gaffer_dod_run_one "$WT" "$WORK/out" 'echo bare-ok; exit 0'; rc=$?
[ "$rc" -eq 0 ] && grep -q bare-ok "$WORK/out" && ok "gate ran and passed without a wrap" || fail "bare gate should pass (rc=$rc)"
[ ! -s "$WRAP_LOG" ] && ok "wrap stub never invoked when GAFFER_DOD_WRAP is empty" || fail "wrap ran with no GAFFER_DOD_WRAP"

echo "== 2: GAFFER_DOD_WRAP set ⇒ every gate runs THROUGH the wrap, in the worktree =="
: > "$WRAP_LOG"; export GAFFER_DOD_WRAP="$WORK/wrap.sh"
gaffer_dod_run_one "$WT" "$WORK/out" 'echo wrapped-ok; exit 0'; rc=$?
[ "$rc" -eq 0 ] && grep -q wrapped-ok "$WORK/out" && ok "gate output + rc pass through the wrap" || fail "wrapped gate should pass (rc=$rc)"
grep -qF "wrapped cwd=$(cd "$WT" && pwd -P) " "$WRAP_LOG" \
  && ok "the wrap ran with the delivery worktree as cwd" || fail "wrap cwd was not the worktree: $(cat "$WRAP_LOG")"
grep -q 'argv=bash -c echo wrapped-ok; exit 0' "$WRAP_LOG" && ok "the wrap received bash -c plus the gate command" || fail "wrap argv unexpected: $(cat "$WRAP_LOG")"
gaffer_dod_run_one "$WT" "$WORK/out" 'echo boom >&2; exit 3'; rc=$?
[ "$rc" -eq 3 ] && grep -q boom "$WORK/out" && ok "a failing gate's rc + stderr still surface through the wrap" || fail "wrapped failing gate should return 3 (got $rc)"

echo "== 3: gaffer_run_dod_gates (the real driver) goes through the same runner =="
: > "$WRAP_LOG"; RES="$WORK/res"
printf 'repo\t%s\t1\t1\t1\ttrue\t-\ttrue\n' "$WT" | gaffer_run_dod_gates "$RES"; rc=$?
[ "$rc" -eq 0 ] && [ "$(grep -c '^wrapped' "$WRAP_LOG")" = "2" ] && ok "both configured gates (tests, lint) ran under the wrap" || fail "expected 2 wrapped gate runs (got $(grep -c '^wrapped' "$WRAP_LOG"), rc=$rc)"

echo "== 4: docker provider ⇒ the image's HOME/PATH are applied inside the wrap =="
: > "$WRAP_LOG"; SANDBOX_PROVIDER=docker GAFFER_SANDBOX_HOME=/root GAFFER_SANDBOX_PATH=/usr/bin:/bin \
  gaffer_dod_run_one "$WT" "$WORK/out" 'echo x'
grep -q 'argv=env HOME=/root PATH=/usr/bin:/bin bash -c echo x' "$WRAP_LOG" \
  && ok "docker wrap prepends the image env (host PATH/HOME do not exist inside)" || fail "docker env substitution missing: $(cat "$WRAP_LOG")"
unset SANDBOX_PROVIDER

echo "== 5: source pins — tick.sh hands the agent's wrap to the gates =="
grep -q 'export GAFFER_DOD_WRAP="$WRAP"' "$RUNNER_DIR/tick.sh" && ok "tick.sh exports GAFFER_DOD_WRAP=\$WRAP under an active provider" || fail "tick.sh should export GAFFER_DOD_WRAP from the agent's WRAP"
grep -q 'export GAFFER_DOD_WRAP=""' "$RUNNER_DIR/tick.sh" && ok "tick.sh resets GAFFER_DOD_WRAP per tick (no stale wrap leaks across ticks)" || fail "tick.sh should reset GAFFER_DOD_WRAP"
grep -q 'GAFFER_DOD_SANDBOX' "$RUNNER_DIR/tick.sh" && ok "GAFFER_DOD_SANDBOX=0 is the documented opt-out" || fail "opt-out knob missing"
grep -q 'gaffer_dod_run_one "$wt" "$tmpout" "$cmd"' "$RUNNER_DIR/lib/ac-checks.sh" && ok "AC check commands use the same (wrapped) runner" || fail "ac-checks.sh no longer routes through gaffer_dod_run_one"
grep -q 'strict-profile.\$\$.XXXXXX' "$RUNNER_DIR/lib/sandbox.sh" && ok "sandbox-exec profile is a per-call mktemp file (no shared-filename race)" || fail "sandbox-exec still writes a fixed strict-profile.sb"
grep -q 'strict-profile.\$\$.\*' "$RUNNER_DIR/tick.sh" && ok "tick.sh sweeps its own per-call profile on exit" || fail "tick.sh cleanup does not sweep strict-profile.\$\$.*"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "dod-sandbox-wrap: ALL $PASS checks passed"; exit 0
else echo "dod-sandbox-wrap: ${#FAILURES[@]} FAILED (of $((PASS + ${#FAILURES[@]})))"; exit 1; fi
