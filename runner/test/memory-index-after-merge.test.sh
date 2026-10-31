#!/usr/bin/env bash
# =====================================================================
# MEMORY ACCURACY AFTER OVERLAPPING MERGES — the file cards describe the MERGED commit.
# ---------------------------------------------------------------------
# Third external review, HIGH memory accuracy. Ticket A renames src/archive.ts to
# src/ledger.ts; ticket B, forked from the same main, changes a function in the
# original file (settle → settleWithFees). Git merges both cleanly and the changed
# function lands in src/ledger.ts. The card refresh used to read each DELIVERY
# BRANCH's own diff and tree, so B's refresh re-carded src/archive.ts (a path that no
# longer exists on main) and memory answered "settleWithFees" with archive.ts only,
# while recording main as fully indexed. Proven against the REAL tick.sh merge lane,
# the real dispatch and memory CLIs and a stub delivery agent:
#   • both tickets deliver from the same main and land through the merge lane, cleanly;
#   • main's tree has src/ledger.ts with settleWithFees and no src/archive.ts;
#   • `memory card search settleWithFees` returns src/ledger.ts and never archive.ts;
#   • no card exists for src/archive.ts; every card's content_hash matches main's blob;
#   • the card watermark is main's merged commit, and the log says it was verified;
#   • the same overlap (ledger.ts → book.ts + settleWithFees → settleNet) landed through
#     the dashboard Merge path (bin/merge-ticket.mjs) leaves the same accurate index.
# Run: bash runner/test/memory-index-after-merge.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
CLI_JS="$ROOT/packages/dispatch/dist/cli/index.js"
MEM_JS="$ROOT/packages/memory/dist/bin/memory.js"
[ -f "$CLI_JS" ] && [ -f "$MEM_JS" ] || { echo "SKIP: dispatch/memory CLI not built"; exit 0; }
[ -f "$ROOT/packages/crew/dist/runtime/context/renderPromptCli.js" ] || { echo "SKIP: crew not built"; exit 0; }

PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/mem-index-merge.XXXXXX")"; WORK="$(cd "$WORK" && pwd -P)"
[ "${KEEP:-0}" = 1 ] || trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/data" "$WORK/bin" "$WORK/calls"; CALLS="$WORK/calls"

R="$WORK/repo"; mkdir -p "$R/src" "$R/test"
( cd "$R" && git init -q -b main
  printf '{ "name": "r", "version": "0.1.0", "private": true, "type": "module", "scripts": { "test": "node --test", "lint": "node -e 0" } }\n' > package.json
  # A file big enough that git's rename detection pairs it across both edits.
  {
    printf '// The archive: settles and records closed accounts.\n'
    for i in 1 2 3 4 5 6 7 8 9 10 11 12; do printf 'export const RATE_%s = %s;\n' "$i" "$i"; done
    printf 'export function settle(amount) {\n  return amount;\n}\n'
    printf 'export function record(entry) {\n  return { entry };\n}\n'
  } > src/archive.ts
  printf 'import test from "node:test"; import assert from "node:assert/strict";\ntest("ok", () => { assert.equal(1, 1); });\n' > test/ok.test.js
  git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init )

# Stub delivery agent. Ticket "Rename archive" moves the file; ticket "Fees" changes
# settle() in the ORIGINAL path (its branch forked before the rename merged).
cat > "$WORK/bin/claude" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
CALLS="__CALLS__"
n="$(ls -1 "$CALLS" 2>/dev/null | wc -l | tr -d ' ')"; n=$((n + 1)); D="$CALLS/$(printf '%03d' "$n")"; mkdir -p "$D"
prompt=""; prev=""; for a in "$@"; do [ "$prev" = "-p" ] && prompt="$a"; prev="$a"; done; printf '%s' "$prompt" > "$D/prompt"
if [ -e .git ] && [ -f src/ledger.ts ] && [ ! -f src/archive.ts ]; then
  case "$prompt" in
    *"Move ledger to book"*)
      echo rename2 > "$D/kind"
      git mv src/ledger.ts src/book.ts
      git -c user.email=s@s -c user.name=s commit -qm "refactor: rename ledger to book" >/dev/null 2>&1 ;;
    *"Net settlement"*)
      echo net > "$D/kind"
      sed 's|^export function settleWithFees(amount, fee = 1) {|export function settleNet(amount, fee = 1) {|' \
        src/ledger.ts > src/l.tmp && mv src/l.tmp src/ledger.ts
      git -c user.email=s@s -c user.name=s add -A >/dev/null
      git -c user.email=s@s -c user.name=s commit -qm "feat: settle net" >/dev/null 2>&1 ;;
  esac
  printf '{"type":"result","subtype":"success","is_error":false,"result":"done.\\n\\nSmallest-change note: one edit.","total_cost_usd":0.02,"num_turns":1}\n'; exit 0
fi
if [ -e .git ] && [ -f src/archive.ts ]; then
  case "$prompt" in
    *"Rename archive"*)
      echo rename > "$D/kind"
      git mv src/archive.ts src/ledger.ts
      sed 's|^// The archive:|// The ledger:|' src/ledger.ts > src/l.tmp && mv src/l.tmp src/ledger.ts
      git -c user.email=s@s -c user.name=s add -A >/dev/null
      git -c user.email=s@s -c user.name=s commit -qm "refactor: rename archive to ledger" >/dev/null 2>&1 ;;
    *"Fees"*)
      echo fees > "$D/kind"
      sed 's|^export function settle(amount) {|export function settleWithFees(amount, fee = 1) {|; s|^  return amount;|  return amount - fee;|' \
        src/archive.ts > src/a.tmp && mv src/a.tmp src/archive.ts
      git -c user.email=s@s -c user.name=s add -A >/dev/null
      git -c user.email=s@s -c user.name=s commit -qm "feat: settle with fees" >/dev/null 2>&1 ;;
  esac
  printf '{"type":"result","subtype":"success","is_error":false,"result":"done.\\n\\nSmallest-change note: one edit.","total_cost_usd":0.02,"num_turns":1}\n'; exit 0
fi
echo other > "$D/kind"; printf '{"type":"result","subtype":"success","is_error":false,"result":"ok"}\n'
STUB
sed -i.bak "s|__CALLS__|$CALLS|" "$WORK/bin/claude" && rm -f "$WORK/bin/claude.bak"; chmod +x "$WORK/bin/claude"

export GAFFER_DATA="$WORK/data" CLAUDE_BIN="$WORK/bin/claude" CLAUDE_FLAGS="" \
       GAFFER_MAX_TURNS=3 GAFFER_TICK_TIMEOUT=60 GAFFER_CARD_MODEL=stub GAFFER_PLAN_MODEL=stub GAFFER_IMPL_MODEL=stub \
       REVIEW_MODE=human DRY_RUN=0 GAFFER_MAINTENANCE=0 GAFFER_STRICT_REQUIRE=0 GAFFER_SECURITY_REVIEW=0 GAFFER_TESTING=0 \
       MAX_OPEN_AGENT_BRANCHES_PER_REPO=10 MAX_IN_REVIEW_PER_REPO=10
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
wg init >/dev/null 2>&1; lg init >/dev/null 2>&1
wg repo add -n repo --path "$R" --branch main --stack node --test "npm test" --lint "npm run lint" >/dev/null 2>&1

# Onboard-shaped cards: one per source file, with a model summary, watermark at main.
CANON="$(lg repo-canonical --repo-root "$R" 2>/dev/null)"
lg card upsert --canonical "$CANON" --repo repo --repo-root "$R" --path src/archive.ts --source onboard \
  --tldr "Settles and records closed accounts" --role-primary domain >/dev/null 2>&1
lg card sync --canonical "$CANON" --repo repo --commit "$(git -C "$R" rev-parse main)" >/dev/null 2>&1

q(){ (cd "$ROOT/packages/memory" && node -e '
  const D=require("better-sqlite3"); const db=new D(process.argv[1],{readonly:true});
  for (const r of db.prepare(process.argv[2]).raw().all()) console.log(r.map(v=>v===null?"":String(v)).join("|"));
  db.close();' "$MEMORY_DB" "$1" 2>/dev/null); }
run_tick() { ( cd "$RUNNER_DIR" && bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep '^TICK_RESULT=' ; }
st() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.status'; }
new_ticket() { local n; n="$(wg ticket create -t "$1" -d "$2" --risk low 2>/dev/null | jget 'd.ticket.number')"; wg ac add "$n" -t "change made" >/dev/null 2>&1; wg ticket repo-access set "$n" repo --access write --relation confirmed >/dev/null 2>&1; printf '%s' "$n"; }
LOGF="$GAFFER_DATA/factory.log"

echo "== both tickets deliver from the same main =="
A="$(new_ticket "Rename archive to ledger" "move src/archive.ts to src/ledger.ts")"; wg ticket ready "$A" >/dev/null 2>&1
B="$(new_ticket "Fees on settle" "settle() charges a fee: settleWithFees")"; wg ticket ready "$B" >/dev/null 2>&1
AUTO_MERGE=0 run_tick >/dev/null; AUTO_MERGE=0 run_tick >/dev/null
[ "$(st "$A")" = "in_review" ] && [ "$(st "$B")" = "in_review" ] && ok "#$A and #$B delivered → in_review" \
  || fail "delivery: #$A=$(st "$A") #$B=$(st "$B")"
wg review approve "$A" --reviewer human1 >/dev/null 2>&1; wg review approve "$B" --reviewer human1 >/dev/null 2>&1

echo "== the merge lane lands both =="
for _ in 1 2; do
  GAFFER_MODE=autonomous AUTO_MERGE=1 DISPATCH_ALLOW_AGENT_APPROVE=1 MERGE_ON_AGENT_REVIEW=1 run_tick >/dev/null
  [ "$(st "$A")" = "done" ] && [ "$(st "$B")" = "done" ] && break
done
[ "$(st "$A")" = "done" ] && [ "$(st "$B")" = "done" ] && ok "both merged cleanly → done" \
  || fail "merge: #$A=$(st "$A") #$B=$(st "$B"): $(grep 'MERGE' "$LOGF" | tail -4 | tr '\n' '|' | cut -c1-400)"
MAIN="$(git -C "$R" rev-parse main)"
TREE="$(git -C "$R" ls-tree -r --name-only main)"
LEDGER="$(git -C "$R" show main:src/ledger.ts 2>/dev/null)"
case "$TREE" in *src/archive.ts*) fail "main still has src/archive.ts" ;; *) ok "main has no src/archive.ts" ;; esac
case "$LEDGER" in *"function settleWithFees"*) ok "git carried B's change into src/ledger.ts" ;; *) fail "src/ledger.ts on main lacks settleWithFees" ;; esac

echo "== memory answers from the merged commit =="
SEARCH="$(lg card search --canonical "$CANON" --repo repo --query settleWithFees --json 2>/dev/null)"
PATHS="$(printf '%s' "$SEARCH" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).cards.map(c=>c.path).join(","))}catch{console.log("")}})')"
case ",$PATHS," in *,src/ledger.ts,*) ok "search settleWithFees → src/ledger.ts" ;; *) fail "search settleWithFees did not return src/ledger.ts (got '$PATHS')" ;; esac
case ",$PATHS," in *,src/archive.ts,*) fail "search settleWithFees returned the nonexistent src/archive.ts ('$PATHS')" ;; *) ok "search never returns the nonexistent src/archive.ts" ;; esac
[ -z "$(q "SELECT 1 FROM file_card WHERE path='src/archive.ts'")" ] && ok "no card is stored for src/archive.ts" \
  || fail "a card for src/archive.ts survived the merges"
# Every stored card matches main's blob byte for byte (sha256 of the file content).
BAD=""
while IFS='|' read -r path hash; do
  [ -n "$path" ] || continue
  want="$(git -C "$R" show "main:$path" 2>/dev/null | node -e 'const c=require("crypto");let b=[];process.stdin.on("data",d=>b.push(d)).on("end",()=>console.log(c.createHash("sha256").update(Buffer.concat(b).toString("utf8"),"utf8").digest("hex")))')"
  git -C "$R" cat-file -e "main:$path" 2>/dev/null || { BAD="$BAD $path(missing)"; continue; }
  [ "$want" = "$hash" ] || BAD="$BAD $path(hash)"
done <<<"$(q "SELECT path, content_hash FROM file_card")"
[ -z "$BAD" ] && ok "every card's path exists on main and its content hash matches main's blob" || fail "cards out of step with main:$BAD"
[ "$(q "SELECT tldr FROM file_card WHERE path='src/ledger.ts'")" = "Settles and records closed accounts" ] \
  && ok "the rename carried the card's summary to src/ledger.ts" || fail "src/ledger.ts lost the onboard summary: '$(q "SELECT tldr FROM file_card WHERE path='src/ledger.ts'")'"
[ "$(q "SELECT synced_commit FROM repo_sync LIMIT 1")" = "$MAIN" ] && ok "watermark = main's merged commit" \
  || fail "watermark $(q "SELECT synced_commit FROM repo_sync LIMIT 1") != main $MAIN"
grep -q "verified .* against ${MAIN:0:8}; watermark → ${MAIN:0:8}" "$LOGF" && ok "the log records the verification against the merged commit" \
  || fail "no verification line: $(grep 'cards:' "$LOGF" | tail -3 | tr '\n' '|' | cut -c1-400)"

echo "== the same overlap through the dashboard Merge path (bin/merge-ticket.mjs) =="
C="$(new_ticket "Move ledger to book" "move src/ledger.ts to src/book.ts")"; wg ticket ready "$C" >/dev/null 2>&1
E="$(new_ticket "Net settlement" "settleWithFees becomes settleNet")"; wg ticket ready "$E" >/dev/null 2>&1
AUTO_MERGE=0 run_tick >/dev/null; AUTO_MERGE=0 run_tick >/dev/null
wg review approve "$C" --reviewer human1 >/dev/null 2>&1; wg review approve "$E" --reviewer human1 >/dev/null 2>&1
for t in "$C" "$E"; do
  node "$RUNNER_DIR/bin/merge-ticket.mjs" --ticket "$t" >"$WORK/merge-$t.json" 2>"$WORK/merge-$t.err" || true
done
[ "$(st "$C")" = "done" ] && [ "$(st "$E")" = "done" ] && ok "#$C and #$E merged through merge-ticket.mjs → done" \
  || fail "dashboard merge: #$C=$(st "$C") #$E=$(st "$E"): $(tail -c 400 "$WORK/merge-$E.err")"
MAIN2="$(git -C "$R" rev-parse main)"
case "$(git -C "$R" show main:src/book.ts 2>/dev/null)" in *"function settleNet"*) ok "git carried #$E's change into src/book.ts" ;; *) fail "src/book.ts on main lacks settleNet" ;; esac
SEARCH2="$(lg card search --canonical "$CANON" --repo repo --query settleNet --json 2>/dev/null)"
PATHS2="$(printf '%s' "$SEARCH2" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).cards.map(c=>c.path).join(","))}catch{console.log("")}})')"
[ "$PATHS2" = "src/book.ts" ] && ok "search settleNet → src/book.ts only" || fail "search settleNet returned '$PATHS2' (want src/book.ts)"
[ -z "$(q "SELECT 1 FROM file_card WHERE path IN ('src/ledger.ts','src/archive.ts')")" ] && ok "no card survives for a path main no longer has" \
  || fail "stale cards: $(q "SELECT path FROM file_card" | tr '\n' ' ')"
[ "$(q "SELECT synced_commit FROM repo_sync LIMIT 1")" = "$MAIN2" ] && ok "watermark = main's merged commit after the dashboard merges" \
  || fail "watermark $(q "SELECT synced_commit FROM repo_sync LIMIT 1") != main $MAIN2"
grep -q "card-refresh: card verification: .* against ${MAIN2:0:8}" "$WORK/merge-$E.err" \
  && ok "merge-ticket verified the cards against the merged commit before the watermark" \
  || fail "no verification line from merge-ticket: $(grep 'card-refresh' "$WORK/merge-$E.err" | tail -3 | tr '\n' '|' | cut -c1-400)"

echo
echo "memory-index-after-merge: $PASS passed, ${#FAILURES[@]} failed"
[ "${#FAILURES[@]}" -eq 0 ]
