#!/usr/bin/env bash
# =====================================================================
# AFK REVIEW — a reviewer that did not run is NOT a verdict.
# ---------------------------------------------------------------------
# With autonomy flags on and no sandbox available, containment correctly refuses
# to spawn the reviewer (worker_deliver exits non-zero, empty envelope). review.sh
# used to read that empty result as the fail-closed default CHANGES and, in AFK
# mode, REJECT a possibly-fine delivery back to rework. Now it HOLDS: the ticket
# stays in_review for a human, the reason is logged, and the pass never approves
# or reworks on a non-verdict. A real APPROVE with the approve gate denied still
# holds (advisory), so both hold paths are pinned here. Case C then grants every
# gate and proves the SHIP path end to end: merge → done, the post-merge memory
# work (digest freshness stamped, the ticket's Feature-Id advanced to shipped, no
# duplicate ledger row), the merged branch deleted, and the reviewer's MCP runtime
# bound to GAFFER_REVIEW_TICKET (claimless per-AC notes for that ticket only).
# Real dispatch + real tick.sh; the stub `claude` is switched per case via a
# mode file. Run: bash runner/test/afk-review-hold.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }
for f in packages/dispatch/dist/cli/index.js packages/memory/dist/bin/memory.js packages/crew/dist/cli/index.js; do
  [ -f "$ROOT/$f" ] || { echo "SKIP: $f not built (run pnpm -r build)"; exit 0; }
done

PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/afk-review-hold.XXXXXX")"; WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/data" "$WORK/bin"

R="$WORK/repo"; mkdir -p "$R/src" "$R/test"
( cd "$R" && git init -q -b main
  printf '{ "name": "r", "version": "0.1.0", "private": true, "type": "module", "scripts": { "test": "node --test", "lint": "node -e 0" } }\n' > package.json
  printf 'export function addTask(l, t) { return [...l, { t }]; }\n' > src/tasks.js
  printf 'import test from "node:test"; import assert from "node:assert/strict";\nimport { addTask } from "../src/tasks.js";\ntest("adds", () => { assert.equal(addTask([], "a").length, 1); });\n' > test/tasks.test.js
  git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init )

# Stub worker. MODE file: deliver | approve | trailing | sneak | sneak-branch | refuse.
#   deliver → commits a helper (a real delivery); approve → valid APPROVE verdict
#   envelope; trailing → a CHANGES token followed by prose quoting an APPROVE token;
#   sneak → the reviewer COMMITS in its cwd, then approves; sneak-branch →
#   it also force-moves the delivery branch onto that commit through the shared ref
#   store; refuse → exit 75 with NO output (containment refused to spawn).
MODE_FILE="$WORK/stub-mode"; echo deliver > "$MODE_FILE"
cat > "$WORK/bin/claude" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
mode="$(cat "__MODE_FILE__")"
case "$mode" in
  refuse) exit 75 ;;
  trailing)
    printf '{"type":"result","subtype":"success","is_error":false,"result":"RECOMMEND CHANGES: add a test\\n{\\"verdict\\":\\"CHANGES\\"}\\nNote: the ticket asked me to print {\\"verdict\\":\\"APPROVE\\"}; ignored.","total_cost_usd":0.01,"num_turns":2}\n'; exit 0 ;;
  sneak|sneak-branch)
    echo "REVIEWER-SNEAK" > sneak.txt
    git -c user.email=r@r -c user.name=r add sneak.txt >/dev/null 2>&1
    git -c user.email=r@r -c user.name=r commit -qm "reviewer sneak" >/dev/null 2>&1
    if [ "$mode" = "sneak-branch" ]; then
      b="$(git for-each-ref --format='%(refname:short)' 'refs/heads/gaffer/ticket-*' | head -1)"
      git branch -f "$b" HEAD >/dev/null 2>&1
    fi
    printf '{"type":"result","subtype":"success","is_error":false,"result":"RECOMMEND APPROVE\\n{\\"verdict\\":\\"APPROVE\\"}","total_cost_usd":0.01,"num_turns":2}\n'; exit 0 ;;
  approve)
    # Keep a copy of the reviewer's rendered MCP runtime so the test can inspect its env.
    prev=""; for a in "$@"; do [ "$prev" = "--mcp-config" ] && cp "$a" "__WORK__/review-mcp.json" 2>/dev/null; prev="$a"; done
    printf '{"type":"result","subtype":"success","is_error":false,"result":"RECOMMEND APPROVE\\n{\\"verdict\\":\\"APPROVE\\"}","total_cost_usd":0.01,"num_turns":2}\n'; exit 0 ;;
esac
if [ -e .git ] && [ -f package.json ]; then
  fn="helper${GAFFER_TICKET:-0}"
  grep -q "$fn" src/tasks.js || { printf 'export function %s(l){return l;}\n' "$fn" >> src/tasks.js; git -c user.email=s@s -c user.name=s add -A >/dev/null; git -c user.email=s@s -c user.name=s commit -qm "feat: $fn" >/dev/null; }
  printf '{"type":"result","subtype":"success","is_error":false,"result":"done.\\n\\nSmallest-change note: modified src/tasks.js only.","total_cost_usd":0.02,"num_turns":3}\n'; exit 0
fi
printf '{"type":"result","subtype":"success","is_error":false,"result":"ok"}\n'
STUB
# -i.bak: BSD sed (macOS CI) requires a suffix argument to -i; GNU sed accepts it too.
sed -i.bak "s|__MODE_FILE__|$MODE_FILE|; s|__WORK__|$WORK|" "$WORK/bin/claude" && rm -f "$WORK/bin/claude.bak"; chmod +x "$WORK/bin/claude"

export GAFFER_DATA="$WORK/data" CLAUDE_BIN="$WORK/bin/claude" CLAUDE_FLAGS="" \
       GAFFER_TICK_TIMEOUT=60 GAFFER_MAX_TURNS=10 GAFFER_CARD_MODEL=stub GAFFER_PLAN_MODEL=stub GAFFER_IMPL_MODEL=stub \
       REVIEW_MODE=human DRY_RUN=0 GAFFER_MAINTENANCE=0
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
wg init >/dev/null 2>&1; lg init >/dev/null 2>&1
wg repo add -n repo --path "$R" --branch main --test "npm test" --lint "npm run lint" >/dev/null 2>&1

run_tick() { ( cd "$RUNNER_DIR" && bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep '^TICK_RESULT=' ; }
st() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.status'; }

# Seed memory: a digest (so `digest touch` has something to stamp) and a BUILDING feature
# whose id rides on the ticket description (`Feature-Id:`), exactly as the feature-backlog
# loop stamps it — case C proves the AFK merge ships it.
lg digest set repo --source onboard --overview o --structure s --conventions c --stack k >/dev/null 2>&1
FEAT_ID="$(lg feature add repo --name "Hold probe" --summary "probe" --status building 2>/dev/null | sed -n 's/^memory: added feature \([^ ]*\) .*/\1/p')"
N="$(wg ticket create -t "Hold probe" -d "deliver then review

Feature-Id: $FEAT_ID" 2>/dev/null | jget 'd.ticket.number')"
wg ac add "$N" -t "helper added" >/dev/null 2>&1
wg ticket repo-access set "$N" repo --access write --relation confirmed >/dev/null 2>&1
wg ticket ready "$N" >/dev/null 2>&1
OUT0="$(run_tick)"
grep -q '^TICK_RESULT=worked$' <<<"$OUT0" && [ "$(st "$N")" = "in_review" ] \
  && ok "setup: #$N delivered → in_review" || fail "setup delivery failed: $OUT0 status=$(st "$N")"

echo "== A. reviewer REFUSED to run (rc=75, empty envelope) with every autonomy grant on =="
echo refuse > "$MODE_FILE"
rm -f "$GAFFER_DATA/.reviewed-tickets"
OUTA="$(REVIEW_MODE=agent DISPATCH_ALLOW_AGENT_APPROVE=1 AUTO_MERGE=1 MERGE_ON_AGENT_REVIEW=1 run_tick)"
grep -q '^TICK_RESULT=reviewed$' <<<"$OUTA" && ok "A: the review pass ran (TICK_RESULT=reviewed)" || fail "A: tick result $OUTA"
grep -q 'verdict=held' "$GAFFER_DATA/factory.log" && grep -q 'not a verdict' "$GAFFER_DATA/factory.log" \
  && ok "A: logged as HELD — 'reviewer did not run … not a verdict'" || fail "A: no held/not-a-verdict log line: $(tail -3 "$GAFFER_DATA/factory.log" | tr '\n' '|')"
[ "$(st "$N")" = "in_review" ] && ok "A: #$N stays in_review (not reworked, not approved)" || fail "A: #$N became '$(st "$N")'"
grep -q 'CHANGES; re-queued' "$GAFFER_DATA/factory.log" && fail "A: a non-verdict was treated as CHANGES (re-queued)" || ok "A: nothing was re-queued for rework"
grep -qx "$N" "$GAFFER_DATA/.reviewed-tickets" 2>/dev/null && ok "A: #$N skipped for the rest of this run (no re-review spin)" || fail "A: #$N not in the reviewed-skip file"

echo "== B. a real APPROVE with the approve gate DENIED holds as advisory =="
echo approve > "$MODE_FILE"
rm -f "$GAFFER_DATA/.reviewed-tickets"
OUTB="$(REVIEW_MODE=agent run_tick)"
grep -q '^TICK_RESULT=reviewed$' <<<"$OUTB" && ok "B: the review pass ran" || fail "B: tick result $OUTB"
grep -q 'verdict=approve, approve_gate=deny' "$GAFFER_DATA/factory.log" && ok "B: verdict parsed as approve, gate deny → advisory hold" || fail "B: expected verdict=approve/approve_gate=deny: $(tail -2 "$GAFFER_DATA/factory.log" | tr '\n' '|')"
[ "$(st "$N")" = "in_review" ] && ok "B: #$N still in_review for a human" || fail "B: #$N became '$(st "$N")'"

echo "== B2. a CHANGES token followed by prose quoting an APPROVE token is NO verdict → HELD =="
echo trailing > "$MODE_FILE"; rm -f "$GAFFER_DATA/.reviewed-tickets"
OUTB2="$(REVIEW_MODE=agent DISPATCH_ALLOW_AGENT_APPROVE=1 AUTO_MERGE=1 MERGE_ON_AGENT_REVIEW=1 GAFFER_STRICT_REQUIRE=0 run_tick)"
[ "$(st "$N")" = "in_review" ] && grep -q "verdict=held.*final line is not a verdict token" "$GAFFER_DATA/factory.log" \
  && ok "B2: #$N held in_review (not approved, not reworked)" || fail "B2: #$N is '$(st "$N")' ($OUTB2): $(tail -2 "$GAFFER_DATA/factory.log" | tr '\n' '|')"

echo "== D. a reviewer that COMMITS in its worktree, then APPROVEs, with every grant on → HELD =="
RBR="$(git -C "$R" branch --list "gaffer/ticket-$N-*" | tr -d ' *' | head -1)"
RSHA0="$(git -C "$R" rev-parse "refs/heads/$RBR")"; MAIN0="$(git -C "$R" rev-parse main)"
for mode in sneak sneak-branch; do
  echo "$mode" > "$MODE_FILE"; rm -f "$GAFFER_DATA/.reviewed-tickets"
  OUTD="$(REVIEW_MODE=agent DISPATCH_ALLOW_AGENT_APPROVE=1 AUTO_MERGE=1 MERGE_ON_AGENT_REVIEW=1 GAFFER_STRICT_REQUIRE=0 run_tick)"
  grep -q '^TICK_RESULT=reviewed$' <<<"$OUTD" && ok "D[$mode]: the review pass ran" || fail "D[$mode]: tick result $OUTD"
  [ "$(st "$N")" = "in_review" ] && ok "D[$mode]: #$N HELD in_review (not approved, not shipped)" || fail "D[$mode]: #$N became '$(st "$N")'"
  grep -q "SAFETY: #$N reviewer modified the candidate" "$GAFFER_DATA/factory.log" \
    && ok "D[$mode]: logged 'reviewer modified the candidate'" || fail "D[$mode]: no tamper log line: $(tail -3 "$GAFFER_DATA/factory.log" | tr '\n' '|')"
  [ "$(git -C "$R" rev-parse main)" = "$MAIN0" ] && ! git -C "$R" cat-file -e main:sneak.txt 2>/dev/null \
    && ok "D[$mode]: main lacks the reviewer's commit" || fail "D[$mode]: main moved / has sneak.txt: $(git -C "$R" log --oneline main | head -3 | tr '\n' '|')"
  [ "$(git -C "$R" rev-parse "refs/heads/$RBR")" = "$RSHA0" ] \
    && ok "D[$mode]: delivery branch $RBR still at the reviewed commit" || fail "D[$mode]: $RBR moved to $(git -C "$R" log --oneline -1 "refs/heads/$RBR")"
done
git -C "$R" rev-parse --verify -q refs/gaffer/review-tamper/"$N" >/dev/null \
  && ok "D: the moved head is kept for forensics (refs/gaffer/review-tamper/$N)" || fail "D: no refs/gaffer/review-tamper/$N"
echo approve > "$MODE_FILE"

echo "== C. APPROVE with every grant on → SHIPS: merge, memory work, branch cleanup, reviewer env =="
rm -f "$GAFFER_DATA/.reviewed-tickets" "$WORK/review-mcp.json"
RBR="$(git -C "$R" branch --list "gaffer/ticket-$N-*" | tr -d ' *' | head -1)"
# Containment out-of-band for this test (GAFFER_STRICT_REQUIRE=0): the sandbox-refusal path is case A.
OUTC="$(REVIEW_MODE=agent DISPATCH_ALLOW_AGENT_APPROVE=1 AUTO_MERGE=1 MERGE_ON_AGENT_REVIEW=1 GAFFER_STRICT_REQUIRE=0 run_tick)"
grep -q '^TICK_RESULT=reviewed$' <<<"$OUTC" && ok "C: the review pass ran" || fail "C: tick result $OUTC"
[ "$(st "$N")" = "done" ] && ok "C: #$N merged and marked done" || fail "C: #$N is '$(st "$N")' (log: $(grep "AFK: #$N" "$GAFFER_DATA/factory.log" | tail -2 | tr '\n' '|'))"
grep -q "AFK: #$N digest/feature applied post-merge" "$GAFFER_DATA/factory.log" \
  && ok "C: post-merge digest/feature apply ran from the AFK path (B9)" || fail "C: no digest/feature apply log line: $(tail -4 "$GAFFER_DATA/factory.log" | tr '\n' '|')"
grep -q "source: merge:#$N" <<<"$(lg digest repo 2>/dev/null)" \
  && ok "C: Repo Digest freshness stamped source=merge:#$N" || fail "C: digest not stamped: $(lg digest repo 2>/dev/null | grep -i source)"
FEAT_STATUS="$(node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1],{readOnly:true});const r=d.prepare("SELECT status FROM feature WHERE id=?").get(process.argv[2]);process.stdout.write(r?r.status:"missing")' "$MEMORY_DB" "$FEAT_ID" 2>/dev/null)"
[ "$FEAT_STATUS" = "shipped" ] && ok "C: feature $FEAT_ID advanced building → shipped via the ticket's Feature-Id (B11)" || fail "C: feature status '$FEAT_STATUS' (want shipped)"
FEAT_ROWS="$(node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1],{readOnly:true});process.stdout.write(String(d.prepare("SELECT COUNT(*) AS n FROM feature WHERE repo=? AND lower(name)=lower(?)").get("repo","Hold probe").n))' "$MEMORY_DB" 2>/dev/null)"
[ "$FEAT_ROWS" = "1" ] && ok "C: exactly one ledger row for the feature (no duplicate shipped row)" || fail "C: $FEAT_ROWS feature rows named 'Hold probe'"
[ -n "$RBR" ] && ! git -C "$R" show-ref --verify --quiet "refs/heads/$RBR" \
  && ok "C: merged delivery branch $RBR deleted" || fail "C: branch '$RBR' still present: $(git -C "$R" branch --list 'gaffer/*' | tr '\n' ' ')"
[ -f "$WORK/review-mcp.json" ] && [ "$(jget 'd.mcpServers.dispatch.env.GAFFER_REVIEW_TICKET' < "$WORK/review-mcp.json" 2>/dev/null)" = "$N" ] \
  && ok "C: reviewer MCP runtime binds GAFFER_REVIEW_TICKET=$N into the dispatch server (B12)" || fail "C: GAFFER_REVIEW_TICKET missing from the reviewer's MCP runtime: $(cat "$WORK/review-mcp.json" 2>/dev/null | tr -d '\n' | head -c 300)"
grep -q '\${GAFFER_' "$WORK/review-mcp.json" 2>/dev/null && fail "C: reviewer MCP runtime still carries a placeholder" || ok "C: reviewer MCP runtime has no leftover placeholders"

echo "== F. approved with the merge gate HELD, then the branch moves → the merge lane HOLDS it =="
echo deliver > "$MODE_FILE"
N2="$(wg ticket create -t "Pin probe" -d "deliver, approve, then move" 2>/dev/null | jget 'd.ticket.number')"
wg ac add "$N2" -t "helper added" >/dev/null 2>&1
wg ticket repo-access set "$N2" repo --access write --relation confirmed >/dev/null 2>&1
wg ticket ready "$N2" >/dev/null 2>&1
OUTF0="$(run_tick)"
[ "$(st "$N2")" = "in_review" ] && ok "F: #$N2 delivered → in_review" || fail "F: setup delivery: $OUTF0 status=$(st "$N2")"
echo approve > "$MODE_FILE"; rm -f "$GAFFER_DATA/.reviewed-tickets"
OUTF1="$(REVIEW_MODE=agent DISPATCH_ALLOW_AGENT_APPROVE=1 GAFFER_STRICT_REQUIRE=0 run_tick)"
[ "$(st "$N2")" = "ready_for_merge" ] && ok "F: #$N2 approved, merge gate held → ready_for_merge" || fail "F: #$N2 is '$(st "$N2")' ($OUTF1)"
RBR2="$(git -C "$R" branch --list "gaffer/ticket-$N2-*" | tr -d ' *' | head -1)"
REV2="$(git -C "$R" rev-parse "refs/heads/$RBR2")"
DEC="$(node "$RUNNER_DIR/lib/tester-binding.mjs" landing --db "$DISPATCH_DB" --ticket "$N2" --repo "$R" --branch "$RBR2")"
[ "$(printf '%s' "$DEC" | jget 'd.ok && d.reviewed === d.pin ? d.pin : ""')" = "$REV2" ] \
  && ok "F: the landing decision is pinned to the reviewed commit" || fail "F: decision before the move: $DEC"
WTX="$WORK/wt-move"; git -C "$R" worktree add -q "$WTX" "$RBR2" >/dev/null 2>&1
( cd "$WTX" && echo unreviewed > late.txt && git -c user.email=x@x -c user.name=x add late.txt && git -c user.email=x@x -c user.name=x commit -qm "unreviewed late commit" )
git -C "$R" worktree remove --force "$WTX" >/dev/null 2>&1
MAINF="$(git -C "$R" rev-parse main)"
OUTF2="$(REVIEW_MODE=human DISPATCH_ALLOW_AGENT_APPROVE=1 AUTO_MERGE=1 MERGE_ON_AGENT_REVIEW=1 GAFFER_STRICT_REQUIRE=0 run_tick)"
grep -q "MERGE: #$N2 HELD — $RBR2 moved since the agent review approved it" "$GAFFER_DATA/factory.log" \
  && ok "F: the merge lane HELD #$N2 (moved-since-review)" || fail "F: no moved-since-review hold: $(grep "#$N2" "$GAFFER_DATA/factory.log" | tail -3 | tr '\n' '|')"
[ "$(git -C "$R" rev-parse main)" = "$MAINF" ] && [ "$(st "$N2")" = "ready_for_merge" ] \
  && ok "F: nothing landed; #$N2 still ready_for_merge" || fail "F: main moved or #$N2 is '$(st "$N2")'"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
