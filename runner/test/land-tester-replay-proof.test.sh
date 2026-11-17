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
#   (I-J, a file-scoped registered command and one gaffer knows no file-scoped
#   invocation for: land-tester-replay-scoped.test.sh, on its own copy of the world)
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
NT=($(new_tickets "Note ten [note-10]${TAB}a note" "Note eleven [note-11]${TAB}a note"))
T10="${NT[0]:-}" T11="${NT[1]:-}"
for _ in $T10 $T11; do AUTO_MERGE=0 run_tick >/dev/null; done
[ "$(st "$T10")" = in_testing ] && [ "$(st "$T11")" = in_testing ] && ok "both delivered through their DoD gates and sent to the tester before review" || fail "statuses: #$T10=$(st "$T10") #$T11=$(st "$T11")"

echo "== main moves: displayName removed — a clean merge, the smoke suite stays green =="
move_main

echo "== G: PR mode (lib/land.sh), green — the record names what LANDED, not the scratch merge =="
tester_pass "$T10" "$NAME_TEST"; approve "$T10"
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
tester_pass "$T11" "$NAME_TEST"; approve "$T11"
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
[ "$(st "$T16")" = in_testing ] && ok "K: the forging delivery passed its own gates and went to the tester" || fail "K: #$T16 status=$(st "$T16")"
tester_pass_in "$R4" "$T16" "$ACC_LABEL"
approve "$T16"
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

