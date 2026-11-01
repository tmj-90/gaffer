#!/usr/bin/env bash
# =====================================================================
# `gaffer` front door — argument handling (runner/gaffer).
# ---------------------------------------------------------------------
# `gaffer run` is the go-live command, so a bad argument there must never fall
# through to a live, paid pass. Proves, with a STUB supervisor loop (GAFFER_LOOP_SH,
# no agent spawned):
#   • `run --help` / `run --daemon --help` print usage, exit 0, the loop never runs;
#   • `run --bogus` / `run --deamon` exit 2, the loop never runs;
#   • `run --dry-run` and `run -n` reach the loop with DRY_RUN=1;
#   • `run --interval abc` / `--interval --daemon` exit 2;
#   • an unknown command exits 2 (it used to print help and exit 0);
#   • `help` / `--help` exit 0, `--version` prints the root package.json version;
#   • every subcommand answers --help with its usage and does nothing else
#     (`onboard --help` was "no such directory", `merge --help` reached merge-ticket);
#   • `onboard --standalone` is accepted, an unknown onboard option is refused;
#   • `skills <bad>` exits 2;
#   • gaffer run through a symlink on PATH (absolute, relative, a chain of two, a
#     directory with a space) finds its own runner dir (it used to die with
#     "RUNNER_DIR: unbound variable").
# Run: bash test/gaffer-cli-args.test.sh   (bash 3.2 safe)
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
G="$RUNNER_DIR/gaffer"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/gaffer-cli-args.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT
SEEN="$WORK/loop-ran"
STUB="$WORK/loop.sh"
cat > "$STUB" <<STUBSH
#!/usr/bin/env bash
printf '%s\n' "\${DRY_RUN-unset}" >> "$SEEN"
STUBSH
chmod +x "$STUB"
export GAFFER_LOOP_SH="$STUB" GAFFER_DATA="$WORK/data" GAFFER_DAEMON_MAX_CYCLES=1
unset DRY_RUN

# gx <args…> — run gaffer, capture combined output in $OUT and the exit code in $RC.
gx() { : > "$SEEN"; OUT="$(bash "$G" "$@" 2>&1)"; RC=$?; }
loop_ran() { [ -s "$SEEN" ]; }

echo "== run: help and bad options never start the loop =="
gx run --help
[ "$RC" -eq 0 ] && [[ "$OUT" == *"usage: gaffer run"* ]] && ! loop_ran \
  && ok "run --help: usage, exit 0, loop not run" || fail "run --help: rc=$RC loop_ran=$(cat "$SEEN") out=$OUT"
gx run --daemon --help
[ "$RC" -eq 0 ] && ! loop_ran && ok "run --daemon --help: help wins wherever it sits" || fail "run --daemon --help: rc=$RC loop=$(cat "$SEEN")"
gx run -h
[ "$RC" -eq 0 ] && ! loop_ran && ok "run -h: exit 0, loop not run" || fail "run -h: rc=$RC"
for bad in --bogus --deamon --dryrun x; do
  gx run "$bad"
  [ "$RC" -eq 2 ] && ! loop_ran && [[ "$OUT" == *"unknown option '$bad'"* ]] \
    && ok "run $bad: exit 2, names the option, loop not run" || fail "run $bad: rc=$RC loop=$(cat "$SEEN") out=$OUT"
done
gx run --interval abc --daemon
[ "$RC" -eq 2 ] && ! loop_ran && ok "run --interval abc: exit 2" || fail "run --interval abc: rc=$RC"
gx run --interval --daemon
[ "$RC" -eq 2 ] && ! loop_ran && ok "run --interval --daemon (missing value): exit 2" || fail "run --interval --daemon: rc=$RC"

echo "== run: --dry-run reaches the loop as DRY_RUN=1; no flag stays live =="
gx run --dry-run
[ "$RC" -eq 0 ] && [ "$(tail -n1 "$SEEN")" = "1" ] && ok "run --dry-run → DRY_RUN=1" || fail "run --dry-run: rc=$RC loop saw '$(cat "$SEEN")'"
gx run -n
[ "$(tail -n1 "$SEEN")" = "1" ] && ok "run -n → DRY_RUN=1" || fail "run -n: loop saw '$(cat "$SEEN")'"
gx run --daemon --interval 0 --dry-run
[ "$(tail -n1 "$SEEN")" = "1" ] && ok "run --daemon --dry-run → DRY_RUN=1" || fail "run --daemon --dry-run: loop saw '$(cat "$SEEN")'"
gx run
[ "$(tail -n1 "$SEEN")" = "0" ] && ok "run (no flag) is still live (DRY_RUN=0)" || fail "run: loop saw '$(cat "$SEEN")'"

echo "== top level: unknown command exits 2; help and version exit 0 =="
gx nosuch
[ "$RC" -eq 2 ] && [[ "$OUT" == *"unknown command 'nosuch'"* ]] && ok "gaffer nosuch: exit 2" || fail "gaffer nosuch: rc=$RC out=$OUT"
gx onbaord x
[ "$RC" -eq 2 ] && ok "gaffer onbaord x (typo): exit 2" || fail "gaffer onbaord: rc=$RC"
for h in help --help -h; do
  gx "$h"
  [ "$RC" -eq 0 ] && [[ "$OUT" == *"gaffer run"* ]] && ok "gaffer $h: exit 0, prints the command list" || fail "gaffer $h: rc=$RC"
done
WANT="$(node -p 'require(process.argv[1]).version' "$RUNNER_DIR/../package.json")"
gx --version
[ "$RC" -eq 0 ] && [ "$OUT" = "gaffer $WANT" ] && ok "gaffer --version → 'gaffer $WANT'" || fail "--version: rc=$RC out=$OUT"

echo "== every subcommand answers --help with usage and does nothing else =="
for c in onboard dashboard status setup demo eval approve merge run skills; do
  gx "$c" --help
  [ "$RC" -eq 0 ] && [[ "$OUT" == "usage: gaffer $c"* ]] && ok "$c --help: usage, exit 0" || fail "$c --help: rc=$RC out=${OUT:0:200}"
done
gx merge --help
[[ "$OUT" != *"could not resolve"* ]] && ok "merge --help never reaches merge-ticket.mjs" || fail "merge --help reached merge-ticket: $OUT"
[ ! -e "$WORK/data/dashboard.log" ] && ok "dashboard --help started no server" || fail "dashboard --help started a server"

echo "== onboard / merge / approve / dashboard / skills reject bad arguments =="
gx onboard --bogus "$WORK"
[ "$RC" -eq 2 ] && [[ "$OUT" == *"unknown option '--bogus'"* ]] && ok "onboard --bogus: exit 2" || fail "onboard --bogus: rc=$RC out=$OUT"
gx onboard "$WORK/absent" --standalone
[ "$RC" -eq 2 ] && [[ "$OUT" == *"no such directory: $WORK/absent"* ]] \
  && ok "onboard <path> --standalone: --standalone accepted (reaches the path check)" || fail "onboard --standalone: rc=$RC out=$OUT"
gx merge 3 4
[ "$RC" -eq 2 ] && ok "merge 3 4: exit 2 (one ticket)" || fail "merge 3 4: rc=$RC"
gx merge --force
[ "$RC" -eq 2 ] && ok "merge --force: exit 2" || fail "merge --force: rc=$RC"
gx approve 3 --bogus
[ "$RC" -eq 2 ] && ok "approve 3 --bogus: exit 2" || fail "approve 3 --bogus: rc=$RC"
gx dashboard --bogus
[ "$RC" -eq 2 ] && [ ! -e "$WORK/data/dashboard.log" ] && ok "dashboard --bogus: exit 2, no server" || fail "dashboard --bogus: rc=$RC"
gx skills nosuch
[ "$RC" -eq 2 ] && ok "skills nosuch: exit 2" || fail "skills nosuch: rc=$RC"
gx status --bogus
[ "$RC" -eq 2 ] && ok "status --bogus: exit 2" || fail "status --bogus: rc=$RC"
gx demo --bogus
[ "$RC" -eq 2 ] && ok "demo --bogus: exit 2 (demo not run)" || fail "demo --bogus: rc=$RC"
gx eval --bogus
[ "$RC" -eq 2 ] && ok "eval --bogus: exit 2" || fail "eval --bogus: rc=$RC"

echo "== gaffer through a symlink (an install on PATH) =="
WANT_VER="gaffer $(node -p 'require(process.argv[1]).version' "$RUNNER_DIR/../package.json")"
mkdir -p "$WORK/bin" "$WORK/with space/bin" "$WORK/chain"
ln -s "$G" "$WORK/bin/gaffer"                                   # absolute target
ln -s "../../chain/gaffer-mid" "$WORK/with space/bin/gaffer"    # relative, into a chain
ln -s "$G" "$WORK/chain/gaffer-mid"
for link in "$WORK/bin/gaffer" "$WORK/with space/bin/gaffer"; do
  RC=0; OUT="$(cd "$WORK" && PATH="$(dirname "$link"):$PATH" gaffer --version 2>&1)" || RC=$?
  [ "$RC" -eq 0 ] && [ "$OUT" = "$WANT_VER" ] && ok "via $(basename "$(dirname "$(dirname "$link")")")/bin/gaffer: --version works" \
    || fail "via $link: rc=$RC out=$(printf '%s' "$OUT" | head -3)"
  RC=0; OUT="$(cd "$WORK" && PATH="$(dirname "$link"):$PATH" gaffer status --help 2>&1)" || RC=$?
  [ "$RC" -eq 0 ] && [[ "$OUT" == "usage: gaffer status"* ]] && ok "via $(basename "$(dirname "$(dirname "$link")")")/bin/gaffer: a subcommand runs" \
    || fail "via $link status --help: rc=$RC out=$(printf '%s' "$OUT" | head -3)"
done

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "gaffer-cli-args: ALL $PASS checks passed"
  exit 0
fi
echo "gaffer-cli-args: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
