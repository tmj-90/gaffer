#!/usr/bin/env bash
# Stub `claude` for the UI regression (scripts/ui-regression/run.sh). Stands in for the
# real worker so every factory seam runs without a model key:
#   • delivery (cwd is a git worktree with a package.json): appends ONE unique helper +
#     test per ticket, commits, and returns the JSON result envelope with a
#     smallest-change note — so DoD (npm test), the AC check, hygiene and minimalism all
#     see a real, passing change;
#   • reviewer (prompt asks for the machine-read verdict): returns {"verdict":"APPROVE"};
#   • everything else (onboard analysis, product owner, judge): a bare "ok" envelope —
#     the product-owner run therefore ends "failed: filed 0 drafts", which is the honest
#     classification and is asserted as "run recorded", not "drafts filed".
set -uo pipefail
prompt=""; prev=""
for a in "$@"; do [ "$prev" = "-p" ] && prompt="$a"; prev="$a"; done
log="${GAFFER_DATA:-/tmp}/stub-claude.log"; printf '%s cwd=%s\n' "$(date +%T)" "$PWD" >> "$log" 2>/dev/null || true
case "$prompt" in
  *"machine-read verdict"*|*'{"verdict"'*)
    printf '{"type":"result","subtype":"success","is_error":false,"result":"Reviewed the diff. RECOMMEND APPROVE\n{\\"verdict\\":\\"APPROVE\\"}","total_cost_usd":0.01,"num_turns":2}\n'; exit 0 ;;
esac
if [ -e .git ] && [ -f package.json ]; then
  # One UNIQUE helper per ticket so repeated regression runs never collide on main.
  fn="helper${GAFFER_TICKET:-0}"
  if ! grep -q "export function $fn" src/tasks.js 2>/dev/null; then
    printf 'export function %s(list) { return list.filter(t => !t.done); }\n' "$fn" >> src/tasks.js
    printf 'import { %s } from "../src/tasks.js";\ntest("%s drops completed", () => { assert.equal(%s([{title:"a",done:true}]).length, 0); });\n' "$fn" "$fn" "$fn" >> test/tasks.test.js
    git -c user.email=stub@gaffer -c user.name=stub add -A >/dev/null 2>&1
    git -c user.email=stub@gaffer -c user.name=stub commit -qm "feat: $fn helper (stub agent delivery)" >/dev/null 2>&1
  fi
  printf '{"type":"result","subtype":"success","is_error":false,"result":"Implemented %s with a test.\\n\\nSmallest-change note: modified src/tasks.js (added %s) and test/tasks.test.js (one new test) only — no other files touched.","total_cost_usd":0.02,"num_turns":6}\n' "$fn" "$fn"; exit 0
fi
printf '{"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0.001,"num_turns":1}\n'
