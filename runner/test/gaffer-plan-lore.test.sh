#!/usr/bin/env bash
# =====================================================================
# `gaffer plan` and `gaffer lore`: planning a build and ratifying lore from the front
# door, doing what the dashboard does (README "What's rough": planning needed the
# dashboard, approving lore needed the raw memory CLI).
# ---------------------------------------------------------------------
# A stub claude (scripts/ui-regression/stub-claude.sh: the planner gets two questions,
# then a fixed plan) and a real dashboard on its own data dir; no tick, no model.
#   P1  no dollar cap: refused before any model call, nothing created
#   P2  a goal: the planner's questions, the draft kept 0600, nothing created
#   P3  --answer: the proposal (tickets, deps, the Final, the agreed answer flagged as
#       uncovered), still nothing created; --show repeats it without a model call
#   P4  the same turns through the dashboard (POST /plan-build) send the planner the
#       SAME prompt and get the same plan
#   P5  --yes creates the shown plan (no new model call), as drafts, and the ticket set
#       matches what the dashboard's confirm (POST /epics) creates for the same plan
#   P6  brownfield: --repo targets a registered repo, every ticket is linked to it,
#       no bootstrap; an unregistered --repo is refused before the planner is paid
#   P7  usage errors exit 2 and run nothing
#   L1  gaffer lore review lists the drafts the dashboard lists, with its fields
#   L2  approve / reject change what the dashboard reads; a refused decision exits 1
#   L3  usage errors exit 2
# Run: bash runner/test/gaffer-plan-lore.test.sh   (bash 3.2 safe)
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

WORK="$(mktemp -d "${TMPDIR:-/tmp}/gaffer-plan-lore.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
A="$WORK/a"; B="$WORK/b"; mkdir -p "$A" "$B" "$WORK/bin"
PORT="${GAFFER_TEST_PORT_BASE:-$(( 20000 + RANDOM % 20000 ))}"
stop_dash() { local p; p="$(cat "$B/dashboard.pid" 2>/dev/null || true)"; [ -n "$p" ] && kill "$p" 2>/dev/null; true; }
trap 'stop_dash; gaffer_test_rm_work "$WORK"' EXIT

cp "$ROOT/scripts/ui-regression/stub-claude.sh" "$WORK/bin/claude"
cp "$ROOT/scripts/ui-regression/stub-worker.mjs" "$WORK/bin/stub-worker.mjs"
chmod +x "$WORK/bin/claude"
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN \
  GAFFER_DAILY_BUDGET_USD GAFFER_BUDGET_USD GAFFER_ALLOW_UNCAPPED GAFFER_DECOMPOSE_BIN \
  DISPATCH_DB MEMORY_DB GAFFER_PLAN_DEBATE DISPATCH_API_TOKEN DRY_RUN
export PATH="$WORK/bin:$PATH" CLAUDE_BIN="$WORK/bin/claude" CLAUDE_FLAGS="" \
  GAFFER_STRICT_REQUIRE=0 STRICT_MODE=0 GAFFER_PLAN_MODEL=stub NO_COLOR=1
MEM="$ROOT/packages/memory/dist/bin/memory.js"

# ga <data> <args…>: gaffer against one factory; output in $OUT, exit code in $RC.
ga() { local d="$1"; shift; OUT="$(GAFFER_DATA="$d" bash "$G" "$@" 2>&1 </dev/null)"; RC=$?; }
calls() { [ -f "$1/stub-calls.jsonl" ] && grep -c '"kind":"plan"' "$1/stub-calls.jsonl" | tr -d ' ' || echo 0; }
# Reads go straight to the dispatch CLI on that factory's database (what `gaffer wg` runs).
wgd() { local d="$1"; shift; node "$ROOT/packages/dispatch/dist/cli/index.js" --db "$d/dispatch.sqlite" "$@"; }
tickets() { wgd "$1" ticket list 2>/dev/null | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const j=JSON.parse(s||"[]");const a=Array.isArray(j)?j:(j.tickets||[]);console.log(a.length)})'; }
for d in "$A" "$B"; do
  GAFFER_DATA="$d" bash "$G" wg init >/dev/null 2>&1 || { echo "dispatch init failed"; exit 1; }
  MEMORY_DB="$d/memory.sqlite" node "$MEM" init >/dev/null 2>&1 || { echo "memory init failed"; exit 1; }
done
GOAL="a tiny task list app with archiving"
ANSWER="archive them after 30 days"

echo "== P1. no dollar cap: refused before the planner runs =="
printf '{}' > "$A/settings.json"
ga "$A" plan "$GOAL"
[ "$RC" -eq 1 ] && has "$OUT" "dollar cap" && ok "P1: refused (exit 1) and says why" || fail "P1: rc=$RC out=$OUT"
[ "$(calls "$A")" = 0 ] && ok "P1: no model call" || fail "P1: the stub was called $(calls "$A") time(s)"
[ "$(tickets "$A")" = 0 ] && ok "P1: nothing created" || fail "P1: tickets exist"
rm -f "$A/plan-draft.json"
export GAFFER_DAILY_BUDGET_USD=5

echo "== P2. a goal: the planner asks first, nothing is created =="
ga "$A" plan "$GOAL"
[ "$RC" -eq 0 ] && has "$OUT" "The planner asks:" && has "$OUT" "Should completed tasks be archived or deleted?" \
  && ok "P2: the questions are printed (exit 0)" || fail "P2: rc=$RC out=$OUT"
has "$OUT" 'gaffer plan --answer' && has "$OUT" 'gaffer plan --now' && ok "P2: says how to answer or plan now" || fail "P2: no next step: $OUT"
[ "$(calls "$A")" = 1 ] && ok "P2: one model call, through the stub" || fail "P2: calls=$(calls "$A")"
[ "$(tickets "$A")" = 0 ] && ok "P2: nothing created" || fail "P2: tickets exist"
mode="$(stat -c %a "$A/plan-draft.json" 2>/dev/null || stat -f %Lp "$A/plan-draft.json" 2>/dev/null)"
[ "$mode" = 600 ] && ok "P2: the draft is kept, 0600" || fail "P2: draft mode '$mode'"

echo "== P3. an answer: the proposal, still nothing created =="
ga "$A" plan --answer "$ANSWER"
[ "$RC" -eq 0 ] && has "$OUT" "Proposed epic: Archive completed tasks" && ok "P3: the proposed epic is shown" || fail "P3: rc=$RC out=$OUT"
has "$OUT" "T1  Bootstrap the task app   (bootstrap · repo task-app)" && has "$OUT" "T3  Show archived tasks count   (repo task-app · after T1, T2)" \
  && ok "P3: tickets with repo, bootstrap and dependsOn" || fail "P3: tickets not as expected: $OUT"
has "$OUT" "    - countArchived counts the archived tasks" && ok "P3: acceptance criteria shown" || fail "P3: no criteria"
has "$OUT" "Final  Acceptance: Archive completed tasks" && ok "P3: the Final the factory adds is shown" || fail "P3: no Final"
has "$OUT" "- $ANSWER   ! no proposed criterion covers this" && ok "P3: the agreed answer is listed and flagged as uncovered" || fail "P3: agreed section: $OUT"
has "$OUT" "gaffer plan --yes" && ok "P3: says how to create it" || fail "P3: no --yes hint"
[ "$(tickets "$A")" = 0 ] && ok "P3: nothing created without --yes" || fail "P3: tickets were created"
[ "$(calls "$A")" = 2 ] && ok "P3: one more model call" || fail "P3: calls=$(calls "$A")"
ga "$A" plan --show
has "$OUT" "Proposed epic: Archive completed tasks" && has "$OUT" "T4  Document the archive helpers" && [ "$(calls "$A")" = 2 ] \
  && ok "P3: --show repeats it, no model call" || fail "P3: --show rc=$RC calls=$(calls "$A") out=$OUT"
cp "$A/plan-draft.json" "$WORK/shown-draft.json"

echo "== P4. the dashboard's planner gets the same prompt and gives the same plan =="
GAFFER_DATA="$B" DISPATCH_API_PORT="$PORT" bash "$G" dashboard >/dev/null 2>&1
TOK="$(cat "$B/dashboard-token" 2>/dev/null)"
up=0; for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  curl -sf -H "authorization: Bearer $TOK" "http://127.0.0.1:$PORT/api/dashboard" >/dev/null 2>&1 && { up=1; break; }; sleep 0.5
done
[ "$up" = 1 ] && ok "P4: a dashboard on :$PORT" || fail "P4: the dashboard did not come up: $(tail -5 "$B/dashboard.log" 2>/dev/null)"
api() { curl -s -H "authorization: Bearer $TOK" -H 'content-type: application/json' -X "$1" "http://127.0.0.1:$PORT$2" ${3:+--data-binary "$3"}; }
# The panel's two turns (submitPlanBuildTurn): the brief rides as a user answer.
H1="[{\"role\":\"user\",\"answer\":\"$GOAL\"}]"
R1="$(api POST /plan-build "{\"brief\":\"$GOAL\",\"history\":$H1}")"
Q="$(printf '%s' "$R1" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.phase==="clarify"?JSON.stringify(j.questions):"")})')"
[ -n "$Q" ] && ok "P4: the dashboard's first turn is the same clarify" || fail "P4: first turn: $R1"
H2="[{\"role\":\"user\",\"answer\":\"$GOAL\"},{\"role\":\"assistant\",\"questions\":$Q},{\"role\":\"user\",\"answer\":\"$ANSWER\"}]"
api POST /plan-build "{\"brief\":\"$GOAL\",\"history\":$H2}" > "$WORK/dash-plan.json"
same="$(node -e '
  const fs=require("fs");
  const prompts=(f)=>fs.readFileSync(f,"utf8").split("\n").filter(Boolean).map(JSON.parse).filter(c=>c.kind==="plan").map(c=>c.prompt);
  const a=prompts(process.argv[1]), b=prompts(process.argv[2]);
  const dash=JSON.parse(fs.readFileSync(process.argv[3],"utf8")).plan;
  const mine=JSON.parse(fs.readFileSync(process.argv[4],"utf8")).plan;
  console.log([a.length===2&&b.length===2&&a[0]===b[0]&&a[1]===b[1], JSON.stringify(dash)===JSON.stringify(mine)].join(" "));
' "$A/stub-calls.jsonl" "$B/stub-calls.jsonl" "$WORK/dash-plan.json" "$WORK/shown-draft.json" 2>&1)"
[ "${same%% *}" = true ] && ok "P4: both turns sent the planner byte-identical prompts" || fail "P4: prompts differ ($same)"
[ "${same##* }" = true ] && ok "P4: the same plan came back" || fail "P4: plans differ ($same)"

echo "== P5. --yes creates the shown plan, as the dashboard's confirm would =="
ga "$A" plan --yes
[ "$RC" -eq 0 ] && has "$OUT" "created epic" && has "$OUT" "5 draft ticket(s) #1 #2 #3 #4 #5 (the Final is #5)" \
  && ok "P5: created 4 tickets + the Final" || fail "P5: rc=$RC out=$OUT"
has "$OUT" "4 repo link(s) deferred to the bootstrap" && ok "P5: greenfield links deferred, like the dashboard" || fail "P5: deferral line: $OUT"
has "$OUT" "1 agreed requirement(s)" && ok "P5: the agreed answer rides to the Final" || fail "P5: agreed line: $OUT"
[ "$(calls "$A")" = 2 ] && ok "P5: no new model call (the shown plan, not a fresh one)" || fail "P5: calls=$(calls "$A")"
[ ! -e "$A/plan-draft.json" ] && ok "P5: the draft is cleared" || fail "P5: draft still there"
ga "$A" plan --yes
[ "$RC" -eq 2 ] && [ "$(tickets "$A")" = 5 ] && ok "P5: a second --yes creates nothing (exit 2)" || fail "P5: second --yes rc=$RC tickets=$(tickets "$A")"
# The dashboard's confirm (app.js confirmPlanBuild + planAgreedRequirements) for the same
# plan and conversation, then POST /epics.
BODY="$(node -e '
  const fs=require("fs");
  const plan=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).plan;
  const known=new Set(JSON.parse(process.argv[2]).repositories.map(r=>r.name));
  const tickets=plan.tickets.map(t=>{ if(t.repo&&!known.has(t.repo)){const {repo,access,...rest}=t; return rest.source?rest:{...rest,source:repo};} return t; });
  const q=JSON.parse(process.argv[3]);
  const epic={...plan.epic, brief:process.argv[4], agreed_requirements:[{question:q.join(" "),answer:process.argv[5]}]};
  process.stdout.write(JSON.stringify({epic,tickets}));
' "$WORK/dash-plan.json" "$(api GET /repositories)" "$Q" "$GOAL" "$ANSWER")"
CR="$(api POST /epics "$BODY")"
has "$CR" '"ticket_numbers":[1,2,3,4,5]' && ok "P5: the dashboard's POST /epics made 5 tickets too" || fail "P5: POST /epics: $CR"
# The ticket sets, field by field (plan order; dependencies by title).
snap() {
  local d="$1" n out=""
  for n in 1 2 3 4 5; do out="$out$(wgd "$d" ticket show "$n" 2>/dev/null)"$'\x1e'; done
  printf '%s' "$out" | node -e '
    let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
      const views=s.split("\x1e").filter(x=>x.trim()).map(JSON.parse);
      const byId=new Map(views.map(v=>[(v.ticket||v).id,(v.ticket||v).title]));
      const rows=views.map(v=>{const t=v.ticket||v; return {
        title:t.title, description:t.description, status:t.status, priority:t.priority, risk:t.risk_level,
        bootstrap:t.bootstrap, source:t.source, acceptance:t.acceptance, testable:t.can_be_tested,
        acs:(v.acceptance_criteria||v.acceptanceCriteria||[]).map(a=>a.text),
        repos:(v.repositories||[]).map(r=>r.name||r.repo_id),
        epics:(v.scopes||[]).filter(n=>n.type==="epic").map(n=>n.name),
        contract:t.test_contract,
        deps:(v.dependencies||v.depends_on||[]).map(d=>byId.get(d.depends_on_ticket_id||d.depends_on||d.id)||d.title||JSON.stringify(d)).sort(),
      };});
      process.stdout.write(JSON.stringify(rows,null,1));
    });'
}
snap "$A" > "$WORK/snap-a.json"; snap "$B" > "$WORK/snap-b.json"
if cmp -s "$WORK/snap-a.json" "$WORK/snap-b.json" && [ "$(wc -c < "$WORK/snap-a.json")" -gt 500 ]; then
  ok "P5: gaffer plan --yes and the dashboard's confirm created the same ticket set"
else
  fail "P5: ticket sets differ: $(diff "$WORK/snap-a.json" "$WORK/snap-b.json" | head -20)"
fi
FIN="$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const f=r[4]||{};console.log([r.every(t=>t.status==="draft"),f.acceptance,f.testable,(f.deps||[]).length,f.acs.some(a=>a.includes("30 days"))].join(" "))' "$WORK/snap-a.json" 2>&1)"
[ "$FIN" = "true 1 1 4 true" ] || [ "$FIN" = "true true true 4 true" ] \
  && ok "P5: all draft; the Final is testable, after all 4, and carries the agreed answer" || fail "P5: Final/status check: $FIN"

echo "== P6. brownfield: --repo extends a registered repo =="
R="$WORK/shop"; mkdir -p "$R"
( cd "$R" && git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init )
GAFFER_DATA="$A" bash "$G" wg repo add -n shop --path "$R" >/dev/null 2>&1
ga "$A" plan "add archiving" --repo nosuch
[ "$RC" -eq 2 ] && has "$OUT" "no registered repo 'nosuch'" && [ "$(calls "$A")" = 2 ] \
  && ok "P6: an unregistered --repo is refused before the planner runs" || fail "P6: nosuch rc=$RC calls=$(calls "$A") out=$OUT"
ga "$A" plan "add archiving" --repo shop --now --yes
[ "$RC" -eq 0 ] && has "$OUT" "extends: shop" && has "$OUT" "(repo shop" && ! has "$OUT" "bootstrap" \
  && has "$OUT" "created epic" && ok "P6: --now --yes plans and creates against the repo, no bootstrap" || fail "P6: rc=$RC out=$OUT"
linked="$(for n in 6 7 8; do wgd "$A" ticket show "$n" 2>/dev/null; done | grep -c '"shop"' | tr -d ' ')"
[ "$linked" -ge 3 ] && ok "P6: every ticket is linked to shop" || fail "P6: shop links=$linked"
has "$(tail -1 "$A/stub-calls.jsonl")" "EXISTING-REPO (BROWNFIELD) MODE" && ok "P6: the planner was told it is brownfield" || fail "P6: brownfield prompt"
# POST /epics's brownfield hook (bin/epic-feature.mjs, detached): the feature is building.
feat=""; for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  feat="$(MEMORY_DB="$A/memory.sqlite" node "$MEM" features shop 2>/dev/null)"; has "$feat" "[building] Archive completed tasks" && break; sleep 0.5
done
has "$feat" "[building] Archive completed tasks" && ok "P6: the feature ledger shows the epic's feature as building" || fail "P6: no building feature: $feat"

echo "== P7. usage errors exit 2 and run nothing =="
before="$(calls "$A")"
for args in "--bogus" "a b" "--answer" "--repo shop" "--show --list" "--list x" "--file $WORK/absent"; do
  # shellcheck disable=SC2086 # word-split on purpose: each case is several arguments
  ga "$A" plan $args
  [ "$RC" -eq 2 ] && has "$OUT" "usage: gaffer plan" && ok "P7: plan $args → exit 2 with usage" || fail "P7: plan $args rc=$RC out=$OUT"
done
ga "$A" plan --answer "x"
[ "$RC" -eq 2 ] && has "$OUT" "no draft plan to continue" && ok "P7: --answer with no draft → exit 2" || fail "P7: --answer no draft rc=$RC"
[ "$(calls "$A")" = "$before" ] && ok "P7: none of them called the planner" || fail "P7: calls moved"
ga "$A" plan --list
has "$OUT" "Archive completed tasks" && ok "P7: --list names the epics" || fail "P7: --list: $OUT"

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

stop_dash
echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "gaffer-plan-lore: ALL $PASS checks passed"
  exit 0
fi
echo "gaffer-plan-lore: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
