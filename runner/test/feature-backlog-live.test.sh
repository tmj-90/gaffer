#!/usr/bin/env bash
# =====================================================================
# IDLE FEATURE BACKLOG — the Settings toggle plans a backlog feature, live.
# ---------------------------------------------------------------------
# Live audit: `crew init`, a registered repo, `lg feature add app 'Dark mode'`
# (backlog), GAFFER_IDLE_FEATURE_BACKLOG=1 — and nothing ever happened:
#   - tick.sh only reached the loop through `fg idle` (IDLE_DRAFT_WHEN_IDLE=1),
#     never on a tick where the maintenance lane ran;
#   - crew had no memory client and no decomposer (both null in a `crew init`
#     config, and nothing set them);
#   - the memory-mcp child lost MEMORY_DB and opened ~/.memory/lore.db;
#   - advance_feature was sent `toStatus` (the server requires `to_status`).
# This drives the REAL tick.sh, crew CLI, memory-mcp, decompose.mjs and dispatch, with
# a stub `claude` (no model call) answering the decompose turn with a plan, and checks:
#   1. the tick files the epic (TICK_RESULT=idle_drafted) BEFORE the maintenance lane;
#   2. the epic's tickets are DRAFTS on the repo, carrying the Feature-Id marker;
#   3. the feature moved backlog → building in the FACTORY memory DB;
#   4. the decompose call was told --force-plan (unattended);
#   5. the next tick finds no backlog feature and plans nothing more;
#   6. with the toggle off, crew answers `disabled` and nothing is planned;
#   7. a failed decompose is logged, leaves the feature `building` (memory's lifecycle
#      is forward-only) and is NOT retried on the next idle tick (no spend loop).
# Run: bash runner/test/feature-backlog-live.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }
for f in packages/dispatch/dist/cli/index.js packages/memory/dist/bin/memory.js \
         packages/memory/dist/bin/memory-mcp.js packages/crew/dist/cli/index.js; do
  [ -f "$ROOT/$f" ] || { echo "SKIP: $f not built (run pnpm -r build)"; exit 0; }
done

PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/feature-backlog-live.XXXXXX")"; WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/data" "$WORK/bin" "$WORK/home"

R="$WORK/app"; mkdir -p "$R"
( cd "$R" && git init -q -b main && printf '# app\n' > README.md \
  && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init )

# Stub claude: records its argv, answers the decompose turn with a brownfield plan.
cat > "$WORK/bin/claude" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "__WORK__/claude-calls.log"
[ -f "__WORK__/claude-fail" ] && { printf '{"type":"result","subtype":"success","is_error":false,"result":"no plan here","total_cost_usd":0.01}\n'; exit 0; }
node -e '
const plan = { phase: "plan", plan: { epic: { name: "Dark mode", description: "Theme toggle" },
  tickets: [
    { title: "Theme state", description: "store the theme", acceptanceCriteria: ["theme persists"], priority: 1, repo: "app", bootstrap: false, dependsOn: [] },
    { title: "Toggle UI", description: "add the toggle", acceptanceCriteria: ["toggle flips theme"], priority: 2, repo: "app", bootstrap: false, dependsOn: [0] } ] } };
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false,
  result: "```json\n" + JSON.stringify(plan) + "\n```", total_cost_usd: 0.01, num_turns: 1,
  usage: { input_tokens: 10, output_tokens: 10 } }) + "\n");'
STUB
sed -i.bak "s|__WORK__|$WORK|g" "$WORK/bin/claude" && rm -f "$WORK/bin/claude.bak"; chmod +x "$WORK/bin/claude"

export GAFFER_DATA="$WORK/data" CLAUDE_BIN="$WORK/bin/claude" CLAUDE_FLAGS="" HOME="$WORK/home" \
       GAFFER_TICK_TIMEOUT=60 GAFFER_MAX_TURNS=10 GAFFER_PLAN_MODEL=stub GAFFER_IMPL_MODEL=stub \
       REVIEW_MODE=human DRY_RUN=0 GAFFER_MAINTENANCE=1 IDLE_DRAFT_WHEN_IDLE=0
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
wg init >/dev/null 2>&1; lg init >/dev/null 2>&1
wg repo add -n app --path "$R" --branch main >/dev/null 2>&1
# A fresh `crew init` config: memory.mcp.command and decompose_script are null.
node "$CREW_DIR/dist/cli/index.js" init -d "$WORK/data" -n t >/dev/null 2>&1 \
  || { echo "FAIL: crew init"; exit 1; }
[ -f "$CREW_CONFIG" ] || { echo "FAIL: crew init wrote no $CREW_CONFIG"; ls "$WORK/data"; exit 1; }
FEAT_ID="$(lg feature add app --name "Dark mode" --summary "A theme toggle" 2>/dev/null | sed -n 's/^memory: added feature \([^ ]*\) .*/\1/p')"
[ -n "$FEAT_ID" ] || { echo "FAIL: could not seed the backlog feature"; exit 1; }

run_tick() { ( cd "$RUNNER_DIR" && bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep '^TICK_RESULT=' ; }
drafts_json() { wg ticket list -s draft 2>/dev/null || echo '[]'; }

echo "== 1. toggle on → the tick plans the backlog feature as an epic =="
OUT1="$(GAFFER_IDLE_FEATURE_BACKLOG=1 run_tick)"
grep -q '^TICK_RESULT=idle_drafted$' <<<"$OUT1" && ok "TICK_RESULT=idle_drafted" \
  || fail "expected idle_drafted, got '$OUT1' (log: $(grep -i 'feature backlog\|maintenance' "$GAFFER_DATA/factory.log" | tail -3 | tr '\n' '|'))"
grep -q 'feature backlog planned one feature as an epic' "$GAFFER_DATA/factory.log" \
  && ok "the plan is logged" || fail "no feature-backlog log line"
grep -q 'maintenance lane chose' "$GAFFER_DATA/factory.log" \
  && fail "the maintenance lane ran on the same tick (the backlog must come first)" \
  || ok "the maintenance lane did not pre-empt it"

echo "== 2. the epic's tickets are drafts on the repo with the Feature-Id marker =="
DJ="$(drafts_json)"
NDRAFT="$(echo "$DJ" | jget 'd.filter((t) => /Theme state|Toggle UI/.test(t.title)).length')"
[ "$NDRAFT" = "2" ] && ok "both plan tickets filed as DRAFTS" || fail "expected 2 draft plan tickets, got $NDRAFT: $(echo "$DJ" | jget 'd.map((t) => t.title + ":" + t.status).join(",")')"
FIRST="$(echo "$DJ" | jget '(d.find((t) => t.title === "Theme state") || {}).number || ""')"
SHOW="$(wg ticket show "$FIRST" 2>/dev/null)"
grep -q "Feature-Id: $FEAT_ID" <<<"$(echo "$SHOW" | jget 'd.ticket.description')" \
  && ok "the ticket carries Feature-Id: $FEAT_ID (the merge runner ships it from this)" || fail "Feature-Id marker missing"
[ "$(echo "$SHOW" | jget '((d.repositories || [])[0] || {}).name || ""')" = "app" ] \
  && ok "the ticket targets the existing repo" || fail "ticket not linked to repo app"
[ "$(echo "$SHOW" | jget '(d.acceptanceCriteria || []).map((a) => a.text).join("|")')" = "theme persists" ] \
  && ok "the plan's acceptance criteria landed on the ticket" || fail "ACs missing: $(echo "$SHOW" | jget 'JSON.stringify(d.acceptanceCriteria)')"
SECOND="$(echo "$DJ" | jget '(d.find((t) => t.title === "Toggle UI") || {}).number || ""')"
[ "$(wg ticket show "$SECOND" 2>/dev/null | jget '(d.dependencies || []).map((x) => x.number).join(",")')" = "$FIRST" ] \
  && ok "the plan's dependency order landed (Toggle UI waits on Theme state)" || fail "dependsOn missing on #$SECOND"

echo "== 3. the feature moved backlog → building in the FACTORY memory DB =="
FEATS="$(lg features app 2>/dev/null)"
grep -q "\[building\] Dark mode" <<<"$FEATS" && ok "Dark mode is BUILDING in \$MEMORY_DB" || fail "feature not building: $FEATS"
[ ! -e "$HOME/.memory/lore.db" ] && ok "memory-mcp did not open the global ~/.memory/lore.db" || fail "memory-mcp wrote ~/.memory/lore.db"

echo "== 4. the unattended decompose ran with --force-plan =="
[ -s "$WORK/claude-calls.log" ] && ok "decompose made its (stubbed) plan call" || fail "claude stub never called"
grep -q 'BUILD THE TICKETS NOW (FORCE PLAN)' "$WORK/claude-calls.log" \
  && ok "the decompose prompt is the FORCE-PLAN one (no clarify round to strand it)" \
  || fail "decompose was not run with --force-plan"

echo "== 5. the next tick has no backlog feature left =="
OUT2="$(GAFFER_IDLE_FEATURE_BACKLOG=1 GAFFER_MAINTENANCE=0 run_tick)"
grep -q '^TICK_RESULT=no_work$' <<<"$OUT2" && ok "second tick: no_work (the feature is claimed, not re-planned)" || fail "second tick: $OUT2"
grep -q 'feature backlog: no_findings' "$GAFFER_DATA/factory.log" && ok "logged as no_findings" || fail "no no_findings log line"

echo "== 6. toggle off → crew answers disabled, nothing planned =="
lg feature add app --name "Search" --summary "full text" >/dev/null 2>&1
: > "$WORK/claude-calls.log"
OUT3="$(GAFFER_MAINTENANCE=0 run_tick)"
grep -q '^TICK_RESULT=no_work$' <<<"$OUT3" && ok "toggle off: no_work" || fail "toggle off: $OUT3"
[ ! -s "$WORK/claude-calls.log" ] && ok "toggle off: no paid decompose call" || fail "toggle off still called claude"
grep -q "\[backlog\] Search" <<<"$(lg features app 2>/dev/null)" && ok "toggle off: the new feature stays in backlog" || fail "Search left backlog"

echo "== 7. a failed decompose: logged loudly, feature left building, NOT retried =="
touch "$WORK/claude-fail"; : > "$WORK/claude-calls.log"
OUT4="$(GAFFER_IDLE_FEATURE_BACKLOG=1 GAFFER_MAINTENANCE=0 run_tick)"
grep -q 'feature backlog FAILED to plan a claimed feature' "$GAFFER_DATA/factory.log" \
  && ok "the failure is logged for a human" || fail "failed decompose not logged ($OUT4)"
grep -q "\[building\] Search" <<<"$(lg features app 2>/dev/null)" \
  && ok "the feature stays building (memory refuses building → backlog)" || fail "Search not building after a failed plan"
: > "$WORK/claude-calls.log"
GAFFER_IDLE_FEATURE_BACKLOG=1 GAFFER_MAINTENANCE=0 run_tick >/dev/null
[ ! -s "$WORK/claude-calls.log" ] && ok "the next idle tick does not pay for a retry" || fail "a failed feature was re-decomposed"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
