#!/usr/bin/env bash
# =====================================================================
# crew never forks the factory onto a fresh Dispatch DB, and `crew doctor` is
# clean on a dashboard-onboarded factory.
# ---------------------------------------------------------------------
# crew used to open crew.yaml's sqlite_path and Dispatch.open CREATED it when
# missing, so a drifted path (a moved/restored $GAFFER_DATA, an overridden
# DISPATCH_DB) sent every idle draft and onboard registration to an empty DB
# nobody reads. With the REAL built crew + dispatch, proves:
#   1. `crew maintain` on a factory whose DB is missing fails and creates nothing.
#   2. fg (factory.config.sh) pins crew to $DISPATCH_DB: with crew.yaml pointing
#      at a missing path, `fg maintain` runs against the factory DB and still
#      creates nothing at the drifted path.
#   3. `crew doctor` on a factory whose only repo is in Dispatch (crew.yaml
#      `repos: []`, no agents) prints no warning line.
#
# Run: bash runner/test/crew-dispatch-db-pin.test.sh   (SKIPs without the builds)
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
CREW_CLI="$ROOT/packages/crew/dist/cli/index.js"
DISPATCH_CLI="$ROOT/packages/dispatch/dist/cli/index.js"
for f in "$CREW_CLI" "$DISPATCH_CLI"; do
  [ -f "$f" ] || { echo "SKIP: $f not built — run pnpm -r build"; exit 0; }
done

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/crew-db-pin.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
trap 'gaffer_test_rm_work "$WORK"' EXIT
unset CREW_DISPATCH_DB

FAC="$WORK/fac"; mkdir -p "$FAC"
node "$CREW_CLI" init -d "$FAC" >/dev/null 2>&1 || { echo "FAIL: crew init"; exit 1; }
DRIFTED="$(grep -m1 'sqlite_path:' "$FAC/crew.yaml" | sed 's/.*sqlite_path:[[:space:]]*//')"

echo "== 1. a missing DB is refused, not created =="
if node "$CREW_CLI" -c "$FAC/crew.yaml" maintain --force >/dev/null 2>"$WORK/err.txt"; then
  fail "crew maintain succeeded against a missing DB"
else
  grep -q 'DISPATCH_UNAVAILABLE' "$WORK/err.txt" \
    && ok "crew maintain fails with DISPATCH_UNAVAILABLE on a missing DB" \
    || fail "unexpected error: $(head -c 200 "$WORK/err.txt")"
fi
[ ! -e "$DRIFTED" ] && ok "no DB was created at $DRIFTED" || fail "crew created a fresh DB at $DRIFTED"

echo "== 2. fg pins crew to \$DISPATCH_DB =="
DATA="$WORK/data"; mkdir -p "$DATA"
node "$DISPATCH_CLI" --db "$DATA/dispatch.sqlite" init >/dev/null 2>&1
OUT="$(GAFFER_DATA="$DATA" DISPATCH_DB="$DATA/dispatch.sqlite" MEMORY_DB="$DATA/memory.sqlite" \
  CREW_DIR="$ROOT/packages/crew" CREW_CONFIG="$FAC/crew.yaml" \
  bash -c 'source "$1/factory.config.sh" >/dev/null 2>&1; fg maintain --force 2>&1; echo "rc=$?"' _ "$RUNNER_DIR")"
case "$OUT" in
  *'"ok": true'*rc=0*) ok "fg maintain runs against the factory DB despite crew.yaml's drifted path" ;;
  *) fail "fg maintain failed: $(printf '%s' "$OUT" | tail -c 300)" ;;
esac
[ ! -e "$DRIFTED" ] && ok "still nothing created at the drifted crew.yaml path" \
  || fail "fg created a DB at the drifted path $DRIFTED"

echo "== 3. crew doctor is clean on a dashboard-onboarded factory =="
FAC2="$WORK/fac2"; mkdir -p "$FAC2" "$WORK/repo1"
chmod 700 "$FAC2"   # as $GAFFER_DATA is (factory.config.sh), so the audit-log check is clean
node "$DISPATCH_CLI" --db "$FAC2/dispatch.sqlite" init >/dev/null 2>&1
node "$CREW_CLI" init -d "$FAC2" >/dev/null 2>&1
# repo add --path needs a git repository (as onboard does).
git init -q "$WORK/repo1" >/dev/null 2>&1
node "$DISPATCH_CLI" --db "$FAC2/dispatch.sqlite" repo add -n repo1 --path "$WORK/repo1" >/dev/null 2>&1
DOC="$(node "$CREW_CLI" -c "$FAC2/crew.yaml" doctor 2>&1)"
if grep -qE '^!|with warnings' <<<"$DOC"; then
  fail "crew doctor warns on a healthy Dispatch-only factory: $(printf '%s\n' "$DOC" | grep -A1 '^!' | tr '\n' ' ')"
else
  ok "crew doctor prints no warning (repos counted from Dispatch, agents informational)"
fi
grep -q '1 repo(s) present on disk' <<<"$DOC" \
  && ok "doctor counts the Dispatch-registered repo" \
  || fail "doctor did not count the Dispatch repo"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS ($PASS checks)"; exit 0
else
  printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
fi
