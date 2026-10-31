#!/usr/bin/env bash
# =====================================================================
# lib/db-forensics.sh — the evidence a dispatch-invariant failure leaves behind
# (concurrency-bookkeeping PART D3 failed once on main CI: a submit that exited 0
# left its ticket 'claimed'; the DB was deleted by the test's EXIT trap and the
# inline diagnostics could not tell "submit never ran" from "submit half-persisted").
#   F1  gaffer_test_db_snapshot keeps rows that live ONLY in the WAL (a plain cp of
#       the main DB file — the obvious snapshot — loses them)
#   F2  …and the per-delivery logs; a no-op without $GAFFER_TEST_ARTIFACTS
#   F3  gaffer_test_db_rows prints the ticket, claim and event rows straight from
#       SQLite for a real dispatch ticket
#   F4  CI uploads $GAFFER_TEST_ARTIFACTS on failure, the action pinned by full SHA
# Run: bash runner/test/db-forensics.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CLI_JS="$ROOT/packages/dispatch/dist/cli/index.js"
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 required"; exit 0; }
# shellcheck source=lib/db-forensics.sh
. "$HERE/lib/db-forensics.sh"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/db-forensics.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT
count() { python3 -c 'import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute("select count(*) from t").fetchone()[0])' "$1" 2>/dev/null || echo ERR; }

echo "== F1/F2: a consistent snapshot, WAL included =="
DB="$WORK/wal.sqlite"
# Leave 5 committed rows in the WAL, never checkpointed (no autocheckpoint, no close).
python3 - "$DB" <<'PY'
import os, sqlite3, sys
c = sqlite3.connect(sys.argv[1], isolation_level=None)
c.execute("PRAGMA journal_mode=WAL"); c.execute("PRAGMA wal_autocheckpoint=0")
c.execute("CREATE TABLE t(x)"); c.execute("PRAGMA wal_checkpoint(TRUNCATE)")
for i in range(5): c.execute("INSERT INTO t VALUES (?)", (i,))
os._exit(0)
PY
[ -s "$DB-wal" ] && ok "fixture: the 5 rows are only in the WAL ($(wc -c <"$DB-wal" | tr -d ' ') bytes)" || fail "fixture: no WAL left"
mkdir -p "$WORK/naive"; cp "$DB" "$WORK/naive/wal.sqlite"
[ "$(count "$WORK/naive/wal.sqlite")" = 0 ] && ok "control: a plain cp of the DB file loses the WAL rows" || fail "control: cp kept $(count "$WORK/naive/wal.sqlite") rows"
echo "delivery E log" > "$WORK/log.E"
OUT="$(GAFFER_TEST_ARTIFACTS="$WORK/art" gaffer_test_db_snapshot "$DB" case1 "$WORK/log.E")"
[ "$(count "$WORK/art/case1/case1.sqlite")" = 5 ] && ok "F1 the snapshot holds all 5 committed rows" || fail "F1 snapshot rows: $(count "$WORK/art/case1/case1.sqlite") ($OUT)"
[ -f "$WORK/art/case1/log.E" ] && ok "F2 the delivery log is saved beside it" || fail "F2 log not saved"
grep -q "forensics saved to $WORK/art/case1" <<<"$OUT" && ok "F2 says where the evidence went" || fail "F2 no location line: $OUT"
OUT="$(env -u GAFFER_TEST_ARTIFACTS bash -c '. "$1"; gaffer_test_db_snapshot "$2" case2' _ "$HERE/lib/db-forensics.sh" "$DB")"
[ -z "$OUT" ] && [ ! -e "$WORK/art/case2" ] && ok "F2 without GAFFER_TEST_ARTIFACTS it is a silent no-op" || fail "F2 wrote without the env var: $OUT"

echo "== F3: the discriminating rows, straight from SQLite =="
if [ -f "$CLI_JS" ] && command -v node >/dev/null 2>&1; then
  D2="$WORK/dispatch.sqlite"
  wg() { node "$CLI_JS" --db "$D2" "$@"; }
  wg init >/dev/null 2>&1
  wg ticket create -t "forensic" --risk low >/dev/null 2>&1
  wg ac add 1 -t "AC" >/dev/null 2>&1; wg ticket ready 1 >/dev/null 2>&1
  ROWS="$(gaffer_test_db_rows "$D2" 1)"
  grep -q '#1: status=ready row_version=' <<<"$ROWS" && ok "F3 the tickets row (status + row_version)" || fail "F3 no ticket row: $ROWS"
  grep -q 'event #.*ticket' <<<"$ROWS" && ok "F3 the ticket's work_events rows" || fail "F3 no event rows: $ROWS"
  grep -q '#9: no tickets row' <<<"$(gaffer_test_db_rows "$D2" 9)" && ok "F3 an unknown ticket is reported, not an error" || fail "F3 unknown ticket"
else
  echo "SKIP: dispatch CLI not built ($CLI_JS) — F3 needs it"
fi

echo "== F4: CI keeps the evidence =="
CI="$ROOT/.github/workflows/ci.yml"
grep -qE 'GAFFER_TEST_ARTIFACTS: \$\{\{ runner\.temp \}\}/gaffer-test-artifacts' "$CI" && ok "F4 the runner-test step exports GAFFER_TEST_ARTIFACTS" || fail "F4 GAFFER_TEST_ARTIFACTS not set for the runner tests"
UP="$(grep -A6 'name: Upload runner-test evidence' "$CI")"
grep -q 'if: failure()' <<<"$UP" && ok "F4 an upload step runs on failure" || fail "F4 no on-failure upload step"
grep -qE 'uses: actions/upload-artifact@[0-9a-f]{40} ' <<<"$UP" && ok "F4 upload-artifact pinned by full commit SHA" || fail "F4 upload-artifact not SHA-pinned: $(grep uses: <<<"$UP")"
grep -q 'path: ${{ runner.temp }}/gaffer-test-artifacts' <<<"$UP" && ok "F4 it uploads that directory" || fail "F4 wrong upload path"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "db-forensics: ALL $PASS checks passed"; exit 0
fi
echo "db-forensics: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
