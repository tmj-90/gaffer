#!/usr/bin/env bash
# =====================================================================
# RELEASE GATE 3 — "CI required" controls approval and landing.
# ---------------------------------------------------------------------
# Operator promise: with CI required, nothing advances to merge without a passing CI
# result for the commit that would land, and a red result stops it.
# The counterexample (external review 2): CI required, the poll held open, a CLI approve
# went through; the failing result released later was logged "CI RED" but the ticket
# stayed ready_for_merge (the rejection path acts only on in_review). And the real gh
# refused the gate's query (Unknown JSON field "status").
#
# Real dispatch + tick.sh (the H3 CI gate, PR mode) + the merge lane, a stub claude, and
# a stub gh that enforces the REAL CLI's JSON fields (fixtures/gh, recorded from gh
# 2.89.0) and serves checks from a state file:
#   1  CI PENDING with the poll held open: a human CLI approve is REFUSED (the ticket stays
#      in_review); the red result then sends it back to rework — never ready_for_merge;
#   2  CI GREEN for the candidate: approval goes through; a LATE red (a re-run) is caught
#      by the merge lane before landing: the ticket is HELD (blocked, ci_red) in the human
#      queue, main untouched;
#   3  every gh call used the real field names.
# Run: bash runner/test/e2e-release-gate-ci-required.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
FX="$HERE/fixtures/gh"
[ -f "$ROOT/packages/dispatch/dist/cli/index.js" ] || { echo "SKIP: dispatch CLI not built"; exit 0; }
[ -f "$ROOT/packages/crew/dist/runtime/context/renderPromptCli.js" ] || { echo "SKIP: crew not built"; exit 0; }
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
# Portable bound (macOS has no GNU timeout).
bounded() { perl -e 'alarm shift; exec @ARGV' "$@"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/rg-ci-required.XXXXXX")"; WORK="$(cd "$WORK" && pwd -P)"
TICK_PID=""
cleanup() { [ -n "$TICK_PID" ] && kill "$TICK_PID" 2>/dev/null; [ "${KEEP:-0}" = 1 ] || rm -rf "$WORK"; }
trap cleanup EXIT
mkdir -p "$WORK/data" "$WORK/bin"
R="$WORK/repo"; mkdir -p "$R/src" "$R/test"
git init -q --bare "$WORK/remote.git"
( cd "$R" && git init -q -b main
  printf '{ "name": "r", "version": "0.1.0", "private": true, "type": "module", "scripts": { "test": "node --test", "lint": "node -e 0" } }\n' > package.json
  printf 'export const a = 1;\n' > src/a.js
  printf 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { a } from "../src/a.js";\ntest("a", () => assert.equal(a, 1));\n' > test/a.test.js
  git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init
  git remote add origin "$WORK/remote.git" && git push -q origin main >/dev/null 2>&1
  # A github.com remote so the CI gate applies (the PR lives on GitHub); pushes go to origin.
  git remote add upstream https://github.com/acme/r.git )

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

# Stub gh: the real CLI's field rules; `pr checks` answers from $WORK/ci-state
# (pending | fail | pass); `pr view` answers the branch head; `pr create` prints a URL.
GH_LOG="$WORK/gh.log"; : > "$GH_LOG"; echo pending > "$WORK/ci-state"
cat > "$WORK/bin/gh" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$GH_LOG"
sub="\$1 \$2"; fields=""; prev=""
for a in "\$@"; do [ "\$prev" = "--json" ] && fields="\$a"; prev="\$a"; done
case "\$sub" in
  "pr create") echo "https://github.com/acme/r/pull/\$RANDOM"; exit 0 ;;
  "pr checks") list="$FX/pr-checks-fields.txt" ;;
  "pr view")   list="$FX/pr-view-fields.txt" ;;
  *) exit 1 ;;
esac
IFS=, read -r -a want <<< "\$fields"
for f in "\${want[@]}"; do grep -qx -- "\$f" "\$list" || { printf 'Unknown JSON field: "%s"\n' "\$f" >&2; exit 1; }; done
if [ "\$sub" = "pr view" ]; then printf '{"headRefOid":"%s"}\n' "\$(git rev-parse "refs/heads/\$3" 2>/dev/null)"; exit 0; fi
cat "$FX/pr-checks-\$(cat "$WORK/ci-state").json"
STUB
chmod +x "$WORK/bin/gh"

export GAFFER_DATA="$WORK/data" CLAUDE_BIN="$WORK/bin/claude" CLAUDE_FLAGS="" GAFFER_GH_BIN="$WORK/bin/gh" \
       GAFFER_MAX_TURNS=3 GAFFER_TICK_TIMEOUT=60 GAFFER_CARD_MODEL=stub GAFFER_PLAN_MODEL=stub GAFFER_IMPL_MODEL=stub \
       REVIEW_MODE=human DRY_RUN=0 GAFFER_MAINTENANCE=0 GAFFER_STRICT_REQUIRE=0 GAFFER_SECURITY_REVIEW=0 GAFFER_TESTING=0 \
       MAX_OPEN_AGENT_BRANCHES_PER_REPO=10 MAX_IN_REVIEW_PER_REPO=10 GAFFER_DIGEST_DISABLE=1 \
       GAFFER_CREATE_PR=1 GAFFER_REQUIRE_CI=1 GAFFER_PR_REMOTE=origin GAFFER_CI_POLL_INTERVAL_SECS=1
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
wg init >/dev/null 2>&1; lg init >/dev/null 2>&1
wg repo add -n repo --path "$R" --branch main --stack node --test "npm test" --lint "npm run lint" >/dev/null 2>&1
run_tick() { ( cd "$RUNNER_DIR" && bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep '^TICK_RESULT=' ; }
st() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.status'; }
# The approval names the commits the reviewer saw (the CLI requires --commit <repo>=<sha>).
approve_heads() { wg ticket diff "$1" --heads 2>/dev/null | sed 's/^/--commit /' | tr '\n' ' '; }
new_ticket() { local n; n="$(wg ticket create -t "$1" -d "deliver $1" --risk low 2>/dev/null | jget 'd.ticket.number')"; wg ac add "$n" -t "line added" >/dev/null 2>&1; wg ticket repo-access set "$n" repo --access write --relation confirmed >/dev/null 2>&1; wg ticket ready "$n" >/dev/null 2>&1; printf '%s' "$n"; }
wait_for() { local i; for i in $(seq 1 120); do eval "$1" && return 0; perl -e 'select(undef,undef,undef,0.5)'; done; return 1; }

echo "== 1: CI pending, poll held open → a CLI approve is refused; the red result sends it back =="
A="$(new_ticket "Pending CI")"
( cd "$RUNNER_DIR" && GAFFER_CI_POLL_ATTEMPTS=60 bounded 200 bash ./tick.sh >"$WORK/tick-a.out" 2>>"$GAFFER_DATA/tick.stderr.log" ) &
TICK_PID=$!
if wait_for '[ "$(st "$A")" = "in_review" ] && [ "$(wg ticket ci-status "$A" 2>/dev/null | jget "d.state")" = "pending" ]'; then
  ok "#$A delivered, PR opened, CI recorded PENDING for the candidate (poll open)"
else fail "#$A never reached in_review with CI pending (status=$(st "$A"), ci=$(wg ticket ci-status "$A" 2>/dev/null | tr -d '\n' | cut -c1-200))"; fi
# shellcheck disable=SC2046  # one --commit <repo>=<sha> word pair per head
if wg review approve "$A" $(approve_heads "$A") --reviewer human1 >"$WORK/approve.out" 2>&1; then fail "a CLI approve went through while CI was pending: $(head -c 300 "$WORK/approve.out")"
else grep -q "Required CI has not passed" "$WORK/approve.out" && ok "the CLI approve is refused: required CI has not passed for the candidate" || fail "refused for another reason: $(head -c 300 "$WORK/approve.out")"; fi
[ "$(st "$A")" = "in_review" ] && ok "#$A stays in_review (not ready_for_merge)" || fail "#$A status=$(st "$A") after the refused approve"
echo fail > "$WORK/ci-state"
wait "$TICK_PID"; TICK_PID=""
[ "$(st "$A")" = "refining" ] && ok "the red result sent #$A back to rework (in_review → refining), never ready_for_merge" || fail "#$A after the red result: $(st "$A")"
[ "$(wg ticket ci-status "$A" | jget 'd.state')" = "fail" ] && ok "CI FAIL recorded for the candidate" || fail "ci-status: $(wg ticket ci-status "$A" | tr -d '\n')"

echo "== 2: CI green → approve; a LATE red is caught before landing → held for a human =="
echo pass > "$WORK/ci-state"
B="$(new_ticket "Green then red")"
GAFFER_CI_POLL_ATTEMPTS=3 run_tick >/dev/null
[ "$(st "$B")" = "in_review" ] && [ "$(wg ticket ci-status "$B" | jget 'd.state')" = "pass" ] && ok "#$B delivered with CI PASS recorded for its candidate" || fail "#$B status=$(st "$B") ci=$(wg ticket ci-status "$B" | tr -d '\n' | cut -c1-200)"
# shellcheck disable=SC2046  # one --commit <repo>=<sha> word pair per head
wg review approve "$B" $(approve_heads "$B") --reviewer human1 >/dev/null 2>&1
[ "$(st "$B")" = "ready_for_merge" ] && ok "with CI green, the human approve goes through (ready_for_merge)" || fail "#$B after approve: $(st "$B")"
echo fail > "$WORK/ci-state"
MAIN0="$(git -C "$R" rev-parse main)"
GAFFER_MODE=autonomous AUTO_MERGE=1 GAFFER_CI_POLL_ATTEMPTS=3 run_tick >/dev/null
[ "$(st "$B")" = "blocked" ] && ok "the late red HOLDS the approved #$B (ready_for_merge → blocked)" || fail "#$B after the late red: $(st "$B") — $(grep "#$B" "$GAFFER_DATA/factory.log" | tail -2 | tr '\n' '|' | cut -c1-300)"
[ "$(git -C "$R" rev-parse main)" = "$MAIN0" ] && ok "main untouched" || fail "main moved: the red candidate landed"
HQ="$(node --input-type=module -e '
  const { Dispatch } = await import(process.argv[1]);
  const d = Dispatch.open(process.argv[2]);
  const i = d.humanQueue().items.find((x) => x.ticket && x.ticket.number === Number(process.argv[3]));
  process.stdout.write(i ? `${i.kind}|${i.reasonCode}|${i.reason}` : "none");' "$ROOT/packages/dispatch/dist/core.js" "$DISPATCH_DB" "$B" 2>/dev/null || echo none)"
case "$HQ" in "parked|ci_red|Required CI failed"*) ok "#$B waits in the human queue: parked, ci_red, with the failing check" ;; *) fail "human queue item: $HQ" ;; esac

echo "== 3: the gh contract =="
BAD="$(grep -- '--json' "$GH_LOG" | grep -v -- '--json name,state,bucket,link$' | grep -v -- '--json headRefOid$' || true)"
[ -z "$BAD" ] && [ -n "$(grep -- 'pr checks' "$GH_LOG" || true)" ] && ok "every gh query used the real JSON fields" || fail "gh queries outside the real field list: ${BAD:0:300}"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "e2e-release-gate-ci-required: ALL $PASS checks passed"; exit 0; fi
echo "e2e-release-gate-ci-required: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1
