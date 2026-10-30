#!/usr/bin/env bash
# runner/test/lib/db-forensics.sh — evidence for a runner test that fails on a dispatch
# DB invariant, read STRAIGHT from SQLite (not through the CLI under suspicion), and
# kept past the test's own `trap 'rm -rf "$WORK"' EXIT`.
#
#   gaffer_test_db_rows DB NUM...        print, per ticket number: the tickets row
#                                        (status, row_version, updated_at), every
#                                        ticket_claims row (status, expires_at,
#                                        released_at) and every work_events row (rowid,
#                                        event_type, payload). A claim 'completed' with
#                                        no transition to in_review = the submit
#                                        transaction partly persisted (product bug); a
#                                        claim still 'active' with no claim.completed =
#                                        the submit never ran against that ticket.
#   gaffer_test_db_snapshot DB NAME FILE...  when $GAFFER_TEST_ARTIFACTS is set (CI
#                                        uploads it on failure), write a CONSISTENT copy
#                                        of DB there as NAME.sqlite via `VACUUM INTO` —
#                                        it folds in un-checkpointed WAL content, which a
#                                        plain `cp` of the main file drops — plus copies
#                                        of FILE... (e.g. the per-delivery logs). Prints
#                                        where it went; a no-op without the env var.
# Both need python3 (its sqlite3 module); both are best-effort and never fail the caller.

gaffer_test_db_rows() {
  local db="$1"; shift
  python3 - "$db" "$@" <<'PY' 2>&1 || true
import sqlite3, sys
db, nums = sys.argv[1], [int(n) for n in sys.argv[2:] if n.isdigit()]
c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
for n in nums:
    t = c.execute("SELECT id, status, row_version, updated_at FROM tickets WHERE number=?", (n,)).fetchone()
    if not t:
        print(f"  #{n}: no tickets row"); continue
    print(f"  #{n}: status={t[1]} row_version={t[2]} updated_at={t[3]}")
    for r in c.execute("SELECT status, expires_at, released_at, created_at FROM ticket_claims WHERE ticket_id=? ORDER BY created_at", (t[0],)):
        print(f"    claim status={r[0]} expires_at={r[1]} released_at={r[2]} created_at={r[3]}")
    for r in c.execute("SELECT rowid, event_type, payload_json, created_at FROM work_events WHERE entity_id=? ORDER BY rowid", (t[0],)):
        print(f"    event #{r[0]} {r[3]} {r[1]} {(r[2] or '')[:200]}")
PY
}

gaffer_test_db_snapshot() {
  local db="$1" name="$2"; shift 2
  [ -n "${GAFFER_TEST_ARTIFACTS:-}" ] || return 0
  local dir="$GAFFER_TEST_ARTIFACTS/$name"
  mkdir -p "$dir" || return 0
  rm -f "$dir/$name.sqlite"
  python3 -c 'import sqlite3,sys; sqlite3.connect(sys.argv[1]).execute("VACUUM INTO ?", (sys.argv[2],))' \
    "$db" "$dir/$name.sqlite" 2>/dev/null || cp "$db" "$db-wal" "$db-shm" "$dir/" 2>/dev/null
  local f; for f in "$@"; do [ -f "$f" ] && cp "$f" "$dir/" 2>/dev/null; done
  echo "  forensics saved to $dir (uploaded as a CI artifact on failure)"
  return 0
}
