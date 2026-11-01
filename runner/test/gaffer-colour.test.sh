#!/usr/bin/env bash
# =====================================================================
# Colour codes only for a person at a terminal (runner/lib/colour.sh).
# ---------------------------------------------------------------------
# runner/gaffer, status.sh, run-summary.sh (and the json-tool reports it prints),
# preflight.sh and demo.sh set ANSI codes unconditionally, so `gaffer status | tee`,
# a CI log or `NO_COLOR=1 gaffer run` came out full of `\033[1;32m`. Proves, through
# the real scripts with stubbed data sources:
#   1  on a tty (a python pty) the marks ARE coloured — the rule is not "never";
#   2  piped (stdout not a tty) there is no escape byte, stdout or stderr;
#   3  NO_COLOR=1 on a tty: none;  4  TERM=dumb on a tty: none.
# Run: bash runner/test/gaffer-colour.test.sh   (bash 3.2 safe)
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 required for the pty"; exit 0; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/gaffer-colour.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT
export GAFFER_DATA="$WORK/data"; mkdir -p "$GAFFER_DATA"
unset NO_COLOR
export TERM=xterm-256color

# Run argv under a pseudo-terminal (stdout AND stderr are the tty); print what it wrote.
cat > "$WORK/ttyrun.py" <<'PY'
import os, pty, subprocess, sys
m, s = pty.openpty()
p = subprocess.Popen(sys.argv[1:], stdin=subprocess.DEVNULL, stdout=s, stderr=s, close_fds=True)
os.close(s)
out = b""
while True:
    try:
        d = os.read(m, 65536)
    except OSError:
        break
    if not d:
        break
    out += d
p.wait()
sys.stdout.buffer.write(out)
PY
on_tty() { python3 -I "$WORK/ttyrun.py" "$@"; }
has_esc() { case "$1" in *$'\033'*) return 0 ;; *) return 1 ;; esac; }

# Stub data sources so status.sh / run-summary.sh run hermetically (status.test.sh's seams).
mk() { printf '#!/usr/bin/env bash\nprintf "%%s\\n" %q\n' "$2" > "$WORK/$1"; chmod +x "$WORK/$1"; }
mk doc.sh "Healthy."
mk stats.sh '{"ticketsByStatus":{"in_review":1,"blocked":0,"ready":2}}'
mk list.sh '[]'
mk empty.sh ''
printf '{"ts":"2099-01-01T00:00:00Z","category":"secret-read"}\n' > "$GAFFER_DATA/safety-blocks.jsonl"
STATUS_ENV=(env WG_DOCTOR_CMD="$WORK/doc.sh" FG_DOCTOR_CMD="$WORK/doc.sh" LG_DOCTOR_CMD="$WORK/doc.sh"
  STATS_CMD="$WORK/stats.sh" REPOS_CMD="$WORK/empty.sh" HUMAN_QUEUE_CMD="$WORK/empty.sh"
  STATUS_TICKETS_CMD="$WORK/list.sh" GAFFER_LOG="$WORK/factory.log" DASHBOARD_PROBE_URL="http://127.0.0.1:9/healthz")
SUMMARY_ENV=(env SUMMARY_LIST_CMD="$WORK/list.sh" SUMMARY_SHOW_CMD="$WORK/empty.sh")

check() {  # check <label> <cmd…>
  local label="$1"; shift
  local out
  out="$(on_tty "$@" 2>&1)"
  has_esc "$out" && ok "$label: coloured on a tty" || fail "$label: no colour on a tty: $(printf '%s' "$out" | head -3)"
  out="$("$@" 2>&1 | cat)"
  has_esc "$out" && fail "$label: escape codes in a pipe: $(printf '%s' "$out" | grep -m1 $'\033' | cat -v)" || ok "$label: plain text in a pipe"
  out="$(NO_COLOR=1 on_tty "$@" 2>&1)"
  has_esc "$out" && fail "$label: escape codes under NO_COLOR=1: $(printf '%s' "$out" | grep -m1 $'\033' | cat -v)" || ok "$label: plain under NO_COLOR=1"
  out="$(TERM=dumb on_tty "$@" 2>&1)"
  has_esc "$out" && fail "$label: escape codes under TERM=dumb: $(printf '%s' "$out" | grep -m1 $'\033' | cat -v)" || ok "$label: plain under TERM=dumb"
}

echo "== gaffer (say / ok / warn) =="
check "gaffer skills list" bash "$RUNNER_DIR/gaffer" skills list
echo "== gaffer err() on stderr =="
out="$(bash "$RUNNER_DIR/gaffer" no-such-command 2>&1 | cat)"
has_esc "$out" && fail "gaffer error on stderr carries escape codes in a pipe" || ok "gaffer error on stderr: plain text in a pipe"
out="$(on_tty bash "$RUNNER_DIR/gaffer" no-such-command)"
has_esc "$out" && ok "gaffer error on a tty stderr is coloured" || fail "gaffer error on a tty: no colour"
echo "== status.sh =="
check "gaffer status" "${STATUS_ENV[@]}" bash "$RUNNER_DIR/status.sh"
echo "== run-summary.sh (+ json-tool's safety report) =="
check "run summary" "${SUMMARY_ENV[@]}" bash "$RUNNER_DIR/run-summary.sh"
out="$("${SUMMARY_ENV[@]}" bash "$RUNNER_DIR/run-summary.sh" 2>&1 | cat)"
case "$out" in *"secret-read attempt(s) blocked"*) ok "the json-tool safety report ran (and is covered above)" ;; *) fail "safety report did not run: $out" ;; esac

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "gaffer-colour: ALL $PASS checks passed"; exit 0; fi
echo "gaffer-colour: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
