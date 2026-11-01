#!/usr/bin/env bash
# =====================================================================
# runner/setup.sh — a failed first step must say why.
# ---------------------------------------------------------------------
# setup.sh ran `pnpm install --silent && pnpm -r build >/dev/null`, so on a Node
# below a dependency's engines floor (engine-strict) it exited 1 with no message.
# Proves, with a STUB pnpm on PATH and a scratch GAFFER_HOME (no real install):
#   • a failing install exits non-zero AND prints pnpm's own error line plus a
#     remedy, and keeps the full output in $GAFFER_DATA/setup.log;
#   • a Node below the root engines.node floor is refused BEFORE pnpm runs, with
#     the running version, the floor and the fix named;
#   • the factory state dir is created (or tightened to) owner-only 0700 — it holds
#     the dashboard token;
#   • `gaffer setup` refused before the data dir exists cites no setup.log that was
#     never written;
#   • a successful setup's footer names the REAL dashboard port (DISPATCH_API_PORT),
#     not a hardcoded :8787;
#   • preflight.sh holds Node to the same engines.node floor setup.sh enforces.
# Run: bash test/setup.test.sh   (bash 3.2 safe)
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/setup-test.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT
BIN="$WORK/bin"; mkdir -p "$BIN"
CALLS="$WORK/pnpm-calls"
# Stub pnpm: records each call, then fails the way pnpm does under engine-strict —
# printing nothing under --silent, exactly like the real one.
cat > "$BIN/pnpm" <<STUB
#!/usr/bin/env bash
echo "\$*" >> "$CALLS"
case " \$* " in *" --silent "*) exit 1 ;; esac
echo " ERR_PNPM_UNSUPPORTED_ENGINE  Unsupported environment (bad pnpm and/or Node.js version)"
echo "Your Node version is incompatible with \"lint-staged@17.3.0\"."
echo "Expected version: >=22.22.1"
exit 1
STUB
chmod +x "$BIN/pnpm"
HOME_OK="$WORK/home-ok"; mkdir -p "$HOME_OK"
printf '{"name":"g","engines":{"node":">=18"}}\n' > "$HOME_OK/package.json"
HOME_HIGH="$WORK/home-high"; mkdir -p "$HOME_HIGH"
printf '{"name":"g","engines":{"node":">=99.0.0"}}\n' > "$HOME_HIGH/package.json"

run_setup() {  # $1 = GAFFER_HOME, $2 = GAFFER_DATA
  : > "$CALLS"
  OUT="$(env PATH="$BIN:$PATH" GAFFER_HOME="$1" GAFFER_DATA="$2" bash "$RUNNER_DIR/setup.sh" 2>&1)"; RC=$?
}

echo "== a failing install says why =="
run_setup "$HOME_OK" "$WORK/data"
[ "$RC" -ne 0 ] && ok "setup exits non-zero (rc=$RC)" || fail "setup exited 0 on a failed install"
[[ "$OUT" == *"ERR_PNPM_UNSUPPORTED_ENGINE"* ]] && ok "pnpm's own error line is shown" || fail "pnpm error hidden: $OUT"
[[ "$OUT" == *"Expected version: >=22.22.1"* ]] && ok "the dependency's floor is shown" || fail "floor line hidden"
[[ "$OUT" == *"install a newer Node"* ]] && ok "a remedy is printed" || fail "no remedy: $OUT"
grep -q ERR_PNPM_UNSUPPORTED_ENGINE "$WORK/data/setup.log" 2>/dev/null \
  && ok "the full output is kept in \$GAFFER_DATA/setup.log" || fail "setup.log missing the install output"
grep -q '^install' "$CALLS" && ! grep -q -- '--silent' "$CALLS" \
  && ok "pnpm install ran without --silent" || fail "pnpm calls: $(cat "$CALLS")"
[ "$(stat -c %a "$WORK/data" 2>/dev/null || stat -f %Lp "$WORK/data")" = "700" ] \
  && ok "the factory state dir is created 0700" || fail "state dir mode $(stat -c %a "$WORK/data" 2>/dev/null)"
mkdir -p "$WORK/data-old"; chmod 755 "$WORK/data-old"
run_setup "$HOME_OK" "$WORK/data-old"
[ "$(stat -c %a "$WORK/data-old" 2>/dev/null || stat -f %Lp "$WORK/data-old")" = "700" ] \
  && ok "an existing 0755 state dir is tightened to 0700" || fail "old state dir mode $(stat -c %a "$WORK/data-old" 2>/dev/null)"

echo "== a Node below the root floor is refused before pnpm runs =="
run_setup "$HOME_HIGH" "$WORK/data-high"
[ "$RC" -ne 0 ] && ok "setup exits non-zero" || fail "setup accepted a Node below the floor"
[[ "$OUT" == *"$(node -v) is below Gaffer's floor"* ]] && [[ "$OUT" == *">=99.0.0"* ]] \
  && ok "names the running Node and the declared floor" || fail "precheck message: $OUT"
[ ! -s "$CALLS" ] && ok "pnpm was never invoked" || fail "pnpm ran despite the precheck: $(cat "$CALLS")"

echo "== gaffer setup refused early: no setup.log is cited =="
RC=0; OUT="$(env PATH="$BIN:$PATH" GAFFER_HOME="$HOME_HIGH" GAFFER_DATA="$WORK/never" bash "$RUNNER_DIR/gaffer" setup 2>&1)" || RC=$?
[ "$RC" -ne 0 ] && [[ "$OUT" == *"setup failed — see the reason above"* ]] && ok "gaffer setup exits non-zero pointing at the reason" || fail "gaffer setup rc=$RC: $OUT"
[[ "$OUT" == *"setup.log"* ]] && [ ! -e "$WORK/never/setup.log" ] && fail "cites a setup.log that does not exist: $OUT" || ok "no setup.log cited that was never written"

echo "== a successful setup's footer names the real port =="
DIST="$RUNNER_DIR/../packages/dispatch/dist/cli/index.js"
if [ -f "$DIST" ] && [ -f "$RUNNER_DIR/../packages/crew/dist/cli/index.js" ] && [ -f "$RUNNER_DIR/../packages/memory/dist/bin/memory.js" ]; then
  # A GAFFER_HOME whose floor this Node meets, with the REAL built packages, and a pnpm
  # that "installs" by doing nothing.
  HOME_REAL="$WORK/home-real"; mkdir -p "$HOME_REAL" "$WORK/okbin"
  printf '{"name":"g","engines":{"node":">=18"}}\n' > "$HOME_REAL/package.json"
  ln -s "$(cd "$RUNNER_DIR/../packages" && pwd)" "$HOME_REAL/packages"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/okbin/pnpm"; chmod +x "$WORK/okbin/pnpm"
  RC=0; OUT="$(env PATH="$WORK/okbin:$PATH" GAFFER_HOME="$HOME_REAL" GAFFER_DATA="$WORK/data-ok" DISPATCH_API_PORT=9471 bash "$RUNNER_DIR/setup.sh" 2>&1)" || RC=$?
  [ "$RC" -eq 0 ] && ok "setup completes against the stub install" || fail "setup rc=$RC: $(printf '%s' "$OUT" | tail -5)"
  [[ "$OUT" == *"http://127.0.0.1:9471"* ]] && [[ "$OUT" != *":8787"* ]] && ok "the footer prints the configured port, not :8787" || fail "footer port: $(printf '%s' "$OUT" | grep -n 'dashboard')"
  [[ "$OUT" == *"one dry tick over a showcase repo"* ]] && ok "the footer describes demo as one dry tick" || fail "demo line: $(printf '%s' "$OUT" | grep demo)"
else
  echo "SKIP: dispatch/crew/memory not built (pnpm -r build)"
fi

echo "== preflight holds Node to the same floor =="
pf() { env GAFFER_HOME="$1" GAFFER_DATA="$WORK/pf-data" GAFFER_REGISTRY_PROBE=0 bash "$RUNNER_DIR/preflight.sh" 2>&1; }
OUT="$(pf "$HOME_HIGH")"
[[ "$OUT" == *"✗ node $(node -v) is below Gaffer's floor (>=99.0.0"* ]] && [[ "$OUT" == *"setup refuses it"* ]] \
  && ok "preflight fails a Node below engines.node, the way setup does" || fail "preflight node line: $(printf '%s' "$OUT" | grep -i 'node' | head -2)"
[[ "$OUT" == *"✓ node $(node -v)"* ]] && fail "preflight still ticks a Node setup refuses" || ok "no ✓ for a Node below the floor"
OUT="$(pf "$HOME_OK")"
[[ "$OUT" == *"✓ node $(node -v) (Gaffer needs >=18)"* ]] && ok "a Node that meets the floor is ✓ with the floor named" || fail "preflight ok line: $(printf '%s' "$OUT" | grep -i 'node' | head -2)"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "setup: ALL $PASS checks passed"
  exit 0
fi
echo "setup: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
