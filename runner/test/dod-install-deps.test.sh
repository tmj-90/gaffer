#!/bin/bash
# =====================================================================
# gaffer_dod_install_deps — pre-gate worktree dependency install.
# ---------------------------------------------------------------------
# A fresh delivery worktree has package.json + a lockfile but no
# node_modules, so the DoD test gate cannot run. Before the gate runs,
# this helper installs the worktree's deps IN THE WORKTREE, bounded +
# fail-soft, so the tests can actually execute. This is the runner-side
# enabler; it never crashes the tick and never passes the gate.
#
# Asserts:
#   1. Fresh Node worktree (package.json + lockfile + file: dep) → installs,
#      node_modules appears, and the pm name is echoed for the caller log.
#   2. No package.json            → clean no-op (no output, no install).
#   3. package.json, NO lockfile  → clean no-op (we don't guess an install).
#   4. Already has node_modules    → clean no-op (idempotent, no output),
#      incl. a node_modules SYMLINK variant (the common worktree case).
#   5. gaffer_dod_install_enabled honours GAFFER_DOD_INSTALL=0 and
#      GAFFER_GREENFIELD_INSTALL=0 (opt-out → the loop is skipped entirely).
#   6. Install ATTEMPTED but fails (unreachable registry) → FAILED:npm,
#      no crash, no node_modules, diagnostic preserved on stderr.
#   7. Install TIMES OUT (gaffer_timeout returns 124) → FAILED:timeout:npm.
#
# Hermetic: the install case uses a LOCAL file: dependency, so npm needs
# no registry/network. gaffer_timeout is stubbed as a pass-through (the
# real shim lives in factory.config.sh). Skips if node/npm are unavailable.
# Run: bash runner/test/dod-install-deps.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
LIB="$RUNNER_DIR/lib/dod.sh"

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
  echo "SKIP: dod.sh not found: $LIB"
  exit 0
}

# The real gaffer_timeout lives in factory.config.sh (not sourced here). Stub it as
# a pass-through so the bounded install runs its command directly; case 7 overrides
# this stub to simulate a timeout (rc 124).
gaffer_timeout() { shift; "$@"; }

# shellcheck source=/dev/null
. "$LIB"
type gaffer_dod_install_deps >/dev/null 2>&1 || {
  echo "SKIP: gaffer_dod_install_deps not defined"
  exit 0
}

WORK="$(mktemp -d "${TMPDIR:-/tmp}/dod-install-deps.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# --- A tiny LOCAL dependency so the install needs no registry/network. -------
mkdir -p "$WORK/localdep"
printf '{"name":"localdep","version":"1.0.0"}\n' >"$WORK/localdep/package.json"

# --- Case 1: fresh worktree with a lockfile → installs + echoes pm -----------
echo "== case 1: fresh worktree (package.json + lock + file: dep) installs deps =="
APP="$WORK/app"
mkdir -p "$APP"
printf '{"name":"app","version":"1.0.0","private":true,"dependencies":{"localdep":"file:../localdep"}}\n' \
  >"$APP/package.json"
# A lockfile must be PRESENT for the deterministic-install guard to fire. A stale
# stub is fine: npm ci rejects it and the helper falls back to `npm install`.
printf '{"name":"app","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{}}\n' \
  >"$APP/package-lock.json"
OUT="$(gaffer_dod_install_deps "$APP")"
RC=$?
[ "$RC" = "0" ] && ok "returns 0" || fail "returns 0 (got $RC)"
[ "$OUT" = "npm" ] && ok "echoes the package manager used (npm)" || fail "echoes npm (got '$OUT')"
[ -e "$APP/node_modules/localdep" ] && ok "node_modules/localdep installed in the worktree" ||
  fail "node_modules/localdep installed in the worktree"

# --- Case 2: no package.json → clean no-op (non-node repo) --------------------
echo "== case 2: non-Node worktree → no-op =="
BARE="$WORK/bare"
mkdir -p "$BARE"
printf 'hi\n' >"$BARE/README.md"
OUT="$(gaffer_dod_install_deps "$BARE")"
[ -z "$OUT" ] && ok "no output" || fail "no output (got '$OUT')"
[ ! -e "$BARE/node_modules" ] && ok "no node_modules created" || fail "no node_modules created"

# --- Case 3: package.json but NO lockfile → no-op (don't guess) --------------
echo "== case 3: package.json without a lockfile → no-op =="
NOLOCK="$WORK/nolock"
mkdir -p "$NOLOCK"
printf '{"name":"nolock","version":"1.0.0","dependencies":{"localdep":"file:../localdep"}}\n' \
  >"$NOLOCK/package.json"
OUT="$(gaffer_dod_install_deps "$NOLOCK")"
[ -z "$OUT" ] && ok "no output (no lockfile → not deterministic)" || fail "no output (got '$OUT')"
[ ! -e "$NOLOCK/node_modules" ] && ok "no node_modules created" || fail "no node_modules created"

# --- Case 4: already has node_modules → idempotent no-op (dir + symlink) ------
echo "== case 4: node_modules already present → idempotent no-op =="
HAVE="$WORK/have"
mkdir -p "$HAVE/node_modules/.marker"
printf '{"name":"have","version":"1.0.0"}\n' >"$HAVE/package.json"
printf '{"lockfileVersion":3}\n' >"$HAVE/package-lock.json"
OUT="$(gaffer_dod_install_deps "$HAVE")"
[ -z "$OUT" ] && ok "no output (already present)" || fail "no output (got '$OUT')"
[ -e "$HAVE/node_modules/.marker" ] && ok "existing node_modules untouched" ||
  fail "existing node_modules untouched"
# The common worktree case: node_modules is a SYMLINK to a shared install.
SYM="$WORK/sym"
mkdir -p "$SYM"
printf '{"name":"sym","version":"1.0.0"}\n' >"$SYM/package.json"
printf '{"lockfileVersion":3}\n' >"$SYM/package-lock.json"
mkdir -p "$WORK/shared_nm/.marker"
ln -s "$WORK/shared_nm" "$SYM/node_modules"
OUT="$(gaffer_dod_install_deps "$SYM")"
[ -z "$OUT" ] && ok "no output when node_modules is a symlink (worktree case)" ||
  fail "no output for a node_modules symlink (got '$OUT')"
[ -L "$SYM/node_modules" ] && ok "node_modules symlink left intact" ||
  fail "node_modules symlink left intact"

# --- Case 5: opt-out knobs make the pre-gate step inert ----------------------
echo "== case 5: opt-out knobs (GAFFER_DOD_INSTALL / GAFFER_GREENFIELD_INSTALL) =="
if gaffer_dod_install_enabled; then
  ok "enabled by default (unset → ON)"
else
  fail "enabled by default (unset → ON)"
fi
if GAFFER_DOD_INSTALL=0 gaffer_dod_install_enabled; then
  fail "GAFFER_DOD_INSTALL=0 disables the pre-gate install"
else
  ok "GAFFER_DOD_INSTALL=0 disables the pre-gate install (byte-identical to today)"
fi
if GAFFER_GREENFIELD_INSTALL=0 gaffer_dod_install_enabled; then
  fail "GAFFER_GREENFIELD_INSTALL=0 also disables the pre-gate install"
else
  ok "GAFFER_GREENFIELD_INSTALL=0 also disables it (one mental model)"
fi

# --- Case 6: install ATTEMPTED but fails → FAILED sentinel, no crash ----------
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
  gaffer_dod_install_deps "$BADDEP" 2>"$ERRLOG")"
RC=$?
[ "$RC" = "0" ] && ok "returns 0 even on a failed install (fail-soft, no crash)" ||
  fail "returns 0 on a failed install (got $RC)"
[ "$OUT" = "FAILED:npm" ] && ok "echoes FAILED:npm sentinel on a failed install" ||
  fail "echoes FAILED:npm (got '$OUT')"
[ ! -e "$BADDEP/node_modules" ] && ok "no node_modules on failure" || fail "no node_modules on failure"
grep -q "did not prime deps" "$ERRLOG" && ok "surfaces the failure reason on stderr (not swallowed)" ||
  fail "surfaces the failure reason on stderr"

# --- Case 7: install TIMES OUT → FAILED:timeout:<pm> -------------------------
echo "== case 7: timed-out install → FAILED:timeout:<pm> sentinel =="
TMO="$WORK/tmo"
mkdir -p "$TMO"
printf '{"name":"tmo","version":"1.0.0","dependencies":{"localdep":"file:../localdep"}}\n' \
  >"$TMO/package.json"
printf '{"name":"tmo","version":"1.0.0","lockfileVersion":3,"packages":{}}\n' \
  >"$TMO/package-lock.json"
# Simulate gaffer_timeout tripping its wall-clock limit: it returns 124 (GNU-timeout
# convention) WITHOUT running the install, so node_modules never appears.
gaffer_timeout() { return 124; }
OUT="$(gaffer_dod_install_deps "$TMO" 2>/dev/null)"
RC=$?
gaffer_timeout() { shift; "$@"; } # restore the pass-through stub
[ "$RC" = "0" ] && ok "returns 0 on a timeout (fail-soft, no crash)" ||
  fail "returns 0 on a timeout (got $RC)"
[ "$OUT" = "FAILED:timeout:npm" ] && ok "echoes FAILED:timeout:npm on a timeout" ||
  fail "echoes FAILED:timeout:npm (got '$OUT')"
[ ! -e "$TMO/node_modules" ] && ok "no node_modules on timeout" || fail "no node_modules on timeout"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS — $PASS checks passed (lib: $LIB)"
  exit 0
else
  echo "FAILED — ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
