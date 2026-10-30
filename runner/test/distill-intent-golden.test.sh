#!/usr/bin/env bash
# =====================================================================
# TICKET → LORE DISTILLATION — distillIntentCli.js (the live close path)
# ---------------------------------------------------------------------
# tick.sh gaffer_distill_ticket_intent renders the requirement draft through
# crew's distillIntentCli.js → distillTicketIntent (context/ticketIntent.ts), the
# single source of the text. The fixtures were captured from the json-tool.mjs
# `distill-intent` case the CLI replaced, so these cases prove the cutover is
# byte-identical for the live path: normal ACs, blank / whitespace ACs dropped,
# all-blank ACs → nothing, an over-long summary truncated, unparseable SHOW →
# nothing (exit 0).
#
# Run: bash runner/test/distill-intent-golden.test.sh   (SKIPs without the crew build)
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
# DISTILL_CLI: a capture seam (point it at another implementation to re-record).
CLI="${DISTILL_CLI:-$ROOT/packages/crew/dist/runtime/context/distillIntentCli.js}"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
[ -f "$CLI" ] || { echo "SKIP: crew not built ($CLI) — run pnpm -C packages/crew build"; exit 0; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/distill-intent-golden.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
pass=0; fail=0
ok() { echo "  ok   $1"; pass=$((pass + 1)); }
no() { echo "  FAIL $1"; fail=$((fail + 1)); }
# shellcheck source=lib/seam-golden.sh
source "$HERE/lib/seam-golden.sh"

distill_case() { # <case> <label> <SHOW> [title]
  local rc=0
  SHOW="$3" DTITLE="${4:-Add login}" DREPO=app DNUM=7 node "$CLI" > "$WORK/out.txt" 2>/dev/null || rc=$?
  [ "$rc" -eq 0 ] || { no "$2 — exited $rc (the distiller must be fail-soft)"; return; }
  seam_golden distill-intent "$1" "$WORK/out.txt" "$2"
}

distill_case normal "two ACs → one requirement line each" \
  '{"acceptanceCriteria":[{"text":"Login works","status":"pending"},{"text":"Logout works","status":"met"}]}'
distill_case blank-acs "blank / whitespace-only ACs are dropped and texts trimmed" \
  '{"acceptanceCriteria":[{"text":"  Login works  "},{"text":"   "},{"text":""},{}]}'
distill_case all-blank "only blank ACs → nothing to harvest (no output)" \
  '{"acceptanceCriteria":[{"text":"  "},{"text":""}]}'
distill_case no-acs "no ACs → no output" '{"acceptanceCriteria":[]}'
LONG="$(node -e 'process.stdout.write(JSON.stringify({acceptanceCriteria: Array.from({length: 30}, (_, i) => ({text: `criterion ${i} — the reset token must be single-use and expire`}))}))')"
distill_case long "an over-long summary is truncated with an ellipsis" "$LONG" \
  "A very long ticket title that keeps going well past what memory will accept for a lore title, on and on and on, with yet more words, and then some more, because titles in the wild do this sometimes"
distill_case unparseable "unparseable SHOW → nothing, exit 0" 'not json {'

echo
if [ "$fail" -eq 0 ]; then echo "PASS ($pass checks)"; exit 0; fi
echo "FAILED ($fail of $((pass + fail)))"; exit 1
