#!/usr/bin/env bash
# =====================================================================
# LOAD-BEARING byte-identity test (docs/tick-sh-runtime-migration.md P1b).
# ---------------------------------------------------------------------
# The PROMPT twin of runner/test/mcp-render-parity.test.sh. It drives the
# SINGLE prompt render seam gaffer_render_delivery_prompt (factory.config.sh)
# BOTH ways on the SAME inputs — the legacy bash heredocs (GAFFER_RUNTIME=bash,
# the live default) and the typed node renderer (GAFFER_RUNTIME=ts,
# renderPromptCli.js → renderDeliveryPrompt / renderBootstrapPrompt) — and
# asserts the two outputs are BYTE-IDENTICAL (cmp, incl. every blank context
# line, the quarantine envelopes, and the absence of a trailing newline).
# Because tick.sh's fresh / resume / bootstrap prompt paths ALL render through
# this same seam, byte parity here is byte parity live. This is the guard that
# stops the two prompt paths drifting.
#
# The bash branch consumes the PRE-RENDERED blocks tick.sh builds (TITLE_Q via
# gaffer_quarantine, WRITE_LIST/READ_LIST via awk, the review-feedback envelope,
# LORE_REFLECTION_NUDGE); the ts branch consumes the RAW inputs (TITLE, _RF,
# WT_ROWS, READ_ROOTS) and rebuilds those blocks inside the typed renderer. This
# test computes the pre-rendered blocks with the EXACT commands tick.sh uses
# (transcribed below), so a green run proves "tick.sh's bash blocks + heredoc" ≡
# "renderPromptCli from the raw inputs" — the property the live cutover rests on.
#
# The crew golden test (packages/crew/test/…) proves the TS render FUNCTION
# matches a bash-captured golden for the fresh delivery; this test proves the
# live node ENTRYPOINT + the live bash heredocs agree end to end for fresh,
# resume, bootstrap, review-feedback, multi-repo and read-root shapes — and that
# the ts branch FAILS CLOSED on a boundary-less (empty write-repo) prompt.
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
CREW_DIR="$ROOT/packages/crew"
RENDER_CLI="$CREW_DIR/dist/runtime/context/renderPromptCli.js"

command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 required"; exit 0; }
[ -f "$RENDER_CLI" ] || { echo "SKIP: crew not built ($RENDER_CLI) — run pnpm -C packages/crew build"; exit 0; }

# Source the seam + its quarantine helpers with the DB vars set (mirrors
# mcp-render-parity.test.sh / capture-context-golden.sh) so factory.config.sh's
# top-level defaults resolve without side effects.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/prompt-render-parity.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
export GAFFER_DATA="$WORK/data" DISPATCH_DB="$WORK/data/dispatch.sqlite" MEMORY_DB="$WORK/data/memory.sqlite"
mkdir -p "$GAFFER_DATA"
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh"
# CREW_DIR is what the seam's ts branch resolves the CLI from; pin it to this repo.
CREW_DIR="$CREW_DIR"

pass=0
fail=0
ok() { echo "  ok   $1"; pass=$((pass + 1)); }
no() { echo "  FAIL $1"; fail=$((fail + 1)); }

# The LORE_REFLECTION_NUDGE tick.sh appends to every delivery brief (tick.sh:1470).
read -r -d '' LORE_REFLECTION_NUDGE <<'NUDGE' || true
BEFORE STOPPING, reflect on WHY this was built this way. If this ticket established a
durable DECISION (why this approach over the alternatives), a REQUIREMENT (what it
needed), or a NON-GOAL (what it deliberately did NOT do), call the Memory `suggest_lore`
tool ONCE with an explicit `kind` (decision / requirement / non-goal). Capture only
intent the NEXT agent should start from — skip per-ticket trivia. This lands a gated
DRAFT a human approves; nothing is auto-applied.
NUDGE

# build_delivery_blocks: given the RAW ambient inputs (NUM, TITLE, WORK_BRANCH,
# WT_ROWS, READ_ROOTS, _RF), compute the PRE-RENDERED blocks the bash branch reads,
# using the SAME commands tick.sh uses (tick.sh:1375–1410, 1479). Leaves TITLE_Q,
# WRITE_LIST, READ_LIST, REVIEW_FEEDBACK_BLOCK set in the ambient scope.
build_delivery_blocks() {
  TITLE_Q="$(gaffer_quarantine ticket-title "$TITLE" single)"
  WRITE_LIST="$(printf '%s\n' "$WT_ROWS" | grep . | awk -F'\t' '{printf "  - %s (%s) [WRITABLE worktree, on branch '"$WORK_BRANCH"']\n", $5, ($2==""?"repo":$2)}')"
  READ_LIST="$(printf '%s\n' "$READ_ROOTS" | grep . | awk '{printf "  - %s [READ-ONLY context — do NOT write or branch]\n", $0}')"
  [ -n "$READ_LIST" ] || READ_LIST="  (none)"
  REVIEW_FEEDBACK_BLOCK=""
  if [ -n "$_RF" ]; then
    local _rf_q
    _rf_q="$(gaffer_quarantine review-feedback "$_RF")"
    REVIEW_FEEDBACK_BLOCK="
PRIOR REVIEW FEEDBACK — this ticket was sent back before. Each line inside the
envelope below is why a previous attempt was rejected; you MUST address every one
before re-delivering, and must NOT repeat them:
$_rf_q
"
  fi
}

# render_delivery_case <label> <variant fresh|resume>: renders BOTH branches from
# the ambient inputs the caller set, and asserts byte-identity.
render_delivery_case() {
  local label="$1" variant="$2"
  build_delivery_blocks
  local out_bash="$WORK/out.bash.txt" out_ts="$WORK/out.ts.txt"
  if ! GAFFER_RUNTIME=bash gaffer_render_delivery_prompt "$variant" > "$out_bash"; then
    no "$label — bash render exited non-zero"; return
  fi
  if ! GAFFER_RUNTIME=ts gaffer_render_delivery_prompt "$variant" > "$out_ts"; then
    no "$label — ts render exited non-zero"; return
  fi
  if cmp -s "$out_bash" "$out_ts"; then
    ok "$label — bash heredoc and ts renderer are byte-identical"
  else
    echo "----- diff (bash left, ts right) -----" >&2
    diff "$out_bash" "$out_ts" >&2 || true
    no "$label — bash heredoc and ts renderer DIVERGED"
  fi
}

# Shared delivery inputs (mirror the golden fixture's shape).
NUM=1
TITLE="Add password reset flow"
SKILLS="frontend-implementer"
LENSES="minimalism"
FILE_CARDS_BLOCK=""
PRODUCT_CONTEXT_BLOCK=""
WORK_BRANCH="gaffer/ticket-1-add-password-reset-flow"
WTP="/data/gaffer/worktrees/ticket-1/fixture-repo-id"
PRIMARY_REPO="$WTP"

# 1. Fresh single-repo delivery, no review feedback, no read roots.
_RF=""
READ_ROOTS=""
WT_ROWS="$(printf 'fixture-repo-id\tfixture-app\t/repos/fixture-app\tmain\t%s' "$WTP")"
render_delivery_case "fresh (single repo, no feedback)" fresh

# 2. Resume variant, same inputs (exercises the RESUMING heredoc branch).
render_delivery_case "resume (single repo)" resume

# 3. Prior review feedback present (untrusted-envelope block, multi-line). The ts
#    branch recovers the raw reasons from the "  - " prefix; the bash branch
#    quarantines the same lines — proving review-feedback quarantine parity.
_RF="$(printf '  - %s\n  - %s' "The reset token was not single-use" "Missing rate-limit on the reset endpoint")"
render_delivery_case "fresh (with prior review feedback)" fresh

# 4. Multi-repo + read roots + non-empty context blocks (fills every seam slot).
_RF=""
READ_ROOTS="$(printf '/repos/design-system\n/repos/api-contracts')"
WT_ROWS="$(printf 'id-a\tapp-web\t/repos/app-web\tmain\t%s\nid-b\t\t/repos/app-api\tmain\t%s' "$WTP/app-web" "$WTP/app-api")"
FILE_CARDS_BLOCK="$(printf 'PRIOR CONTEXT (file cards):\n  - [src/auth.ts] token issuance lives here')"
PRODUCT_CONTEXT_BLOCK="$(printf 'PRODUCT CONTEXT:\n  - decision: tokens are single-use by design')"
render_delivery_case "fresh (multi-repo, read roots, context blocks, empty-name→repo)" fresh
render_delivery_case "resume (multi-repo, read roots, context blocks)" resume

# 5. Bootstrap variant. Its bash branch reads B_TITLE_Q / B_SKILLS / B_DIR.
NUM=9
TITLE="Scaffold the billing service"
B_SKILLS="minimalism"
B_DIR="/data/gaffer/bootstrap/ticket-9/billing"
B_TITLE_Q="$(gaffer_quarantine ticket-title "$TITLE" single)"
if GAFFER_RUNTIME=bash gaffer_render_delivery_prompt bootstrap > "$WORK/boot.bash.txt" \
   && GAFFER_RUNTIME=ts gaffer_render_delivery_prompt bootstrap > "$WORK/boot.ts.txt"; then
  cmp -s "$WORK/boot.bash.txt" "$WORK/boot.ts.txt" \
    && ok "bootstrap — bash heredoc and ts renderer are byte-identical" \
    || { echo "----- bootstrap diff -----" >&2; diff "$WORK/boot.bash.txt" "$WORK/boot.ts.txt" >&2 || true; no "bootstrap — DIVERGED"; }
else
  no "bootstrap — a render exited non-zero"
fi

# ── Negative control: the ts branch must FAIL CLOSED on a boundary-less prompt
# (an empty write-repo set) — the exact case renderDeliveryPrompt rejects so a
# prompt with no WRITABLE-repo boundary never reaches a live agent launch. The
# bash heredoc would happily render an empty WRITE_LIST; the typed seam refuses. ─
NUM=1
TITLE="Add password reset flow"
_RF=""
READ_ROOTS=""
WT_ROWS=""            # no write rows → empty writeRepos → renderer throws
build_delivery_blocks
if GAFFER_RUNTIME=ts gaffer_render_delivery_prompt fresh > "$WORK/nowrite.txt" 2>/dev/null; then
  no "negative control — ts render did NOT fail closed on an empty write-repo set"
else
  ok "negative control — ts render fails closed on an empty write-repo set (no boundary)"
fi

echo ""
echo "prompt-render-parity: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
