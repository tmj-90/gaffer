#!/usr/bin/env bash
# =====================================================================
# RELEASE GATE 2 — "done" means the COMBINED code passed the gates on the target.
# ---------------------------------------------------------------------
# Operator promise: two branches that each pass their gates, whose COMBINATION fails,
# never land the failing combination — main stays green and the second ticket waits
# for a human with the gate output, instead of reading "done".
#
# The counterexample (external review 2): a field rename. Branch A changes which field
# greet() reads (name → fullName); branch B removes the field it considers unused
# (fullName). Each branch passes `npm test` alone, main passes, the textual merge is
# clean — and main + A + B fails the same test.
#
# Real dispatch + tick.sh + bin/merge-ticket.mjs, a stub claude, a fixture repo:
#   1  both deliveries pass their own DoD gates and are approved by a human;
#   2  the MERGE LANE lands A (its merge with main passes the merge gate) and HOLDS B:
#      main does not gain B, main's tests still pass, B is blocked (merge_gate_red) in
#      the human queue with the failing gate output as evidence, never done;
#   3  the dashboard's Merge now (bin/merge-ticket.mjs) applies the same gate: a second
#      rename pair, the first lands, the second exits 4 HELD, main untouched by it;
#   4  compare-and-land: a target that moves after the gate is re-gated, never landed
#      on the stale verdict (lib/land.sh _gaffer_land_gated → 7).
# Run: bash runner/test/e2e-release-gate-merge-combination.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
[ -f "$ROOT/packages/dispatch/dist/cli/index.js" ] || { echo "SKIP: dispatch CLI not built"; exit 0; }
[ -f "$ROOT/packages/crew/dist/runtime/context/renderPromptCli.js" ] || { echo "SKIP: crew not built"; exit 0; }
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/rg-merge-combo.XXXXXX")"; WORK="$(cd "$WORK" && pwd -P)"
[ "${KEEP:-0}" = 1 ] || trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/data" "$WORK/bin"
R="$WORK/repo"; mkdir -p "$R/src" "$R/test"
gitc() { git -c user.email=t@t -c user.name=t "$@"; }
( cd "$R" && git init -q -b main
  printf '{ "name": "r", "version": "0.1.0", "private": true, "type": "module", "scripts": { "test": "node --test", "lint": "node -e 0" } }\n' > package.json
  printf 'export function user() {\n  return { name: "Ada", fullName: "Ada Lovelace", nick: "ada", handle: "@ada" };\n}\n' > src/user.js
  printf 'import { user } from "./user.js";\nexport function greet() {\n  return "hi " + user().name;\n}\nexport function tag() {\n  return "tag " + user().nick;\n}\n' > src/greet.js
  printf 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { greet, tag } from "../src/greet.js";\ntest("greet", () => { assert.match(greet(), /^hi Ada/); assert.doesNotMatch(greet(), /undefined/); });\ntest("tag", () => { assert.match(tag(), /^tag /); assert.doesNotMatch(tag(), /undefined/); });\n' > test/greet.test.js
  gitc add -A && gitc commit -qm init )

# Stub agent: the delivery a ticket asks for, keyed on a marker in its title.
cat > "$WORK/bin/claude" <<'STUB'
#!/usr/bin/env bash
prompt=""; prev=""; for a in "$@"; do [ "$prev" = "-p" ] && prompt="$a"; prev="$a"; done
if [ -e .git ]; then
  case "$prompt" in
    *"[read-fullName]"*) sed -i.bak 's/user().name;/user().fullName;/' src/greet.js ;;
    *"[drop-fullName]"*) sed -i.bak 's/, fullName: "Ada Lovelace"//' src/user.js ;;
    *"[read-handle]"*)   sed -i.bak 's/user().nick;/user().handle;/' src/greet.js ;;
    *"[drop-handle]"*)   sed -i.bak 's/, handle: "@ada"//' src/user.js ;;
  esac
  rm -f src/*.bak
  git -c user.email=s@s -c user.name=s add -A >/dev/null; git -c user.email=s@s -c user.name=s commit -qm "feat: delivery" >/dev/null 2>&1 || true
  printf '{"type":"result","subtype":"success","is_error":false,"result":"done.\\n\\nSmallest-change note: one line.","total_cost_usd":0.01,"num_turns":1}\n'; exit 0
fi
printf '{"type":"result","subtype":"success","is_error":false,"result":"ok"}\n'
STUB
chmod +x "$WORK/bin/claude"
export GAFFER_DATA="$WORK/data" CLAUDE_BIN="$WORK/bin/claude" CLAUDE_FLAGS="" \
       GAFFER_MAX_TURNS=3 GAFFER_TICK_TIMEOUT=60 GAFFER_CARD_MODEL=stub GAFFER_PLAN_MODEL=stub GAFFER_IMPL_MODEL=stub \
       REVIEW_MODE=human DRY_RUN=0 GAFFER_MAINTENANCE=0 GAFFER_STRICT_REQUIRE=0 GAFFER_SECURITY_REVIEW=0 GAFFER_TESTING=0 \
       MAX_OPEN_AGENT_BRANCHES_PER_REPO=10 MAX_IN_REVIEW_PER_REPO=10 GAFFER_DIGEST_DISABLE=1
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
wg init >/dev/null 2>&1; lg init >/dev/null 2>&1
wg repo add -n repo --path "$R" --branch main --stack node --test "npm test" --lint "npm run lint" >/dev/null 2>&1
run_tick() { ( cd "$RUNNER_DIR" && bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep '^TICK_RESULT=' ; }
st() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.status'; }
new_ticket() { local n; n="$(wg ticket create -t "$1" -d "$2" --risk low 2>/dev/null | jget 'd.ticket.number')"; wg ac add "$n" -t "tests pass" >/dev/null 2>&1; wg ticket repo-access set "$n" repo --access write --relation confirmed >/dev/null 2>&1; wg ticket ready "$n" >/dev/null 2>&1; printf '%s' "$n"; }
branch_of() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.branch_name || ""'; }
main_tests() { local wt="$WORK/main-check"; git -C "$R" worktree add -q --detach "$wt" main >/dev/null 2>&1; ( cd "$wt" && npm test >/dev/null 2>&1 ); local rc=$?; git -C "$R" worktree remove --force "$wt" >/dev/null 2>&1; return $rc; }
branch_tests() { local wt="$WORK/br-check"; git -C "$R" worktree add -q --detach "$wt" "$1" >/dev/null 2>&1; ( cd "$wt" && npm test >/dev/null 2>&1 ); local rc=$?; git -C "$R" worktree remove --force "$wt" >/dev/null 2>&1; return $rc; }
LOGF="$GAFFER_DATA/factory.log"

echo "== 1: two branches, each green on its own, both human-approved =="
A="$(new_ticket "Greet by full name [read-fullName]" "greet() reads user().fullName")"
B="$(new_ticket "Drop the unused field [drop-fullName]" "remove fullName from user(); nothing reads it")"
AUTO_MERGE=0 run_tick >/dev/null; AUTO_MERGE=0 run_tick >/dev/null
[ "$(st "$A")" = "in_review" ] && [ "$(st "$B")" = "in_review" ] && ok "both delivered through their DoD gates (in_review)" || fail "statuses A=$(st "$A") B=$(st "$B")"
BA="$(branch_of "$A")"; BB="$(branch_of "$B")"
branch_tests "$BA" && branch_tests "$BB" && main_tests && ok "each branch passes npm test alone, and so does main" || fail "a side does not pass alone (fixture broken)"
wg review approve "$A" --reviewer human1 >/dev/null 2>&1; wg review approve "$B" --reviewer human1 >/dev/null 2>&1
[ "$(st "$A")" = "ready_for_merge" ] && [ "$(st "$B")" = "ready_for_merge" ] && ok "both approved by a human (ready_for_merge)" || fail "approve: A=$(st "$A") B=$(st "$B")"

echo "== 2: the merge lane lands A and holds B — main never gets the failing combination =="
MAIN0="$(git -C "$R" rev-parse main)"; B_SHA="$(git -C "$R" rev-parse "refs/heads/$BB")"
GAFFER_MODE=autonomous AUTO_MERGE=1 run_tick >/dev/null
[ "$(st "$A")" = "done" ] && ok "A landed (its merge with main passed the merge gate)" || fail "A status=$(st "$A")"
git -C "$R" merge-base --is-ancestor "$(git -C "$R" rev-parse "$MAIN0")" main && ok "main advanced from its old head (A's merge)" || fail "main rewritten"
if git -C "$R" merge-base --is-ancestor "$B_SHA" main; then fail "main contains B — the failing combination landed"; else ok "main does NOT contain B"; fi
git -C "$R" rev-parse --verify -q "refs/heads/$BB" >/dev/null && ok "B's branch is kept for the rework" || fail "B's branch was deleted"
main_tests && ok "main's tests still pass after the tick" || fail "main is RED — the combination landed"
[ "$(st "$B")" = "blocked" ] && ok "B is held for a human (blocked), not done" || fail "B status=$(st "$B")"
EV="$(wg ticket show "$B" | jget '(d.evidence || []).filter(e => (e.summary || "").startsWith("MERGE GATE FAILED")).map(e => e.summary).join("\n")' 2>/dev/null)"
case "$EV" in *"MERGE GATE FAILED"*"DoD: FAIL"*) ok "the failing gate output is attached to B as evidence" ;; *) fail "no merge-gate evidence on B: ${EV:0:300}" ;; esac
grep -q "MERGE: #$B HELD for a human — the merge of" "$LOGF" && ok "the lane logged the hold with its reason" || fail "no hold line: $(grep "#$B" "$LOGF" | tail -3 | tr '\n' '|' | cut -c1-400)"
HQ="$(node -e '
  const { Dispatch } = await import(process.argv[1]);
  const d = Dispatch.open(process.argv[2]);
  const n = Number(process.argv[3]);
  const i = d.humanQueue().items.find((x) => x.ticket && x.ticket.number === n);
  process.stdout.write(i ? `${i.kind}|${i.reasonCode}|${i.reason}` : "none");' --input-type=module "$ROOT/packages/dispatch/dist/core.js" "$DISPATCH_DB" "$B" 2>/dev/null || echo none)"
case "$HQ" in "parked|merge_gate_red|"*"fails its gates"*) ok "B is in the human queue: parked, merge_gate_red, with the reason" ;; *) fail "human queue item: $HQ" ;; esac

echo "== 3: the dashboard's Merge now (bin/merge-ticket.mjs) applies the same gate =="
C="$(new_ticket "Tag by handle [read-handle]" "tag() reads user().handle")"
D="$(new_ticket "Drop the unused handle [drop-handle]" "remove handle from user(); nothing reads it")"
AUTO_MERGE=0 run_tick >/dev/null; AUTO_MERGE=0 run_tick >/dev/null
wg review approve "$C" --reviewer human1 >/dev/null 2>&1; wg review approve "$D" --reviewer human1 >/dev/null 2>&1
merge_now() { ( cd "$RUNNER_DIR" && DISPATCH_DB="$DISPATCH_DB" GAFFER_DATA="$GAFFER_DATA" node bin/merge-ticket.mjs --ticket "$1" ) >"$WORK/mn.out" 2>"$WORK/mn.err"; }
merge_now "$C"; rc=$?
[ "$rc" -eq 0 ] && [ "$(st "$C")" = "done" ] && ok "Merge now lands C (its combination passes)" || fail "Merge now C rc=$rc status=$(st "$C") $(tail -c 300 "$WORK/mn.out")"
MAIN1="$(git -C "$R" rev-parse main)"
merge_now "$D"; rc=$?
[ "$rc" -eq 4 ] && ok "Merge now refuses D (exit 4)" || fail "Merge now D rc=$rc: $(tail -c 400 "$WORK/mn.out")"
grep -q "MERGE GATE FAILED" "$WORK/mn.out" && ok "…saying the merge gate failed" || fail "Merge now output: $(tail -c 300 "$WORK/mn.out")"
[ "$(git -C "$R" rev-parse main)" = "$MAIN1" ] && main_tests && ok "main untouched by D and still green" || fail "main moved or is red after D"
[ "$(st "$D")" = "blocked" ] && ok "D held for a human (blocked)" || fail "D status=$(st "$D")"

echo "== 4: compare-and-land — a target that moved after the gate is never landed on the stale verdict =="
# shellcheck source=../lib/land.sh
source "$RUNNER_DIR/lib/land.sh"
gitc -C "$R" branch -f cl-target main; gitc -C "$R" branch cl-branch main
T0="$(git -C "$R" rev-parse cl-target)"
gitc -C "$R" commit -q --allow-empty -m "moved target" >/dev/null 2>&1 || true
git -C "$R" checkout -q -b cl-tmp "$T0" 2>/dev/null; gitc -C "$R" commit -q --allow-empty -m "elsewhere"; MOVED="$(git -C "$R" rev-parse HEAD)"; git -C "$R" checkout -q main
git -C "$R" update-ref refs/heads/cl-target "$MOVED"
_gaffer_land_gated "$R" cl-target "$T0" "$(git -C "$R" rev-parse cl-branch)" cl-branch "$(git -C "$R" rev-parse cl-branch)"; rc=$?
[ "$rc" -eq 7 ] && [ "$(git -C "$R" rev-parse cl-target)" = "$MOVED" ] && ok "target moved since the gate → rc 7 (re-gate), target untouched" || fail "compare-and-land rc=$rc"
grep -q "re-gating on the new target" "$RUNNER_DIR/lib/land.sh" && grep -q "landGatedMerge" "$RUNNER_DIR/bin/merge-ticket.mjs" && ok "both landing paths re-gate a moved target" || fail "re-gate wiring missing"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "e2e-release-gate-merge-combination: ALL $PASS checks passed"; exit 0; fi
echo "e2e-release-gate-merge-combination: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1
