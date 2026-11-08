#!/usr/bin/env bash
# =====================================================================
# PER-LANE TURN CAPS — every agent lane has its own knob.
# ---------------------------------------------------------------------
# Only the delivery had a turn cap of its own (GAFFER_MAX_TURNS, 200): the reviewer and
# the security reviewer shared it, and the tester, the conflict resolver and the
# product-owner run had none (wall clock only). Each lane now has its own cap with a
# default, set through one knob (GAFFER_ROLE_MAX_TURNS="role=N ...") and clamped to
# GAFFER_MAX_TURNS (a ceiling, never a replacement — the policy is pinned in
# turn-caps.test.sh). This file pins the per-lane mechanism:
#   A. the defaults (judge 2), the one exported knob, and the deprecated per-lane
#      variables (GAFFER_RESOLVER_MAX_TURNS still the resolver's) with their warning
#   B. both reviewer spawns pass their lane cap to worker_deliver
#   C. the mjs lanes (tester, resolver, PO) build --max-turns from their role cap through
#      the ONE helper (lib/worker.mjs maxTurnsArgv); the resolver's dry-run argv shows it
#      end to end
#   D. decompose: --max-rounds is the history ceiling (--max-turns still accepted) and
#      decompose= (or the deprecated GAFFER_DECOMPOSE_AGENT_MAX_TURNS) caps the agent on
#      its own (under the ceiling)
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
DEFS="$(cfg bash -c 'source "$0" >/dev/null 2>&1; for r in review:60 security_review:40 tester:80 merge:60 po:60 judge:2 clarify:40 scout:6 onboard:60; do printf "%s|" "$(gaffer_role_cap "${r%%:*}" "${r#*:}")"; done' "$CFG")"
[ "$DEFS" = "60|40|80|60|60|2|40|6|60|" ] && ok "defaults: review 60, security 40, tester 80, resolver 60, PO 60, judge 2, clarify 40, scout 6, onboard 60" || fail "defaults: '$DEFS'"
EXP="$(cfg bash -c 'source "$0" >/dev/null 2>&1; env | grep -E "^GAFFER_[A-Z_]*MAX_TURNS=" | sort | cut -d= -f1 | tr "\n" " "' "$CFG")"
[ "$EXP" = "GAFFER_MAX_TURNS GAFFER_ROLE_MAX_TURNS " ] \
  && ok "one knob for every lane, exported to bin/*.mjs children (no per-lane variable left)" || fail "exported: '$EXP'"
WARN="$(cfg GAFFER_RESOLVER_MAX_TURNS=45 GAFFER_PO_MAX_TURNS=30 bash -c 'source "$0" 2>&1 >/dev/null; source "$0" 2>&1 >/dev/null; printf "|%s|%s" "$(gaffer_role_cap merge 60)" "$(gaffer_role_cap po 60)"' "$CFG")"
[ "$(grep -c 'GAFFER_RESOLVER_MAX_TURNS is deprecated' <<<"$WARN")" = "1" ] && [ "$(grep -c 'GAFFER_PO_MAX_TURNS is deprecated' <<<"$WARN")" = "1" ] \
  && grep -q 'GAFFER_ROLE_MAX_TURNS="merge=N"' <<<"$WARN" && ok "a deprecated lane variable warns once per process tree and names the replacement" || fail "deprecation warning: '$WARN'"
[ "${WARN##*|45|}" = "30" ] && ok "the deprecated variables still set their lane's cap" || fail "deprecated caps: '$WARN'"

echo "== B. both reviewer spawns carry their lane cap =="
grep -q 'worker_deliver "$WT" "$RPROMPT"' <<<"$(grep -B1 -F 'gaffer_role_turns "$(gaffer_role_cap review 60)"' "$RUNNER_DIR/lib/review.sh")" \
  && ok "reviewer: its lane cap → worker_deliver's per-call cap" || fail "reviewer spawn does not pass its cap"
grep -q 'worker_deliver "$WT" "$SPROMPT"' <<<"$(grep -B1 -F 'gaffer_role_turns "$(gaffer_role_cap security_review 40)"' "$RUNNER_DIR/lib/review.sh")" \
  && ok "security reviewer: its own lane cap (40)" || fail "security reviewer spawn does not pass its cap"

echo "== C. the mjs lanes =="
OUT="$(cd "$RUNNER_DIR" && env -u GAFFER_MAX_TURNS -u GAFFER_ROLE_MAX_TURNS -u GAFFER_PO_MAX_TURNS -u GAFFER_MERGE_MAX_TURNS -u GAFFER_RESOLVER_MAX_TURNS node --input-type=module -e '
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
    mtRole: mergeMaxTurns({ GAFFER_ROLE_MAX_TURNS: "merge=33" }) === 33 &&
      mergeMaxTurns({ GAFFER_ROLE_MAX_TURNS: "po=5,merge=33", GAFFER_RESOLVER_MAX_TURNS: "45" }) === 33,
    mtSet: mt({ prompt: "p", mcpConfig: "m", flags: [], maxTurns: "35" }).join(" ").endsWith("--max-turns 35"),
  };
  process.stdout.write(JSON.stringify(r));
' 2>&1)"
for k in unset set poDefault poSet mtDefault mtSet mtAlias mtRole; do
  grep -q "\"$k\":true" <<<"$OUT" && ok "argv builder: $k" || fail "argv builder $k: $OUT"
done
grep -q 'maxTurns: testerMaxTurns()' "$RUNNER_DIR/bin/tester-run.mjs" && ok "tester passes its role cap (tester=)" || fail "tester does not pass its cap"
[ "$(grep -c 'maxTurns: poMaxTurns()' "$RUNNER_DIR/bin/product-owner-run.mjs")" = "2" ] && ok "PO passes its role cap (po=; live + dry-run)" || fail "PO does not pass its cap"
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
dry() { env -u GAFFER_MAX_TURNS -u GAFFER_ROLE_MAX_TURNS -u GAFFER_MERGE_MAX_TURNS -u GAFFER_RESOLVER_MAX_TURNS DISPATCH_DB="$DB" GAFFER_DATA="$WORK/data" "$@" node "$RUNNER_DIR/bin/merge-ticket.mjs" --ticket 7 --dry-run 2>/dev/null | tail -n 1; }
D1="$(dry GAFFER_ROLE_MAX_TURNS=merge=45)"; D0="$(dry)"
printf '%s' "$D1" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const a=JSON.parse(s).resolverArgv||[];const i=a.indexOf("--max-turns");process.exit(i>=0&&a[i+1]==="45"?0:1)})' \
  && ok "resolver dry-run argv carries --max-turns 45 from GAFFER_ROLE_MAX_TURNS merge=45" || fail "resolver dry-run: $D1"
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
( cd "$WORK" && env CLAUDE_BIN="$STUB" GAFFER_DATA="$WORK/data" GAFFER_STRICT_REQUIRE=0 STRICT_MODE=0 GAFFER_MAX_TURNS=200 GAFFER_ROLE_MAX_TURNS=decompose=7 \
    node "$RUNNER_DIR/bin/decompose.mjs" --brief "a todo app" --max-rounds 3 >/dev/null 2>&1 )
[ "$(grep -A1 -x -- '--max-turns' "$WORK/decompose-argv" 2>/dev/null | tail -1)" = "7" ] \
  && ok "decompose=7 caps the decomposer agent on its own (under the 200 ceiling)" || fail "decompose argv: $(tr '\n' ' ' < "$WORK/decompose-argv" 2>/dev/null | tail -c 200)"
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
