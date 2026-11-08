#!/usr/bin/env bash
# =====================================================================
# PRE-WORK SCOUT, the runner side (delta roadmap gap 3). lib/scout.sh gathers the
# ticket, the base tree (git) and the code index's neighbours (the real memory CLI) and
# builds the packet through lib/scout.mjs + lib/risk-classify.mjs; the delivery prompt
# renders it through the crew seam inside <untrusted-scout>. FAIL-SOFT: no index means
# the named files and stack frames only, said as such; GAFFER_SCOUT=none is off.
# The bounded model scout (GAFFER_SCOUT) runs only when asked, through worker_deliver
# (stubbed here: no model is ever spawned), read-only, booked as kind scout, and its
# reply is checked against the base tree.
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
CREW_DIR="$ROOT/packages/crew"
MEMORY_BIN="$ROOT/packages/memory/dist/bin/memory.js"
JSON_TOOL="$RUNNER_DIR/lib/json-tool.mjs"

command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }
[ -f "$CREW_DIR/dist/runtime/context/renderPromptCli.js" ] || { echo "SKIP: crew not built"; exit 0; }
[ -f "$MEMORY_BIN" ] || { echo "SKIP: memory not built ($MEMORY_BIN)"; exit 0; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/scout-gather.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
trap 'gaffer_test_rm_work "$WORK"' EXIT

pass=0
fail=0
ok() { echo "  ok   $1"; pass=$((pass + 1)); }
no() { echo "  FAIL $1"; fail=$((fail + 1)); }
has() { case "$1" in *"$2"*) return 0 ;; esac; return 1; }

export MEMORY_DB="$WORK/memory.sqlite" CREW_DIR RUNNER_DIR
export GAFFER_DATA="$WORK/data"
mkdir -p "$GAFFER_DATA"
lg() { node "$MEMORY_BIN" "$@"; }
gaffer_json() { node "$JSON_TOOL" "$@"; }
LOGF="$WORK/log"
log() { printf '%s\n' "$*" >> "$LOGF"; }
WG_CALLS="$WORK/wg-calls"
wg() { printf '%s\n' "$*" >> "$WG_CALLS"; }
# shellcheck source=../lib/scout.sh
. "$RUNNER_DIR/lib/scout.sh"
# The per-role model reader the config defines (runner/config/04-models.sh), taken from
# the real source: the model scout asks it for GAFFER_ROLE_MODELS scout=.
eval "$(awk '/^gaffer_role_model\(\) \{/,/^\}/' "$RUNNER_DIR/config/04-models.sh")"

REPO="$WORK/app"
mkdir -p "$REPO/src" "$REPO/test" "$REPO/db/migrations"
git -C "$REPO" init -q -b main
git -C "$REPO" config user.email t@example.invalid
git -C "$REPO" config user.name t
printf 'export function calculateInvoice(l: number[]) {\n  return l.length;\n}\n' > "$REPO/src/invoice.ts"
printf "export { calculateInvoice } from './invoice';\n" > "$REPO/src/index.ts"
printf "import { calculateInvoice } from './index';\nexport const api = calculateInvoice;\n" > "$REPO/src/api.ts"
printf "import { calculateInvoice } from './invoice.js';\nexport const r = calculateInvoice([]);\n" > "$REPO/src/report.ts"
printf "import { r } from './report';\nexport const page = r;\n" > "$REPO/src/page.ts"
printf "import { calculateInvoice } from '../src/invoice';\ncalculateInvoice([]);\n" > "$REPO/test/invoice.test.ts"
printf 'ALTER TABLE invoice ADD total int;\n' > "$REPO/db/migrations/0042_total.sql"
git -C "$REPO" add -A
git -C "$REPO" commit -qm base
SHA="$(git -C "$REPO" rev-parse HEAD)"

SHOW='{"ticket":{"title":"Round `calculateInvoice()` totals","description":"It crashes:\n    at calculateInvoice (/home/ci/build/app/src/invoice.ts:2:10)\n    at run (node_modules/x/index.js:1:1)\nSee src/report.ts","risk_level":"low","attempt_count":0},"repositories":[{"id":"r1","name":"app","access":"write","relation":"confirmed","test_command":"npm test"}]}'
_CARD_NAMED="$(printf '%s' "$SHOW" | node "$JSON_TOOL" ticket-named-code)"
_RF=""

echo "== A. no index yet: the named files and the stack frame only, said as such =="
gaffer_scout_run "$REPO" "$SHA" 1
[ -n "$SCOUT_PACKET_FILE" ] && [ -s "$SCOUT_PACKET_FILE" ] && ok "a packet is built" || no "no packet"
pk="$(cat "$SCOUT_PACKET_FILE" 2>/dev/null)"
has "$pk" '"status":"missing"' && ok "the index status is missing" || no "status: $pk"
has "$pk" '"path":"src/report.ts","reasons":["named"]' && ok "the named path, reason named" || no "named item absent"
has "$pk" '"path":"src/invoice.ts","reasons":["stack trace (line 2)"]' && ok "the absolute stack frame resolved by suffix" || no "stack item absent"
has "$pk" 'node_modules' && no "a node_modules frame leaked" || ok "node_modules frames dropped"
has "$SCOUT_PROMPT" '"status":"missing"' && ok "the prompt input carries the index status" || no "prompt input: $SCOUT_PROMPT"
[ "$SCOUT_RISK" = "low" ] && ok "no signal: the declared low stands" || no "risk $SCOUT_RISK"
gaffer_scout_cleanup

echo "== B. index built: importers and tests, two hops, with reasons =="
node "$MEMORY_BIN" index build --repo-root "$REPO" --json > /dev/null 2>&1 || no "index build failed"
gaffer_scout_run "$REPO" "$SHA" 1
pk="$(cat "$SCOUT_PACKET_FILE" 2>/dev/null)"
has "$pk" '"status":"fresh"' && ok "fresh index" || no "status: $pk"
has "$pk" '"path":"src/api.ts","reasons":["imports calculateInvoice through src/index.ts"' && ok "a barrel caller with its reason" || no "barrel caller absent"
has "$pk" '"path":"test/invoice.test.ts","reasons":["tests' && ok "the test with its reason" || no "test absent"
has "$pk" '"path":"src/page.ts","reasons":["imports src/report.ts"]' && ok "an importer of the named path is first-hop, not repeated as 2 hops" || no "page.ts: $pk"
has "$pk" '"imports src/index.ts (2 hops)"' && ok "a second hop through the barrel" || no "second hop absent: $pk"
[ -n "$SCOUT_INDEX_FILE" ] && has "$(node "$JSON_TOOL" index-metric "$SCOUT_INDEX_FILE")" '"index_status":"fresh"' \
  && ok "the scout's index answer feeds delivery-metrics" || no "index metric"

echo "== C. the delivery prompt renders it inside the untrusted envelope =="
NUM=7 TITLE="Round totals" SKILLS="" LENSES=minimalism WORK_BRANCH=gaffer/ticket-7-x PRIMARY_REPO=/wt/app \
  WT_ROWS="$(printf 'r1\tapp\t%s\tmain\t/wt/app' "$REPO")"
inputs="$(GF_NUM=7 GF_TITLE="Round totals" GF_SCOUT="$SCOUT_PROMPT" GF_WORK_BRANCH=gaffer/ticket-7-x GF_PRIMARY=/wt/app \
  GF_WT_ROWS="$(printf 'r1\tapp\t%s\tmain\t/wt/app' "$REPO")" node "$JSON_TOOL" prompt-inputs fresh)"
prompt="$(printf '%s' "$inputs" | node "$CREW_DIR/dist/runtime/context/renderPromptCli.js")"
has "$prompt" "SCOUT — before you started" && ok "the SCOUT block is in the prompt" || no "no SCOUT block"
inner="${prompt#*<untrusted-scout>}"
has "$inner" "src/api.ts — imports calculateInvoice through src/index.ts" && ok "the items are inside the envelope" || no "items outside the envelope"
has "$inner" "test command (app): npm test" && ok "the test command is listed" || no "no test command"
noscout="$(GF_NUM=7 GF_TITLE="Round totals" GF_WORK_BRANCH=gaffer/ticket-7-x GF_PRIMARY=/wt/app \
  GF_WT_ROWS="$(printf 'r1\tapp\t%s\tmain\t/wt/app' "$REPO")" node "$JSON_TOOL" prompt-inputs fresh)"
has "$noscout" '"scout"' && no "an empty GF_SCOUT added a key" || ok "no scout: the prompt inputs are unchanged"

echo "== D. persist and telemetry: the attempt's file, the system event, the selection line =="
: > "$WG_CALLS"
gaffer_scout_persist 7 1
[ -s "$GAFFER_DATA/scout/ticket-7/attempt-1.json" ] && ok "the attempt's packet file is kept" || no "no attempt file"
has "$(cat "$WG_CALLS")" "ticket scout-record 7 --file " && has "$(cat "$WG_CALLS")" "--as system" \
  && ok "recorded on the ticket as a system event" || no "wg calls: $(cat "$WG_CALLS")"
gaffer_scout_selection 7 1 "fix-bug, typescript" minimalism mid "  - [module] src/invoice.ts — totals"
sel="$(tail -1 "$GAFFER_DATA/context-selection.jsonl" 2>/dev/null)"
has "$sel" '"role":"delivery"' && has "$sel" '"reason":"always-on quality lens"' && has "$sel" '"path":"src/invoice.ts","reason":"file card"' \
  && ok "context-selection.jsonl: files, cards and skills with reasons" || no "selection: $sel"
: > "$WG_CALLS"; rm -rf "$GAFFER_DATA/scout"
DRY_RUN=1 gaffer_scout_persist 8 1
DRY_RUN=1 gaffer_scout_selection 8 1 a b c ""
[ ! -e "$GAFFER_DATA/scout/ticket-8" ] && [ ! -s "$WG_CALLS" ] && [ "$(grep -c '"ticket":"8"' "$GAFFER_DATA/context-selection.jsonl")" = 0 ] \
  && ok "DRY_RUN records nothing" || no "DRY_RUN recorded something"
gaffer_scout_cleanup

echo "== E. the risk classifier raises, and only raises =="
SHOW_M='{"ticket":{"title":"Add the total column","description":"Write the migration db/migrations/0042_total.sql and call `calculateInvoice()`","risk_level":"low","attempt_count":1},"repositories":[]}'
SHOW="$SHOW_M" _CARD_NAMED="$(printf '%s' "$SHOW_M" | node "$JSON_TOOL" ticket-named-code)" _RF="$(printf '  - tests failed')" \
  gaffer_scout_run "$REPO" "$SHA" 2
[ "$SCOUT_RISK" = "high" ] && ok "a migration ticket routes high" || no "risk: $SCOUT_RISK"
has "$SCOUT_RAISED" "risk raised to high (declared low): " && has "$SCOUT_RAISED" "a previous attempt was sent back" \
  && ok "the raise names its reasons: $SCOUT_RAISED" || no "raised: $SCOUT_RAISED"
has "$SCOUT_PROMPT" '"risk":{"declared":"low","effective":"high"' && ok "the prompt input carries the raise" || no "prompt risk: $SCOUT_PROMPT"
gaffer_scout_cleanup

echo "== F. off: GAFFER_SCOUT=none builds nothing =="
GAFFER_SCOUT=none gaffer_scout_run "$REPO" "$SHA" 1
[ -z "$SCOUT_PACKET_FILE" ] && [ -z "$SCOUT_PROMPT" ] && [ -z "$SCOUT_RISK" ] && ok "off: no packet, no prompt input, no risk" || no "off still built"
GAFFER_SCOUT_PACKET=0 gaffer_scout_run "$REPO" "$SHA" 1
[ -z "$SCOUT_PACKET_FILE" ] && [ -z "$SCOUT_PROMPT" ] && ok "the deprecated GAFFER_SCOUT_PACKET=0 still builds nothing" || no "GAFFER_SCOUT_PACKET=0 still built"
gaffer_scout_run "$WORK/nowhere" "" 1
has "$SCOUT_PROMPT" "src/report.ts" && ok "no repo and no base: the named path is kept (unchecked), nothing fails" || no "no-repo: $SCOUT_PROMPT"
gaffer_scout_cleanup

echo "== G. the model scout: only when asked, read-only, booked, checked =="
SPAWNS="$WORK/spawns"; : > "$SPAWNS"
LEDGER="$WORK/ledger"; : > "$LEDGER"
gaffer_write_agent_settings() { mkdir -p "$1/.claude" && printf '{}' > "$1/.claude/settings.json"; }
gaffer_role_turns() { printf '%s' "$1"; }
gaffer_usage_record() { printf '%s %s %s\n' "$1" "$2" "$3" >> "$LEDGER"; }
gaffer_usage_pause_record() { return 1; }
PAUSED=0
gaffer_usage_pause_active() { [ "$PAUSED" = 1 ] && { echo "paused"; return 0; }; return 1; }
REPLY='{"files":[{"path":"src/report.ts","why":"sums the totals"},{"path":"src/ghost.ts","why":"x"}],"symbols":[{"name":"calculateInvoice","path":"src/invoice.ts"},{"name":"nope","path":"src/invoice.ts"}],"notes":["round in calculateInvoice","prove it in test/invoice.test.ts"]}'
worker_deliver() {
  {
    printf 'kind=%s cwd=%s\n' "${GAFFER_LAUNCH_KIND:-}" "$1"
    printf 'flags=%s\n' "$CLAUDE_FLAGS"
    printf 'env=%s\n' "${WORKER_CALL_ENV[*]}"
    printf 'args=%s\n' "${*:7}"
    printf 'model=%s\n' "$3"
  } >> "$SPAWNS"
  R="$REPLY" node -e 'process.stdout.write(JSON.stringify({type:"result",result:process.env.R,total_cost_usd:0.0123}))' > "$5"
  return 0
}
SHOW='{"ticket":{"title":"Round `calculateInvoice()` totals","description":"See src/invoice.ts","risk_level":"low"},"repositories":[]}'
_CARD_NAMED="$(printf '%s' "$SHOW" | node "$JSON_TOOL" ticket-named-code)"; _RF=""
gaffer_scout_run "$REPO" "$SHA" 1
gaffer_model_scout 7 "$REPO" "$SHA"
[ ! -s "$SPAWNS" ] && ok "default (off): no model call" || no "off spawned"
GAFFER_SCOUT=auto gaffer_model_scout 7 "$REPO" "$SHA"
[ ! -s "$SPAWNS" ] && ok "auto with a low effective risk: no model call" || no "auto-low spawned"
SHOW='{"ticket":{"title":"Round `calculateInvoice()` totals","description":"See src/invoice.ts","risk_level":"medium"},"repositories":[]}'
gaffer_scout_cleanup; gaffer_scout_run "$REPO" "$SHA" 1
PAUSED=1 GAFFER_SCOUT=auto gaffer_model_scout 7 "$REPO" "$SHA"
[ ! -s "$SPAWNS" ] && ok "a usage pause: no model call" || no "pause spawned"
DRY_RUN=1 GAFFER_SCOUT=on gaffer_model_scout 7 "$REPO" "$SHA"
[ ! -s "$SPAWNS" ] && ok "DRY_RUN: no model call" || no "dry run spawned"
GAFFER_SCOUT=auto GAFFER_ROLE_MODELS="scout=cheap-x" gaffer_model_scout 7 "$REPO" "$SHA"
sp="$(cat "$SPAWNS")"
has "$sp" "kind=scout" && ok "one call through worker_deliver, launch kind scout (budget admission)" || no "spawn: $sp"
has "$sp" "model=--model cheap-x" && ok "the model is GAFFER_ROLE_MODELS scout=" || no "model: $sp"
has "$sp" "--tools Read,Grep,Glob --strict-mcp-config --disable-slash-commands" && ok "read-only tools, no MCP, no slash commands" || no "args: $sp"
has "$sp" "--disallowedTools Bash,Edit,Write" && ok "write and shell tools denied by name" || no "flags: $sp"
has "$sp" "GAFFER_READ_ROOTS=$REPO" && ok "the real repo is a READ root only" || no "env: $sp"
[ "$(grep -c '^kind=' "$SPAWNS")" = 1 ] && ok "exactly one call" || no "calls: $(grep -c '^kind=' "$SPAWNS")"
has "$(cat "$LEDGER")" "scout 7 0" && ok "booked in the ledger as kind scout" || no "ledger: $(cat "$LEDGER")"
pk="$(cat "$SCOUT_PACKET_FILE")"
has "$pk" '"kept_files":1,"dropped_files":1' && ok "a path not in the checkout is dropped" || no "merge: $pk"
has "$pk" '"kept_symbols":1,"dropped_symbols":1' && ok "a symbol not in its file is dropped" || no "symbols: $pk"
has "$pk" '"cost_usd":0.0123' && ok "the scout's cost is on the packet" || no "cost"
has "$SCOUT_PROMPT" '"why":"sums the totals"' && has "$SCOUT_PROMPT" 'prove it in test/invoice.test.ts' && ok "the suggestions reach the prompt input" || no "prompt: $SCOUT_PROMPT"
has "$SCOUT_PROMPT" 'src/ghost.ts' && no "a dropped path reached the prompt" || ok "the dropped path never reaches the prompt"
gaffer_scout_cleanup

echo "== G2. review findings: the provider, the subagent tool, a killed call's spend, a long ticket =="
has "$sp" "--disallowedTools Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task,Agent," && ok "the subagent tool is denied by its current name (Agent) too" || no "flags: $sp"
gaffer_scout_run "$REPO" "$SHA" 1
: > "$SPAWNS"
GAFFER_WORKER_PROVIDER=command GAFFER_SCOUT=on GAFFER_SCOUT_MODEL_FLAG="--model cheap-x" gaffer_model_scout 7 "$REPO" "$SHA"
[ ! -s "$SPAWNS" ] && ok "a command worker cannot be held to Read, Grep and Glob: no model scout" || no "command provider spawned"
# A call that ran and was killed (a timeout) leaves an empty envelope: its spend is still
# booked (the ledger estimates it), as for every other launch kind.
worker_deliver() { printf 'kind=%s\n' "${GAFFER_LAUNCH_KIND:-}" >> "$SPAWNS"; : > "$5"; return 124; }
: > "$LEDGER"
GAFFER_SCOUT=on GAFFER_SCOUT_MODEL_FLAG="--model cheap-x" gaffer_model_scout 7 "$REPO" "$SHA"
has "$(cat "$LEDGER")" "scout 7 124" && ok "a killed model scout call is booked (rc 124)" || no "ledger after a timeout: $(cat "$LEDGER")"
# A launch the runner itself refused (budget 77, no sandbox 75, provider 70) spawned nothing: no row.
worker_deliver() { printf 'kind=%s\n' "${GAFFER_LAUNCH_KIND:-}" >> "$SPAWNS"; : > "$5"; return 77; }
: > "$LEDGER"
GAFFER_SCOUT=on GAFFER_SCOUT_MODEL_FLAG="--model cheap-x" gaffer_model_scout 7 "$REPO" "$SHA"
[ ! -s "$LEDGER" ] && ok "a launch the budget refused books nothing" || no "ledger after a refusal: $(cat "$LEDGER")"
# A ticket whose show JSON is past the per-variable environment limit still renders the
# scout prompt (read from the packet's temp file, not the environment).
worker_deliver() { printf 'prompt=%s\n' "$2" | head -3 >> "$SPAWNS"; : > "$5"; return 0; }
BIGDESC="$(head -c 200000 /dev/zero | tr '\0' 'x')"
SHOW="{\"ticket\":{\"title\":\"Round totals\",\"description\":\"See src/invoice.ts $BIGDESC\",\"risk_level\":\"medium\"},\"repositories\":[]}"
gaffer_scout_cleanup; gaffer_scout_run "$REPO" "$SHA" 1; : > "$SPAWNS"
GAFFER_SCOUT=on GAFFER_SCOUT_MODEL_FLAG="--model cheap-x" gaffer_model_scout 7 "$REPO" "$SHA"
has "$(cat "$SPAWNS")" "read-only SCOUT for ticket #7" && ok "a long ticket still renders the model scout prompt" || no "long ticket: no prompt ($(head -c 200 "$SPAWNS"))"
gaffer_scout_cleanup

echo "== H. the live path: tick.sh gathers and routes on the effective risk, no wording =="
TICK="$RUNNER_DIR/tick.sh"
grep -F 'gaffer_scout_run "$_CARD_REAL_REPO" "$_CARD_BASE_SHA"' "$RUNNER_DIR/lib/tick-launch.sh" > /dev/null && ok "tick.sh builds the packet" || no "tick.sh does not call the scout"
grep -F 'ROUTE_RISK="$SCOUT_RISK"' "$RUNNER_DIR/lib/tick-launch.sh" > /dev/null && ok "the router gets the effective risk" || no "routing ignores the scout"
grep -F 'gaffer_scout_persist "$NUM"' "$RUNNER_DIR/lib/tick-launch.sh" > /dev/null && ok "tick.sh records the packet" || no "no persist"
grep -F 'GF_SCOUT="${SCOUT_PROMPT:-}"' "$RUNNER_DIR/config/09-render.sh" > /dev/null && ok "the prompt inputs carry it" || no "GF_SCOUT not wired"
grep -F 'SCOUT — ' "$TICK" "$RUNNER_DIR"/lib/tick-*.sh "$RUNNER_DIR/lib/scout.sh" > /dev/null && no "prompt wording in the runner" || ok "no prompt wording in tick.sh or scout.sh"

echo
echo "scout-gather: $pass passed, $fail failed"
[ "$fail" = 0 ]
