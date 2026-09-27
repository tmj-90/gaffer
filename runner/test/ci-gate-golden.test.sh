#!/usr/bin/env bash
# =====================================================================
# CI-CHECK PARSE — gaffer_parse_checks (lib/ci-gate.sh) runs the typed parser
# (packages/crew ciGateCli.js parse-checks) and its verdict tokens are pinned to
# fixtures/typed-seams/ci-gate/<case>.txt, captured from the bash implementation
# the CLI replaced (proven byte-identical by the former parity test). A missing
# crew build FAILS CLOSED (non-zero, nothing on stdout) instead of guessing.
# LC_ALL=C pins byte semantics across the ubuntu + macOS matrix.
# Run: bash runner/test/ci-gate-golden.test.sh      (SEAM_GOLDEN_CAPTURE=1 to re-pin)
# =====================================================================
set -uo pipefail
export LC_ALL=C LC_CTYPE=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
CREW_DIR="$ROOT/packages/crew"
CLI="$CREW_DIR/dist/runtime/ci/ciGateCli.js"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
[ -f "$CLI" ] || { echo "SKIP: crew not built ($CLI) — run pnpm -C packages/crew build"; exit 0; }
log() { :; }
# shellcheck source=../lib/ci-gate.sh
source "$RUNNER_DIR/lib/ci-gate.sh"
# shellcheck source=lib/seam-golden.sh
source "$HERE/lib/seam-golden.sh"
export CREW_DIR
pass=0; fail=0
ok() { echo "  ok   $1"; pass=$((pass + 1)); }
no() { echo "  FAIL $1"; fail=$((fail + 1)); }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ci-gate-golden.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT

pc() {
  local name="$1" label="$2" data="$3"
  gaffer_parse_checks "$data" > "$WORK/out" 2>/dev/null
  seam_golden ci-gate "$name" "$WORK/out" "$label"
}
pc empty            "empty → unknown"             ""
pc all-pass         "all pass"                    "$(printf 'build\tsuccess\tsuccess\thttp://x\ntest\tcompleted\tsuccess\thttp://y')"
pc one-failing      "one failing (conclusion)"    "$(printf 'build\tcompleted\tsuccess\thttp://x\ntest\tcompleted\tfailure\thttp://y/test')"
pc error-status     "error in status column"      "$(printf 'lint\terror\t\thttp://z')"
pc pending          "pending (in_progress)"       "$(printf 'build\tin_progress\t\thttp://x\ntest\tqueued\t\thttp://y')"
pc waiting          "waiting → pending"           "$(printf 'deploy\twaiting\t\thttp://d')"
pc fail-over-pending "fail wins over pending"     "$(printf 'a\tpending\t\tu1\nb\tcompleted\tfailure\tu2')"
pc first-failing    "first failing row wins"      "$(printf 'a\tcompleted\tfailure\tu1\nb\tcompleted\terror\tu2')"
pc failing-no-url   "failing, no url column"      "$(printf 'build\tcompleted\tfailure')"
pc failing-no-name  "failing, empty name → unknown" "$(printf '\tfailure\t\thttp://x')"
pc mixed-case       "mixed-case status (tolower)" "$(printf 'build\tFAILURE\t\thttp://x')"

# Fail closed without the typed CLI: no verdict is ever invented.
out="$(CREW_DIR="$WORK/nope" gaffer_parse_checks "$(printf 'build\tcompleted\tsuccess\thttp://x')" 2>/dev/null)"; rc=$?
[ "$rc" -ne 0 ] && [ -z "$out" ] && ok "missing crew dist → non-zero, no verdict (fail closed)" || no "missing dist: rc=$rc out='$out'"

echo ""; echo "ci-gate-golden: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
