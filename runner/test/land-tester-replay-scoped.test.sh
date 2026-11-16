#!/usr/bin/env bash
# =====================================================================
# TESTER REPLAY ON THE LANDING CANDIDATE, part 3: the tester's file runs BY PATH, whatever
# the repository registered as its test command (land-tester-replay-proof.test.sh holds
# G, H and K; the same world, lib/land-replay-world.sh: real dispatch + tick.sh +
# lib/land.sh + bin/merge-ticket.mjs, a stub claude):
#   I  external review #7, the reviewer's steps: the registered command is FILE-SCOPED
#      (`node --test test/label.test.mjs`) and never runs the tester's
#      test/acceptance.test.mjs. The replay used to run that command, pass, land the broken
#      combination and record the unrun file as passed. Now the tester's file runs BY PATH
#      (node:test) on the candidate: it fails there, the landing is held (tester_replay_red,
#      the file named), main is untouched and nothing is recorded; a passing tester file in
#      the same repo runs by path, lands and is recorded.
#   J  a registered command gaffer has no file-scoped invocation for (`sh scripts/test.sh`,
#      which runs one file): the tester's file shows no evidence it ran, so the merge lane
#      and Merge now hold it (tester_replay_unverified, naming the file), nothing lands, no
#      record, and `gaffer status` names the file that did not run.
# Run: bash runner/test/land-tester-replay-scoped.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
# shellcheck source=lib/land-replay-world.sh
source "$HERE/lib/land-replay-world.sh"

echo "== I: a FILE-SCOPED registered command (the reviewer's steps) =="
# repo2: the registered command runs ONE file (test/label.test.mjs), which stays green.
R2="$WORK/repo2"; mkdir -p "$R2/src" "$R2/test"
( cd "$R2" && git init -q -b main
  printf '{ "name": "r2", "version": "0.1.0", "private": true, "type": "module" }\n' > package.json
  printf 'export function profile() {\n  return { name: "Ada", displayName: "Ada" };\n}\n' > src/profile.js
  printf 'import { profile } from "./profile.js";\nexport function label() {\n  return profile().name;\n}\n' > src/label.js
  printf 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { label } from "../src/label.js";\ntest("label is a function", () => { assert.equal(typeof label, "function"); });\n' > test/label.test.mjs
  gitc add -A && gitc commit -qm init )
wg repo add -n repo2 --path "$R2" --branch main --stack node --test "node --test test/label.test.mjs" >/dev/null 2>&1
# repo3: a registered command gaffer knows no file-scoped invocation for.
R3="$WORK/repo3"; mkdir -p "$R3/src" "$R3/test" "$R3/scripts"
( cd "$R3" && git init -q -b main
  printf '{ "name": "r3", "version": "0.1.0", "private": true, "type": "module" }\n' > package.json
  printf 'export function profile() {\n  return { name: "Ada" };\n}\n' > src/profile.js
  printf 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { profile } from "../src/profile.js";\ntest("profile", () => { assert.equal(profile().name, "Ada"); });\n' > test/label.test.mjs
  printf 'node --test test/label.test.mjs\n' > scripts/test.sh
  gitc add -A && gitc commit -qm init )
wg repo add -n repo3 --path "$R3" --branch main --stack node --test "sh scripts/test.sh" >/dev/null 2>&1
NT=($(new_tickets -r repo2 "Label by display name, file-scoped [read-displayName]${TAB}label() reads profile().displayName" "Note thirteen [note-13]${TAB}a note"))
T12="${NT[0]:-}" T13="${NT[1]:-}"
NT=($(new_tickets -r repo3 "Note fourteen [note-14]${TAB}a note" "Note fifteen [note-15]${TAB}a note"))
T14="${NT[0]:-}" T15="${NT[1]:-}"
for _ in 1 2 3 4; do AUTO_MERGE=0 run_tick >/dev/null; done
[ "$(st "$T12")" = in_testing ] && [ "$(st "$T14")" = in_testing ] && ok "I: the file-scoped repos' deliveries passed their gates and went to the tester" || fail "I: statuses T12=$(st "$T12") T13=$(st "$T13") T14=$(st "$T14") T15=$(st "$T15")"
tester_pass_in "$R2" "$T12" "$ACC_LABEL"; tester_pass_in "$R2" "$T13" "$ACC_NAME"
tester_pass_in "$R3" "$T14" "$ACC_NAME"
for n in "$T12" "$T13" "$T14"; do approve "$n"; done
# main moves in repo2: displayName removed; the registered (file-scoped) suite stays green.
sed -i.bak 's/, displayName: "Ada"//' "$R2/src/profile.js" && rm -f "$R2/src/profile.js.bak"
gitc -C "$R2" commit -qam "refactor: drop the unused displayName"
MAIN_J="$(git -C "$R3" rev-parse main)"
rf_I="$WORK/i-check"; git -C "$R2" worktree add -q --detach "$rf_I" main >/dev/null 2>&1
gitc -C "$rf_I" merge -q --no-edit "$(git -C "$R2" rev-parse "refs/heads/$(branch_of "$T12")")" >/dev/null 2>&1
( cd "$rf_I" && node --test test/label.test.mjs >/dev/null 2>&1 ) && ok "I: the registered file-scoped command passes on the merge candidate" || fail "I: fixture: the registered command is red on the candidate"
git -C "$rf_I" checkout -q "gaffer-tests/ticket-$T12" -- test/acceptance.test.mjs
( cd "$rf_I" && node --test test/acceptance.test.mjs >/dev/null 2>&1 ) && fail "I: fixture: the tester's file passes on the candidate" || ok "I: the tester's test/acceptance.test.mjs FAILS on the candidate (undefined !== 'Ada')"
git -C "$R2" worktree remove --force "$rf_I" >/dev/null 2>&1
B12="$(git -C "$R2" rev-parse "refs/heads/$(branch_of "$T12")")"
rm -f "$GAFFER_DATA/.merge-held-tickets"
GAFFER_MODE=autonomous AUTO_MERGE=1 run_tick >/dev/null
if git -C "$R2" merge-base --is-ancestor "$B12" main; then fail "I: main contains #$T12 — the broken combination landed"; else ok "I: main does not contain #$T12 — the broken combination did not land"; fi
grep -q 'profile().name;' <<<"$(git -C "$R2" show main:src/label.js 2>/dev/null)" && ok "I: main's label still reads name" || fail "I: main's label changed"
H12="$(hold_of "$T12")"
[ "$(st "$T12")" = blocked ] && case "$H12" in *tester_replay_red*) case "$H12" in *test/acceptance.test.mjs*) true ;; *) false ;; esac ;; *) false ;; esac \
  && ok "I: #$T12 held (tester_replay_red) naming test/acceptance.test.mjs" || fail "I: #$T12 status=$(st "$T12") hold=${H12:0:300}"
grep -q "MERGE: #$T12 TESTER REPLAY — running the tester's 1 test file(s) (test/acceptance.test.mjs) on the merge candidate .* (node-test, by path)" "$LOGF" && ok "I: the tester's file ran BY PATH (node:test), not through the file-scoped command" || fail "I: no by-path replay line for #$T12"
[ -z "$(replay_rec "$T12")" ] && ok "I: no replay record names the file (it failed where it ran)" || fail "I: #$T12 recorded a replay: $(replay_rec "$T12")"
[ "$(st "$T13")" = "done" ] && ok "I: the file-scoped happy path: the tester's passing file runs by path and #$T13 lands" || fail "I: #$T13 status=$(st "$T13") $(grep "#$T13" "$LOGF" | tail -2 | tr '\n' '|' | cut -c1-300)"
R13="$(replay_rec "$T13")"
[ "${R13%% *}" = "$(git -C "$R2" rev-parse main)" ] && case "$R13" in *'["test/acceptance.test.mjs"]'*) true ;; *) false ;; esac \
  && ok "I: …recorded on the landed revision with the file that ran: $R13" || fail "I: #$T13 record '$R13' main=$(git -C "$R2" rev-parse main)"

echo "== J: no file-scoped invocation known — a tester file with no proof it ran holds =="
[ "$(git -C "$R3" rev-parse main)" = "$MAIN_J" ] && ok "J: repo3's main untouched by the merge lane" || fail "J: repo3 main moved: $(git -C "$R3" log --oneline -2 main | tr '\n' '|')"
H14="$(hold_of "$T14")"
[ "$(st "$T14")" = blocked ] && case "$H14" in *tester_replay_unverified*) case "$H14" in *test/acceptance.test.mjs*) true ;; *) false ;; esac ;; *) false ;; esac \
  && ok "J: the merge lane held #$T14 (tester_replay_unverified) naming test/acceptance.test.mjs" || fail "J: #$T14 status=$(st "$T14") hold=${H14:0:300} $(grep "#$T14" "$LOGF" | tail -2 | tr '\n' '|' | cut -c1-300)"
[ -z "$(replay_rec "$T14")" ] && ok "J: no replay record for the unverified file" || fail "J: #$T14 recorded: $(replay_rec "$T14")"
EV14="$(wg ticket show "$T14" | jget '(d.evidence || []).filter(e => (e.summary || "").startsWith("TESTER REPLAY UNVERIFIED")).map(e => e.summary).join("\n")' 2>/dev/null)"
case "$EV14" in *"TESTER REPLAY UNVERIFIED"*test/acceptance.test.mjs*) ok "J: the ticket page's evidence says which file did not run" ;; *) fail "J: evidence: ${EV14:0:300}" ;; esac
tester_pass_in "$R3" "$T15" "$ACC_NAME"; approve "$T15"
merge_now "$T15"; rc=$?
[ "$rc" -eq 4 ] && grep -q "TESTER REPLAY UNVERIFIED" "$WORK/mn.out" && grep -q "test/acceptance.test.mjs" "$WORK/mn.out" && ok "J: Merge now refuses #$T15 the same way (exit 4, the file named)" || fail "J: Merge now rc=$rc $(tail -c 400 "$WORK/mn.out")"
[ "$(git -C "$R3" rev-parse main)" = "$MAIN_J" ] && [ "$(st "$T15")" = blocked ] && [ -z "$(replay_rec "$T15")" ] && ok "J: …nothing landed, held, no record" || fail "J: #$T15 status=$(st "$T15") main=$(git -C "$R3" rev-parse main) rec=$(replay_rec "$T15")"
STATUS_J="$(bash "$RUNNER_DIR/status.sh" 2>/dev/null)"
case "$STATUS_J" in *"#$T14 tester replay UNVERIFIED (held)"*test/acceptance.test.mjs*) ok "J: gaffer status names the tester file that did not run" ;; *) fail "J: gaffer status: $(printf '%s' "$STATUS_J" | grep -i 'replay' | head -3)" ;; esac

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "land-tester-replay-scoped: ALL $PASS checks passed"; exit 0; fi
echo "land-tester-replay-scoped: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1

