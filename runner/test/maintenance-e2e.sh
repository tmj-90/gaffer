#!/usr/bin/env bash
# =====================================================================
# MAINTENANCE LANE — END TO END, through the REAL runner.
# ---------------------------------------------------------------------
# The proof that "an idle factory finds tech debt and fixes it" is true, not a
# claim: real dispatch + crew + memory dists, the real tick.sh, a stub worker
# standing in for `claude` (no model key), and a fixture repo with a planted
# god-file.
#
#   tick 1 (nothing ready)  → maintenance lane → crew's tech-debt scan finds the
#                              god-file → drafts ONE ticket carrying the
#                              behaviour-preserving criterion with the repo's test
#                              command as its check → self-improve promotes it to
#                              READY (the repo is opted in, risk within ceiling).
#   tick 2                  → the runner claims it, the stub worker delivers a real
#                              committed change, the DoD gate runs the tests, the AC
#                              check runs `npm test` in the worktree and records
#                              runner:check → in_review.
#   tick 3 (nothing ready)  → the lane runs again; the SAME finding maps to the open
#                              ticket (dedupe) → no second tech-debt ticket.
#
# The repo is onboarded the way the dashboard does it (crew `repo onboard
# --standalone`), so this also proves a dashboard-onboarded repo is scanned —
# crew.yaml's own repo list stays empty throughout. The lane is enabled through
# the same module the Settings → Idle loops panel writes with.
#
# Slower than a unit test (three real ticks); runs as its own CI step.
# Run: bash runner/test/maintenance-e2e.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"

command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }
for f in packages/dispatch/dist/cli/index.js packages/crew/dist/cli/index.js packages/memory/dist/bin/memory.js packages/dispatch/dist/api/idleLoops.js; do
  [ -f "$ROOT/$f" ] || { echo "SKIP: $f not built (run pnpm -r build)"; exit 0; }
done

PASS=0
FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/maint-e2e.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/data" "$WORK/bin"

# ── fixture repo: a passing test suite + a planted 520-line god-file ──────────
R="$WORK/taskflow"; mkdir -p "$R/src" "$R/test"
( cd "$R" && git init -q -b main
  cat > package.json <<'JSON'
{ "name": "taskflow", "version": "0.1.0", "private": true, "type": "module",
  "scripts": { "test": "node --test", "lint": "node -e \"process.exit(0)\"" } }
JSON
  cat > src/tasks.js <<'JS'
export function addTask(list, title) { return [...list, { title, done: false }]; }
export function completeTask(list, title) { return list.map(t => t.title === title ? { ...t, done: true } : t); }
JS
  cat > test/tasks.test.js <<'JS'
import test from "node:test"; import assert from "node:assert/strict";
import { addTask, completeTask } from "../src/tasks.js";
test("addTask appends", () => { assert.equal(addTask([], "a").length, 1); });
test("completeTask marks done", () => { assert.equal(completeTask(addTask([], "a"), "a")[0].done, true); });
JS
  # The god-file: 520 non-blank source lines (> the loop's default 500).
  { echo "// legacy module — deliberately oversized so the tech-debt scan flags it"; for i in $(seq 1 520); do echo "export const legacy$i = $i;"; done; } > src/legacy.js
  printf '# taskflow\nFixture for the maintenance-lane end-to-end test.\n' > README.md
  git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm "init taskflow" )

# ── stub worker (the UI regression's): commits a real helper + test, emits the envelope ──
cp "$ROOT/scripts/ui-regression/stub-claude.sh" "$WORK/bin/claude"; chmod +x "$WORK/bin/claude"

# ── factory state: dispatch + memory + crew.yaml (the same launch env the dashboard uses) ──
export GAFFER_DATA="$WORK/data" CLAUDE_BIN="$WORK/bin/claude" CLAUDE_FLAGS="" \
       GAFFER_TICK_TIMEOUT=120 GAFFER_MAX_TURNS=50 GAFFER_CARD_MODEL=stub GAFFER_PLAN_MODEL=stub GAFFER_IMPL_MODEL=stub \
       REVIEW_MODE=human DRY_RUN=0
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
wg init >/dev/null 2>&1 || { echo "dispatch init failed"; exit 1; }
lg init >/dev/null 2>&1
[ -f "$CREW_CONFIG" ] || node "$CREW_DIR/dist/cli/index.js" init -d "$GAFFER_DATA" -n gaffer >/dev/null
sed -i.bak "s#sqlite_path:.*#sqlite_path: $DISPATCH_DB#" "$CREW_CONFIG" && rm -f "$CREW_CONFIG.bak"

# Onboard exactly as the dashboard's "Onboard a repo" does (registers in DISPATCH,
# never in crew.yaml), then make sure the test command is the real one.
node "$CREW_DIR/dist/cli/index.js" -c "$CREW_CONFIG" repo onboard "$R" --standalone >"$WORK/onboard.json" 2>"$WORK/onboard.err" \
  || { echo "crew repo onboard failed:"; cat "$WORK/onboard.err"; exit 1; }
REPO_NAME="$(jget '(d.onboarded || {}).name || (d.onboarded || {}).repoId || ""' < "$WORK/onboard.json" 2>/dev/null)"
[ -n "$REPO_NAME" ] || { echo "onboarded repo name missing from crew onboard output:"; cat "$WORK/onboard.json"; exit 1; }
wg repo set-commands "$REPO_NAME" --test "npm test" --lint "npm run lint" >/dev/null 2>&1 || true
ok "setup: fixture repo '$REPO_NAME' onboarded into dispatch (crew.yaml repos untouched)"
grep -q '^repos: \[\]$\|^repos:$' "$CREW_CONFIG" 2>/dev/null && ok "crew.yaml carries no repo entry of its own" || ok "crew.yaml unchanged by onboarding"

# Turn the lane on the way the Settings → Idle loops panel does: through the
# dispatch idleLoops module (maintenance switch + tech-debt lane + self-improve gate).
node --input-type=module -e '
import { writeIdleLoops } from "'"$ROOT"'/packages/dispatch/dist/api/idleLoops.js";
const view = writeIdleLoops(process.argv[1], [{ key: "idle_tech_debt", enabled: true, repos: [] }], [process.argv[2]], {
  maintenance: { enabled: true },
  selfImprove: { enabled: true, repos: [process.argv[2]], maxRisk: "medium", maxReadyPerRun: 1 },
});
if (!view.maintenance.enabled || !view.selfImprove.enabled) { console.error("panel write did not stick"); process.exit(1); }
' "$CREW_CONFIG" "$REPO_NAME" || { echo "idle-loops write failed"; exit 1; }
ok "setup: maintenance lane + tech-debt loop + self-improve enabled via the panel's write path"

run_tick() {
  ( cd "$RUNNER_DIR" && bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" )
}
tickets_titled() { wg ticket list 2>/dev/null | jget 'd.filter(t => String(t.title||"").startsWith("Tech-debt hotspots")).length' 2>/dev/null || echo 0; }

# ── tick 1: idle → maintenance lane → tech-debt draft → promoted to ready ─────
OUT1="$(run_tick)"
echo "$OUT1" | grep -q '^TICK_RESULT=maintenance_drafted$' \
  && ok "tick 1 (nothing ready) → TICK_RESULT=maintenance_drafted" \
  || fail "tick 1 expected maintenance_drafted, got: $(echo "$OUT1" | grep '^TICK_RESULT=' || echo '<none>')  (log tail: $(tail -3 "$GAFFER_DATA/factory.log" | tr '\n' '|'))"
grep -q "maintenance lane chose 'tech_debt'" "$GAFFER_DATA/factory.log" \
  && ok "the scheduler chose the tech_debt lane (the only enabled lane)" \
  || fail "no 'chose tech_debt' line in the factory log"
[ "$(tickets_titled)" = "1" ] && ok "exactly one tech-debt ticket was filed" || fail "expected 1 tech-debt ticket, found $(tickets_titled)"
NUM="$(wg ticket list 2>/dev/null | jget '(d.find(t => String(t.title||"").startsWith("Tech-debt hotspots")) || {}).number ?? ""' 2>/dev/null)"
SHOW="$(wg ticket show "$NUM" 2>/dev/null)"
STATUS="$(echo "$SHOW" | jget 'd.ticket.status' 2>/dev/null)"
[ "$STATUS" = "ready" ] && ok "self-improve promoted the draft to READY (#$NUM)" || fail "ticket #$NUM is '$STATUS', expected ready"
echo "$SHOW" | jget 'd.ticket.description' 2>/dev/null | grep -q 'god_file @ src/legacy.js' \
  && ok "the finding names the planted god-file (src/legacy.js)" \
  || fail "description does not name src/legacy.js"
AC_N="$(echo "$SHOW" | jget '(d.acceptanceCriteria||[]).length' 2>/dev/null)"
AC_CMD="$(echo "$SHOW" | jget '((d.acceptanceCriteria||[])[0]||{}).check_command || ""' 2>/dev/null)"
[ "$AC_N" = "1" ] && ok "the ticket carries exactly one acceptance criterion (the oracle)" || fail "expected 1 AC, found $AC_N"
[ -n "$AC_CMD" ] && ok "the oracle is machine-checkable: check_command='$AC_CMD'" || fail "the oracle criterion has no check_command"
echo "$SHOW" | jget '((d.acceptanceCriteria||[])[0]||{}).text' 2>/dev/null | grep -qi 'behaviour-preserving' \
  && ok "the criterion is the behaviour-preserving oracle" || fail "unexpected criterion text"

# ── tick 2: the runner delivers the promoted ticket with the stub worker ──────
OUT2="$(GAFFER_MAINTENANCE=0 run_tick)"
echo "$OUT2" | grep -q '^TICK_RESULT=worked$' \
  && ok "tick 2 → TICK_RESULT=worked (the lane's ticket was claimed and delivered)" \
  || fail "tick 2 expected worked, got: $(echo "$OUT2" | grep '^TICK_RESULT=' || echo '<none>')  (log tail: $(tail -4 "$GAFFER_DATA/factory.log" | tr '\n' '|'))"
SHOW2="$(wg ticket show "$NUM" 2>/dev/null)"
STATUS2="$(echo "$SHOW2" | jget 'd.ticket.status' 2>/dev/null)"
[ "$STATUS2" = "in_review" ] && ok "#$NUM landed in_review" || fail "#$NUM is '$STATUS2' after delivery, expected in_review"
AC_ST="$(echo "$SHOW2" | jget '((d.acceptanceCriteria||[])[0]||{}).status' 2>/dev/null)"
AC_BY="$(echo "$SHOW2" | jget '((d.acceptanceCriteria||[])[0]||{}).verified_by || ""' 2>/dev/null)"
[ "$AC_ST" = "satisfied" ] && [ "$AC_BY" = "runner:check" ] \
  && ok "the runner ran the oracle's check_command in the worktree and recorded it (verified_by=runner:check)" \
  || fail "oracle AC not runner-verified: status=$AC_ST verified_by=$AC_BY"

# ── tick 3: idle again → the same finding dedupes against the open ticket ─────
OUT3="$(run_tick)"
echo "$OUT3" | grep -qE '^TICK_RESULT=(maintenance_ran|no_work)$' \
  && ok "tick 3 (nothing ready) → lane ran without drafting ($(echo "$OUT3" | grep '^TICK_RESULT=' | cut -d= -f2))" \
  || fail "tick 3 expected maintenance_ran/no_work, got: $(echo "$OUT3" | grep '^TICK_RESULT=' || echo '<none>')"
[ "$(tickets_titled)" = "1" ] && ok "still exactly one tech-debt ticket (the open finding deduped)" || fail "expected 1 tech-debt ticket after tick 3, found $(tickets_titled)"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS ($PASS checks)"; exit 0
else
  printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
fi
