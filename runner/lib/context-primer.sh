#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# runner/lib/context-primer.sh — shared file-card context primer.
#
# Single implementation of: canonical derivation + cards-for-scope retrieval
# + block formatting.  Every agent launch (delivery, review, clarify, …) that
# wants a "PRIOR CONTEXT (file cards)" block calls gaffer_prime_context_block
# rather than inlining the logic.
#
# Requires: lg, MEMORY_DB, MEMORY_CLI_BIN (all defined in factory.config.sh).
# Source AFTER factory.config.sh.
# ─────────────────────────────────────────────────────────────────────────────

# gaffer_prime_context_block <real_repo_path> <repo_display> <query> [path...]
#
# Derive the repo's canonical identity (remote.origin.url else pwd -P — the
# EXACT contract onboard uses so memory keys match), call `memory
# cards-for-scope` for the given query + optional path hints, and format the
# result as a "PRIOR CONTEXT (file cards)" block suitable for injection into
# an agent prompt.
#
# Outputs the formatted block on stdout.  Outputs nothing on any error:
# missing/non-dir repo, lg/memory failure, zero cards AND no digest.
# FAIL-SOFT by design — callers must treat an empty result as "no context"
# and proceed exactly as before.
#
# The block's framing emphasises cards are RETRIEVAL AIDS, never authoritative
# source: the agent must read the real file before editing or relying on a
# card's summary.
gaffer_prime_context_block() {
  local _gpc_real_repo="${1:-}" _gpc_display="${2:-}" _gpc_query="${3:-}"
  shift 3 2>/dev/null || true
  local _gpc_paths=("$@")

  # Fail-soft: missing or non-existent repo path → empty output.
  [ -n "$_gpc_real_repo" ] && [ -d "$_gpc_real_repo" ] || return 0

  # CANONICAL CONTRACT (must match onboard's repoCanonical EXACTLY):
  # the repo's remote.origin.url, else its realpath (pwd -P).
  local _gpc_canonical
  _gpc_canonical="$(git -C "$_gpc_real_repo" config --get remote.origin.url 2>/dev/null)"
  [ -z "$_gpc_canonical" ] && _gpc_canonical="$(cd "$_gpc_real_repo" && pwd -P)"

  # Build the cards-for-scope argv.  Caller-supplied paths narrow the
  # search; omitting them falls back to the query-driven selection.
  local _gpc_argv=(cards-for-scope \
    --canonical "$_gpc_canonical" \
    --repo      "$_gpc_display" \
    --query     "$_gpc_query" \
    --max-cards 12 \
    --max-tokens 1800 \
    --per-card-max-tokens 160)
  local _gpc_p
  for _gpc_p in "${_gpc_paths[@]+"${_gpc_paths[@]}"}"; do
    _gpc_argv+=(--paths "$_gpc_p")
  done
  _gpc_argv+=(--json)

  # Call the memory CLI (fail-soft: any error or empty output → return 0).
  local _gpc_json
  _gpc_json="$(lg "${_gpc_argv[@]}" 2>/dev/null)" || return 0
  [ -n "$_gpc_json" ] || return 0

  # Render the packet into a compact, agent-facing block.  python3 is
  # fail-soft: bad JSON or zero cards AND no digest yields no output.
  local _gpc_body
  _gpc_body="$(printf '%s' "$_gpc_json" | python3 -c '
import sys, json
try:
    p = json.load(sys.stdin)
except Exception:
    sys.exit(0)
cards = p.get("cards") or []
order = {e["path"]: e["tier"] for e in (p.get("selectionOrder") or [])}
dg    = p.get("digest")
lines = []
if dg and dg.get("overview"):
    lines.append("Repo digest: " + dg["overview"].strip())
for c in cards:
    tier = order.get(c.get("path"), "fts")
    head = "  - [%s] %s" % (tier, c.get("path", ""))
    if c.get("tldr"):
        head += " \xe2\x80\x94 " + c["tldr"].strip()
    lines.append(head)
    syms = c.get("symbols") or []
    if syms:
        lines.append("      symbols: " + ", ".join(syms[:8]))
cov     = p.get("coverage") or {}
missing = cov.get("missing") or []
tr      = p.get("truncationReason")
foot    = []
if missing:
    foot.append("no card yet for: " + ", ".join(missing[:8]))
if tr:
    foot.append(tr)
if not lines:
    sys.exit(0)
print("\n".join(lines))
if foot:
    print("  (" + "; ".join(foot) + ")")
' 2>/dev/null)" || return 0

  [ -n "$_gpc_body" ] || return 0

  # Emit the formatted block.  The exact phrase "a card is a guide, never
  # authoritative source" must appear as a single contiguous string on one
  # output line — it is asserted verbatim by the test suite and by callers
  # that grep the block.
  printf '\nPRIOR CONTEXT (file cards) — the runner pre-selected these from the\nrepo'"'"'s file-card index to orient you. Read the real file before editing;\na card is a guide, never authoritative source. Pull more via the memory\nMCP (`cards_for_scope` / `card get` / `card search`) when you need them.\n%s\n\n' \
    "$_gpc_body"
}
