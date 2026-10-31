#!/usr/bin/env bash
# =====================================================================
# RESTORE UNDER LOAD — the real `dispatch export` / `dispatch import` CLI while a
# second PROCESS creates epics (tickets + dependencies + ACs) on the same database.
#   • every export taken mid-write exits 0, says it verified the restore, and the
#     untouched file imports into a fresh database with no dangling references;
#   • the restored ticket count matches whole epics (a consistent snapshot);
#   • a database that is internally inconsistent (a dependency on a missing ticket)
#     makes export exit non-zero and write NO file — never a silent bad backup.
# Third external review, HIGH recovery. Run: bash runner/test/export-under-load.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CLI="$ROOT/packages/dispatch/dist/cli/index.js"
CORE="$ROOT/packages/dispatch/dist/core.js"
[ -f "$CLI" ] && [ -f "$CORE" ] || { echo "SKIP: dispatch CLI not built ($CLI)"; exit 0; }

P=0; F=0
ok(){ P=$((P + 1)); printf '  ok   %s\n' "$1"; }
no(){ F=$((F + 1)); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/export-under-load.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WP=""
cleanup(){ [ -n "$WP" ] && kill "$WP" 2>/dev/null; gaffer_test_rm_work "$WORK"; }
trap cleanup EXIT
SRC="$WORK/src.sqlite"
node "$CLI" --db "$SRC" init >/dev/null

# The writer: three-ticket epics in a loop until the stop file appears (or 60 s / 1500).
cat > "$WORK/writer.mjs" <<JS
import { existsSync } from "node:fs";
import { Dispatch } from "$CORE";
const [file, stop] = process.argv.slice(2);
const wg = Dispatch.open(file);
const human = { type: "human", id: "writer" };
const pause = new Int32Array(new SharedArrayBuffer(4));
const deadline = Date.now() + 60000;
for (let i = 0; !existsSync(stop) && Date.now() < deadline && i < 1500; i++) {
  wg.createEpic({ epic: { name: "E" + i, description: "d" }, tickets: [
    { title: "a" + i, description: "a", acceptanceCriteria: ["x"] },
    { title: "b" + i, description: "b", acceptanceCriteria: ["y"], dependsOn: [0] },
    { title: "c" + i, description: "c", acceptanceCriteria: ["z"], dependsOn: [0, 1] },
  ] }, human);
  if (i === 2) console.log("writing");
  Atomics.wait(pause, 0, 0, 3);
}
wg.db.close();
JS
node "$WORK/writer.mjs" "$SRC" "$WORK/stop" > "$WORK/writer.out" 2>&1 &
WP=$!
for _ in $(seq 1 100); do
  case "$(cat "$WORK/writer.out" 2>/dev/null)" in *writing*) break ;; esac
  perl -e 'select(undef,undef,undef,0.1)'
done

exports=0; bad_exports=0; bad_imports=0; partial=0; overlapped=0
for n in 1 2 3 4 5 6; do
  kill -0 "$WP" 2>/dev/null && overlapped=$((overlapped + 1))
  if ! node "$CLI" --db "$SRC" export --out "$WORK/b$n.json" > "$WORK/exp$n.out" 2>&1; then
    bad_exports=$((bad_exports + 1)); continue
  fi
  exports=$((exports + 1))
  out="$(cat "$WORK/exp$n.out")"
  case "$out" in *'"verified": true'*) ;; *) bad_exports=$((bad_exports + 1)) ;; esac
  if ! node "$CLI" --db "$WORK/dst$n.sqlite" import "$WORK/b$n.json" > "$WORK/imp$n.out" 2>&1; then
    bad_imports=$((bad_imports + 1)); continue
  fi
  # Whole epics only: each epic is one scope node + a fixed number of tickets.
  counts="$(node -e '
    const D = require(process.argv[1]);
    const db = new D(process.argv[2], { readonly: true });
    const n = (t) => db.prepare("SELECT COUNT(*) AS n FROM " + t).get().n;
    const fk = db.pragma("foreign_key_check").length;
    console.log(n("scope_nodes"), n("tickets"), fk);
  ' "$ROOT/packages/dispatch/node_modules/better-sqlite3" "$WORK/dst$n.sqlite")"
  set -- $counts
  [ "$3" = "0" ] && [ "$2" = "$(( $1 * 4 ))" ] || partial=$((partial + 1))
done
: > "$WORK/stop"; wait "$WP" 2>/dev/null; WP=""

[ "$overlapped" -ge 3 ] && ok "the writer was creating epics during $overlapped of 6 exports" \
  || no "the writer was not running during the exports ($overlapped of 6)"
[ "$exports" = 6 ] && [ "$bad_exports" = 0 ] && ok "every export under load exited 0 and reported a verified restore" \
  || no "exports under load: $exports ok, $bad_exports bad ($(cat "$WORK"/exp*.out | head -c 300))"
[ "$bad_imports" = 0 ] && ok "every untouched export imported into a fresh database" \
  || no "$bad_imports export(s) were rejected by the importer ($(cat "$WORK"/imp*.out | head -c 300))"
[ "$partial" = 0 ] && ok "every restore held whole epics and no dangling references" \
  || no "$partial restore(s) held a torn snapshot"

# An internally inconsistent source: export must fail loudly and write nothing.
BAD="$WORK/bad.sqlite"
node "$CLI" --db "$BAD" init >/dev/null
node -e '
  const D = require(process.argv[1]);
  const db = new D(process.argv[2]);
  db.pragma("foreign_keys = OFF");
  db.prepare("INSERT INTO ticket_dependencies(ticket_id, depends_on_ticket_id) VALUES (?, ?)").run("gone-a", "gone-b");
' "$ROOT/packages/dispatch/node_modules/better-sqlite3" "$BAD"
if node "$CLI" --db "$BAD" export --out "$WORK/bad.json" > "$WORK/bad.out" 2>&1; then
  no "export of an inconsistent database exited 0"
else
  ok "export of an inconsistent database exited non-zero"
fi
[ ! -e "$WORK/bad.json" ] && ok "and wrote no bundle file" || no "an unrestorable bundle was written"
bad_out="$(cat "$WORK/bad.out")"
case "$bad_out" in *"restore check"*dangling*) ok "and said why (restore check, dangling references)" ;;
  *) no "export failure did not explain itself: $bad_out" ;; esac
stdout_bytes="$(node "$CLI" --db "$BAD" export 2>/dev/null | wc -c | tr -d ' ')"
[ "$stdout_bytes" = 0 ] && ok "stdout export of it prints no bundle either" \
  || no "stdout export printed $stdout_bytes bytes of an unrestorable bundle"

echo "export-under-load: $P passed, $F failed"
[ "$F" -eq 0 ]
