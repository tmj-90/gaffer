#!/usr/bin/env bash
# =====================================================================
# MACHINE-CHECKABLE AC — the command that runs is the command that was stored.
# ---------------------------------------------------------------------
# A check_command that needed two fields separated by a literal TAB (inside quotes)
# was rewritten TAB → space on its way to `bash -c` (the row format collapsed it), so a
# criterion that fails in a shell was recorded satisfied by runner:check. The bytes are
# now preserved from storage through the API, the runner's row channel (base64) and the
# shell invocation, and dispatch refuses a check result whose command differs from the
# stored one. For each tricky command — a quoted TAB, a multiline script, $-signs,
# backslashes, non-ASCII — the gaffer verdict equals the direct `bash -c` verdict, and
# the recorded command equals the stored bytes.
# Run: bash runner/test/ac-check-bytes.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
CLI="$ROOT/packages/dispatch/dist/cli/index.js"
[ -f "$CLI" ] || { echo "SKIP: dispatch CLI not built ($CLI)"; exit 0; }
P=0; F=0
ok(){ P=$((P + 1)); printf '  ok   %s\n' "$1"; }
no(){ F=$((F + 1)); printf '  FAIL %s\n' "$1"; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ac-bytes.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT
export GAFFER_DATA="$WORK/data"; mkdir -p "$GAFFER_DATA"
export DISPATCH_DB="$WORK/dispatch.sqlite" GAFFER_DOD_TIMEOUT=30 GAFFER_DOD_OUTPUT_TAIL=40
log(){ :; }
wg(){ node "$CLI" --db "$DISPATCH_DB" "$@"; }
jget(){ node "$RUNNER_DIR/lib/json-tool.mjs" expr "$1"; }
gaffer_timeout(){ shift; "$@"; }
# shellcheck source=../lib/dod.sh
source "$RUNNER_DIR/lib/dod.sh"
# shellcheck source=../lib/ac-checks.sh
source "$RUNNER_DIR/lib/ac-checks.sh"

WT="$WORK/wt"; mkdir -p "$WT"
printf 'a b\n' > "$WT/spaced.txt"          # a SPACE, not a tab
printf 'a\tb\n' > "$WT/tabbed.txt"         # a real TAB
printf 'caf\xc3\xa9\n' > "$WT/utf8.txt"
TAB=$'\t'
# name|expected-direct-rc-class (0 or non-0) is computed below by running each directly.
CMDS=()
CMDS+=("grep -q \"a${TAB}b\" spaced.txt")                       # FAILS in a shell (no tab in the file)
CMDS+=("grep -q \"a${TAB}b\" tabbed.txt")                       # passes
CMDS+=($'x=1\nif [ "$x" = 1 ]; then\n  test -f tabbed.txt\nelse\n  exit 9\nfi')   # multiline, passes
CMDS+=($'test "$(printf \'%s\' "$HOME")" != \'$HOME\' && [ "\\$" = \'$\' ]')   # $-signs and a backslash, passes
CMDS+=($'grep -q \'\\ta\' tabbed.txt')                           # backslash-t is NOT a tab for grep's BRE → fails
CMDS+=("grep -q 'café' utf8.txt")                              # non-ASCII, passes
CMDS+=($'  printf \'%s\' "lead and trail"   ')                  # leading/trailing blanks kept
T="$(wg ticket create --title "Byte-exact checks")"
NUM="$(printf '%s' "$T" | jget 'd.number ?? d.ticket?.number')"
i=0
for c in "${CMDS[@]}"; do
  i=$((i + 1))
  if ! wg ac add "$NUM" -t "check $i" --check "$c" >"$WORK/add.$i" 2>&1; then
    no "check $i could not be stored: $(head -c 200 "$WORK/add.$i")"
  fi
done
SHOW="$(wg ticket show "$NUM")"
RES="$WORK/ac.results"; : > "$RES"
gaffer_run_ac_checks "$NUM" "$SHOW" "$WT" "$RES" >/dev/null 2>&1
AFTER="$(wg ticket show "$NUM")"
i=0
for c in "${CMDS[@]}"; do
  i=$((i + 1))
  ( cd "$WT" && bash -c "$c" ) >/dev/null 2>&1 </dev/null; drc=$?
  want=satisfied; [ "$drc" -eq 0 ] || want=failed
  got="$(printf '%s' "$AFTER" | jget "(d.acceptanceCriteria.find((a) => a.text === 'check $i') || {}).status")"
  [ "$got" = "$want" ] && ok "check $i: gaffer verdict ($got) = direct shell (rc $drc)" || no "check $i: gaffer recorded '$got', a direct shell says '$want' (rc $drc) for: $(printf '%q' "$c")"
  stored="$(printf '%s' "$AFTER" | jget "(d.acceptanceCriteria.find((a) => a.text === 'check $i') || {}).check_command")"
  [ "$stored" = "$c" ] && ok "check $i: stored bytes are the authored bytes" || no "check $i: stored $(printf '%q' "$stored") != authored $(printf '%q' "$c")"
done
# The recorded evidence carries the exact command (payload), never a rewritten one.
N_EXACT="$(SHOW_JSON="$AFTER" node -e '
  const d = JSON.parse(process.env.SHOW_JSON);
  const stored = new Set((d.acceptanceCriteria || []).map((a) => a.check_command));
  const ev = (d.evidence || []).filter((e) => e.evidence_type === "test_output" && e.payload_json);
  let n = 0; for (const e of ev) { try { if (stored.has(JSON.parse(e.payload_json).command)) n++; } catch {} }
  process.stdout.write(String(n));')"
[ "$N_EXACT" = "${#CMDS[@]}" ] && ok "every check's evidence records the stored command byte for byte" || no "only $N_EXACT/${#CMDS[@]} evidence rows carry the exact stored command"

echo "== dispatch refuses a result for a command other than the stored one =="
AC1="$(printf '%s' "$AFTER" | jget "d.acceptanceCriteria.find((a) => a.text === 'check 1').id")"
if wg ac check-result "$AC1" --ticket "$NUM" --exit 0 --command 'grep -q "a b" spaced.txt' >"$WORK/cr.out" 2>&1; then
  no "a check result for a rewritten command was accepted"
else
  grep -q "COMMAND_MISMATCH\|does not match" "$WORK/cr.out" && ok "a rewritten command is refused (COMMAND_MISMATCH)" || no "refused, but not for the command: $(head -c 200 "$WORK/cr.out")"
fi
S1="$(wg ticket show "$NUM" | jget "d.acceptanceCriteria.find((a) => a.text === 'check 1').status")"
[ "$S1" = "failed" ] && ok "the TAB criterion stays failed" || no "the TAB criterion is now $S1"

echo
[ "$F" -eq 0 ] && { echo "ac-check-bytes: ALL $P checks passed"; exit 0; }
echo "ac-check-bytes: $F FAILURE(S), $P ok"; exit 1
