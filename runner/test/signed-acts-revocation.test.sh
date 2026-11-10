#!/usr/bin/env bash
# =====================================================================
# SIGNED GATE EVENTS: an approval that was UNDONE never lands again, whatever an attacker
# with write access to the dispatch database does (independent review of package H2).
#
# The old approval keeps a valid seal after it is revoked, so the first cut of signed
# approvals landed each of these: the status written back to ready_for_merge, with the later
# rows deleted (revocation by truncation) or not, or the whole file rolled back to a copy.
# Every landing now requires the approval to be the ticket's latest move, and the event log
# to still hold the head the host anchored outside the database (beside the factory key)
# after its last write. Real dispatch CLI, real git, bin/merge-ticket.mjs and lib/land.sh.
#   R1  reopen-for-review, then only the status written back: refused, held
#   R2  reopen-for-review, the later rows deleted, the status reset (gaffer merge): refused
#   R3  the same through the merge lane
#   R4  sent back (refining), won't-do, held by the runner: each truncated away, refused
#   R5  the whole database rolled back to a copy taken at approval: refused
#   R6  a host write after the truncation does not paper over it
#   R7  genuine: an approval lands; reopen + re-approve lands; a deliberate restore is
#       re-anchored by a person (gate-key reanchor), reopened, re-approved and lands
#   R8  a future-dated in_review entry planted before the approval: the approval still
#       seals the commit the person named, and the unreviewed branch head does not land
# Run: bash runner/test/run.sh -j 1 runner/test/signed-acts-revocation.test.sh   (bash 3.2 safe)
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
DISPATCH_JS="$ROOT/packages/dispatch/dist/cli/index.js"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }
node -e 'require("node:sqlite")' 2>/dev/null || { echo "SKIP: node:sqlite unavailable"; exit 0; }
[ -f "$DISPATCH_JS" ] || { echo "SKIP: build the workspace first (no $DISPATCH_JS)"; exit 0; }
WORK="$(gaffer_test_tmpdir signed-acts-revocation)" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
[ "${KEEP:-0}" = 1 ] || trap 'gaffer_test_rm_work "$WORK"' EXIT
mkdir -p "$WORK/bin"
printf '#!/bin/sh\nexit 1\n' > "$WORK/bin/claude"; chmod +x "$WORK/bin/claude"
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN XDG_CONFIG_HOME
export CLAUDE_BIN="$WORK/bin/claude" GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 \
  GAFFER_CREATE_PR=0 GAFFER_DIGEST_DISABLE=1 GAFFER_MEMORY_INDEX=0 GAFFER_CONFLICT_RESOLVER=0 \
  GAFFER_DOD_SANDBOX=0 DISPATCH_AUDIT_OFF=1 MEMORY_AUDIT_OFF=1 GAFFER_STRICT_REQUIRE=0 \
  GAFFER_DOD_TYPECHECK=0 GAFFER_DOD_LINT=0 GAFFER_TESTING=0

D=""; HEAD=""; MAIN0=""
wgd() { node "$DISPATCH_JS" --db "$D/data/dispatch.sqlite" "$@"; }
jf() { node "$RUNNER_DIR/lib/json-tool.mjs" expr "$1"; }
status() { wgd ticket show 1 | jf 'd.ticket.status'; }
main_head() { git -C "$D/repo" rev-parse main; }
sql() {  # <statement>...: what an attacker with the sqlite file runs
  node --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    const d = new DatabaseSync(process.argv[1]);
    for (const s of process.argv.slice(2)) d.exec(s);
    d.close();' "$D/data/dispatch.sqlite" "$@"
}
approval_seq() {
  node --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    const d = new DatabaseSync(process.argv[1], { readOnly: true });
    const r = d.prepare("SELECT max(rowid) AS s FROM work_events WHERE event_type = ? AND json_extract(payload_json, ?) = ?").get("ticket.transitioned", "$.to", "ready_for_merge");
    console.log(r.s);' "$D/data/dispatch.sqlite"
}
world() {  # <case>: one repo, a delivered ticket in review
  D="$WORK/$1"; mkdir -p "$D/data" "$D/home"
  export HOME="$D/home" GAFFER_DATA="$D/data" DISPATCH_DB="$D/data/dispatch.sqlite" MEMORY_DB="$D/data/memory.sqlite"
  wgd init >/dev/null
  git init -q -b main "$D/repo"
  git -C "$D/repo" config user.email fixture@example.invalid; git -C "$D/repo" config user.name Fixture
  mkdir -p "$D/repo/test"
  printf 'base\n' > "$D/repo/version.txt"
  printf 'import test from "node:test";\ntest("smoke", () => {});\n' > "$D/repo/test/smoke.test.mjs"
  git -C "$D/repo" add -A; git -C "$D/repo" commit -qm baseline
  git -C "$D/repo" switch -qc gaffer/change
  printf 'delivery\n' > "$D/repo/version.txt"; git -C "$D/repo" commit -qam deliver
  HEAD="$(git -C "$D/repo" rev-parse HEAD)"
  git -C "$D/repo" switch -q main
  wgd repo add -n repo --path "$D/repo" --branch main --test "node --test test/smoke.test.mjs" >/dev/null
  wgd ticket create -t "Change the version" --policy team_light --description "One change" --risk low >/dev/null
  local ac agent token
  ac="$(wgd ac add 1 -t "The version says delivery" | jf 'd.ac_id')"
  wgd ticket repo-access set 1 repo --access write --relation confirmed >/dev/null
  wgd ticket ready 1 >/dev/null
  agent="$(wgd agent register -n fixture --max-risk high | jf 'd.agent.id')"
  token="$(wgd claim-ticket 1 --agent "$agent" --ttl 900 | jf 'd.claimToken')"
  wgd evidence 1 --token "$token" --type test_output --summary "version changed" --ac "$ac" >/dev/null
  wgd ticket repo-delivery record 1 repo --branch gaffer/change --commit "$HEAD" >/dev/null
  wgd submit 1 --token "$token" --reason "delivered" >/dev/null
  MAIN0="$(main_head)"
}
approve() { wgd review approve 1 --reviewer fixture --commit "repo=$HEAD" >/dev/null; }
reopen() { wgd ticket reopen-for-review 1 --as admin --reason "${1:-changed my mind}" --resolution "look again" >/dev/null; }
truncate_after() {  # <rowid>: delete every later row and write the status back
  sql "DELETE FROM work_events WHERE rowid > $1" "UPDATE tickets SET status = 'ready_for_merge' WHERE number = 1"
}
MT() { ( cd "$D" && node "$RUNNER_DIR/bin/merge-ticket.mjs" --ticket 1 ) > "$D/mt.log" 2>&1; }
LANE() {
  : > "$D/lane.log"
  ( cd "$D" || exit 2
    log() { printf '%s\n' "$*" >> "$D/lane.log"; }
    wg() { node "$DISPATCH_JS" --db "$DISPATCH_DB" "$@"; }
    jget() { node "$RUNNER_DIR/lib/json-tool.mjs" expr "$1"; }
    gaffer_refresh_cards() { :; }
    _gaffer_flag_on() { case "${1:-}" in 1|true|yes|on) return 0 ;; *) return 1 ;; esac; }
    export RUNNER_DIR
    # shellcheck source=../lib/automerge.sh
    source "$RUNNER_DIR/lib/automerge.sh"
    # shellcheck source=../lib/land.sh
    source "$RUNNER_DIR/lib/land.sh"
    gaffer_land_delivery 1 "$D/repo" gaffer/change main "$(wg ticket show 1)" MERGE ) > /dev/null 2>&1
}
refused() {  # <label> <rc> <log>
  local label="$1" rc="$2" logf="$3"
  if [ "$rc" -ne 0 ] && [ "$(main_head)" = "$MAIN0" ] && [ "$(status)" = blocked ]; then
    ok "$label: refused, main untouched, held for a person"
  else
    fail "$label: rc=$rc main moved=$([ "$(main_head)" = "$MAIN0" ] && echo no || echo YES) status=$(status) $(tail -2 "$logf" | tr '\n' '|')"
  fi
}
landed() {  # <label> <rc> <log>
  if [ "$2" -eq 0 ] && git -C "$D/repo" merge-base --is-ancestor "$HEAD" main && [ "$(status)" = "done" ]; then
    ok "$1: lands"
  else
    fail "$1: rc=$2 status=$(status) $(tail -3 "$3" | tr '\n' '|')"
  fi
}

echo "== R1: revoked, only the status written back =="
world r1; approve; reopen
[ "$(status)" = in_review ] || fail "R1 fixture: reopen left $(status)"
sql "UPDATE tickets SET status = 'ready_for_merge' WHERE number = 1"
MT; refused "R1 gaffer merge" "$?" "$D/mt.log"
grep -q "undone after it was given" "$D/mt.log" && ok "R1: the refusal says the approval was undone" || fail "R1: message $(tail -2 "$D/mt.log")"

echo "== R2: revoked, the later rows deleted, the status reset =="
world r2; approve; A="$(approval_seq)"; reopen; truncate_after "$A"
wgd events verify >/dev/null 2>&1 && ok "R2: the shortened log verifies on its own (the attack is sound)" || fail "R2 fixture: chain broken"
MT; refused "R2 gaffer merge" "$?" "$D/mt.log"
grep -q "deleted or rewritten" "$D/mt.log" && grep -q "gate-key reanchor" "$D/mt.log" \
  && ok "R2: the refusal names the truncation and the way back" || fail "R2: message $(tail -2 "$D/mt.log")"

echo "== R3: the same through the merge lane =="
world r3; approve; A="$(approval_seq)"; reopen; truncate_after "$A"
LANE; refused "R3 merge lane" "$?" "$D/lane.log"

echo "== R4: other revocations truncated away =="
world r4a; approve; A="$(approval_seq)"
wgd ticket move 1 refining >/dev/null; [ "$(status)" = refining ] || fail "R4a fixture: $(status)"
truncate_after "$A"; MT; refused "R4 sent back" "$?" "$D/mt.log"
world r4b; approve; A="$(approval_seq)"
wgd wont-do 1 --reason "no longer wanted" >/dev/null; [ "$(status)" = cancelled ] || fail "R4b fixture: $(status)"
truncate_after "$A"; MT; refused "R4 won't do" "$?" "$D/mt.log"
world r4c; approve; A="$(approval_seq)"
wgd ticket hold 1 --reason-code moved_since_review --reason "held" --as system >/dev/null
[ "$(status)" = blocked ] || fail "R4c fixture: $(status)"
truncate_after "$A"; MT; refused "R4 held by the runner" "$?" "$D/mt.log"

echo "== R5: the whole database rolled back to a copy taken at approval =="
world r5; approve
cp "$D/data/dispatch.sqlite" "$D/snapshot.sqlite"
reopen
cp "$D/snapshot.sqlite" "$D/data/dispatch.sqlite"; rm -f "$D/data/dispatch.sqlite-wal" "$D/data/dispatch.sqlite-shm"
[ "$(status)" = ready_for_merge ] || fail "R5 fixture: $(status)"
MT; refused "R5 rollback" "$?" "$D/mt.log"

echo "== R6: a host write after the truncation does not paper over it =="
world r6; approve; A="$(approval_seq)"; reopen; truncate_after "$A"
n0="$(wgd events verify 2>&1 | sed -n 's/.*(\([0-9]*\) events.*/\1/p')"
wgd agent register -n later --max-risk low >/dev/null
n1="$(wgd events verify 2>&1 | sed -n 's/.*(\([0-9]*\) events.*/\1/p')"
[ -n "$n0" ] && [ "${n1:-0}" -gt "$n0" ] && ok "R6: the host wrote a later event ($n0 -> $n1)" || fail "R6 fixture: no later host write ($n0 -> $n1)"
LANE; refused "R6 after a later host write" "$?" "$D/lane.log"

echo "== R8: a future-dated in_review entry planted before a person approves =="
# Every review pin read as stale against it, so the genuine approval sealed no commit and
# the unreviewed head of the branch landed. The seal now binds the commits the person named.
world r8
node --no-warnings --input-type=module -e '
  import { createRequire } from "node:module"; const require = createRequire(import.meta.url);
  const { DatabaseSync } = require("node:sqlite");
  const chain = await import(process.argv[1]);
  const d = new DatabaseSync(process.argv[2]);
  const t = d.prepare("SELECT id FROM tickets WHERE number = 1").get();
  const f = { id: "planted", entity_type: "ticket", entity_id: t.id, actor_type: "agent", actor_id: "a",
    event_type: "ticket.transitioned", payload_json: JSON.stringify({ from: "in_review", to: "in_review", reason: "x", patch: null }),
    correlation_id: null, created_at: "2099-01-01T00:00:00.000Z" };
  const prev = chain.latestEventHash(d);
  d.prepare("INSERT INTO work_events (id, entity_type, entity_id, actor_type, actor_id, event_type, payload_json, correlation_id, created_at, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(f.id, f.entity_type, f.entity_id, f.actor_type, f.actor_id, f.event_type, f.payload_json, f.correlation_id, f.created_at, prev, chain.eventHash(prev, f));
  d.close();' "$ROOT/packages/dispatch/dist/events/eventChain.js" "$D/data/dispatch.sqlite"
approve
git -C "$D/repo" switch -q gaffer/change
printf 'not reviewed\n' > "$D/repo/version.txt"; git -C "$D/repo" commit -qam "unreviewed"
OTHER="$(git -C "$D/repo" rev-parse HEAD)"; git -C "$D/repo" switch -q main
MT; rc=$?
if git -C "$D/repo" merge-base --is-ancestor "$OTHER" main; then
  fail "R8: the UNREVIEWED commit landed (rc=$rc)"
else
  [ "$rc" -ne 0 ] && [ "$(main_head)" = "$MAIN0" ] && ok "R8: the unreviewed head does not land, main untouched" \
    || fail "R8: rc=$rc $(tail -2 "$D/mt.log" | tr '\n' '|')"
fi

echo "== R7: genuine flows =="
world r7a; approve; MT; landed "R7 a person's approval" "$?" "$D/mt.log"
world r7b; approve; reopen; approve; LANE; landed "R7 reopened and re-approved" "$?" "$D/lane.log"
world r7c; approve; A="$(approval_seq)"; reopen; truncate_after "$A"
MT; refused "R7c truncated first" "$?" "$D/mt.log"
out="$(wgd gate-key reanchor 2>&1)" && ok "R7c: a person re-anchors the restored log" || fail "R7c reanchor: $out"
reopen unsigned_approval && approve
MT; landed "R7c re-anchored, reopened, re-approved" "$?" "$D/mt.log"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "signed-acts-revocation: all $PASS checks passed"
  exit 0
fi
echo "signed-acts-revocation: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
