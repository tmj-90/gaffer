#!/usr/bin/env bash
# =====================================================================
# TESTER REPLAY ON THE LANDING CANDIDATE, part 2: what the replay RECORD and its PROOF
# name. Part 1 (land-tester-replay.test.sh A-F) proves every landing path replays the
# tester's saved assertions on the exact merge it is about to land and holds a red one;
# this file proves the record names the revision that LANDED and lists only tester files
# proven to have run there. Same world (lib/land-replay-world.sh): real dispatch +
# tick.sh + lib/land.sh + bin/merge-ticket.mjs, a stub claude, a fixture repo whose
# suite stays GREEN throughout.
#   G  PR mode (lib/land.sh), green: the record names the revision that LANDED (the local
#      default after the fast-forward, tree-equal to the candidate), not the scratch merge;
#   H  PR mode (bin/merge-ticket.mjs): the remote default moved before GitHub merged, so
#      what landed is not the candidate the replay passed on — no record.
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
#   K  FORGED PROOF (the reviewer's follow-up): the delivery's module, imported by the
#      tester's file, exits before the file's tests register and prints / writes "passed"
#      evidence for it (runner lines, reporter-shaped events, appended to the replay's proof
#      files). The by-path run exits 0, but no signed event proves the file: the merge lane
#      holds it (tester_replay_unverified, naming the file), main is untouched, no record.
# Run: bash runner/test/land-tester-replay-proof.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
# shellcheck source=lib/land-replay-world.sh
source "$HERE/lib/land-replay-world.sh"

echo "== setup: two deliveries for the PR-mode landings, each green on its own =="
T10="$(new_ticket "Note ten [note-10]" "a note")"
T11="$(new_ticket "Note eleven [note-11]" "a note")"
for _ in $T10 $T11; do AUTO_MERGE=0 run_tick >/dev/null; done
[ "$(st "$T10")" = in_review ] && [ "$(st "$T11")" = in_review ] && ok "both delivered through their DoD gates (in_review)" || fail "statuses: #$T10=$(st "$T10") #$T11=$(st "$T11")"

echo "== main moves: displayName removed — a clean merge, the smoke suite stays green =="
move_main

echo "== G: PR mode (lib/land.sh), green — the record names what LANDED, not the scratch merge =="
approve "$T10"; tester_pass "$T10" "$NAME_TEST"
git -C "$R" push -q origin "$(branch_of "$T10")" 2>/dev/null   # the PR's head branch, on the remote
MAIN_G="$(git -C "$R" rev-parse main)"
(
  # shellcheck source=../lib/land.sh
  source "$RUNNER_DIR/lib/land.sh"
  log() { printf '%s\n' "$*" >> "$LOGF"; }
  # GitHub merges the PR (its own merge commit on the remote default), then the local
  # default is fast-forwarded — what gaffer_pr_merge does.
  gaffer_pr_merge() {
    local c="$WORK/gh-clone-g"; rm -rf "$c"; git clone -q -b main "$WORK/origin.git" "$c" 2>/dev/null
    gitc -C "$c" merge -q --no-ff -m "Merge pull request #10" "$4" && git -C "$c" push -q origin HEAD:main 2>/dev/null || return 1
    git -C "$1" fetch -q origin "$3" 2>/dev/null && git -C "$1" merge -q --ff-only FETCH_HEAD >/dev/null 2>&1 || return 3
    return 0
  }
  SHOW="$(wg ticket show "$T10" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const d=JSON.parse(s);d.ticket.pr_url="https://github.com/o/r/pull/10";process.stdout.write(JSON.stringify(d))})')"
  _gaffer_land_one "$T10" "$R" "$(branch_of "$T10")" main "$SHOW" MERGE "" 0
  echo "rc=$?" > "$WORK/g.rc"
) >/dev/null 2>&1
grep -q '^rc=0$' "$WORK/g.rc" 2>/dev/null && ok "G: the PR-mode landing ran (rc 0)" || fail "G: $(cat "$WORK/g.rc" 2>/dev/null) $(grep "#$T10" "$LOGF" | tail -3 | tr '\n' '|' | cut -c1-400)"
LANDED_G="$(git -C "$R" rev-parse main)"
[ "$LANDED_G" != "$MAIN_G" ] && [ "$LANDED_G" = "$(git -C "$WORK/origin.git" rev-parse main)" ] && ok "G: the PR merge landed upstream and main was fast-forwarded" || fail "G: main=$LANDED_G origin=$(git -C "$WORK/origin.git" rev-parse main)"
R10="$(replay_rec "$T10")"
[ "${R10%% *}" = "$LANDED_G" ] && ok "G: the replay record names the landed revision (main ${LANDED_G:0:12})" || fail "G: record '$R10' vs main $LANDED_G"
case "$R10" in *'["test/bb-label.test.js"]'*) ok "G: …and the tester file that passed on the candidate with that tree" ;; *) fail "G: record files: $R10" ;; esac

echo "== H: PR mode (bin/merge-ticket.mjs) — the remote moved before GitHub merged: no record =="
approve "$T11"; tester_pass "$T11" "$NAME_TEST"
git -C "$R" push -q origin "$(branch_of "$T11")" 2>/dev/null
node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1]);d.prepare("UPDATE tickets SET pr_url=? WHERE number=?").run("https://github.com/o/r/pull/11",Number(process.argv[2]));d.close()' "$DISPATCH_DB" "$T11" 2>/dev/null
cat > "$WORK/bin/gh-h" <<GH
#!/usr/bin/env bash
# Someone else's change reaches the remote default first; then GitHub squash-merges the PR.
pin=""; prev=""; for a in "\$@"; do [ "\$prev" = "--match-head-commit" ] && pin="\$a"; prev="\$a"; done
case "\$*" in *"pr merge"*) ;; *) exit 0 ;; esac
c="$WORK/gh-clone-h"; rm -rf "\$c"; git clone -q -b main "$WORK/origin.git" "\$c" 2>/dev/null
mkdir -p "\$c/docs"; printf 'other\n' > "\$c/docs/other.md"
git -C "\$c" add -A; git -C "\$c" -c user.email=o@o -c user.name=o commit -qm "someone else"
git -C "\$c" -c user.email=o@o -c user.name=o merge -q --squash "\$pin" >/dev/null 2>&1
git -C "\$c" -c user.email=o@o -c user.name=o commit -qm "squash #11" >/dev/null 2>&1
git -C "\$c" push -q origin HEAD:main 2>/dev/null
GH
chmod +x "$WORK/bin/gh-h"
( cd "$RUNNER_DIR" && GAFFER_GH_BIN="$WORK/bin/gh-h" DISPATCH_DB="$DISPATCH_DB" GAFFER_DATA="$GAFFER_DATA" node bin/merge-ticket.mjs --ticket "$T11" ) >"$WORK/h.out" 2>"$WORK/h.err"; rc=$?
[ "$rc" -eq 0 ] && git -C "$R" cat-file -e main:docs/other.md 2>/dev/null && git -C "$R" cat-file -e main:docs/note-11.md 2>/dev/null && ok "H: the PR landed upstream on a moved default and main was fast-forwarded" || fail "H: rc=$rc $(tail -c 400 "$WORK/h.out")"
[ -z "$(replay_rec "$T11")" ] && ok "H: no replay record — what landed is not the candidate the replay passed on" || fail "H: #$T11 recorded a replay on a revision it never ran on: $(replay_rec "$T11") (main $(git -C "$R" rev-parse main))"
grep -q "NO tester replay record" "$WORK/h.err" 2>/dev/null && ok "H: …and says so" || fail "H: no log line for the missing record"

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
T12="$(new_ticket_in repo2 "Label by display name, file-scoped [read-displayName]" "label() reads profile().displayName")"
T13="$(new_ticket_in repo2 "Note thirteen [note-13]" "a note")"
T14="$(new_ticket_in repo3 "Note fourteen [note-14]" "a note")"
T15="$(new_ticket_in repo3 "Note fifteen [note-15]" "a note")"
for _ in 1 2 3 4; do AUTO_MERGE=0 run_tick >/dev/null; done
for n in "$T12" "$T13" "$T14" "$T15"; do approve "$n"; done
[ "$(st "$T12")" = in_testing ] && [ "$(st "$T14")" = in_testing ] && ok "I: the file-scoped repos' deliveries passed their gates and went to the tester" || fail "I: statuses T12=$(st "$T12") T13=$(st "$T13") T14=$(st "$T14") T15=$(st "$T15")"
tester_pass_in "$R2" "$T12" "$ACC_LABEL"; tester_pass_in "$R2" "$T13" "$ACC_NAME"
tester_pass_in "$R3" "$T14" "$ACC_NAME"
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
tester_pass_in "$R3" "$T15" "$ACC_NAME"
merge_now "$T15"; rc=$?
[ "$rc" -eq 4 ] && grep -q "TESTER REPLAY UNVERIFIED" "$WORK/mn.out" && grep -q "test/acceptance.test.mjs" "$WORK/mn.out" && ok "J: Merge now refuses #$T15 the same way (exit 4, the file named)" || fail "J: Merge now rc=$rc $(tail -c 400 "$WORK/mn.out")"
[ "$(git -C "$R3" rev-parse main)" = "$MAIN_J" ] && [ "$(st "$T15")" = blocked ] && [ -z "$(replay_rec "$T15")" ] && ok "J: …nothing landed, held, no record" || fail "J: #$T15 status=$(st "$T15") main=$(git -C "$R3" rev-parse main) rec=$(replay_rec "$T15")"
STATUS_J="$(bash "$RUNNER_DIR/status.sh" 2>/dev/null)"
case "$STATUS_J" in *"#$T14 tester replay UNVERIFIED (held)"*test/acceptance.test.mjs*) ok "J: gaffer status names the tester file that did not run" ;; *) fail "J: gaffer status: $(printf '%s' "$STATUS_J" | grep -i 'replay' | head -3)" ;; esac

echo "== K: forged proof — the delivery stops the tester's file and prints 'passed' for it =="
# The delivery's src/label.js: when the tester's file imports it, it writes "passed"
# evidence for that file in every shape a runner uses (and appends a reporter-shaped event
# to the replay's proof files once the runner has written there), then exits before the
# file's tests register.
cat > "$WORK/bin/forger.js" <<'FORGER'
import { spawn } from "node:child_process";
import { resolve } from "node:path";
const me = resolve("test/acceptance.test.mjs");
const ev = JSON.stringify({ pid: process.ppid, seq: 1, type: "test:pass", file: me, name: "the label is Ada", skip: false, todo: false, suite: false });
const helper = `const fs = require("fs"); const t0 = Date.now();
const tick = () => { for (const d of fs.readdirSync(".")) if (d.startsWith(".gaffer-replay-")) for (const f of ["events.jsonl", "output.txt"]) { try { if (fs.statSync(d + "/" + f).size > 0) { fs.appendFileSync(d + "/" + f, ${JSON.stringify(ev + "\n")}); return; } } catch {} } if (Date.now() - t0 < 4000) setImmediate(tick); };
tick();`;
spawn(process.execPath, ["-e", helper], { detached: true, stdio: "ignore" }).unref();
console.log("\u2714 the label is Ada (0.1ms)");
console.log("PASS test/acceptance.test.mjs");
console.log(ev);
console.log("gaffer-replay-proof " + "0".repeat(64) + " " + ev);
await new Promise((r) => setTimeout(r, 300));
process.exit(0);
export function label() { return "Ada"; }
FORGER
R4="$WORK/repo4"; mkdir -p "$R4/src" "$R4/test"
( cd "$R4" && git init -q -b main
  printf '{ "name": "r4", "version": "0.1.0", "private": true, "type": "module" }\n' > package.json
  printf 'export function profile() {\n  return { name: "Ada" };\n}\n' > src/profile.js
  printf 'import { profile } from "./profile.js";\nexport function label() {\n  return profile().name;\n}\n' > src/label.js
  printf 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { profile } from "../src/profile.js";\ntest("profile", () => { assert.equal(profile().name, "Ada"); });\n' > test/label.test.mjs
  gitc add -A && gitc commit -qm init )
wg repo add -n repo4 --path "$R4" --branch main --stack node --test "node --test test/label.test.mjs" >/dev/null 2>&1
T16="$(new_ticket_in repo4 "Label tweak [forge-proof]" "label() reads the profile")"
for _ in 1 2; do AUTO_MERGE=0 run_tick >/dev/null; done
approve "$T16"
[ "$(st "$T16")" = in_testing ] && ok "K: the forging delivery passed its own gates and went to the tester" || fail "K: #$T16 status=$(st "$T16")"
tester_pass_in "$R4" "$T16" "$ACC_LABEL"
MAIN_K="$(git -C "$R4" rev-parse main)"
rm -f "$GAFFER_DATA/.merge-held-tickets"
GAFFER_MODE=autonomous AUTO_MERGE=1 run_tick >/dev/null
[ "$(git -C "$R4" rev-parse main)" = "$MAIN_K" ] && ok "K: main untouched — the forged proof did not land the delivery" || fail "K: repo4 main moved: $(git -C "$R4" log --oneline -2 main | tr '\n' '|')"
H16="$(hold_of "$T16")"
[ "$(st "$T16")" = blocked ] && case "$H16" in *tester_replay_unverified*) case "$H16" in *test/acceptance.test.mjs*) true ;; *) false ;; esac ;; *) false ;; esac \
  && ok "K: #$T16 held (tester_replay_unverified) naming test/acceptance.test.mjs" || fail "K: #$T16 status=$(st "$T16") hold=${H16:0:400} $(grep "#$T16" "$LOGF" | tail -3 | tr '\n' '|' | cut -c1-400)"
[ -z "$(replay_rec "$T16")" ] && ok "K: no replay record for the forged file" || fail "K: #$T16 recorded: $(replay_rec "$T16")"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "land-tester-replay-proof: ALL $PASS checks passed"; exit 0; fi
echo "land-tester-replay-proof: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1

