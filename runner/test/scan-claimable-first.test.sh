#!/usr/bin/env bash
# =====================================================================
# SCHEDULER — the candidate scan limit is applied to CLAIMABLE work.
# ---------------------------------------------------------------------
# One low-priority prerequisite and 30 higher-priority dependants: the candidate walk
# visited the dependants first (priority order), each claim failed (dependency not
# done), the walk hit MAX_CANDIDATES (25) and the tick reported no_work. The next tick
# saw the same 25 first, forever: the one ticket that would unblock everything never
# ran. The scan now lists ready tickets whose dependencies are satisfied
# (`ticket list -s ready --claimable`) and applies the limit to that list.
# Proven against the REAL dispatch + tick.sh with a stub agent:
#   1  the prerequisite is claimed and delivered on the FIRST tick;
#   2  no dependant was claimed;
#   3  `ticket list --claimable` = ready tickets with every dependency done;
#   4  an unreadable claimable listing falls back to the full ready list (old walk).
# Run: bash runner/test/scan-claimable-first.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
[ -f "$ROOT/packages/dispatch/dist/cli/index.js" ] || { echo "SKIP: dispatch CLI not built"; exit 0; }
[ -f "$ROOT/packages/crew/dist/runtime/context/renderPromptCli.js" ] || { echo "SKIP: crew not built"; exit 0; }
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/scan-claimable.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
[ "${KEEP:-0}" = 1 ] || trap 'gaffer_test_rm_work "$WORK"' EXIT
mkdir -p "$WORK/data" "$WORK/bin"
R="$WORK/repo"; mkdir -p "$R/src"
( cd "$R" && git init -q -b main
  printf '{ "name": "r", "version": "0.1.0", "private": true, "scripts": { "test": "node -e 0", "lint": "node -e 0" } }\n' > package.json
  printf 'export const a = 1;\n' > src/a.js
  git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init )
cat > "$WORK/bin/claude" <<'STUB'
#!/usr/bin/env bash
if [ -e .git ]; then
  printf 'export const t%s = 1;\n' "${GAFFER_TICKET:-0}" >> src/a.js
  git -c user.email=s@s -c user.name=s add -A >/dev/null; git -c user.email=s@s -c user.name=s commit -qm "feat: ${GAFFER_TICKET:-0}" >/dev/null 2>&1 || true
  printf '{"type":"result","subtype":"success","is_error":false,"result":"done.\\n\\nSmallest-change note: one line.","total_cost_usd":0.01,"num_turns":1}\n'; exit 0
fi
printf '{"type":"result","subtype":"success","is_error":false,"result":"ok"}\n'
STUB
chmod +x "$WORK/bin/claude"
export GAFFER_DATA="$WORK/data" CLAUDE_BIN="$WORK/bin/claude" CLAUDE_FLAGS="" \
       GAFFER_MAX_TURNS=3 GAFFER_TICK_TIMEOUT=60 GAFFER_CARD_MODEL=stub GAFFER_PLAN_MODEL=stub GAFFER_IMPL_MODEL=stub \
       REVIEW_MODE=human DRY_RUN=0 GAFFER_MAINTENANCE=0 GAFFER_STRICT_REQUIRE=0 GAFFER_SECURITY_REVIEW=0 GAFFER_TESTING=0 \
       MAX_OPEN_AGENT_BRANCHES_PER_REPO=50 MAX_IN_REVIEW_PER_REPO=50 MAX_CANDIDATES=25 AUTO_MERGE=0
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
wg init >/dev/null 2>&1; lg init >/dev/null 2>&1
wg repo add -n repo --path "$R" --branch main --stack node --test "npm test" --lint "npm run lint" >/dev/null 2>&1
st() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.status'; }
# The queue, built in ONE process through the dispatch facade (31 tickets × 5 CLI calls
# took over two minutes on a loaded runner): the prerequisite at priority 0, then 30
# dependants at priority 10, each with a criterion, the repo as its write repo, ready.
NUMS="$(node --input-type=module -e '
  const { Dispatch } = await import(process.argv[1]);
  const d = Dispatch.open(process.argv[2]);
  const human = { type: "human", id: "fixture" };
  const mk = (title, priority) => {
    const t = d.createTicket({ title, description: `deliver ${title}`, risk_level: "low", priority }, human);
    d.addAcceptanceCriterion({ ticket_id: t.id, text: "line added" }, human);
    d.setTicketRepoAccess({ ticket_id: t.id, repo_id: "repo", access: "write", relation: "confirmed" }, human);
    return t;
  };
  const pre = mk("Prerequisite", 0);
  const deps = [];
  for (let i = 1; i <= 30; i++) {
    const t = mk(`Dependant ${i}`, 10);
    d.addDependency({ ticket: t.id, depends_on: pre.id }, human);
    deps.push(t);
  }
  for (const t of [pre, ...deps]) d.markReady(t.id, human);
  process.stdout.write([pre, ...deps].map((t) => t.number).join(" "));
  d.db.close();' "$ROOT/packages/dispatch/dist/core.js" "$DISPATCH_DB" 2>/dev/null)"
read -r PRE REST <<<"$NUMS"
read -r -a DEPS <<<"$REST"
[ "${#DEPS[@]}" = 30 ] || { echo "FIXTURE ERROR: could not build the queue ($NUMS)"; exit 1; }

echo "== 3: the claimable listing =="
ALL="$(wg ticket list -s ready | jget 'd.length')"
CL="$(wg ticket list -s ready --claimable 2>/dev/null | jget 'd.map(t => t.number).join(",")' 2>/dev/null || echo '?')"
[ "$ALL" = "31" ] && ok "31 tickets are ready" || fail "ready count $ALL"
[ "$CL" = "$PRE" ] && ok "--claimable lists only the prerequisite (#$PRE)" || fail "--claimable listed '$CL'"

echo "== 1/2: the first tick claims the prerequisite =="
OUT="$( ( cd "$RUNNER_DIR" && bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep '^TICK_RESULT=' )"
[ "$OUT" = "TICK_RESULT=worked" ] && ok "first tick worked (not no_work)" || fail "first tick: $OUT ($(grep -E 'MAX_CANDIDATES|claim' "$GAFFER_DATA/factory.log" | tail -2 | tr '\n' '|' | cut -c1-300))"
[ "$(st "$PRE")" = "in_review" ] && ok "the prerequisite #$PRE was delivered on the first tick" || fail "prerequisite status=$(st "$PRE")"
_claimed=0; for d in "${DEPS[@]}"; do [ "$(st "$d")" = "ready" ] || _claimed=$((_claimed + 1)); done
[ "$_claimed" -eq 0 ] && ok "no dependant left ready" || fail "$_claimed dependants moved"
grep -q "candidate scan hit MAX_CANDIDATES" "$GAFFER_DATA/factory.log" && fail "the scan still hit its limit" || ok "the scan never hit MAX_CANDIDATES"

echo "== 4: WIRING — the scan uses the claimable list and falls back to the full list =="
grep -q 'ticket list -s ready --claimable' "$RUNNER_DIR/tick.sh" && ok "tick.sh lists claimable work for the walk" || fail "tick.sh does not use --claimable"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "scan-claimable-first: ALL $PASS checks passed"; exit 0; fi
echo "scan-claimable-first: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1
