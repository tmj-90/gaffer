#!/usr/bin/env bash
# =====================================================================
# PER-LANE TURN CAPS — the mechanism, with the defaults unchanged.
# ---------------------------------------------------------------------
# Only the delivery had a turn cap of its own (GAFFER_MAX_TURNS, 200): the reviewer and
# the security reviewer shared it, and the tester, the conflict resolver and the
# product-owner run had none (wall clock only). Each lane now has its own knob. EMPTY
# keeps the old behaviour exactly, so nothing an operator relies on for cost moves:
#   A. the bash helper gaffer_lane_turns_flag: a positive cap → --max-turns N; empty or
#      junk → the shared $GAFFER_MAX_TURNS_FLAG; the defaults are empty (judge: 2)
#   B. both reviewer spawns pass their lane cap as a per-call GAFFER_MAX_TURNS_FLAG
#   C. the mjs lanes (tester, resolver, PO) build --max-turns from their knob through the
#      ONE helper (lib/worker.mjs maxTurnsArgv) and add nothing when it is unset; the
#      resolver's dry-run argv shows it end to end
#   D. decompose: --max-rounds is the history ceiling (--max-turns still accepted) and
#      GAFFER_DECOMPOSE_AGENT_MAX_TURNS caps the agent on its own
# Run: bash runner/test/lane-turn-caps.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/lane-caps.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
CFG="$RUNNER_DIR/factory.config.sh"
cfg() {  # run a snippet with a clean env + the real factory.config.sh sourced
  env -i PATH="$PATH" HOME="$HOME" GAFFER_DATA="$WORK/data" "$@"
}

echo "== A. gaffer_lane_turns_flag + the defaults =="
mkdir -p "$WORK/data"
flag() { cfg GAFFER_MAX_TURNS=200 bash -c 'source "$0" >/dev/null 2>&1; gaffer_lane_turns_flag "$@"' "$CFG" "$@"; }
[ "$(flag "")" = "--max-turns 200" ] && ok "empty cap → the shared GAFFER_MAX_TURNS flag (unchanged)" || fail "empty → '$(flag "")'"
[ "$(flag 40)" = "--max-turns 40" ] && ok "cap 40 → --max-turns 40" || fail "40 → '$(flag 40)'"
[ "$(flag "" 25)" = "--max-turns 25" ] && ok "first positive cap wins (security falls back to the reviewer's)" || fail "fallback → '$(flag "" 25)'"
[ "$(flag 0)" = "--max-turns 200" ] && [ "$(flag abc)" = "--max-turns 200" ] && ok "0 / junk → the shared flag" || fail "junk → '$(flag abc)'"
DEFS="$(cfg bash -c 'source "$0" >/dev/null 2>&1; printf "%s|%s|%s|%s|%s|%s" "$GAFFER_REVIEW_MAX_TURNS" "$GAFFER_SECURITY_REVIEW_MAX_TURNS" "$GAFFER_TESTER_MAX_TURNS" "$GAFFER_RESOLVER_MAX_TURNS" "$GAFFER_PO_MAX_TURNS" "$GAFFER_JUDGE_MAX_TURNS"' "$CFG")"
[ "$DEFS" = "|||||2" ] && ok "defaults: every lane cap empty (behaviour unchanged); judge 2" || fail "defaults: '$DEFS'"

echo "== B. both reviewer spawns carry their lane cap =="
grep -A1 'GAFFER_MAX_TURNS_FLAG="$(gaffer_lane_turns_flag "${GAFFER_REVIEW_MAX_TURNS:-}")"' "$RUNNER_DIR/lib/review.sh" | grep -q 'worker_deliver "$WT" "$RPROMPT"' \
  && ok "reviewer: GAFFER_REVIEW_MAX_TURNS → per-call GAFFER_MAX_TURNS_FLAG" || fail "reviewer spawn does not pass its cap"
grep -A1 'GAFFER_MAX_TURNS_FLAG="$(gaffer_lane_turns_flag "${GAFFER_SECURITY_REVIEW_MAX_TURNS:-}" "${GAFFER_REVIEW_MAX_TURNS:-}")"' "$RUNNER_DIR/lib/review.sh" | grep -q 'worker_deliver "$WT" "$SPROMPT"' \
  && ok "security reviewer: GAFFER_SECURITY_REVIEW_MAX_TURNS, else the reviewer's cap" || fail "security reviewer spawn does not pass its cap"

echo "== C. the mjs lanes =="
OUT="$(cd "$RUNNER_DIR" && node --input-type=module -e '
  import { maxTurnsArgv } from "./lib/worker.mjs";
  import { buildClaudeArgv as po } from "./bin/product-owner-run.mjs";
  import { buildClaudeArgv as mt } from "./bin/merge-ticket.mjs";
  const r = {
    unset: maxTurnsArgv(undefined).length === 0 && maxTurnsArgv("").length === 0 && maxTurnsArgv("0").length === 0 && maxTurnsArgv("x").length === 0,
    set: maxTurnsArgv("40").join(" ") === "--max-turns 40",
    poUnset: !po({ prompt: "p", mcpConfig: "m", flags: [] }).includes("--max-turns"),
    poSet: po({ prompt: "p", mcpConfig: "m", flags: [], maxTurns: "30" }).join(" ").endsWith("--max-turns 30 --allowedTools mcp__dispatch mcp__memory"),
    mtUnset: !mt({ prompt: "p", mcpConfig: "m", flags: [] }).includes("--max-turns"),
    mtSet: mt({ prompt: "p", mcpConfig: "m", flags: [], maxTurns: "35" }).join(" ").endsWith("--max-turns 35"),
  };
  process.stdout.write(JSON.stringify(r));
' 2>&1)"
for k in unset set poUnset poSet mtUnset mtSet; do
  printf '%s' "$OUT" | grep -q "\"$k\":true" && ok "argv builder: $k" || fail "argv builder $k: $OUT"
done
grep -q 'maxTurns: process.env.GAFFER_TESTER_MAX_TURNS' "$RUNNER_DIR/bin/tester-run.mjs" && ok "tester passes GAFFER_TESTER_MAX_TURNS" || fail "tester does not pass its cap"
[ "$(grep -c 'maxTurns: process.env.GAFFER_PO_MAX_TURNS' "$RUNNER_DIR/bin/product-owner-run.mjs")" = "2" ] && ok "PO passes GAFFER_PO_MAX_TURNS (live + dry-run)" || fail "PO does not pass its cap"
# Resolver end to end: --dry-run reports the resolver argv it would spawn.
R="$WORK/repo"; git init -q -b main "$R"; git -C "$R" -c user.email=t@t -c user.name=t commit -q --allow-empty -m base
git -C "$R" branch gaffer/ticket-7-x
DB="$WORK/db.sqlite"
node --no-warnings -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1]);d.exec(process.argv[2]);d.close()' "$DB" "CREATE TABLE tickets (id TEXT PRIMARY KEY, number INTEGER UNIQUE, title TEXT, status TEXT, branch_name TEXT, pr_url TEXT);
 CREATE TABLE repositories (id TEXT PRIMARY KEY, name TEXT UNIQUE, local_path TEXT, default_branch TEXT, stack TEXT);
 CREATE TABLE ticket_repos (ticket_id TEXT, repo_id TEXT, role TEXT, branch_name TEXT, access TEXT, pr_url TEXT);
 INSERT INTO tickets VALUES ('t7',7,'x','ready_for_merge','gaffer/ticket-7-x',NULL);
 INSERT INTO repositories VALUES ('r1','demo','$R','main','');
 INSERT INTO ticket_repos VALUES ('t7','r1','primary','gaffer/ticket-7-x','write',NULL);" 2>/dev/null
dry() { env DISPATCH_DB="$DB" GAFFER_DATA="$WORK/data" "$@" node "$RUNNER_DIR/bin/merge-ticket.mjs" --ticket 7 --dry-run 2>/dev/null | tail -n 1; }
D1="$(dry GAFFER_RESOLVER_MAX_TURNS=45)"; D0="$(dry)"
printf '%s' "$D1" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const a=JSON.parse(s).resolverArgv||[];const i=a.indexOf("--max-turns");process.exit(i>=0&&a[i+1]==="45"?0:1)})' \
  && ok "resolver dry-run argv carries --max-turns 45 from GAFFER_RESOLVER_MAX_TURNS" || fail "resolver dry-run: $D1"
printf '%s' "$D0" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const a=JSON.parse(s).resolverArgv||null;process.exit(a&&!a.includes("--max-turns")?0:1)})' \
  && ok "resolver with the knob unset: no --max-turns (unchanged)" || fail "resolver default: $D0"

echo "== D. decompose: history rounds vs the agent turn cap =="
STUB="$WORK/claude-decompose"
cat > "$STUB" <<STUBEOF
#!/usr/bin/env bash
printf '%s\n' "\$@" > "$WORK/decompose-argv"
printf '%s\n' '{"type":"result","subtype":"success","result":"{\"phase\":\"clarify\",\"questions\":[\"Which users?\"]}","num_turns":1}'
STUBEOF
chmod +x "$STUB"
( cd "$WORK" && env CLAUDE_BIN="$STUB" GAFFER_DATA="$WORK/data" GAFFER_STRICT_REQUIRE=0 STRICT_MODE=0 GAFFER_MAX_TURNS=200 GAFFER_DECOMPOSE_AGENT_MAX_TURNS=7 \
    node "$RUNNER_DIR/bin/decompose.mjs" --brief "a todo app" --max-rounds 3 >/dev/null 2>&1 )
[ "$(grep -A1 -x -- '--max-turns' "$WORK/decompose-argv" 2>/dev/null | tail -1)" = "7" ] \
  && ok "GAFFER_DECOMPOSE_AGENT_MAX_TURNS caps the decomposer agent (beats GAFFER_MAX_TURNS)" || fail "decompose argv: $(tr '\n' ' ' < "$WORK/decompose-argv" 2>/dev/null | tail -c 200)"
( cd "$WORK" && env CLAUDE_BIN="$STUB" GAFFER_DATA="$WORK/data" GAFFER_STRICT_REQUIRE=0 STRICT_MODE=0 GAFFER_MAX_TURNS=200 \
    node "$RUNNER_DIR/bin/decompose.mjs" --brief "a todo app" --max-rounds 3 >/dev/null 2>&1 )
[ "$(grep -A1 -x -- '--max-turns' "$WORK/decompose-argv" 2>/dev/null | tail -1)" = "200" ] \
  && ok "unset → GAFFER_MAX_TURNS as before; --max-rounds accepted" || fail "decompose default argv: $(tr '\n' ' ' < "$WORK/decompose-argv" 2>/dev/null | tail -c 200)"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "lane-turn-caps: PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
