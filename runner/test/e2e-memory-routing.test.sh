#!/usr/bin/env bash
# =====================================================================
# E2E — the RIGHT MEMORY reaches the RIGHT AGENT at the RIGHT TIME.
# ---------------------------------------------------------------------
# Real dispatch + real memory + real tick.sh + the real onboarding runner, with a stub
# `claude` that snapshots every prompt it is handed. Two repos are onboarded with
# DIFFERENT lore; the test asserts what each agent's prompt carried:
#
#   0. ONBOARDING (alpha) writes the digest, indexes file cards and files the model's
#      induction lore as a DRAFT — never active.
#   1. DELIVERY on alpha is primed with alpha's ACTIVE product-intent lore (PRODUCT
#      CONTEXT) and alpha's file cards (PRIOR CONTEXT); it never sees beta's lore, the
#      unratified induction draft, or an agent's unratified suggestion.
#   2. After the delivery the distiller has filed the ticket's requirement as a DRAFT
#      tagged with the ticket (memory is written at submit time, human-gated).
#   3. Ratifying the induction draft (`memory approve`) is what makes it reach the NEXT
#      delivery on alpha — and only alpha.
#   4. DELIVERY on beta is primed with beta's lore, not alpha's.
#   5. The REVIEWER on alpha is oriented with alpha's file cards and sees no beta lore.
#   6. The delivery's MEMORY ATTRIBUTION (memory_primed evidence) lands on the real
#      dispatch DB, and the agent-mounted memory MCP server — spawned exactly from the
#      rendered runtime config — serves alpha's cards from the worktree with no
#      repoCanonical guess and keeps agent-suggested lore a DRAFT even when
#      MEMORY_AUTO_APPROVE=1 leaks into its env.
#
# Step 1 also asserts that alpha's ACTIVE conventions / gotchas recalled for the
# ticket ride in the PRIOR CONTEXT block (beta's never do).
#
# Run: bash runner/test/e2e-memory-routing.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }
for f in packages/dispatch/dist/cli/index.js packages/memory/dist/bin/memory.js packages/crew/dist/cli/index.js packages/crew/dist/runtime/context/renderContextPrimerCli.js; do
  [ -f "$ROOT/$f" ] || { echo "SKIP: $f not built (run pnpm -r build)"; exit 0; }
done

PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/memory-routing.XXXXXX")"; WORK="$(cd "$WORK" && pwd -P)"
[ "${KEEP:-0}" = 1 ] || trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/data" "$WORK/bin" "$WORK/calls"
CALLS="$WORK/calls"

# ── two repos ────────────────────────────────────────────────────────────────
A="$WORK/alpha"; mkdir -p "$A/src" "$A/test"
( cd "$A" && git init -q -b main
  printf '{ "name": "alpha", "version": "0.1.0", "private": true, "type": "module", "scripts": { "test": "node --test", "lint": "node -e 0" } }\n' > package.json
  printf '# alpha\n\nA task service. Tasks are soft-deleted; errors are RFC 7807 problem documents.\n' > README.md
  printf '// Task list helpers: paging, filtering and soft-delete of task rows.\nexport function listTasks(l) { return l; }\nexport function softDeleteTask(t) { return { ...t, deleted_at: Date.now() }; }\n' > src/tasks.js
  printf 'import test from "node:test"; import assert from "node:assert/strict";\nimport { listTasks } from "../src/tasks.js";\ntest("lists", () => { assert.equal(listTasks([]).length, 0); });\n' > test/tasks.test.js
  git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init )
B="$WORK/beta"; mkdir -p "$B/app"
( cd "$B" && git init -q -b main
  printf 'def login(user, password):\n    return user == "admin" and password == "x"\n' > app/auth.py
  printf '# beta\n' > README.md
  git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init )

# The onboarding analysis the stub agent returns for alpha: a digest, no features, ONE
# cited lore record. It must land as a DRAFT (human-gated) — never active.
ANALYSIS="$WORK/analysis.json"
cat > "$ANALYSIS" <<'JSON'
{
  "digest": {
    "overview": "alpha is a small task service exposing list, filter and soft-delete helpers.",
    "structure": "single module: src/tasks.js with node:test tests under test/.",
    "conventions": "ESM node, node --test, RFC 7807 problem documents for errors.",
    "stack": "node"
  },
  "features": [],
  "lore": [
    {
      "title": "Alpha induction: tasks are soft-deleted",
      "summary": "Task rows are never hard-deleted; softDeleteTask stamps deleted_at and every listing filters it.",
      "body": "Source: README.md and src/tasks.js\n\nHard deletes would break the audit trail the service promises.",
      "tags": ["induction", "tasks"],
      "confidence": "low",
      "kind": "decision"
    }
  ]
}
JSON

# ── the recording stub `claude` ──────────────────────────────────────────────
cat > "$WORK/bin/claude" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
CALLS="__CALLS__"; ANALYSIS="__ANALYSIS__"
prompt=""; prev=""; mcp=""
for a in "$@"; do [ "$prev" = "-p" ] && prompt="$a"; [ "$prev" = "--mcp-config" ] && mcp="$a"; prev="$a"; done
n="$(ls -1 "$CALLS" 2>/dev/null | wc -l | tr -d ' ')"; n=$((n + 1))
D="$CALLS/$(printf '%03d' "$n")"; mkdir -p "$D"
printf '%s' "$prompt" > "$D/prompt"; pwd -P > "$D/cwd"
env | grep -E '^(GAFFER_|DISPATCH_|MEMORY_)' | sort > "$D/env"
[ -n "$mcp" ] && [ -f "$mcp" ] && cp "$mcp" "$D/mcp.json"
case "$prompt" in
  *"memory-onboard methodology"*)
    echo onboard > "$D/kind"
    node -e 'const fs=require("fs");const a=fs.readFileSync(process.argv[1],"utf8");process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"Analysis follows.\n```json\n"+a+"\n```",total_cost_usd:0.01,num_turns:1})+"\n")' "$ANALYSIS"
    exit 0 ;;
  *"SECURITY REVIEWER"*)
    echo security > "$D/kind"
    printf '{"type":"result","subtype":"success","is_error":false,"result":"RECOMMEND APPROVE\\n{\\"verdict\\":\\"APPROVE\\"}","total_cost_usd":0.01,"num_turns":2}\n'; exit 0 ;;
  *"REVIEWER agent"*)
    echo review > "$D/kind"
    printf '{"type":"result","subtype":"success","is_error":false,"result":"RECOMMEND APPROVE\\n{\\"verdict\\":\\"APPROVE\\"}","total_cost_usd":0.01,"num_turns":2}\n'; exit 0 ;;
esac
if [ -e .git ]; then
  echo delivery > "$D/kind"
  fn="helper${GAFFER_TICKET:-0}"
  if [ -f package.json ]; then
    grep -q "$fn" src/tasks.js || printf 'export function %s(l){return l;}\n' "$fn" >> src/tasks.js
  else
    printf 'def %s(x):\n    return x\n' "$fn" > "app/$fn.py"
  fi
  git -c user.email=s@s -c user.name=s add -A >/dev/null; git -c user.email=s@s -c user.name=s commit -qm "feat: $fn" >/dev/null 2>&1 || true
  printf '{"type":"result","subtype":"success","is_error":false,"result":"done.","total_cost_usd":0.02,"num_turns":3}\n'; exit 0
fi
echo other > "$D/kind"; printf '{"type":"result","subtype":"success","is_error":false,"result":"ok"}\n'
STUB
sed -i.bak "s|__CALLS__|$CALLS|; s|__ANALYSIS__|$ANALYSIS|" "$WORK/bin/claude" && rm -f "$WORK/bin/claude.bak"; chmod +x "$WORK/bin/claude"

export GAFFER_DATA="$WORK/data" CLAUDE_BIN="$WORK/bin/claude" CLAUDE_FLAGS="" \
       GAFFER_TICK_TIMEOUT=60 GAFFER_MAX_TURNS=10 GAFFER_CARD_MODEL=stub GAFFER_PLAN_MODEL=stub GAFFER_IMPL_MODEL=stub \
       REVIEW_MODE=human DRY_RUN=0 GAFFER_MAINTENANCE=0 AUTO_MERGE=0 GAFFER_STRICT_REQUIRE=0 GAFFER_SECURITY_REVIEW=0
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
wg init >/dev/null 2>&1; lg init >/dev/null 2>&1
wg repo add -n alpha --path "$A" --branch main --stack node --test "npm test" --lint "npm run lint" >/dev/null 2>&1
wg repo add -n beta  --path "$B" --branch main --stack python --test "true" --lint "true" >/dev/null 2>&1

run_tick() { ( cd "$RUNNER_DIR" && bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep '^TICK_RESULT=' ; }
review_tick() {
  rm -f "$GAFFER_DATA/.reviewed-tickets"
  ( cd "$RUNNER_DIR" && REVIEW_MODE=agent DISPATCH_ALLOW_AGENT_APPROVE=1 bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep '^TICK_RESULT='
}
st() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.status'; }
new_ready_ticket() { # $1 repo, $2 title, $3 description
  local n
  n="$(wg ticket create -t "$2" -d "$3" --risk medium 2>/dev/null | jget 'd.ticket.number')"
  wg ac add "$n" -t "the change is covered by a test" >/dev/null 2>&1
  wg ticket repo-access set "$n" "$1" --access write --relation confirmed >/dev/null 2>&1
  wg ticket ready "$n" >/dev/null 2>&1
  printf '%s' "$n"
}
last_call() { grep -lx "$1" "$CALLS"/*/kind 2>/dev/null | tail -1 | xargs -I{} dirname {}; }
prompt_has() { grep -qF -- "$2" "$1/prompt"; }
# assert_prompt <label> <calldir> <present '|'-separated> <absent '|'-separated>
assert_prompt() {
  local label="$1" d="$2" present="$3" absent="$4" miss=() leak=()
  local IFS='|'
  for s in $present; do [ -n "$s" ] && { prompt_has "$d" "$s" || miss+=("$s"); }; done
  for s in $absent; do [ -n "$s" ] && prompt_has "$d" "$s" && leak+=("$s"); done
  unset IFS
  [ "${#miss[@]}" -eq 0 ] && ok "$label: prompt carries: ${present}" || fail "$label: prompt lacks: ${miss[*]}"
  [ "${#leak[@]}" -eq 0 ] && ok "$label: prompt withholds: ${absent}" || fail "$label: prompt leaks: ${leak[*]}"
}
lore_id_by_title() { lg list --repo "$1" --status "$2" --limit 200 --json 2>/dev/null | jget "(d.items||[]).filter(i => i.title === $(printf '%s' "$3" | node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0,"utf8")))')).map(i => i.id)[0] || ''"; }

# ── seed ACTIVE product-intent lore per repo, plus an UNRATIFIED agent suggestion ─
ALPHA_DECISION="Alpha decision: API errors use RFC 7807"
BETA_DECISION="Beta decision: passwords are hashed with argon2id"
ALPHA_DRAFT="Alpha suggestion: not yet ratified"
INDUCTION="Alpha induction: tasks are soft-deleted"
lg add --title "$ALPHA_DECISION" --summary "Every error body is application/problem+json with a stable type URI." --body "Decided in ADR-3." --kind decision --repo alpha --tag api </dev/null >/dev/null 2>&1
lg add --title "$BETA_DECISION" --summary "Never store a reversible or unsalted password hash." --body "Decided in beta ADR-1." --kind decision --repo beta --tag auth </dev/null >/dev/null 2>&1
lg suggest --title "$ALPHA_DRAFT" --summary "An agent proposed this; a human has not reviewed it." --body "pending" --kind requirement --repo alpha </dev/null >/dev/null 2>&1
# Conventions / gotchas (not product intent): recalled per ticket into PRIOR CONTEXT.
ALPHA_CONVENTION="Alpha convention: task listings paginate with an opaque cursor"
ALPHA_GOTCHA="Alpha gotcha: soft-deleted tasks must be filtered from every listing page"
BETA_CONVENTION="Beta convention: login helpers return booleans"
lg add --title "$ALPHA_CONVENTION" --summary "Task list pagination uses an opaque cursor, never page offsets." --body "convention" --kind convention --repo alpha --tag tasks </dev/null >/dev/null 2>&1
lg add --title "$ALPHA_GOTCHA" --summary "A listing page that forgets the deleted_at filter leaks soft-deleted tasks." --body "gotcha" --kind gotcha --repo alpha --tag tasks </dev/null >/dev/null 2>&1
lg add --title "$BETA_CONVENTION" --summary "Task pagination cursor listing helpers in beta return booleans." --body "convention" --kind convention --repo beta --tag auth </dev/null >/dev/null 2>&1

echo "== 0. ONBOARDING alpha: digest + file cards written, induction lore filed as a DRAFT =="
( cd "$RUNNER_DIR" && DISPATCH_ONBOARD_REPO="$A" DISPATCH_DB="$DISPATCH_DB" MEMORY_DB="$MEMORY_DB" GAFFER_CREW_EVENTS="$GAFFER_DATA/events.jsonl" \
    CREW_DIR="$CREW_DIR" CREW_CONFIG="$CREW_CONFIG" MEMORY_CLI_BIN="$MEMORY_CLI_BIN" \
    node bin/onboard-run.mjs --repo "$A" >>"$GAFFER_DATA/onboard.log" 2>&1 ); orc=$?
[ "$orc" -eq 0 ] && ok "0: onboard-run exited 0" || fail "0: onboard-run exited $orc: $(tail -3 "$GAFFER_DATA/onboard.log" | tr '\n' '|' | cut -c1-400)"
O1="$(last_call onboard)"
[ -n "$O1" ] && ok "0: the onboarding analysis agent ran" || fail "0: no onboarding analysis spawn"
IND_DRAFT_ID="$(lore_id_by_title alpha draft "$INDUCTION")"
[ -n "$IND_DRAFT_ID" ] && ok "0: induction lore filed as a DRAFT ($IND_DRAFT_ID) — human-gated" || fail "0: induction lore not found as a draft: $(lg list --repo alpha --json 2>/dev/null | cut -c1-300)"
[ -z "$(lore_id_by_title alpha active "$INDUCTION")" ] && ok "0: induction lore is NOT active" || fail "0: onboarding auto-activated the induction lore"
grep -q '"kind":"decision"' <<<"$(lg list --repo alpha --status draft --json 2>/dev/null)" && ok "0: the induction draft carries its kind (decision) — reachable by the primer once ratified" || fail "0: induction draft has no kind"
CARDS_JSON="$(lg cards-for-scope --canonical "$(lg repo-canonical --repo-root "$A" 2>/dev/null)" --repo alpha --query "tasks soft delete" --json 2>/dev/null || echo '')"
grep -q 'src/tasks.js' <<<"$CARDS_JSON" && ok "0: onboarding indexed alpha's file cards (src/tasks.js)" || fail "0: no file card for src/tasks.js: $(printf '%s' "$CARDS_JSON" | cut -c1-200)"

echo "== 1. DELIVERY on alpha: alpha's ACTIVE lore + cards, nothing from beta, no drafts =="
A1="$(new_ready_ticket alpha "Add cursor pagination to the task listing" "GET /tasks returns a page of tasks with a cursor.")"
run_tick >/dev/null
[ "$(st "$A1")" = "in_review" ] && ok "1: #$A1 delivered → in_review" || fail "1: status=$(st "$A1")"
D1="$(last_call delivery)"
if [ -z "$D1" ]; then fail "1: no delivery spawn"; else
  assert_prompt "1: delivery/alpha" "$D1" \
    "PRODUCT CONTEXT|$ALPHA_DECISION|PRIOR CONTEXT|src/tasks.js|$ALPHA_CONVENTION|$ALPHA_GOTCHA" \
    "$BETA_DECISION|$ALPHA_DRAFT|$INDUCTION|$BETA_CONVENTION"
  # The recalled lore rides INSIDE the file-cards envelope (retrieval data).
  grep -qF "[convention] $ALPHA_CONVENTION" <<<"$(awk '/<untrusted-file-cards>/,/<\/untrusted-file-cards>/' "$D1/prompt")" \
    && ok "1: the convention is quarantined inside <untrusted-file-cards>" || fail "1: convention not inside the file-cards envelope"
  _NCARDS="$(awk '/<untrusted-file-cards>/,/Recalled lore for this scope/' "$D1/prompt" | grep -c '^  - \[' || true)"
  grep -q "cards: primed delivery #$A1 with $_NCARDS file card" "$GAFFER_DATA/factory.log" \
    && ok "1: the cards count ($_NCARDS) excludes the recalled-lore lines" || fail "1: cards count (want $_NCARDS): $(grep "cards: primed delivery #$A1" "$GAFFER_DATA/factory.log" | tail -1)"
  grep -q "product-context: primed delivery #$A1" "$GAFFER_DATA/factory.log" && ok "1: runner logged the product-context prime" || fail "1: no product-context log line"
  grep -q "cards: primed delivery #$A1 with [1-9]" "$GAFFER_DATA/factory.log" && ok "1: runner logged the file-card prime" || fail "1: cards log: $(grep "cards:" "$GAFFER_DATA/factory.log" | tail -1)"
  grep -q '"GAFFER_TICKET_REPOS": *"alpha"' "$D1/env" 2>/dev/null || true
fi

echo "== 2. After the delivery: the distiller filed the ticket's requirement as a DRAFT =="
DIST="$(lg search --repo alpha --tag "ticket-$A1" --include-drafts --json 2>/dev/null || echo '[]')"
[ "$(printf '%s' "$DIST" | jget 'Array.isArray(d) ? d.length : 0')" = "1" ] && ok "2: one distilled record tagged ticket-$A1" || fail "2: distilled records for ticket-$A1: $(printf '%s' "$DIST" | cut -c1-200)"
[ "$(lg search --repo alpha --tag "ticket-$A1" --json 2>/dev/null | jget 'Array.isArray(d) ? d.length : 0')" = "0" ] && ok "2: the distilled requirement is a DRAFT (not active) under the supervised default" || fail "2: distilled requirement is already active"

echo "== 3. Ratifying the induction draft is what lets it reach the NEXT alpha delivery =="
lg approve "$IND_DRAFT_ID" >/dev/null 2>&1 && ok "3: memory approve $IND_DRAFT_ID" || fail "3: approve failed"
A2="$(new_ready_ticket alpha "Filter tasks by status" "GET /tasks?status= filters the listing.")"
run_tick >/dev/null
D2="$(last_call delivery)"
if [ -z "$D2" ] || [ "$D2" = "$D1" ]; then fail "3: no second alpha delivery spawn (status=$(st "$A2"))"; else
  assert_prompt "3: delivery/alpha after ratification" "$D2" \
    "PRODUCT CONTEXT|$ALPHA_DECISION|$INDUCTION" \
    "$BETA_DECISION|$ALPHA_DRAFT"
fi

echo "== 4. DELIVERY on beta: beta's lore, not alpha's =="
B1="$(new_ready_ticket beta "Reject empty passwords at login" "login() must refuse an empty password.")"
run_tick >/dev/null
D3="$(last_call delivery)"
if [ -z "$D3" ] || [ "$D3" = "$D2" ]; then fail "4: no beta delivery spawn (status=$(st "$B1"))"; else
  assert_prompt "4: delivery/beta" "$D3" \
    "PRODUCT CONTEXT|$BETA_DECISION" \
    "$ALPHA_DECISION|$INDUCTION|$ALPHA_DRAFT|src/tasks.js"
fi

echo "== 5. REVIEW on alpha: oriented with alpha's cards, no beta lore =="
review_tick >/dev/null
R1="$(last_call review)"
if [ -z "$R1" ]; then fail "5: no reviewer spawn"; else
  REVIEWED="$(grep -o '#[0-9]*' "$R1/prompt" | head -1)"
  ok "5: the reviewer ran (${REVIEWED:-?})"
  assert_prompt "5: reviewer/alpha" "$R1" "REVIEWER agent|PRIOR CONTEXT" "$BETA_DECISION|$ALPHA_DRAFT"
fi

echo "== 6. Attribution evidence + the agent-mounted memory MCP server (rendered config) =="
EVID="$(wg ticket show "$A1" 2>/dev/null | jget '(d.evidence||[]).filter(e => e.evidence_type === "memory_primed").map(e => e.summary).join("\n")')"
case "$EVID" in
  *"src/tasks.js"*) ok "6: memory_primed evidence recorded on #$A1 in the real dispatch DB" ;;
  *) fail "6: no memory_primed evidence on #$A1: $(wg ticket show "$A1" 2>/dev/null | jget '(d.evidence||[]).map(e => e.evidence_type).join(",")')" ;;
esac
case "$EVID" in *"lore:"*) ok "6: the evidence names the recalled lore" ;; *) fail "6: evidence lacks the lore: $EVID" ;; esac
if [ -n "${D1:-}" ] && [ -f "$D1/mcp.json" ]; then
  MENV="$(jget 'JSON.stringify(d.mcpServers.memory.env)' < "$D1/mcp.json")"
  grep -qF '"MEMORY_AUTO_APPROVE":"0"' <<<"$MENV" && ok "6: rendered memory server pins MEMORY_AUTO_APPROVE=0" || fail "6: memory env: $MENV"
  [ "$(jget 'JSON.parse(d.mcpServers.memory.env.GAFFER_REPO_CANONICALS || "{}").alpha || ""' < "$D1/mcp.json")" = "$(lg repo-canonical --repo-root "$A")" ] \
    && ok "6: rendered memory server binds alpha's canonical (the REAL repo's key)" || fail "6: GAFFER_REPO_CANONICALS: $MENV"
  cat > "$WORK/mcpclient.mjs" <<'MJS'
// node mcpclient.mjs <mcp.json> <calls.json>: spawn the memory server EXACTLY as the
// rendered config says, with the runner env underneath (MEMORY_AUTO_APPROVE=1 leaked
// in), run the calls, print one JSON line per call.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
const [cfgPath, callsPath] = process.argv.slice(2);
const cfg = JSON.parse(readFileSync(cfgPath, "utf8")).mcpServers.memory;
const env = { ...process.env, MEMORY_AUTO_APPROVE: "1", MEMORY_AUDIT_OFF: "1", ...cfg.env };
const p = spawn(cfg.command, cfg.args, { env, stdio: ["pipe", "pipe", "ignore"] });
let buf = ""; const waiters = new Map(); let id = 0;
p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); waiters.get(m.id)?.(m); } catch {} } });
const rpc = (method, params) => new Promise((res) => { const n = ++id; waiters.set(n, res); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
for (const c of JSON.parse(readFileSync(callsPath, "utf8"))) {
  const r = await rpc("tools/call", { name: c.name, arguments: c.args });
  const text = (r.result?.content ?? []).map((x) => x.text).join("");
  let j = null; try { j = JSON.parse(text); } catch {}
  console.log(JSON.stringify({ name: c.name, isError: Boolean(r.result?.isError), cards: j?.cards?.length ?? j?.count ?? null, status: j?.status ?? null }));
}
p.kill();
MJS
  WTCWD="$(cat "$D1/cwd")"
  node -e 'const [wt]=process.argv.slice(1);process.stdout.write(JSON.stringify([
    {name:"cards_for_scope",args:{repo:"alpha",query:"tasks soft delete"}},
    {name:"cards_for_scope",args:{repoCanonical:wt,repo:"alpha",query:"tasks soft delete"}},
    {name:"search_file_cards",args:{repo:"alpha",query:"tasks"}},
    {name:"suggest_lore",args:{title:"E2E agent suggestion over MCP",summary:"s",body:"b",kind:"convention"}}]))' "$WTCWD" > "$WORK/calls.json"
  # (The worktree itself is gone after the tick; its path is still the agent's guess.)
  MCPOUT="$(timeout 60 node "$WORK/mcpclient.mjs" "$D1/mcp.json" "$WORK/calls.json" 2>&1)"
  [ "$(printf '%s\n' "$MCPOUT" | sed -n 1p | jget 'd.cards')" -ge 1 ] 2>/dev/null \
    && ok "6: MCP cards_for_scope with NO repoCanonical serves alpha's cards" || fail "6: cards_for_scope (no canonical): $(printf '%s\n' "$MCPOUT" | sed -n 1p)"
  [ "$(printf '%s\n' "$MCPOUT" | sed -n 2p | jget 'd.cards')" -ge 1 ] 2>/dev/null \
    && ok "6: MCP cards_for_scope with the worktree path as canonical still serves them" || fail "6: cards_for_scope (worktree canonical): $(printf '%s\n' "$MCPOUT" | sed -n 2p)"
  [ "$(printf '%s\n' "$MCPOUT" | sed -n 3p | jget 'd.cards')" -ge 1 ] 2>/dev/null \
    && ok "6: MCP search_file_cards with NO repoCanonical finds alpha's cards" || fail "6: search_file_cards: $(printf '%s\n' "$MCPOUT" | sed -n 3p)"
  [ "$(printf '%s\n' "$MCPOUT" | sed -n 4p | jget 'd.status')" = "draft" ] \
    && ok "6: agent suggest_lore lands as a DRAFT despite MEMORY_AUTO_APPROVE=1 in the env" || fail "6: suggest_lore: $(printf '%s\n' "$MCPOUT" | sed -n 4p)"
else
  fail "6: the delivery's runtime MCP config was not captured"
fi

echo
echo "spawns: $(cat "$CALLS"/*/kind | sort | uniq -c | awk '{printf "%s=%s ", $2, $1}')"
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
