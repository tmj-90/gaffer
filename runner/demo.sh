#!/usr/bin/env bash
# Gaffer factory — self-contained showcase. Seeds the two MCP servers (memory +
# work) in a throwaway factory, proves both are live, and runs ONE dry-run tick over
# a showcase repo (the tick previews the delivery; it is not the whole loop).
# Safe: DRY_RUN stays on — no Claude is invoked and no repo is mutated.
#
# Where: DEMO_DIR, else a FRESH temp dir (mktemp, checked) each run, printed at the
# end. It used to default to one fixed, shared /tmp path that it `rm -rf`d
# first, and it wrote its MCP ping script into packages/memory inside the checkout.
# Nothing is written inside the checkout now (the ping is runner/lib/mcp-ping.mjs). A
# DEMO_DIR you name is only ever cleared when it is empty or a previous demo's (it
# holds the .gaffer-demo marker); anything else is refused.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Isolated showcase state (set before sourcing config so these win).
if [ -n "${DEMO_DIR:-}" ]; then
  DEMO="$DEMO_DIR"
  if [ -d "$DEMO" ] && [ -n "$(ls -A "$DEMO" 2>/dev/null)" ]; then
    [ -f "$DEMO/.gaffer-demo" ] || { echo "DEMO_DIR=$DEMO is not empty and is not a previous demo (no .gaffer-demo marker) — refusing to clear it; name a new or empty directory" >&2; exit 2; }
    _demo_real="$(cd "$DEMO" && pwd -P)"; _home_real="$(cd "$HOME" 2>/dev/null && pwd -P)"; _root_real="$(cd "$HERE/.." && pwd -P)"
    case "$_demo_real" in
      /|"$_home_real"|"$_root_real"|"$_root_real"/*) echo "DEMO_DIR=$DEMO is /, your home or inside the checkout — refusing" >&2; exit 2 ;;
    esac
    rm -rf "${_demo_real:?}"/* "${_demo_real:?}"/.[!.]* 2>/dev/null || true
  fi
else
  DEMO="$(mktemp -d "${TMPDIR:-/tmp}/gaffer-demo.XXXXXX")" || { echo "could not create a temp dir for the demo" >&2; exit 1; }
  [ -n "$DEMO" ] && [ -d "$DEMO" ] || { echo "could not create a temp dir for the demo" >&2; exit 1; }
fi
mkdir -p "$DEMO/repo"; : > "$DEMO/.gaffer-demo"
# Self-contained: set the identity on the commit itself (-c) so the demo works on a
# fresh machine with no global git user.name/email configured.
( cd "$DEMO/repo" && git init -q \
  && git -c user.email=gaffer-demo@example.invalid -c user.name="Gaffer Demo" commit -q --allow-empty -m init )
export GAFFER_DATA="$DEMO" DISPATCH_DB="$DEMO/dispatch.sqlite" MEMORY_DB="$DEMO/memory.sqlite" DRY_RUN=1
# shellcheck source=factory.config.sh
source "$HERE/factory.config.sh"

# No colour in a pipe / file, under NO_COLOR or TERM=dumb (lib/colour.sh).
# shellcheck source=lib/colour.sh
. "$HERE/lib/colour.sh"
gaffer_colours 1
line() { printf "\n${c_bold}%s${c_off}\n" "$*"; }

[ -f "$DISPATCH_DIR/dist/cli/index.js" ] || { echo "build first: pnpm -C $DISPATCH_DIR build"; exit 1; }
[ -f "$MEMORY_CLI_BIN" ] || { echo "build first: pnpm -C $MEMORY_DIR build"; exit 1; }

line "1 ▸ Seed Memory (memory) — your real memory-mcp"
lg init >/dev/null 2>&1 || true
lg demo --force >/dev/null 2>&1 || true   # memory's own 5-record illustrative seed
echo "  ratified records seeded (memory demo)"

line "2 ▸ Seed Dispatch (work) — a ready ticket"
wg init >/dev/null
wg repo add -n demo --path "$DEMO/repo" --stack node --test "pnpm test" >/dev/null
wg ticket create -t "Add a /health endpoint" -d "Expose GET /health returning {status:'ok'}" -p team_light >/dev/null
wg repo link 1 demo >/dev/null
wg ac add 1 -t "GET /health returns 200 with {status:'ok'}" >/dev/null
wg ticket ready 1 >/dev/null
node "$CREW_DIR/dist/cli/index.js" init -d "$GAFFER_DATA" -n showcase >/dev/null 2>&1 || true
echo "  ticket #1 ready, linked to repo 'demo' (node)"

line "3 ▸ The two MCP servers are real (live stdio handshake)"
# Each handshake is assigned first: a failure inside printf's arguments would not stop
# the demo (set -e ignores it), and an empty "dispatch-mcp:" line would pass for proof.
_ping_d="$(MEMORY_DIR="$MEMORY_DIR" node "$HERE/lib/mcp-ping.mjs" "$DISPATCH_DIR/dist/mcp/bin.js" DISPATCH_DB "$DISPATCH_DB" --names)"
printf '  dispatch-mcp: %s\n' "$_ping_d"
_ping_m="$(MEMORY_DIR="$MEMORY_DIR" node "$HERE/lib/mcp-ping.mjs" "$MEMORY_MCP_BIN" MEMORY_DB "$MEMORY_DB" --names)"
printf '  memory-mcp: %s\n' "$_ping_m"

line "4 ▸ One factory tick (DRY-RUN — nothing is invoked or mutated)"
bash "$HERE/tick.sh" 2>&1 | sed 's/^[0-9T:-]* //; s#'"$HERE"'#runner#g' | grep -vE '^TICK_RESULT'

line "▸ Live run: review $HERE/factory.config.sh, then  $HERE/gaffer run   (LIVE: delivers your ready tickets)"
# This demo's ticket lives in the showcase db, not the factory's — name it, or
# `gaffer wg ticket show 1` would show the operator's OWN ticket #1.
echo "  Audit trail: DISPATCH_DB=$DISPATCH_DB $HERE/gaffer wg ticket show 1"
echo "  Showcase factory: $DEMO   (yours to delete; DEMO_DIR=<dir> picks the place)"
