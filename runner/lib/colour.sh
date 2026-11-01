# shellcheck shell=bash
# Terminal colour for the operator-facing scripts (runner/gaffer, status.sh,
# run-summary.sh, preflight.sh, demo.sh). Colour is for a person at a terminal:
# piped into a file, `tee`, `grep` or a CI log the escape codes were noise, and
# NO_COLOR / TERM=dumb were ignored. The rule (https://no-color.org):
#   no colour when the stream is not a tty, when NO_COLOR is set to anything
#   non-empty, or when TERM is "dumb".
# bash 3.2 safe; sourcing it has no side effects beyond defining the names below.

# gaffer_colour_on [fd] — 0 when output on fd (default 1, stdout) may be coloured.
gaffer_colour_on() {
  [ -n "${NO_COLOR:-}" ] && return 1
  [ "${TERM:-}" = "dumb" ] && return 1
  [ -t "${1:-1}" ]
}

# gaffer_colours [fd] — set c_grn c_cya c_yel c_red c_dim c_bold c_off for printf
# FORMAT strings (they hold `\033[…m`, which printf expands), all empty when
# gaffer_colour_on says no.
gaffer_colours() {
  if gaffer_colour_on "${1:-1}"; then
    c_grn='\033[1;32m'; c_cya='\033[1;36m'; c_yel='\033[1;33m'; c_red='\033[1;31m'
    c_dim='\033[2m'; c_bold='\033[1m'; c_off='\033[0m'
  else
    c_grn=''; c_cya=''; c_yel=''; c_red=''; c_dim=''; c_bold=''; c_off=''
  fi
}
