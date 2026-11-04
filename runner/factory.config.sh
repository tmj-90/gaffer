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
: "${GAFFER_HOME:=$(cd "$RUNNER_DIR/.." && pwd)}"
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
unset -f _gaffer_config_loaded
unset _GAFFER_CONFIG_DIR _GAFFER_CONFIG_PART

# CLI helpers (use the built dist bins)
# memory-mcp uses its own bin layout + the MEMORY_DB env var (no --db flag).
: "${MEMORY_CLI_BIN:=$MEMORY_DIR/dist/bin/memory.js}"
: "${MEMORY_MCP_BIN:=$MEMORY_DIR/dist/bin/memory-mcp.js}"
: "${DISPATCH_MCP_BIN:=$DISPATCH_DIR/dist/mcp/bin.js}"   # substituted into .mcp.json by tick.sh

# --- DB-var fail-CLOSED guard (P1-B) -----------------------------------------
# The .mcp.json ships "${DISPATCH_DB}" / "${MEMORY_DB}" placeholders that
# tick.sh sed-substitutes, and the lg/wg wrappers + the memory server launch
# pass these through to the MCP servers. If either var is EMPTY/unset, the sed
# substitution writes a literal value and a stray DB file named e.g.
# `${MEMORY_DB}` gets created in cwd — and the MCP servers silently point at
# the wrong (empty-named) database. Fail CLOSED instead: assert both are
# non-empty before any consumption, with a clear, actionable error.
#
# Call this immediately before a sed-substitution of the MCP config OR before
# launching anything (lg/wg/memory server) that relies on these vars.
gaffer_assert_db_vars() {
  local missing=()
  [ -n "${DISPATCH_DB:-}" ] || missing+=("DISPATCH_DB")
  [ -n "${MEMORY_DB:-}" ]  || missing+=("MEMORY_DB")
  if [ "${#missing[@]}" -gt 0 ]; then
    printf 'gaffer: refusing to run — required DB var(s) empty/unset: %s\n' "${missing[*]}" >&2
    printf 'gaffer: set them (factory.config.sh defaults to $GAFFER_DATA/*.sqlite) so the MCP\n' >&2
    printf 'gaffer: servers point at a real database and no literal-named ${...} DB file is\n' >&2
    printf 'gaffer: created in the working directory.\n' >&2
    return 1
  fi
  return 0
}

wg() { gaffer_assert_db_vars || return 1; node "$DISPATCH_DIR/dist/cli/index.js" --db "$DISPATCH_DB" "$@"; }
# fg pins crew to the factory's $DISPATCH_DB (CREW_DISPATCH_DB beats crew.yaml's
# sqlite_path), so a drifted crew.yaml can't send drafts to a DB nobody reads.
# It also names the factory's memory store and the brownfield decomposer, as crew
# FALLBACKS (an explicit crew.yaml value wins): CREW_MEMORY_MCP_BIN + MEMORY_DB give
# the async idle loops a real memory client on the factory DB, CREW_DECOMPOSE_SCRIPT
# gives the feature-backlog loop its decomposer. Without them a `crew init` config
# left both null and the Settings "Feature backlog" toggle could never run.
fg() {
  CREW_DISPATCH_DB="${DISPATCH_DB:-}" MEMORY_DB="${MEMORY_DB:-}" \
  CREW_MEMORY_MCP_BIN="${CREW_MEMORY_MCP_BIN:-${MEMORY_MCP_BIN:-}}" \
  CREW_DECOMPOSE_SCRIPT="${CREW_DECOMPOSE_SCRIPT:-$RUNNER_DIR/bin/decompose.mjs}" \
    node "$CREW_DIR/dist/cli/index.js" -c "$CREW_CONFIG" "$@"
}
lg() { gaffer_assert_db_vars || return 1; MEMORY_DB="$MEMORY_DB" node "$MEMORY_CLI_BIN" "$@"; }

# The runner's JSON helpers (node — lib/json-tool.mjs replaces the former inline
# python3 programs; python3 is no longer a runtime dependency).
#   gaffer_json <subcommand> [args]   — see the table in lib/json-tool.mjs
#   jget '<js expression over d>'      — stdin JSON → d; prints the value ("" for
#                                        null); a parse/eval failure exits 1 with
#                                        no output so `|| echo <default>` applies.
gaffer_json() { node "$RUNNER_DIR/lib/json-tool.mjs" "$@"; }
jget() { gaffer_json expr "$1"; }

# RESUME REPORT (tick.sh): a resumed delivery holds no claim, so the agent's own evidence
# writes are refused and its prompt tells it to END its message with the AC -> test lines
# and the smallest-change note. Record the tail of that final text (the `.result` of the
# agent's JSON envelope in $2) as a runner-attributed manual_note on ticket $1, so the
# minimalism gate and the reviewer can read it. No text → nothing recorded (rc 0);
# a failed write → rc 1.
gaffer_record_resume_report() {
  local num="$1" usage="$2" report
  [ -n "$num" ] && [ -s "$usage" ] || return 0
  # The tolerant envelope parser every other agent-output reader uses (lib/worker.mjs).
  report="$(node "$RUNNER_DIR/lib/worker.mjs" parse-result result-text --json-file "$usage" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",(c)=>(s+=c)).on("end",()=>process.stdout.write(s.trim().slice(-4800)))' 2>/dev/null || true)"
  [ -n "$report" ] || return 0
  wg attach-evidence "$num" --type manual_note --summary "resume agent report: $report" >/dev/null 2>&1
}

# GRADUATED-AUTONOMY: the read-only ship decision the AFK gate consults per ticket —
# "is `auto` permitted for ticket $1 at gate $2 (approve|merge)?" It reuses dispatch's
# isAutonomyAllowed (env FLOOR OR an earned per-repo/risk `auto` policy) via the
# `wg ticket auto-decision` CLI, so the runner adds NO policy logic of its own and can
# never diverge from the enforced decision. The autonomy env flags are UNexported shell
# vars (see the GAFFER_MODE cluster above), so the floor is passed EXPLICITLY into the
# CLI's environment here — otherwise the child node process would see them unset. Echoes
# exactly `allow` or `deny`. FAILS CLOSED: any error, missing DB, or non-`allow` → `deny`.
gaffer_auto_decision() {
  local _ref="$1" _gate="$2" _out _dec
  _out="$(
    export AUTO_MERGE="${AUTO_MERGE:-0}" \
           MERGE_ON_AGENT_REVIEW="${MERGE_ON_AGENT_REVIEW:-0}" \
           DISPATCH_ALLOW_AGENT_APPROVE="${DISPATCH_ALLOW_AGENT_APPROVE:-0}"
    wg ticket auto-decision "$_ref" --gate "$_gate" 2>/dev/null
  )" || _out=""
  _dec="$(printf '%s' "$_out" | jget 'd.decision ?? "deny"' 2>/dev/null || echo deny)"
  [ "$_dec" = "allow" ] && printf 'allow\n' || printf 'deny\n'
}

# GRADUATED-AUTONOMY: per-repo `auto` policy rows are consulted ONLY inside the agent
# review pass (REVIEW_MODE=agent|both → gaffer_auto_decision). In the default supervised
# posture (REVIEW_MODE=human) no reviewer runs, so a policy the operator enabled shows
# "Enabled" in Settings and never acts. Detect that and say so — ONE line per run (the
# marker lives in the run's own state dir, lib/run-state.sh). Read-only
# and fail-soft: a missing DB / CLI error simply logs nothing. Echoes the number of inert
# `auto` rows found (0 when none / not applicable) for the caller's own use.
gaffer_inert_policy_check() {
  local _n=0 _marker="${GAFFER_DATA:+${GAFFER_RUN_STATE_DIR:-$GAFFER_DATA}/.autonomy-policy-inert-warned}"
  [ "${REVIEW_MODE:-human}" = "human" ] || { printf '0\n'; return 0; }
  _n="$(wg autonomy policies --mode auto 2>/dev/null | jget 'd.count ?? 0' 2>/dev/null || echo 0)"
  case "$_n" in ''|*[!0-9]*) _n=0 ;; esac
  if [ "$_n" -gt 0 ]; then
    if [ -z "$_marker" ] || [ ! -f "$_marker" ]; then
      log "AUTONOMY: WARNING — $_n per-repo 'auto' policy grant(s) are enabled but REVIEW_MODE=human, so no reviewer agent runs and the policies are never consulted: they are INERT. Set Review mode to agent or both (or Autonomy mode to graduated) for them to act, or turn them off in Settings."
      [ -n "$_marker" ] && : > "$_marker" 2>/dev/null
    fi
  fi
  printf '%s\n' "$_n"
  return 0
}

# HALF-CONFIGURED MERGE: MERGE_ON_AGENT_REVIEW ("Auto-merge on agent review") only
# EXTENDS Auto-merge on approval to agent approvals — the merge gate is AUTO_MERGE AND
# MERGE_ON_AGENT_REVIEW (dispatch's envAllowsAuto('merge')). Flipping only
# MERGE_ON_AGENT_REVIEW gives approve-and-hold: agent-approved work waits at
# ready_for_merge. We deliberately do NOT let one flag imply the other (that would turn
# on more unattended merging than the operator set); say so ONCE per run instead (the
# marker lives in the run's own state dir, lib/run-state.sh). Echoes
# 1 when it warned (or would have, marker already present), else 0.
gaffer_half_merge_config_check() {
  local _marker="${GAFFER_DATA:+${GAFFER_RUN_STATE_DIR:-$GAFFER_DATA}/.merge-config-half-warned}"
  if _gaffer_flag_on "${MERGE_ON_AGENT_REVIEW:-0}" && ! _gaffer_flag_on "${AUTO_MERGE:-0}"; then
    if [ -z "$_marker" ] || [ ! -f "$_marker" ]; then
      log "AUTONOMY: WARNING — MERGE_ON_AGENT_REVIEW=1 but AUTO_MERGE is off: 'Auto-merge on agent review' needs 'Auto-merge on approval' too, so agent-approved tickets will WAIT at ready_for_merge for a human merge. Turn AUTO_MERGE on to let them land (or turn MERGE_ON_AGENT_REVIEW off to silence this)."
      [ -n "$_marker" ] && : > "$_marker" 2>/dev/null
    fi
    printf '1\n'; return 0
  fi
  printf '0\n'
  return 0
}

# GRADUATED-AUTONOMY: the PURE ship-decision matrix — the single source of truth mapping
# (reviewer verdict × approve gate × merge gate) → one runner action, so the AFK block in
# tick.sh just dispatches on the result and the logic is unit-testable in isolation. No I/O,
# no side effects. FAIL-CLOSED: unless the approve gate is `allow` the plan is `hold`.
#   $1 verdict         : approve | changes | held   (the reviewer's advisory verdict)
#   $2 approve-decision: allow | deny         (gaffer_auto_decision <n> approve)
#   $3 merge-decision  : allow | deny         (gaffer_auto_decision <n> merge)
#   $4 review mode     : human | agent | both (optional; REVIEW_MODE)
# Echoes exactly one of:
#   hold          — the runner does NOT act; the ticket waits in_review for a human
#                   (supervised env floor, or a graduated repo/risk not yet earned).
#   rework        — approve earned + CHANGES verdict → reject to rework.
#   ship          — approve AND merge earned + APPROVE verdict → approve then auto-merge.
#   approve_hold  — approve earned + APPROVE verdict, but merge NOT earned → approve and
#                   hold at ready_for_merge for a human to merge.
# REVIEW_MODE=both is "an agent screens first, then a HUMAN confirms": the agent's
# APPROVE is never an approval there, whatever the floor or an earned policy row says —
# it HOLDS in_review for the human's confirm. The screen still bounces a CHANGES verdict
# back to rework (when the approve gate is earned), so the human sees only work the agent
# passed. Without this `both` behaved exactly like `agent` and shipped with no human.
gaffer_afk_ship_plan() {
  local _verdict="$1" _approve="$2" _merge="$3" _mode="${4:-}"
  if [ "$_approve" != "allow" ]; then printf 'hold\n'; return 0; fi
  if [ "$_verdict" = "approve" ]; then
    if [ "$_mode" = "both" ]; then printf 'hold\n'; return 0; fi
    [ "$_merge" = "allow" ] && printf 'ship\n' || printf 'approve_hold\n'
  elif [ "$_verdict" = "changes" ]; then
    printf 'rework\n'
  else
    printf 'hold\n'  # held / anything unexpected: no verdict → never rework on it
  fi
}

# The default SECURITY-SENSITIVE PATH regex, shared by the lite trivial classifier and
# the security second-review lane (one definition, so the two cannot drift). The
# `auth` stem carves out only `author`: author/authors/authoring used to trip it (an
# extra security reviewer per approve, and a lite trivial change held as "sensitive").
# auth + "or" matches only when followed by s/z (authorize*, authoris/zation). Every
# other auth* path stays a PREFIX match — auth, authn, authz, oauth/OAuth2,
# authentication, AuthGuard, auth.ts, auth/ and the lowercase compounds (authmiddleware,
# authhandler, authconfig, authprovider) that a required word boundary would lose. The
# other stems are PREFIX matches on purpose too — this is a security gate, so .env*
# (incl. .envrc), secrets*, security*, migrations* keep matching.
_GAFFER_SENSITIVE_PATH_RE='(^|/)([Mm]igrations?|\.github/|[Dd]ockerfile|[Oo]?[Aa]uth([^o]|o[^r]|ori[sz]|$)|[Ss]ecurity|[Ss]ecrets?|\.env|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|\.gaffer|safety-hook|runner/lib/hook/|runner/lib/dangerous-commands\.mjs)'

# LITE MODE trivial classifier — PURE core. Decides whether a ticket is trivial enough
# to auto-approve WITHOUT a human reviewer. This is an ADDITIONAL narrowing that only
# applies in GAFFER_MODE=lite: a trivial ticket has already passed the DoD (tests/lint/
# typecheck) + hygiene gates to reach in_review, and the reviewer AGENT must still return
# APPROVE; on top of that, ALL of these must hold or it holds for a human:
#   • risk_level = low
#   • diff within the TIGHT lite caps (GAFFER_LITE_MAX_LINES / GAFFER_LITE_MAX_FILES)
#   • touches NO sensitive path (migrations, CI, Dockerfile, auth/security/secrets, lockfiles,
#     the factory's own .gaffer / safety-hook, its runner/lib/hook/ rule modules and its
#     deny list runner/lib/dangerous-commands.mjs):
#     GAFFER_LITE_SENSITIVE_RE, operator-tunable.
# NB: intentionally tiny caps (60 lines / 4 files) — "trivial" means a typo/doc/small-config
# change, NOT the 400-line minimalism cap. No I/O, no side effects; echoes `trivial` or
# `nontrivial:<reason>` so the caller can log WHY a ticket was held.
#   $1 risk   $2 lines(int)   $3 files(int)   $4 changed-paths(newline-separated)
gaffer_lite_trivial_reason() {
  local _risk="$1" _lines="$2" _files="$3" _paths="$4"
  local _maxl="${GAFFER_LITE_MAX_LINES:-60}" _maxf="${GAFFER_LITE_MAX_FILES:-4}"
  local _re="${GAFFER_LITE_SENSITIVE_RE:-$_GAFFER_SENSITIVE_PATH_RE}"
  [ "$_risk" = "low" ] || { printf 'nontrivial:risk=%s\n' "$_risk"; return 0; }
  case "$_lines" in '' | *[!0-9]*) _lines=999999 ;; esac
  case "$_files" in '' | *[!0-9]*) _files=999999 ;; esac
  [ "$_lines" -le "$_maxl" ] || { printf 'nontrivial:lines=%s>%s\n' "$_lines" "$_maxl"; return 0; }
  [ "$_files" -le "$_maxf" ] || { printf 'nontrivial:files=%s>%s\n' "$_files" "$_maxf"; return 0; }
  # Here-string, not `printf | grep -q`: under pipefail grep's early exit can SIGPIPE
  # the printf and turn this MATCH into a miss — a sensitive diff called "trivial".
  if grep -qE -- "$_re" <<<"$_paths"; then printf 'nontrivial:sensitive-path\n'; return 0; fi
  printf 'trivial\n'
}

# LITE MODE trivial classifier — I/O wrapper. Gathers the ticket risk (dispatch) + the
# delivered diff's size and paths (git, from the review worktree's branch vs base) and runs
# the pure core. Returns 0 (trivial → runner may auto-approve) / 1 (non-trivial → hold for a
# human). Sets GAFFER_LITE_REASON / _LINES / _FILES for the caller's log + evidence marker.
# FAIL-CLOSED: a missing risk defaults to 'medium' (non-trivial); unreadable diff → large.
#   $1 ticket#   $2 repo-path   $3 base-ref   $4 delivery-branch
gaffer_ticket_is_trivial() {
  local _num="$1" _repo="$2" _base="$3" _branch="$4" _risk _stat _lines _files _paths _r
  _risk="$(wg ticket show "$_num" 2>/dev/null | jget 'd.ticket.risk_level || "medium"' 2>/dev/null || echo medium)"
  _stat="$(git -C "$_repo" diff "$_base"..."$_branch" --numstat 2>/dev/null)"
  _lines="$(printf '%s\n' "$_stat" | awk 'NF{a+=($1 ~ /^[0-9]+$/ ? $1 : 0)+($2 ~ /^[0-9]+$/ ? $2 : 0)} END{print a+0}')"
  _files="$(printf '%s\n' "$_stat" | awk 'NF' | grep -c . || true)"
  _paths="$(git -C "$_repo" diff "$_base"..."$_branch" --name-only 2>/dev/null)"
  _r="$(gaffer_lite_trivial_reason "$_risk" "${_lines:-0}" "${_files:-0}" "$_paths")"
  GAFFER_LITE_REASON="$_r"; GAFFER_LITE_LINES="${_lines:-0}"; GAFFER_LITE_FILES="${_files:-0}"
  case "$_r" in trivial) return 0 ;; *) return 1 ;; esac
}

# SECURITY SECOND OPINION — decides whether a ticket gets a SECOND, security-focused
# reviewer pass after the primary reviewer APPROVEs (lib/review.sh). A ticket qualifies
# when its risk_level is high, or when the delivered diff touches a security-sensitive
# path (auth, secrets, migrations, CI, Dockerfiles, lockfiles, the factory's own guards —
# GAFFER_SECURITY_REVIEW_RE, operator-tunable; defaults to the lite sensitive-path
# regex). GAFFER_SECURITY_REVIEW=0 disables the lane; empty/1 = on. Sets
# GAFFER_SECURITY_REVIEW_REASON for the log. Returns 0 (needs it) / 1 (does not).
#   $1 ticket number  $2 repo path  $3 base branch  $4 delivery branch
: "${GAFFER_SECURITY_REVIEW:=1}"
# MERGE LANE (lib/merge-lane.sh): at the start of every tick, land every ready_for_merge
# ticket the merge policy permits (a human's approve, the tester's PASS, a merge gate
# held at review time and since earned) through the same landing the review pass uses,
# so dependents unblock without the dashboard's Merge button. 0 = off (a ready_for_merge
# ticket then waits for a human to merge — the pre-lane behaviour).
: "${GAFFER_MERGE_LANE:=1}"
# CONFLICT RESOLVER (lib/land.sh): when a landing hits a merge CONFLICT (the branch forked
# before a sibling landed on the same files), spawn bin/merge-ticket.mjs's resolver agent
# ONCE per ticket: it merges the default branch into the delivery branch in a throwaway
# worktree, resolves preserving both sides, and reopens the ticket for re-review of the
# resolved diff (never a silent landing). 0 = off (a conflict holds the ticket at
# ready_for_merge for a human, and its dependents wait). Bounded by GAFFER_MERGE_TIMEOUT_MS.
: "${GAFFER_CONFLICT_RESOLVER:=1}"
# MERGE GATE (lib/land.sh, bin/merge-ticket.mjs): every landing first builds the merge of
# the approved commit onto the CURRENT target in a scratch worktree and runs the repo's
# DoD gates on that merge (bin/dod-regate.sh: test, lint and the same typecheck command
# as the delivery gate, gaffer_dod_typecheck_cmd); a red combination is held for a human
# (blocked, merge_gate_red) and the target is not touched. The gated merge commit lands
# only while the target still is the gated head; a target that moved meanwhile is
# re-gated up to this many times, then the ticket waits for the next run. Always on
# (GAFFER_DOD=0, which turns every gate off, is the only way to land ungated).
: "${GAFFER_MERGE_GATE_RETRIES:=2}"
export GAFFER_MERGE_GATE_RETRIES   # read by bin/merge-ticket.mjs (a child process)
gaffer_needs_security_review() {
  local _num="$1" _repo="$2" _base="$3" _branch="$4" _risk _paths _re
  GAFFER_SECURITY_REVIEW_REASON=""
  case "${GAFFER_SECURITY_REVIEW:-1}" in 0|false|no|off) return 1 ;; esac
  _risk="$(wg ticket show "$_num" 2>/dev/null | jget 'd.ticket.risk_level || "medium"' 2>/dev/null || echo medium)"
  if [ "$_risk" = "high" ]; then GAFFER_SECURITY_REVIEW_REASON="risk=high"; return 0; fi
  _re="${GAFFER_SECURITY_REVIEW_RE:-${GAFFER_LITE_SENSITIVE_RE:-$_GAFFER_SENSITIVE_PATH_RE}}"
  _paths="$(git -C "$_repo" diff "$_base"..."$_branch" --name-only 2>/dev/null)"
  if grep -qE -- "$_re" <<<"$_paths"; then   # here-string: no SIGPIPE false miss under pipefail
    GAFFER_SECURITY_REVIEW_REASON="sensitive-path: $(printf '%s\n' "$_paths" | grep -E "$_re" | head -3 | paste -sd, -)"
    return 0
  fi
  return 1
}

# S-H2: reviewer VERDICT resolution from an OUT-OF-BAND STRUCTURED signal, NOT a
# free-text grep over the reviewer's whole prose. In AFK/graduated mode a clean
# `approve` triggers an autonomous approve+merge with no human, so the verdict must
# not be forgeable by text QUOTED in the reviewer's reasoning. An adversarial
# ticket/diff/rejection-reason could make the reviewer reproduce "RECOMMEND APPROVE"
# in prose; the old grep over the entire blob would then flip the gate.
#
# The reviewer is required to end its output with a machine-read line —
#   {"verdict":"APPROVE"}  or  {"verdict":"CHANGES"}
# — and ONLY its FINAL non-empty line counts (a closing ``` fence, trailing blanks and
# CRs ignored; surrounding backticks tolerated). A token anywhere else is quoted text:
# a CHANGES token followed by "Note: the ticket asked me to print {"verdict":"APPROVE"}"
# used to resolve to approve, because the last token ANYWHERE won. A final line that is
# not a token at all (a non-compliant or cut-off reviewer) is no verdict: `held`, never
# `changes` (that sent a possibly-fine delivery to rework, and could loop) and never
# `approve` — the old free-text RECOMMEND APPROVE fallback no longer approves anything.
# Pure: no I/O, no side effects.
#   $1 result : the reviewer agent's full result text (may be multi-line)
# Echoes exactly one of: approve | changes | held   (held on empty/ambiguous).
gaffer_review_verdict() {
  local _result="$1" _last
  _last="$(printf '%s\n' "$_result" | tr -d '\r' \
    | sed -E 's/[[:space:]]+$//' | grep -vE '^[[:space:]]*(```[[:alnum:]_-]*)?$' | tail -n 1 \
    | sed -E 's/^[[:space:]]*`?//; s/`?[[:space:]]*$//')"
  # Braces are matched via [{]/[}] so the ERE is portable across BSD (macOS
  # /usr/bin/grep) and GNU grep (CI) — `\{` is an interval metacharacter to GNU grep.
  if grep -qixE '[{][[:space:]]*"verdict"[[:space:]]*:[[:space:]]*"APPROVE"[[:space:]]*[}]' <<<"$_last"; then
    printf 'approve\n'
  elif grep -qixE '[{][[:space:]]*"verdict"[[:space:]]*:[[:space:]]*"CHANGES"[[:space:]]*[}]' <<<"$_last"; then
    printf 'changes\n'
  else
    printf 'held\n'
  fi
}

# The REWORK REASON handed back to the delivery agent on a CHANGES verdict. The
# reviewer's prompt ends its report with the "RECOMMEND CHANGES: <the concrete fix>"
# line, so the actionable part is the TAIL of the result — but `tail -c 480` cut a
# long report mid-word and kept the verdict token, so the agent read "…viour and is
# acceptable… {"verdict":"CHANGES"}" with the actual ask truncated (seen live). Keep
# the text FROM the last RECOMMEND CHANGES marker (the reviewer's own summary of what
# to fix), drop the structured verdict token, collapse whitespace, cap from the FRONT
# at 600 chars; with no marker fall back to the last 480 chars as before.
#   gaffer_review_reason <reviewer result>   → one line, never empty
gaffer_review_reason() {
  local _result="$1" _flat _from _reason
  _flat="$(printf '%s' "$_result" | tr '\n' ' ' \
    | sed -E 's/[{][[:space:]]*"verdict"[[:space:]]*:[[:space:]]*"[A-Za-z]+"[[:space:]]*[}]//g' \
    | tr -s ' ')"
  _from="$(printf '%s' "$_flat" | grep -oiE 'RECOMMEND[ _-]*CHANGES.*$' | tail -n 1)"
  if [ -n "$_from" ]; then _reason="$(printf '%s' "$_from" | cut -c1-600)"; else _reason="$(printf '%s' "$_flat" | tail -c 480)"; fi
  _reason="$(printf '%s' "$_reason" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
  [ -n "$_reason" ] || _reason="agent review recommended changes"
  printf '%s\n' "$_reason"
}

# Strict-execution-mode provider seam (defines sandbox_wrap_cmd). Sourced last so
# it can read the GAFFER_DATA / STRICT_* config above. Best-effort: a missing file
# must not break the suite, but it ships in-tree so this is just defensive.
# shellcheck source=lib/sandbox.sh
[ -f "$RUNNER_DIR/lib/sandbox.sh" ] && source "$RUNNER_DIR/lib/sandbox.sh"

# Worker seam (defines worker_deliver — the ONE headless `claude -p` invocation).
# Sourced after sandbox.sh so worker_deliver can rely on gaffer_timeout /
# gaffer_agent_env / CLAUDE_* being defined above. Mirrors the sandbox seam's
# fail-soft source guard; it ships in-tree so this is just defensive.
# shellcheck source=lib/worker.sh
[ -f "$RUNNER_DIR/lib/worker.sh" ] && source "$RUNNER_DIR/lib/worker.sh"

# Per-day cost guard helpers (gaffer_day_count / gaffer_bump_day_count /
# gaffer_day_cap_ok). Sourced after the config above so they read MAX_TICKS_PER_DAY
# and DAILY_COUNTER_FILE.
# shellcheck source=lib/budget.sh
[ -f "$RUNNER_DIR/lib/budget.sh" ] && source "$RUNNER_DIR/lib/budget.sh"

# Per-run state dirs (gaffer_run_state_begin / _end: every run's own skip and marker
# lists) and the dashboard Poll's lock (gaffer_poll_lock_acquire / _release).
# shellcheck source=lib/run-state.sh
[ -f "$RUNNER_DIR/lib/run-state.sh" ] && source "$RUNNER_DIR/lib/run-state.sh"

# Usage-window pause helpers (gaffer_usage_pause_record / _active / _until / _wait):
# a usage-limit or rate-limit refusal pauses admission until the window resets.
# shellcheck source=lib/usage-pause.sh
[ -f "$RUNNER_DIR/lib/usage-pause.sh" ] && source "$RUNNER_DIR/lib/usage-pause.sh"

# Auto-merge helper (defines gaffer_auto_merge). In-tree, so this is defensive.
# shellcheck source=lib/automerge.sh
[ -f "$RUNNER_DIR/lib/automerge.sh" ] && source "$RUNNER_DIR/lib/automerge.sh"

# Prompt quarantine (defines gaffer_quarantine + QUARANTINE_NOTICE) — wraps
# untrusted ticket-derived fields in a delimited envelope before they reach the
# agent prompt (P1 prompt-injection). In-tree, so this is defensive.
# shellcheck source=lib/quarantine.sh
[ -f "$RUNNER_DIR/lib/quarantine.sh" ] && source "$RUNNER_DIR/lib/quarantine.sh"

# Delivery-hygiene assertions (defines gaffer_assert_clean_delivery /
# gaffer_assert_repo_clean). HARD-FAIL guard against the unattended-run leaks.
# shellcheck source=lib/hygiene.sh
[ -f "$RUNNER_DIR/lib/hygiene.sh" ] && source "$RUNNER_DIR/lib/hygiene.sh"
# Agent-env helpers shared by every spawn site: the verified settings.json write
# and the worktree node_modules linker (see lib/agent-env.sh).
# shellcheck source=lib/agent-env.sh
[ -f "$RUNNER_DIR/lib/agent-env.sh" ] && source "$RUNNER_DIR/lib/agent-env.sh"
# Execution preflight: `npm ping` from INSIDE the agent's allowlisted env (preflight.sh
# report + the bootstrap gate in tick.sh). Fail-soft: skipped when npm is absent.
# shellcheck source=lib/registry-probe.sh
[ -f "$RUNNER_DIR/lib/registry-probe.sh" ] && source "$RUNNER_DIR/lib/registry-probe.sh"
# Claude auth preflight: is a credential visible (free), or does one tiny call work
# (GAFFER_PREFLIGHT_LIVE=1)? Report-only, used by preflight.sh.
# shellcheck source=lib/claude-auth.sh
[ -f "$RUNNER_DIR/lib/claude-auth.sh" ] && source "$RUNNER_DIR/lib/claude-auth.sh"
# Acceptance gate (runner half): the prompt block for an epic's acceptance ticket.
# shellcheck source=lib/acceptance.sh
[ -f "$RUNNER_DIR/lib/acceptance.sh" ] && source "$RUNNER_DIR/lib/acceptance.sh"

# Minimalism post-condition (defines gaffer_diff_stats / gaffer_check_minimalism).
# shellcheck source=lib/minimalism.sh
[ -f "$RUNNER_DIR/lib/minimalism.sh" ] && source "$RUNNER_DIR/lib/minimalism.sh"

# Per-agent SKILL mount + skill-selection telemetry (defines gaffer_skills_mount /
# gaffer_skills_mount_cleanup / gaffer_record_skill_usage). Mounts ONLY the
# selected + universal skill subset into an agent's .claude/skills instead of the
# whole library, so Claude Code doesn't auto-load all ~66 frontmatter blocks.
# shellcheck source=lib/skills-mount.sh
[ -f "$RUNNER_DIR/lib/skills-mount.sh" ] && source "$RUNNER_DIR/lib/skills-mount.sh"

# Shared file-card context primer (defines gaffer_prime_context_block).
# Sourced after the config above so it can use lg / MEMORY_CLI_BIN / MEMORY_DB.
# shellcheck source=lib/context-primer.sh
[ -f "$RUNNER_DIR/lib/context-primer.sh" ] && source "$RUNNER_DIR/lib/context-primer.sh"

# shellcheck source=lib/card-refresh.sh
# Memory FRESHNESS: write-through file-card refresh after a delivery merges (uses lg +
# the canonical contract, so sourced after context-primer which sets them up).
[ -f "$RUNNER_DIR/lib/card-refresh.sh" ] && source "$RUNNER_DIR/lib/card-refresh.sh"

# Definition-of-Done gate (I3): defines gaffer_run_dod_gates / gaffer_dod_enabled /
# gaffer_dod_run_one / gaffer_dod_summary_line / gaffer_dod_evidence_summary. The
# enforced, runner-run gate (tests/typecheck/lint) every delivery clears BEFORE the
# human review lane. In-tree, so this is defensive.
# GAFFER_ALLOW_NO_DOD=1 — waiver for repos with genuinely no runnable gates: a
# delivery that passes with ZERO gates executed is otherwise a hard fail (the work
# was never verified). Set only when test_command and lint_command are deliberately
# absent; without it the delivery is parked for the operator to investigate.
# GAFFER_DOD_INSTALL (default 1/ON) — before the DoD test gate runs, auto-install
# the delivery worktree's dependencies so the tests can actually run. A fresh
# throwaway worktree has no node_modules, so the first greenfield deliveries used
# to fail the gate ("tests could not run"); this removes that gotcha. Safe-soft: a
# strict no-op when node_modules already exists or the repo is not a recognised
# node project, bounded by GAFFER_DOD_INSTALL_TIMEOUT (defaults to GAFFER_DOD_TIMEOUT,
# 900s), and fail-soft — a failed/timed-out install never crashes the tick and never
# passes the gate (the gate still runs and fails loudly). Set GAFFER_DOD_INSTALL=0
# (or the existing GAFFER_GREENFIELD_INSTALL=0) for byte-identical-to-today behaviour.
# shellcheck source=lib/dod.sh
[ -f "$RUNNER_DIR/lib/dod.sh" ] && source "$RUNNER_DIR/lib/dod.sh"
# MACHINE-CHECKABLE acceptance criteria: the runner executes each AC's check_command
# in the delivery worktree after the DoD gates and records the verdict server-side.
# shellcheck source=lib/ac-checks.sh
[ -f "$RUNNER_DIR/lib/ac-checks.sh" ] && source "$RUNNER_DIR/lib/ac-checks.sh"

# Recoverable-delivery + ask-on-cap primitives (GUARD B / GUARD C): defines
# gaffer_branch_has_commits / gaffer_any_branch_has_commits (recoverable-vs-
# unrecoverable discriminator), gaffer_is_cap_hit / gaffer_cap_num_turns /
# gaffer_delivery_spend (cap detection + spend for the ask-on-cap notify).
# shellcheck source=lib/delivery-recovery.sh
[ -f "$RUNNER_DIR/lib/delivery-recovery.sh" ] && source "$RUNNER_DIR/lib/delivery-recovery.sh"

# Per-repo backpressure (defines gaffer_repo_pressure / gaffer_repo_in_backpressure).
# shellcheck source=lib/backpressure.sh
[ -f "$RUNNER_DIR/lib/backpressure.sh" ] && source "$RUNNER_DIR/lib/backpressure.sh"

# Orphaned-worktree recovery (defines gaffer_cleanup_orphaned_worktrees) — sweeps
# stale per-ticket worktrees left by killed workers (A-1 parallel execution).
# shellcheck source=lib/orphan-recovery.sh
[ -f "$RUNNER_DIR/lib/orphan-recovery.sh" ] && source "$RUNNER_DIR/lib/orphan-recovery.sh"

# Cleanup ownership (defines gaffer_note_own_claim / gaffer_cleanup_owned): a tick's
# teardown removes a worktree or branch only while this run still owns it (external
# review #8: a stopped or expired worker deleted its replacement's submitted branch).
# shellcheck source=lib/cleanup-ownership.sh
[ -f "$RUNNER_DIR/lib/cleanup-ownership.sh" ] && source "$RUNNER_DIR/lib/cleanup-ownership.sh"

# Dashboard process tracking (defines gaffer_dashboard_pid / _pidfile / _write_pid):
# precise running-detection via a recorded+validated PID instead of a broad pgrep.
# shellcheck source=lib/dashboard.sh
[ -f "$RUNNER_DIR/lib/dashboard.sh" ] && source "$RUNNER_DIR/lib/dashboard.sh"

# Greenfield bootstrap helpers (defines gaffer_bootstrap_repo_name / _repo_dir /
# _target_ok / _init / _onboard) — the create-a-repo delivery mode for bootstrap
# tickets. In-tree, so this is defensive.
# shellcheck source=lib/greenfield.sh
[ -f "$RUNNER_DIR/lib/greenfield.sh" ] && source "$RUNNER_DIR/lib/greenfield.sh"

# Clarify gate: when idle (nothing ready), run a headless clarify pass over an
# un-specified DRAFT. OFF by default — clarifying spends tokens every idle tick.
# Set to 1 for a factory you want actively refining its own backlog while idle.
: "${CLARIFY_DRAFTS_WHEN_IDLE:=0}"
: "${IDLE_DRAFT_WHEN_IDLE:=0}"
# Maintenance lane ENV override. The lane's own switch is crew.yaml's
# loops.maintenance.enabled (Settings → Idle loops). Empty (default) = crew.yaml
# decides; 0 = kill switch (an idle tick never asks crew); 1 = force the lane even
# when the crew.yaml switch is off. It only turns the LANE on: the lane rotates
# through the idle loops you enabled (each loop's own flag), so with none enabled an
# idle tick still does nothing and reports no_work.
: "${GAFFER_MAINTENANCE:=}"   # env override for the idle maintenance lane: empty = crew.yaml decides, 0 = off, 1 = force (a lane must still be enabled)

# --- H4: real PR creation (opt-in) -------------------------------------------
# When GAFFER_CREATE_PR=1 AND the primary write repo has a GitHub remote, the
# runner runs `gh pr create` after a successful delivery and records the resulting
# URL back as pr_url on the ticket. Off by default — opt in per-run or globally.
# The `gh` binary is injectable via GAFFER_GH_BIN (default: `gh`) so tests can
# stub it without a real remote.
# PR MODE lands the approved change THROUGH that PR: the dashboard merge
# (bin/merge-ticket.mjs) and the AFK merge (lib/review.sh → gaffer_pr_merge) run
# `gh pr merge <pr_url> --<GAFFER_PR_MERGE_METHOD> --delete-branch` and then
# fast-forward the local default branch from GAFFER_PR_REMOTE; a gh failure falls
# back to the local merge with the reason logged. Without a pr_url the merge is the
# local one, exactly as before.
: "${GAFFER_CREATE_PR:=0}"   # 1/true/yes/on to enable real PR creation; default OFF
: "${GAFFER_GH_BIN:=gh}"     # injectable gh binary (for tests)
: "${GAFFER_PR_MERGE_METHOD:=merge}"   # how an approved PR is landed: merge | squash | rebase
export GAFFER_CREATE_PR GAFFER_GH_BIN GAFFER_PR_MERGE_METHOD

# --- H3: CI-aware review gate (opt-in) ----------------------------------------
# When GAFFER_REQUIRE_CI=1, after the delivery branch/PR exists the runner polls
# `gh pr checks <branch>` until checks are green, then lets the ticket enter the
# human review lane. If CI goes red, the ticket is auto-rejected back to rework
# with the failing check (name + url) as evidence. On poll timeout the gate
# surfaces "CI still pending" and proceeds rather than hanging forever.
# REQUIRES GAFFER_CREATE_PR: the checks are read off the delivery PR, so with PR
# creation off there is no PR to poll — the gate then logs one clear warning per run
# and SKIPS (proceeds to review) instead of polling a PR that never exists and
# rejecting every delivery at the timeout.
# Off by default — fully backward-compatible when unset.
: "${GAFFER_REQUIRE_CI:=0}"            # 1/true/yes/on to require CI green before review (needs GAFFER_CREATE_PR)
: "${GAFFER_CI_POLL_ATTEMPTS:=20}"     # max poll cycles before "still pending" timeout
: "${GAFFER_CI_POLL_INTERVAL_SECS:=30}" # seconds between polls
export GAFFER_REQUIRE_CI GAFFER_CI_POLL_ATTEMPTS GAFFER_CI_POLL_INTERVAL_SECS

# H4 PR-creation helper (defines gaffer_create_pr / gaffer_pr_create_enabled /
# gaffer_has_github_remote / gaffer_build_pr_body). Sourced here so the functions
# are available in tick.sh which sources factory.config.sh.
# shellcheck source=lib/pr-create.sh
[ -f "$RUNNER_DIR/lib/pr-create.sh" ] && source "$RUNNER_DIR/lib/pr-create.sh"

# H3 CI-gate helper (defines gaffer_ci_gate / gaffer_ci_gate_enabled /
# gaffer_parse_checks). Sourced here for the same reason.
# shellcheck source=lib/ci-gate.sh
[ -f "$RUNNER_DIR/lib/ci-gate.sh" ] && source "$RUNNER_DIR/lib/ci-gate.sh"

# EVAL JUDGE (lib/eval-judge.sh): 1 = after every submitted delivery an independent judge
# scores the diff against the ticket on the crew rubric (AC coverage, correctness,
# minimalism, test adequacy, security) with a reason per dimension, into
# $GAFFER_DATA/eval-ledger.jsonl and onto the ticket: the Review view's verdict strip and
# `wg ticket show` carry the score and the weak dimensions' reasons. Advisory only: it
# never blocks, parks or reworks a ticket. Off by default because it is one extra paid
# model call per delivery (booked as kind eval-judge). Whether it earns that on your
# factory is measured, not assumed: after 20 or more reviewed deliveries,
# `gaffer eval agreement` pairs each score with the review outcome and says whether it
# separates the work you accepted from the work you sent back. 0 = off.
# See docs/eval-harness.md.
: "${GAFFER_EVAL_JUDGE:=0}"

# MATCHED EXPERIMENTS (runner/eval/experiment.sh, `gaffer eval experiment`): the same
# tickets under two or more arms of settings, paired differences per ticket. Stub mode (the
# default) is free and ignores the dollar cap; a LIVE run (--live) needs a hard USD cap for
# the whole run, which also caps every call, and still passes the factory's own budget
# admission and usage pause. A person starts one: the safety hook denies it to an agent.
: "${GAFFER_EXPERIMENT_MAX_USD:=}"       # Hard USD cap of one LIVE experiment run (every call is capped at what is left); required for --live, empty = live mode refuses
: "${GAFFER_EXPERIMENT_MAX_TICKETS:=5}"  # At most this many tickets in one experiment (each runs once per arm)
: "${GAFFER_EXPERIMENT_MAX_ATTEMPTS:=2}" # Attempts per ticket and arm: the first plus reworks after a failed gate, every one counted

# REVIEW RULES (dispatch): the same send-back reason or must-fix comment from a person
# (after dropping ids, paths and numbers) on this many tickets in one repo is proposed as a
# lore convention draft tagged review-rule, which a person approves (gaffer lore approve or
# the Memory view); it never auto-approves, MEMORY_AUTO_APPROVE included. Only a person's
# feedback counts, never an agent's or the tester's. 2..20; `wg review-rules` lists them.
# Read by dispatch (the dashboard server and `gaffer wg`), so it is a dashboard setting and
# exported like the other dispatch knobs: an unexported default here never reached it.
: "${GAFFER_REVIEW_RULE_REPEAT:=3}"
export GAFFER_REVIEW_RULE_REPEAT
# Post-delivery quality judging (gaffer_eval_judge_delivery): scores a submitted
# delivery on the crew rubric into the eval ledger (pass rate / cost-per-pass /
# memory score gap telemetry). Always fail-soft.
# shellcheck source=lib/eval-judge.sh
[ -f "$RUNNER_DIR/lib/eval-judge.sh" ] && source "$RUNNER_DIR/lib/eval-judge.sh"
# The pre-work scout (gaffer_scout_run, gaffer_model_scout): the deterministic packet of
# likely files and the risk classifier before each delivery; the bounded model scout is
# opt-in (GAFFER_SCOUT). Always fail-soft.
# shellcheck source=lib/scout.sh
[ -f "$RUNNER_DIR/lib/scout.sh" ] && source "$RUNNER_DIR/lib/scout.sh"
# The replay manifest of each delivery attempt (gaffer_manifest_start / _finish / _close /
# _annotate): what an offline experiment re-runs and the routing scorecard joins on.
# Measurements only; always fail-soft. Stubs keep tick.sh's calls safe without the lib.
# shellcheck source=lib/replay-manifest.sh
if [ -f "$RUNNER_DIR/lib/replay-manifest.sh" ]; then
  source "$RUNNER_DIR/lib/replay-manifest.sh"
else
  gaffer_manifest_start() { :; }; gaffer_manifest_gates() { :; }; gaffer_manifest_finish() { :; }
  gaffer_manifest_close() { :; }; gaffer_manifest_annotate() { :; }
fi

# HOST GIT NEVER RUNS REPOSITORY CODE (external review #9, finding 2). Every git the
# runner runs for bookkeeping (auto-commit, worktrees, fetch/merge/push, status) gets
# core.hooksPath=/dev/null and core.fsmonitor=false through GIT_CONFIG_COUNT, so an
# agent's edit to a tracked hook script never executes on the host. tick.sh and land.sh
# call it again with the ticket's repositories to neutralise drivers/helpers that point
# into them (lib/git-safe.mjs). The agent's own env is allowlisted, so it never sees these.
# shellcheck source=lib/git-safe.sh
if [ -f "$RUNNER_DIR/lib/git-safe.sh" ]; then
  source "$RUNNER_DIR/lib/git-safe.sh"
  gaffer_git_harden
fi

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
