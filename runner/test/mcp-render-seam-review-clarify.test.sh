#!/usr/bin/env bash
# =====================================================================
# LOAD-BEARING byte-identity test for the review.sh + clarify.sh render
# migration onto the single gaffer_render_mcp_runtime seam.
# ---------------------------------------------------------------------
# review.sh and clarify.sh used to render the runtime .mcp.json with an
# inline 6-`e` sed chain (identical in both files). This proves the seam
# reproduces that prior inline render EXACTLY, save the ONE documented
# fix: the prior chain OMITTED ${GAFFER_TICKET_REPOS}, leaking the literal
# placeholder into the memory server env; the seam substitutes it, and
# review/clarify pass it EMPTY (non-delivery ticks do no scope-bound
# memory direct-apply writes, so empty fails closed exactly as the leaked
# literal did — a placeholder-leak fix, not a behaviour change).
#
# Assertion 1 (sole-delta): the prior render carries the literal
#   ${GAFFER_TICKET_REPOS} placeholder (the leak — in BOTH the memory-env
#   line and the template's own _comment, which names the placeholder) and
#   the seam render carries NONE of them — proves the fix stripped every
#   occurrence and nothing but that changed introduced the delta.
# Assertion 2 (positive byte-identity): prior piped through one extra sed
#   that strips the leaked placeholder must be byte-identical (cmp -s,
#   incl. trailing newline) to the seam output — this is the load-bearing
#   proof that the six shared substitutions render byte-for-byte the same
#   and the ONLY difference is the ${GAFFER_TICKET_REPOS} placeholder fix.
#
# If either migrated render diverged from the prior inline sed on any of
# the shared values, this test FAILS. It runs the bash branch of the seam
# (GAFFER_RUNTIME=bash) so it needs no crew build — live behaviour is the
# bash path.
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
TEMPLATE="$RUNNER_DIR/.mcp.json"

[ -f "$TEMPLATE" ] || { echo "FAIL: template missing ($TEMPLATE)" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/mcp-render-seam-rc.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
# The seam + its _gaffer_sed_repl helper live in factory.config.sh. Source it
# with the DB vars set so its top-level defaults resolve without side effects
# (mirrors mcp-render-parity.test.sh).
export GAFFER_DATA="$WORK/data" DISPATCH_DB="$WORK/data/dispatch.sqlite" MEMORY_DB="$WORK/data/memory.sqlite"
mkdir -p "$GAFFER_DATA"
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh"

pass=0
fail=0
ok() { echo "  ok   $1"; pass=$((pass + 1)); }
no() { echo "  FAIL $1"; fail=$((fail + 1)); }

# prior_render <out> — a VERBATIM copy of the inline 6-`e` sed chain that
# review.sh:99 and clarify.sh:83 carried (both identical), reading the same
# five ambient globals + a hardcoded empty recall. This is the reference the
# seam must reproduce (save the documented ticket-repos fix).
prior_render() {
  local out="$1"
  sed -e "s#\${DISPATCH_DB}#$(_gaffer_sed_repl "$DISPATCH_DB")#g" \
      -e "s#\${MEMORY_DB}#$(_gaffer_sed_repl "$MEMORY_DB")#g" \
      -e "s#\${DISPATCH_MCP_BIN}#$(_gaffer_sed_repl "$DISPATCH_MCP_BIN")#g" \
      -e "s#\${MEMORY_MCP_BIN}#$(_gaffer_sed_repl "$MEMORY_MCP_BIN")#g" \
      -e "s#\${GAFFER_CLAIM_TOKEN}#$(_gaffer_sed_repl "$CLAIM_TOKEN")#g" \
      -e "s#\${GAFFER_RECALL_TICKET}#$(_gaffer_sed_repl "")#g" \
      "$TEMPLATE" > "$out"
}

# seam_case <label> <dispatchDb> <memoryDb> <dispatchBin> <memoryBin> <claimToken>
# Sets the ambient globals exactly as review.sh/clarify.sh do at their call site,
# renders the PRIOR inline chain and the SEAM (recall="", GAFFER_TICKET_REPOS=""),
# then runs both assertions.
seam_case() {
  local label="$1"
  DISPATCH_DB="$2" MEMORY_DB="$3" DISPATCH_MCP_BIN="$4" MEMORY_MCP_BIN="$5" CLAIM_TOKEN="$6"
  local prior="$WORK/prior.json" seam="$WORK/seam.json" corrected="$WORK/corrected.json"

  prior_render "$prior"

  # The migrated call sites feed the seam exactly this: recall empty, ticket-repos
  # explicitly empty, bash branch (live default).
  GAFFER_TICKET_REPOS=""
  if ! GAFFER_RUNTIME=bash gaffer_render_mcp_runtime "$TEMPLATE" "$seam" ""; then
    no "$label — seam render exited non-zero"; return
  fi

  # Assertion 1: the prior render leaks the literal ${GAFFER_TICKET_REPOS}
  # placeholder (>=1 occurrence) and the seam render leaks NONE. Matching the
  # placeholder itself (not the substituted result) is order/whitespace-robust
  # and captures every occurrence, incl. the one in the template _comment.
  local n_prior n_seam
  n_prior="$(grep -c 'GAFFER_TICKET_REPOS}' "$prior" || true)"
  n_seam="$(grep -c 'GAFFER_TICKET_REPOS}' "$seam" || true)"
  if [ "$n_prior" -lt 1 ]; then
    no "$label — prior inline render did NOT contain the \${GAFFER_TICKET_REPOS} leak (test premise broken)"
  elif [ "$n_seam" -ne 0 ]; then
    echo "----- seam still leaks the placeholder -----" >&2
    diff "$prior" "$seam" >&2 || true
    no "$label — seam render still leaks \${GAFFER_TICKET_REPOS} ($n_seam occurrence(s))"
  else
    ok "$label — seam stripped all $n_prior leaked \${GAFFER_TICKET_REPOS} placeholder(s)"
  fi

  # Assertion 2: prior + the one extra placeholder-stripping sub == seam, byte for
  # byte (trailing newline included).
  sed -e "s#\${GAFFER_TICKET_REPOS}##g" "$prior" > "$corrected"
  if cmp -s "$corrected" "$seam"; then
    ok "$label — corrected prior render is byte-identical to the seam output"
  else
    echo "----- cmp diff (corrected left, seam right) -----" >&2
    diff "$corrected" "$seam" >&2 || true
    no "$label — corrected prior render DIVERGED from the seam output"
  fi
}

DB="/data/gaffer/dispatch.sqlite"
MDB="/data/gaffer/memory.sqlite"
DBIN="/opt/gaffer/dispatch-mcp/bin.js"
MBIN="/opt/gaffer/memory-mcp/bin.js"
TOK="ct_live_9f3a7b21c0"

# 1. Nominal review/clarify inputs: real claim token.
seam_case "nominal (real claim token)" "$DB" "$MDB" "$DBIN" "$MBIN" "$TOK"

# 2. Empty claim token (resumed / no runner-held token) — a review/clarify tick
#    can fire with no live token; the seam must strip the placeholder the same way.
seam_case "empty claim token" "$DB" "$MDB" "$DBIN" "$MBIN" ""

# 3. Escaping torture: a db path with sed-special (#, &) and replace-special
#    ($&, $') characters — proves _gaffer_sed_repl parity holds for the seam on
#    review/clarify inputs too.
TRICKY='/data/di#r/w&x$&$'\''z.sqlite'
seam_case "escaping torture (# & \$& \$')" "$TRICKY" "$MDB" "$DBIN" "$MBIN" "$TOK"

echo "mcp-render-seam-review-clarify: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
