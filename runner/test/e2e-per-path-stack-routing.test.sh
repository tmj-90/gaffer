#!/usr/bin/env bash
# =====================================================================
# E2E — PER-PATH STACK ROUTING on a mixed .NET + TypeScript repo, live.
# ---------------------------------------------------------------------
# One repo, one compound stack label (`csharp-typescript-react`): a solution under api/
# and a React SPA under web/. Real dispatch + real tick.sh + a recording stub agent:
#   A. a ticket that NAMES a .cs file → the delivery agent gets the C# pack and NOT the
#      TypeScript pack / React design bar; its REVIEWER (whose diff touches only .cs)
#      gets the same narrowing.
#   B. a ticket that names a .tsx file → TypeScript + React packs, no C# pack; the
#      reviewer of the .tsx-only diff likewise.
#   C. a ticket naming no file → BOTH packs (the repo's full compound stack).
# Run: bash runner/test/e2e-per-path-stack-routing.test.sh
# =====================================================================
set -uo pipefail
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

WORK="$(mktemp -d "${TMPDIR:-/tmp}/per-path.XXXXXX")"; WORK="$(cd "$WORK" && pwd -P)"
[ "${KEEP:-0}" = 1 ] || trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/data" "$WORK/bin" "$WORK/calls"
CALLS="$WORK/calls"

# ── the mixed repo ──────────────────────────────────────────────────────────────
R="$WORK/shop"; mkdir -p "$R/api/Shop.Api/Controllers" "$R/web/src"
( cd "$R" && git init -q -b main
  printf 'Microsoft Visual Studio Solution File, Format Version 12.00\n' > Shop.sln
  printf '<Project Sdk="Microsoft.NET.Sdk.Web" />\n' > api/Shop.Api/Shop.Api.csproj
  printf 'public class TasksController { }\n' > api/Shop.Api/Controllers/TasksController.cs
  printf '{ "name": "shop-web", "private": true, "dependencies": { "react": "18.2.0" }, "scripts": { "build": "vite build" } }\n' > web/package.json
  printf 'export function App() { return null; }\n' > web/src/App.tsx
  printf '{ "name": "shop", "private": true, "scripts": { "test": "node -e 0", "lint": "node -e 0" } }\n' > package.json
  git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init )

# ── recording stub `claude`: delivery writes a .cs or a .tsx helper by ticket title ──
cat > "$WORK/bin/claude" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
CALLS="__CALLS__"
prompt=""; prev=""
for a in "$@"; do [ "$prev" = "-p" ] && prompt="$a"; prev="$a"; done
n="$(ls -1 "$CALLS" 2>/dev/null | wc -l | tr -d ' ')"; n=$((n + 1))
D="$CALLS/$(printf '%03d' "$n")"; mkdir -p "$D"
printf '%s' "$prompt" > "$D/prompt"; pwd -P > "$D/cwd"
if [ -e .claude/skills ]; then ls -1 .claude/skills/ 2>/dev/null | sort > "$D/skills"; else : > "$D/skills"; fi
case "$prompt" in
  *"SECURITY REVIEWER"*) echo security > "$D/kind"
    printf '{"type":"result","subtype":"success","is_error":false,"result":"RECOMMEND APPROVE\\n{\\"verdict\\":\\"APPROVE\\"}","total_cost_usd":0.01,"num_turns":2}\n'; exit 0 ;;
  *"REVIEWER agent"*) echo review > "$D/kind"
    printf '{"type":"result","subtype":"success","is_error":false,"result":"RECOMMEND APPROVE\\n{\\"verdict\\":\\"APPROVE\\"}","total_cost_usd":0.01,"num_turns":2}\n'; exit 0 ;;
esac
if [ -e .git ]; then
  echo delivery > "$D/kind"
  fn="Helper${GAFFER_TICKET:-0}"
  # The delivery prompt carries the ticket by reference (the agent pulls it over MCP), so
  # the stub decides where to write by ticket NUMBER: #1 → .NET, #2 → React, else docs.
  case "${GAFFER_TICKET:-0}" in
    1) printf 'public class %s { }\n' "$fn" > "api/Shop.Api/Controllers/$fn.cs" ;;
    2) printf 'export const %s = () => null;\n' "$fn" > "web/src/$fn.tsx" ;;
    *) printf '# %s\n' "$fn" > "NOTES-$fn.md" ;;
  esac
  git -c user.email=s@s -c user.name=s add -A >/dev/null; git -c user.email=s@s -c user.name=s commit -qm "feat: $fn" >/dev/null 2>&1 || true
  printf '{"type":"result","subtype":"success","is_error":false,"result":"done.","total_cost_usd":0.02,"num_turns":3}\n'; exit 0
fi
echo other > "$D/kind"; printf '{"type":"result","subtype":"success","is_error":false,"result":"ok"}\n'
STUB
sed -i.bak "s|__CALLS__|$CALLS|" "$WORK/bin/claude" && rm -f "$WORK/bin/claude.bak"; chmod +x "$WORK/bin/claude"

export GAFFER_DATA="$WORK/data" CLAUDE_BIN="$WORK/bin/claude" CLAUDE_FLAGS="" \
       GAFFER_TICK_TIMEOUT=60 GAFFER_MAX_TURNS=10 GAFFER_CARD_MODEL=stub GAFFER_PLAN_MODEL=stub GAFFER_IMPL_MODEL=stub \
       REVIEW_MODE=human DRY_RUN=0 GAFFER_MAINTENANCE=0 AUTO_MERGE=0 GAFFER_STRICT_REQUIRE=0 GAFFER_SECURITY_REVIEW=0 GAFFER_TESTING=0
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
wg init >/dev/null 2>&1; lg init >/dev/null 2>&1
# The label the onboarding scanner would compose for this layout (root .sln first, then web/).
wg repo add -n shop --path "$R" --branch main --stack csharp-typescript-react --test "npm test" --lint "npm run lint" >/dev/null 2>&1

run_tick() { ( cd "$RUNNER_DIR" && bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep '^TICK_RESULT=' ; }
review_tick() { rm -f "$GAFFER_DATA/.reviewed-tickets"; ( cd "$RUNNER_DIR" && REVIEW_MODE=agent DISPATCH_ALLOW_AGENT_APPROVE=1 bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep '^TICK_RESULT='; }
st() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.status'; }
new_ready_ticket() { # $1 title, $2 description
  local n
  n="$(wg ticket create -t "$1" -d "$2" --risk medium 2>/dev/null | jget 'd.ticket.number')"
  wg ac add "$n" -t "the change is covered by a test" >/dev/null 2>&1
  wg ticket repo-access set "$n" shop --access write --relation confirmed >/dev/null 2>&1
  wg ticket ready "$n" >/dev/null 2>&1
  printf '%s' "$n"
}
last_call() { grep -lx "$1" "$CALLS"/*/kind 2>/dev/null | tail -1 | xargs -I{} dirname {}; }
has_skill() { grep -qx -- "$2" "$1/skills"; }
assert_skills() { # label calldir present-csv absent-csv
  local label="$1" d="$2" present="$3" absent="$4" s miss=() leak=()
  for s in ${present//,/ }; do has_skill "$d" "$s" || miss+=("$s"); done
  for s in ${absent//,/ }; do has_skill "$d" "$s" && leak+=("$s"); done
  [ "${#miss[@]}" -eq 0 ] && ok "$label: mounts ${present}" || fail "$label: missing: ${miss[*]}"
  [ "${#leak[@]}" -eq 0 ] && ok "$label: withholds ${absent}" || fail "$label: leaked: ${leak[*]}"
}

echo "== A. a ticket naming a .cs file: C# pack only, for the builder AND the reviewer =="
A="$(new_ready_ticket "Add cursor pagination to TasksController" "Extend api/Shop.Api/Controllers/TasksController.cs so GET /tasks returns a page with a cursor.")"
run_tick >/dev/null; [ "$(st "$A")" = "in_review" ] && ok "A: #$A delivered → in_review" || fail "A: status=$(st "$A")"
DA="$(last_call delivery)"
[ -n "$DA" ] && assert_skills "A: delivery" "$DA" "csharp-conventions,run-tests,minimalism" "typescript-conventions,react-patterns,frontend-design,design-system,python-conventions"
review_tick >/dev/null
RA="$(last_call review)"
[ -n "$RA" ] && assert_skills "A: reviewer (diff touches only .cs)" "$RA" "csharp-conventions,review-ticket,security-review" "typescript-conventions,react-patterns,accessibility-review,frontend-design" || fail "A: no reviewer spawn"

echo "== B. a ticket naming a .tsx file: TypeScript + React packs, no C# pack =="
B="$(new_ready_ticket "Fix the empty state in the task list" "web/src/App.tsx renders nothing when the list is empty; show an empty-state message.")"
run_tick >/dev/null; [ "$(st "$B")" = "in_review" ] && ok "B: #$B delivered → in_review" || fail "B: status=$(st "$B")"
DB="$(last_call delivery)"
[ -n "$DB" ] && [ "$DB" != "$DA" ] && assert_skills "B: delivery" "$DB" "typescript-conventions,react-patterns,frontend-design,run-tests" "csharp-conventions,python-conventions,mobile-ui" || fail "B: no new delivery spawn"
review_tick >/dev/null
RB="$(last_call review)"
[ -n "$RB" ] && [ "$RB" != "$RA" ] && assert_skills "B: reviewer (diff touches only .tsx)" "$RB" "typescript-conventions,review-ticket,accessibility-review" "csharp-conventions" || fail "B: no new reviewer spawn"

echo "== C. a ticket naming no file: the repo's full compound stack, both packs =="
C="$(new_ready_ticket "Write the release notes for 1.2" "Summarise what shipped since 1.1 for the changelog.")"
run_tick >/dev/null; [ "$(st "$C")" = "in_review" ] && ok "C: #$C delivered → in_review" || fail "C: status=$(st "$C")"
DC="$(last_call delivery)"
[ -n "$DC" ] && [ "$DC" != "$DB" ] && assert_skills "C: delivery (no path named)" "$DC" "csharp-conventions,typescript-conventions,react-patterns" "python-conventions,go-conventions,mobile-ui" || fail "C: no new delivery spawn"

echo
echo "spawns: $(cat "$CALLS"/*/kind | sort | uniq -c | awk '{printf "%s=%s ", $2, $1}')"
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
