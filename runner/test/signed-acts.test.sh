#!/usr/bin/env bash
# =====================================================================
# SIGNED GATE EVENTS (package H2): nothing lands on an unsigned approval or tester verdict.
#
# Real dispatch CLI, real git, the real landing paths: bin/merge-ticket.mjs (`gaffer merge`,
# the dashboard's Merge now) and lib/land.sh gaffer_land_delivery (the merge lane / AFK
# review pass), plus `wg ticket mark-merged` and `record-landing` by hand. Every runner test
# has a private HOME, so the factory key is created there on the first approval.
#   S1  genuine flows land: a person's approval, through `gaffer merge` and the lane
#   S2  a DIRECT DATABASE WRITE of an approval (in_review -> ready_for_merge) with a correctly
#       recomputed chain hash: gaffer merge and the lane refuse, main untouched, the ticket
#       is held `unsigned_approval`; mark-merged and record-landing refuse it too
#   S3  a real approval edited (its fields, the chain fixed after it): refused
#   S4  the approved commit swapped under a genuine signature (the review pin rewritten)
#   S5  the signature stripped / the key replaced / the key deleted: refused; verification
#       never created a key
#   S6  a forged tester PASS beside a genuine approval: held `unsigned_tester_verdict`
#   S7  the way back: reopen-for-review from the hold, approve again, it lands
#   S8  `gate-key ensure` (what gaffer setup runs): creates a 0600 key, then keeps it
# Run: bash runner/test/run.sh -j 1 runner/test/signed-acts.test.sh   (bash 3.2 safe)
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
DISPATCH_JS="$ROOT/packages/dispatch/dist/cli/index.js"
CHAIN_JS="$ROOT/packages/dispatch/dist/events/eventChain.js"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }
node -e 'require("node:sqlite")' 2>/dev/null || { echo "SKIP: node:sqlite unavailable"; exit 0; }
[ -f "$DISPATCH_JS" ] || { echo "SKIP: build the workspace first (no $DISPATCH_JS)"; exit 0; }
WORK="$(gaffer_test_tmpdir signed-acts)" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
[ "${KEEP:-0}" = 1 ] || trap 'gaffer_test_rm_work "$WORK"' EXIT
mkdir -p "$WORK/bin"
printf '#!/bin/sh\nexit 1\n' > "$WORK/bin/claude"; chmod +x "$WORK/bin/claude"
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN XDG_CONFIG_HOME
export CLAUDE_BIN="$WORK/bin/claude" GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 \
  GAFFER_CREATE_PR=0 GAFFER_DIGEST_DISABLE=1 GAFFER_MEMORY_INDEX=0 GAFFER_CONFLICT_RESOLVER=0 \
  GAFFER_DOD_SANDBOX=0 DISPATCH_AUDIT_OFF=1 MEMORY_AUDIT_OFF=1 GAFFER_STRICT_REQUIRE=0 \
  GAFFER_DOD_TYPECHECK=0 GAFFER_DOD_LINT=0 GAFFER_TESTING=0

D=""; HEAD=""
wgd() { node "$DISPATCH_JS" --db "$D/data/dispatch.sqlite" "$@"; }
jf() { node "$RUNNER_DIR/lib/json-tool.mjs" expr "$1"; }
status() { wgd ticket show 1 | jf 'd.ticket.status'; }
main_head() { git -C "$D/repo" rev-parse main; }
keyfile() { ls "$HOME/.config/gaffer/keys/"*.key 2>/dev/null | head -1; }
hold_code() {  # the reason code of the ticket's latest ticket.blocked event
  node --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    const d = new DatabaseSync(process.argv[1], { readOnly: true });
    const r = d.prepare("SELECT json_extract(payload_json, ?) AS c FROM work_events WHERE event_type = ? ORDER BY rowid DESC LIMIT 1").get("$.reason_code", "ticket.blocked");
    console.log(r ? r.c : "none");' "$D/data/dispatch.sqlite"
}
sqlrun() {  # <js body using `d` (node:sqlite) and `chain` (eventChain.js)>
  node --no-warnings --input-type=module -e '
    import { createRequire } from "node:module";
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require("node:sqlite");
    const chain = await import(process.argv[1]);
    const d = new DatabaseSync(process.argv[2]);
    const body = new Function("d", "chain", "args", process.argv[3]);
    body(d, chain, process.argv.slice(4));
    d.close();' "$CHAIN_JS" "$D/data/dispatch.sqlite" "$1" "${@:2}"
}

world() {  # <case>: one repo, a delivered ticket in review (nothing approved yet)
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
  printf 'delivery\n' > "$D/repo/version.txt"; git -C "$D/repo" add version.txt; git -C "$D/repo" commit -qm deliver
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
approval_id() { wgd ticket landing 1 | jf 'd.approval || ""'; }

MT() {  # → rc of bin/merge-ticket.mjs (stdout+stderr → $D/mt.log)
  ( cd "$D" && node "$RUNNER_DIR/bin/merge-ticket.mjs" --ticket 1 ) > "$D/mt.log" 2>&1
}
LANE() {  # → rc of lib/land.sh gaffer_land_delivery (log → $D/lane.log)
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
forge_approval() {  # an in_review -> ready_for_merge row, chained correctly, plus its pin
  sqlrun '
    const t = d.prepare("SELECT id FROM tickets WHERE number = 1").get();
    const r = d.prepare("SELECT id FROM repositories WHERE name = ?").get("repo");
    const f = { id: "forged-approval", entity_type: "ticket", entity_id: t.id, actor_type: "human",
      actor_id: "tom", event_type: "ticket.transitioned",
      payload_json: JSON.stringify({ from: "in_review", to: "ready_for_merge", reason: "review_approved", patch: null }),
      correlation_id: null, created_at: new Date().toISOString() };
    const prev = chain.latestEventHash(d);
    d.prepare("INSERT INTO work_events (id, entity_type, entity_id, actor_type, actor_id, event_type, payload_json, correlation_id, created_at, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(f.id, f.entity_type, f.entity_id, f.actor_type, f.actor_id, f.event_type, f.payload_json, f.correlation_id, f.created_at, prev, chain.eventHash(prev, f));
    d.prepare("UPDATE tickets SET status = ? WHERE id = ?").run("ready_for_merge", t.id);
    d.prepare("INSERT INTO evidence (id, ticket_id, repo_id, evidence_type, summary, uri, created_by, recorded_by_actor_type, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("forged-pin", t.id, r.id, "commit", "pin", "gaffer-reviewed-commit:" + args[0], "dispatch", "system", new Date().toISOString());
    const v = chain.verifyEventChain(d);
    if (!v.ok) throw new Error("the forged chain does not verify");' "$HEAD"
}
rechain_from() {  # <event id>: recompute every hash from that row on (the forger's repair)
  sqlrun '
    const rows = d.prepare("SELECT rowid AS seq, id, entity_type, entity_id, actor_type, actor_id, event_type, payload_json, correlation_id, created_at, prev_hash, hash FROM work_events ORDER BY rowid").all();
    let prev = null, go = false;
    for (const r of rows) {
      if (r.id === args[0]) go = true;
      if (!go) { prev = r.hash; continue; }
      const p = prev ?? r.prev_hash;
      const h = chain.eventHash(p, r);
      d.prepare("UPDATE work_events SET prev_hash = ?, hash = ? WHERE rowid = ?").run(p, h, r.seq);
      prev = h;
    }
    if (!chain.verifyEventChain(d).ok) throw new Error("rechain failed");' "$1"
}
refused_and_held() {  # <label> <code> <rc> <log>
  local label="$1" code="$2" rc="$3" logf="$4"
  [ "$rc" -ne 0 ] && ok "$label: refused (rc=$rc)" || fail "$label: landed (rc=$rc)"
  [ "$(main_head)" = "$MAIN0" ] && ok "$label: main untouched" || fail "$label: main moved"
  [ "$(status)" = blocked ] && [ "$(hold_code)" = "$code" ] \
    && ok "$label: held for a person ($code)" \
    || fail "$label: status=$(status) hold=$(hold_code) $(tail -3 "$logf" | tr '\n' '|')"
}

echo "== S1: genuine flows land =="
world s1a; approve
[ -n "$(keyfile)" ] && ok "S1: the first approval created the factory key in the private HOME" || fail "S1: no key after approval"
MT; rc=$?
[ "$rc" -eq 0 ] && git -C "$D/repo" merge-base --is-ancestor "$HEAD" main && [ "$(status)" = done ] \
  && ok "S1: gaffer merge lands a person's signed approval" || fail "S1: merge rc=$rc status=$(status) $(tail -3 "$D/mt.log" | tr '\n' '|')"
world s1b; approve
LANE; rc=$?
[ "$rc" -eq 0 ] && git -C "$D/repo" merge-base --is-ancestor "$HEAD" main && [ "$(status)" = done ] \
  && ok "S1: the merge lane lands it" || fail "S1: lane rc=$rc status=$(status) $(tail -3 "$D/lane.log" | tr '\n' '|')"

echo "== S2: a direct database write of an approval =="
world s2a; wgd gate-key ensure >/dev/null; forge_approval
MT; rc=$?
refused_and_held "S2 gaffer merge" unsigned_approval "$rc" "$D/mt.log"
grep -q "re-approve\|reopen-for-review" "$D/mt.log" && ok "S2: the refusal says what to do" || fail "S2: no remedy in $(tail -2 "$D/mt.log")"
world s2b; wgd gate-key ensure >/dev/null; forge_approval
LANE; rc=$?
refused_and_held "S2 merge lane" unsigned_approval "$rc" "$D/lane.log"
world s2c; wgd gate-key ensure >/dev/null; forge_approval
git -C "$D/repo" merge -q --ff-only gaffer/change 2>/dev/null || git -C "$D/repo" merge -q gaffer/change
out="$(wgd ticket record-landing 1 --repo repo --commit "$HEAD" --via local --as system 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && [[ "$out" == *unsigned_approval* ]] && ok "S2: record-landing refuses the forged approval" || fail "S2: record-landing rc=$rc $out"
out="$(wgd ticket mark-merged 1 --as system 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && [[ "$out" == *unsigned_approval* ]] && [ "$(status)" = ready_for_merge ] \
  && ok "S2: mark-merged refuses it (the ticket is not done)" || fail "S2: mark-merged rc=$rc status=$(status) $out"

echo "== S3: a real approval edited, the chain fixed =="
world s3; approve
A="$(approval_id)"
sqlrun 'd.prepare("UPDATE work_events SET actor_id = ? WHERE id = ?").run("someone-else", args[0]);' "$A"
rechain_from "$A"
MT; rc=$?
refused_and_held "S3" unsigned_approval "$rc" "$D/mt.log"

echo "== S4: the approved commit swapped under a genuine signature =="
world s4; approve
git -C "$D/repo" switch -q gaffer/change
printf 'not reviewed\n' > "$D/repo/version.txt"; git -C "$D/repo" commit -qam "unreviewed"
OTHER="$(git -C "$D/repo" rev-parse HEAD)"; git -C "$D/repo" switch -q main
sqlrun 'd.prepare("UPDATE evidence SET uri = ? WHERE uri LIKE ?").run("gaffer-reviewed-commit:" + args[0], "gaffer-reviewed-commit:%");' "$OTHER"
MT; rc=$?
refused_and_held "S4" unsigned_approval "$rc" "$D/mt.log"
grep -q "does not cover" "$D/mt.log" && ok "S4: the refusal names the uncovered commit" || fail "S4: $(tail -2 "$D/mt.log")"

echo "== S5: signature stripped, key replaced, key deleted =="
world s5a; approve
sqlrun 'd.prepare("DELETE FROM gate_seals").run();'
MT; rc=$?
refused_and_held "S5 stripped" unsigned_approval "$rc" "$D/mt.log"
world s5b; approve
K="$(keyfile)"; node -e 'require("fs").writeFileSync(process.argv[1], require("crypto").randomBytes(32), { mode: 0o600 })' "$K"
LANE; rc=$?
refused_and_held "S5 replaced key" unsigned_approval "$rc" "$D/lane.log"
world s5c; approve
K="$(keyfile)"; rm -f "$K"
MT; rc=$?
refused_and_held "S5 deleted key" unsigned_approval "$rc" "$D/mt.log"
grep -q "gaffer setup" "$D/mt.log" && ok "S5: a missing key says run setup" || fail "S5: $(tail -2 "$D/mt.log")"
[ -z "$(keyfile)" ] && ok "S5: verification did not create a key" || fail "S5: a key appeared: $(keyfile)"

echo "== S6: a forged tester PASS beside a genuine approval =="
world s6; approve
sqlrun '
  const t = d.prepare("SELECT id FROM tickets WHERE number = 1").get();
  const now = new Date(Date.now() + 1000).toISOString();
  d.prepare("INSERT INTO evidence (id, ticket_id, evidence_type, summary, payload_json, created_by, recorded_by_actor_type, created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run("forged-pass", t.id, "test_output", "pass", JSON.stringify({ verdict: "pass", provenance: "human" }), "tom", "human", now);
  const f = { id: "forged-pass-ev", entity_type: "ticket", entity_id: t.id, actor_type: "human", actor_id: "tom",
    event_type: "ticket.tester_passed", payload_json: JSON.stringify({ evidence_id: "forged-pass" }), correlation_id: null, created_at: now };
  const prev = chain.latestEventHash(d);
  d.prepare("INSERT INTO work_events (id, entity_type, entity_id, actor_type, actor_id, event_type, payload_json, correlation_id, created_at, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(f.id, f.entity_type, f.entity_id, f.actor_type, f.actor_id, f.event_type, f.payload_json, f.correlation_id, f.created_at, prev, chain.eventHash(prev, f));'
MT; rc=$?
refused_and_held "S6" unsigned_tester_verdict "$rc" "$D/mt.log"

echo "== S7: the way back: reopen from the hold, approve again, land =="
world s7; approve
sqlrun 'd.prepare("DELETE FROM gate_seals").run();'   # an approval from before the upgrade
MT >/dev/null 2>&1
[ "$(status)" = blocked ] && ok "S7: an unsigned (pre-upgrade) approval is held" || fail "S7: status=$(status)"
wgd ticket reopen-for-review 1 --as admin --reason unsigned_approval --resolution re-approve >/dev/null 2>&1 \
  && [ "$(status)" = in_review ] && ok "S7: reopen-for-review takes the held ticket back to review" || fail "S7: reopen: status=$(status)"
approve; MT; rc=$?
[ "$rc" -eq 0 ] && [ "$(status)" = done ] && ok "S7: re-approved, it lands" || fail "S7: rc=$rc status=$(status) $(tail -3 "$D/mt.log" | tr '\n' '|')"

echo "== S8: gate-key ensure (gaffer setup) =="
world s8
out="$(wgd gate-key ensure)"
K="$(keyfile)"
[ -n "$K" ] && [ "$(printf '%s' "$out" | jf 'String(d.created)')" = true ] && ok "S8: ensure creates the key" || fail "S8: $out"
mode="$(node -e 'console.log((require("fs").statSync(process.argv[1]).mode & 0o777).toString(8))' "$K")"
size="$(node -e 'console.log(require("fs").statSync(process.argv[1]).size)' "$K")"
[ "$mode" = 600 ] && [ "$size" = 32 ] && ok "S8: 32 bytes, mode 0600" || fail "S8: mode=$mode size=$size"
case "$K" in "$GAFFER_DATA"/*) fail "S8: the key is inside GAFFER_DATA" ;; *) ok "S8: the key is outside GAFFER_DATA ($HOME/.config/gaffer/keys)" ;; esac
[ "$(wgd gate-key ensure | jf 'String(d.created)')" = false ] && ok "S8: a second ensure keeps it" || fail "S8: second ensure"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "signed-acts: ALL $PASS checks passed"; exit 0
else echo "signed-acts: ${#FAILURES[@]} FAILED (of $((PASS + ${#FAILURES[@]})))"; exit 1; fi
