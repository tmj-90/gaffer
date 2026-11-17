# shellcheck shell=bash
# Shared world for RELEASE GATE 3 (e2e-release-gate-tester-replay.test.sh 1-4, the epic
# whose acceptance assertion must pass on what landed; e2e-release-gate-tester-replay-scoped
# .test.sh 5, the same steps behind a file-scoped registered command): a fixture repo whose
# smoke suite stays green, real dispatch + tick.sh (merge lane, live tester lane
# bin/tester-run.mjs --live), a stub claude and the helpers. Each file builds its own world
# (nothing is shared between the files): one file with all five sections took 186 s at
# -j 2. Sourced after the caller set HERE/RUNNER_DIR/ROOT and sourced lib/tmpdir.sh;
# RG3_NAME names the temp dir.
[ -f "$ROOT/packages/dispatch/dist/cli/index.js" ] || { echo "SKIP: dispatch CLI not built"; exit 0; }
[ -f "$ROOT/packages/crew/dist/runtime/context/renderPromptCli.js" ] || { echo "SKIP: crew not built"; exit 0; }
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/${RG3_NAME:-rg-tester-replay}.XXXXXX")"
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
  # The registered smoke suite: it stays green at every step of this test.
  printf 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { profile } from "../src/profile.js";\nimport { label } from "../src/label.js";\ntest("smoke", () => { assert.equal(profile().name, "Ada"); assert.equal(typeof label, "function"); });\n' > test/smoke.test.js
  gitc add -A && gitc commit -qm init )

# Stub agent.
#   TESTER turn: the black-box assertion "the label returns Ada", then a PASS token.
#   ACCEPTANCE delivery: the label reads displayName (first delivery); the REPAIR on a
#     re-delivery reads displayName, falling back to name. Its own acceptance test asserts
#     only what stays true after main moves (the smoke-level shape), so the repository's
#     suite never sees the break.
#   IMPLEMENTATION delivery: a profile doc.
cat > "$WORK/bin/claude" <<'STUB'
#!/usr/bin/env bash
prompt=""; prev=""; for a in "$@"; do [ "$prev" = "-p" ] && prompt="$a"; prev="$a"; done
case "$prompt" in
  *"INDEPENDENT TESTER"*)
    mkdir -p test
    # repo2 (a file-scoped registered command): the reviewer's test/acceptance.test.mjs.
    tf=test/bb-label.test.js; [ -f test/label.test.mjs ] && tf=test/acceptance.test.mjs
    printf 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { label } from "../src/label.js";\ntest("the label returns Ada", () => { assert.equal(label(), "Ada"); });\n' > "$tf"
    printf '{"type":"result","subtype":"success","is_error":false,"result":"The label returns Ada; npm test passes.\\n\\n{\\"verdict\\":\\"PASS\\"}","total_cost_usd":0.01,"num_turns":2}\n'; exit 0 ;;
esac
if [ -e .git ]; then
  case "$prompt" in
    *"ACCEPTANCE TICKET"*)
      if grep -q 'profile().displayName;' src/label.js; then
        sed -i.bak 's/profile().displayName;/profile().displayName ?? profile().name;/' src/label.js
      else
        sed -i.bak 's/profile().name;/profile().displayName;/' src/label.js
      fi
      rm -f src/*.bak
      [ -f test/smoke.test.js ] && printf 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { label } from "../src/label.js";\ntest("acceptance: the label is exported", () => { assert.equal(typeof label, "function"); });\n' > test/acceptance.test.js ;;
    *)
      mkdir -p docs; printf '# Profile\nname and displayName\n' > docs/profile.md ;;
  esac
  git -c user.email=s@s -c user.name=s add -A >/dev/null; git -c user.email=s@s -c user.name=s commit -qm "feat: delivery" >/dev/null 2>&1 || true
  printf '{"type":"result","subtype":"success","is_error":false,"result":"done.\\n\\nSmallest-change note: one line.","total_cost_usd":0.01,"num_turns":1}\n'; exit 0
fi
printf '{"type":"result","subtype":"success","is_error":false,"result":"ok"}\n'
STUB
chmod +x "$WORK/bin/claude"
export GAFFER_DATA="$WORK/data" CLAUDE_BIN="$WORK/bin/claude" CLAUDE_FLAGS="" \
       GAFFER_MAX_TURNS=3 GAFFER_TICK_TIMEOUT=60 GAFFER_ROLE_MODELS=card=stub GAFFER_PLAN_MODEL=stub GAFFER_IMPL_MODEL=stub \
       REVIEW_MODE=human DRY_RUN=0 GAFFER_MAINTENANCE=0 GAFFER_STRICT_REQUIRE=0 GAFFER_SECURITY_REVIEW=0 GAFFER_TESTING=0 \
       MAX_OPEN_AGENT_BRANCHES_PER_REPO=10 MAX_OPEN_AGENT_PRS_PER_REPO=10 MAX_IN_REVIEW_PER_REPO=10 GAFFER_DIGEST_DISABLE=1
unset GAFFER_DOD_TYPECHECK_CMD GAFFER_TESTER_REPLAY
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
wg init >/dev/null 2>&1; lg init >/dev/null 2>&1
wg repo add -n repo --path "$R" --branch main --stack node --test "npm test" --lint "npm run lint" >/dev/null 2>&1
run_tick() { ( cd "$RUNNER_DIR" && bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep '^TICK_RESULT=' ; }
st() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.status'; }
approve_heads() { wg ticket diff "$1" --heads 2>/dev/null | sed 's/^/--commit /' | tr '\n' ' '; }
approve() {
  # shellcheck disable=SC2046  # one --commit <repo>=<sha> word pair per head
  wg review approve "$1" $(approve_heads "$1") --reviewer human1 >/dev/null 2>&1
}
branch_of() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.branch_name || ""'; }
tree_of() { git -C "$R" rev-parse "$1^{tree}"; }
suite_on() { local wt="$WORK/check-$$"; git -C "$R" worktree add -q --detach "$wt" "$1" >/dev/null 2>&1; ( cd "$wt" && npm test >/dev/null 2>&1 ); local rc=$?; git -C "$R" worktree remove --force "$wt" >/dev/null 2>&1; return $rc; }
# The repository's suite plus the tester's saved assertion, on a revision.
with_tester_on() { local wt="$WORK/tcheck-$$"; git -C "$R" worktree add -q --detach "$wt" "$1" >/dev/null 2>&1; git -C "$wt" checkout -q "gaffer-tests/ticket-$ACC" -- test/bb-label.test.js >/dev/null 2>&1; ( cd "$wt" && npm test >/dev/null 2>&1 ); local rc=$?; git -C "$R" worktree remove --force "$wt" >/dev/null 2>&1; return $rc; }
accepted() { wg stats --json 2>/dev/null | jget 'String(d.acceptance.accepted)'; }
epic_field() { wg stats --json 2>/dev/null | jget "String(((d.acceptance.epics || [])[0] || {}).$1 ?? '')"; }
replay_rec() { wg ticket show "$1" | jget '((d.evidence || []).filter(e => e.recorded_by_actor_type === "system" && (e.uri || "").startsWith("gaffer-tester-replayed:")).map(e => e.uri.slice(23) + " " + JSON.stringify(JSON.parse(e.payload_json || "{}").files || [])).join("\n"))' 2>/dev/null; }
LOGF="$GAFFER_DATA/factory.log"
# The tests commit the tester's latest PASS is bound to (bin/tester-run.mjs records it).
bound_tests() { wg ticket show "$1" | jget '((d.evidence || []).filter(e => e.evidence_type === "test_output" && /"verdict":"pass"/.test(e.payload_json || "")).map(e => JSON.parse(e.payload_json).tests_commit || "").pop()) || ""' 2>/dev/null; }
