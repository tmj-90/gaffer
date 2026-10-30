#!/usr/bin/env bash
# =====================================================================
# Per-ROLE turn caps — GAFFER_MAX_TURNS is a CEILING, never a replacement.
# ---------------------------------------------------------------------
# Before: decompose / spec-author / onboard computed `GAFFER_MAX_TURNS || own cap`,
# so the exported 200-turn delivery cap silently replaced their 20 / 20 / 60; every
# worker_deliver role (reviewer, security reviewer, clarify, judge) ran under the
# same 200; and the product owner, tester and merge resolver passed no --max-turns
# at all. Proves, with a fake `claude` that records its argv (no live model):
#   1. gaffer_role_turns = min(role cap, GAFFER_MAX_TURNS) (bash) and roleTurnCap
#      (mjs) agree; an unset global leaves the role cap; an empty role → global.
#   2. The REAL worker_deliver emits the role cap ($7) instead of the global, keeps
#      the global flag when no cap is passed, and appends extra flags ($8…) AFTER
#      $CLAUDE_FLAGS.
#   3. review/security/clarify/judge pass their role cap to worker_deliver.
#   4. decompose.mjs + spec-author.mjs: `--max-turns 5` survives GAFFER_MAX_TURNS=200,
#      and GAFFER_MAX_TURNS=3 lowers their default of 20 to 3.
#   5. onboard analysisCaps uses GAFFER_ONBOARD_MAX_TURNS (60) under the 200 ceiling.
#   6. PO / tester / merge resolver argv carry --max-turns (their role cap).
# Run: bash test/turn-caps.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/turn-caps.XXXXXX")"; WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT
export GAFFER_DATA="$WORK/.gaffer"; mkdir -p "$GAFFER_DATA"
export GAFFER_LOG="$WORK/factory.log"

# Fake claude: one argv element per line, then a minimal JSON envelope.
FAKE="$WORK/fake-claude"
cat > "$FAKE" <<EOS
#!/usr/bin/env bash
printf '%s\n' "\$@" > "$WORK/claude.argv"
printf '%s\n' '{"result":"ok","total_cost_usd":0.01,"num_turns":1}'
EOS
chmod +x "$FAKE"
# The value following --max-turns in the last recorded argv ("" when absent).
turns_arg() { awk 'p { print; exit } $0 == "--max-turns" { p = 1 }' "$WORK/claude.argv" 2>/dev/null; }

export CLAUDE_BIN="$FAKE"
unset GAFFER_MAX_TURNS GAFFER_REVIEW_MAX_TURNS GAFFER_SECURITY_REVIEW_MAX_TURNS GAFFER_CLARIFY_MAX_TURNS \
  GAFFER_JUDGE_MAX_TURNS GAFFER_TESTER_MAX_TURNS GAFFER_MERGE_MAX_TURNS GAFFER_RESOLVER_MAX_TURNS \
  GAFFER_PO_MAX_TURNS GAFFER_DECOMPOSE_MAX_TURNS GAFFER_SPEC_AUTHOR_MAX_TURNS GAFFER_ONBOARD_MAX_TURNS \
  GAFFER_DECOMPOSE_AGENT_MAX_TURNS GAFFER_SPEC_AUTHOR_AGENT_MAX_TURNS
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1

echo "== 1: gaffer_role_turns / roleTurnCap = min(role, global) =="
[ "$GAFFER_MAX_TURNS" = "200" ] && ok "delivery cap default stays 200" || fail "GAFFER_MAX_TURNS default changed ($GAFFER_MAX_TURNS)"
[ "$(gaffer_role_turns 60)" = "60" ] && ok "role 60 under a 200 ceiling → 60" || fail "role 60 → $(gaffer_role_turns 60)"
[ "$(GAFFER_MAX_TURNS=3 gaffer_role_turns 60)" = "3" ] && ok "a lower global (3) lowers the role cap" || fail "global 3 should clamp"
[ "$(gaffer_role_turns "")" = "200" ] && ok "an empty role cap falls back to the global" || fail "empty role → $(gaffer_role_turns "")"
[ "$(GAFFER_MAX_TURNS="" gaffer_role_turns 40)" = "40" ] && ok "no global → the role cap as is" || fail "no global should keep 40"
MJS="$(node --input-type=module -e "
import { roleTurnCap } from '$RUNNER_DIR/lib/worker.mjs';
console.log([roleTurnCap(60,{GAFFER_MAX_TURNS:'200'}), roleTurnCap(60,{GAFFER_MAX_TURNS:'3'}),
  roleTurnCap(0,{GAFFER_MAX_TURNS:'200'}), roleTurnCap(40,{}), roleTurnCap('',{})].join(','));")"
[ "$MJS" = "60,3,200,40,0" ] && ok "roleTurnCap (mjs) matches the bash helper ($MJS)" || fail "roleTurnCap gave $MJS"
[ "${GAFFER_REVIEW_MAX_TURNS:-}" = "60" ] && [ "${GAFFER_SECURITY_REVIEW_MAX_TURNS:-}" = "40" ] \
  && [ "${GAFFER_CLARIFY_MAX_TURNS:-}" = "40" ] && [ "${GAFFER_JUDGE_MAX_TURNS:-}" = "2" ] \
  && ok "per-role defaults: review 60, security 40, clarify 40, judge 2" || fail "per-role defaults wrong"

echo "== 2: the REAL worker_deliver honours a per-call cap =="
CWD="$WORK/cwd"; mkdir -p "$CWD"; MCP="$WORK/mcp.json"; printf '{"mcpServers":{}}' > "$MCP"
WORKER_CALL_ENV=( GAFFER_TURNS_TEST=1 )
worker_deliver "$CWD" "p" "" "$MCP" "$WORK/o1.json" "" >/dev/null 2>&1
[ "$(turns_arg)" = "200" ] && ok "no cap passed → the global delivery flag (--max-turns 200)" || fail "default → '$(turns_arg)'"
worker_deliver "$CWD" "p" "" "$MCP" "$WORK/o2.json" "" "$(gaffer_role_turns "${GAFFER_REVIEW_MAX_TURNS:-60}")" >/dev/null 2>&1
[ "$(turns_arg)" = "60" ] && ok "a role cap (60) replaces the 200 on the invocation" || fail "role cap → '$(turns_arg)'"
[ "$(grep -c '^--max-turns$' "$WORK/claude.argv")" = "1" ] && ok "exactly one --max-turns on the argv" || fail "duplicate --max-turns"
CLAUDE_FLAGS="--permission-mode acceptEdits" \
  worker_deliver "$CWD" "p" "" "$MCP" "$WORK/o3.json" "" 2 --tools "" --strict-mcp-config >/dev/null 2>&1
TAIL="$(tail -n 4 "$WORK/claude.argv" | tr '\n' '|')"
[ "$TAIL" = "2|--tools||--strict-mcp-config|" ] && ok "extra flags are appended last, the empty --tools value intact" \
  || fail "extra flags tail wrong: $TAIL"

echo "== 3: every worker_deliver role passes its own cap =="
grep -q 'gaffer_role_turns "${GAFFER_REVIEW_MAX_TURNS:-60}"' "$RUNNER_DIR/lib/review.sh" \
  && ok "reviewer passes GAFFER_REVIEW_MAX_TURNS" || fail "reviewer does not pass its cap"
grep -qF 'gaffer_role_turns "${GAFFER_SECURITY_REVIEW_MAX_TURNS:-${GAFFER_REVIEW_MAX_TURNS:-40}}"' "$RUNNER_DIR/lib/review.sh" \
  && ok "security reviewer passes GAFFER_SECURITY_REVIEW_MAX_TURNS" || fail "security reviewer does not pass its cap"
grep -q 'gaffer_role_turns "${GAFFER_CLARIFY_MAX_TURNS:-40}"' "$RUNNER_DIR/lib/clarify.sh" \
  && ok "clarify passes GAFFER_CLARIFY_MAX_TURNS" || fail "clarify does not pass its cap"
grep -q 'GAFFER_JUDGE_MAX_TURNS' "$RUNNER_DIR/lib/eval-judge.sh" \
  && ok "eval judge passes GAFFER_JUDGE_MAX_TURNS" || fail "eval judge does not pass its cap"

echo "== 4: decompose / spec-author — the flag survives the global, the global only lowers =="
for helper in decompose spec-author; do
  rm -f "$WORK/claude.argv"
  GAFFER_MAX_TURNS=200 node "$RUNNER_DIR/bin/$helper.mjs" --brief 'build a todo app' --max-turns 5 >/dev/null 2>&1 </dev/null
  [ "$(turns_arg)" = "5" ] && ok "$helper: --max-turns 5 survives GAFFER_MAX_TURNS=200" || fail "$helper: got '$(turns_arg)' (want 5)"
  rm -f "$WORK/claude.argv"
  GAFFER_MAX_TURNS=200 node "$RUNNER_DIR/bin/$helper.mjs" --brief 'build a todo app' >/dev/null 2>&1 </dev/null
  [ "$(turns_arg)" = "20" ] && ok "$helper: own default 20 applies under the 200 ceiling" || fail "$helper: got '$(turns_arg)' (want 20)"
  rm -f "$WORK/claude.argv"
  GAFFER_MAX_TURNS=3 node "$RUNNER_DIR/bin/$helper.mjs" --brief 'build a todo app' >/dev/null 2>&1 </dev/null
  [ "$(turns_arg)" = "3" ] && ok "$helper: GAFFER_MAX_TURNS=3 lowers the default of 20 to 3" || fail "$helper: got '$(turns_arg)' (want 3)"
done

echo "== 5: onboard analysis uses its own role cap =="
OB="$(GAFFER_MAX_TURNS=200 node --input-type=module -e "
import { analysisCaps } from '$RUNNER_DIR/lib/onboard-analyze.mjs';
console.log([analysisCaps(process.env).maxTurns, analysisCaps({...process.env, GAFFER_ONBOARD_MAX_TURNS:'7'}).maxTurns,
  analysisCaps({GAFFER_MAX_TURNS:'5'}).maxTurns].join(','));")"
[ "$OB" = "60,7,5" ] && ok "onboard: 60 under the 200 ceiling; GAFFER_ONBOARD_MAX_TURNS wins; global 5 lowers" || fail "onboard caps: $OB"

echo "== 6: PO / tester / merge resolver carry --max-turns =="
ARGVS="$(GAFFER_MAX_TURNS=200 node --input-type=module -e "
import { buildClaudeArgv as po } from '$RUNNER_DIR/bin/product-owner-run.mjs';
import { testerMaxTurns } from '$RUNNER_DIR/bin/tester-run.mjs';
import { buildClaudeArgv as merge } from '$RUNNER_DIR/bin/merge-ticket.mjs';
const t = (a) => a[a.indexOf('--max-turns') + 1] ?? 'none';
console.log([t(po({prompt:'P', mcpConfig:'/x.json', flags:[]})),
  t(po({prompt:'P', mcpConfig:'/x.json', flags:[], maxTurns: testerMaxTurns()})),
  t(merge({prompt:'P', mcpConfig:'/x.json', flags:[]}))].join(','));" 2>/dev/null)"
[ "$ARGVS" = "60,80,60" ] && ok "PO 60, tester 80, merge resolver 60 (each under the 200 ceiling)" || fail "PO/tester/merge caps: '$ARGVS'"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
