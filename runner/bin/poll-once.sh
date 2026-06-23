#!/usr/bin/env bash
# One-shot "poll for work" — the entrypoint the dashboard's Poll-for-work button
# spawns (via DISPATCH_TICK_CMD). Clears the per-run skip files (so a previously
# parked/failed ticket gets a fresh attempt) then runs a SINGLE tick. Never loops,
# so it can't run away; the button is an explicit "go deliver the next ready ticket".
#
# Runs LIVE by default (the button is a deliberate user action); pass DRY_RUN=1 to
# preview. The dashboard spawns this detached, fire-and-gaffert, with the factory env.
set -uo pipefail
export DRY_RUN="${DRY_RUN:-0}"   # explicit poll = live unless the caller overrides
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../factory.config.sh
source "$HERE/factory.config.sh"
mkdir -p "$GAFFER_DATA"
# Fresh poll: nothing skipped from a prior run (mirrors what loop.sh clears).
rm -f "$GAFFER_DATA/.failed-tickets" "$GAFFER_DATA/.reviewed-tickets" \
      "$GAFFER_DATA/.clarified-tickets" "$GAFFER_DATA/.backpressure-repos"
wg expire-claims >/dev/null 2>&1 || true   # reap any stale claim before polling
exec bash "$HERE/tick.sh"
