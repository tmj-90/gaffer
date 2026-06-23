#!/usr/bin/env bash
# =====================================================================
# STRICT-MODE provider-seam validation (best-effort OS-level containment).
# ---------------------------------------------------------------------
# Proves, with REAL temp dirs and a REAL generated sandbox-exec profile, that:
#   1. A write OUTSIDE the worktree is OS-BLOCKED under the profile.
#   2. A write INSIDE the worktree SUCCEEDS.
#   3. `python3 -m unittest` (a representative test runner) SUCCEEDS.
#   4. The provider seam dispatches correctly:
#        none      → empty prefix
#        docker    → empty prefix + a stderr fallback notice (non-fatal)
#        sandbox-exec → a `sandbox-exec -f <profile>` prefix
#
# This is the POINT of strict mode: prove the OS refuses the escape the
# in-process safety hook can't see. Zero deps; macOS-only (sandbox-exec).
# Run: bash test/strict-mode.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

if [ "$(uname -s)" != "Darwin" ] || ! command -v sandbox-exec >/dev/null 2>&1; then
  echo "SKIP: strict-mode test requires macOS sandbox-exec"
  exit 0
fi

# Isolated GAFFER_DATA so we never touch real factory state; the seam writes the
# generated profile here. Real temp worktree stands in for a delivery worktree.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/strict-test.XXXXXX")"
# Canonicalise: macOS aliases /tmp → /private/tmp; the kernel enforces canonical.
WORK="$(cd "$WORK" && pwd -P)"
export GAFFER_DATA="$WORK/gaffer-data"
WORKTREE="$WORK/worktree"
mkdir -p "$GAFFER_DATA" "$WORKTREE"

# The "escape" target must be a path the profile does NOT make writable. Temp
# dirs ARE intentionally writable (build/test tools need them), so a meaningful
# escape target lives OUTSIDE the worktree, GAFFER_DATA, temp, and (empty here)
# STRICT_ALLOW_HOME — we use a unique dir under $HOME. This mirrors the real
# threat: the agent writing into the human's home / another repo.
OUTSIDE="$HOME/.gaffer-strict-escape-test.$$"
mkdir -p "$OUTSIDE"

cleanup() { rm -rf "$WORK" "$OUTSIDE"; }
trap cleanup EXIT

# Minimal config the seam reads, then source ONLY the provider lib (no full
# factory.config.sh side effects). STRICT_ALLOW_HOME empty to keep the profile tight.
: "${STRICT_ALLOW_NETWORK:=1}"
export STRICT_ALLOW_NETWORK
export STRICT_ALLOW_HOME=""
# shellcheck source=../lib/sandbox.sh
source "$RUNNER_DIR/lib/sandbox.sh"

echo "== provider seam dispatch =="

SANDBOX_PROVIDER=none WRAP="$(sandbox_wrap_cmd "$WORKTREE" "")"
[ -z "$WRAP" ] && ok "provider 'none' echoes empty prefix" || fail "provider 'none' should echo nothing (got: $WRAP)"

DOCKER_ERR="$(SANDBOX_PROVIDER=docker sandbox_wrap_cmd "$WORKTREE" "" 2>&1 >/dev/null)"
DOCKER_OUT="$(SANDBOX_PROVIDER=docker sandbox_wrap_cmd "$WORKTREE" "" 2>/dev/null)"
[ -z "$DOCKER_OUT" ] && ok "provider 'docker' echoes empty prefix (no containment)" || fail "provider 'docker' should echo nothing (got: $DOCKER_OUT)"
echo "$DOCKER_ERR" | grep -q "not yet supported" && ok "provider 'docker' warns non-fatally on stderr" || fail "provider 'docker' should warn on stderr"

WRAP="$(SANDBOX_PROVIDER=sandbox-exec sandbox_wrap_cmd "$WORKTREE" "")"
case "$WRAP" in
  "sandbox-exec -f "*) ok "provider 'sandbox-exec' echoes a 'sandbox-exec -f <profile>' prefix" ;;
  *) fail "provider 'sandbox-exec' bad prefix: $WRAP" ;;
esac
PROFILE="${WRAP#sandbox-exec -f }"
[ -f "$PROFILE" ] && ok "profile file was generated at $PROFILE" || fail "profile file missing"

echo "== generated profile contents =="
grep -q '(allow default)' "$PROFILE" && ok "profile: (allow default) present (reads broad)" || fail "profile missing (allow default)"
grep -q '(deny file-write\*)' "$PROFILE" && ok "profile: (deny file-write*) present" || fail "profile missing deny file-write*"
grep -q "(subpath \"$WORKTREE\")" "$PROFILE" && ok "profile: worktree is a writable subpath" || fail "profile missing worktree subpath"
grep -q "(subpath \"$GAFFER_DATA\")" "$PROFILE" && ok "profile: GAFFER_DATA is a writable subpath" || fail "profile missing GAFFER_DATA subpath"
grep -q '(allow network\*)' "$PROFILE" && ok "profile: network allowed (STRICT_ALLOW_NETWORK=1 default)" || fail "profile should allow network by default"

echo "== OS enforcement under the generated profile =="
# 1. Write INSIDE the worktree → must SUCCEED.
if sandbox-exec -f "$PROFILE" python3 -c "open('$WORKTREE/inside.txt','w').write('ok')" 2>/dev/null; then
  [ -f "$WORKTREE/inside.txt" ] && ok "write INSIDE worktree succeeds" || fail "inside write reported ok but file missing"
else
  fail "write INSIDE worktree was wrongly blocked"
fi

# 2. Write OUTSIDE the worktree → must be OS-BLOCKED.
if sandbox-exec -f "$PROFILE" python3 -c "open('$OUTSIDE/escape.txt','w').write('leak')" 2>/dev/null; then
  fail "write OUTSIDE worktree LEAKED (should be OS-blocked)"
else
  [ ! -f "$OUTSIDE/escape.txt" ] && ok "write OUTSIDE worktree is OS-blocked" || fail "outside write left a file behind"
fi

# 2b. DYNAMIC outside path (the class of escape the in-process hook can miss).
if sandbox-exec -f "$PROFILE" python3 -c "import os; p=os.path.join('$OUTSIDE','d'+'yn'); open(p,'w').write('x')" 2>/dev/null; then
  fail "DYNAMIC-path write OUTSIDE worktree LEAKED"
else
  ok "DYNAMIC-path write OUTSIDE worktree is OS-blocked"
fi

# 3. A representative test runner must still run under the profile.
UPKG="$WORKTREE/utest"
mkdir -p "$UPKG"
cat > "$UPKG/test_sample.py" <<'PY'
import unittest
class T(unittest.TestCase):
    def test_pass(self):
        self.assertEqual(1 + 1, 2)
if __name__ == "__main__":
    unittest.main()
PY
if ( cd "$WORKTREE" && sandbox-exec -f "$PROFILE" python3 -m unittest discover -s utest -p 'test_*.py' ) >/dev/null 2>&1; then
  ok "python3 -m unittest runs under the profile"
else
  fail "python3 -m unittest failed under the profile"
fi

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
