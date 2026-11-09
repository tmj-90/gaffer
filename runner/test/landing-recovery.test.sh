#!/usr/bin/env bash
# =====================================================================
# LANDING RECOVERY (external review 16): the boundary between git or the PR provider
# changing something and SQLite recording it. A two-repository ticket, each repository with
# a bare upstream and a recorded PR, the real Dispatch CLI, a local stand-in for `gh` that
# behaves like the provider (a merged PR cannot be merged again, `--delete-branch` drops
# the remote and the local branch), a stub agent binary that is never run, and the
# evidence a landing needs on file: a bound tester PASS with saved tests (replayed on the
# merge candidate), the approval's per-repo pins and a recorded CI pass.
#   L1  the merger is killed (SIGKILL) after repo A's PR merged upstream and before the
#       landing record was written (GAFFER_TEST_MERGE_CRASH_AFTER_LAND, a test seam in
#       bin/merge-ticket.mjs). The retry against the same repos and database recognises
#       that A already landed (its approved commit is upstream), never asks the provider
#       to merge A again and never opens a PR, keeps the approval and the CI record,
#       regenerates the tester replay record on what landed, lands B, and only then is
#       the ticket done. L1b: the same crash on a local landing (no PRs).
#   L2  the provider rejects B (A landed, B did not, as secondary-pr-landing.test.sh
#       does); `wg ticket landing` / the ticket's landing block name A landed and B
#       pending; the SAME ticket retried (merge, and the merge lane in a second world)
#       lands only B and reaches done.
#   L3  two retries of the same partly landed ticket at once (two `gaffer merge`, and the
#       merge lane beside `gaffer merge`): one lands B, the other is refused by the landing
#       lock or finds nothing left to do; B's PR is asked to merge exactly once.
#   L4  the ledger side: a call completes and the usage-ledger append fails. The cost must
#       not vanish: a durable hold under GAFFER_DATA makes budget admission refuse paid
#       launches under a cap (a fresh process, as after a restart) until
#       `usage-ledger.mjs --reconcile` books it.
#   L5  no shortcut without proof: the "already upstream" recognition is never taken on a
#       remote-tracking ref the fetch did not just update (the network is down; the ref
#       says A's commit is upstream, its PR never merged), and it never skips the tester gate
#       (an acceptance ticket with no PASS whose PR was merged outside the gates holds).
# Run: bash runner/test/landing-recovery.test.sh   (bash 3.2 safe)
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
[ -f "$DISPATCH_JS" ] || { echo "SKIP: build the workspace first (no $DISPATCH_JS)"; exit 0; }
WORK="$(gaffer_test_tmpdir landing-recovery)" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
[ "${KEEP:-0}" = 1 ] || trap 'gaffer_test_rm_work "$WORK"' EXIT
mkdir -p "$WORK/bin"
printf '#!/bin/sh\nexit 1\n' > "$WORK/bin/claude"; chmod +x "$WORK/bin/claude"
# The provider stand-in. `pr merge <url>`: logged to $MOCK_ROOT/requests; refused while the
# repo is $MOCK_BLOCKED or once that PR has merged (as the provider refuses a merged PR);
# otherwise (after $MOCK_GH_SLEEP seconds) the upstream main becomes the PR head, and
# --delete-branch drops the upstream branch and the local one in the checkout it runs in.
# `pr create` is logged as `create:<repo>` (no landing path may open a PR).
cat > "$WORK/bin/gh" <<'GH'
#!/bin/sh
set -eu
if [ "$1" = "--version" ]; then echo fixture-gh; exit 0; fi
case "$1 ${2:-}" in
  "pr create") echo "create:$(basename "$PWD")" >> "$MOCK_ROOT/requests"; exit 1 ;;
  "pr merge") ;;
  *) exit 4 ;;
esac
case "$3" in */repoA/*) repo=repoA ;; */repoB/*) repo=repoB ;; *) exit 3 ;; esac
echo "$repo" >> "$MOCK_ROOT/requests"
if [ "$repo" = "${MOCK_BLOCKED:-}" ]; then echo 'required check is red' >&2; exit 1; fi
if [ -f "$MOCK_ROOT/merged-$repo" ]; then echo "Pull request $3 was already merged" >&2; exit 1; fi
sleep "${MOCK_GH_SLEEP:-0}"
remote="$MOCK_ROOT/$repo.git"
git --git-dir="$remote" update-ref refs/heads/main "$(git --git-dir="$remote" rev-parse refs/heads/gaffer/change)"
: > "$MOCK_ROOT/merged-$repo"
case " $* " in
  *" --delete-branch "*)
    git --git-dir="$remote" update-ref -d refs/heads/gaffer/change
    git branch -q -D gaffer/change >/dev/null 2>&1 || true ;;
esac
GH
chmod +x "$WORK/bin/gh"
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN GAFFER_TEST_MERGE_CRASH_AFTER_LAND
export CLAUDE_BIN="$WORK/bin/claude" GAFFER_GH_BIN="$WORK/bin/gh" GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 \
  GAFFER_PR_LOCAL_FALLBACK=0 GAFFER_CREATE_PR=1 GAFFER_DIGEST_DISABLE=1 GAFFER_MEMORY_INDEX=0 \
  GAFFER_CONFLICT_RESOLVER=0 GAFFER_DOD_SANDBOX=0 DISPATCH_AUDIT_OFF=1 MEMORY_AUDIT_OFF=1 \
  GAFFER_STRICT_REQUIRE=0 GAFFER_DOD_TYPECHECK=0 GAFFER_DOD_LINT=0

D=""
wgd() { node "$DISPATCH_JS" --db "$D/data/dispatch.sqlite" "$@"; }
jf() { node "$RUNNER_DIR/lib/json-tool.mjs" expr "$1"; }
upstream() { git --git-dir="$D/$1.git" rev-parse main; }
status() { wgd ticket show 1 | jf 'd.ticket.status'; }
calls() { if [ -s "$D/requests" ]; then tr '\n' ' ' < "$D/requests" | sed 's/ $//'; fi; }
landed_repos() { wgd ticket landing 1 | jf '(d.repos || []).filter(r => r.landed).map(r => r.repo).join(",")'; }
pending_repos() { wgd ticket landing 1 | jf '(d.repos || []).filter(r => !r.landed).map(r => r.repo).join(",")'; }
replay_records() {  # → the number of tester replay records on file for ticket 1
  node --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    const d = new DatabaseSync(process.argv[1], { readOnly: true });
    const r = d.prepare("SELECT COUNT(*) AS n FROM evidence WHERE uri LIKE ? AND recorded_by_actor_type = ?").get("gaffer-tester-replayed:%", "system");
    console.log(r.n);' "$D/data/dispatch.sqlite"
}
ci_state_a() {  # → the CI state on file for repo A's approved commit
  node --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    const d = new DatabaseSync(process.argv[1], { readOnly: true });
    const r = d.prepare("SELECT json_extract(payload_json, ?) AS s FROM work_events WHERE event_type = ? AND json_extract(payload_json, ?) = ? ORDER BY rowid DESC LIMIT 1").get("$.state", "ticket.ci_result", "$.commit", process.argv[2]);
    console.log(r ? r.s : "none");' "$D/data/dispatch.sqlite" "$HEAD_repoA"
}

TESTER_FILE='import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
test("the delivery is on the version", () => { assert.match(readFileSync("version.txt", "utf8"), /delivery/); });'
TESTER_IDS='[{"file":"test/acceptance.test.mjs","name":"the delivery is on the version"}]'

world() {  # <case> <pr|local>: a two-repo ticket, approved with both heads pinned
  D="$WORK/$1"; mkdir -p "$D/data"
  export HOME="$D" GAFFER_DATA="$D/data" DISPATCH_DB="$D/data/dispatch.sqlite" MEMORY_DB="$D/data/memory.sqlite" \
    MOCK_ROOT="$D" MOCK_BLOCKED="" MOCK_GH_SLEEP=0
  : > "$D/requests"
  wgd init >/dev/null
  local name pr="" tc wt
  for name in repoA repoB; do
    git init -q -b main "$D/$name"
    git -C "$D/$name" config user.email fixture@example.invalid; git -C "$D/$name" config user.name Fixture
    mkdir -p "$D/$name/test"
    printf 'base\n' > "$D/$name/version.txt"
    printf 'import test from "node:test";\ntest("smoke", () => {});\n' > "$D/$name/test/smoke.test.mjs"
    git -C "$D/$name" add -A; git -C "$D/$name" commit -qm baseline
    git -C "$D/$name" switch -qc gaffer/change
    printf '%s delivery\n' "$name" > "$D/$name/version.txt"; git -C "$D/$name" add version.txt; git -C "$D/$name" commit -qm deliver
    eval "HEAD_$name=\"\$(git -C \"\$D/\$name\" rev-parse HEAD)\""
    git -C "$D/$name" switch -q main
    git init -q --bare "$D/$name.git"
    git -C "$D/$name" remote add origin "$D/$name.git"
    git -C "$D/$name" push -q origin main gaffer/change
    git -C "$D/$name" fetch -q origin
    wgd repo add -n "$name" --path "$D/$name" --branch main --test "node --test test/smoke.test.mjs" >/dev/null
  done
  # The tester's saved tests for repo A, off the delivery head (gaffer-tests/ticket-1).
  wt="$D/tester-wt"; git -C "$D/repoA" worktree add -q --detach "$wt" "$HEAD_repoA" >/dev/null 2>&1
  printf '%s\n' "$TESTER_FILE" > "$wt/test/acceptance.test.mjs"
  git -C "$wt" checkout -q -B gaffer-tests/ticket-1; git -C "$wt" add -A; git -C "$wt" commit -qm "black-box tests for #1"
  tc="$(git -C "$wt" rev-parse HEAD)"; git -C "$D/repoA" worktree remove --force "$wt" >/dev/null 2>&1
  wgd ticket create -t "Update both repos" --policy team_light --description "One change per repository" --risk low >/dev/null
  local ac agent token
  ac="$(wgd ac add 1 -t "Update both versions" | jf 'd.ac_id')"
  for name in repoA repoB; do wgd ticket repo-access set 1 "$name" --access write --relation confirmed >/dev/null; done
  wgd ticket ready 1 >/dev/null
  agent="$(wgd agent register -n fixture --max-risk high | jf 'd.agent.id')"
  token="$(wgd claim-ticket 1 --agent "$agent" --ttl 900 | jf 'd.claimToken')"
  wgd evidence 1 --token "$token" --type test_output --summary "Both versions changed" --ac "$ac" >/dev/null
  for name in repoA repoB; do
    [ "$2" = pr ] && pr="--pr https://github.com/example/$name/pull/1"
    # shellcheck disable=SC2086
    eval "wgd ticket repo-delivery record 1 $name --branch gaffer/change --commit \"\$HEAD_$name\" $pr" >/dev/null
  done
  wgd submit 1 --token "$token" --reason "Both deliveries ready" >/dev/null
  [ "$2" = pr ] && wgd delivery-artifact 1 --branch gaffer/change --diff "Two filed PRs" --pr "https://github.com/example/repoA/pull/1" --as system >/dev/null
  # The independent tester's PASS bound to A's delivery head and its saved tests, as
  # dispatch's tester-pass path records it (the evidence row and the event naming it).
  node --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    const [db, tested, tc, tests] = process.argv.slice(1);
    const d = new DatabaseSync(db);
    const t = d.prepare("SELECT id FROM tickets WHERE number = 1").get();
    const p = { verdict: "pass", provenance: "system", tested_commit: tested, replay: "passed", tests_commit: tc, tests: JSON.parse(tests) };
    d.prepare("INSERT INTO evidence (id, ticket_id, evidence_type, summary, payload_json, created_by, recorded_by_actor_type) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("ev-tester-1", t.id, "test_output", "black-box tests pass", JSON.stringify(p), "tester", "system");
    d.prepare("INSERT INTO work_events (id, entity_type, entity_id, actor_type, event_type, payload_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run("we-tester-1", "ticket", t.id, "system", "ticket.tester_passed", JSON.stringify({ evidence_id: "ev-tester-1", tested_head: tested }));
    d.close();' "$DISPATCH_DB" "$HEAD_repoA" "$tc" "$TESTER_IDS"
  wgd ticket ci-result 1 --commit "$HEAD_repoA" --state pass --as system >/dev/null
  wgd review approve 1 --reviewer fixture --commit "repoA=$HEAD_repoA" --commit "repoB=$HEAD_repoB" >/dev/null
  APPROVAL="$(wgd ticket landing 1 | jf 'd.approval || ""')"
}

MT() {  # [env...] → rc of bin/merge-ticket.mjs (stdout → $D/mt.out, stderr → $D/mt.log)
  ( cd "$D" && env "$@" node "$RUNNER_DIR/bin/merge-ticket.mjs" --ticket 1 ) > "$D/mt.out" 2>>"$D/mt.log"
}
LANE() {  # → rc of lib/land.sh gaffer_land_delivery (log → $D/lane.log)
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
    gaffer_land_delivery 1 "$D/repoA" gaffer/change main "$(wg ticket show 1)" MERGE ) > /dev/null 2>&1
}

echo "== L1: killed after A's PR merged upstream, before the landing record =="
world l1 pr
{ MT GAFFER_TEST_MERGE_CRASH_AFTER_LAND=repoA; } 2>/dev/null; rc=$?
A_UP="$(upstream repoA)"
[ "$rc" -ge 128 ] && ok "L1: the merger died at the seam (rc=$rc)" || fail "L1: the crash seam did not fire (rc=$rc) $(tail -3 "$D/mt.log" | tr '\n' '|')"
[ "$A_UP" = "$HEAD_repoA" ] && ok "L1: A's PR merged upstream before the crash" || fail "L1: A's upstream is $A_UP, not the delivery"
[ "$(landed_repos)" = "" ] && [ "$(status)" = ready_for_merge ] && ok "L1: no landing on record, ticket still ready_for_merge (the window is real)" || fail "L1: landed=$(landed_repos) status=$(status)"
[ "$(calls)" = repoA ] && ok "L1: only A's PR was asked for before the crash" || fail "L1: provider calls: $(calls)"
MT; rc=$?
[ "$rc" -eq 0 ] && [ "$(status)" = done ] && ok "L1: the retry lands the rest and the ticket is done" || fail "L1: retry rc=$rc status=$(status) $(cat "$D/mt.out") $(tail -4 "$D/mt.log" | tr '\n' '|')"
[ "$(calls)" = "repoA repoB" ] && ok "L1: the retry did not ask for A again (one PR merge per repo, no PR opened)" || fail "L1: provider calls: $(calls)"
[ "$(upstream repoA)" = "$A_UP" ] && ok "L1: A's upstream main did not move again" || fail "L1: A's upstream moved on the retry"
[ "$(upstream repoB)" = "$HEAD_repoB" ] && ok "L1: B landed upstream" || fail "L1: B's upstream is $(upstream repoB)"
[ "$(landed_repos)" = "repoA,repoB" ] && ok "L1: both landings on record" || fail "L1: landed: $(landed_repos)"
[ "$(replay_records)" = 1 ] && ok "L1: the tester replay record is on file (regenerated on what landed)" || fail "L1: replay records: $(replay_records)"
[ "$(ci_state_a)" = pass ] && ok "L1: the CI record for A's approved commit is kept" || fail "L1: CI record: $(ci_state_a)"
[ "$(wgd ticket landing 1 | jf '(d.repos || []).map(r => r.sha).join(",")')" = "$HEAD_repoA,$HEAD_repoB" ] && [ -n "$APPROVAL" ] && [ "$(wgd ticket landing 1 | jf 'd.approval || ""')" = "$APPROVAL" ] \
  && ok "L1: the approval and its pins are unchanged (no re-approval was needed)" || fail "L1: pins/approval: $(wgd ticket landing 1) (approved as $APPROVAL)"
[ ! -d "$GAFFER_DATA/locks/merge-ticket-1.lock" ] && ok "L1: the dead merger's lock was taken over and released" || fail "L1: a merge lock was left behind"

echo "== L1b: the same crash on a LOCAL landing (no PRs) =="
world l1b local
{ MT GAFFER_TEST_MERGE_CRASH_AFTER_LAND=repoA; } 2>/dev/null; rc=$?
A_MAIN="$(git -C "$D/repoA" rev-parse main)"
[ "$rc" -ge 128 ] && git -C "$D/repoA" merge-base --is-ancestor "$HEAD_repoA" main && [ "$(landed_repos)" = "" ] \
  && ok "L1b: A landed locally, nothing on record, the merger died (rc=$rc)" || fail "L1b: rc=$rc landed=$(landed_repos) $(tail -3 "$D/mt.log" | tr '\n' '|')"
MT; rc=$?
[ "$rc" -eq 0 ] && [ "$(status)" = done ] && ok "L1b: the retry lands B and the ticket is done" || fail "L1b: retry rc=$rc status=$(status) $(cat "$D/mt.out") $(tail -4 "$D/mt.log" | tr '\n' '|')"
[ "$(git -C "$D/repoA" rev-parse main)" = "$A_MAIN" ] && ok "L1b: A's main did not move again (no second merge commit)" || fail "L1b: A's main moved on the retry"
[ "$(landed_repos)" = "repoA,repoB" ] && [ "$(replay_records)" = 1 ] && ok "L1b: both landings and the replay record on file" || fail "L1b: landed=$(landed_repos) replays=$(replay_records)"

echo "== L2: the provider rejects B; the same ticket retried (merge, then the lane) =="
world l2 pr
MOCK_BLOCKED=repoB MT; rc=$?
[ "$rc" -eq 4 ] && [ "$(status)" = ready_for_merge ] && ok "L2: partly merged, held (rc=4)" || fail "L2: rc=$rc status=$(status)"
[ "$(landed_repos)" = repoA ] && [ "$(pending_repos)" = repoB ] && ok "L2: wg ticket landing names A landed and B pending" || fail "L2: landing: $(wgd ticket landing 1)"
[ "$(wgd ticket show 1 | jf '(d.landing && d.landing.partial) ? (d.landing.repos || []).map(r => r.repo + "=" + (r.landed ? "landed" : "pending")).join(",") : "not-partial"')" = "repoA=landed,repoB=pending" ] \
  && ok "L2: the ticket's landing block (what the ticket page reads) says partial: A landed, B pending" || fail "L2: ticket show landing: $(wgd ticket show 1 | jf 'JSON.stringify(d.landing)')"
A_UP="$(upstream repoA)"
MT; rc=$?
[ "$rc" -eq 0 ] && [ "$(status)" = done ] && ok "L2: the retry on the same fixture lands B, done" || fail "L2: retry rc=$rc status=$(status) $(cat "$D/mt.out") $(tail -4 "$D/mt.log" | tr '\n' '|')"
[ "$(calls)" = "repoA repoB repoB" ] && ok "L2: A was not asked again; B asked once more" || fail "L2: provider calls: $(calls)"
[ "$(upstream repoA)" = "$A_UP" ] && [ "$(upstream repoB)" = "$HEAD_repoB" ] && ok "L2: A unchanged, B landed upstream" || fail "L2: upstreams A=$(upstream repoA) B=$(upstream repoB)"
[ "$(replay_records)" = 1 ] && [ "$(ci_state_a)" = pass ] && ok "L2: one tester replay record, CI record kept" || fail "L2: replays=$(replay_records) ci=$(ci_state_a)"
world l2lane pr
MOCK_BLOCKED=repoB LANE; rc=$?
[ "$rc" -ne 0 ] && [ "$(landed_repos)" = repoA ] && ok "L2-lane: the lane leaves it partly merged (rc=$rc)" || fail "L2-lane: rc=$rc landed=$(landed_repos)"
LANE; rc=$?
[ "$rc" -eq 0 ] && [ "$(status)" = done ] && [ "$(calls)" = "repoA repoB repoB" ] && ok "L2-lane: the lane's retry lands only B, done" || fail "L2-lane: rc=$rc status=$(status) calls=$(calls) $(tail -4 "$D/lane.log" | tr '\n' '|')"

echo "== L3: two retries of the partly landed ticket at once =="
world l3 pr
MOCK_BLOCKED=repoB MT >/dev/null 2>&1
: > "$D/requests"
( MOCK_GH_SLEEP=2 MT; echo "$?" > "$D/rc1" ) &
p1=$!
( MOCK_GH_SLEEP=2 MT; echo "$?" > "$D/rc2" ) &
p2=$!
wait "$p1" "$p2"
r1="$(cat "$D/rc1")"; r2="$(cat "$D/rc2")"
[ "$(calls)" = repoB ] && ok "L3: B's PR was asked to merge exactly once (rc $r1/$r2)" || fail "L3: provider calls: $(calls) (rc $r1/$r2)"
[ "$(status)" = done ] && [ "$(landed_repos)" = "repoA,repoB" ] && ok "L3: the ticket is done, both landings on record" || fail "L3: status=$(status) landed=$(landed_repos) $(tail -6 "$D/mt.log" | tr '\n' '|')"
{ [ "$r1" = 0 ] || [ "$r2" = 0 ]; } && ok "L3: one of the two landed it" || fail "L3: neither run succeeded ($r1/$r2)"
world l3lane pr
MOCK_BLOCKED=repoB MT >/dev/null 2>&1
: > "$D/requests"
# The provider takes 6 s; the merge starts once the lane's PR merge of B is in flight.
( MOCK_GH_SLEEP=6 LANE; echo "$?" > "$D/rc1" ) &
p1=$!
i=0
while [ "$i" -lt 120 ] && ! grep -qx repoB "$D/requests" 2>/dev/null && ! grep -q HELD "$D/lane.log" 2>/dev/null; do
  sleep 0.5; i=$((i + 1))
done
( MOCK_GH_SLEEP=6 MT; echo "$?" > "$D/rc2" ) &
p2=$!
wait "$p1" "$p2"
r1="$(cat "$D/rc1")"; r2="$(cat "$D/rc2")"
[ "$(calls)" = repoB ] && ok "L3-lane: lane + merge: B's PR asked for exactly once (rc $r1/$r2)" || fail "L3-lane: provider calls: $(calls) (lane rc $r1, merge rc $r2)"
[ "$(status)" = done ] && ok "L3-lane: the ticket is done" || fail "L3-lane: status=$(status) $(tail -4 "$D/lane.log" | tr '\n' '|') $(tail -3 "$D/mt.log" | tr '\n' '|')"

echo "== L4: the usage-ledger append fails after a completed call =="
D="$WORK/l4"; mkdir -p "$D/data"
L4ENV="GAFFER_DATA=$D/data GAFFER_USAGE_LEDGER=$D/ledger-dir/usage-ledger.jsonl GAFFER_DAILY_BUDGET_USD=5"
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"done","total_cost_usd":0.42,"num_turns":3,"duration_ms":1000,"usage":{"input_tokens":10,"output_tokens":20}}' > "$D/call.json"
# shellcheck disable=SC2086
env $L4ENV node "$RUNNER_DIR/lib/usage-ledger.mjs" --kind delivery --ticket 5 --rc 0 --json-file "$D/call.json" >/dev/null 2>"$D/append.err"; arc=$?
[ "$arc" -eq 0 ] && ok "L4: the append failure does not fail the tick's ledger call (rc=0)" || fail "L4: ledger CLI rc=$arc"
grep -q "usage-ledger append FAILED" "$D/append.err" && ok "L4: the failure is logged" || fail "L4: no warning: $(cat "$D/append.err")"
[ ! -e "$D/ledger-dir/usage-ledger.jsonl" ] && ok "L4: the row is not in the ledger (the append really failed)" || fail "L4: the ledger was written"
# A fresh process, as after a restart: admission under a cap must not read the lost cost as $0.
# shellcheck disable=SC2086
env $L4ENV node "$RUNNER_DIR/lib/budget-admission.mjs" check --kind delivery > "$D/adm1.json" 2>/dev/null; brc=$?
[ "$brc" -eq 3 ] && ok "L4: after the restart a paid launch under a cap is refused (cost not vanished)" || fail "L4: admission rc=$brc $(cat "$D/adm1.json")"
case "$(cat "$D/adm1.json")" in *reconcile*) ok "L4: the refusal names the reconcile" ;; *) fail "L4: refusal: $(cat "$D/adm1.json")" ;; esac
mkdir -p "$D/ledger-dir"
# shellcheck disable=SC2086
env $L4ENV node "$RUNNER_DIR/lib/usage-ledger.mjs" --reconcile --usd 0.42 --note "booked from billing" >/dev/null 2>"$D/rec.err"; rrc=$?
[ "$rrc" -eq 0 ] && ok "L4: --reconcile books it" || fail "L4: reconcile rc=$rrc $(cat "$D/rec.err")"
# shellcheck disable=SC2086
env $L4ENV node "$RUNNER_DIR/lib/budget-admission.mjs" check --kind delivery > "$D/adm2.json" 2>/dev/null; brc=$?
[ "$brc" -eq 0 ] && ok "L4: after the reconcile admission admits again" || fail "L4: admission after reconcile rc=$brc $(cat "$D/adm2.json")"
grep -q '"ticket":5' "$D/ledger-dir/usage-ledger.jsonl" 2>/dev/null && ok "L4: the held call's row reached the ledger with the reconcile" || fail "L4: the held row is not in the ledger: $(cat "$D/ledger-dir/usage-ledger.jsonl" 2>/dev/null)"

echo "== L5: no shortcut without proof =="
drop_tester() {  # [acceptance]: remove the tester PASS (and mark the ticket an acceptance ticket)
  node --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    const d = new DatabaseSync(process.argv[1]);
    d.prepare("DELETE FROM evidence WHERE id = ?").run("ev-tester-1");
    d.prepare("DELETE FROM work_events WHERE id = ?").run("we-tester-1");
    if (process.argv[2] === "acceptance") d.prepare("UPDATE tickets SET acceptance = 1 WHERE number = 1").run();
    d.close();' "$DISPATCH_DB" "${1:-}"
}
world l5a pr
drop_tester
git -C "$D/repoA" update-ref refs/remotes/origin/main "$HEAD_repoA"
git -C "$D/repoA" remote set-url origin "$D/no-such-remote.git"
MOCK_BLOCKED=repoA MT; rc=$?  # the network is down: the provider cannot be reached either
[ "$(status)" = ready_for_merge ] && [ "$(landed_repos)" = "" ] && ! grep -q 'already in refs/remotes' "$D/mt.log" \
  && ok "L5: a failed fetch takes no shortcut on the remote-tracking ref (rc=$rc, nothing recorded)" \
  || fail "L5: failed fetch: rc=$rc status=$(status) landed=$(landed_repos) (A's PR never merged)"
world l5b pr
drop_tester acceptance
git --git-dir="$D/repoA.git" update-ref refs/heads/main "$HEAD_repoA"; : > "$D/merged-repoA"
MT; rc=$?
[ "$rc" -eq 4 ] && [ "$(status)" = ready_for_merge ] && [ "$(landed_repos)" = "" ] && grep -q 'landing check unverified' "$D/mt.log" \
  && ok "L5: an acceptance ticket with no tester PASS holds though its commit is upstream" \
  || fail "L5: no PASS: rc=$rc status=$(status) landed=$(landed_repos) $(tail -2 "$D/mt.log" | tr '\n' '|')"
: > "$D/lane.log"; LANE; rc=$?
[ "$rc" -ne 0 ] && [ "$(status)" = ready_for_merge ] && [ "$(landed_repos)" = "" ] && grep -q 'unverified' "$D/lane.log" \
  && ok "L5: the lane holds it too" || fail "L5: lane, no PASS: rc=$rc status=$(status) landed=$(landed_repos) $(tail -2 "$D/lane.log" | tr '\n' '|')"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "landing-recovery: ALL $PASS checks passed"; exit 0
else echo "landing-recovery: ${#FAILURES[@]} FAILED (of $((PASS + ${#FAILURES[@]})))"; exit 1; fi
