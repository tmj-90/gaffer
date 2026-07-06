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
# B-H3: the review + clarify passes were extracted from tick.sh into these libs
# (sourced by tick.sh). The prompt-wiring guarantees now live in the lib files.
REVIEW_SH="$HERE/../lib/review.sh"
CLARIFY_SH="$HERE/../lib/clarify.sh"
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
# Assert a FIXED string is present in file $2.  usage: has <label> <file> <needle>
has() { if grep -qF -- "$3" "$2"; then ok "$1"; else no "$1"; fi; }
# Assert an EXTENDED-regex pattern is ABSENT from file $2. usage: hasnt <label> <file> <pattern>
hasnt() { if grep -qE -- "$3" "$2"; then no "$1"; else ok "$1"; fi; }

# Review prompt: heredoc + cards appended; usage-json is output-only.
has "RPROMPT is built as a heredoc (<<EOF)" "$REVIEW_SH" "read -r -d '' RPROMPT <<EOF"
has 'review cards appended to RPROMPT' "$REVIEW_SH" 'RPROMPT="${RPROMPT}${_REVIEW_CARDS}"'
hasnt "RPROMPT is never read from a usage-json file" "$REVIEW_SH" 'RPROMPT[^=]*<[[:space:]]*"?\$R_USAGE_JSON'
hasnt "R_USAGE_JSON is never used as stdin (output capture only)" "$REVIEW_SH" '[^>:][[:space:]]*<[[:space:]]*"?\$R_USAGE_JSON'

# Clarify prompt: same guarantees.
has "CPROMPT is built as a heredoc (<<EOF)" "$CLARIFY_SH" "read -r -d '' CPROMPT <<EOF"
has 'clarify cards appended to CPROMPT' "$CLARIFY_SH" 'CPROMPT="${CPROMPT}${_CLARIFY_CARDS}"'
hasnt "CPROMPT is never read from a usage-json file" "$CLARIFY_SH" 'CPROMPT[^=]*<[[:space:]]*"?\$C_USAGE_JSON'
hasnt "C_USAGE_JSON is never used as stdin (output capture only)" "$CLARIFY_SH" '[^>:][[:space:]]*<[[:space:]]*"?\$C_USAGE_JSON'

for _f in "$TICK" "$REVIEW_SH" "$CLARIFY_SH"; do
  if bash -n "$_f"; then ok "$(basename "$_f") parses (bash -n)"; else no "$(basename "$_f") parses (bash -n)"; fi
done

echo "tick-prompt-wiring: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
