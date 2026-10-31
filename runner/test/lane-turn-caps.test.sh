#!/usr/bin/env bash
# =====================================================================
# PER-LANE TURN CAPS — every agent lane has its own knob.
# ---------------------------------------------------------------------
# Only the delivery had a turn cap of its own (GAFFER_MAX_TURNS, 200): the reviewer and
# the security reviewer shared it, and the tester, the conflict resolver and the
# product-owner run had none (wall clock only). Each lane now has its own knob with a
# default, clamped to GAFFER_MAX_TURNS (a ceiling, never a replacement — the policy is
# pinned in turn-caps.test.sh). This file pins the per-lane mechanism:
#   A. the defaults (judge 2), and GAFFER_RESOLVER_MAX_TURNS as the resolver's alias
#   B. both reviewer spawns pass their lane cap to worker_deliver; the security reviewer
#      falls back to the reviewer's knob
#   C. the mjs lanes (tester, resolver, PO) build --max-turns from their role cap through
#      the ONE helper (lib/worker.mjs maxTurnsArgv); the resolver's dry-run argv shows it
#      end to end
#   D. decompose: --max-rounds is the history ceiling (--max-turns still accepted) and
#      GAFFER_DECOMPOSE_AGENT_MAX_TURNS caps the agent on its own (under the ceiling)
# Run: bash runner/test/lane-turn-caps.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/lane-caps.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT
CFG="$RUNNER_DIR/factory.config.sh"
cfg() {  # run a snippet with a clean env + the real factory.config.sh sourced
  env -i PATH="$PATH" HOME="$HOME" GAFFER_DATA="$WORK/data" "$@"
}

echo "== A. the lane defaults =="
mkdir -p "$WORK/data"
DEFS="$(cfg bash -c 'source "$0" >/dev/null 2>&1; printf "%s|%s|%s|%s|%s|%s|%s" "$GAFFER_REVIEW_MAX_TURNS" "$GAFFER_SECURITY_REVIEW_MAX_TURNS" "$GAFFER_TESTER_MAX_TURNS" "$GAFFER_MERGE_MAX_TURNS" "$GAFFER_RESOLVER_MAX_TURNS" "$GAFFER_PO_MAX_TURNS" "$GAFFER_JUDGE_MAX_TURNS"' "$CFG")"
[ "$DEFS" = "60|40|80|60||60|2" ] && ok "defaults: review 60, security 40, tester 80, resolver 60 (alias empty), PO 60, judge 2" || fail "defaults: '$DEFS'"
EXP="$(cfg bash -c 'source "$0" >/dev/null 2>&1; env | grep -E "^GAFFER_(TESTER|MERGE|RESOLVER|PO)_MAX_TURNS=" | sort | cut -d= -f1 | tr "\n" " "' "$CFG")"
[ "$EXP" = "GAFFER_MERGE_MAX_TURNS GAFFER_PO_MAX_TURNS GAFFER_RESOLVER_MAX_TURNS GAFFER_TESTER_MAX_TURNS " ] \
  && ok "the mjs lanes' knobs are exported to bin/*.mjs children" || fail "exported: '$EXP'"

echo "== B. both reviewer spawns carry their lane cap =="
grep -q 'worker_deliver "$WT" "$RPROMPT"' <<<"$(grep -B1 'gaffer_role_turns "${GAFFER_REVIEW_MAX_TURNS:-60}"' "$RUNNER_DIR/lib/review.sh")" \
  && ok "reviewer: GAFFER_REVIEW_MAX_TURNS → worker_deliver's per-call cap" || fail "reviewer spawn does not pass its cap"
grep -q 'worker_deliver "$WT" "$SPROMPT"' <<<"$(grep -B1 'gaffer_role_turns "${GAFFER_SECURITY_REVIEW_MAX_TURNS:-${GAFFER_REVIEW_MAX_TURNS:-40}}"' "$RUNNER_DIR/lib/review.sh")" \
  && ok "security reviewer: GAFFER_SECURITY_REVIEW_MAX_TURNS, else the reviewer's cap" || fail "security reviewer spawn does not pass its cap"

echo "== C. the mjs lanes =="
OUT="$(cd "$RUNNER_DIR" && env -u GAFFER_MAX_TURNS -u GAFFER_PO_MAX_TURNS -u GAFFER_MERGE_MAX_TURNS -u GAFFER_RESOLVER_MAX_TURNS node --input-type=module -e '
  import { maxTurnsArgv } from "./lib/worker.mjs";
  import { buildClaudeArgv as po } from "./bin/product-owner-run.mjs";
  import { buildClaudeArgv as mt, mergeMaxTurns } from "./bin/merge-ticket.mjs";
  const r = {
    unset: maxTurnsArgv(undefined).length === 0 && maxTurnsArgv("").length === 0 && maxTurnsArgv("0").length === 0 && maxTurnsArgv("x").length === 0,
    set: maxTurnsArgv("40").join(" ") === "--max-turns 40",
    poDefault: po({ prompt: "p", mcpConfig: "m", flags: [] }).join(" ").endsWith("--max-turns 60 --allowedTools mcp__dispatch mcp__memory"),
    poSet: po({ prompt: "p", mcpConfig: "m", flags: [], maxTurns: "30" }).join(" ").endsWith("--max-turns 30 --allowedTools mcp__dispatch mcp__memory"),
    mtDefault: mt({ prompt: "p", mcpConfig: "m", flags: [] }).join(" ").endsWith("--max-turns 60"),
    mtAlias: mergeMaxTurns({ GAFFER_RESOLVER_MAX_TURNS: "45", GAFFER_MERGE_MAX_TURNS: "60" }) === 45 &&
      mergeMaxTurns({ GAFFER_MERGE_MAX_TURNS: "30" }) === 30 &&
      mergeMaxTurns({ GAFFER_RESOLVER_MAX_TURNS: "90", GAFFER_MAX_TURNS: "50" }) === 50,
    mtSet: mt({ prompt: "p", mcpConfig: "m", flags: [], maxTurns: "35" }).join(" ").endsWith("--max-turns 35"),
  };
  process.stdout.write(JSON.stringify(r));
' 2>&1)"
for k in unset set poDefault poSet mtDefault mtSet mtAlias; do
  grep -q "\"$k\":true" <<<"$OUT" && ok "argv builder: $k" || fail "argv builder $k: $OUT"
done
grep -q 'maxTurns: testerMaxTurns()' "$RUNNER_DIR/bin/tester-run.mjs" && ok "tester passes its role cap (GAFFER_TESTER_MAX_TURNS)" || fail "tester does not pass its cap"
[ "$(grep -c 'maxTurns: poMaxTurns()' "$RUNNER_DIR/bin/product-owner-run.mjs")" = "2" ] && ok "PO passes its role cap (GAFFER_PO_MAX_TURNS; live + dry-run)" || fail "PO does not pass its cap"
[ "$(grep -c 'maxTurns: mergeMaxTurns()' "$RUNNER_DIR/bin/merge-ticket.mjs")" = "2" ] && ok "resolver passes its role cap (live + dry-run)" || fail "resolver does not pass its cap"
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
dry() { env -u GAFFER_MAX_TURNS -u GAFFER_MERGE_MAX_TURNS -u GAFFER_RESOLVER_MAX_TURNS DISPATCH_DB="$DB" GAFFER_DATA="$WORK/data" "$@" node "$RUNNER_DIR/bin/merge-ticket.mjs" --ticket 7 --dry-run 2>/dev/null | tail -n 1; }
D1="$(dry GAFFER_RESOLVER_MAX_TURNS=45)"; D0="$(dry)"
printf '%s' "$D1" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const a=JSON.parse(s).resolverArgv||[];const i=a.indexOf("--max-turns");process.exit(i>=0&&a[i+1]==="45"?0:1)})' \
  && ok "resolver dry-run argv carries --max-turns 45 from GAFFER_RESOLVER_MAX_TURNS" || fail "resolver dry-run: $D1"
printf '%s' "$D0" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const a=JSON.parse(s).resolverArgv||[];const i=a.indexOf("--max-turns");process.exit(i>=0&&a[i+1]==="60"?0:1)})' \
  && ok "resolver with the knobs unset: the default --max-turns 60" || fail "resolver default: $D0"

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
  && ok "GAFFER_DECOMPOSE_AGENT_MAX_TURNS caps the decomposer agent on its own (under the 200 ceiling)" || fail "decompose argv: $(tr '\n' ' ' < "$WORK/decompose-argv" 2>/dev/null | tail -c 200)"
( cd "$WORK" && env CLAUDE_BIN="$STUB" GAFFER_DATA="$WORK/data" GAFFER_STRICT_REQUIRE=0 STRICT_MODE=0 GAFFER_MAX_TURNS=200 \
    node "$RUNNER_DIR/bin/decompose.mjs" --brief "a todo app" --max-rounds 3 >/dev/null 2>&1 )
[ "$(grep -A1 -x -- '--max-turns' "$WORK/decompose-argv" 2>/dev/null | tail -1)" = "3" ] \
  && ok "unset → the helper's own cap (--max-rounds 3; GAFFER_MAX_TURNS is only a ceiling, never a replacement)" || fail "decompose default argv: $(tr '\n' ' ' < "$WORK/decompose-argv" 2>/dev/null | tail -c 200)"
( cd "$WORK" && env CLAUDE_BIN="$STUB" GAFFER_DATA="$WORK/data" GAFFER_STRICT_REQUIRE=0 STRICT_MODE=0 GAFFER_MAX_TURNS=5 GAFFER_DECOMPOSE_AGENT_MAX_TURNS=7 \
    node "$RUNNER_DIR/bin/decompose.mjs" --brief "a todo app" --max-rounds 3 >/dev/null 2>&1 )
[ "$(grep -A1 -x -- '--max-turns' "$WORK/decompose-argv" 2>/dev/null | tail -1)" = "5" ] \
  && ok "a lower GAFFER_MAX_TURNS (5) still clamps the lane knob (7)" || fail "decompose ceiling argv: $(tr '\n' ' ' < "$WORK/decompose-argv" 2>/dev/null | tail -c 200)"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "lane-turn-caps: PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
