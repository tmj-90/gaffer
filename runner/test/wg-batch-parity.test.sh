#!/usr/bin/env bash
# =====================================================================
# lib/wg-batch.mjs (ticket setup in one node process, for the slow e2e tests) leaves
# the dispatch DB exactly as the `wg` CLI sequence it replaces does:
#   ticket create -t T -d D --risk low; ac add N -t TEXT;
#   ticket repo-access set N repo --access write --relation confirmed;
#   ticket set-testable N (unless the ticket is "plain"); ticket ready N
# Both run against twin databases; every table is compared row for row, with the ids
# that link rows written as what they name (ticket number, repo name) and only row ids,
# times, fresh uuids and the event hash chain masked (they differ by construction).
#   B1  the two databases hold the same rows (tickets, criteria, repo access,
#       events, audit-relevant rows), so a test using the batch drives the same world
#   B2  the batch prints the ticket numbers in order, and a "plain" ticket is not
#       made testable
#   B3  a refused step is reported and does not stop the next ticket (as the shell
#       sequence with 2>/dev/null did); a failed create exits 1
#   B4  the bare form (concurrency-bookkeeping's loop: ticket create -t "T$n" --risk low;
#       ac add $n -t "AC$n"; ticket ready $n) matches too, "{n}" in --ac included
#   B5  the batch's event log is a chain `events verify` accepts, in the CLI sequence's
#       order (the B1 dump sorts rows and masks the chain, so it cannot see either)
#   B6  it writes only a dispatch database inside the test's temp dir and only as the
#       operator: a path outside ${TMPDIR:-/tmp}, a SQLite file that is not a dispatch
#       database, a missing path and a set GAFFER_PRINCIPAL_TOKEN are each refused
#       (exit 2) with the file untouched and nothing created (a guessed path once
#       wrote two tickets into someone else's database)
# If this fails after a CLI change, make wg-batch.mjs make the same calls again.
# Run: bash runner/test/wg-batch-parity.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CLI_JS="$ROOT/packages/dispatch/dist/cli/index.js"
# shellcheck source=lib/skip.sh
. "$HERE/lib/skip.sh"
[ -f "$CLI_JS" ] || { echo "SKIP: dispatch CLI not built ($CLI_JS)"; exit 0; }
command -v git >/dev/null 2>&1 || gaffer_skip "git required"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/wg-batch-parity.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
trap 'gaffer_test_rm_work "$WORK"' EXIT
export DISPATCH_AUDIT_OFF=1 USER="${USER:-tester}"
git init -q -b main "$WORK/repo" && git -C "$WORK/repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
for d in cli batch cli4 batch4; do
  node "$CLI_JS" --db "$WORK/$d.sqlite" init >/dev/null
  node "$CLI_JS" --db "$WORK/$d.sqlite" repo add -n repo --path "$WORK/repo" --branch main --stack node --test "npm test" >/dev/null
done
wg() { node "$CLI_JS" --db "$WORK/cli.sqlite" "$@"; }
jget() { node "$ROOT/runner/lib/json-tool.mjs" expr "$1"; }
cli_ticket() { # title desc [plain]
  local n; n="$(wg ticket create -t "$1" -d "$2" --risk low 2>/dev/null | jget 'd.ticket.number')"
  wg ac add "$n" -t "tests pass" >/dev/null 2>&1
  wg ticket repo-access set "$n" repo --access write --relation confirmed >/dev/null 2>&1
  [ "${3:-}" = plain ] || wg ticket set-testable "$n" >/dev/null 2>&1
  wg ticket ready "$n" >/dev/null 2>&1
  printf '%s\n' "$n"
}
TAB="$(printf '\t')"
{ cli_ticket "Label [read-displayName]" "label() reads displayName"; cli_ticket "Note seven [note-7]" "a note" plain; cli_ticket "Note eight [note-8]" "a note"; } >"$WORK/cli.out"
node "$HERE/lib/wg-batch.mjs" "$WORK/batch.sqlite" --risk low --ac "tests pass" --repo repo --testable --ready \
  "Label [read-displayName]${TAB}label() reads displayName" "Note seven [note-7]${TAB}a note${TAB}plain" "Note eight [note-8]${TAB}a note" \
  >"$WORK/batch.out" 2>"$WORK/batch.err"; rc=$?

cat >"$WORK/dump.mjs" <<'JS'
import { DatabaseSync } from "node:sqlite";
// Every table's rows. Ids that point at a row are written as what they name (T<number>,
// R:<repo name>, AC:T<number>:<order>), so a criterion, repo grant or event on the
// wrong ticket shows up; what differs by construction (row ids, hash chain, times,
// fresh uuids) is left out or masked.
const SKIP = /^(id|hash|prev_hash)$|_at$/i;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const TS = /\d{4}-\d\d-\d\d[T ][\d:.]+Z?/g;
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const label = new Map();
for (const r of db.prepare("select id, number from tickets").all()) label.set(r.id, `T${r.number}`);
for (const r of db.prepare("select id, name from repositories").all()) label.set(r.id, `R:${r.name}`);
for (const r of db.prepare("select id, ticket_id, sort_order from acceptance_criteria").all())
  label.set(r.id, `AC:${label.get(r.ticket_id)}:${r.sort_order}`);
const ids = [...label.keys()].sort((a, b) => b.length - a.length);
const named = (v) => {
  if (typeof v !== "string") return v;
  if (label.has(v)) return label.get(v);
  let s = v;
  for (const id of ids) if (s.includes(id)) s = s.split(id).join(label.get(id));
  return s.replace(UUID, "<id>").replace(TS, "<ts>");
};
const tables = db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name").all();
for (const { name } of tables) {
  const rows = db.prepare(`select * from "${name}"`).all().map((r) => {
    const o = {};
    for (const [k, v] of Object.entries(r)) if (!SKIP.test(k)) o[k] = named(v);
    return JSON.stringify(o);
  });
  rows.sort();
  for (const r of rows) console.log(`${name}\t${r}`);
}
JS
node --no-warnings "$WORK/dump.mjs" "$WORK/cli.sqlite" >"$WORK/cli.dump"
node --no-warnings "$WORK/dump.mjs" "$WORK/batch.sqlite" >"$WORK/batch.dump"

echo "== B1: the same database =="
[ "$rc" -eq 0 ] && ok "B1 the batch ran (rc 0)" || fail "B1 batch rc=$rc: $(head -3 "$WORK/batch.err")"
n_rows="$(wc -l <"$WORK/cli.dump" | tr -d ' ')"
if cmp -s "$WORK/cli.dump" "$WORK/batch.dump"; then
  ok "B1 every table matches row for row ($n_rows rows: $(cut -f1 "$WORK/cli.dump" | sort -u | tr '\n' ' '))"
else
  fail "B1 the databases differ: $(diff "$WORK/cli.dump" "$WORK/batch.dump" | head -6 | cut -c1-300 | tr '\n' '|')"
fi
for t in tickets acceptance_criteria ticket_repos work_events; do
  grep -q "^$t	" "$WORK/cli.dump" && ok "B1 the comparison covers $t" || fail "B1 no $t rows compared (schema renamed?)"
done

echo "== B2: numbers and plain tickets =="
cmp -s "$WORK/cli.out" "$WORK/batch.out" && [ "$(tr '\n' ' ' <"$WORK/batch.out")" = "1 2 3 " ] \
  && ok "B2 the batch prints 1 2 3, as the CLI sequence did" || fail "B2 numbers: cli '$(tr '\n' ' ' <"$WORK/cli.out")' batch '$(tr '\n' ' ' <"$WORK/batch.out")'"
plain="$(node --no-warnings -e 'const{DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1]);process.stdout.write(d.prepare("select group_concat(number || '"'"'='"'"' || can_be_tested, '"'"' '"'"') v from (select number, can_be_tested from tickets order by number)").get().v)' "$WORK/batch.sqlite" 2>&1)"
[ "$plain" = "1=1 2=0 3=1" ] && ok "B2 only the plain ticket is left untestable" || fail "B2 testable flags: $plain"

echo "== B3: a refused step does not stop the batch =="
node "$HERE/lib/wg-batch.mjs" "$WORK/batch.sqlite" --risk low --ac "tests pass" --repo no-such-repo --ready "Orphan${TAB}no repo" >"$WORK/b3.out" 2>"$WORK/b3.err"; rc=$?
[ "$rc" -eq 0 ] && [ "$(cat "$WORK/b3.out")" = "4" ] && grep -q 'repo-access set #4 no-such-repo' "$WORK/b3.err" \
  && ok "B3 an unknown repo is reported on stderr and the ticket is still created (#4)" || fail "B3 rc=$rc out=$(cat "$WORK/b3.out") err=$(head -2 "$WORK/b3.err")"
node "$HERE/lib/wg-batch.mjs" "$WORK/batch.sqlite" --risk nope "Bad risk${TAB}x" >"$WORK/b3b.out" 2>"$WORK/b3b.err"; rc=$?
[ "$rc" -eq 1 ] && grep -q 'ticket create' "$WORK/b3b.err" && ok "B3 a refused create exits 1 and says so" || fail "B3 bad create rc=$rc: $(head -2 "$WORK/b3b.err")"

echo "== B4: the bare form, {n} in an AC =="
for n in 1 2 3; do
  node "$CLI_JS" --db "$WORK/cli4.sqlite" ticket create -t "T$n" --risk low >/dev/null 2>&1
  node "$CLI_JS" --db "$WORK/cli4.sqlite" ac add "$n" -t "AC$n" >/dev/null 2>&1
  node "$CLI_JS" --db "$WORK/cli4.sqlite" ticket ready "$n" >/dev/null 2>&1
done
node "$HERE/lib/wg-batch.mjs" "$WORK/batch4.sqlite" --risk low --ac 'AC{n}' --ready T1 T2 T3 >"$WORK/b4.out" 2>"$WORK/b4.err"; rc=$?
node --no-warnings "$WORK/dump.mjs" "$WORK/cli4.sqlite" >"$WORK/cli4.dump"
node --no-warnings "$WORK/dump.mjs" "$WORK/batch4.sqlite" >"$WORK/batch4.dump"
[ "$rc" -eq 0 ] && [ "$(tr '\n' ' ' <"$WORK/b4.out")" = "1 2 3 " ] && ok "B4 the batch ran and printed 1 2 3" || fail "B4 rc=$rc out=$(tr '\n' ' ' <"$WORK/b4.out") err=$(head -2 "$WORK/b4.err")"
cmp -s "$WORK/cli4.dump" "$WORK/batch4.dump" && grep -q '"text":"AC3"' "$WORK/batch4.dump" \
  && ok "B4 every table matches row for row, AC{n} became AC1..AC3 ($(wc -l <"$WORK/cli4.dump" | tr -d ' ') rows)" \
  || fail "B4 the databases differ: $(diff "$WORK/cli4.dump" "$WORK/batch4.dump" | head -6 | cut -c1-300 | tr '\n' '|')"

echo "== B5: an intact hash chain, in the CLI's order =="
for d in batch batch4; do
  node "$CLI_JS" --db "$WORK/$d.sqlite" events verify >"$WORK/$d.verify" 2>&1 \
    && ok "B5 $d.sqlite: events verify passes ($(head -1 "$WORK/$d.verify" | cut -c1-60))" \
    || fail "B5 $d.sqlite: events verify: $(head -2 "$WORK/$d.verify" | tr '\n' ' ')"
done
cat >"$WORK/evseq.mjs" <<'JS'
import { DatabaseSync } from "node:sqlite";
// The event log in write order: entity (as the ticket number it names), actor, type.
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const num = new Map(db.prepare("select id, number from tickets").all().map((r) => [r.id, `T${r.number}`]));
for (const e of db.prepare("select entity_type, entity_id, actor_type, actor_id, event_type from work_events order by rowid").all())
  console.log([e.entity_type, num.get(e.entity_id) ?? "-", e.actor_type, e.actor_id, e.event_type].join(" "));
JS
for p in "cli batch" "cli4 batch4"; do
  set -- $p
  node --no-warnings "$WORK/evseq.mjs" "$WORK/$1.sqlite" >"$WORK/$1.seq"
  # B3 wrote more into batch.sqlite after B1: compare the part the CLI sequence made.
  node --no-warnings "$WORK/evseq.mjs" "$WORK/$2.sqlite" >"$WORK/$2.seq.all"
  head -n "$(wc -l <"$WORK/$1.seq")" "$WORK/$2.seq.all" >"$WORK/$2.seq"
  [ -s "$WORK/$1.seq" ] && cmp -s "$WORK/$1.seq" "$WORK/$2.seq" \
    && ok "B5 $2: the same $(wc -l <"$WORK/$1.seq" | tr -d ' ') events in the same order as $1" \
    || fail "B5 $2 event order differs: $(diff "$WORK/$1.seq" "$WORK/$2.seq" | head -4 | tr '\n' '|')"
done

echo "== B6: only a dispatch database in the test's temp dir, only as the operator =="
cksum_of() { if [ -e "$1" ]; then cksum <"$1"; else echo absent; fi; }
refused() { # <what> <db> [env...]: the batch exits 2 and leaves <db> as it was
  local what="$1" db="$2" before rc; shift 2
  before="$(cksum_of "$db")"
  env "$@" node "$HERE/lib/wg-batch.mjs" "$db" --risk low --ac "tests pass" --ready "Stray${TAB}must not land" >"$WORK/b6.out" 2>"$WORK/b6.err"; rc=$?
  [ "$rc" -eq 2 ] && [ "$(cksum_of "$db")" = "$before" ] && [ ! -s "$WORK/b6.out" ] \
    && ok "B6 $what is refused, the file untouched ($(head -1 "$WORK/b6.err" | cut -c1-90))" \
    || fail "B6 $what: rc=$rc, file $before -> $(cksum_of "$db"), out=$(head -1 "$WORK/b6.out") err=$(head -1 "$WORK/b6.err")"
}
# Outside the temp dir: a real, initialised dispatch DB the batch's TMPDIR does not hold.
mkdir -p "$WORK/elsewhere" "$WORK/tmp"
node "$CLI_JS" --db "$WORK/elsewhere/x.sqlite" init >/dev/null
refused "a dispatch database outside \$TMPDIR" "$WORK/elsewhere/x.sqlite" TMPDIR="$WORK/tmp"
node --no-warnings -e 'const{DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1]);d.exec("create table t(x)");d.close()' "$WORK/plain.sqlite"
refused "a SQLite file that is not a dispatch database" "$WORK/plain.sqlite"
: >"$WORK/empty.sqlite"
refused "an empty file" "$WORK/empty.sqlite"
refused "a missing path" "$WORK/missing.sqlite"
[ ! -e "$WORK/missing.sqlite" ] && ok "B6 a missing path is not created" || fail "B6 the batch created $WORK/missing.sqlite"
cp "$WORK/batch4.sqlite" "$WORK/b6-principal.sqlite"
refused "GAFFER_PRINCIPAL_TOKEN set (the CLI would act as that principal)" "$WORK/b6-principal.sqlite" GAFFER_PRINCIPAL_TOKEN=gfp_not_the_operator
node "$HERE/lib/wg-batch.mjs" "$WORK/b6-principal.sqlite" --risk low "Fine${TAB}inside" >"$WORK/b6ok.out" 2>"$WORK/b6ok.err"; rc=$?
[ "$rc" -eq 0 ] && [ "$(cat "$WORK/b6ok.out")" = 4 ] && ok "B6 the same database without the token is written (#4)" || fail "B6 control: rc=$rc $(head -1 "$WORK/b6ok.err")"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "wg-batch-parity: ALL $PASS checks passed"; exit 0; fi
echo "wg-batch-parity: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
