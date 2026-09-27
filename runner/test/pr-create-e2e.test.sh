#!/usr/bin/env bash
# =====================================================================
# GitHub PR creation (GAFFER_CREATE_PR=1) — end to end through the real tick.
# ---------------------------------------------------------------------
# The PR step runs AFTER the delivery worktrees are torn down, and it used to be
# handed the WORKTREE path: every remote check ran against a deleted directory,
# logged "no GitHub remote", and PR creation never fired for anyone. The URL
# recording then used a flag the CLI does not have (`--pr-url` vs `--pr`). Both are
# pinned here: with a pushable local `origin`, a GitHub-named remote and a stub `gh`,
# a delivery pushes the branch, creates the PR and records `pr_url` on the ticket.
# Run: bash runner/test/pr-create-e2e.test.sh
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

WORK="$(mktemp -d "${TMPDIR:-/tmp}/pr-create-e2e.XXXXXX")"; WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/data" "$WORK/bin"

R="$WORK/repo"; mkdir -p "$R/src" "$R/test"
( cd "$R" && git init -q -b main
  printf '{ "name": "r", "version": "0.1.0", "private": true, "type": "module", "scripts": { "test": "node --test", "lint": "node -e 0" } }\n' > package.json
  printf 'export function addTask(l, t) { return [...l, { t }]; }\n' > src/tasks.js
  printf 'import test from "node:test"; import assert from "node:assert/strict";\nimport { addTask } from "../src/tasks.js";\ntest("adds", () => { assert.equal(addTask([], "a").length, 1); });\n' > test/tasks.test.js
  git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init
  # `origin` is a pushable local bare repo; a second remote carries the github.com URL
  # the remote check looks for (any remote qualifies; the push goes to GAFFER_PR_REMOTE).
  git init -q --bare "$WORK/origin.git" && git remote add origin "$WORK/origin.git"
  git remote add github git@github.com:example/repo.git )

cat > "$WORK/bin/claude" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
if [ -e .git ] && [ -f package.json ]; then
  fn="helper${GAFFER_TICKET:-0}"
  grep -q "$fn" src/tasks.js || { printf 'export function %s(l){return l;}\n' "$fn" >> src/tasks.js; git -c user.email=s@s -c user.name=s add -A >/dev/null; git -c user.email=s@s -c user.name=s commit -qm "feat: $fn" >/dev/null; }
  printf '{"type":"result","subtype":"success","is_error":false,"result":"done.\\n\\nSmallest-change note: modified src/tasks.js only.","total_cost_usd":0.02,"num_turns":3}\n'; exit 0
fi
printf '{"type":"result","subtype":"success","is_error":false,"result":"ok"}\n'
STUB
chmod +x "$WORK/bin/claude"
# Stub gh: records argv; `pr create` prints a PR URL like the real CLI.
cat > "$WORK/bin/gh" <<'GH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${GH_CALLS:?}"
case "$*" in *"pr create"*) echo "https://github.com/example/repo/pull/42";; *) echo "{}";; esac
GH
sed -i "s|\${GH_CALLS:?}|$WORK/data/gh-calls.log|" "$WORK/bin/gh"; chmod +x "$WORK/bin/gh"

export GAFFER_DATA="$WORK/data" CLAUDE_BIN="$WORK/bin/claude" CLAUDE_FLAGS="" \
       GAFFER_TICK_TIMEOUT=60 GAFFER_MAX_TURNS=10 GAFFER_CARD_MODEL=stub GAFFER_PLAN_MODEL=stub GAFFER_IMPL_MODEL=stub \
       REVIEW_MODE=human DRY_RUN=0 GAFFER_MAINTENANCE=0 GAFFER_CREATE_PR=1 GAFFER_GH_BIN="$WORK/bin/gh"
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
wg init >/dev/null 2>&1; lg init >/dev/null 2>&1
wg repo add -n repo --path "$R" --branch main --test "npm test" --lint "npm run lint" >/dev/null 2>&1

N="$(wg ticket create -t "PR probe" -d "deliver with a PR" 2>/dev/null | jget 'd.ticket.number')"
wg ac add "$N" -t "helper added" >/dev/null 2>&1
wg ticket repo-access set "$N" repo --access write --relation confirmed >/dev/null 2>&1
wg ticket ready "$N" >/dev/null 2>&1
OUT="$( ( cd "$RUNNER_DIR" && bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep '^TICK_RESULT=' )"
echo "$OUT" | grep -q '^TICK_RESULT=worked$' && ok "delivery tick → worked" || fail "tick result: $OUT ($(tail -3 "$GAFFER_DATA/factory.log" | tr '\n' '|'))"
SHOW="$(wg ticket show "$N" 2>/dev/null)"
[ "$(echo "$SHOW" | jget 'd.ticket.status')" = "in_review" ] && ok "#$N in_review" || fail "#$N status $(echo "$SHOW" | jget 'd.ticket.status')"
grep -q "H4: created PR for #$N" "$GAFFER_DATA/factory.log" && ok "PR creation ran against the REAL repo (remote found after worktree teardown)" || fail "PR creation did not run: $(grep 'H4' "$GAFFER_DATA/factory.log" | tail -2 | tr '\n' '|')"
grep -q 'pr create' "$GAFFER_DATA/gh-calls.log" 2>/dev/null && ok "gh pr create was invoked" || fail "gh was not invoked"
grep -q -- "--head gaffer/ticket-$N" "$GAFFER_DATA/gh-calls.log" 2>/dev/null && ok "gh was given the delivery branch as --head" || fail "gh head arg wrong: $(cat "$GAFFER_DATA/gh-calls.log")"
[ -n "$(git -C "$WORK/origin.git" branch --list "gaffer/ticket-$N*")" ] && ok "the delivery branch was pushed to origin" || fail "branch not pushed to origin"
PRURL="$(echo "$SHOW" | jget 'd.ticket.pr_url ?? ""')"
[ "$PRURL" = "https://github.com/example/repo/pull/42" ] && ok "pr_url recorded on the ticket ($PRURL)" || fail "pr_url not recorded (got '$PRURL')"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
