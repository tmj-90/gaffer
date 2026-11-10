# shellcheck shell=bash
# runner/test/lib/principal.sh: A PERSON'S ACT IN A TEST (package H1). A person's tester
# verdict (a waiver, or a person's FAIL) is accepted only for an active human or admin
# principal's token, so a test that records one mints a principal once and runs the verb
# with its token, exactly as a person does:
#   gaffer_test_principal_token [name] [--admin]  → prints the token (minted once per name)
#   gaffer_test_as_person <wg args…>              → `wg <args>` with that token
# Needs `wg` (the config's shell function, or a test's own) pointed at the test's DB.
# bash 3.2: no associative arrays; the token is kept in a file under the test's work dir.

_gaffer_test_principal_dir() { printf '%s' "${GAFFER_DATA:-${TMPDIR:-/tmp}}/.test-principals"; }

gaffer_test_principal_token() {
  local name="${1:-person}" dir file out
  shift 2>/dev/null || true
  dir="$(_gaffer_test_principal_dir)"; file="$dir/$name"
  if [ -s "$file" ]; then cat "$file"; return 0; fi
  mkdir -p "$dir" || return 1
  out="$(wg principal create "$name" "$@" 2>"$dir/.$name.err")" || { printf 'principal create %s failed: %s\n' "$name" "$(cat "$dir/.$name.err")" >&2; return 1; }
  printf '%s' "$out" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);if(!j.token)process.exit(1);process.stdout.write(j.token)})' > "$file" || return 1
  cat "$file"
}

gaffer_test_as_person() {
  local token
  token="$(gaffer_test_principal_token "${GAFFER_TEST_PERSON:-person}")" || return 1
  GAFFER_PRINCIPAL_TOKEN="$token" wg "$@"
}
