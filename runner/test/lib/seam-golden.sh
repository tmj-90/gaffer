# Golden-fixture helper for the typed-seam tests (sourced by runner/test/*-golden.test.sh).
# shellcheck shell=bash
#
# The runner's text-processing seams (prompt / MCP / context renders, DoD distill,
# minimalism, hygiene forbidden paths, CI-check parse, worktree key) run through
# packages/crew's typed CLIs. Their outputs are pinned to checked-in fixtures under
# runner/test/fixtures/typed-seams/<seam>/<case>.txt — captured from the bash
# implementations the CLIs replaced (proven byte-identical by the former parity
# tests), so a behaviour change is a visible fixture diff, never a silent drift.
#
#   seam_golden <seam> <case> <actual-file> [label]
#     compares <actual-file> with the fixture (cmp -s); reports ok/FAIL.
#   SEAM_GOLDEN_CAPTURE=1 bash runner/test/<seam>-golden.test.sh
#     (re)writes the fixtures from the current output instead of comparing —
#     for an INTENDED change only; review the fixture diff like code.
#
# Requires the caller to define ok()/no() and $HERE (the test dir).

SEAM_FIXTURES="${SEAM_FIXTURES:-$HERE/fixtures/typed-seams}"

seam_golden() {
  local seam="$1" name="$2" actual="$3" label="${4:-$2}"
  local dir="$SEAM_FIXTURES/$seam" file
  file="$dir/$name.txt"
  if [ "${SEAM_GOLDEN_CAPTURE:-0}" = "1" ]; then
    mkdir -p "$dir"
    cp "$actual" "$file"
    ok "$label — captured → fixtures/typed-seams/$seam/$name.txt"
    return 0
  fi
  if [ ! -f "$file" ]; then
    no "$label — fixture missing: fixtures/typed-seams/$seam/$name.txt (run with SEAM_GOLDEN_CAPTURE=1 after reviewing the change)"
    return 1
  fi
  if cmp -s "$actual" "$file"; then
    ok "$label — matches the golden"
  else
    echo "----- diff (golden left, actual right) -----" >&2
    diff "$file" "$actual" >&2 || true
    no "$label — DIVERGED from fixtures/typed-seams/$seam/$name.txt"
    return 1
  fi
}
