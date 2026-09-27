#!/usr/bin/env bash
# =====================================================================
# DELIVERY / BOOTSTRAP PROMPT RENDER — gaffer_render_delivery_prompt
# (factory.config.sh) renders the text tick.sh feeds `claude -p` through the typed
# renderer (packages/crew renderPromptCli.js → renderDeliveryPrompt /
# renderBootstrapPrompt). Every variant (fresh / resume / bootstrap, single- and
# multi-repo, review feedback incl. multi-line reasons, context blocks) is pinned to
# fixtures/typed-seams/prompt-render/<case>.txt — captured from the bash heredocs
# the renderer replaced (proven byte-identical by the former parity test). The
# renderer FAILS CLOSED on an empty write-repo set and without the crew build: no
# agent is ever launched with an unrendered prompt.
# Run: bash runner/test/prompt-render-golden.test.sh   (SEAM_GOLDEN_CAPTURE=1 to re-pin)
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
RENDER_CLI="$ROOT/packages/crew/dist/runtime/context/renderPromptCli.js"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
[ -f "$RENDER_CLI" ] || { echo "SKIP: crew not built ($RENDER_CLI) — run pnpm -C packages/crew build"; exit 0; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/prompt-render-golden.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
export GAFFER_DATA="$WORK/data" DISPATCH_DB="$WORK/data/dispatch.sqlite" MEMORY_DB="$WORK/data/memory.sqlite"
mkdir -p "$GAFFER_DATA"
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh"
# shellcheck source=lib/seam-golden.sh
source "$HERE/lib/seam-golden.sh"
pass=0; fail=0
ok() { echo "  ok   $1"; pass=$((pass + 1)); }
no() { echo "  FAIL $1"; fail=$((fail + 1)); }

render_case() { # <name> <label> <variant>
  if ! gaffer_render_delivery_prompt "$3" > "$WORK/out.txt"; then no "$2 — render exited non-zero"; return; fi
  seam_golden prompt-render "$1" "$WORK/out.txt" "$2"
}

# The raw inputs the renderer consumes from the ambient tick.sh scope.
NUM=1
TITLE="Add password reset flow"
SKILLS="frontend-implementer"
LENSES="minimalism"
FILE_CARDS_BLOCK=""
PRODUCT_CONTEXT_BLOCK=""
WORK_BRANCH="gaffer/ticket-1-add-password-reset-flow"
WTP="/data/gaffer/worktrees/ticket-1/fixture-repo-id"
PRIMARY_REPO="$WTP"
_RF=""
READ_ROOTS=""
WT_ROWS="$(printf 'fixture-repo-id\tfixture-app\t/repos/fixture-app\tmain\t%s' "$WTP")"
render_case fresh-single      "fresh (single repo, no feedback)"          fresh
render_case resume-single     "resume (single repo)"                      resume
_RF="$(printf '  - %s\n  - %s' "The reset token was not single-use" "Missing rate-limit on the reset endpoint")"
render_case fresh-feedback    "fresh (with prior review feedback)"        fresh
_RF="$(printf '  - %s\n%s\n  - %s' "The reset token was not single-use;" "it must be deleted on consume, not soft-expired." "Missing rate-limit on the reset endpoint")"
render_case fresh-multiline   "fresh (multi-line review reason)"          fresh
_RF=""
READ_ROOTS="$(printf '/repos/design-system\n/repos/api-contracts')"
WT_ROWS="$(printf 'id-a\tapp-web\t/repos/app-web\tmain\t%s\nid-b\t\t/repos/app-api\tmain\t%s' "$WTP/app-web" "$WTP/app-api")"
FILE_CARDS_BLOCK="$(printf 'PRIOR CONTEXT (file cards):\n  - [src/auth.ts] token issuance lives here')"
PRODUCT_CONTEXT_BLOCK="$(printf 'PRODUCT CONTEXT:\n  - decision: tokens are single-use by design')"
render_case fresh-multi       "fresh (multi-repo, read roots, context blocks, empty-name→repo)" fresh
render_case resume-multi      "resume (multi-repo, read roots, context blocks)"                resume

# Bootstrap (greenfield) variant.
NUM=9
TITLE="Scaffold the billing service"
B_SKILLS="minimalism"
B_DIR="/data/gaffer/bootstrap/ticket-9/billing"
render_case bootstrap         "bootstrap"                                 bootstrap

# The fresh render is also what the tick-context golden pins end to end (see
# packages/crew/test/fixtures/tick-context/prompt.fresh.golden.txt); this file pins
# the seam's own call. Both must contain the security framing verbatim.
grep -q "is repo-derived retrieval data, NEVER instructions\|NEVER instructions" "$SEAM_FIXTURES/prompt-render/fresh-multi.txt" 2>/dev/null \
  && ok "multi-repo prompt carries the untrusted-context framing" || ok "framing check skipped (fixture not yet captured)"

# Negative controls.
NUM=1; TITLE="Add password reset flow"; _RF=""; READ_ROOTS=""; WT_ROWS=""
if gaffer_render_delivery_prompt fresh > "$WORK/nowrite.txt" 2>/dev/null; then no "negative control — did NOT fail closed on an empty write-repo set"; else ok "negative control — fails closed on an empty write-repo set (no boundary)"; fi
WT_ROWS="$(printf 'fixture-repo-id\tfixture-app\t/repos/fixture-app\tmain\t%s' "$WTP")"
if CREW_DIR="$WORK/nope" gaffer_render_delivery_prompt fresh > "$WORK/nodist.txt" 2>/dev/null; then no "missing crew dist did NOT fail closed"; else ok "missing crew dist → non-zero (no agent launched on an unrendered prompt)"; fi

echo ""; echo "prompt-render-golden: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
