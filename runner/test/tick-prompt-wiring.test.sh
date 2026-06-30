#!/usr/bin/env bash
# Proves the review + clarify agent prompts are built as HEREDOCS (with file
# cards appended), and that the per-run usage-JSON files are OUTPUT captures
# only -- never read back in as the prompt.
#
# This refutes a recurring GitHub-raw misrender of the `<<EOF` heredocs as
# `read -r -d '' RPROMPT < "$R_USAGE_JSON"`, and guards against a real
# regression to that (genuinely broken) shape.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TICK="$HERE/../tick.sh"
pass=0
fail=0
ok() {
  echo "  ok   $1"
  pass=$((pass + 1))
}
no() {
  echo "  FAIL $1"
  fail=$((fail + 1))
}
# Assert a FIXED string is present in tick.sh.
has() { if grep -qF -- "$2" "$TICK"; then ok "$1"; else no "$1"; fi; }
# Assert an EXTENDED-regex pattern is ABSENT from tick.sh.
hasnt() { if grep -qE -- "$2" "$TICK"; then no "$1"; else ok "$1"; fi; }

# Review prompt: heredoc + cards appended; usage-json is output-only.
has "RPROMPT is built as a heredoc (<<EOF)" "read -r -d '' RPROMPT <<EOF"
has 'review cards appended to RPROMPT' 'RPROMPT="${RPROMPT}${_REVIEW_CARDS}"'
hasnt "RPROMPT is never read from a usage-json file" 'RPROMPT[^=]*<[[:space:]]*"?\$R_USAGE_JSON'
hasnt "R_USAGE_JSON is never used as stdin (output capture only)" '[^>:][[:space:]]*<[[:space:]]*"?\$R_USAGE_JSON'

# Clarify prompt: same guarantees.
has "CPROMPT is built as a heredoc (<<EOF)" "read -r -d '' CPROMPT <<EOF"
has 'clarify cards appended to CPROMPT' 'CPROMPT="${CPROMPT}${_CLARIFY_CARDS}"'
hasnt "CPROMPT is never read from a usage-json file" 'CPROMPT[^=]*<[[:space:]]*"?\$C_USAGE_JSON'
hasnt "C_USAGE_JSON is never used as stdin (output capture only)" '[^>:][[:space:]]*<[[:space:]]*"?\$C_USAGE_JSON'

if bash -n "$TICK"; then ok "tick.sh parses (bash -n)"; else no "tick.sh parses (bash -n)"; fi

echo "tick-prompt-wiring: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
