#!/usr/bin/env bash
# =====================================================================
# BROWNFIELD EPIC -> FEATURE `building`, end to end on the live path.
# ---------------------------------------------------------------------
# runner/bin/epic-feature.mjs worked when run by hand, but nothing called it: a
# brownfield epic confirmed in the dashboard (POST /epics) never moved the memory
# feature ledger. The REAL dispatch API now spawns DISPATCH_EPIC_FEATURE_CMD (the
# command `gaffer dashboard` exports) when every ticket of the new epic targets ONE
# existing registered repo. This drives exactly that: the built dispatch API, a
# registered repo, POST /epics, the REAL epic-feature.mjs and the REAL memory CLI,
# then reads the feature row back from the memory DB.
#   1. a brownfield epic -> a `building` feature with the epic ref as provenance
#   2. a greenfield epic (repo not registered) -> no feature row
#   3. an epic with NO description on an existing backlog feature -> building, and the
#      hand-written backlog summary survives (a blank summary used to wipe it)
#   4. an epic whose name matches an already SHIPPED feature -> stays shipped, and its
#      summary + merge/PR provenance are untouched (they used to be overwritten)
#
# Hermetic: temp DBs, a loopback port, no model calls. SKIPs when the dispatch or
# memory dist is not built.
# Run: bash runner/test/epic-feature-live.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
API_JS="$ROOT/packages/dispatch/dist/api/bin.js"
CLI_JS="$ROOT/packages/dispatch/dist/cli/index.js"
MEM_JS="$ROOT/packages/memory/dist/bin/memory.js"
for f in "$API_JS" "$CLI_JS" "$MEM_JS"; do
  [ -f "$f" ] || { echo "SKIP: not built ($f)"; exit 0; }
done
command -v curl >/dev/null 2>&1 || { echo "SKIP: curl required"; exit 0; }

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/epic-feature-live.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
API_PID=""
cleanup() { [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null; gaffer_test_rm_work "$WORK"; }
trap cleanup EXIT

export GAFFER_DATA="$WORK/data"; mkdir -p "$GAFFER_DATA"
export DISPATCH_DB="$WORK/dispatch.sqlite" MEMORY_DB="$WORK/memory.sqlite"
export MEMORY_CLI_BIN="$MEM_JS"
REPO="$WORK/taskapi"; mkdir -p "$REPO"
( cd "$REPO" && git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init )
# Only `init` creates a database (exploratory finding cli-wg/F-09).
node "$CLI_JS" --db "$DISPATCH_DB" init >/dev/null 2>&1 || { echo "FAIL: dispatch init"; exit 1; }
node "$CLI_JS" --db "$DISPATCH_DB" repo add --name taskapi --path "$REPO" >/dev/null 2>&1 \
  || { echo "FAIL: could not register the repo"; exit 1; }

PORT="$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
TOK="test-token-$$"
# The command exactly as `runner/gaffer dashboard` builds it (JSON argv).
EPIC_CMD="$(node -e 'console.log(JSON.stringify(["node", process.argv[1]]))' "$RUNNER_DIR/bin/epic-feature.mjs")"
DISPATCH_API_TOKEN="$TOK" DISPATCH_EPIC_FEATURE_CMD="$EPIC_CMD" \
  node "$API_JS" --db "$DISPATCH_DB" --port "$PORT" >"$WORK/api.log" 2>&1 &
API_PID=$!
curl -s --retry 30 --retry-connrefused --retry-delay 1 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 \
  || { echo "FAIL: dispatch API did not start"; cat "$WORK/api.log"; exit 1; }

post_epic() {
  curl -s -o "$WORK/resp.json" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/epics" \
    -H "Authorization: Bearer $TOK" -H 'content-type: application/json' -d "$1"
}
features() { MEMORY_DB="$MEMORY_DB" node "$MEM_JS" features "$1" 2>/dev/null; }
wait_feature() { # <repo> <needle>
  local i=0
  while [ "$i" -lt 60 ]; do
    grep -q "$2" <<<"$(features "$1")" && return 0
    i=$((i+1)); sleep 0.25
  done
  return 1
}

echo "== 1. brownfield epic -> feature building =="
CODE="$(post_epic '{"epic":{"name":"Streaks","description":"Daily streaks"},"tickets":[{"title":"streak model","repo":"taskapi","acceptanceCriteria":["stores streaks"]},{"title":"streak api","repo":"taskapi","acceptanceCriteria":["GET /streaks"],"dependsOn":[0]}]}')"
[ "$CODE" = "201" ] && ok "POST /epics created the brownfield epic (201)" || fail "POST /epics returned $CODE: $(cat "$WORK/resp.json")"
EPIC_ID="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).epic_node_id||"")' "$WORK/resp.json" 2>/dev/null)"
if wait_feature taskapi "Streaks"; then
  ok "the memory ledger has the epic's feature"
else
  fail "no feature row for the brownfield epic (api log: $(tail -5 "$WORK/api.log" | tr '\n' '|'))"
fi
FOUT="$(features taskapi)"
grep -q "\[building\] Streaks" <<<"$FOUT" && ok "the feature is BUILDING" || fail "feature not building: $FOUT"
[ -n "$EPIC_ID" ] && grep -q "provenance: $EPIC_ID" <<<"$FOUT" \
  && ok "the epic ref is the feature's provenance" || fail "provenance missing (epic $EPIC_ID): $FOUT"

echo "== 2. greenfield epic -> no feature row =="
CODE="$(post_epic '{"epic":{"name":"Newapp"},"tickets":[{"title":"page","repo":"newapp","acceptanceCriteria":["renders"]}]}')"
[ "$CODE" = "201" ] && ok "POST /epics created the greenfield epic (201)" || fail "greenfield POST /epics returned $CODE"
sleep 1.5
grep -q "Newapp" <<<"$(features newapp)" && fail "a greenfield epic wrote a feature row" || ok "a greenfield epic writes no feature row"

epic_id_of_resp() {
  node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).epic_node_id||"")' "$WORK/resp.json" 2>/dev/null
}
# Wait until the hook run for epic <id> has finished (its run log carries the JSON
# result line naming the epic), so "nothing changed" is asserted AFTER the hook ran.
wait_hook() { # <epic id>
  local i=0
  while [ "$i" -lt 60 ]; do
    grep -lq "\"epic\":\"$1\"" "$GAFFER_DATA"/runs/*.log 2>/dev/null && return 0
    i=$((i+1)); sleep 0.25
  done
  return 1
}
mem() { MEMORY_DB="$MEMORY_DB" node "$MEM_JS" "$@" >/dev/null 2>&1; }

echo "== 3. epic with no description on a backlog feature keeps its summary =="
mem feature add taskapi --name Habits --summary "Precious hand-written summary" --provenance onboard \
  || fail "could not seed the backlog feature"
CODE="$(post_epic '{"epic":{"name":"Habits"},"tickets":[{"title":"habit model","repo":"taskapi","acceptanceCriteria":["stores habits"]}]}')"
[ "$CODE" = "201" ] && ok "POST /epics created the description-less epic (201)" || fail "POST /epics returned $CODE: $(cat "$WORK/resp.json")"
H_EPIC="$(epic_id_of_resp)"
wait_feature taskapi "\[building\] Habits" && ok "the backlog feature advanced to BUILDING" \
  || fail "Habits not building: $(features taskapi)"
FOUT="$(features taskapi)"
HBLOCK="$(grep -A2 "\] Habits" <<<"$FOUT")"
grep -q "Precious hand-written summary" <<<"$HBLOCK" \
  && ok "the backlog summary survived an epic with no description" \
  || fail "the backlog summary was wiped: $HBLOCK"
[ -n "$H_EPIC" ] && grep -q "provenance: $H_EPIC" <<<"$HBLOCK" \
  && ok "the advancing epic is the feature's provenance" || fail "provenance not the epic ($H_EPIC): $HBLOCK"

echo "== 4. epic named like a SHIPPED feature leaves it untouched =="
mem feature add taskapi --name Login --summary "Shipped login" --status shipped --provenance pr-42 \
  || fail "could not seed the shipped feature"
CODE="$(post_epic '{"epic":{"name":"login","description":"redo"},"tickets":[{"title":"login page","repo":"taskapi","acceptanceCriteria":["renders"]}]}')"
[ "$CODE" = "201" ] && ok "POST /epics created the epic named like a shipped feature (201)" || fail "POST /epics returned $CODE: $(cat "$WORK/resp.json")"
L_EPIC="$(epic_id_of_resp)"
[ -n "$L_EPIC" ] && wait_hook "$L_EPIC" && ok "the feature hook ran for the epic" \
  || fail "the feature hook never ran for epic '$L_EPIC' (runs: $(ls "$GAFFER_DATA/runs" 2>/dev/null | tr '\n' ' '))"
FOUT="$(features taskapi)"
LBLOCK="$(grep -i -A2 "\] Login" <<<"$FOUT")"
grep -q "\[shipped\] Login" <<<"$LBLOCK" && ok "the shipped feature stays SHIPPED" || fail "Login not shipped: $LBLOCK"
grep -q "Shipped login" <<<"$LBLOCK" && ! grep -q "redo" <<<"$LBLOCK" \
  && ok "the shipped summary is untouched" || fail "the shipped summary was overwritten: $LBLOCK"
grep -q "provenance: pr-42" <<<"$LBLOCK" \
  && ok "the shipped merge/PR provenance is untouched" || fail "the shipped provenance was overwritten: $LBLOCK"
[ "$(grep -ci "\] login" <<<"$FOUT")" = "1" ] && ok "still ONE Login row" || fail "duplicate Login rows: $FOUT"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS ($PASS checks)"; exit 0
else
  printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
fi
