#!/usr/bin/env bash
# =====================================================================
# `gaffer demo` writes nothing inside the checkout and owns its own temp dir.
# ---------------------------------------------------------------------
# demo.sh wrote its MCP ping script into packages/memory (inside the checkout) and,
# without DEMO_DIR, `rm -rf`d a fixed shared /tmp/gaffer-showcase. Proves:
#   1  without DEMO_DIR: exit 0, a FRESH mktemp dir under TMPDIR (marked .gaffer-demo,
#      named in the output) holds the showcase factory; both MCP servers answered;
#   2  nothing in packages/ or runner/ of the checkout changed, ignored files included;
#   3  a DEMO_DIR that is not empty and not a previous demo is refused (exit 2) and
#      left as it was; a previous demo's dir is reused (exit 0);
#   4  no fixed /tmp/gaffer-showcase path remains in demo.sh.
# Run: bash runner/test/demo-isolation.test.sh   (bash 3.2 safe)
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
[ -f "$ROOT/packages/dispatch/dist/cli/index.js" ] || { echo "SKIP: dispatch CLI not built"; exit 0; }
[ -f "$ROOT/packages/memory/dist/bin/memory.js" ] || { echo "SKIP: memory not built"; exit 0; }
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
has()  { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/demo-isolation.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
trap 'gaffer_test_rm_work "$WORK"' EXIT
mkdir -p "$WORK/tmp"
unset DEMO_DIR
snap() { git -C "$ROOT" status --porcelain --ignored --untracked-files=all -- packages runner 2>/dev/null | grep -v '/node_modules/' | grep -v '/dist/' | sort; }
BEFORE="$(snap)"

echo "== 1: no DEMO_DIR → a fresh temp dir =="
RC=0; OUT="$(cd "$WORK" && TMPDIR="$WORK/tmp" bash "$RUNNER_DIR/gaffer" demo 2>&1)" || RC=$?
[ "$RC" -eq 0 ] && ok "demo exits 0" || fail "demo rc=$RC: $(printf '%s' "$OUT" | tail -5)"
D="$(ls -d "$WORK/tmp"/gaffer-demo.* 2>/dev/null | head -1)"
[ -n "$D" ] && [ -f "$D/.gaffer-demo" ] && [ -f "$D/dispatch.sqlite" ] && ok "the showcase factory is in a fresh mktemp dir ($(basename "$D"))" || fail "no fresh demo dir under TMPDIR: $(ls -A "$WORK/tmp")"
has "$OUT" "Showcase factory: $D" && ok "the output names it" || fail "output does not name the demo dir"
has "$OUT" "dispatch-mcp: " && has "$OUT" "memory-mcp: " && has "$OUT" " tools — " && ok "both MCP servers answered the live handshake" || fail "handshake lines missing: $(printf '%s' "$OUT" | grep -i mcp)"

echo "== 2: nothing written inside the checkout =="
AFTER="$(snap)"
[ "$BEFORE" = "$AFTER" ] && ok "packages/ and runner/ unchanged (ignored files included)" || fail "checkout changed: $(diff <(printf '%s\n' "$BEFORE") <(printf '%s\n' "$AFTER") | head -5)"
[ ! -e "$ROOT/packages/memory/.demo-ping.mjs" ] && ok "no ping script in packages/memory" || fail "packages/memory/.demo-ping.mjs exists"

echo "== 3: DEMO_DIR safety =="
mkdir -p "$WORK/mine"; echo "precious" > "$WORK/mine/notes.txt"
RC=0; OUT="$(DEMO_DIR="$WORK/mine" bash "$RUNNER_DIR/gaffer" demo 2>&1)" || RC=$?
[ "$RC" -eq 2 ] && has "$OUT" "not a previous demo" && ok "a non-empty, non-demo DEMO_DIR is refused (exit 2)" || fail "rc=$RC: $(printf '%s' "$OUT" | tail -3)"
[ "$(cat "$WORK/mine/notes.txt" 2>/dev/null)" = precious ] && [ "$(ls -A "$WORK/mine")" = notes.txt ] && ok "…and left exactly as it was" || fail "DEMO_DIR contents changed: $(ls -A "$WORK/mine")"
RC=0; OUT="$(DEMO_DIR="$D" bash "$RUNNER_DIR/gaffer" demo 2>&1)" || RC=$?
[ "$RC" -eq 0 ] && [ -f "$D/.gaffer-demo" ] && ok "a previous demo's dir is reused" || fail "reuse rc=$RC: $(printf '%s' "$OUT" | tail -3)"

echo "== 4: no fixed shared path =="
grep -q 'gaffer-showcase' "$RUNNER_DIR/demo.sh" && fail "demo.sh still names /tmp/gaffer-showcase" || ok "no fixed /tmp/gaffer-showcase in demo.sh"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "demo-isolation: ALL $PASS checks passed"; exit 0; fi
echo "demo-isolation: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
