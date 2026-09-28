#!/usr/bin/env bash
# =====================================================================
# E2E — the RIGHT AGENT runs with the RIGHT SKILLS, per lane, live.
# ---------------------------------------------------------------------
# Real dispatch + real tick.sh + the real headless runners, with a stub `claude` that
# SNAPSHOTS every spawn: the prompt, the cwd, the `.claude/skills` mount it was handed,
# the settings/brief files, the scoped MCP runtime and the GAFFER_* env. The test then
# asserts, lane by lane, that the factory picked the right agent AND mounted that
# role's skill set for the repo's stack — no wrong-language pack, no delivery bench on
# a reviewer, no implementation pointer for the tester:
#
#   1. DELIVERY  (alpha, Node)   — TS conventions + the packs the ticket text calls for;
#                                  no C#/Python/mobile packs; brief + settings installed.
#   2. REVIEW    (primary)       — review role: lenses + TS pack; NO create-branch /
#                                  run-coverage / add-api-endpoint; GAFFER_REVIEW_TICKET
#                                  bound into its MCP runtime.
#      SECURITY  (second pass)   — high-risk ticket → the security reviewer runs, with
#                                  the security-review lens mounted.
#   3. TESTER    (GAFFER_TESTING) — test role; a CONTRACT-ONLY prompt (no branch name,
#                                  no product-context lore); records PASS.
#   4. DELIVERY  (beta, Python)  — python-conventions, fix-bug; NO typescript pack.
#   5. CLARIFY   (draft intake)  — clarify role: clarify/prd/user-story + TS pack; no
#                                  delivery mechanics.
#   6. PRODUCT OWNER (headless)  — product role only (product-owner/rice/prd…), not the
#                                  whole library.
#
# Run: bash runner/test/e2e-agent-skill-routing.test.sh
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

WORK="$(mktemp -d "${TMPDIR:-/tmp}/agent-routing.XXXXXX")"; WORK="$(cd "$WORK" && pwd -P)"
[ "${KEEP:-0}" = 1 ] || trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/data" "$WORK/bin" "$WORK/calls"
CALLS="$WORK/calls"

# ── two repos with DIFFERENT stacks ───────────────────────────────────────────
A="$WORK/alpha"; mkdir -p "$A/src" "$A/test"
( cd "$A" && git init -q -b main
  printf '{ "name": "alpha", "version": "0.1.0", "private": true, "type": "module", "scripts": { "test": "node --test", "lint": "node -e 0" } }\n' > package.json
  printf 'export function listTasks(l) { return l; }\n' > src/tasks.js
  printf 'import test from "node:test"; import assert from "node:assert/strict";\nimport { listTasks } from "../src/tasks.js";\ntest("lists", () => { assert.equal(listTasks([]).length, 0); });\n' > test/tasks.test.js
  git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init )
B="$WORK/beta"; mkdir -p "$B/app"
( cd "$B" && git init -q -b main
  printf 'def login(user, password):\n    return user == "admin" and password == "x"\n' > app/auth.py
  printf '# beta\n' > README.md
  git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init )

# ── the recording stub `claude` ──────────────────────────────────────────────
# Every spawn writes a numbered snapshot: prompt, argv, cwd, the resolved skills mount,
# the GAFFER_*/DISPATCH_* env (values scrubbed to names where secret-shaped), whether
# the factory brief + settings were installed, and a copy of the --mcp-config file.
# It answers per lane: reviewers APPROVE, the tester PASSes, intake/PO return text, and
# a delivery commits one helper file in the repo it was spawned in.
cat > "$WORK/bin/claude" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
CALLS="__CALLS__"
prompt=""; prev=""; mcp=""
for a in "$@"; do
  [ "$prev" = "-p" ] && prompt="$a"
  [ "$prev" = "--mcp-config" ] && mcp="$a"
  prev="$a"
done
n="$(ls -1 "$CALLS" 2>/dev/null | wc -l | tr -d ' ')"; n=$((n + 1))
D="$CALLS/$(printf '%03d' "$n")"; mkdir -p "$D"
printf '%s' "$prompt" > "$D/prompt"
printf '%s\n' "$@" > "$D/argv"
pwd -P > "$D/cwd"
if [ -e .claude/skills ]; then ls -1 .claude/skills/ 2>/dev/null | sort > "$D/skills"; else : > "$D/skills"; fi
[ -f .claude/settings.json ] && echo yes > "$D/settings" || echo no > "$D/settings"
[ -f CLAUDE.factory.md ] && echo yes > "$D/brief" || echo no > "$D/brief"
env | grep -E '^(GAFFER_|DISPATCH_|MEMORY_)' | sort > "$D/env"
[ -n "$mcp" ] && [ -f "$mcp" ] && cp "$mcp" "$D/mcp.json"
case "$prompt" in
  *"SECURITY REVIEWER"*)
    echo security > "$D/kind"
    printf '{"type":"result","subtype":"success","is_error":false,"result":"No blocking finding.\\nRECOMMEND APPROVE\\n{\\"verdict\\":\\"APPROVE\\"}","total_cost_usd":0.01,"num_turns":2}\n'; exit 0 ;;
  *"REVIEWER agent"*)
    echo review > "$D/kind"
    printf '{"type":"result","subtype":"success","is_error":false,"result":"RECOMMEND APPROVE\\n{\\"verdict\\":\\"APPROVE\\"}","total_cost_usd":0.01,"num_turns":2}\n'; exit 0 ;;
  *"INDEPENDENT TESTER agent"*)
    echo tester > "$D/kind"
    printf '{"type":"result","subtype":"success","is_error":false,"result":"Probed the contract; every AC holds.\\n{\\"verdict\\":\\"PASS\\"}","total_cost_usd":0.01,"num_turns":2}\n'; exit 0 ;;
  *"INTAKE agent"*)
    echo clarify > "$D/kind"
    printf '{"type":"result","subtype":"success","is_error":false,"result":"Filed two acceptance criteria and one decision question.","total_cost_usd":0.01,"num_turns":2}\n'; exit 0 ;;
  *"product-owner skill"*)
    echo po > "$D/kind"
    printf '{"type":"result","subtype":"success","is_error":false,"result":"Drafted 3 tickets.","total_cost_usd":0.01,"num_turns":2}\n'; exit 0 ;;
esac
if [ -e .git ]; then
  echo delivery > "$D/kind"
  fn="helper${GAFFER_TICKET:-0}"
  if [ -f package.json ]; then
    grep -q "$fn" src/tasks.js || printf 'export function %s(l){return l;}\n' "$fn" >> src/tasks.js
  else
    printf 'def %s(x):\n    return x\n' "$fn" > "app/$fn.py"
  fi
  git -c user.email=s@s -c user.name=s add -A >/dev/null; git -c user.email=s@s -c user.name=s commit -qm "feat: $fn" >/dev/null 2>&1 || true
  printf '{"type":"result","subtype":"success","is_error":false,"result":"done.\\n\\nSmallest-change note: one helper.","total_cost_usd":0.02,"num_turns":3}\n'; exit 0
fi
echo other > "$D/kind"
printf '{"type":"result","subtype":"success","is_error":false,"result":"ok"}\n'
STUB
sed -i.bak "s|__CALLS__|$CALLS|" "$WORK/bin/claude" && rm -f "$WORK/bin/claude.bak"; chmod +x "$WORK/bin/claude"

export GAFFER_DATA="$WORK/data" CLAUDE_BIN="$WORK/bin/claude" CLAUDE_FLAGS="" \
       GAFFER_TICK_TIMEOUT=60 GAFFER_MAX_TURNS=10 GAFFER_CARD_MODEL=stub GAFFER_PLAN_MODEL=stub GAFFER_IMPL_MODEL=stub \
       REVIEW_MODE=human DRY_RUN=0 GAFFER_MAINTENANCE=0 AUTO_MERGE=0 GAFFER_STRICT_REQUIRE=0
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
wg init >/dev/null 2>&1; lg init >/dev/null 2>&1
wg repo add -n alpha --path "$A" --branch main --stack node --test "npm test" --lint "npm run lint" >/dev/null 2>&1
wg repo add -n beta  --path "$B" --branch main --stack python --test "true" --lint "true" >/dev/null 2>&1

run_tick() { ( cd "$RUNNER_DIR" && bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep '^TICK_RESULT=' ; }
review_tick() {
  rm -f "$GAFFER_DATA/.reviewed-tickets"
  # The full AUTONOMOUS ship posture (approve + merge env floors ON): the approve must
  # still route to in_testing and the review pass must NOT land the branch under the
  # tester's feet — a live run merged and deleted the branch here, leaving the ticket
  # in_testing with nothing to test.
  ( cd "$RUNNER_DIR" && REVIEW_MODE=agent DISPATCH_ALLOW_AGENT_APPROVE=1 GAFFER_TESTING=1 \
      GAFFER_MODE=autonomous AUTO_MERGE=1 MERGE_ON_AGENT_REVIEW=1 \
      bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep '^TICK_RESULT='
}
st() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.status'; }
new_ticket() { # $1 repo, $2 title, $3 description, $4 risk
  local n
  n="$(wg ticket create -t "$2" -d "$3" --risk "$4" 2>/dev/null | jget 'd.ticket.number')"
  wg ac add "$n" -t "the change is covered by a test" >/dev/null 2>&1
  wg ticket repo-access set "$n" "$1" --access write --relation confirmed >/dev/null 2>&1
  printf '%s' "$n"
}
# The most recent snapshot of a given kind (its directory).
last_call() { grep -lx "$1" "$CALLS"/*/kind 2>/dev/null | tail -1 | xargs -I{} dirname {}; }
count_kind() { grep -lx "$1" "$CALLS"/*/kind 2>/dev/null | wc -l | tr -d ' '; }
has_skill()  { grep -qx -- "$2" "$1/skills"; }
# assert_skills <label> <calldir> <present csv> <absent csv>
assert_skills() {
  local label="$1" d="$2" present="$3" absent="$4" s miss=() leak=()
  for s in ${present//,/ }; do has_skill "$d" "$s" || miss+=("$s"); done
  for s in ${absent//,/ }; do has_skill "$d" "$s" && leak+=("$s"); done
  [ "${#miss[@]}" -eq 0 ] && ok "$label: mounts ${present}" || fail "$label: missing skills: ${miss[*]}"
  [ "${#leak[@]}" -eq 0 ] && ok "$label: does not mount ${absent}" || fail "$label: leaked skills: ${leak[*]}"
}
prompt_has()  { grep -qF -- "$2" "$1/prompt"; }

echo "== 1. DELIVERY on alpha (Node): the TS pack + what the ticket calls for, and nothing foreign =="
A1="$(new_ticket alpha "Add a REST API endpoint for paginated tasks" "GET /tasks returns a page of tasks with a cursor; add pagination and filtering by status." high)"
wg ticket set-testable "$A1" >/dev/null 2>&1
wg ticket ready "$A1" >/dev/null 2>&1
run_tick >/dev/null
[ "$(st "$A1")" = "in_review" ] && ok "1: #$A1 delivered → in_review" || fail "1: delivery did not land (status=$(st "$A1"))"
D1="$(last_call delivery)"
if [ -z "$D1" ]; then fail "1: no delivery agent spawn recorded"; else
  ok "1: the delivery agent ran (cwd $(cat "$D1/cwd" | sed "s|$WORK/||"))"
  assert_skills "1: delivery/alpha" "$D1" \
    "typescript-conventions,add-api-endpoint,pagination-and-filtering,run-tests,run-lint,minimalism,engineering-craft,self-review,submit-review,record-evidence,create-branch" \
    "csharp-conventions,python-conventions,rust-conventions,kotlin-conventions,swift-conventions,mobile-ui,frontend-design,react-patterns,seo-audit,terraform-patterns,kubernetes-operator,review-ticket"
  n1="$(wc -l < "$D1/skills" | tr -d ' ')"
  { [ "$n1" -ge 20 ] && [ "$n1" -le 80 ]; } && ok "1: a scoped mount ($n1 skills, not the whole library)" || fail "1: mount size $n1"
  grep -qx "GAFFER_TICKET=$A1" "$D1/env" && ok "1: GAFFER_TICKET=$A1 in the agent env" || fail "1: GAFFER_TICKET missing: $(grep GAFFER_TICKET= "$D1/env")"
  # The repo scope is bound into the MEMORY MCP server's env (one-hop plumbing), not the
  # agent's own env: suggest_lore / direct-apply default to exactly this repo.
  grep -q '"GAFFER_TICKET_REPOS": *"alpha"' "$D1/mcp.json" 2>/dev/null && ok "1: memory MCP scoped to GAFFER_TICKET_REPOS=alpha" || fail "1: memory MCP repo scope: $(grep -o '"GAFFER_TICKET_REPOS": *"[^"]*"' "$D1/mcp.json" 2>/dev/null)"
  [ "$(cat "$D1/settings")" = yes ] && ok "1: .claude/settings.json (safety hook) installed" || fail "1: no settings.json in the agent dir"
  [ "$(cat "$D1/brief")" = yes ] && ok "1: CLAUDE.factory.md brief installed" || fail "1: no factory brief in the agent dir"
  prompt_has "$D1" "typescript-conventions" && ok "1: prompt recommends the TS pack" || fail "1: prompt does not name typescript-conventions"
  prompt_has "$D1" "csharp-conventions" && fail "1: prompt recommends csharp-conventions on a Node repo" || ok "1: prompt does not recommend a foreign language pack"
  prompt_has "$D1" "minimalism" && ok "1: prompt carries the mandatory quality lenses" || fail "1: prompt lacks the quality lenses"
fi

echo "== 2. REVIEW: the reviewer role (lenses + TS pack), then the SECURITY second opinion =="
review_tick >/dev/null
R1="$(last_call review)"; S1="$(last_call security)"
if [ -z "$R1" ]; then fail "2: no primary reviewer spawn"; else
  ok "2: the primary reviewer ran"
  assert_skills "2: reviewer/alpha" "$R1" \
    "review-ticket,adversarial-reviewer,submit-review,record-evidence,security-review,performance-review,test-quality-review,typescript-conventions,minimalism,engineering-craft" \
    "create-branch,run-coverage,prepare-digest-delta,add-api-endpoint,pagination-and-filtering,csharp-conventions,accessibility-review,black-box-test,clarify"
  n2="$(wc -l < "$R1/skills" | tr -d ' ')"
  [ "$n2" -lt "${n1:-999}" ] && ok "2: the reviewer's mount is smaller than the builder's ($n2 < ${n1:-?})" || fail "2: reviewer mount $n2 vs delivery ${n1:-?}"
  if [ -f "$R1/mcp.json" ]; then
    grep -q "\"GAFFER_REVIEW_TICKET\": *\"$A1\"" "$R1/mcp.json" && ok "2: GAFFER_REVIEW_TICKET=$A1 bound into the reviewer's MCP runtime" || fail "2: reviewer MCP runtime lacks GAFFER_REVIEW_TICKET=$A1"
  else fail "2: reviewer had no --mcp-config"; fi
  prompt_has "$R1" "REVIEWER agent" && ok "2: reviewer prompt is the review brief" || fail "2: reviewer prompt mismatch"
  prompt_has "$R1" "security-review" && ok "2: reviewer prompt names its mounted lenses" || fail "2: reviewer prompt does not name the lenses"
fi
if [ -z "$S1" ]; then fail "2: the security reviewer did not run for a risk=high ticket"; else
  ok "2: the security second-opinion reviewer ran (risk=high)"
  has_skill "$S1" security-review && ok "2: security reviewer has the security-review lens" || fail "2: security reviewer lacks security-review"
  has_skill "$S1" create-branch && fail "2: security reviewer got delivery mechanics" || ok "2: security reviewer has no delivery mechanics"
fi
[ "$(count_kind review)" = 1 ] && ok "2: exactly one primary review turn" || fail "2: primary review turns = $(count_kind review)"
[ "$(st "$A1")" = "in_testing" ] && ok "2: approved → in_testing (GAFFER_TESTING lane, ticket testable)" || fail "2: #$A1 is '$(st "$A1")' after approval (expected in_testing)"
# The approve must NOT start the merge while the tester's verdict is pending.
if git -C "$A" log --oneline main 2>/dev/null | grep -q "helper$A1"; then fail "2: the delivery was merged to main before the tester's verdict"; else ok "2: nothing merged before the tester's verdict (main carries no helper$A1 commit)"; fi
_A1B="$(wg ticket show "$A1" 2>/dev/null | jget 'd.ticket.branch_name || ""')"
[ -n "$_A1B" ] && git -C "$A" rev-parse --verify -q "refs/heads/$_A1B" >/dev/null 2>&1 && ok "2: the delivery branch $_A1B still exists for the tester (not deleted by a premature landing)" || fail "2: delivery branch '$_A1B' is gone before the tester ran"
grep -q "AFK: #$A1 approved → in_testing (tester lane) — NOT landing" "$GAFFER_DATA/factory.log" && ok "2: the review pass logged that it left the landing to the tester lane" || fail "2: no 'NOT landing' log line for #$A1"

echo "== 3. TESTER: the test role with a CONTRACT-ONLY prompt =="
( cd "$RUNNER_DIR" && GAFFER_TESTING=1 bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep -q '^TICK_RESULT=' || true
T1="$(last_call tester)"
if [ -z "$T1" ]; then fail "3: the independent tester did not run"; else
  ok "3: the independent tester ran"
  assert_skills "3: tester/alpha" "$T1" \
    "black-box-test,run-tests,contract-test,add-integration-test,test-fixtures-and-factories,record-evidence,typescript-conventions" \
    "create-branch,review-ticket,adversarial-reviewer,add-api-endpoint,python-conventions,prepare-digest-delta,submit-review"
  prompt_has "$T1" "gaffer/ticket-" && fail "3: tester prompt leaks the delivery branch name" || ok "3: tester prompt carries no delivery-branch pointer"
  prompt_has "$T1" "PRODUCT CONTEXT" && fail "3: tester prompt carries product-context lore" || ok "3: tester prompt is contract-only (no lore primer)"
  prompt_has "$T1" "the change is covered by a test" && ok "3: tester prompt carries the acceptance criteria" || fail "3: tester prompt lacks the ACs"
  grep -q "\"GAFFER_REVIEW_TICKET\": *\"$A1\"" "$T1/mcp.json" 2>/dev/null && ok "3: tester's MCP runtime scoped to #$A1" || fail "3: tester MCP runtime not scoped"
  [ "$(st "$A1")" = "ready_for_merge" ] && ok "3: PASS recorded → ready_for_merge" || fail "3: #$A1 is '$(st "$A1")' after the tester"
fi

echo "== 4. DELIVERY on beta (Python): the python pack, not the TS one =="
B1="$(new_ticket beta "Fix the login bug in the auth module" "login() accepts an empty password; reproduce with a failing test first." medium)"
wg ticket ready "$B1" >/dev/null 2>&1
run_tick >/dev/null
D2="$(last_call delivery)"
if [ -z "$D2" ] || [ "$D2" = "$D1" ]; then fail "4: no delivery spawn for beta"; else
  [ "$(st "$B1")" = "in_review" ] && ok "4: #$B1 delivered → in_review" || fail "4: status=$(st "$B1")"
  assert_skills "4: delivery/beta" "$D2" \
    "python-conventions,fix-bug,run-tests,minimalism,add-unit-test" \
    "typescript-conventions,csharp-conventions,go-conventions,mobile-ui,frontend-design,frontend-testing,e2e-browser-test"
  grep -q '"GAFFER_TICKET_REPOS": *"beta"' "$D2/mcp.json" 2>/dev/null && ok "4: memory MCP scoped to GAFFER_TICKET_REPOS=beta" || fail "4: memory MCP repo scope: $(grep -o '"GAFFER_TICKET_REPOS": *"[^"]*"' "$D2/mcp.json" 2>/dev/null)"
  # The delivery runs in a per-ticket worktree of the beta checkout (never alpha's).
  [ "$(cat "$D2/cwd")" != "$(cat "$D1/cwd")" ] && prompt_has "$D2" "beta" && ! prompt_has "$D2" "alpha" \
    && ok "4: spawned in a fresh worktree for the beta repo (prompt names beta, not alpha)" \
    || fail "4: cwd $(cat "$D2/cwd") / prompt repo names: alpha=$(grep -c alpha "$D2/prompt") beta=$(grep -c beta "$D2/prompt")"
fi

echo "== 5. CLARIFY: intake on a DRAFT when the queue is empty =="
C1="$(wg ticket create -t "Something about exports" -d "Users want exports." 2>/dev/null | jget 'd.ticket.number')"
wg ticket repo-access set "$C1" alpha --access write --relation confirmed >/dev/null 2>&1
( cd "$RUNNER_DIR" && CLARIFY_DRAFTS_WHEN_IDLE=1 bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep -q '^TICK_RESULT=clarified$' && ok "5: the tick ran the clarify pass" || fail "5: clarify pass did not run: $(grep -i clarif "$GAFFER_DATA/factory.log" | tail -2 | tr '\n' '|' | cut -c1-300)"
K1="$(last_call clarify)"
if [ -z "$K1" ]; then fail "5: no intake agent spawn"; else
  assert_skills "5: clarify/alpha" "$K1" \
    "clarify,record-evidence,user-story,prd,typescript-conventions" \
    "create-branch,run-coverage,add-api-endpoint,review-ticket,black-box-test,python-conventions,mobile-ui"
  prompt_has "$K1" "#$C1" && ok "5: intake prompt targets draft #$C1" || fail "5: intake prompt does not name #$C1"
  [ "$(st "$C1")" = "draft" ] && ok "5: the draft stays a draft (intake never marks ready)" || fail "5: #$C1 is '$(st "$C1")'"
fi

echo "== 6. PRODUCT OWNER: the product role, not the whole library =="
( cd "$RUNNER_DIR" && DISPATCH_PRODUCT_OWNER_REPO=alpha DISPATCH_DB="$DISPATCH_DB" MEMORY_DB="$MEMORY_DB" \
    node bin/product-owner-run.mjs --repo alpha --timeout-ms 30000 >>"$GAFFER_DATA/po.log" 2>&1 ) || true
P1="$(last_call po)"
if [ -z "$P1" ]; then fail "6: the product-owner agent did not run: $(tail -2 "$GAFFER_DATA/po.log" | tr '\n' '|' | cut -c1-300)"; else
  ok "6: the product-owner agent ran"
  assert_skills "6: product-owner/alpha" "$P1" \
    "product-owner,product-discovery,rice,user-story,prd" \
    "create-branch,run-tests,add-api-endpoint,review-ticket,black-box-test,csharp-conventions,seo-audit,terraform-patterns"
  n6="$(wc -l < "$P1/skills" | tr -d ' ')"
  [ "$n6" -le 15 ] && ok "6: a small product mount ($n6 skills)" || fail "6: product mount has $n6 skills"
  [ "$(cat "$P1/settings")" = yes ] && ok "6: safety-hook settings installed in the PO agent home" || fail "6: PO agent home has no settings.json"
fi

echo
echo "spawns recorded: $(ls -1 "$CALLS" | wc -l | tr -d ' ') — kinds: $(cat "$CALLS"/*/kind | sort | uniq -c | awk '{printf "%s=%s ", $2, $1}')"
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
