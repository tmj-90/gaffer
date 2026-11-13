#!/usr/bin/env bash
# shellcheck shell=bash
# =====================================================================
# Shared world for review-once-per-head.test.sh (sections 1-4) and
# review-once-per-head-races.test.sh (sections 5-7): a one-repo factory with real
# dispatch, real tick.sh, the real bin/tester-run.mjs, a stub agent whose own invocation
# log ($CALLS) is what the tests count, and a `git` shim that plays a person racing the
# review pass. Sourced, never run: the caller sources lib/tmpdir.sh and sets HERE,
# RUNNER_DIR, ROOT, ok and fail first. This file creates $WORK (removed on exit unless
# KEEP=1) and defines daemon_pass, st, new_ticket, branch_head, count, line_of,
# ledger_rows and tamper_notes. The two tests were one file until it outgrew the 600 s
# per-test cap on a slow macOS runner; each half builds its own world.
# =====================================================================
WORK="$(mktemp -d "${TMPDIR:-/tmp}/review-once.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
trap '[ "${KEEP:-0}" = 1 ] && echo "kept $WORK" || gaffer_test_rm_work "$WORK"' EXIT
CTL="$WORK/ctl"; mkdir -p "$WORK/data" "$WORK/bin" "$WORK/shim" "$CTL"
CALLS="$WORK/agent-calls.log"; : > "$CALLS"
R="$WORK/repo"; mkdir -p "$R/src" "$R/test"
gitc() { git -c user.email=t@t -c user.name=t "$@"; }
( cd "$R" && git init -q -b main
  printf '{ "name": "r", "version": "0.1.0", "private": true, "type": "module", "scripts": { "test": "node --test", "lint": "node -e 0" } }\n' > package.json
  printf 'export const v = 1;\n' > src/v.js
  printf 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { v } from "../src/v.js";\ntest("smoke", () => { assert.equal(v, 1); });\n' > test/smoke.test.js
  gitc add -A && gitc commit -qm init )
DCLI="$ROOT/packages/dispatch/dist/cli/index.js"
DB="$WORK/data/dispatch.sqlite"

# Stub agent. Every call appends one line to $CALLS: "<role> <head of its cwd>".
#   tester (the INDEPENDENT TESTER prompt): writes a passing black-box test and answers
#     the verdict in $CTL/tester-verdict (PASS | FAIL).
#   (the reviewer is told apart first: its packet quotes the tester's outcome)
#   reviewer (the REVIEWER agent prompt): keeps its prompt as $CTL/review-prompt-<head>;
#     answers APPROVE. With $CTL/merge-during present it first plays a person who
#     approves and merges the ticket while the review runs (the live race).
#   delivery (anything else in a checkout): one new committed line, so every delivery
#     and every rework is a new head.
cat > "$WORK/bin/claude" <<STUB
#!/usr/bin/env bash
CTL="$CTL"; CALLS="$CALLS"; DCLI="$DCLI"; DB="$DB"; R="$R"; NODE="$(command -v node)"
STUB
cat >> "$WORK/bin/claude" <<'STUB'
prompt=""; prev=""; for a in "$@"; do [ "$prev" = "-p" ] && prompt="$a"; prev="$a"; done
head="$(git rev-parse HEAD 2>/dev/null || echo none)"
case "$prompt" in
  *"You are a REVIEWER agent"*)
    echo "review $head" >> "$CALLS"
    printf '%s' "$prompt" > "$CTL/review-prompt-$head"
    if [ -e "$CTL/merge-during" ]; then
      rm -f "$CTL/merge-during"
      n="$(printf '%s' "$prompt" | sed -n 's/.*in_review ticket #\([0-9][0-9]*\).*/\1/p' | head -1)"
      b="$("$NODE" "$DCLI" --db "$DB" ticket show "$n" 2>/dev/null | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).ticket.branch_name||"")}catch{}})')"
      "$NODE" "$DCLI" --db "$DB" review approve "$n" --as human --reviewer person --commit "$head" >/dev/null 2>&1
      git -C "$R" -c user.email=p@p -c user.name=p merge -q --no-ff -m "merge #$n" "$b" >/dev/null 2>&1
      git -C "$R" branch -D "$b" >/dev/null 2>&1
    fi
    if [ "$(cat "$CTL/review-verdict" 2>/dev/null)" = CHANGES ]; then
      printf '{"type":"result","subtype":"success","is_error":false,"result":"AC1 not met.\\nRECOMMEND CHANGES: v must be documented\\n{\\"verdict\\":\\"CHANGES\\"}","total_cost_usd":0.01,"num_turns":2}\n'
      exit 0
    fi
    printf '{"type":"result","subtype":"success","is_error":false,"result":"AC1 PASS.\\nRECOMMEND APPROVE\\n{\\"verdict\\":\\"APPROVE\\"}","total_cost_usd":0.01,"num_turns":2}\n'
    exit 0 ;;
  *"INDEPENDENT TESTER"*)
    echo "tester $head" >> "$CALLS"
    mkdir -p test
    printf 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { v } from "../src/v.js";\ntest("bb", () => { assert.equal(v, 1); });\n' > test/bb.test.js
    case "$(cat "$CTL/tester-verdict" 2>/dev/null || echo PASS)" in
      FAIL) printf '{"type":"result","subtype":"success","is_error":false,"result":"FAIL: v is not what AC1 says (stub-fail-marker)\\n{\\"verdict\\":\\"FAIL\\"}","total_cost_usd":0.01,"num_turns":2}\n' ;;
      *) printf '{"type":"result","subtype":"success","is_error":false,"result":"PASS: v is 1 as AC1 says (stub-pass-marker)\\n{\\"verdict\\":\\"PASS\\"}","total_cost_usd":0.01,"num_turns":2}\n' ;;
    esac
    exit 0 ;;
esac
if [ -e .git ] && [ -e "$CTL/no-commit" ] && [ "$(git rev-list --count main..HEAD 2>/dev/null || echo 0)" -gt 0 ]; then
  # A rework that commits nothing new: the branch keeps the head it was sent back on.
  echo "deliver-nocommit $(git rev-parse HEAD)" >> "$CALLS"
  printf '{"type":"result","subtype":"success","is_error":false,"result":"done: nothing to change.\\n\\nSmallest-change note: none.","total_cost_usd":0.01,"num_turns":1}\n'; exit 0
fi
if [ -e .git ]; then
  mkdir -p docs; printf 'change %s %s\n' "$$" "$RANDOM" >> docs/change.md
  git -c user.email=s@s -c user.name=s add -A >/dev/null; git -c user.email=s@s -c user.name=s commit -qm "feat: delivery" >/dev/null 2>&1 || true
  echo "deliver $(git rev-parse HEAD)" >> "$CALLS"
  printf '{"type":"result","subtype":"success","is_error":false,"result":"done.\\n\\nSmallest-change note: one line.","total_cost_usd":0.01,"num_turns":1}\n'; exit 0
fi
printf '{"type":"result","subtype":"success","is_error":false,"result":"ok"}\n'
STUB
chmod +x "$WORK/bin/claude"

# A `git` shim first on PATH: armed by $CTL/race-armed, it plays a person who approves and
# merges the ticket in $CTL/race-ticket at the moment the review pass creates its review
# worktree (after the pick, before the launch), then runs the real git.
REALGIT="$(command -v git)"
cat > "$WORK/shim/git" <<SHIM
#!/usr/bin/env bash
CTL="$CTL"; DCLI="$DCLI"; DB="$DB"; R="$R"; REALGIT="$REALGIT"; NODE="$(command -v node)"
SHIM
cat >> "$WORK/shim/git" <<'SHIM'
if [ -e "$CTL/race-armed" ]; then
  case " $* " in
    *" worktree add "*review-wt-*)
      rm -f "$CTL/race-armed"
      n="$(cat "$CTL/race-ticket")"
      b="$("$NODE" "$DCLI" --db "$DB" ticket show "$n" 2>/dev/null | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).ticket.branch_name||"")}catch{}})')"
      h="$("$REALGIT" -C "$R" rev-parse "refs/heads/$b")"
      if [ "$(cat "$CTL/race-mode" 2>/dev/null)" = verdict ]; then
        # Another lane finished a review of this head after this lane's pick.
        "$NODE" "$DCLI" --db "$DB" ticket lane-verdict "$n" --lane agent-review --verdict changes --commit "$h" --as system >"$CTL/race-approve.out" 2>&1
        : > "$CTL/race-fired"; exec "$REALGIT" "$@"
      fi
      "$NODE" "$DCLI" --db "$DB" review approve "$n" --as human --reviewer person --commit "$h" >"$CTL/race-approve.out" 2>&1
      "$REALGIT" -C "$R" -c user.email=p@p -c user.name=p merge -q --no-ff -m "merge #$n" "$b" >/dev/null 2>&1
      : > "$CTL/race-fired" ;;
  esac
fi
exec "$REALGIT" "$@"
SHIM
chmod +x "$WORK/shim/git"

export GAFFER_DATA="$WORK/data" DISPATCH_DB="$DB" CLAUDE_BIN="$WORK/bin/claude" CLAUDE_FLAGS="" \
       GAFFER_MAX_TURNS=3 GAFFER_TICK_TIMEOUT=60 GAFFER_ROLE_MODELS=card=stub GAFFER_PLAN_MODEL=stub GAFFER_IMPL_MODEL=stub \
       REVIEW_MODE=agent DRY_RUN=0 GAFFER_MAINTENANCE=0 GAFFER_STRICT_REQUIRE=0 \
       MAX_OPEN_AGENT_BRANCHES_PER_REPO=12 MAX_OPEN_AGENT_PRS_PER_REPO=12 MAX_IN_REVIEW_PER_REPO=12 GAFFER_DIGEST_DISABLE=1 GAFFER_AUTO_PUSH=0
# The tester lane as the live run had it: the `auto` default with a registered test command.
unset GAFFER_TESTING GAFFER_DOD_TYPECHECK_CMD GAFFER_TESTER_REPLAY AUTO_MERGE MERGE_ON_AGENT_REVIEW DISPATCH_ALLOW_AGENT_APPROVE
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
wg init >/dev/null 2>&1; lg init >/dev/null 2>&1
wg repo add -n repo --path "$R" --branch main --stack node --test "npm test" --lint "npm run lint" >/dev/null 2>&1

# One daemon PASS: a run of its own (a fresh GAFFER_RUN_STATE_DIR, so the per-run skip
# files start empty, as each pass of the live daemon did), ticking until the factory
# has nothing left to do (at most 8 ticks).
PASSNO=0
daemon_pass() {
  PASSNO=$((PASSNO + 1))
  local sd="$WORK/run-$PASSNO" i r
  mkdir -p "$sd"
  for i in 1 2 3 4 5 6 7 8; do
    r="$( ( cd "$RUNNER_DIR" && GAFFER_RUN_STATE_DIR="$sd" PATH="$WORK/shim:$PATH" bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | sed -n 's/^TICK_RESULT=//p' | tail -1)"
    echo "    pass $PASSNO tick $i: ${r:-none}"
    case "$r" in worked|reviewed|tested) ;; *) break ;; esac
  done
}
st() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.status'; }
new_ticket() { local n; n="$(wg ticket create -t "$1" -d "$2" --risk low 2>/dev/null | jget 'd.ticket.number')"; wg ac add "$n" -t "v is 1" >/dev/null 2>&1; wg ticket repo-access set "$n" repo --access write --relation confirmed >/dev/null 2>&1; wg ticket set-testable "$n" >/dev/null 2>&1; wg ticket ready "$n" >/dev/null 2>&1; printf '%s' "$n"; }
branch_head() { local b; b="$(wg ticket show "$1" 2>/dev/null | jget 'd.ticket.branch_name || ""')"; [ -n "$b" ] && git -C "$R" rev-parse --verify -q "refs/heads/$b"; }
count() { grep -c "^$1 $2\$" "$CALLS" 2>/dev/null; }
line_of() { grep -n "^$1 $2\$" "$CALLS" 2>/dev/null | head -1 | cut -d: -f1; }
ledger_rows() { node -e 'const fs=require("fs");let n=0;try{for(const l of fs.readFileSync(process.argv[1],"utf8").split("\n")){if(!l.trim())continue;try{const r=JSON.parse(l);if(r.kind===process.argv[2]&&Number(r.ticket)===Number(process.argv[3]))n++}catch{}}}catch{}process.stdout.write(String(n))' "$GAFFER_DATA/usage-ledger.jsonl" "$1" "$2"; }
tamper_notes() { { grep -c "reviewer modified the candidate" "$GAFFER_DATA/factory.log" 2>/dev/null || true; } | head -1; }
