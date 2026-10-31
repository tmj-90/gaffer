#!/usr/bin/env bash
# =====================================================================
# bin/dod-regate.sh runs the SAME typecheck gate as the delivery gate.
# ---------------------------------------------------------------------
# The merge gate and the conflict re-gate both run bin/dod-regate.sh. It used to read
# only GAFFER_DOD_TYPECHECK_CMD, so the typecheck script tick.sh auto-detects from the
# repo's package.json (gaffer_dod_typecheck_cmd) was SKIPPED there: a combination only
# `npm run typecheck` caught landed red, and a repo whose only gate is that script ran
# zero gates (every landing held). Now:
#   T1  a failing auto-detected typecheck fails the re-gate (rc 1, typecheck FAIL);
#   T2  a typecheck-only repo whose script passes PASSES (one gate executed, rc 0);
#   T3  the script is detected from the BASE ref first (5th argument): a branch that
#       deletes it still runs it — the BASE body (gate integrity: source base-pinned),
#       so it fails when the code fails it — as the delivery gate does;
#   T4  GAFFER_DOD_TYPECHECK_CMD still overrides the detected script;
#   T5  GAFFER_DOD_TYPECHECK=0 still disables the gate (zero gates → fail closed);
#   T6  gateProposedMerge (bin/merge-ticket.mjs) passes the gated target as the base,
#       and land.sh / the conflict re-gate pass one too (wiring).
# Run: bash runner/test/dod-regate-typecheck.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/dod-regate-tc.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
trap 'gaffer_test_rm_work "$WORK"' EXIT
mkdir -p "$WORK/data"
export GAFFER_DATA="$WORK/data" GAFFER_DOD_INSTALL=0 GAFFER_STRICT_REQUIRE=0 STRICT_MODE=0
unset GAFFER_DOD_TYPECHECK_CMD GAFFER_ALLOW_NO_DOD GAFFER_DOD GAFFER_DOD_TYPECHECK
gitc() { git -c user.email=t@t -c user.name=t "$@"; }

R="$WORK/repo"; mkdir -p "$R"
( cd "$R" && git init -q -b main
  printf '{ "name": "r", "private": true, "scripts": { "typecheck": "node -e \\"process.exit(require(\\\\\\"fs\\\\\\").existsSync(\\\\\\"bad\\\\\\")?1:0)\\"" } }\n' > package.json
  gitc add -A && gitc commit -qm init )
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$R/package.json" || { echo "fixture package.json is not JSON"; exit 1; }
regate() { bash "$RUNNER_DIR/bin/dod-regate.sh" "$@" 2>/dev/null; }

echo "== T1: a failing auto-detected typecheck fails the re-gate =="
touch "$R/bad"
out="$(regate "$R" repo - -)"; rc=$?
[ "$rc" -eq 1 ] && ok "rc 1" || fail "rc=$rc out=${out:0:300}"
case "$out" in *'"gate":"typecheck"'*'"status":"FAIL"'*) ok "the evidence names the failing typecheck gate" ;; *) fail "evidence: ${out:0:400}" ;; esac
rm -f "$R/bad"

echo "== T2: a typecheck-only repo passes (not the zero-gates refusal) =="
out="$(regate "$R" repo - -)"; rc=$?
[ "$rc" -eq 0 ] && ok "rc 0" || fail "rc=$rc out=${out:0:400}"
case "$out" in "DoD: PASS"*'"gate":"typecheck"'*'"status":"PASS"'*) ok "typecheck executed and passed" ;; *) fail "evidence: ${out:0:400}" ;; esac

echo "== T3: detected from the base ref first =="
gitc -C "$R" checkout -q -b drop
printf '{ "name": "r", "private": true, "scripts": {} }\n' > "$R/package.json"; gitc -C "$R" commit -qam "drop typecheck"
touch "$R/bad"
out="$(regate "$R" repo - - main)"; rc=$?
[ "$rc" -eq 1 ] && case "$out" in *'"gate":"typecheck"'*'"status":"FAIL"'*'"source":"base-pinned'*) true ;; *) false ;; esac \
  && ok "the base's typecheck script still runs on a branch that deleted it (the base body, and it fails)" || fail "rc=$rc out=${out:0:400}"
rm -f "$R/bad"
out="$(regate "$R" repo - - main)"; rc=$?
[ "$rc" -eq 0 ] && case "$out" in *'"gate":"typecheck"'*'"status":"PASS"'*'"source":"base-pinned'*) true ;; *) false ;; esac \
  && ok "the base body is what runs: it passes when the code passes it (one gate executed)" || fail "rc=$rc out=${out:0:400}"
case "$out" in *'"gate":"integrity"'*'"status":"FLAG"'*) ok "the deleted gate script FLAGs the integrity row" ;; *) fail "no integrity FLAG: ${out:0:600}" ;; esac
out="$(regate "$R" repo - -)"; rc=$?
[ "$rc" -eq 1 ] && case "$out" in *"zero DoD gates"*) true ;; *) false ;; esac \
  && ok "control: with no base the branch has no typecheck script (zero gates → fail closed)" || fail "rc=$rc out=${out:0:400}"
gitc -C "$R" checkout -q main

echo "== T4: GAFFER_DOD_TYPECHECK_CMD overrides =="
out="$(GAFFER_DOD_TYPECHECK_CMD='exit 3' regate "$R" repo - -)"; rc=$?
[ "$rc" -eq 1 ] && ok "the override runs instead of the detected script" || fail "rc=$rc out=${out:0:300}"

echo "== T5: GAFFER_DOD_TYPECHECK=0 disables it =="
out="$(GAFFER_DOD_TYPECHECK=0 regate "$R" repo - -)"; rc=$?
[ "$rc" -eq 1 ] && case "$out" in *"zero DoD gates"*) true ;; *) false ;; esac \
  && ok "disabled typecheck → zero gates → fail closed (no silent PASS)" || fail "rc=$rc out=${out:0:300}"

echo "== T6: every caller passes a base ref =="
gitc -C "$R" checkout -q -b feat; printf 'x\n' > "$R/f.txt"; gitc -C "$R" add -A; gitc -C "$R" commit -qm feat; gitc -C "$R" checkout -q main
# argv[1] is a placeholder: merge-ticket.mjs runs its CLI when argv[1] names it.
res="$(node --input-type=module -e '
  const { gateProposedMerge } = await import(process.argv[2]);
  const r = gateProposedMerge({ repoPath: process.argv[3], branch: "feat", pin: process.argv[4],
    targetRef: "refs/heads/main", label: "repo", commands: { test: "", lint: "" },
    gateDir: process.argv[5] });
  process.stdout.write(r.kind + "|" + r.evidence.replace(/\n/g, " "));' \
  placeholder "$RUNNER_DIR/bin/merge-ticket.mjs" "$R" "$(git -C "$R" rev-parse feat)" "$WORK/data/worktrees/mg" 2>&1)"
case "$res" in pass*'"gate":"typecheck"'*'"status":"PASS"'*) ok "gateProposedMerge on a typecheck-only repo runs the typecheck gate and passes" ;; *) fail "gateProposedMerge: ${res:0:400}" ;; esac
grep -q 'dod-regate.sh" "$wt" "$label" "${tcmd:--}" "${lcmd:--}" "$_MG_TARGET"' "$RUNNER_DIR/lib/land.sh" \
  && ok "land.sh's merge gate passes the gated target head" || fail "land.sh does not pass the target head to dod-regate.sh"
grep -q 'base: defaultTip' "$RUNNER_DIR/bin/merge-ticket.mjs" \
  && ok "the conflict re-gate passes the default branch's tip" || fail "regateResolution is not given the default branch"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "dod-regate-typecheck: ALL $PASS checks passed"; exit 0; fi
echo "dod-regate-typecheck: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1
