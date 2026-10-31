#!/usr/bin/env bash
# =====================================================================
# UI SCENARIOS — the browser-driven scenario suites (scripts/ui-regression/suites/),
# each a product flow beyond the golden path (rework, won't do, unblock, pause,
# tester verdicts, decisions, settings, memory, map, squad, specs, plans, health,
# autonomy, PR mode, ingest, greenfield, conflicts) driven in a real browser against
# the real server and runner, with the stub worker (stub-claude.sh: modes per ticket
# from $GAFFER_DATA/stub-mode.json) and no model call.
#
#   pnpm -r build
#   bash scripts/ui-regression/run-suites.sh               # every suite, in run order
#   bash scripts/ui-regression/run-suites.sh s1-rework s3-blocked   # just these
#
# WORLDS. Most suites share ONE world, the golden path's (setup.sh, shared with run.sh:
# throwaway GAFFER_DATA, the taskflow-mini sample repo, the stub worker, the dashboard
# via `gaffer dashboard --restart`), plus two canned planning bins for the suites that
# plan or author (GAFFER_DECOMPOSE_BIN, GAFFER_SPEC_AUTHOR_BIN → suites/bin/) and one
# operator-exported setting (GAFFER_NOTIFY_DESKTOP=0) so the Settings suite can
# prove an env-locked row is read-only. A suite that declares `server = { env,
# fixtures }` (suite-plan.mjs) gets its OWN world after the shared one: a fresh out
# dir ($UI_REGRESS_OUT-<suite>), port ($UI_REGRESS_PORT + n), data dir, sample repo
# and dashboard started with that env and those fixtures (own-env.sh). Every world,
# shared or own, gets a $5 daily budget through Settings before its suites run
# (own-env.sh ui_world_daily_budget); run.sh leaves it unset for the first-run sheet.
# Prints one line per suite, "UI scenarios: …" per world and, with more than one
# world, a combined "UI scenarios (every world): …" line; exits 1 on any FAIL.
# Env: UI_REGRESS_PORT (default 8798) · UI_REGRESS_OUT (default /tmp/gaffer-ui-scenarios)
#      UI_SUITES (space/comma list, same as argv) · KEEP_DASHBOARD=1 · PLAYWRIGHT_CHROMIUM
#      UI_PW_CACHE (default $UI_REGRESS_OUT-pw: playwright-core + axe-core, installed once)
# `run-suites.sh --serve [suite]` only builds the shared world (or that own-server
# suite's world) and leaves the dashboard up, printing the env to drive
# `node run-suites.mjs <suite>` against it while writing a suite.
# =====================================================================
set -uo pipefail
_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_BASE_OUT="${UI_REGRESS_OUT:-/tmp/gaffer-ui-scenarios}"
_BASE_PORT="${UI_REGRESS_PORT:-8798}"
export UI_PW_CACHE="${UI_PW_CACHE:-$_BASE_OUT-pw}"

_SERVE=0
if [ "${1:-}" = "--serve" ]; then _SERVE=1; shift; fi
_PLAN="$(node "$_HERE/suite-plan.mjs" "$@")" || exit 2
_SHARED=(); _OWN=()
while read -r _kind _name; do
  [ -n "${_name:-}" ] || continue
  if [ "$_kind" = own ]; then _OWN+=("$_name"); else _SHARED+=("$_name"); fi
done <<< "$_PLAN"
# --serve with no suite named builds the shared world only.
if [ "$_SERVE" = 1 ] && [ "$#" -eq 0 ]; then _OWN=(); fi

# One world: setup.sh in a SUBSHELL (it sets globals and exits on a setup failure),
# then the suites against it.   ui_world <out> <port> <own-suite-or-empty> <suite>…
ui_world() {
  local own="$3"
  local -a fixtures=()
  # shellcheck disable=SC2034  # both read by setup.sh, sourced below
  local UI_REGRESS_OUT="$1" UI_REGRESS_PORT="$2"
  shift 3
  if [ -n "$own" ]; then
    mapfile -t fixtures < <(node "$_HERE/suite-plan.mjs" --fixtures "$own")
  fi
  (
    # shellcheck source=own-env.sh
    source "$_HERE/own-env.sh"
    ui_setup_before_dashboard() {
      # Canned planning bins (no model): the dashboard's plan-build / spec-build runners
      # spawn these instead of `claude`.
      export GAFFER_DECOMPOSE_BIN="$HERE/suites/bin/decompose-stub.mjs"
      export GAFFER_SPEC_AUTHOR_BIN="$HERE/suites/bin/spec-author-stub.mjs"
      # An operator override the Settings suite asserts is env-locked (read-only).
      export GAFFER_NOTIFY_DESKTOP=0
      [ -n "$own" ] || return 0
      ui_run_fixtures before "${fixtures[@]+"${fixtures[@]}"}" || return 1
      local k v
      while IFS='=' read -r k v; do
        [ -n "$k" ] || continue
        v="${v//\$\{OUT\}/$OUT}"; v="${v//\$\{R\}/$R}"; v="${v//\$\{HERE\}/$HERE}"
        export "$k=$v"
      done < <(node "$_HERE/suite-plan.mjs" --env "$own")
    }
    # shellcheck source=setup.sh
    source "$_HERE/setup.sh"
    # Every world (the shared one and each own-server one) gets the $5 daily budget
    # before its suites press Poll for work (own-env.sh ui_world_daily_budget).
    ui_world_daily_budget || { ui_teardown; exit 2; }
    if [ -n "$own" ]; then
      ui_run_fixtures after "${fixtures[@]+"${fixtures[@]}"}" || { ui_teardown; exit 2; }
    fi
    if [ "$_SERVE" = 1 ]; then
      printf 'BASE=http://127.0.0.1:%s TOKEN=%s REPO_PATH=%s OUT=%s ROOT=%s GAFFER_DATA=%s PW_CORE_ROOT=%s%s\n' \
        "$PORT" "$TOKEN" "$R" "$OUT/shots" "$ROOT" "$GAFFER_DATA" "${PW_CORE_ROOT:-}" \
        "${FAKE_GH_STATE:+ FAKE_GH_STATE=$FAKE_GH_STATE}"
      exit 0
    fi
    echo "== UI scenarios against http://127.0.0.1:$PORT (out: $OUT)${own:+ — own server for $own} =="
    BASE="http://127.0.0.1:$PORT" TOKEN="$TOKEN" REPO_PATH="$R" OUT="$OUT/shots" ROOT="$ROOT" \
      GAFFER_DATA="$GAFFER_DATA" node "$HERE/run-suites.mjs" "$@"
    rc=$?
    ui_teardown
    exit $rc
  )
}

rc=0
_RESULTS=()
if [ "${#_SHARED[@]}" -gt 0 ] && { [ "$_SERVE" = 0 ] || [ "${#_OWN[@]}" -eq 0 ]; }; then
  ui_world "$_BASE_OUT" "$_BASE_PORT" "" "${_SHARED[@]}" || rc=1
  [ "$_SERVE" = 1 ] && exit 0
  _RESULTS+=("$_BASE_OUT/shots/results.json")
fi
_n=0
for _s in "${_OWN[@]+"${_OWN[@]}"}"; do
  _n=$((_n + 1))
  ui_world "$_BASE_OUT-$_s" "$((_BASE_PORT + _n))" "$_s" "$_s" || rc=1
  [ "$_SERVE" = 1 ] && exit 0
  _RESULTS+=("$_BASE_OUT-$_s/shots/results.json")
done
if [ "${#_RESULTS[@]}" -gt 1 ]; then
  echo
  node "$_HERE/suite-plan.mjs" --summary "${_RESULTS[@]}"
fi
exit $rc
