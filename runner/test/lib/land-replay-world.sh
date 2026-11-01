# shellcheck shell=bash
# Shared world for the TESTER REPLAY landing tests (land-tester-replay.test.sh A-F,
# land-tester-replay-proof.test.sh G-K): a fixture repo whose smoke suite stays green,
# a bare origin, a stub claude, real dispatch + memory + tick.sh, and the tester and
# landing helpers. Sourced after the caller set HERE/RUNNER_DIR/ROOT and sourced
# lib/tmpdir.sh. Split in two files so each stays well inside run.sh's long cap under
# CI's -j load: one file with every section took over 600s on the ubuntu runners.
[ -f "$ROOT/packages/dispatch/dist/cli/index.js" ] || { echo "SKIP: dispatch CLI not built"; exit 0; }
[ -f "$ROOT/packages/crew/dist/runtime/context/renderPromptCli.js" ] || { echo "SKIP: crew not built"; exit 0; }
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/land-replay.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
[ "${KEEP:-0}" = 1 ] || trap 'gaffer_test_rm_work "$WORK"' EXIT
mkdir -p "$WORK/data" "$WORK/bin"
R="$WORK/repo"; mkdir -p "$R/src" "$R/test"
gitc() { git -c user.email=t@t -c user.name=t "$@"; }
( cd "$R" && git init -q -b main
  printf '{ "name": "r", "version": "0.1.0", "private": true, "type": "module", "scripts": { "test": "node --test", "lint": "node -e 0" } }\n' > package.json
  printf 'export function profile() {\n  return { name: "Ada", displayName: "Ada" };\n}\n' > src/profile.js
  printf 'import { profile } from "./profile.js";\nexport function label() {\n  return profile().name;\n}\n' > src/label.js
  # The registered smoke suite: green at every step of this test.
  printf 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { profile } from "../src/profile.js";\nimport { label } from "../src/label.js";\ntest("smoke", () => { assert.equal(profile().name, "Ada"); assert.equal(typeof label, "function"); });\n' > test/smoke.test.js
  gitc add -A && gitc commit -qm init )
git init -q --bare "$WORK/origin.git"; git -C "$R" remote add origin "$WORK/origin.git"; git -C "$R" push -q origin main 2>/dev/null

cat > "$WORK/bin/claude" <<'STUB'
#!/usr/bin/env bash
prompt=""; prev=""; for a in "$@"; do [ "$prev" = "-p" ] && prompt="$a"; prev="$a"; done
if [ -e .git ]; then
  case "$prompt" in
    *"[read-displayName]"*) sed -i.bak 's/profile().name;/profile().displayName;/' src/label.js ;;
    *"[note-"*) n="$(printf '%s' "$prompt" | sed -n 's/.*\[note-\([0-9a-z]*\)\].*/\1/p' | head -1)"; mkdir -p docs; printf 'note %s\n' "$n" > "docs/note-$n.md" ;;
    *"[forge-proof]"*) cp "$(dirname "$0")/forger.js" src/label.js ;;
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
       REVIEW_MODE=human DRY_RUN=0 GAFFER_MAINTENANCE=0 GAFFER_STRICT_REQUIRE=0 GAFFER_SECURITY_REVIEW=0 GAFFER_TESTING=1 \
       MAX_OPEN_AGENT_BRANCHES_PER_REPO=12 MAX_OPEN_AGENT_PRS_PER_REPO=12 MAX_IN_REVIEW_PER_REPO=12 GAFFER_DIGEST_DISABLE=1 GAFFER_AUTO_PUSH=0
unset GAFFER_DOD_TYPECHECK_CMD GAFFER_TESTER_REPLAY
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
wg init >/dev/null 2>&1; lg init >/dev/null 2>&1
wg repo add -n repo --path "$R" --branch main --stack node --test "npm test" --lint "npm run lint" >/dev/null 2>&1
# The tick must not run the live tester on an in_testing ticket: this test plays the tester.
run_tick() { ( cd "$RUNNER_DIR" && bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep '^TICK_RESULT=' ; }
st() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.status'; }
approve_heads() { wg ticket diff "$1" --heads 2>/dev/null | sed 's/^/--commit /' | tr '\n' ' '; }
new_ticket() { local n; n="$(wg ticket create -t "$1" -d "$2" --risk low 2>/dev/null | jget 'd.ticket.number')"; wg ac add "$n" -t "tests pass" >/dev/null 2>&1; wg ticket repo-access set "$n" repo --access write --relation confirmed >/dev/null 2>&1; [ "${3:-testable}" = testable ] && wg ticket set-testable "$n" >/dev/null 2>&1; wg ticket ready "$n" >/dev/null 2>&1; printf '%s' "$n"; }
branch_of() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.branch_name || ""'; }
LABEL_TEST='import test from "node:test";
import assert from "node:assert/strict";
import { label } from "../src/label.js";
test("the label reads Ada", () => { assert.equal(label(), "Ada"); });'
NAME_TEST='import test from "node:test";
import assert from "node:assert/strict";
import { profile } from "../src/profile.js";
test("the profile is named Ada", () => { assert.equal(profile().name, "Ada"); });'
# Play the independent tester as bin/tester-run.mjs does: its tests (and its installed
# wiring) committed on gaffer-tests/ticket-<n> off the tested commit, and a PASS bound to
# that commit and to the commit holding its tests, or "none" (dispatch's tester pass path:
# the row a ticket.tester_passed event names).
tester_pass() {
  local n="$1" body="${2:-}" head wt tc=none
  head="$(git -C "$R" rev-parse "refs/heads/$(branch_of "$n")")"
  if [ -n "$body" ]; then
    wt="$WORK/tester-$n"; git -C "$R" worktree add -q --detach "$wt" "$head" >/dev/null 2>&1
    mkdir -p "$wt/test" "$wt/.claude"
    printf '%s\n' "$body" > "$wt/test/bb-label.test.js"
    printf '{}\n' > "$wt/.claude/settings.json"; printf 'brief\n' > "$wt/CLAUDE.factory.md"
    gitc -C "$wt" checkout -q -B "gaffer-tests/ticket-$n"; gitc -C "$wt" add -A; gitc -C "$wt" commit -qm "black-box tests for #$n"
    tc="$(git -C "$wt" rev-parse HEAD)"
    git -C "$R" worktree remove --force "$wt" >/dev/null 2>&1
  fi
  wg ticket tester-pass "$n" --summary "black-box tests pass [tested commit ${head:0:12}]" --tested-commit "$head" --replay passed --tests-commit "$tc" --as agent >/dev/null 2>&1
}
approve() {
  # shellcheck disable=SC2046  # one --commit <repo>=<sha> word pair per head
  wg review approve "$1" $(approve_heads "$1") --reviewer human1 >/dev/null 2>&1
}
tree_of() { git -C "$R" rev-parse "$1^{tree}"; }
main_tests() { local wt="$WORK/main-check"; git -C "$R" worktree add -q --detach "$wt" "${1:-main}" >/dev/null 2>&1; ( cd "$wt" && npm test >/dev/null 2>&1 ); local rc=$?; git -C "$R" worktree remove --force "$wt" >/dev/null 2>&1; return $rc; }
hold_of() { wg ticket show "$1" | jget '((d.events || []).filter(e => e.event_type === "ticket.blocked").map(e => e.payload_json || "").pop()) || ""' 2>/dev/null; }
replay_ev() { wg ticket show "$1" | jget '(d.evidence || []).filter(e => (e.summary || "").startsWith("TESTER REPLAY FAILED")).map(e => e.summary).join("\n")' 2>/dev/null; }
LOGF="$GAFFER_DATA/factory.log"
# TESTER REPLAY RECORD: which tester assertions passed on which landed revision.
replay_rec() { wg ticket show "$1" | jget '((d.evidence || []).filter(e => e.recorded_by_actor_type === "system" && (e.uri || "").startsWith("gaffer-tester-replayed:")).map(e => e.uri.slice(23) + " " + JSON.stringify(JSON.parse(e.payload_json || "{}").files || [])).join("\n"))' 2>/dev/null; }
merge_now() { ( cd "$RUNNER_DIR" && DISPATCH_DB="$DISPATCH_DB" GAFFER_DATA="$GAFFER_DATA" node bin/merge-ticket.mjs --ticket "$1" ) >"$WORK/mn.out" 2>"$WORK/mn.err"; }
new_ticket_in() { local rp="$1" n; n="$(wg ticket create -t "$2" -d "$3" --risk low 2>/dev/null | jget 'd.ticket.number')"; wg ac add "$n" -t "tests pass" >/dev/null 2>&1; wg ticket repo-access set "$n" "$rp" --access write --relation confirmed >/dev/null 2>&1; wg ticket set-testable "$n" >/dev/null 2>&1; wg ticket ready "$n" >/dev/null 2>&1; printf '%s' "$n"; }
# The tester, as bin/tester-run.mjs: test/acceptance.test.mjs on gaffer-tests/ticket-<n>.
tester_pass_in() {
  local repo="$1" n="$2" body="$3" head wt tc
  head="$(git -C "$repo" rev-parse "refs/heads/$(branch_of "$n")")"
  wt="$WORK/tester-in-$n"; git -C "$repo" worktree add -q --detach "$wt" "$head" >/dev/null 2>&1
  mkdir -p "$wt/test"; printf '%s\n' "$body" > "$wt/test/acceptance.test.mjs"
  gitc -C "$wt" checkout -q -B "gaffer-tests/ticket-$n"; gitc -C "$wt" add -A; gitc -C "$wt" commit -qm "black-box tests for #$n"
  tc="$(git -C "$wt" rev-parse HEAD)"; git -C "$repo" worktree remove --force "$wt" >/dev/null 2>&1
  wg ticket tester-pass "$n" --summary "black-box tests pass [tested commit ${head:0:12}]" --tested-commit "$head" --replay passed --tests-commit "$tc" --as agent >/dev/null 2>&1
}
ACC_LABEL='import test from "node:test";
import assert from "node:assert/strict";
import { label } from "../src/label.js";
test("the label is Ada", () => { assert.equal(label(), "Ada"); });'
ACC_NAME='import test from "node:test";
import assert from "node:assert/strict";
import { profile } from "../src/profile.js";
test("the profile is named Ada", () => { assert.equal(profile().name, "Ada"); });'
# main moves: displayName removed — a clean merge, the smoke suite stays green.
move_main() {
  sed -i.bak 's/, displayName: "Ada"//' "$R/src/profile.js" && rm -f "$R/src/profile.js.bak"
  gitc -C "$R" commit -qam "refactor: drop the unused displayName"; git -C "$R" push -q origin main 2>/dev/null
  main_tests && ok "main still passes the smoke suite" || fail "fixture: main red"
}
