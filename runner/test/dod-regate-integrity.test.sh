#!/usr/bin/env bash
# =====================================================================
# GATE INTEGRITY on the landing paths: bin/dod-regate.sh (the merge gate and the
# conflict re-gate) carries its base ref into lib/dod.sh as the gate row's base_ref,
# so the merged tree gets the delivery gate's integrity treatment.
#   M1  the merge gate (gateProposedMerge) of a branch that deletes a test file PASSES
#       (the gates are green) and its evidence carries an integrity FLAG naming the
#       file; DoD stays PASS — a FLAG never fails a landing.
#   M2  a human's allow_test_changes (commands.allow) turns that FLAG into PASS with
#       a note; dod-regate.sh's 6th argument does the same.
#   M3  a branch that rewrites `scripts.test` to `true` while breaking the code is RED
#       at the merge gate: the target head's script runs (source base-pinned).
#   M4  no base ref → no integrity row (the old contract exactly); the integrity row
#       never counts as an executed gate (zero configured gates still fail closed).
#   M5  resolveGateCommands reads allow_test_changes from the dispatch DB (fails
#       closed to false; a schema without the column keeps the gate commands).
#   M6  wiring: land.sh's merge gate passes the ticket's allowance to dod-regate.sh.
# Requires git, node, npm and the built crew + dispatch dists. SKIPs (exit 0) otherwise.
# Run: bash runner/test/dod-regate-integrity.test.sh      (bash 3.2-safe)
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v npm >/dev/null 2>&1 || { echo "SKIP: npm required"; exit 0; }
[ -f "$ROOT/packages/crew/dist/runtime/dod/gateIntegrityCli.js" ] || { echo "SKIP: crew dist not built"; exit 0; }
[ -f "$ROOT/packages/dispatch/dist/services/testIntegrity.js" ] || { echo "SKIP: dispatch dist not built"; exit 0; }

PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/dod-regate-gi.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
trap 'gaffer_test_rm_work "$WORK"' EXIT
mkdir -p "$WORK/data"
export GAFFER_DATA="$WORK/data" GAFFER_DOD_INSTALL=0 GAFFER_STRICT_REQUIRE=0 STRICT_MODE=0
unset GAFFER_DOD_TYPECHECK_CMD GAFFER_ALLOW_NO_DOD GAFFER_DOD GAFFER_DOD_TYPECHECK GAFFER_DOD_TESTS GAFFER_DOD_LINT
gitc() { git -c user.email=t@t -c user.name=t "$@"; }

# Fixture: `npm test` runs every file in test/ against src/m.js (v must be 1).
R="$WORK/repo"; mkdir -p "$R/src" "$R/test"
( cd "$R" && git init -q -b main
  printf '{ "name": "r", "private": true, "scripts": { "test": "node run-tests.js" } }\n' > package.json
  printf 'for (const f of require("fs").readdirSync("test")) require("./test/" + f);\n' > run-tests.js
  printf 'module.exports = { v: 1 };\n' > src/m.js
  printf 'const assert = require("assert");\nassert.strictEqual(require("../src/m.js").v, 1);\n' > test/a.test.js
  printf 'const assert = require("assert");\nassert.ok(require("../src/m.js"));\n' > test/b.test.js
  gitc add -A && gitc commit -qm init )
MAIN="$(git -C "$R" rev-parse main)"
# drop-test: deletes test/b.test.js (the gates stay green).
gitc -C "$R" checkout -q -b drop-test
gitc -C "$R" rm -q test/b.test.js; gitc -C "$R" commit -qm "drop a test"
DROP="$(git -C "$R" rev-parse HEAD)"
# no-op-test: breaks the code and points scripts.test at `true`.
gitc -C "$R" checkout -q -b noop-test main
printf '{ "name": "r", "private": true, "scripts": { "test": "true" } }\n' > "$R/package.json"
printf 'module.exports = { v: 2 };\n' > "$R/src/m.js"
gitc -C "$R" commit -qam "break it and no-op the test"
NOOP="$(git -C "$R" rev-parse HEAD)"
gitc -C "$R" checkout -q main

# gateProposedMerge, as merge-ticket.mjs's landing calls it. argv[1] is a placeholder:
# merge-ticket.mjs runs its CLI when argv[1] names it.
mg() { # <branch> <pin> <allow:true|false> <gate-dir-name>
  node --input-type=module -e '
    const { gateProposedMerge } = await import(process.argv[2]);
    const r = gateProposedMerge({ repoPath: process.argv[3], branch: process.argv[4], pin: process.argv[5],
      targetRef: "refs/heads/main", label: "repo",
      commands: { test: "npm test", lint: "", allow: process.argv[6] === "true" },
      gateDir: process.argv[7] });
    process.stdout.write(r.kind + "|" + r.evidence.replace(/\n/g, " "));' \
    placeholder "$RUNNER_DIR/bin/merge-ticket.mjs" "$R" "$1" "$2" "$3" "$WORK/data/worktrees/$4" 2>&1
}
regate() { bash "$RUNNER_DIR/bin/dod-regate.sh" "$@" 2>/dev/null; }

echo "== M1: a deleted test file FLAGs the merge gate's integrity row; the landing still passes =="
res="$(mg drop-test "$DROP" false m1)"
case "$res" in "pass|DoD: PASS"*) ok "the merge gate passes (the gates are green)" ;; *) fail "M1 kind/verdict: ${res:0:500}" ;; esac
case "$res" in *'"gate":"tests"'*'"status":"PASS"'*) ok "the tests gate ran and passed" ;; *) fail "M1 tests: ${res:0:500}" ;; esac
case "$res" in *'"gate":"integrity"'*'"status":"FLAG"'*'test/b.test.js'*) ok "the integrity row FLAGs and names the deleted test file" ;; *) fail "M1 integrity: ${res:0:800}" ;; esac
case "$res" in *'"gate":"integrity"'*'"status":"FAIL"'*) fail "M1: the integrity row FAILed" ;; *) ok "the integrity row is never FAIL" ;; esac

echo "== M2: a human's allowance turns the FLAG into PASS with a note =="
res="$(mg drop-test "$DROP" true m2)"
case "$res" in "pass|DoD: PASS"*'"gate":"integrity"'*'"status":"PASS"'*'allowed on this ticket by a human'*) ok "gateProposedMerge: allow → integrity PASS with the note" ;; *) fail "M2: ${res:0:800}" ;; esac
WT2="$WORK/wt2"; git -C "$R" worktree add -q --detach "$WT2" "$DROP" >/dev/null 2>&1
out="$(regate "$WT2" repo "npm test" - "$MAIN" 1)"; rc=$?
[ "$rc" -eq 0 ] && case "$out" in *'"gate":"integrity"'*'"status":"PASS"'*'by a human'*) true ;; *) false ;; esac \
  && ok "dod-regate.sh's 6th argument is the allowance" || fail "M2 regate: rc=$rc ${out:0:600}"
out="$(regate "$WT2" repo "npm test" - "$MAIN" yes)"; rc=$?
[ "$rc" -eq 0 ] && case "$out" in *'"gate":"integrity"'*'"status":"FLAG"'*) true ;; *) false ;; esac \
  && ok "anything but 1 is no allowance (FLAG)" || fail "M2 non-1 allow: rc=$rc ${out:0:600}"

echo "== M3: rewriting scripts.test cannot pass the merge gate =="
res="$(mg noop-test "$NOOP" false m3)"
case "$res" in "red|DoD: FAIL"*'"gate":"tests"'*'"status":"FAIL"'*'base-pinned'*) ok "the target head's test script runs on the merge (base-pinned) and fails it" ;; *) fail "M3: ${res:0:800}" ;; esac
case "$res" in *'"gate":"integrity"'*'"status":"FLAG"'*) ok "and the integrity row FLAGs the changed gate script" ;; *) fail "M3 integrity: ${res:0:800}" ;; esac

echo "== M4: no base → the old contract; integrity never counts as an executed gate =="
out="$(regate "$WT2" repo "npm test" -)"; rc=$?
[ "$rc" -eq 0 ] && case "$out" in *'"gate":"integrity"'*) false ;; *) true ;; esac \
  && ok "no base ref: no integrity row, the gate runs as registered" || fail "M4 no base: rc=$rc ${out:0:600}"
out="$(GAFFER_DOD_TESTS=0 regate "$WT2" repo "npm test" - "$MAIN")"; rc=$?
[ "$rc" -eq 1 ] && case "$out" in *"zero DoD gates"*) true ;; *) false ;; esac \
  && ok "only the integrity row ran → zero executed gates → fail closed" || fail "M4 zero gates: rc=$rc ${out:0:600}"
git -C "$R" worktree remove --force "$WT2" >/dev/null 2>&1 || true

echo "== M5: resolveGateCommands reads the allowance =="
cat > "$WORK/m5.mjs" <<'JS'
const { resolveGateCommands } = await import(process.argv[2]);
const { DatabaseSync } = await import("node:sqlite");
const mk = (path, withAllow) => {
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE tickets (id TEXT, number INTEGER" +
      (withAllow ? ", allow_test_changes INTEGER NOT NULL DEFAULT 0" : "") + ");" +
      "CREATE TABLE repositories (id TEXT, test_command TEXT, lint_command TEXT);" +
      "CREATE TABLE ticket_repos (ticket_id TEXT, repo_id TEXT, access TEXT, role TEXT);" +
      "INSERT INTO repositories VALUES ('r1', 'npm test', 'npm run lint');" +
      "INSERT INTO ticket_repos VALUES ('t1', 'r1', 'write', 'primary'), ('t2', 'r1', 'write', 'primary');",
  );
  db.exec(withAllow ? "INSERT INTO tickets VALUES ('t1', 7, 1), ('t2', 8, 0)" : "INSERT INTO tickets VALUES ('t1', 7)");
  db.close();
  return path;
};
const a = mk(process.argv[3] + "/a.sqlite", true);
const b = mk(process.argv[3] + "/b.sqlite", false);
process.stdout.write(JSON.stringify([resolveGateCommands(a, 7), resolveGateCommands(a, 8), resolveGateCommands(b, 7)]));
JS
res="$(node --no-warnings "$WORK/m5.mjs" "$RUNNER_DIR/bin/merge-ticket.mjs" "$WORK" 2>&1)"
[ "$res" = '[{"test":"npm test","lint":"npm run lint","allow":true},{"test":"npm test","lint":"npm run lint","allow":false},{"test":"npm test","lint":"npm run lint","allow":false}]' ] \
  && ok "allow from the ticket (1 → true, 0 → false); a schema without the column keeps the commands, allow false" \
  || fail "M5: $res"

echo "== M6: land.sh passes the ticket's allowance =="
grep -q 'dod-regate.sh" "$wt" "$label" "${tcmd:--}" "${lcmd:--}" "$_MG_TARGET" "$allow"' "$RUNNER_DIR/lib/land.sh" \
  && grep -q "allow_test_changes === 1) ? 1 : 0" "$RUNNER_DIR/lib/land.sh" \
  && ok "land.sh's merge gate hands dod-regate.sh the allowance from the ticket" || fail "land.sh does not pass the allowance"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "dod-regate-integrity: ALL $PASS checks passed"; exit 0; fi
echo "dod-regate-integrity: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1
