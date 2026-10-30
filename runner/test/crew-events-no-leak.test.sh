#!/usr/bin/env bash
# =====================================================================
# crew never writes its events log into the repo it is run from.
# ---------------------------------------------------------------------
# crew.yaml's default `logging.event_log_path` is the relative
# `./.crew/events.jsonl`. It used to resolve against process.cwd(), so
# `cd myrepo && gaffer onboard .` (or any direct crew call) left `?? .crew/` in
# the human's checkout — the exact residue HYGIENE_FORBIDDEN_PATHS blocks. With
# GAFFER_CREW_EVENTS UNSET (a direct crew call), runs the REAL built crew from
# inside a clean temp git repo and proves:
#   1. `crew maintain --force` leaves the repo clean; its events land under the
#      factory root (the config file's directory).
#   2. `crew repo onboard . --standalone` with the memory env (as `gaffer onboard`
#      passes it) leaves the repo clean.
#   3. factory.config.sh exports GAFFER_CREW_EVENTS=$GAFFER_DATA/events.jsonl, so
#      runner-spawned crew calls share the one log tick.sh reads.
#
# Run: bash runner/test/crew-events-no-leak.test.sh   (SKIPs without the builds)
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
CREW_CLI="$ROOT/packages/crew/dist/cli/index.js"
DISPATCH_CLI="$ROOT/packages/dispatch/dist/cli/index.js"
MEMORY_CLI="$ROOT/packages/memory/dist/bin/memory.js"
for f in "$CREW_CLI" "$DISPATCH_CLI" "$MEMORY_CLI"; do
  [ -f "$f" ] || { echo "SKIP: $f not built — run pnpm -r build"; exit 0; }
done

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/crew-events-leak.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT
unset GAFFER_CREW_EVENTS

FAC="$WORK/fac"; mkdir -p "$FAC"
node "$DISPATCH_CLI" --db "$FAC/dispatch.sqlite" init >/dev/null 2>&1
node "$CREW_CLI" init -d "$FAC" >/dev/null 2>&1 || { echo "FAIL: crew init"; exit 1; }

REPO="$WORK/myrepo"; mkdir -p "$REPO"
git -C "$REPO" init -q -b main
printf '# app\n' > "$REPO/README.md"
git -C "$REPO" add README.md
git -C "$REPO" -c user.email=t@t -c user.name=t commit -q -m init

echo "== 1. crew maintain from inside a repo =="
( cd "$REPO" && node "$CREW_CLI" -c "$FAC/crew.yaml" maintain --force >/dev/null 2>&1 )
DIRTY="$(git -C "$REPO" status --porcelain)"
[ -z "$DIRTY" ] && ok "crew maintain leaves the repo it ran from clean" \
  || fail "crew maintain dirtied the repo: $DIRTY"
[ -s "$FAC/.crew/events.jsonl" ] && ok "its events land under the factory root ($FAC/.crew/events.jsonl)" \
  || fail "no events log under the factory root"

echo "== 2. crew repo onboard . from inside a repo (memory env set) =="
( cd "$REPO" && MEMORY_CLI_BIN="$MEMORY_CLI" MEMORY_DB="$WORK/memory.sqlite" \
    node "$CREW_CLI" -c "$FAC/crew.yaml" repo onboard . --standalone >/dev/null 2>&1 )
DIRTY="$(git -C "$REPO" status --porcelain)"
[ -z "$DIRTY" ] && ok "crew repo onboard . leaves the onboarded repo clean" \
  || fail "crew repo onboard . dirtied the repo: $DIRTY"
grep -q '"repo_digest_written"' "$FAC/.crew/events.jsonl" 2>/dev/null \
  && ok "the onboard events are in the factory's log" \
  || fail "the onboard events are missing from the factory's log"

echo "== 3. runner-spawned crew calls share \$GAFFER_DATA/events.jsonl =="
GOT="$(GAFFER_DATA="$WORK/data" DISPATCH_DB="$WORK/data/dispatch.sqlite" MEMORY_DB="$WORK/data/memory.sqlite" \
  bash -c 'source "$1/factory.config.sh" >/dev/null 2>&1; printf "%s" "$GAFFER_CREW_EVENTS"' _ "$RUNNER_DIR")"
[ "$GOT" = "$WORK/data/events.jsonl" ] \
  && ok "factory.config.sh exports GAFFER_CREW_EVENTS=\$GAFFER_DATA/events.jsonl" \
  || fail "factory.config.sh should export GAFFER_CREW_EVENTS=$WORK/data/events.jsonl (got '$GOT')"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS ($PASS checks)"; exit 0
else
  printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
fi
