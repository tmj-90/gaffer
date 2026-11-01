#!/usr/bin/env bash
# Gaffer factory — one-command bootstrap. Installs + builds the three products and
# initialises factory state (databases + Crew config). Run once on a fresh
# checkout (`runner/gaffer setup`), then `bash runner/preflight.sh` to verify, then
# `runner/gaffer demo` to see it work.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=factory.config.sh
source "$HERE/factory.config.sh"

command -v pnpm >/dev/null || { echo "pnpm is required (https://pnpm.io)"; exit 1; }
command -v node >/dev/null || { echo "node is required (Node 22.22.1+ or 24)"; exit 1; }
# The Node floor is engines.node in the root package.json, and .npmrc's engine-strict
# makes pnpm refuse below it — check first so the reason is said in one line, not
# buried (or, with --silent, hidden) in install output. scripts/check-engines.mjs keeps
# that floor true against every locked dependency's own engines.
node "$HERE/../scripts/check-engines.mjs" --runtime --root "$GAFFER_HOME" || exit 1
# The `claude` CLI is REQUIRED for any LIVE run (the factory spawns `claude -p` for
# planning, delivery, and onboarding). Not fatal for setup — dry-run/demo work without
# it — but warn loudly so a first live run doesn't silently spawn, fail, and park every
# ticket with no obvious cause.
command -v claude >/dev/null 2>&1 \
  || echo "  ⚠ 'claude' CLI not found — install + authenticate it (https://docs.anthropic.com/claude-code) before a live run; dry-run/demo still work."

echo "Gaffer factory setup"
# Workspace install + build: one root `pnpm install` resolves the whole
# packages/* workspace, then `pnpm -r build` builds every package (dispatch,
# memory, crew) in dependency order. Replaces the old per-package cd/install/build.
echo "── install + build workspace ($GAFFER_HOME)"
# Output goes to a log, not /dev/null: a failed install or build used to exit 1 with
# no message at all. On failure show its tail, plus the fix for the common cause.
# Owner-only factory state: it holds the dashboard token, the databases and the logs
# (and the doctors recommend 0700). An existing 0755 dir from an older setup is tightened.
( umask 077; mkdir -p "$GAFFER_DATA" ); chmod 700 "$GAFFER_DATA"
SETUP_LOG="$GAFFER_DATA/setup.log"
if ! ( cd "$GAFFER_HOME" && pnpm install && pnpm -r build ) >"$SETUP_LOG" 2>&1; then
  echo "  ✗ install/build failed — last lines of $SETUP_LOG:"
  tail -n 25 "$SETUP_LOG" | sed 's/^/    /'
  if grep -q ERR_PNPM_UNSUPPORTED_ENGINE "$SETUP_LOG"; then
    echo "  → your Node ($(node -v)) is below a dependency's floor: install a newer Node"
    echo "    (nvm install 22 && nvm use 22, or Node 24), then re-run setup"
  fi
  exit 1
fi
echo "  ✓ installed + built (dispatch, memory, crew)"

echo "── factory state ($GAFFER_DATA)"
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
echo "  $HERE/gaffer onboard /path/to/your/repo   # add an EXISTING repo (registers + scans)"
echo "  $HERE/gaffer dashboard                    # open the web UI (http://127.0.0.1:${DISPATCH_API_PORT:-8787})"
echo "                                            #   → 'Plan a build' turns one line into a NEW app (greenfield)"
echo "  $HERE/gaffer demo                         # one dry tick over a showcase repo (nothing spent)"
echo "  $HERE/gaffer status                       # what's registered + running"
echo "  $HERE/gaffer wg ticket create -t \"<title>\" -d \"<what + why>\"   # your first ticket (then: ac add · repo-access set · ready — see quickstart §4)"
echo "  $HERE/gaffer skills install --user        # (optional) add the $(find "$HERE/skills" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d " ") skills to your own Claude Code"
echo
echo "  go live when ready:  GAFFER_DAILY_BUDGET_USD=5 $HERE/gaffer run   # one pass, delivers the ready queue to Review"
echo "                      #   (a live run needs a dollar cap; review preflight.sh first; --daemon to keep going)"
