#!/usr/bin/env bash
# =====================================================================
# TESTER REPLAY ON THE LANDING CANDIDATE, part 3: the registered test command is an
# EXECUTION CONTRACT and the tester's PASS binds TEST IDENTITIES (external review 10).
# Both landing gates (lib/land.sh _gaffer_merge_gate and bin/merge-ticket.mjs
# gateProposedMerge) on a real scratch merge, a real dispatch DB and real runners:
#   L1 THE COMBINED COUNTEREXAMPLE, node:test: the registered command
#      (`PROFILE_API_V2=1 node --test test/smoke.test.mjs`) sets the env that enables the
#      tester's substantive assertion; a smoke test sits in the same tester file. main
#      moves so that assertion fails on the merge, while the repo's own suite stays green.
#      The replay used to rebuild `node --test <file>` without the env: the assertion
#      skipped, the smoke passed, the file counted as replayed and the landing would have
#      recorded a green. Now the env reaches the replay: the assertion runs and fails, and
#      both gates HOLD (tester_replay_red), for a PASS with identities and an older one;
#   L2 the same with vitest, where the registered config file (`--config`) enables it;
#   L3 green: on a main that keeps the assertion passing, the gates pass and the record
#      carries the identities proven (files kept for the existing readers);
#   L4 a bound identity the candidate skips holds (tester_replay_unverified, named);
#   L5 a package script (`npm test`) runs as the gated base has it, with the worktree's
#      node_modules/.bin on PATH as the package manager would put it (vitest is not on
#      the runner's own PATH), its config included: green with the identities proven.
# Run: bash runner/test/land-tester-replay-contract.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
[ -f "$ROOT/packages/dispatch/dist/cli/index.js" ] || { echo "SKIP: dispatch CLI not built"; exit 0; }
[ -f "$ROOT/packages/crew/dist/runtime/context/renderPromptCli.js" ] || { echo "SKIP: crew not built"; exit 0; }
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/land-replay-contract.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
[ "${KEEP:-0}" = 1 ] || trap 'gaffer_test_rm_work "$WORK"' EXIT
mkdir -p "$WORK/data"
gitc() { git -c user.email=t@t -c user.name=t "$@"; }
export GAFFER_DATA="$WORK/data" REVIEW_MODE=human DRY_RUN=0 GAFFER_MAINTENANCE=0 GAFFER_STRICT_REQUIRE=0 GAFFER_DIGEST_DISABLE=1 GAFFER_AUTO_PUSH=0
unset GAFFER_DOD_TYPECHECK_CMD GAFFER_TESTER_REPLAY DISPATCH_DB
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
# shellcheck source=../lib/land.sh
source "$RUNNER_DIR/lib/land.sh"
LOGF="$GAFFER_DATA/factory.log"
log() { printf '%s\n' "$*" >> "$LOGF"; }
wg init >/dev/null 2>&1

# A fixture repo: <name> <test script> — src/profile.js names "Ada"; the registered smoke
# suite only checks the module loads (green at every step).
make_repo() {
  local name="$1" script="$2" r="$WORK/$1"
  mkdir -p "$r/src" "$r/test"
  ( cd "$r" && git init -q -b main
    printf '{ "name": "%s", "private": true, "type": "module", "scripts": { "test": "%s" } }\n' "$name" "$script" > package.json
    printf 'export function profile() {\n  return { name: "Ada" };\n}\n' > src/profile.js
    gitc add -A && gitc commit -qm init ) >/dev/null 2>&1
  wg repo add -n "$name" --path "$r" --branch main --stack node --test "npm test" >/dev/null 2>&1
  printf '%s' "$r"
}
# A delivery (a note) on gaffer/ticket-<n>, a ticket for it, and the tester's tests on
# gaffer-tests/ticket-<n> off the delivery head, with a PASS bound to both. With a
# fourth argument the PASS carries those identities (JSON), as the runner's tester lane
# records them; without it it is an older PASS (file-level evidence).
#   deliver <repo-name> <repo-path> <tester file body> [tests-json] → ticket number
deliver() {
  local name="$1" r="$2" body="$3" tests="${4:-}" n head tc wt
  n="$(wg ticket create -t "note for $name" -d "a note" --risk low 2>/dev/null | jget 'd.ticket.number')"
  wg ticket repo-access set "$n" "$name" --access write --relation confirmed >/dev/null 2>&1
  gitc -C "$r" checkout -q -b "gaffer/ticket-$n" main
  mkdir -p "$r/docs"; printf 'note %s\n' "$n" > "$r/docs/note-$n.md"
  gitc -C "$r" add -A; gitc -C "$r" commit -qm "feat: note $n"
  head="$(git -C "$r" rev-parse HEAD)"; gitc -C "$r" checkout -q main
  wt="$WORK/tester-$n"; git -C "$r" worktree add -q --detach "$wt" "$head" >/dev/null 2>&1
  printf '%s\n' "$body" > "$wt/test/acceptance.test.mjs"
  gitc -C "$wt" checkout -q -B "gaffer-tests/ticket-$n"; gitc -C "$wt" add -A; gitc -C "$wt" commit -qm "black-box tests for #$n"
  tc="$(git -C "$wt" rev-parse HEAD)"; git -C "$r" worktree remove --force "$wt" >/dev/null 2>&1
  # The tester's PASS as dispatch's tester-pass path records it: the evidence row and the
  # ticket.tester_passed event naming it (the only shape the replay reads as a PASS).
  node --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    const [db, num, tested, tc, tests] = process.argv.slice(1);
    const d = new DatabaseSync(db);
    const t = d.prepare("SELECT id FROM tickets WHERE number = ?").get(Number(num));
    const id = "ev-" + num;
    const p = { verdict: "pass", provenance: tests ? "system" : "agent", tested_commit: tested, replay: "passed", tests_commit: tc };
    if (tests) p.tests = JSON.parse(tests);
    d.prepare("INSERT INTO evidence (id, ticket_id, evidence_type, summary, payload_json, created_by, recorded_by_actor_type) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, t.id, "test_output", "black-box tests pass", JSON.stringify(p), "tester", tests ? "system" : "agent");
    d.prepare("INSERT INTO work_events (id, entity_type, entity_id, actor_type, event_type, payload_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run("we-" + num, "ticket", t.id, "agent", "ticket.tester_passed", JSON.stringify({ evidence_id: id, tested_head: tested }));
    d.close();' "$DISPATCH_DB" "$n" "$head" "$tc" "$tests"
  printf '%s' "$n"
}
# Gate the merge of the ticket's delivery onto main with lib/land.sh; prints
# "rc kind record files tests" (one line).
land_gate() {
  local n="$1" r="$2" show pin
  show="$(wg ticket show "$n" 2>/dev/null)"
  pin="$(git -C "$r" rev-parse "refs/heads/gaffer/ticket-$n")"
  _gaffer_merge_gate "$n" "$r" "gaffer/ticket-$n" main "$pin" "$show" "refs/heads/main" MERGE "" 0 >/dev/null 2>&1
  local rc=$?
  printf '%s\n' "${_MG_REASON:-}" > "$WORK/mg.reason"
  printf '%s %s %s %s %s\n' "$rc" "${_MG_KIND:--}" "${_MG_REPLAY_RECORD:-0}" "${_MG_REPLAY_FILES:-[]}" "${_MG_REPLAY_TESTS:-[]}"
}
# The same through bin/merge-ticket.mjs gateProposedMerge; prints "kind code record files tests".
mt_gate() {
  local n="$1" r="$2" name="$3" pin
  pin="$(git -C "$r" rev-parse "refs/heads/gaffer/ticket-$n")"
  ( cd "$RUNNER_DIR" && DISPATCH_DB="$DISPATCH_DB" GAFFER_DATA="$GAFFER_DATA" node --input-type=module -e '
    const [n, r, name, pin, db, dir] = process.argv.slice(1);
    const m = await import(process.cwd() + "/bin/merge-ticket.mjs");
    const g = m.gateProposedMerge({ repoPath: r, branch: "gaffer/ticket-" + n, pin, targetRef: "refs/heads/main",
      label: name, commands: { test: "npm test", lint: "", allow: false }, gateDir: dir,
      testerReplay: { dbPath: db, ticketNumber: Number(n) } });
    const rp = g.replay || {};
    console.log([g.kind, g.code || "-", rp.record ? 1 : 0, JSON.stringify(rp.files || []), JSON.stringify(rp.tests || [])].join(" "));
    if (process.env.MT_DEBUG) console.error(g.reason, g.evidence);
  ' "$n" "$r" "$name" "$pin" "$DISPATCH_DB" "$GAFFER_DATA/worktrees" ) 2>>"$WORK/mt.err"
}

ACC_NODE='import test from "node:test";
import assert from "node:assert/strict";
import { profile } from "../src/profile.js";
test("the module loads", () => { assert.equal(typeof profile, "function"); });
test("the v2 profile is named Ada", { skip: !process.env.PROFILE_API_V2 }, () => { assert.equal(profile().name, "Ada"); });'
IDS_NODE='[{"file":"test/acceptance.test.mjs","name":"the module loads"},{"file":"test/acceptance.test.mjs","name":"the v2 profile is named Ada"}]'

echo "== L1: the combined counterexample, node:test (the registered env enables the assertion) =="
RN="$(make_repo nrepo "PROFILE_API_V2=1 node --test test/smoke.test.mjs")"
printf 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { profile } from "../src/profile.js";\ntest("smoke", () => { assert.equal(typeof profile, "function"); });\n' > "$RN/test/smoke.test.mjs"
gitc -C "$RN" add -A; gitc -C "$RN" commit -qm "smoke suite"
N1="$(deliver nrepo "$RN" "$ACC_NODE" "$IDS_NODE")"
N2="$(deliver nrepo "$RN" "$ACC_NODE")"
N3="$(deliver nrepo "$RN" "$ACC_NODE" "$IDS_NODE")"
# Green on the tested commits: L3 lands N3 before main moves.
L3="$(land_gate "$N3" "$RN")"
case "$L3" in "0 - 1 "*'"the v2 profile is named Ada"'*) ok "L3: green before main moves: the gate passes and the record carries the identities ($L3)" ;; *) fail "L3: $L3 $(tail -3 "$LOGF" | tr '\n' '|' | cut -c1-400)" ;; esac
case "$L3" in *'["test/acceptance.test.mjs"]'*) ok "L3: …and still the file list the existing readers use" ;; *) fail "L3 files: $L3" ;; esac
M3="$(mt_gate "$N3" "$RN" nrepo)"
case "$M3" in "pass - 1 "*'"the v2 profile is named Ada"'*) ok "L3: merge-ticket's gate passes the same way ($M3)" ;; *) fail "L3 merge-ticket: $M3 $(tail -c 400 "$WORK/mt.err")" ;; esac
# main moves: the v2 profile loses its name; the registered smoke suite stays green.
printf 'export function profile() {\n  return { name: undefined };\n}\n' > "$RN/src/profile.js"
gitc -C "$RN" commit -qam "refactor: the profile name moves"
( cd "$RN" && PROFILE_API_V2=1 node --test test/smoke.test.mjs >/dev/null 2>&1 ) && ok "L1: main's own suite stays green" || fail "L1: fixture: main red"
for n in "$N1" "$N2"; do
  what="with identities"; [ "$n" = "$N2" ] && what="an older PASS without identities"
  L="$(land_gate "$n" "$RN")"
  case "$L" in "4 tester_replay_red 0 "*) ok "L1 (land.sh, $what): the env reaches the replay, the assertion runs and fails: HELD tester_replay_red ($L)" ;; *) fail "L1 (land.sh, $what): $L $(tail -3 "$LOGF" | tr '\n' '|' | cut -c1-400)" ;; esac
  M="$(mt_gate "$n" "$RN" nrepo)"
  case "$M" in "red tester_replay_red 0 "*) ok "L1 (merge-ticket, $what): HELD tester_replay_red ($M)" ;; *) fail "L1 (merge-ticket, $what): $M $(tail -c 400 "$WORK/mt.err")" ;; esac
done

echo "== L4: a bound identity the candidate SKIPS holds, named =="
# The registered command loses the env (a human changed it): the bound assertion skips.
N4="$(deliver nrepo "$RN" "$ACC_NODE" "$IDS_NODE")"
gitc -C "$RN" checkout -q main
printf 'export function profile() {\n  return { name: "Ada" };\n}\n' > "$RN/src/profile.js"
node -e 'const f=process.argv[1];const p=JSON.parse(require("fs").readFileSync(f,"utf8"));p.scripts.test="node --test test/smoke.test.mjs";require("fs").writeFileSync(f,JSON.stringify(p))' "$RN/package.json"
gitc -C "$RN" commit -qam "test script without the v2 env"
L4="$(land_gate "$N4" "$RN")"
case "$L4" in "4 tester_replay_unverified 0 "*) ok "L4 (land.sh): HELD tester_replay_unverified ($L4)" ;; *) fail "L4 (land.sh): $L4" ;; esac
R4="$(cat "$WORK/mg.reason" 2>/dev/null)"
case "$R4" in *"the v2 profile is named Ada"*) case "$R4" in *skipped*) ok "L4: the hold names the skipped identity" ;; *) fail "L4 reason: ${R4:0:400}" ;; esac ;; *) fail "L4 reason: ${R4:0:400}" ;; esac
M4="$(mt_gate "$N4" "$RN" nrepo)"
case "$M4" in "red tester_replay_unverified 0 "*) ok "L4 (merge-ticket): HELD tester_replay_unverified ($M4)" ;; *) fail "L4 (merge-ticket): $M4" ;; esac

echo "== L2: the combined counterexample, vitest (the registered --config enables it) =="
VMODS="$ROOT/packages/dispatch/node_modules"
if [ ! -x "$VMODS/.bin/vitest" ]; then
  echo "  SKIP L2: packages/dispatch has no vitest installed"
else
  RV="$(make_repo vrepo "vitest run --config vitest.ci.config.mjs test/smoke.test.mjs")"
  ln -s "$VMODS" "$RV/node_modules"
  printf 'export default { test: { env: { PROFILE_API_V2: "1" } } };\n' > "$RV/vitest.ci.config.mjs"
  printf 'import { it, expect } from "vitest";\nimport { profile } from "../src/profile.js";\nit("smoke", () => expect(typeof profile).toBe("function"));\n' > "$RV/test/smoke.test.mjs"
  gitc -C "$RV" add -A; gitc -C "$RV" commit -qm "vitest suite (node_modules linked)"
  ACC_V='import { describe, it, expect } from "vitest";
import { profile } from "../src/profile.js";
it("the module loads", () => expect(typeof profile).toBe("function"));
describe("v2", () => { it.skipIf(!process.env.PROFILE_API_V2)("the profile is named Ada", () => expect(profile().name).toBe("Ada")); });'
  V1="$(deliver vrepo "$RV" "$ACC_V" '[{"file":"test/acceptance.test.mjs","name":"the module loads"},{"file":"test/acceptance.test.mjs","name":"v2 > the profile is named Ada"}]')"
  V2="$(deliver vrepo "$RV" "$ACC_V")"
  V3="$(deliver vrepo "$RV" "$ACC_V" '[{"file":"test/acceptance.test.mjs","name":"the module loads"},{"file":"test/acceptance.test.mjs","name":"v2 > the profile is named Ada"}]')"
  command -v vitest >/dev/null 2>&1 && fail "L5: fixture: vitest is on the runner's PATH"
  L="$(land_gate "$V3" "$RV")"
  case "$L" in "0 - 1 "*'"v2 > the profile is named Ada"'*) ok "L5: the package script runs with node_modules/.bin on PATH and its config: green with both identities ($L)" ;; *) fail "L5: $L $(tail -3 "$LOGF" | tr '\n' '|' | cut -c1-400)" ;; esac
  M="$(mt_gate "$V3" "$RV" vrepo)"
  case "$M" in "pass - 1 "*'"v2 > the profile is named Ada"'*) ok "L5 (merge-ticket): green with both identities" ;; *) fail "L5 (merge-ticket): $M" ;; esac
  printf 'export function profile() {\n  return { name: undefined };\n}\n' > "$RV/src/profile.js"
  gitc -C "$RV" commit -qam "refactor: the profile name moves"
  for n in "$V1" "$V2"; do
    what="with identities"; [ "$n" = "$V2" ] && what="an older PASS without identities"
    L="$(land_gate "$n" "$RV")"
    case "$L" in "4 tester_replay_red 0 "*) ok "L2 (land.sh, $what): the config reaches the replay: HELD tester_replay_red ($L)" ;; *) fail "L2 (land.sh, $what): $L $(tail -3 "$LOGF" | tr '\n' '|' | cut -c1-400)" ;; esac
    M="$(mt_gate "$n" "$RV" vrepo)"
    case "$M" in "red tester_replay_red 0 "*) ok "L2 (merge-ticket, $what): HELD tester_replay_red ($M)" ;; *) fail "L2 (merge-ticket, $what): $M" ;; esac
  done
fi

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "land-tester-replay-contract: ALL $PASS checks passed"; exit 0; fi
echo "land-tester-replay-contract: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1
