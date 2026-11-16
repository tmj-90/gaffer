#!/usr/bin/env bash
# =====================================================================
# TESTER REPLAY ON THE LANDING CANDIDATE, the other landing paths (the second part of
# land-tester-replay.test.sh; the same world, lib/land-replay-world.sh: real dispatch +
# lib/land.sh + bin/merge-ticket.mjs, a stub claude, a fixture repo whose suite stays
# GREEN throughout, so only the tester's saved assertion catches the break):
#   B  the dashboard's Merge now (bin/merge-ticket.mjs) holds like the merge lane (exit 4),
#      and lands once the tester's assertion passes, recording the landed revision;
#   C  PR mode (lib/land.sh): the gate on the FETCHED remote default replays the tester's
#      tests; a red replay never asks GitHub to merge;
#   D  PR mode (bin/merge-ticket.mjs): the same, with a gh stub that would merge.
# Run: bash runner/test/land-tester-replay-merge-now.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
# shellcheck source=lib/land-replay-world.sh
source "$HERE/lib/land-replay-world.sh"

echo "== setup: four deliveries, each green on its own =="
NT=($(new_tickets \
  "Label by display name again [read-displayName]${TAB}label() reads profile().displayName" \
  "Label by display name, PR [read-displayName]${TAB}label() reads profile().displayName" \
  "Label by display name, PR now [read-displayName]${TAB}label() reads profile().displayName" \
  "Note eight [note-8]${TAB}a note"))
T2="${NT[0]:-}" T3="${NT[1]:-}" T4="${NT[2]:-}" T8="${NT[3]:-}"
ALL_T="$T2 $T3 $T4 $T8"
for _ in $ALL_T; do AUTO_MERGE=0 run_tick >/dev/null; done
# TESTER FIRST: a testable delivery goes to the tester before review.
all_lane=1; for n in $ALL_T; do [ "$(st "$n")" = in_testing ] || all_lane=0; done
[ "$all_lane" = 1 ] && ok "all four delivered through their DoD gates and sent to the tester" || fail "statuses: $(for n in $ALL_T; do printf '#%s=%s ' "$n" "$(st "$n")"; done)"
main_tests "$(branch_of "$T2")" && ok "the delivery branch passes the smoke suite" || fail "fixture: T2 branch red"

echo "== main moves: displayName removed — a clean merge, the smoke suite stays green =="
move_main

MAIN1="$(git -C "$R" rev-parse main)"; TREE1="$(tree_of main)"

echo "== B: Merge now (bin/merge-ticket.mjs) replays and holds the same way =="
tester_pass "$T2" "$LABEL_TEST"; approve "$T2"
merge_now "$T2"; rc=$?
[ "$rc" -eq 4 ] && ok "B: Merge now refuses #$T2 (exit 4)" || fail "B: rc=$rc $(tail -c 400 "$WORK/mn.out")"
grep -q "TESTER REPLAY FAILED" "$WORK/mn.out" && grep -q "test/bb-label.test.js" "$WORK/mn.out" && ok "B: …saying the tester's replay failed, naming the file" || fail "B: output: $(tail -c 400 "$WORK/mn.out")"
[ "$(git -C "$R" rev-parse main)" = "$MAIN1" ] && [ "$(tree_of main)" = "$TREE1" ] && ok "B: main untouched (head and tree)" || fail "B: main moved"
[ "$(st "$T2")" = "blocked" ] && case "$(hold_of "$T2")" in *tester_replay_red*) true ;; *) false ;; esac && ok "B: #$T2 held (blocked, tester_replay_red)" || fail "B: #$T2 status=$(st "$T2") hold=$(hold_of "$T2" | cut -c1-200)"
[ -z "$(replay_rec "$T2")" ] && ok "B: a held replay records nothing" || fail "B: #$T2 has a replay record"
tester_pass "$T8" "$NAME_TEST"; approve "$T8"
merge_now "$T8"; rc=$?
[ "$rc" -eq 0 ] && [ "$(st "$T8")" = "done" ] && ok "B: Merge now lands #$T8 once the tester's assertion passes on the candidate" || fail "B: #$T8 rc=$rc status=$(st "$T8") $(tail -c 300 "$WORK/mn.out")"
R8="$(replay_rec "$T8")"; S8="${R8%% *}"
[ -n "$S8" ] && [ "$S8" = "$(git -C "$R" rev-parse main)" ] && case "$R8" in *'["test/bb-label.test.js"]'*) true ;; *) false ;; esac \
  && ok "B: Merge now's replay record names the landed revision (main) and the tester's file" || fail "B: #$T8 record: '$R8' main=$(git -C "$R" rev-parse main)"
MAIN1="$(git -C "$R" rev-parse main)"; TREE1="$(tree_of main)"; git -C "$R" push -q origin main 2>/dev/null

echo "== C: PR mode (lib/land.sh) gates the fetched remote default and never asks GitHub =="
tester_pass "$T3" "$LABEL_TEST"; approve "$T3"
(
  # shellcheck source=../lib/land.sh
  source "$RUNNER_DIR/lib/land.sh"
  log() { printf '%s\n' "$*" >> "$LOGF"; }
  gaffer_pr_merge() { printf 'pr_merge %s\n' "$*" >> "$WORK/pr-calls"; return 0; }
  SHOW="$(wg ticket show "$T3" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const d=JSON.parse(s);d.ticket.pr_url="https://github.com/o/r/pull/3";process.stdout.write(JSON.stringify(d))})')"
  _gaffer_land_one "$T3" "$R" "$(branch_of "$T3")" main "$SHOW" MERGE "" 0
  echo "rc=$?" > "$WORK/c.rc"
) >/dev/null 2>&1
grep -q '^rc=4$' "$WORK/c.rc" 2>/dev/null && ok "C: PR-mode landing held (rc 4)" || fail "C: $(cat "$WORK/c.rc" 2>/dev/null)"
[ -s "$WORK/pr-calls" ] && fail "C: gh pr merge was asked to merge a red replay" || ok "C: the PR merge was never asked for"
grep -q "MERGE: #$T3 TESTER REPLAY — running the tester's 1 test file(s)" "$LOGF" && ok "C: the replay ran on the PR-mode candidate" || fail "C: no PR-mode replay line"
[ "$(git -C "$WORK/origin.git" rev-parse main)" = "$MAIN1" ] && [ "$(git -C "$R" rev-parse main)" = "$MAIN1" ] && ok "C: the remote and local default untouched" || fail "C: a default branch moved"
[ "$(st "$T3")" = "blocked" ] && ok "C: #$T3 held (blocked)" || fail "C: #$T3 status=$(st "$T3")"

echo "== D: PR mode (bin/merge-ticket.mjs) — the same, with a gh that would merge =="
tester_pass "$T4" "$LABEL_TEST"; approve "$T4"
node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1]);d.prepare("UPDATE tickets SET pr_url=? WHERE number=?").run("https://github.com/o/r/pull/4",Number(process.argv[2]));d.close()' "$DISPATCH_DB" "$T4" 2>/dev/null
cat > "$WORK/bin/gh" <<GH
#!/usr/bin/env bash
printf 'gh %s\n' "\$*" >> "$WORK/gh-calls"
exit 0
GH
chmod +x "$WORK/bin/gh"
( cd "$RUNNER_DIR" && GAFFER_GH_BIN="$WORK/bin/gh" DISPATCH_DB="$DISPATCH_DB" GAFFER_DATA="$GAFFER_DATA" node bin/merge-ticket.mjs --ticket "$T4" ) >"$WORK/d.out" 2>"$WORK/d.err"; rc=$?
[ "$rc" -eq 4 ] && grep -q "TESTER REPLAY FAILED" "$WORK/d.out" && ok "D: PR-mode Merge now refuses (exit 4, tester replay failed)" || fail "D: rc=$rc $(tail -c 400 "$WORK/d.out")"
grep -q "pr merge" "$WORK/gh-calls" 2>/dev/null && fail "D: gh pr merge ran on a red replay" || ok "D: gh pr merge never ran"
[ "$(git -C "$R" rev-parse main)" = "$MAIN1" ] && ok "D: main untouched" || fail "D: main moved"
[ "$(st "$T4")" = "blocked" ] && ok "D: #$T4 held (blocked)" || fail "D: #$T4 status=$(st "$T4")"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "land-tester-replay-merge-now: ALL $PASS checks passed"; exit 0; fi
echo "land-tester-replay-merge-now: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1

