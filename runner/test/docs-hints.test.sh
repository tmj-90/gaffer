#!/usr/bin/env bash
# =====================================================================
# Copy-paste hints in the docs and the runner's own output must work.
# ---------------------------------------------------------------------
# Each check is a dead end a new user hit:
#   • a bare `node packages/dispatch/dist/cli/index.js …` with no --db reaches
#     ./.dispatch (a new, empty database in the cwd), not the factory's — the
#     quickstart's set-reviewer snippet answered NOT_FOUND that way.
# Run: bash test/docs-hints.test.sh   (bash 3.2 safe)
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"

PASS=0; FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

# The user-facing docs (CHANGELOG.md records history and is left as written).
DOCS=("$ROOT/README.md" "$ROOT/quickstart.md" "$ROOT/CONTRIBUTING.md" "$RUNNER_DIR"/*.md "$ROOT"/docs/*.md)

echo "== dispatch CLI snippets name a database =="
bad="$(grep -nH 'dispatch/dist/cli/index\.js' "${DOCS[@]}" 2>/dev/null \
  | grep -v -- '--db' | grep -vE 'dist/cli/index\.js`|at packages/dispatch/dist/cli/index\.js' || true)"
[ -z "$bad" ] && ok "no bare dispatch CLI call without --db (use runner/gaffer wg)" \
  || fail "dispatch CLI call without --db (hits ./.dispatch):
$bad"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "docs-hints: ALL $PASS checks passed"
  exit 0
fi
echo "docs-hints: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
