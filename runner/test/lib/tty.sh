# shellcheck shell=bash
# gaffer_test_tty <cmd> [args...] — run a command with its stdout on a pseudo-terminal
# (so `[ -t 1 ]` holds inside it) and print what it wrote; returns the command's exit
# status. Uses util-linux `script -qec` or the BSD/macOS `script -q /dev/null`. Returns
# 77 without running anything when no `script` is available (the caller skips).
gaffer_test_tty_available() { command -v script >/dev/null 2>&1; }
gaffer_test_tty() {
  gaffer_test_tty_available || return 77
  local cmd="" a
  for a in "$@"; do cmd+="$(printf '%q ' "$a")"; done
  if script --version 2>/dev/null | grep -q util-linux; then
    script -qec "$cmd" /dev/null </dev/null | tr -d '\r'
    return "${PIPESTATUS[0]}"
  fi
  script -q /dev/null bash -c "$cmd" </dev/null | tr -d '\r'
  return "${PIPESTATUS[0]}"
}
