#!/usr/bin/env bash
# Gaffer factory — one-command bootstrap. Installs + builds the three products and
# initialises factory state (databases + Crew config). Run once on a fresh
# checkout, then `bash preflight.sh` to verify, then `bash demo.sh` to see it work.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=factory.config.sh
source "$HERE/factory.config.sh"

command -v pnpm >/dev/null || { echo "pnpm is required (https://pnpm.io)"; exit 1; }
command -v node >/dev/null || { echo "node is required (>= 22)"; exit 1; }

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
echo "  $HERE/gaffer skills install --user        # (optional) add the 66 skills to your own Claude Code"
echo
echo "  go live when ready:  DRY_RUN=0 bash $HERE/loop.sh   (review preflight.sh first)"
