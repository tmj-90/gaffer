#!/usr/bin/env bash
# =====================================================================
# gaffer_json_vars (runner/config/17-cli.sh) and `json-tool.mjs fields`: several jget
# reads of ONE document in one node process.
# ---------------------------------------------------------------------
# The tick reads many fields of the same ticket view back to back; each read was its
# own node process. gaffer_json_vars must give every variable EXACTLY what the separate
#   VAR="$(printf '%s' "$JSON" | jget '<expr>' 2>/dev/null || echo '<default>')"
# gave, for any ticket text, and never run ticket text as shell:
#   J1  hostile values (quotes, $, backticks, tabs, newlines, trailing newlines, a NUL,
#       ANSI colour, unicode, a leading dash, an empty string, null, numbers, objects)
#       come back byte for byte as the separate reads give them, and nothing in them runs;
#   J2  a document that does not parse, an expression that throws, and a helper that
#       prints nothing give each variable its default (as `|| echo <default>` did);
#   J3  a caller's local variable is assigned (not a global), and a global when none;
#   J4  a malformed argument list assigns nothing and returns 2;
#   J5  it starts one node process for any number of fields.
# Run: bash runner/test/json-fields.test.sh   (bash 3.2 safe)
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
. "$HERE/lib/tmpdir.sh"
. "$HERE/lib/skip.sh"
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
command -v node >/dev/null 2>&1 || gaffer_skip "node required"

PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
WORK="$(gaffer_test_tmpdir json-fields)" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT
export GAFFER_DATA="$WORK/data"; mkdir -p "$GAFFER_DATA"
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
declare -F gaffer_json_vars >/dev/null || { echo "FAIL gaffer_json_vars is not defined"; exit 1; }

PWNED="$WORK/pwned"
# The title tries every way out of a quote: a command substitution, backticks, a quote
# break, a here-string, a newline then a command.
TITLE_RAW="Fix \"auth\" for \$HOME \$(touch $PWNED) \`touch $PWNED\` ' ; touch $PWNED ; '"$'\t'"tab"$'\n'"rm -rf / # nope"$'\n\n'
DOC="$(TITLE="$TITLE_RAW" PW="$PWNED" node -e '
const t = process.env.TITLE;
process.stdout.write(JSON.stringify({
  ticket: { title: t, description: "-n leading dash\\\\ back\\\\slash", risk_level: null, n: 7, f: 1.5,
            nul: "a\u0000b", ansi: "\u001b[31mred\u001b[0m plain", uni: "café ☃ 😀",
            empty: "", trail: "x\n\n\n", obj: { a: [1, "two"] }, yes: true },
  repositories: [ { access: "read", local_path: "/r/read" }, { access: "write", local_path: "/r/w $(x)", name: "w" } ],
}));')"

# The expressions under test, and a default for each.
EXPRS=(
  'd.ticket.title' ''
  'd.ticket.description' ''
  'd.ticket.risk_level || "medium"' medium
  'd.ticket.risk_level' 'unused-default'
  'd.ticket.n + 1' 0
  'd.ticket.f' 0
  'd.ticket.nul' ''
  'd.ticket.ansi' ''
  'd.ticket.uni' ''
  'd.ticket.empty' 'x'
  'd.ticket.trail' ''
  'd.ticket.obj' ''
  'd.ticket.yes' ''
  'd.ticket.missing.deeper' 'dflt'
  '((d.repositories||[]).find(r => r.access === "write") || {}).local_path' ''
  'd.repositories.length' 0
)
separate() {  # <json> <expr> <default>: what the separate read gives (NULs dropped by bash)
  local v
  v="$(printf '%s' "$1" | jget "$2" 2>/dev/null || echo "$3")" 2>/dev/null
  printf '%s' "$v"
}

echo "== J1: hostile values, byte for byte =="
args=(); names=(); i=0
while [ "$i" -lt "${#EXPRS[@]}" ]; do
  names+=("V$i"); args+=("V$i" "${EXPRS[$i]}" "${EXPRS[$((i + 1))]}"); i=$((i + 2))
done
gaffer_json_vars "$DOC" "${args[@]}"; rc=$?
[ "$rc" = 0 ] && ok "J1: returned 0" || fail "J1: rc=$rc"
i=0; bad=0
while [ "$i" -lt "${#EXPRS[@]}" ]; do
  n="V$i"; want="$(separate "$DOC" "${EXPRS[$i]}" "${EXPRS[$((i + 1))]}" 2>/dev/null; printf '.')"; want="${want%.}"
  got="${!n}"
  if [ "$got" != "$want" ]; then
    bad=$((bad + 1)); fail "J1: ${EXPRS[$i]}: got [$(printf '%s' "$got" | od -c | head -2 | tr '\n' ' ')] want [$(printf '%s' "$want" | od -c | head -2 | tr '\n' ' ')]"
  fi
  i=$((i + 2))
done
[ "$bad" = 0 ] && ok "J1: all $(( ${#EXPRS[@]} / 2 )) fields equal the separate jget reads" || :
[ "$V0" = "${TITLE_RAW%$'\n\n'}" ] && ok "J1: the hostile title came back as data (trailing newlines stripped as \$(...) does)" || fail "J1: title [$V0]"
[ "$V12" = "ab" ] && ok "J1: a NUL inside a value is dropped, as a command substitution drops it" || fail "J1: nul [$V12]"
[ "$V14" = "red plain" ] && ok "J1: colour codes are stripped as jget strips them in a pipe" || fail "J1: ansi [$V14]"
[ ! -e "$PWNED" ] && ok "J1: nothing in the values ran" || fail "J1: a value was executed ($PWNED exists)"

echo "== J2: defaults =="
gaffer_json_vars 'not json {' A 'd.a' 'da' B 'd.b' '' C 'd.c' $'multi\nline\n\n'
[ "$A" = da ] && [ -z "$B" ] && [ "$C" = $'multi\nline' ] && ok "J2: an unparseable document gives every default (trailing newlines stripped)" || fail "J2: A=[$A] B=[$B] C=[$C]"
gaffer_json_vars '{"a":1}' A 'd.a' 'x' B 'd.nope.deeper' 'fallback' C '(() => { throw new Error("x") })()' 'thrown'
[ "$A" = 1 ] && [ "$B" = fallback ] && [ "$C" = thrown ] && ok "J2: a throwing expression gives its own default, the others their values" || fail "J2: A=[$A] B=[$B] C=[$C]"
gaffer_json_vars '' A 'd.a' 'empty-doc'
[ "$A" = empty-doc ] && ok "J2: an empty document gives the default" || fail "J2: A=[$A]"
(
  gaffer_json() { :; }   # a helper that prints nothing (it did not run)
  gaffer_json_vars '{"a":1}' A 'd.a' 'when-silent' B 'd.a' ''
  [ "$A" = when-silent ] && [ -z "$B" ] && echo OK || echo "FAIL A=[$A] B=[$B]"
) > "$WORK/silent.out"
grep -q '^OK$' "$WORK/silent.out" && ok "J2: a helper that prints nothing gives every default" || fail "J2: $(cat "$WORK/silent.out")"

echo "== J3: where the variables land =="
G1=global-before
caller() { local L1="local-before"; gaffer_json_vars '{"x":"set"}' L1 'd.x' '' G1 'd.x' ''; printf '%s' "$L1"; }
inner="$(caller)"; caller >/dev/null
[ "$inner" = set ] && ok "J3: the caller's local was assigned" || fail "J3: local=[$inner]"
[ "$G1" = set ] && ok "J3: a name with no local is assigned globally" || fail "J3: global=[$G1]"

echo "== J4: a malformed argument list =="
Z=keep
gaffer_json_vars '{"a":1}' Z 'd.a'; rc=$?
[ "$rc" = 2 ] && [ "$Z" = keep ] && ok "J4: a missing default returns 2 and assigns nothing" || fail "J4: rc=$rc Z=$Z"
gaffer_json_vars '{"a":1}'; rc=$?
[ "$rc" = 2 ] && ok "J4: no fields returns 2" || fail "J4: rc=$rc"

echo "== J5: one process =="
(
  # gaffer_json runs in a subshell (a process substitution): count through a file.
  node() { echo x >> "$WORK/count.log"; command node "$@"; }
  : > "$WORK/count.log"
  gaffer_json_vars "$DOC" "${args[@]}"
  wc -l < "$WORK/count.log" | tr -d ' '
) > "$WORK/count.out"
[ "$(cat "$WORK/count.out")" = 1 ] && ok "J5: $(( ${#EXPRS[@]} / 2 )) fields cost one node process" || fail "J5: $(cat "$WORK/count.out") node processes"

echo
echo "json-fields: $PASS passed, ${#FAILURES[@]} failed"
[ "${#FAILURES[@]}" -eq 0 ]
