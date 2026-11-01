#!/usr/bin/env bash
# =====================================================================
# `gaffer onboard`: usage errors, and a next-step hint that pastes as one argument.
# ---------------------------------------------------------------------
#   1  no path: exit 2, ✗ + the usage line on stderr, nothing on stdout (was exit 1);
#   2  a path that is not a directory: exit 2, "✗ no such directory" on stderr (was
#      stdout, exit 1, no mark);
#   3  the summary's next step quotes a repo name with spaces ('repo with spaces')
#      and leaves a plain name bare (bin/onboard-run.mjs buildOnboardSummary);
#   4  `/`, the home directory, a folder outside any git checkout (and a symlink to
#      one) are refused in ONE line on stderr, exit 2, nothing spawned — the same rule
#      as the dashboard's onboard route; `gaffer onboard /` used to end in a raw
#      ZodError stack from crew. onboard-run.mjs itself refuses them too (exit 2).
# Run: bash runner/test/onboard-usage.test.sh   (bash 3.2 safe)
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
has()  { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/onboard-usage.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT
export GAFFER_DATA="$WORK/data"; mkdir -p "$GAFFER_DATA"
ob() { RC=0; bash "$RUNNER_DIR/gaffer" onboard "$@" >"$WORK/out" 2>"$WORK/err" || RC=$?; OUT="$(cat "$WORK/out")"; ERR="$(cat "$WORK/err")"; }

echo "== 1: no path =="
ob
[ "$RC" -eq 2 ] && ok "exit 2" || fail "exit $RC"
has "$ERR" "✗" && has "$ERR" "usage: gaffer onboard <path>" && ok "✗ and the usage line on stderr" || fail "stderr: $ERR"
[ -z "$OUT" ] && ok "nothing on stdout" || fail "stdout: $OUT"

echo "== 2: no such directory =="
ob "$WORK/not-here"
[ "$RC" -eq 2 ] && ok "exit 2" || fail "exit $RC"
has "$ERR" "✗ no such directory: $WORK/not-here" && ok "'✗ no such directory' on stderr" || fail "stderr: $ERR"
[ -z "$OUT" ] && ok "nothing on stdout" || fail "stdout: $OUT"

echo "== 3: the next step quotes a name with spaces =="
next_line() {
  # The module path goes in through the env: onboard-run.mjs runs its main when
  # process.argv[1] is its own path.
  OBR="$RUNNER_DIR/bin/onboard-run.mjs" node --input-type=module -e '
    const { buildOnboardSummary } = await import(process.env.OBR);
    const stdout = JSON.stringify({ onboarded: { name: process.argv[1], scan: { stack: "node", testCommand: "npm test" } } });
    const lines = buildOnboardSummary({ stdout, exit: 0, analysis: null, logFile: "/x/onboard.log" });
    console.log(lines.find((l) => l.startsWith("next:")) || "");
  ' "$1"
}
L="$(next_line "repo with spaces")"
has "$L" "repo-access set <n> 'repo with spaces' · ready" && ok "a name with spaces is single-quoted" || fail "hint: $L"
L="$(next_line "notes")"
has "$L" "repo-access set <n> notes · ready" && ok "a plain name stays bare" || fail "hint: $L"
L="$(next_line "it's")"
has "$L" "repo-access set <n> 'it'\\''s' · ready" && ok "an embedded quote is escaped" || fail "hint: $L"

echo "== 4: not a repository =="
mkdir -p "$WORK/home" "$WORK/plain/sub"; ln -s "$WORK/plain" "$WORK/plain-link"
mkdir -p "$WORK/bin"; printf '#!/bin/sh\necho "claude must not be called" >> "%s"\nexit 97\n' "$WORK/claude-calls" > "$WORK/bin/claude"; chmod +x "$WORK/bin/claude"
for target in / "$WORK/home" "$WORK/plain" "$WORK/plain-link" "$WORK/plain/sub"; do
  RC=0; HOME="$WORK/home" CLAUDE_BIN="$WORK/bin/claude" bash "$RUNNER_DIR/gaffer" onboard "$target" >"$WORK/out" 2>"$WORK/err" || RC=$?
  OUT="$(cat "$WORK/out")"; ERR="$(cat "$WORK/err")"
  [ "$RC" -eq 2 ] && [ "$(printf '%s\n' "$ERR" | grep -c .)" = 1 ] && has "$ERR" "✗ " && ok "$(basename "$target"): exit 2, one ✗ line" || fail "$target: rc=$RC err=$ERR"
  has "$OUT$ERR" "ZodError" && fail "$target: a ZodError reached the operator" || true
done
case "$(HOME="$WORK/home" bash "$RUNNER_DIR/gaffer" onboard / 2>&1)" in *"a filesystem root is not a repository"*) ok "/ : 'a filesystem root is not a repository'" ;; *) fail "/ message" ;; esac
case "$(HOME="$WORK/home" bash "$RUNNER_DIR/gaffer" onboard "$WORK/home" 2>&1)" in *"your home directory is not a repository"*) ok "home: 'your home directory is not a repository'" ;; *) fail "home message" ;; esac
case "$(HOME="$WORK/home" bash "$RUNNER_DIR/gaffer" onboard "$WORK/plain-link" 2>&1)" in *"$WORK/plain is not a git repository"*"git init"*) ok "a symlink is followed: the real folder is named, with git init" ;; *) fail "symlink message" ;; esac
[ ! -e "$WORK/claude-calls" ] && ok "nothing was spawned (no model call)" || fail "claude was called"
[ ! -e "$GAFFER_DATA/onboard.log" ] && ok "no onboard run started (no onboard.log)" || fail "an onboard run started"
RC=0; ERR="$(HOME="$WORK/home" DISPATCH_ONBOARD_REPO=/ node "$RUNNER_DIR/bin/onboard-run.mjs" 2>&1 >/dev/null)" || RC=$?
[ "$RC" -eq 2 ] && has "$ERR" "a filesystem root is not a repository" && ! has "$ERR" "ZodError" && ok "onboard-run.mjs (the dashboard's runner) refuses / too, exit 2" || fail "onboard-run / rc=$RC: $(printf '%s' "$ERR" | tail -2)"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "onboard-usage: ALL $PASS checks passed"; exit 0; fi
echo "onboard-usage: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
