#!/usr/bin/env bash
# =====================================================================
# `gaffer lore`: ratifying lore from the front door, doing what the dashboard's Memory
# view does (README "What's rough": approving lore needed the raw memory CLI with its
# database path typed out).
# ---------------------------------------------------------------------
# A real dashboard on its own data dir, its memory database seeded with drafts; no model.
#   L1  gaffer lore review lists the drafts the dashboard lists, with its fields, and
#       pages (--offset) and filters (--repo) as it does
#   L2  approve / reject change what the dashboard reads; a refused decision exits 1
#   L3  usage errors exit 2; an id the dashboard refuses (422) is refused here too
#   L4  review --json is the page the Memory view reads
#   L5  the factory's MEMORY_DB is the one read and written: a custom MEMORY_DB is
#       honoured; an unbuilt memory CLI is a clear error, not a stack
# Run: bash runner/test/gaffer-lore.test.sh   (bash 3.2 safe)
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
G="$RUNNER_DIR/gaffer"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v curl >/dev/null 2>&1 || { echo "SKIP: curl required"; exit 0; }
[ -f "$ROOT/packages/dispatch/dist/cli/index.js" ] && [ -f "$ROOT/packages/memory/dist/bin/memory.js" ] \
  || { echo "SKIP: build the packages first (pnpm -r build)"; exit 0; }
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
has()  { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/gaffer-lore.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
B="$WORK/b"; mkdir -p "$B" "$WORK/bin"
# GAFFER_TEST_PORT_BASE + 2 (gaffer-plan.test.sh takes +0, dashboard-lifecycle +0/+1), else random.
if [ -n "${GAFFER_TEST_PORT_BASE:-}" ]; then PORT=$(( GAFFER_TEST_PORT_BASE + 2 )); else PORT=$(( 20000 + RANDOM % 20000 )); fi
stop_dash() { local p; p="$(cat "$B/dashboard.pid" 2>/dev/null || true)"; [ -n "$p" ] && kill "$p" 2>/dev/null; true; }
trap 'stop_dash; gaffer_test_rm_work "$WORK"' EXIT

# No model call happens here; the stub is first on PATH and in CLAUDE_BIN all the same.
cp "$ROOT/scripts/ui-regression/stub-claude.sh" "$WORK/bin/claude"
cp "$ROOT/scripts/ui-regression/stub-worker.mjs" "$WORK/bin/stub-worker.mjs"
chmod +x "$WORK/bin/claude"
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN \
  DISPATCH_DB MEMORY_DB DISPATCH_API_TOKEN DRY_RUN MEMORY_CLI_BIN
export PATH="$WORK/bin:$PATH" CLAUDE_BIN="$WORK/bin/claude" CLAUDE_FLAGS="" \
  GAFFER_STRICT_REQUIRE=0 STRICT_MODE=0 NO_COLOR=1 GAFFER_DAILY_BUDGET_USD=5
MEM="$ROOT/packages/memory/dist/bin/memory.js"

# ga <data> <args…>: gaffer against one factory; output in $OUT, exit code in $RC.
ga() { local d="$1"; shift; OUT="$(GAFFER_DATA="$d" bash "$G" "$@" 2>&1 </dev/null)"; RC=$?; }
GAFFER_DATA="$B" bash "$G" wg init >/dev/null 2>&1 || { echo "dispatch init failed"; exit 1; }
MEMORY_DB="$B/memory.sqlite" node "$MEM" init >/dev/null 2>&1 || { echo "memory init failed"; exit 1; }

GAFFER_DATA="$B" DISPATCH_API_PORT="$PORT" bash "$G" dashboard >/dev/null 2>&1
TOK="$(cat "$B/dashboard-token" 2>/dev/null)"
up=0; for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  curl -sf -H "authorization: Bearer $TOK" "http://127.0.0.1:$PORT/api/dashboard" >/dev/null 2>&1 && { up=1; break; }; sleep 0.5
done
[ "$up" = 1 ] && ok "a dashboard on :$PORT" || fail "the dashboard did not come up: $(tail -5 "$B/dashboard.log" 2>/dev/null)"
api() { curl -s -H "authorization: Bearer $TOK" -H 'content-type: application/json' -X "$1" "http://127.0.0.1:$PORT$2" ${3:+--data-binary "$3"}; }

echo "== L1. gaffer lore review lists what the dashboard lists =="
MEMORY_DB="$B/memory.sqlite" node "$MEM" suggest --title "Use the task helpers" --summary "Every list change goes through src/tasks.js." \
  --body "Seeded by the test." --repo taskflow --kind convention --tag ui >/dev/null 2>&1
MEMORY_DB="$B/memory.sqlite" node "$MEM" suggest --title "Archive is append-only" --summary "Never rewrite an archived task." \
  --body "Second seed." --repo taskflow --kind gotcha >/dev/null 2>&1
DASH="$(api GET '/api/memory/lore?status=draft&limit=200')"
ids="$(printf '%s' "$DASH" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const j=JSON.parse(s);console.log((j.lore||[]).map(l=>l.id).join(" "))})')"
ga "$B" lore review
[ "$RC" -eq 0 ] && has "$OUT" "2 lore draft(s) awaiting review" && ok "L1: two drafts listed" || fail "L1: rc=$RC out=$OUT"
n=0; for id in $ids; do has "$OUT" "$id" && n=$((n + 1)); done
[ "$n" = 2 ] && ok "L1: the same ids the dashboard's Memory view reads" || fail "L1: ids '$ids' not all in: $OUT"
has "$OUT" "[convention] Use the task helpers" && has "$OUT" "Every list change goes through src/tasks.js." \
  && has "$OUT" "repos taskflow · tags ui" && ok "L1: kind, title, summary, repos, tags as a Memory row shows them" || fail "L1: fields: $OUT"
ga "$B" lore
has "$OUT" "2 lore draft(s)" && ok "L1: bare 'gaffer lore' is review" || fail "L1: bare lore: $OUT"
ga "$B" lore review --repo nosuch
has "$OUT" "No lore drafts are waiting" && ok "L1: --repo filters" || fail "L1: --repo: $OUT"
ID1="${ids%% *}"; ID2="${ids##* }"
# Paging: --offset 1 is the dashboard's ?offset=1 page (the second draft only).
P2ID="$(api GET '/api/memory/lore?status=draft&limit=200&offset=1' | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const j=JSON.parse(s);console.log((j.lore||[]).map(l=>l.id).join(" "))})')"
ga "$B" lore review --offset 1
[ "$RC" -eq 0 ] && [ -n "$P2ID" ] && has "$OUT" "$P2ID" && ! has "$OUT" "${ids%% *}  " \
  && ok "L1: --offset 1 lists the dashboard's second page" || fail "L1: --offset 1 ('$P2ID') rc=$RC out=$OUT"
ga "$B" lore show "$ID1"
[ "$RC" -eq 0 ] && has "$OUT" "$ID1" && has "$OUT" "draft" && ok "L1: show prints the record" || fail "L1: show rc=$RC out=$OUT"

echo "== L2. approve / reject change what the dashboard reads =="
ga "$B" lore approve "$ID1"
[ "$RC" -eq 0 ] && has "$OUT" "approved $ID1" && ok "L2: approve (exit 0)" || fail "L2: approve rc=$RC out=$OUT"
st="$(api GET '/api/memory/lore?limit=200' | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const j=JSON.parse(s);const l=(j.lore||[]).find(x=>x.id===process.argv[1]);console.log(l?l.status:"gone")})' "$ID1")"
[ "$st" = active ] && ok "L2: the dashboard now reads it as active" || fail "L2: dashboard status '$st'"
ga "$B" lore approve "$ID1"
[ "$RC" -eq 1 ] && has "$OUT" "not a pending draft" && ok "L2: approving it again is refused (exit 1), as the dashboard's 409" || fail "L2: re-approve rc=$RC out=$OUT"
ga "$B" lore reject "$ID2" --reason "too narrow"
[ "$RC" -eq 0 ] && has "$OUT" "rejected $ID2" && ok "L2: reject --reason (exit 0)" || fail "L2: reject rc=$RC out=$OUT"
st="$(api GET '/api/memory/lore?limit=200' | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const j=JSON.parse(s);const l=(j.lore||[]).find(x=>x.id===process.argv[1]);console.log(l?l.status:"gone")})' "$ID2")"
[ "$st" = gone ] && ok "L2: the dashboard no longer lists the rejected draft" || fail "L2: rejected still '$st'"
MEMORY_DB="$B/memory.sqlite" node "$MEM" suggest --title "Third" --summary "Approved from the dashboard." --body "x" --repo taskflow >/dev/null 2>&1
ID3="$(api GET '/api/memory/lore?status=draft&limit=200' | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const j=JSON.parse(s);console.log((j.lore||[])[0]?.id||"")})')"
api POST "/api/memory/lore/$ID3/approve" >/dev/null
ga "$B" lore review
has "$OUT" "No lore drafts are waiting" && ok "L2: a draft approved in the dashboard leaves gaffer lore review" || fail "L2: after dashboard approve: $OUT"

echo "== L3. usage errors exit 2 =="
for args in "nosuch" "approve" "approve --reason x" "reject $ID1 --bogus" "approve $ID1 --reason x" "review --bogus" "review --offset x"; do
  # shellcheck disable=SC2086 # word-split on purpose: each case is several arguments
  ga "$B" lore $args
  [ "$RC" -eq 2 ] && has "$OUT" "usage: gaffer lore" && ok "L3: lore $args → exit 2 with usage" || fail "L3: lore $args rc=$RC out=$OUT"
done

for args in "review --offset" "approve abc;rm" "reject ABCDEFGH" "show ../x"; do
  # shellcheck disable=SC2086 # word-split on purpose: each case is several arguments
  ga "$B" lore $args
  [ "$RC" -eq 2 ] && has "$OUT" "usage: gaffer lore" && ok "L3: lore $args → exit 2, nothing run (a malformed id is the dashboard's 422)" || fail "L3: lore $args rc=$RC out=$OUT"
done

echo "== L4. review --json is the page the Memory view reads =="
MEMORY_DB="$B/memory.sqlite" node "$MEM" suggest --title "Fourth" --summary "json" --body "x" --repo taskflow >/dev/null 2>&1
ga "$B" lore review --json
J="$(printf '%s' "$OUT" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const j=JSON.parse(s);console.log(j.total+" "+j.items.map(i=>i.id).join(","))}catch(e){console.log("bad "+e.message)}})')"
D="$(api GET '/api/memory/lore?status=draft&limit=200' | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const j=JSON.parse(s);console.log(j.total+" "+(j.lore||[]).map(i=>i.id).join(","))})')"
[ "$RC" -eq 0 ] && [ "$J" = "$D" ] && [ "${J%% *}" = 1 ] && ok "L4: the same total and ids as GET /api/memory/lore" || fail "L4: --json '$J' vs dashboard '$D' rc=$RC"

echo "== L5. the factory's MEMORY_DB, and an unbuilt memory CLI =="
CUSTOM="$WORK/elsewhere/lore.sqlite"; mkdir -p "$WORK/elsewhere"
MEMORY_DB="$CUSTOM" node "$MEM" suggest --title "Only in the custom db" --summary "custom" --body "x" --repo taskflow >/dev/null 2>&1
OUT="$(GAFFER_DATA="$B" MEMORY_DB="$CUSTOM" bash "$G" lore review 2>&1 </dev/null)"; RC=$?
[ "$RC" -eq 0 ] && has "$OUT" "Only in the custom db" && ! has "$OUT" "Fourth" \
  && ok "L5: a custom MEMORY_DB is the one read" || fail "L5: custom MEMORY_DB rc=$RC out=$OUT"
OUT="$(GAFFER_DATA="$B" MEMORY_CLI_BIN="$WORK/absent/memory.js" bash "$G" lore review 2>&1 </dev/null)"; RC=$?
[ "$RC" -eq 1 ] && has "$OUT" "memory CLI is not built" && ! has "$OUT" "    at " \
  && ok "L5: an unbuilt memory CLI: exit 1 with the fix, no stack" || fail "L5: unbuilt CLI rc=$RC out=$OUT"

stop_dash
echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "gaffer-lore: ALL $PASS checks passed"
  exit 0
fi
echo "gaffer-lore: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
