# Gaffer factory configuration — source-controlled defaults; override any with env.
# shellcheck shell=bash
# The operator's REAL environment, captured before this file assigns anything. The
# dashboard launcher uses it to tell an operator override (which locks a setting in
# the UI) from a value this config derived (settings.json, mode preset, default) —
# those are unset for the dashboard process so the UI can still edit them.
#
# RE-SOURCE HYGIENE. This file is sourced by a parent (gaffer, loop.sh, a daemon pass)
# and again by every child (tick.sh, worker.sh). The parent EXPORTS what it derived —
# settings.json values and exported defaults — so a child used to inherit them as if
# they were real env, and the assign-if-unset below kept the stale value: a dashboard
# edit (daily USD cap, MAX_TICKS_PER_DAY, review mode, turn cap) never reached a
# running `gaffer run --daemon` or loop until the operator restarted it. So:
#   * the operator's env is captured ONCE per process tree (_GAFFER_OPERATOR_ENV is
#     exported) — a child does not mistake its parent's derived values for overrides;
#   * at the end of this file every variable THIS source newly exported is recorded
#     with its value (_GAFFER_DV_<KEY>, exported; the `_GAFFER_` prefix keeps it out of
#     the agent env, whose allow-list is `GAFFER_*`);
#   * on a re-source, a recorded key the operator did not set and nobody has changed
#     since (value == recorded) is unset first, so settings.json, the mode preset and
#     the defaults derive it afresh. A value a parent script changed on purpose (e.g.
#     `gaffer run` passing DRY_RUN=0 to loop.sh) differs from the record and is kept.
#
# FAIL CLOSED ON AN UNREADABLE settings.json. The unset above is only safe when the
# file can be re-read: a settings.json that EXISTS but does not parse (a hand edit, a
# truncated copy) or cannot be read at all (no node on PATH) would otherwise leave
# every unset key to its default, so a running loop's MAX_TICKS_PER_DAY went back to
# 50 and GAFFER_DAILY_BUDGET_USD / GAFFER_BUDGET_USD went OFF mid-run. So the file is
# read FIRST (before anything is unset) and, when it exists but cannot be parsed:
#   * nothing is unset — inherited values (the last good settings) are kept;
#   * _GAFFER_SETTINGS_UNREADABLE=1 is exported, and every spend gate refuses new paid
#     work on it (gaffer_refresh_day_caps → loop.sh / worker.sh stop, the daemon
#     idles, tick.sh and poll-once.sh refuse) until the file parses again.
# A missing settings.json is not an error (nothing was configured in the UI).
# The path resolves EXACTLY as the RUNNER_DIR / GAFFER_HOME / GAFFER_DATA defaults
# further down do (GAFFER_DATA := $GAFFER_HOME/.gaffer, GAFFER_HOME := $RUNNER_DIR/..),
# so an operator-set GAFFER_HOME with GAFFER_DATA unset reads $GAFFER_HOME/.gaffer —
# not the runner checkout's parent — in the parent and in every child.
_gs_rd="${RUNNER_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
_gs_home="${GAFFER_HOME:-$(cd "$_gs_rd/.." && pwd)}"
_gs_file="${GAFFER_DATA:-$_gs_home/.gaffer}/settings.json"
_gs_out=""; _gs_bad=0
if [ -e "$_gs_file" ]; then
  if command -v node >/dev/null 2>&1; then
    # STRICT: the file must parse as a flat JSON object; anything else exits non-zero.
    # Parsed the way the dashboard's readSettingsFile (packages/dispatch/src/api/
    # settings.ts) reads it: a leading UTF-8 BOM is dropped and the text trimmed, and an
    # empty or whitespace-only file is {} (nothing configured) — so the runner never
    # halts on a file the Settings panel shows as fine. Unparseable or non-object → 3.
    _gs_out="$(node -e 'const fs=require("fs");let s;try{const raw=fs.readFileSync(process.argv[1],"utf8").replace(/^\uFEFF/,"").trim();if(raw==="")process.exit(0);s=JSON.parse(raw)}catch{process.exit(3)}if(!s||typeof s!=="object"||Array.isArray(s))process.exit(3);for(const[k,v]of Object.entries(s))process.stdout.write(k+"\t"+String(v).replace(/[\t\n\r]/g," ")+"\n")' "$_gs_file" 2>/dev/null)" || _gs_bad=1
  else
    _gs_bad=1
  fi
fi
if [ "$_gs_bad" = 1 ]; then
  _GAFFER_SETTINGS_UNREADABLE=1; export _GAFFER_SETTINGS_UNREADABLE
  _gs_out=""
else
  unset _GAFFER_SETTINGS_UNREADABLE
fi
if [ -n "${_GAFFER_OPERATOR_ENV+x}" ]; then
  # Re-source hygiene — skipped while settings.json is unreadable (see above), so the
  # inherited values and their records survive until the file parses again.
  if [ "$_gs_bad" != 1 ]; then
    while IFS= read -r _dv; do
      [ -n "$_dv" ] || continue
      _dk="${_dv#_GAFFER_DV_}"
      case "$_GAFFER_OPERATOR_ENV" in *" $_dk "*) unset "$_dv"; continue ;; esac
      if [ -n "${!_dk+x}" ] && [ "${!_dk}" = "${!_dv}" ]; then unset "$_dk"; fi
      unset "$_dv"
    done < <(compgen -v _GAFFER_DV_ 2>/dev/null)
    unset _dv _dk
  fi
else
  _GAFFER_OPERATOR_ENV=" $(compgen -e 2>/dev/null | tr '\n' ' ') "
  export _GAFFER_OPERATOR_ENV
fi
unset _gs_rd _gs_home _gs_file _gs_bad
_GAFFER_ENV_AT_SOURCE="$_GAFFER_OPERATOR_ENV"
# What was already exported when THIS source began (after the hygiene step): those
# are the operator's or a parent's on purpose, never recorded as derived here.
_GAFFER_EXPORTED_AT_START=" $(compgen -e 2>/dev/null | tr '\n' ' ') "

# This file lives in runner/ of the Gaffer monorepo, so RUNNER_DIR is its own dir
# and GAFFER_HOME is the mono root — which holds runner/ alongside
# packages/{dispatch,crew,memory}. Derive both from the script location
# so the suite works under any checkout root — no hardcoded /Users/<name> path.
# Still env-overridable: a side-by-side (non-mono) checkout can point these elsewhere.
: "${RUNNER_DIR:=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
: "${GAFFER_HOME:=$(cd "$RUNNER_DIR/.." && pwd)}"   # the Gaffer checkout (the directory above runner/)
: "${GAFFER_DATA:=$GAFFER_HOME/.gaffer}"                       # factory state (dbs, logs, agent id)
# ONE canonical crew events log for everything that sources this file (tick.sh,
# the gaffer CLI, fg, the dashboard it launches, onboard-run): $GAFFER_DATA, never a
# repo checkout. crew itself resolves a relative crew.yaml event_log_path against
# the factory root; this keeps runner-spawned crew calls on the one log tick reads.
export GAFFER_CREW_EVENTS="${GAFFER_CREW_EVENTS:-$GAFFER_DATA/events.jsonl}"

# CONFIG PARTS. The defaults below the prologue live in runner/config/*.sh, one file per
# area, sourced here in this FIXED order: each part reads what the parts before it set,
# and the order is the order this file had when it was one file (the map and the order
# dependencies are in runner/CLAUDE.md). Parts are sourced, never run, so they share
# this shell and the record block at the end sees every export they made. A part that
# is missing, unreadable or did not load to its last line stops the process (fail
# closed): a half-loaded config must never run a tick. The parts are found next to this
# file (symlinks resolved), not under $RUNNER_DIR, which an operator may point elsewhere.
_GAFFER_CONFIG_DIR="${BASH_SOURCE[0]}"
while [ -h "$_GAFFER_CONFIG_DIR" ]; do
  _GAFFER_CONFIG_PART="$(readlink "$_GAFFER_CONFIG_DIR")"
  case "$_GAFFER_CONFIG_PART" in
    /*) _GAFFER_CONFIG_DIR="$_GAFFER_CONFIG_PART" ;;
    *) _GAFFER_CONFIG_DIR="$(dirname "$_GAFFER_CONFIG_DIR")/$_GAFFER_CONFIG_PART" ;;
  esac
done
_GAFFER_CONFIG_DIR="$(cd "$(dirname "$_GAFFER_CONFIG_DIR")" && pwd)/config"
_GAFFER_CONFIG_PART=""
# Every part ends with `_GAFFER_CONFIG_PART=<its name>`; anything else here means it did
# not load whole.
_gaffer_config_loaded() {
  [ "${_GAFFER_CONFIG_PART:-}" = "$1" ] && { _GAFFER_CONFIG_PART=""; return 0; }
  printf 'gaffer: runner/config/%s.sh is missing, unreadable or did not load to its end (looked in %s); refusing to go on with a half-loaded config (fail closed)\n' "$1" "$_GAFFER_CONFIG_DIR" >&2
  exit 1
}
# shellcheck source=config/01-settings.sh
[ -r "$_GAFFER_CONFIG_DIR/01-settings.sh" ] && . "$_GAFFER_CONFIG_DIR/01-settings.sh"; _gaffer_config_loaded 01-settings
# shellcheck source=config/02-paths.sh
[ -r "$_GAFFER_CONFIG_DIR/02-paths.sh" ] && . "$_GAFFER_CONFIG_DIR/02-paths.sh"; _gaffer_config_loaded 02-paths
# shellcheck source=config/03-wiring.sh
[ -r "$_GAFFER_CONFIG_DIR/03-wiring.sh" ] && . "$_GAFFER_CONFIG_DIR/03-wiring.sh"; _gaffer_config_loaded 03-wiring
# shellcheck source=config/04-models.sh
[ -r "$_GAFFER_CONFIG_DIR/04-models.sh" ] && . "$_GAFFER_CONFIG_DIR/04-models.sh"; _gaffer_config_loaded 04-models
# shellcheck source=config/05-budget.sh
[ -r "$_GAFFER_CONFIG_DIR/05-budget.sh" ] && . "$_GAFFER_CONFIG_DIR/05-budget.sh"; _gaffer_config_loaded 05-budget
# shellcheck source=config/06-routing.sh
[ -r "$_GAFFER_CONFIG_DIR/06-routing.sh" ] && . "$_GAFFER_CONFIG_DIR/06-routing.sh"; _gaffer_config_loaded 06-routing
# shellcheck source=config/07-limits.sh
[ -r "$_GAFFER_CONFIG_DIR/07-limits.sh" ] && . "$_GAFFER_CONFIG_DIR/07-limits.sh"; _gaffer_config_loaded 07-limits
# shellcheck source=config/08-guards.sh
[ -r "$_GAFFER_CONFIG_DIR/08-guards.sh" ] && . "$_GAFFER_CONFIG_DIR/08-guards.sh"; _gaffer_config_loaded 08-guards
# shellcheck source=config/09-render.sh
[ -r "$_GAFFER_CONFIG_DIR/09-render.sh" ] && . "$_GAFFER_CONFIG_DIR/09-render.sh"; _gaffer_config_loaded 09-render
# shellcheck source=config/10-locks.sh
[ -r "$_GAFFER_CONFIG_DIR/10-locks.sh" ] && . "$_GAFFER_CONFIG_DIR/10-locks.sh"; _gaffer_config_loaded 10-locks
# shellcheck source=config/11-agent-env.sh
[ -r "$_GAFFER_CONFIG_DIR/11-agent-env.sh" ] && . "$_GAFFER_CONFIG_DIR/11-agent-env.sh"; _gaffer_config_loaded 11-agent-env
# shellcheck source=config/12-identity.sh
[ -r "$_GAFFER_CONFIG_DIR/12-identity.sh" ] && . "$_GAFFER_CONFIG_DIR/12-identity.sh"; _gaffer_config_loaded 12-identity
# shellcheck source=config/13-stop.sh
[ -r "$_GAFFER_CONFIG_DIR/13-stop.sh" ] && . "$_GAFFER_CONFIG_DIR/13-stop.sh"; _gaffer_config_loaded 13-stop
# shellcheck source=config/14-usage.sh
[ -r "$_GAFFER_CONFIG_DIR/14-usage.sh" ] && . "$_GAFFER_CONFIG_DIR/14-usage.sh"; _gaffer_config_loaded 14-usage
# shellcheck source=config/15-modes.sh
[ -r "$_GAFFER_CONFIG_DIR/15-modes.sh" ] && . "$_GAFFER_CONFIG_DIR/15-modes.sh"; _gaffer_config_loaded 15-modes
# shellcheck source=config/16-sandbox.sh
[ -r "$_GAFFER_CONFIG_DIR/16-sandbox.sh" ] && . "$_GAFFER_CONFIG_DIR/16-sandbox.sh"; _gaffer_config_loaded 16-sandbox
# shellcheck source=config/17-cli.sh
[ -r "$_GAFFER_CONFIG_DIR/17-cli.sh" ] && . "$_GAFFER_CONFIG_DIR/17-cli.sh"; _gaffer_config_loaded 17-cli
# shellcheck source=config/18-review.sh
[ -r "$_GAFFER_CONFIG_DIR/18-review.sh" ] && . "$_GAFFER_CONFIG_DIR/18-review.sh"; _gaffer_config_loaded 18-review
# shellcheck source=config/19-libs.sh
[ -r "$_GAFFER_CONFIG_DIR/19-libs.sh" ] && . "$_GAFFER_CONFIG_DIR/19-libs.sh"; _gaffer_config_loaded 19-libs
# shellcheck source=config/20-gates.sh
[ -r "$_GAFFER_CONFIG_DIR/20-gates.sh" ] && . "$_GAFFER_CONFIG_DIR/20-gates.sh"; _gaffer_config_loaded 20-gates
unset -f _gaffer_config_loaded
unset _GAFFER_CONFIG_DIR _GAFFER_CONFIG_PART

# RE-SOURCE HYGIENE (see the top of this file): record every variable this source
# newly exported, with its value, so a child's re-source can tell a stale derived
# value (unchanged → derived afresh from settings.json / the mode / the defaults) from
# one a parent changed on purpose (kept). Keep this block LAST.
while IFS= read -r _dk; do
  # GIT_CONFIG_* (lib/git-safe.sh) is a numbered list: re-deriving
  # some entries and not others would corrupt it, so they are never recorded.
  case "$_dk" in '' | _GAFFER_* | GIT_CONFIG_*) continue ;; esac
  case "$_GAFFER_EXPORTED_AT_START" in *" $_dk "*) continue ;; esac
  printf -v "_GAFFER_DV_$_dk" '%s' "${!_dk}"
  export "_GAFFER_DV_$_dk"
done < <(compgen -e 2>/dev/null)
unset _dk _GAFFER_EXPORTED_AT_START
