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
prompt=""; prev=""
for a in "$@"; do [ "$prev" = "-p" ] && prompt="$a"; prev="$a"; done
n="$(ls -1 "$CALLS" 2>/dev/null | wc -l | tr -d ' ')"; n=$((n + 1))
D="$CALLS/$(printf '%03d' "$n")"; mkdir -p "$D"
printf '%s' "$prompt" > "$D/prompt"; pwd -P > "$D/cwd"
env | grep -E '^(GAFFER_|DISPATCH_|MEMORY_)' | sort > "$D/env"
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

echo "== 0. ONBOARDING alpha: digest + file cards written, induction lore filed as a DRAFT =="
( cd "$RUNNER_DIR" && DISPATCH_ONBOARD_REPO="$A" DISPATCH_DB="$DISPATCH_DB" MEMORY_DB="$MEMORY_DB" \
    CREW_DIR="$CREW_DIR" CREW_CONFIG="$CREW_CONFIG" MEMORY_CLI_BIN="$MEMORY_CLI_BIN" \
    node bin/onboard-run.mjs --repo "$A" >>"$GAFFER_DATA/onboard.log" 2>&1 ); orc=$?
[ "$orc" -eq 0 ] && ok "0: onboard-run exited 0" || fail "0: onboard-run exited $orc: $(tail -3 "$GAFFER_DATA/onboard.log" | tr '\n' '|' | cut -c1-400)"
O1="$(last_call onboard)"
[ -n "$O1" ] && ok "0: the onboarding analysis agent ran" || fail "0: no onboarding analysis spawn"
IND_DRAFT_ID="$(lore_id_by_title alpha draft "$INDUCTION")"
[ -n "$IND_DRAFT_ID" ] && ok "0: induction lore filed as a DRAFT ($IND_DRAFT_ID) — human-gated" || fail "0: induction lore not found as a draft: $(lg list --repo alpha --json 2>/dev/null | cut -c1-300)"
[ -z "$(lore_id_by_title alpha active "$INDUCTION")" ] && ok "0: induction lore is NOT active" || fail "0: onboarding auto-activated the induction lore"
lg list --repo alpha --status draft --json 2>/dev/null | grep -q '"kind":"decision"' && ok "0: the induction draft carries its kind (decision) — reachable by the primer once ratified" || fail "0: induction draft has no kind"
CARDS_JSON="$(lg cards-for-scope --canonical "$(lg repo-canonical --repo-root "$A" 2>/dev/null)" --repo alpha --query "tasks soft delete" --json 2>/dev/null || echo '')"
printf '%s' "$CARDS_JSON" | grep -q 'src/tasks.js' && ok "0: onboarding indexed alpha's file cards (src/tasks.js)" || fail "0: no file card for src/tasks.js: $(printf '%s' "$CARDS_JSON" | cut -c1-200)"

echo "== 1. DELIVERY on alpha: alpha's ACTIVE lore + cards, nothing from beta, no drafts =="
A1="$(new_ready_ticket alpha "Add cursor pagination to the task listing" "GET /tasks returns a page of tasks with a cursor.")"
run_tick >/dev/null
[ "$(st "$A1")" = "in_review" ] && ok "1: #$A1 delivered → in_review" || fail "1: status=$(st "$A1")"
D1="$(last_call delivery)"
if [ -z "$D1" ]; then fail "1: no delivery spawn"; else
  assert_prompt "1: delivery/alpha" "$D1" \
    "PRODUCT CONTEXT|$ALPHA_DECISION|PRIOR CONTEXT|src/tasks.js" \
    "$BETA_DECISION|$ALPHA_DRAFT|$INDUCTION"
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

echo
echo "spawns: $(cat "$CALLS"/*/kind | sort | uniq -c | awk '{printf "%s=%s ", $2, $1}')"
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
