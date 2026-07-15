#!/bin/bash
# =====================================================================
# gaffer_ensure_node_modules — greenfield first-run dependency priming.
# ---------------------------------------------------------------------
# A freshly-bootstrapped repo has package.json + a lockfile but no
# node_modules; the delivery worktree flow only SYMLINKS the primary
# repo's node_modules in, so if the primary has none the first "build a
# whole new app" ticket dies at the test gate on missing modules. The
# helper installs ONCE into the primary repo so that symlink resolves.
#
# Asserts:
#   1. Fresh Node repo (package.json + lockfile + a file: dep) → installs,
#      node_modules appears, and the pm name is echoed for the caller log.
#   2. No package.json            → clean no-op (no output, no install).
#   3. package.json, NO lockfile  → clean no-op (we don't guess an install).
#   4. Already has node_modules    → clean no-op (idempotent, no output).
#   5. GAFFER_GREENFIELD_INSTALL=0 → disabled, clean no-op.
#
# Hermetic: the install case uses a LOCAL file: dependency, so npm needs
# no registry/network. Skips cleanly if node/npm are unavailable.
# Run: bash runner/test/greenfield-ensure-deps.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
LIB="$RUNNER_DIR/lib/greenfield.sh"

PASS=0
FAILURES=()
ok() {
  PASS=$((PASS + 1))
  printf '  ok   %s\n' "$1"
}
fail() {
  FAILURES+=("$1")
  printf '  FAIL %s\n' "$1"
}

command -v node >/dev/null 2>&1 || {
  echo "SKIP: node required"
  exit 0
}
command -v npm >/dev/null 2>&1 || {
  echo "SKIP: npm required"
  exit 0
}
[ -f "$LIB" ] || {
  echo "SKIP: greenfield.sh not found: $LIB"
  exit 0
}

# shellcheck source=/dev/null
. "$LIB"
type gaffer_ensure_node_modules >/dev/null 2>&1 || {
  echo "SKIP: gaffer_ensure_node_modules not defined"
  exit 0
}

WORK="$(mktemp -d "${TMPDIR:-/tmp}/gf-ensure-deps.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# --- A tiny LOCAL dependency so the install needs no registry/network. -------
mkdir -p "$WORK/localdep"
printf '{"name":"localdep","version":"1.0.0"}\n' >"$WORK/localdep/package.json"

# --- Case 1: fresh Node repo with a lockfile → installs + echoes pm ----------
echo "== case 1: fresh repo (package.json + lock + file: dep) primes install =="
APP="$WORK/app"
mkdir -p "$APP"
printf '{"name":"app","version":"1.0.0","private":true,"dependencies":{"localdep":"file:../localdep"}}\n' \
  >"$APP/package.json"
# A lockfile must be PRESENT for the deterministic-install guard to fire. A stale
# stub is fine: npm ci rejects it and the helper falls back to `npm install`.
printf '{"name":"app","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{}}\n' \
  >"$APP/package-lock.json"
OUT="$(gaffer_ensure_node_modules "$APP")"
RC=$?
[ "$RC" = "0" ] && ok "returns 0" || fail "returns 0 (got $RC)"
[ "$OUT" = "npm" ] && ok "echoes the package manager used (npm)" || fail "echoes npm (got '$OUT')"
[ -e "$APP/node_modules/localdep" ] && ok "node_modules/localdep installed" ||
  fail "node_modules/localdep installed"

# --- Case 2: no package.json → clean no-op -----------------------------------
echo "== case 2: non-Node dir → no-op =="
BARE="$WORK/bare"
mkdir -p "$BARE"
printf 'hi\n' >"$BARE/README.md"
OUT="$(gaffer_ensure_node_modules "$BARE")"
[ -z "$OUT" ] && ok "no output" || fail "no output (got '$OUT')"
[ ! -e "$BARE/node_modules" ] && ok "no node_modules created" || fail "no node_modules created"

# --- Case 3: package.json but NO lockfile → no-op (don't guess) --------------
echo "== case 3: package.json without a lockfile → no-op =="
NOLOCK="$WORK/nolock"
mkdir -p "$NOLOCK"
printf '{"name":"nolock","version":"1.0.0","dependencies":{"localdep":"file:../localdep"}}\n' \
  >"$NOLOCK/package.json"
OUT="$(gaffer_ensure_node_modules "$NOLOCK")"
[ -z "$OUT" ] && ok "no output (no lockfile → not deterministic)" || fail "no output (got '$OUT')"
[ ! -e "$NOLOCK/node_modules" ] && ok "no node_modules created" || fail "no node_modules created"

# --- Case 4: already has node_modules → idempotent no-op ---------------------
echo "== case 4: node_modules already present → idempotent no-op =="
HAVE="$WORK/have"
mkdir -p "$HAVE/node_modules/.marker"
printf '{"name":"have","version":"1.0.0"}\n' >"$HAVE/package.json"
printf '{"lockfileVersion":3}\n' >"$HAVE/package-lock.json"
OUT="$(gaffer_ensure_node_modules "$HAVE")"
[ -z "$OUT" ] && ok "no output (already present)" || fail "no output (got '$OUT')"
[ -e "$HAVE/node_modules/.marker" ] && ok "existing node_modules untouched" ||
  fail "existing node_modules untouched"

# --- Case 5: opt-out via GAFFER_GREENFIELD_INSTALL=0 -------------------------
echo "== case 5: GAFFER_GREENFIELD_INSTALL=0 disables priming =="
OFF="$WORK/off"
mkdir -p "$OFF"
printf '{"name":"off","version":"1.0.0","dependencies":{"localdep":"file:../localdep"}}\n' \
  >"$OFF/package.json"
printf '{"lockfileVersion":3}\n' >"$OFF/package-lock.json"
OUT="$(GAFFER_GREENFIELD_INSTALL=0 gaffer_ensure_node_modules "$OFF")"
[ -z "$OUT" ] && ok "no output when disabled" || fail "no output when disabled (got '$OUT')"
[ ! -e "$OFF/node_modules" ] && ok "no install when disabled" || fail "no install when disabled"

# --- Case 6: install ATTEMPTED but fails → FAILED sentinel + diagnostic preserved --
echo "== case 6: failed install → FAILED:<pm> sentinel + diagnostic on stderr =="
BADDEP="$WORK/baddep"
mkdir -p "$BADDEP"
# A registry dependency + an UNREACHABLE registry (127.0.0.1:1, refused immediately)
# → npm ci AND npm install both fail hermetically (no real network), and node_modules
# never materialises. Deterministic + fast (connection refused, zero retries).
printf '{"name":"baddep","version":"1.0.0","dependencies":{"nonexistent-pkg-xyzzy":"1.2.3"}}\n' \
  >"$BADDEP/package.json"
printf '{"name":"baddep","version":"1.0.0","lockfileVersion":3,"packages":{}}\n' \
  >"$BADDEP/package-lock.json"
ERRLOG="$WORK/case6.err"
OUT="$(npm_config_registry='http://127.0.0.1:1' npm_config_fetch_retries=0 \
  gaffer_ensure_node_modules "$BADDEP" 2>"$ERRLOG")"
[ "$OUT" = "FAILED:npm" ] && ok "echoes FAILED:npm sentinel on a failed prime" ||
  fail "echoes FAILED:npm (got '$OUT')"
[ ! -e "$BADDEP/node_modules" ] && ok "no node_modules on failure" || fail "no node_modules on failure"
grep -q "did not prime deps" "$ERRLOG" && ok "surfaces the failure reason on stderr (not swallowed)" ||
  fail "surfaces the failure reason on stderr"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS — $PASS checks passed (lib: $LIB)"
  exit 0
else
  echo "FAILED — ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
