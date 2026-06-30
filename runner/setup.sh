#!/usr/bin/env bash
# Gaffer factory — one-command bootstrap. Installs + builds the three products and
# initialises factory state (databases + Crew config). Run once on a fresh
# checkout, then `bash preflight.sh` to verify, then `bash demo.sh` to see it work.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=factory.config.sh
source "$HERE/factory.config.sh"

# ── prerequisite preflight ─────────────────────────────────────────────────
# Check everything up front with actionable messages, so a fresh machine fails
# HERE (with the fix in hand) instead of sailing through setup + dry-run and
# then dying on the first real tick. Hard deps (setup itself needs them) abort;
# live-only deps (needed only at DRY_RUN=0) warn but don't block setup.
echo "── prerequisites"
_hard_missing=0
_live_missing=0
if command -v node >/dev/null; then
  _node_major="$(node -v | sed 's/v\([0-9]*\).*/\1/')"
  if [ "${_node_major:-0}" -ge 22 ] 2>/dev/null; then
    echo "  ✓ node $(node -v)"
  else
    echo "  ✗ node $(node -v) — Gaffer needs Node 22 or 24 (https://nodejs.org)"; _hard_missing=1
  fi
else
  echo "  ✗ node — install Node 22 or 24 (https://nodejs.org)"; _hard_missing=1
fi
if command -v pnpm >/dev/null; then
  echo "  ✓ pnpm $(pnpm -v)"
else
  echo "  ✗ pnpm — run 'corepack enable' (ships with Node; pins pnpm@10.33.0), or see https://pnpm.io"; _hard_missing=1
fi
if command -v git >/dev/null; then
  echo "  ✓ git"
else
  echo "  ✗ git — required to register repos and run each ticket in a worktree"; _hard_missing=1
fi
if command -v python3 >/dev/null; then
  echo "  ✓ python3"
else
  echo "  ⚠ python3 — needed for LIVE ticks (runner JSON parsing + portable timeout shim); setup + dry-run work without it"; _live_missing=1
fi
if command -v claude >/dev/null; then
  echo "  ✓ claude"
else
  echo "  ⚠ claude — needed for LIVE agent runs (onboard/plan/deliver); install + authenticate before DRY_RUN=0"; _live_missing=1
fi
if [ "$_hard_missing" = 1 ]; then
  echo
  echo "Install the tools marked ✗ above, then re-run: bash runner/setup.sh"
  exit 1
fi
[ "$_live_missing" = 1 ] && echo "  (⚠ items are fine for setup + dry-run — resolve before going live with DRY_RUN=0)"

echo "Gaffer factory setup"
# Workspace install + build: one root `pnpm install` resolves the whole
# packages/* workspace, then `pnpm -r build` builds every package (dispatch,
# memory, crew) in dependency order. Replaces the old per-package cd/install/build.
echo "── install + build workspace ($GAFFER_HOME)"
( cd "$GAFFER_HOME" && pnpm install --silent && pnpm -r build >/dev/null )
echo "  ✓ installed + built (dispatch, memory, crew)"

echo "── factory state ($GAFFER_DATA)"
mkdir -p "$GAFFER_DATA"
node "$DISPATCH_DIR/dist/cli/index.js" --db "$DISPATCH_DB" init >/dev/null
lg init >/dev/null   # memory-mcp: MEMORY_DB env, own bin
if [ ! -f "$CREW_CONFIG" ]; then
  node "$CREW_DIR/dist/cli/index.js" init -d "$GAFFER_DATA" -n gaffer >/dev/null
fi
# `crew init -d "$GAFFER_DATA"` already writes an ABSOLUTE sqlite_path
# (`$GAFFER_DATA/dispatch.sqlite`) — the relative-path footgun is fixed at source
# (see packages/crew/src/config/init.ts). This sed stays only as a defensive sync:
# if DISPATCH_DB was overridden away from the default, it re-points crew.yaml at the
# SAME db the orchestrator + dashboard use, so `gaffer onboard` lands in the right
# place. (Portable sed for macOS + Linux.)
sed -i.bak "s#sqlite_path:.*#sqlite_path: $DISPATCH_DB#" "$CREW_CONFIG" && rm -f "$CREW_CONFIG.bak"
echo "  ✓ databases + crew.yaml ready (dispatch db: $DISPATCH_DB)"

echo
echo "Setup complete. From here:"
echo "  $HERE/gaffer onboard /path/to/your/repo   # add a repo (registers + scans, one step)"
echo "  $HERE/gaffer dashboard                    # open the web UI (http://127.0.0.1:8787)"
echo "  $HERE/gaffer demo                         # watch the whole loop (dry-run)"
echo "  $HERE/gaffer status                       # what's registered + running"
echo "  $HERE/gaffer skills install --user        # (optional) add the 31 skills to your own Claude Code"
echo
echo "  go live when ready:  DRY_RUN=0 bash $HERE/loop.sh   (review preflight.sh first)"
