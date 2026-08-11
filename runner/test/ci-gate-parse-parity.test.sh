#!/usr/bin/env bash
# =====================================================================
# LOAD-BEARING byte-identity test for the CI-gate check-status parser strangler
# port (P4). Mirrors the dod-distill / minimalism parity tests.
# ---------------------------------------------------------------------
# gaffer_parse_checks maps a tab-separated checks table into ONE verdict
# (unknown / fail:<name>|<url> / pending / pass) the CI gate acts on. This drives
# the WIRED function BOTH ways (GAFFER_RUNTIME=bash — the legacy awk; =ts — the
# seam through ciGateCli.js) on the SAME corpus and asserts the verdict is
# byte-identical (the whole $(...) capture). A drift here could mis-gate a
# delivery (pass a red PR, or block a green one), so the bash oracle pins it.
#
# LC_ALL=C pins awk tolower() to ASCII across the ubuntu+macOS matrix.
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
# shellcheck source=../lib/ci-gate.sh
source "$RUNNER_DIR/lib/ci-gate.sh"

pass=0
fail=0
ok() { echo "  ok   $1"; pass=$((pass + 1)); }
no() { echo "  FAIL $1"; fail=$((fail + 1)); }

pc() {
  local label="$1" data="$2" b t
  b="$(GAFFER_RUNTIME=bash gaffer_parse_checks "$data")"
  t="$(GAFFER_RUNTIME=ts CREW_DIR="$CREW_DIR" gaffer_parse_checks "$data")"
  [ "$b" = "$t" ] && ok "$label — bash and ts agree ([$b])" || no "$label — bash=[$b] ts=[$t]"
}

pc "empty → unknown"          ""
pc "all pass"                 "$(printf 'build\tsuccess\tsuccess\thttp://x\ntest\tcompleted\tsuccess\thttp://y')"
pc "one failing (conclusion)" "$(printf 'build\tcompleted\tsuccess\thttp://x\ntest\tcompleted\tfailure\thttp://y/test')"
pc "error in status column"   "$(printf 'lint\terror\t\thttp://z')"
pc "pending (in_progress)"    "$(printf 'build\tin_progress\t\thttp://x\ntest\tqueued\t\thttp://y')"
pc "waiting → pending"        "$(printf 'deploy\twaiting\t\thttp://d')"
pc "fail wins over pending"   "$(printf 'a\tpending\t\tu1\nb\tcompleted\tfailure\tu2')"
pc "first failing row wins"   "$(printf 'a\tcompleted\tfailure\tu1\nb\tcompleted\terror\tu2')"
pc "failing, no url column"   "$(printf 'build\tcompleted\tfailure')"
pc "failing, empty name → unknown" "$(printf '\tfailure\t\thttp://x')"
pc "mixed-case status (tolower)"   "$(printf 'build\tFAILURE\t\thttp://x')"

echo ""
echo "ci-gate-parse-parity: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
