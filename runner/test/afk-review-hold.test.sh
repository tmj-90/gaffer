#!/usr/bin/env bash
# =====================================================================
# AFK REVIEW — a reviewer that did not run is NOT a verdict.
# ---------------------------------------------------------------------
# With autonomy flags on and no sandbox available, containment correctly refuses
# to spawn the reviewer (worker_deliver exits non-zero, empty envelope). review.sh
# used to read that empty result as the fail-closed default CHANGES and, in AFK
# mode, REJECT a possibly-fine delivery back to rework. Now it HOLDS: the ticket
# stays in_review for a human, the reason is logged, and the pass never approves
# or reworks on a non-verdict. A real APPROVE with the approve gate denied still
# holds (advisory), so both hold paths are pinned here. ONE AGENT REVIEW PER DELIVERED
# COMMIT: once a case leaves a real verdict (approve, changes) on the head, the next case
# that needs a reviewer runs on a rework (a new head; rework_head below), because the
# review pass never pays for a second review of a commit dispatch holds a verdict for
# (pinned in review-once-per-head.test.sh and -resubmit.test.sh). Case C then grants every
# gate and proves the SHIP path end to end: merge → done, the post-merge memory
# work (digest freshness stamped, the ticket's Feature-Id advanced to shipped, no
# duplicate ledger row), the merged branch deleted, and the reviewer's MCP runtime
# bound to GAFFER_REVIEW_TICKET (claimless per-AC notes for that ticket only).
# (F, an approved branch that moves before the merge lane lands it:
# afk-review-hold-moved.test.sh, on its own copy of the world.)
# Real dispatch + real tick.sh; the stub `claude` is switched per case via a
# mode file. Run: bash runner/test/afk-review-hold.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
# shellcheck source=lib/afk-review-world.sh
source "$HERE/lib/afk-review-world.sh"

# Seed memory: a digest (so `digest touch` has something to stamp) and a BUILDING feature
# whose id rides on the ticket description (`Feature-Id:`), filed as the one ticket of a
# feature epic exactly as the feature-backlog loop files it (a marked ticket that no epic
# holds never completes a feature); case C proves the AFK merge ships it.
lg digest set repo --source onboard --overview o --structure s --conventions c --stack k >/dev/null 2>&1
FEAT_ID="$(lg feature add repo --name "Hold probe" --summary "probe" --status building 2>/dev/null | sed -n 's/^memory: added feature \([^ ]*\) .*/\1/p')"
N="$(printf '{"epic":{"name":"Hold probe","description":"probe","acceptance":false},"tickets":[{"title":"Hold probe","description":"deliver then review\\n\\nFeature-Id: %s","acceptanceCriteria":["helper added"],"repo":"repo","testable":false,"dependsOn":[]}]}' "$FEAT_ID" \
  | wg epic create - 2>/dev/null | jget 'd.ticket_numbers[0]')"
wg ac add "$N" -t "helper added" >/dev/null 2>&1
wg ticket repo-access set "$N" repo --access write --relation confirmed >/dev/null 2>&1
wg ticket ready "$N" >/dev/null 2>&1
OUT0="$(run_tick)"
grep -q '^TICK_RESULT=worked$' <<<"$OUT0" && [ "$(st "$N")" = "in_review" ] \
  && ok "setup: #$N delivered → in_review" || fail "setup delivery failed: $OUT0 status=$(st "$N")"

echo "== A. reviewer REFUSED to run (rc=75, empty envelope) with every autonomy grant on =="
echo refuse > "$MODE_FILE"
rm -f "$GAFFER_DATA/.reviewed-tickets"
OUTA="$(REVIEW_MODE=agent DISPATCH_ALLOW_AGENT_APPROVE=1 AUTO_MERGE=1 MERGE_ON_AGENT_REVIEW=1 run_tick)"
grep -q '^TICK_RESULT=reviewed$' <<<"$OUTA" && ok "A: the review pass ran (TICK_RESULT=reviewed)" || fail "A: tick result $OUTA"
grep -q 'verdict=held' "$GAFFER_DATA/factory.log" && grep -q 'not a verdict' "$GAFFER_DATA/factory.log" \
  && ok "A: logged as HELD — 'reviewer did not run … not a verdict'" || fail "A: no held/not-a-verdict log line: $(tail -3 "$GAFFER_DATA/factory.log" | tr '\n' '|')"
[ "$(st "$N")" = "in_review" ] && ok "A: #$N stays in_review (not reworked, not approved)" || fail "A: #$N became '$(st "$N")'"
grep -q 'CHANGES; re-queued' "$GAFFER_DATA/factory.log" && fail "A: a non-verdict was treated as CHANGES (re-queued)" || ok "A: nothing was re-queued for rework"
grep -qx "$N" "$GAFFER_DATA/.reviewed-tickets" 2>/dev/null && ok "A: #$N skipped for the rest of this run (no re-review spin)" || fail "A: #$N not in the reviewed-skip file"

echo "== A2. reviewer REFUSED by the usage window: held (not a verdict) and the factory pauses =="
echo limit > "$MODE_FILE"
rm -f "$GAFFER_DATA/.reviewed-tickets" "$GAFFER_DATA/usage-pause.json"
OUTA2="$(REVIEW_MODE=agent DISPATCH_ALLOW_AGENT_APPROVE=1 AUTO_MERGE=1 MERGE_ON_AGENT_REVIEW=1 GAFFER_STRICT_REQUIRE=0 run_tick)"
[ "$(st "$N")" = "in_review" ] && ok "A2: #$N stays in_review (not reworked, not approved)" || fail "A2: #$N became '$(st "$N")' ($OUTA2)"
grep -q "verdict=held.*refused by the usage window" "$GAFFER_DATA/factory.log" \
  && ok "A2: the hold names the usage-window refusal" || fail "A2: hold reason: $(grep "agent review of #$N" "$GAFFER_DATA/factory.log" | tail -1)"
[ -s "$GAFFER_DATA/usage-pause.json" ] && grep -q '"lane":"review"' "$GAFFER_DATA/usage-pause.json" \
  && ok "A2: the pause was recorded (lane review), so no further tick spins into the refusal" \
  || fail "A2: no review pause: $(cat "$GAFFER_DATA/usage-pause.json" 2>/dev/null)"
rm -f "$GAFFER_DATA/usage-pause.json"

echo "== B. a real APPROVE with the approve gate DENIED holds as advisory =="
echo approve > "$MODE_FILE"
rm -f "$GAFFER_DATA/.reviewed-tickets"
OUTB="$(REVIEW_MODE=agent run_tick)"
grep -q '^TICK_RESULT=reviewed$' <<<"$OUTB" && ok "B: the review pass ran" || fail "B: tick result $OUTB"
grep -q 'verdict=approve, approve_gate=deny' "$GAFFER_DATA/factory.log" && ok "B: verdict parsed as approve, gate deny → advisory hold" || fail "B: expected verdict=approve/approve_gate=deny: $(tail -2 "$GAFFER_DATA/factory.log" | tr '\n' '|')"
[ "$(st "$N")" = "in_review" ] && ok "B: #$N still in_review for a human" || fail "B: #$N became '$(st "$N")'"

echo "== B1. the same head is not reviewed again on a later run =="
rm -f "$GAFFER_DATA/.reviewed-tickets"
OUTB1="$(REVIEW_MODE=agent run_tick)"
grep -q "REVIEW: #$N head .* already has an agent review verdict (approve)" "$GAFFER_DATA/factory.log" \
  && ok "B1: the approved head is not reviewed a second time" || fail "B1: ($OUTB1) $(tail -2 "$GAFFER_DATA/factory.log" | tr '\n' '|')"
rework_head "$N"

echo "== B2. a CHANGES token followed by prose quoting an APPROVE token is NO verdict → HELD =="
echo trailing > "$MODE_FILE"; rm -f "$GAFFER_DATA/.reviewed-tickets"
OUTB2="$(REVIEW_MODE=agent DISPATCH_ALLOW_AGENT_APPROVE=1 AUTO_MERGE=1 MERGE_ON_AGENT_REVIEW=1 GAFFER_STRICT_REQUIRE=0 run_tick)"
[ "$(st "$N")" = "in_review" ] && grep -q "verdict=held.*final line is not a verdict token" "$GAFFER_DATA/factory.log" \
  && ok "B2: #$N held in_review (not approved, not reworked)" || fail "B2: #$N is '$(st "$N")' ($OUTB2): $(tail -2 "$GAFFER_DATA/factory.log" | tr '\n' '|')"

echo "== B3. a real CHANGES with the approve gate DENIED holds, and leaves an advisory note =="
echo changes > "$MODE_FILE"; rm -f "$GAFFER_DATA/.reviewed-tickets"
OUTB3="$(REVIEW_MODE=agent run_tick)"
[ "$(st "$N")" = "in_review" ] && grep -q 'verdict=changes, approve_gate=deny' "$GAFFER_DATA/factory.log" \
  && ok "B3: #$N held in_review on an advisory CHANGES" || fail "B3: #$N is '$(st "$N")' ($OUTB3): $(tail -2 "$GAFFER_DATA/factory.log" | tr '\n' '|')"
ADV="$(wg ticket show "$N" 2>/dev/null | jget '(d.evidence||[]).filter(e=>e.recorded_by_actor_type==="system"&&/^Reviewer agent \(advisory\): changes requested — /.test(e.summary)).map(e=>e.summary).join("|")')"
case "$ADV" in
  *"changes requested — add a docstring to addTask") ok "B3: the advisory CHANGES is recorded as system evidence with its ask" ;;
  *) fail "B3: no advisory note on #$N (got '$ADV')" ;;
esac

echo "== D. a reviewer that COMMITS in its worktree, then APPROVEs, with every grant on → HELD =="
rework_head "$N"
RBR="$(git -C "$R" branch --list "gaffer/ticket-$N-*" | tr -d ' *' | head -1)"
RSHA0="$(git -C "$R" rev-parse "refs/heads/$RBR")"; MAIN0="$(git -C "$R" rev-parse main)"
for mode in sneak sneak-branch; do
  echo "$mode" > "$MODE_FILE"; rm -f "$GAFFER_DATA/.reviewed-tickets"
  OUTD="$(REVIEW_MODE=agent DISPATCH_ALLOW_AGENT_APPROVE=1 AUTO_MERGE=1 MERGE_ON_AGENT_REVIEW=1 GAFFER_STRICT_REQUIRE=0 run_tick)"
  grep -q '^TICK_RESULT=reviewed$' <<<"$OUTD" && ok "D[$mode]: the review pass ran" || fail "D[$mode]: tick result $OUTD"
  [ "$(st "$N")" = "in_review" ] && ok "D[$mode]: #$N HELD in_review (not approved, not shipped)" || fail "D[$mode]: #$N became '$(st "$N")'"
  grep -q "SAFETY: #$N reviewer modified the candidate" "$GAFFER_DATA/factory.log" \
    && ok "D[$mode]: logged 'reviewer modified the candidate'" || fail "D[$mode]: no tamper log line: $(tail -3 "$GAFFER_DATA/factory.log" | tr '\n' '|')"
  [ "$(git -C "$R" rev-parse main)" = "$MAIN0" ] && ! git -C "$R" cat-file -e main:sneak.txt 2>/dev/null \
    && ok "D[$mode]: main lacks the reviewer's commit" || fail "D[$mode]: main moved / has sneak.txt: $(git -C "$R" log --oneline main | head -3 | tr '\n' '|')"
  [ "$(git -C "$R" rev-parse "refs/heads/$RBR")" = "$RSHA0" ] \
    && ok "D[$mode]: delivery branch $RBR still at the reviewed commit" || fail "D[$mode]: $RBR moved to $(git -C "$R" log --oneline -1 "refs/heads/$RBR")"
done
git -C "$R" rev-parse --verify -q refs/gaffer/review-tamper/"$N" >/dev/null \
  && ok "D: the moved head is kept for forensics (refs/gaffer/review-tamper/$N)" || fail "D: no refs/gaffer/review-tamper/$N"
echo approve > "$MODE_FILE"

echo "== C. APPROVE with every grant on → SHIPS: merge, memory work, branch cleanup, reviewer env =="
rm -f "$GAFFER_DATA/.reviewed-tickets" "$WORK/review-mcp.json"
RBR="$(git -C "$R" branch --list "gaffer/ticket-$N-*" | tr -d ' *' | head -1)"
# Containment out-of-band for this test (GAFFER_STRICT_REQUIRE=0): the sandbox-refusal path is case A.
OUTC="$(REVIEW_MODE=agent DISPATCH_ALLOW_AGENT_APPROVE=1 AUTO_MERGE=1 MERGE_ON_AGENT_REVIEW=1 GAFFER_STRICT_REQUIRE=0 run_tick)"
grep -q '^TICK_RESULT=reviewed$' <<<"$OUTC" && ok "C: the review pass ran" || fail "C: tick result $OUTC"
[ "$(st "$N")" = "done" ] && ok "C: #$N merged and marked done" || fail "C: #$N is '$(st "$N")' (log: $(grep "AFK: #$N" "$GAFFER_DATA/factory.log" | tail -2 | tr '\n' '|'))"
grep -q "AFK: #$N digest/feature applied post-merge" "$GAFFER_DATA/factory.log" \
  && ok "C: post-merge digest/feature apply ran from the AFK path (B9)" || fail "C: no digest/feature apply log line: $(tail -4 "$GAFFER_DATA/factory.log" | tr '\n' '|')"
grep -q "source: merge:#$N" <<<"$(lg digest repo 2>/dev/null)" \
  && ok "C: Repo Digest freshness stamped source=merge:#$N" || fail "C: digest not stamped: $(lg digest repo 2>/dev/null | grep -i source)"
FEAT_STATUS="$(node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1],{readOnly:true});const r=d.prepare("SELECT status FROM feature WHERE id=?").get(process.argv[2]);process.stdout.write(r?r.status:"missing")' "$MEMORY_DB" "$FEAT_ID" 2>/dev/null)"
[ "$FEAT_STATUS" = "shipped" ] && ok "C: feature $FEAT_ID advanced building → shipped via the ticket's Feature-Id (B11)" || fail "C: feature status '$FEAT_STATUS' (want shipped)"
FEAT_ROWS="$(node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1],{readOnly:true});process.stdout.write(String(d.prepare("SELECT COUNT(*) AS n FROM feature WHERE repo=? AND lower(name)=lower(?)").get("repo","Hold probe").n))' "$MEMORY_DB" 2>/dev/null)"
[ "$FEAT_ROWS" = "1" ] && ok "C: exactly one ledger row for the feature (no duplicate shipped row)" || fail "C: $FEAT_ROWS feature rows named 'Hold probe'"
[ -n "$RBR" ] && ! git -C "$R" show-ref --verify --quiet "refs/heads/$RBR" \
  && ok "C: merged delivery branch $RBR deleted" || fail "C: branch '$RBR' still present: $(git -C "$R" branch --list 'gaffer/*' | tr '\n' ' ')"
[ -f "$WORK/review-mcp.json" ] && [ "$(jget 'd.mcpServers.dispatch.env.GAFFER_REVIEW_TICKET' < "$WORK/review-mcp.json" 2>/dev/null)" = "$N" ] \
  && ok "C: reviewer MCP runtime binds GAFFER_REVIEW_TICKET=$N into the dispatch server (B12)" || fail "C: GAFFER_REVIEW_TICKET missing from the reviewer's MCP runtime: $(cat "$WORK/review-mcp.json" 2>/dev/null | tr -d '\n' | head -c 300)"
grep -q '\${GAFFER_' "$WORK/review-mcp.json" 2>/dev/null && fail "C: reviewer MCP runtime still carries a placeholder" || ok "C: reviewer MCP runtime has no leftover placeholders"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
