#!/usr/bin/env bash
# =====================================================================
# A repository's committed symlink never makes the runner write outside its worktree.
# ---------------------------------------------------------------------
# External review 17 reproduced it with the stub agent through a whole ticket run: a
# repo with a committed `.claude/settings.json` symlink to a file outside the worktree
# got that outside file overwritten while the runner prepared the agent's directory (on
# the host, before any sandbox), the tick returned worked and the ticket reached
# in_review. Real tick.sh + real dispatch + a stub `claude` that logs every call:
#   S  a committed .claude/settings.json link to an outside sentinel;
#   B  a committed CLAUDE.factory.md link to an outside sentinel;
#   K  a committed .claude/skills link (to a directory in the repo: a benign repo that
#      shares configuration through links);
#   C  control: a plain repo still delivers.
# For S, B and K: the sentinel is byte-identical, no agent was launched, and the ticket
# is parked blocked (reason code unsafe_worktree_path) with a reason that names the
# path and says what to do.
# Run: bash runner/test/worktree-link-refusal.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
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

WORK="$(mktemp -d "${TMPDIR:-/tmp}/wt-link-refusal.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
trap 'gaffer_test_rm_work "$WORK"' EXIT
mkdir -p "$WORK/data" "$WORK/bin" "$WORK/home" "$WORK/outside"
REAL_HOME="$(cd ~ 2>/dev/null && pwd -P)"
export HOME="$WORK/home"
[ "$HOME" != "$REAL_HOME" ] || { echo "FAIL: scratch HOME is the real HOME"; exit 1; }

# One small JS repo per scenario; $2 adds the committed link(s).
make_repo() {
  local r="$WORK/$1"
  mkdir -p "$r/src" "$r/test"
  ( cd "$r" && git init -q -b main
    printf '{ "name": "r", "version": "0.1.0", "private": true, "type": "module", "scripts": { "test": "node --test", "lint": "node -e 0" } }\n' > package.json
    printf 'export function addTask(l, t) { return [...l, { t }]; }\n' > src/tasks.js
    printf 'import test from "node:test"; import assert from "node:assert/strict";\nimport { addTask } from "../src/tasks.js";\ntest("adds", () => { assert.equal(addTask([], "a").length, 1); });\n' > test/tasks.test.js
    eval "$2"
    git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init )
  printf '%s' "$r"
}
SENT_S="$WORK/outside/operator-settings.json"; printf '{"operator":"real settings, do not touch"}\n' > "$SENT_S"; cp "$SENT_S" "$SENT_S.orig"
SENT_B="$WORK/outside/operator-notes.md"; printf '# operator notes, do not touch\n' > "$SENT_B"; cp "$SENT_B" "$SENT_B.orig"
RS="$(make_repo repo-s "mkdir -p .claude && ln -s '$SENT_S' .claude/settings.json")"
RB="$(make_repo repo-b "ln -s '$SENT_B' CLAUDE.factory.md")"
RK="$(make_repo repo-k "mkdir -p .claude shared-skills/house && printf 'HOUSE\n' > shared-skills/house/SKILL.md && ln -s ../shared-skills .claude/skills")"
RC="$(make_repo repo-c ":")"

CALLS="$WORK/claude-calls.log"; : > "$CALLS"
cat > "$WORK/bin/claude" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
[ "${1:-}" = "--version" ] && { echo "0.0.0 (stub)"; exit 0; }
printf '%s\n' "$PWD" >> "__CALLS__"
if [ -e .git ] && [ -f package.json ]; then
  fn="helper${GAFFER_TICKET:-0}"
  grep -q "$fn" src/tasks.js || { printf 'export function %s(l){return l;}\n' "$fn" >> src/tasks.js; git -c user.email=s@s -c user.name=s add src/tasks.js >/dev/null; git -c user.email=s@s -c user.name=s commit -qm "feat: $fn" >/dev/null; }
  printf '{"type":"result","subtype":"success","is_error":false,"result":"done.\\n\\nSmallest-change note: modified src/tasks.js only.","total_cost_usd":0.02,"num_turns":3}\n'; exit 0
fi
printf '{"type":"result","subtype":"success","is_error":false,"result":"ok"}\n'
STUB
sed -i.bak -e "s|__CALLS__|$CALLS|" "$WORK/bin/claude" && rm -f "$WORK/bin/claude.bak"; chmod +x "$WORK/bin/claude"

export GAFFER_DATA="$WORK/data" CLAUDE_BIN="$WORK/bin/claude" CLAUDE_FLAGS="" \
       GAFFER_TICK_TIMEOUT=60 GAFFER_MAX_TURNS=10 GAFFER_ROLE_MODELS=card=stub GAFFER_PLAN_MODEL=stub GAFFER_IMPL_MODEL=stub \
       REVIEW_MODE=human DRY_RUN=0 GAFFER_MAINTENANCE=0 MAX_OPEN_AGENT_BRANCHES_PER_REPO=10 MAX_OPEN_AGENT_PRS_PER_REPO=10
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
wg init >/dev/null 2>&1; lg init >/dev/null 2>&1
for _rp in "s:$RS" "b:$RB" "k:$RK" "c:$RC"; do
  wg repo add -n "repo-${_rp%%:*}" --path "${_rp#*:}" --branch main --test "npm test" --lint "npm run lint" >/dev/null 2>&1
done

if command -v perl >/dev/null 2>&1; then BOUND=(perl -e 'alarm shift; exec @ARGV' 240); else BOUND=(); fi
run_tick() { ( cd "$RUNNER_DIR" && ${BOUND[@]+"${BOUND[@]}"} bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep '^TICK_RESULT=' ; }
st() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.status'; }
ncalls() { wc -l < "$CALLS" | tr -d ' '; }
new_ticket() {
  local n
  n="$(wg ticket create -t "$1" -d "add a helper" 2>/dev/null | jget 'd.ticket.number')"
  wg ac add "$n" -t "helper added" >/dev/null 2>&1
  wg ticket repo-access set "$n" "$2" --access write --relation confirmed >/dev/null 2>&1
  wg ticket ready "$n" >/dev/null 2>&1
  printf '%s' "$n"
}
# The ticket's trail as one line (status, the park reason, the events).
trail() { wg ticket show "$1" 2>/dev/null | tr '\n' ' '; }

refused() { # <label> <ticket> <path-named> <sentinel-or-empty>
  local label="$1" num="$2" path="$3" sent="$4" c0 out
  c0="$(ncalls)"
  out="$(run_tick)"
  [ "$(ncalls)" = "$c0" ] && ok "$label: no agent was launched ($out)" || fail "$label: $(( $(ncalls) - c0 )) agent call(s) made"
  if [ -n "$sent" ]; then
    cmp -s "$sent" "$sent.orig" && ok "$label: the outside file is byte-identical" || fail "$label: the outside file changed: $(head -c 80 "$sent")"
  fi
  [ "$(st "$num")" = "blocked" ] && ok "$label: #$num is parked blocked" || fail "$label: #$num is '$(st "$num")' ($out): $(grep -E 'SAFETY|unsafe' "$GAFFER_DATA/factory.log" | tail -3 | tr '\n' '|')"
  grep -q "unsafe_worktree_path" <<<"$(trail "$num")" && ok "$label: the ticket carries reason code unsafe_worktree_path" || fail "$label: no unsafe_worktree_path on #$num"
  grep -qF "$path" <<<"$(trail "$num")" && ok "$label: the ticket's reason names $path" || fail "$label: #$num's reason does not name $path"
  grep -q "Replace the link" <<<"$(trail "$num")" && grep -q "wg unblock $num" <<<"$(trail "$num")" \
    && ok "$label: the reason says what to do (replace the link, then unblock)" || fail "$label: the reason gives no fix"
  grep -q "unsafe_worktree_path.*$path" "$GAFFER_DATA/factory.log" && ok "$label: the factory log names the refusal" || fail "$label: no refusal line in factory.log"
}

echo "== S. a committed .claude/settings.json link to an outside file =="
NS="$(new_ticket "Settings link" repo-s)"
refused S "$NS" ".claude/settings.json" "$SENT_S"

echo "== B. a committed CLAUDE.factory.md link to an outside file =="
NB="$(new_ticket "Brief link" repo-b)"
refused B "$NB" "CLAUDE.factory.md" "$SENT_B"

echo "== K. a committed .claude/skills link (benign: shares skills inside the repo) =="
NK="$(new_ticket "Skills link" repo-k)"
refused K "$NK" ".claude/skills" ""
[ "$(ls -A "$RK/shared-skills")" = "house" ] && ok "K: nothing copied into the repo's shared skills" || fail "K: shared-skills now: $(ls -A "$RK/shared-skills" | paste -sd, -)"

echo "== C. control: a plain repo still delivers =="
NC="$(new_ticket "Plain repo" repo-c)"
C0="$(ncalls)"
OUT="$(run_tick)"
[ "$(st "$NC")" = "in_review" ] && [ "$(ncalls)" -gt "$C0" ] && ok "C: #$NC delivered → in_review ($OUT)" \
  || fail "C: #$NC is '$(st "$NC")' ($OUT), calls +$(( $(ncalls) - C0 )): $(tail -4 "$GAFFER_DATA/factory.log" | tr '\n' '|')"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
