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
#     the dashboard token.
# Run: bash test/setup.test.sh   (bash 3.2 safe)
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/setup-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
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

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "setup: ALL $PASS checks passed"
  exit 0
fi
echo "setup: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
