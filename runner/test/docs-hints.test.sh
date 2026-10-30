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

# Hints the runner PRINTS live in its scripts; the rest in the docs.
SCRIPTS=("$RUNNER_DIR"/*.sh "$RUNNER_DIR/gaffer")
MDS=("$ROOT/README.md" "$ROOT/quickstart.md" "$RUNNER_DIR/ONBOARDING.md" "$RUNNER_DIR/RUNBOOK.md" "$RUNNER_DIR/README.md")

echo "== next-step hints use the front door, not cwd-relative scripts =="
# `bash loop.sh` / `bash demo.sh` only work from inside runner/ — printed by preflight
# and demo (which run from anywhere) they failed. A path (runner/loop.sh) is fine.
bad="$(grep -nHE '(^|[^/A-Za-z0-9_.-])bash (loop|demo|setup|preflight)\.sh' "${SCRIPTS[@]}" "${MDS[@]}" 2>/dev/null || true)"
[ -z "$bad" ] && ok "no bare 'bash loop|demo|setup|preflight.sh' hint (use runner/gaffer …)" \
  || fail "cwd-relative script hint:
$bad"
# `dispatch` is not a command on PATH; the factory's CLI is `gaffer wg`.
bad="$(grep -nHE '(^|[`( ])dispatch ticket (show|create|ready)' "${SCRIPTS[@]}" "${MDS[@]}" 2>/dev/null || true)"
[ -z "$bad" ] && ok "no bare 'dispatch ticket …' hint (dispatch is not on PATH)" || fail "bare dispatch hint:
$bad"
# The dashboard reads the db on every request; a restart is never needed to see a repo.
bad="$(grep -nHiE -- '--restart` to see|--restart to refresh|reads the db at startup' "${SCRIPTS[@]}" "${MDS[@]}" 2>/dev/null || true)"
[ -z "$bad" ] && ok "no 'restart the dashboard to see the repo' hint" || fail "stale restart hint:
$bad"

echo "== every fenced bash block in the docs parses =="
# Fences (and a blockquote's "> ") stripped, <placeholder> tokens replaced; ONBOARDING's
# snippet used to end inside an unclosed $( … ).
blocks() {
  awk '
    { line = $0; sub(/^> ?/, "", line) }
    !inb && line ~ /^[[:space:]]*```(bash|sh|shell)[[:space:]]*$/ { inb = 1; start = FNR; body = ""; next }
    inb && line ~ /^[[:space:]]*```[[:space:]]*$/ { inb = 0; printf "%s:%d\n%s%c", FILENAME, start, body, 0; next }
    inb { gsub(/<[A-Za-z][A-Za-z0-9_|. -]*>/, "X", line); body = body line "\n" }
  ' "$@"
}
nblk=0; bad=""
while IFS= read -r -d '' blk; do
  nblk=$((nblk + 1))
  err="$(printf '%s' "${blk#*$'\n'}" | bash -n 2>&1)" || bad="$bad${blk%%$'\n'*}: $err"$'\n'
done < <(blocks "${MDS[@]}")
[ "$nblk" -gt 10 ] && ok "found $nblk bash blocks to check" || fail "only $nblk bash blocks found (extractor broken?)"
[ -z "$bad" ] && ok "every bash block passes bash -n" || fail "bash blocks that do not parse:
$bad"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "docs-hints: ALL $PASS checks passed"
  exit 0
fi
echo "docs-hints: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
