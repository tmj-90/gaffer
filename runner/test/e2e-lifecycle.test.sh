#!/usr/bin/env bash
# =====================================================================
# E2E TICKET LIFECYCLE — the full state machine + runner-owned bookkeeping.
# ---------------------------------------------------------------------
# ONE deterministic, hermetic end-to-end run that drives a ticket through its
# WHOLE lifecycle against the REAL dispatch state machine and the REAL runner
# bookkeeping/gate code — with a STUB agent (no tokens spent), a temp dispatch DB,
# and a temp on-disk git repo. It is the integration-level regression the unit +
# behavioral tests don't cover: it proves the verbs compose correctly.
#
# Flow (each step a REAL dispatch CLI verb or a REAL runner gate function):
#   create → ready → runner claim (token) → stub-agent delivery (worktree, trivial
#   change, commit, AC evidence via the injected token) → DoD gate (runner/lib/dod.sh)
#   → delivery hygiene (runner/lib/hygiene.sh) → submit (token) → human review
#   approve (real-diff done-gate) → mark-merged.
#
# It asserts, along the way:
#   • GUARDED TRANSITIONS reject illegitimate moves:
#       G1  a second claim on an already-claimed ticket is refused (no double-claim);
#       G2  `review approve` BEFORE a real git diff exists is DENIED by the done-gate
#           (PR_OR_DIFF_REQUIRED — prose/PR links never satisfy it);
#       G3  an AGENT self-approve without DISPATCH_ALLOW_AGENT_APPROVE is refused;
#       G4  `mark-merged` from in_review (skipping approval) is a STATE_CONFLICT.
#   • CLAIM / SUBMIT / RELEASE bookkeeping:
#       claim moves ready→claimed with exactly one active claim; submit completes it
#       (claimed→in_review, zero active claims); a separate rework-exhausted delivery
#       is RELEASED to the VISIBLE `blocked` column with its claim gone.
#   • THE DONE-GATE behaves: it DENIES an empty-diff delivery and PASSES a real one.
#   • THE GATES run for real: the DoD gate passes on a green repo, hygiene passes on
#     a clean delivery diff.
#   • The ticket lands `done` with no active claim.
#
# Requires the dispatch CLI to be built + git. SKIPs (exit 0) otherwise.
# Run: bash test/e2e-lifecycle.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
CLI_JS="$ROOT/packages/dispatch/dist/cli/index.js"

command -v node    >/dev/null 2>&1 || { echo "SKIP: node required";    exit 0; }
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 required"; exit 0; }
command -v git     >/dev/null 2>&1 || { echo "SKIP: git required";     exit 0; }
[ -f "$CLI_JS" ] || { echo "SKIP: dispatch CLI not built ($CLI_JS) — run pnpm -C packages/dispatch build"; exit 0; }

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/e2e-lifecycle.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
DB="$WORK/dispatch.sqlite"
REPO="$WORK/repo"
export GAFFER_DATA="$WORK"

wg()   { node "$CLI_JS" --db "$DB" "$@"; }
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }
status_of() { wg ticket show "$1" 2>/dev/null | jget "d['ticket']['status']" 2>/dev/null || echo ''; }
ac_status_of() { wg ticket show "$1" 2>/dev/null | jget "d['acceptanceCriteria'][0]['status']" 2>/dev/null || echo ''; }
active_claims() {
  python3 - "$DB" "$1" <<'PY'
import sqlite3,sys
db,num=sys.argv[1],int(sys.argv[2]); c=sqlite3.connect(db)
print(c.execute("SELECT count(*) FROM ticket_claims tc JOIN tickets t ON t.id=tc.ticket_id "
                "WHERE t.number=? AND tc.status='active'",(num,)).fetchone()[0])
PY
}

# The single gate primitive dod.sh needs when sourced standalone (the real one lives
# in factory.config.sh). It must relay the command's exit status faithfully so the
# gate verdict is REAL. Same shim the dod-gate unit test uses.
gaffer_timeout() { shift; "$@"; return $?; }
export HYGIENE_FORBIDDEN_PATHS="node_modules .crew/ *.events.jsonl"
# shellcheck source=../lib/dod.sh
source "$RUNNER_DIR/lib/dod.sh"
# shellcheck source=../lib/hygiene.sh
source "$RUNNER_DIR/lib/hygiene.sh"

# ── A real on-disk git repo, main branch + a test command that PASSES ────────
git init -q -b main "$REPO"
git -C "$REPO" config user.email gaffer@test
git -C "$REPO" config user.name gaffer-test
mkdir -p "$REPO/src"
printf 'export const x = 1;\n' > "$REPO/src/x.ts"
printf '# demo\n' > "$REPO/README.md"
git -C "$REPO" add -A
git -C "$REPO" commit -qm "init"

# ── The STUB agent (no tokens spent) ─────────────────────────────────────────
# A real executable that stands in for `claude -p`: it makes a TRIVIAL, hygienic
# change in the delivery worktree, commits it on the gaffer/ branch, and records AC
# evidence via the dispatch CLI using the claim token injected in its env (exactly
# how the live dispatch MCP server reads GAFFER_CLAIM_TOKEN — the agent never sees
# the token string). Emits a `claude`-style JSON envelope. Spends nothing.
STUB="$WORK/stub-claude.sh"
cat > "$STUB" <<'STUBSH'
#!/usr/bin/env bash
set -uo pipefail
# env contract: WT (worktree), BRANCH, AC_ID, TICKET, CLI_JS, DB, GAFFER_CLAIM_TOKEN
printf '// delivered by stub agent for %s\n' "$TICKET" >> "$WT/src/x.ts"
git -C "$WT" add -A
git -C "$WT" commit -qm "stub: deliver $TICKET"
node "$CLI_JS" --db "$DB" evidence "$TICKET" --token "$GAFFER_CLAIM_TOKEN" \
  --type test_output --summary "stub agent: tests pass for $TICKET" --ac "$AC_ID" >/dev/null 2>&1
printf '{"type":"result","subtype":"success","is_error":false,"result":"delivered %s"}\n' "$TICKET"
STUBSH
chmod +x "$STUB"

echo "== SETUP: repo + ticket + acceptance criterion =="
wg init >/dev/null 2>&1
wg repo add -n demo --path "$REPO" --branch main --test "true" >/dev/null 2>&1
NUM="$(wg ticket create -t "Add a delivered line" --description "the factory delivers a trivial change" --policy team_light --risk low 2>/dev/null | jget "d['ticket']['number']")"
ACID="$(wg ac add "$NUM" -t "the line is added" 2>/dev/null | jget "d['ac_id']")"
wg ticket repo-access set "$NUM" demo --access write --relation confirmed >/dev/null 2>&1
[ -n "$NUM" ] && [ -n "$ACID" ] && ok "created ticket #$NUM with an acceptance criterion" || { fail "setup: could not create ticket/AC"; }

echo "== READY: the ready gate passes (title + description + AC + write repo) =="
wg ticket ready "$NUM" >/dev/null 2>&1
[ "$(status_of "$NUM")" = "ready" ] && ok "#$NUM is ready" || fail "#$NUM did not reach ready (got '$(status_of "$NUM")')"

echo "== CLAIM: the RUNNER claims at selection and holds the token =="
AGENT="$(wg agent register -n gaffer-factory --max-risk high 2>/dev/null | jget "d['agent']['id']")"
CLAIM_TOKEN="$(wg claim-ticket "$NUM" --agent "$AGENT" --ttl 900 2>/dev/null | jget "d['claimToken']")"
[ -n "$CLAIM_TOKEN" ] && ok "runner captured a claim token" || fail "no claim token captured"
[ "$(status_of "$NUM")" = "claimed" ] && ok "#$NUM moved ready → claimed (in-flight before the agent)" || fail "#$NUM not claimed"
[ "$(active_claims "$NUM")" = "1" ] && ok "exactly one active claim on #$NUM" || fail "expected one active claim on #$NUM"

echo "== G1 (guard): a second claim on a claimed ticket is REFUSED (no double-claim) =="
if wg claim-ticket "$NUM" --agent "$AGENT" --ttl 900 >/dev/null 2>&1 && \
   [ -n "$(wg claim-ticket "$NUM" --agent "$AGENT" --ttl 900 2>/dev/null | jget "d.get('claimToken','')" 2>/dev/null)" ]; then
  fail "G1: a second claim on an already-claimed ticket wrongly succeeded"
else
  ok "G1: a second claim on #$NUM is refused (the claim is the lock)"
fi
[ "$(active_claims "$NUM")" = "1" ] && ok "G1: still exactly one active claim after the refused re-claim" || fail "G1: claim count changed after a refused re-claim"

echo "== DELIVER: runner sets up the worktree/branch; the STUB agent delivers =="
BRANCH="gaffer/t$NUM"
WT="$WORK/wt-$NUM"
git -C "$REPO" worktree add -q -b "$BRANCH" "$WT" main
# Run the stub agent in the worktree with the token injected in its env (as the MCP
# server does). No real model, no spend.
( export WT BRANCH TICKET="$NUM" AC_ID="$ACID" CLI_JS DB GAFFER_CLAIM_TOKEN="$CLAIM_TOKEN"
  "$STUB" -p "deliver #$NUM" >/dev/null 2>&1 )
# The stub committed a real change on the gaffer/ branch → a non-empty diff vs main.
DIFF_LINES="$(git -C "$WT" diff --numstat main...HEAD | wc -l | tr -d ' ')"
[ "$DIFF_LINES" -ge 1 ] && ok "stub agent committed a real change on $BRANCH (non-empty diff vs main)" || fail "stub agent produced no diff"
[ "$(ac_status_of "$NUM")" = "satisfied" ] && ok "the AC is satisfied by the stub agent's token-scoped evidence" || fail "AC not satisfied after delivery (got '$(ac_status_of "$NUM")')"

echo "== GATES: the REAL DoD gate + delivery-hygiene run in the worktree =="
DOD_RES="$WORK/dod.results"
printf 'demo\t%s\t1\t0\t0\ttrue\t-\t-\n' "$WT" | gaffer_run_dod_gates "$DOD_RES"; DOD_RC=$?
{ [ "$DOD_RC" -eq 0 ] && grep -q 'GATE	tests	demo	PASS' "$DOD_RES"; } \
  && ok "DoD gate PASSED (tests gate ran 'true' → PASS)" \
  || fail "DoD gate did not pass (rc=$DOD_RC): $(cat "$DOD_RES")"
if gaffer_assert_clean_delivery "$WT" main >/dev/null 2>&1; then
  ok "delivery hygiene PASSED (clean, minimal diff — no forbidden paths)"
else
  fail "delivery hygiene wrongly flagged a clean delivery"
fi

echo "== record the per-repo delivery (branch the done-gate will diff) =="
wg ticket repo-delivery record "$NUM" demo --branch "$BRANCH" >/dev/null 2>&1
ok "recorded repo-delivery for demo on $BRANCH"

echo "== SUBMIT: the runner-owned token-gated submit completes the claim =="
wg submit "$NUM" --token "$CLAIM_TOKEN" --reason "gates passed" >/dev/null 2>&1
[ "$(status_of "$NUM")" = "in_review" ] && ok "#$NUM moved claimed → in_review (submitted for human review)" || fail "#$NUM not in_review after submit (got '$(status_of "$NUM")')"
[ "$(active_claims "$NUM")" = "0" ] && ok "submit COMPLETED the claim — zero active claims on #$NUM" || fail "claim not completed after submit (active=$(active_claims "$NUM"))"

echo "== G3 (guard): an AGENT self-approve without the opt-in is REFUSED =="
if wg review approve "$NUM" --as agent --reviewer bot >/dev/null 2>&1; then
  fail "G3: an agent self-approved without DISPATCH_ALLOW_AGENT_APPROVE"
else
  ok "G3: agent self-approve is refused (ACTOR_NOT_PERMITTED — a human must approve)"
fi

echo "== G4 (guard): mark-merged from in_review (skipping approval) is a CONFLICT =="
if wg ticket mark-merged "$NUM" --as system >/dev/null 2>&1; then
  fail "G4: mark-merged wrongly succeeded from in_review (skipped approval)"
else
  ok "G4: mark-merged from in_review is refused (must pass through approve first)"
fi

echo "== REVIEW APPROVE: the human approves; the real-diff done-gate passes =="
wg review approve "$NUM" --reviewer human1 >/dev/null 2>&1
[ "$(status_of "$NUM")" = "ready_for_merge" ] && ok "#$NUM moved in_review → ready_for_merge (done-gate satisfied by the REAL git diff)" || fail "#$NUM not ready_for_merge after approve (got '$(status_of "$NUM")')"

echo "== MARK-MERGED: the runner records the landed merge =="
wg ticket mark-merged "$NUM" --as system >/dev/null 2>&1
[ "$(status_of "$NUM")" = "done" ] && ok "#$NUM moved ready_for_merge → done (merge landed)" || fail "#$NUM not done after mark-merged (got '$(status_of "$NUM")')"
[ "$(active_claims "$NUM")" = "0" ] && ok "no active claim remains on the completed ticket" || fail "a claim lingers on the done ticket"

echo "== G2 (guard) + done-gate control: an EMPTY-diff delivery is DENIED at approve =="
# A second ticket whose delivery branch has NO change vs main → the done-gate must
# DENY approval (the real git diff is empty; prose/PR links can't satisfy it). Then
# a real change flips it to allowed — proving the gate reads git, not the agent.
NUM2="$(wg ticket create -t "empty then real" --description "controls the done-gate" --policy team_light --risk low | jget "d['ticket']['number']")"
AC2="$(wg ac add "$NUM2" -t "works" | jget "d['ac_id']")"
wg ticket repo-access set "$NUM2" demo --access write --relation confirmed >/dev/null 2>&1
wg ticket ready "$NUM2" >/dev/null 2>&1
TOK2="$(wg claim-ticket "$NUM2" --agent "$AGENT" --ttl 900 | jget "d['claimToken']")"
BR2="gaffer/t$NUM2"
git -C "$REPO" branch "$BR2" main          # branch off main with NO extra commit → empty diff
wg ticket repo-delivery record "$NUM2" demo --branch "$BR2" >/dev/null 2>&1
wg evidence "$NUM2" --token "$TOK2" --type test_output --summary ok --ac "$AC2" >/dev/null 2>&1
wg submit "$NUM2" --token "$TOK2" --reason "no real change" >/dev/null 2>&1
DENY_CODES="$(wg review approve "$NUM2" --reviewer human1 2>&1 | jget "[f['code'] for f in d['details']['policy']['failures']]" 2>/dev/null || echo '')"
case "$DENY_CODES" in
  *PR_OR_DIFF_REQUIRED*) ok "G2: approve on an EMPTY-diff delivery is DENIED (PR_OR_DIFF_REQUIRED)";;
  *) fail "G2: empty-diff approve was not denied with PR_OR_DIFF_REQUIRED (got: $DENY_CODES, status=$(status_of "$NUM2"))";;
esac
[ "$(status_of "$NUM2")" = "in_review" ] && ok "G2: the denied ticket stayed in_review (no illegitimate advance)" || fail "G2: ticket advanced despite the denied done-gate"
# Now give it a REAL change and re-approve → passes (the gate reads git, not prose).
git -C "$REPO" checkout -q "$BR2"; printf '// real\n' >> "$REPO/src/x.ts"; git -C "$REPO" add -A; git -C "$REPO" commit -qm real; git -C "$REPO" checkout -q main
wg review approve "$NUM2" --reviewer human1 >/dev/null 2>&1
[ "$(status_of "$NUM2")" = "ready_for_merge" ] && ok "G2 control: with a REAL diff the SAME ticket now approves (done-gate reads git)" || fail "G2 control: real-diff approve failed (got '$(status_of "$NUM2")')"

echo "== RELEASE bookkeeping: a rework-exhausted delivery parks to VISIBLE blocked =="
# The runner's park verb (gaffer_release_delivery → wg runner-release --to blocked)
# returns a rework-exhausted CLAIMED delivery to the visible `blocked` column and
# releases the claim — a human never wonders where the ticket went.
NUM3="$(wg ticket create -t "will exhaust rework" --description "d" --policy team_light --risk low | jget "d['ticket']['number']")"
wg ac add "$NUM3" -t "AC" >/dev/null 2>&1
wg ticket repo-access set "$NUM3" demo --access write --relation confirmed >/dev/null 2>&1
wg ticket ready "$NUM3" >/dev/null 2>&1
TOK3="$(wg claim-ticket "$NUM3" --agent "$AGENT" --ttl 900 | jget "d['claimToken']")"
[ "$(active_claims "$NUM3")" = "1" ] && ok "release-setup: #$NUM3 claimed (one active claim)" || fail "release-setup: #$NUM3 not claimed"
wg runner-release "$NUM3" --to blocked --token "$TOK3" --reason "rework exhausted" --reason-code rework_exhausted --attempt 3 --max 3 >/dev/null 2>&1
[ "$(status_of "$NUM3")" = "blocked" ] && ok "#$NUM3 parked to the VISIBLE blocked column (rework_exhausted)" || fail "#$NUM3 not blocked after runner-release (got '$(status_of "$NUM3")')"
[ "$(active_claims "$NUM3")" = "0" ] && ok "the runner-held claim on #$NUM3 was released (zero active claims)" || fail "claim still active on the parked #$NUM3"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "e2e-lifecycle: ALL $PASS checks passed"
  exit 0
fi
echo "e2e-lifecycle: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
