# shellcheck shell=bash
# runner/config/01-settings.sh: the fourteen settings: their spec, strict validation, the
# settings.json loader (the fourteen only; old keys go to the migration below), the
# derivation-table helper every later part uses, and the environment-only keys.
# Sourced by runner/factory.config.sh only, in its fixed order, never directly or on
# its own: it reads what the parts before it set. The last line tells
# factory.config.sh this part loaded whole.

# ── THE FOURTEEN SETTINGS ─────────────────────────────────────────────────────
# A person sets these and nothing else: README, docs/CONFIG.md, the dashboard and
# settings.json know only them. Every other knob is DERIVED from them by a small table
# in the config part of its area (`_gaffer_derive <SETTING> <<'_GAFFER_TABLE_'`, below),
# and a real environment variable for a derived name still overrides it (the one
# override, kept for good). One line per setting:
#   NAME|kind|accepted values|default|one-line description
# kind: choice (one of the values), usd (empty or a dollar amount), count (1..64),
# models (a preset or "strong,standard,cheap"), gates (standard | strict, or in the
# environment a list of tests, lint, typecheck), testing (auto | on | off), notify (a
# list of webhook / Slack URLs and "desktop"), path (absolute), port (1..65535).
# scripts/config-reference.mjs reads this block and the tables to write docs/CONFIG.md,
# docs/CONFIG-ADVANCED.md and runner/config/settings-schema.json (what the dashboard reads).
_GAFFER_SETTINGS_SPEC='
GAFFER_MODE|choice|supervised lite graduated autonomous strict|supervised|Who approves and merges agent work: supervised (a person approves every merge), lite (trivial work is approved by the reviewer agent, a person merges), graduated (only what each repository earned ships on its own), autonomous (agents approve, merge and push inside the OS sandbox), strict (autonomous, and the sandbox wraps the agent even under the environment opt-out).
GAFFER_DAILY_BUDGET_USD|usd||(none)|The most the factory may spend in one UTC day, in dollars; empty is no daily cap. A live run needs this or GAFFER_BUDGET_USD.
GAFFER_BUDGET_USD|usd||(none)|The most the factory may spend in its lifetime (the whole usage ledger), in dollars; empty is no lifetime cap.
GAFFER_MODELS|models|standard economy strong|standard|The three models, as "strong,standard,cheap" (each a model id), or a preset: standard (opus,sonnet,haiku), economy (sonnet,sonnet,haiku: the strong tier moves to sonnet; implementation and review stay on sonnet), strong (opus,opus,sonnet).
GAFFER_EFFORT|choice|small standard large|standard|How much work one ticket may take: small, standard or large (time per agent call, turns, delivery attempts, gate and CI time).
GAFFER_CONCURRENCY|count||1|How many tickets the factory delivers at once (1 to 64).
GAFFER_SANDBOX|choice|auto docker sandbox-exec|auto|Which OS sandbox contains every agent: auto (sandbox-exec on macOS, else docker), docker or sandbox-exec. Running with none is only the environment opt-out GAFFER_STRICT_REQUIRE=0.
GAFFER_GATES|gates|standard strict|standard|The Definition-of-Done gates: standard (tests, lint and typecheck must pass) or strict (also a smallest-change note, tighter size flags, no flaky rerun). In the environment only, a list such as "tests,lint" runs only those.
GAFFER_LANDING|choice|local pr|local|How approved work lands: local (merged into the default branch of the repository on this machine) or pr (a pull request per delivery: it enters review once its checks are green, and an approved one is merged through the pull request).
GAFFER_TESTING|testing|auto on off|auto|The independent tester lane: auto (on where a repository has a test command), on (every testable ticket) or off (only the acceptance ticket of an epic).
GAFFER_IDLE|choice|auto off maintenance backlog all|auto|What the factory does when nothing is ready: auto (the Idle loops page decides), off, maintenance, backlog (plan the next feature) or all (also clarify and draft tickets).
GAFFER_NOTIFY|notify||(none)|Where to tell a person: a webhook URL, a Slack incoming-webhook URL and/or "desktop", separated by commas or spaces; empty sends nothing.
GAFFER_DATA|path||$GAFFER_HOME/.gaffer|Where the factory keeps its state (databases, logs, settings.json). Environment only: settings.json lives inside it.
DISPATCH_API_PORT|port||8787|The port the dashboard serves on.
'
_GAFFER_SETTINGS_KEYS=""
while IFS='|' read -r _gk _gkind _gchoices _gdefault _gdesc; do
  [ -n "$_gk" ] || continue
  _GAFFER_SETTINGS_KEYS="$_GAFFER_SETTINGS_KEYS $_gk"
  printf -v "_GAFFER_SK_$_gk" '%s|%s|%s' "$_gkind" "$_gchoices" "$_gdefault"
done <<<"$_GAFFER_SETTINGS_SPEC"
_GAFFER_SETTINGS_KEYS="$_GAFFER_SETTINGS_KEYS "
unset _gk _gkind _gchoices _gdefault _gdesc
# These names existed before the fourteen, with a looser reading in the environment
# that falls to the safe side (GAFFER_MODE=yolo warns and runs supervised; a budget that
# is not a number is no cap, and the spend gate refuses a live run with no cap; a
# concurrency that is not a number runs one ticket). Their environment values keep that
# reading; their settings.json values, and every value of the other settings, are
# validated strictly here. GAFFER_TESTING is not among them: any other word used to turn
# the tester lane OFF (a gate dropped by a typo), so an unknown word stops the config.
_GAFFER_SETTINGS_ENV_AS_BEFORE=" GAFFER_MODE GAFFER_DAILY_BUDGET_USD GAFFER_BUDGET_USD GAFFER_CONCURRENCY GAFFER_DATA DISPATCH_API_PORT "

# _gaffer_setting_problem <NAME> <value> <from: settings.json | the environment>
# Sets _GAFFER_SP to what is wrong with the value (empty when it is accepted).
_gaffer_setting_problem() {
  local name="$1" v="$2" from="$3" spec kind choices item re n_hook=0 n_slack=0 lv
  spec="_GAFFER_SK_$name"; spec="${!spec-}"
  kind="${spec%%|*}"; choices="${spec#*|}"; choices="${choices%%|*}"
  _GAFFER_SP=""
  case "$kind" in
    choice)
      [ -n "$v" ] && case " $choices " in *" $v "*) return 0 ;; esac
      _GAFFER_SP="is not one of: ${choices// /, }" ;;
    usd)
      # The forms the dashboard API has always accepted (5, 5.25, 5. and .5: a stored one
      # must never stop a factory) and the spend gate's awk reads.
      re='^([0-9]+([.][0-9]*)?|[.][0-9]+)$'
      { [ -z "$v" ] || [[ "$v" =~ $re ]]; } && return 0
      _GAFFER_SP="is not a dollar amount (digits with an optional decimal part; empty is no cap)" ;;
    count)
      re='^[1-9][0-9]?$'
      [[ "$v" =~ $re ]] && [ "$v" -le 64 ] && return 0
      _GAFFER_SP="is not a whole number from 1 to 64" ;;
    port)
      re='^[1-9][0-9]{0,4}$'
      [[ "$v" =~ $re ]] && [ "$v" -le 65535 ] && return 0
      _GAFFER_SP="is not a port number (1 to 65535)" ;;
    path)
      case "$v" in /*) return 0 ;; esac
      _GAFFER_SP="is not an absolute path" ;;
    models)
      case " $choices " in *" $v "*) [ -n "$v" ] && return 0 ;; esac
      # Each id starts with a letter or a digit: it is put after --model on the agent's
      # command line, so a leading dash would read as another flag.
      re='^[A-Za-z0-9][A-Za-z0-9._:/@-]*,[A-Za-z0-9][A-Za-z0-9._:/@-]*,[A-Za-z0-9][A-Za-z0-9._:/@-]*$'
      [[ "$v" =~ $re ]] && return 0
      _GAFFER_SP="is not a preset (${choices// /, }) or three model ids as strong,standard,cheap (each starting with a letter or digit)" ;;
    gates)
      [ -n "$v" ] && case " $choices " in *" $v "*) return 0 ;; esac
      re='^(tests|lint|typecheck)([ ,]+(tests|lint|typecheck))*$'
      if [[ "$v" =~ $re ]]; then
        [ "$from" != settings.json ] && return 0
        _GAFFER_SP="is a list of gates, which turns the others off; only the environment may do that (settings.json takes standard or strict)"
      else
        _GAFFER_SP="is not standard, strict or a list of tests, lint, typecheck"
      fi ;;
    testing)
      lv="$(printf '%s' "$v" | tr '[:upper:]' '[:lower:]')"
      case "$lv" in auto | on | off | 1 | 0 | true | false | yes | no) return 0 ;; esac
      _GAFFER_SP="is not one of: auto, on, off" ;;
    notify)
      local had_f=0
      case "$-" in *f*) had_f=1 ;; esac
      set -f
      # shellcheck disable=SC2086  # the list's words, globbing off
      set -- ${v//,/ }
      [ "$had_f" = 1 ] || set +f
      for item in "$@"; do
        case "$item" in
          desktop) ;;
          https://hooks.slack.com/* ) n_slack=$((n_slack + 1)) ;;
          http://* | https://*) n_hook=$((n_hook + 1)) ;;
          *) _GAFFER_SP="holds an item that is neither \"desktop\" nor an http(s) URL"; return 0 ;;
        esac
      done
      if [ "$n_hook" -gt 1 ] || [ "$n_slack" -gt 1 ]; then
        _GAFFER_SP="names more than one webhook URL or more than one Slack URL"
      fi ;;
    *) _GAFFER_SP="is not a setting" ;;
  esac
  return 0
}
# _gaffer_setting_refuse <NAME> <value> <from>: the fail-closed stop for a value no
# setting accepts. It never prints a URL (a webhook URL holds its token).
_gaffer_setting_refuse() {
  local shown="'$2'"
  [ "$1" = GAFFER_NOTIFY ] && shown="(value not shown: it may hold a token)"
  printf 'gaffer: %s sets %s=%s, which %s. Fix it (or remove it for the default); refusing to load a config with an unknown setting value (fail closed)\n' \
    "$3" "$1" "$shown" "$_GAFFER_SP" >&2
  exit 1
}

# ── THE OLD settings.json KEYS (the migration) ────────────────────────────────
# Before the fourteen, the dashboard wrote 58 knobs to settings.json. Each of those
# that is no longer a setting is IGNORED, with one warning naming the setting that now
# decides it, except where its value is STRICTER than what the settings derive: then
# the stricter reading wins, so a settings.json written before this change never
# silently widens autonomy or spend. One line per old key:
#   KEY|the setting that decides it now|how to compare the old value with the derived one
# off: 0 is stricter (a ship or spend switch); on: 1 is stricter (a gate; GAFFER_CREATE_PR
# is one, because GAFFER_REQUIRE_CI reads its checks from the pull request, so dropping an
# old 1 would skip the CI gate); a value of either that is not a plain 1/true/yes/on or
# 0/false/no/off (any case, no padding) is not comparable, so it is ignored, never kept;
# less: a lower number is stricter, 0 or empty is no limit; less0: a lower number is
# stricter and 0 is a real 0 (MAX_TICKS=0 runs no tick; GAFFER_MAX_DELIVERY_ATTEMPTS=0
# is one attempt); more: a higher number is stricter; rank a b c: later is stricter
# (a/b are one level, - is empty or unset; a value on no level is not comparable); keep: the old value applies while the
# setting leaves the name empty (a person's alert channel); drop: not comparable, the
# derived value applies.
# `gaffer config show --json` prints what happened to each one (the "migration" list).
_GAFFER_MIGRATION_MAP='
DISPATCH_ALLOW_AGENT_APPROVE|GAFFER_MODE|off
MERGE_ON_AGENT_REVIEW|GAFFER_MODE|off
MEMORY_AUTO_APPROVE|GAFFER_MODE|off
REVIEW_MODE|GAFFER_MODE|rank agent human both
AUTO_MERGE|GAFFER_MODE|off
GAFFER_AUTO_PUSH|GAFFER_MODE|off
GAFFER_ALLOW_SELF_DELIVERY|GAFFER_MODE|off
STRICT_MODE|GAFFER_SANDBOX|on
STRICT_ALLOW_NETWORK|GAFFER_SANDBOX|off
SANDBOX_PROVIDER|GAFFER_SANDBOX|rank none sandbox-exec docker
STRICT_ALLOW_HOME|GAFFER_SANDBOX|drop
GAFFER_IDLE_FEATURE_BACKLOG|GAFFER_IDLE|rank 1/true/yes/on - 0/false/no/off
GAFFER_MAINTENANCE|GAFFER_IDLE|rank 1/true/yes/on - 0/false/no/off
GAFFER_IDLE_MODE|GAFFER_IDLE|rank create_ready_tickets/create_ready/- create_draft_tickets/create_draft observe_only
CLARIFY_DRAFTS_WHEN_IDLE|GAFFER_IDLE|off
IDLE_DRAFT_WHEN_IDLE|GAFFER_IDLE|off
MAX_TICKS|GAFFER_CONCURRENCY|less0
MAX_TICKS_PER_DAY|GAFFER_CONCURRENCY|less
TICK_SLEEP|GAFFER_CONCURRENCY|drop
EMPTY_POLL_LIMIT|GAFFER_CONCURRENCY|drop
MAX_CONCURRENT_TICKETS_PER_REPO|GAFFER_CONCURRENCY|less
MAX_CANDIDATES|GAFFER_CONCURRENCY|drop
MAX_OPEN_AGENT_BRANCHES_PER_REPO|GAFFER_CONCURRENCY|less
MAX_OPEN_AGENT_PRS_PER_REPO|GAFFER_CONCURRENCY|less
GAFFER_TICK_TIMEOUT|GAFFER_EFFORT|less
GAFFER_MAX_TURNS|GAFFER_EFFORT|less
GAFFER_MAX_DELIVERY_ATTEMPTS|GAFFER_EFFORT|less0
DISPATCH_MAX_ATTEMPTS|GAFFER_EFFORT|less
GAFFER_MAX_NOCOMMIT_FAILURES|GAFFER_EFFORT|less
GAFFER_CI_POLL_ATTEMPTS|GAFFER_EFFORT|drop
GAFFER_CI_POLL_INTERVAL_SECS|GAFFER_EFFORT|drop
GAFFER_BUDGET_LOW_THRESHOLD|GAFFER_BUDGET_USD|more
GAFFER_CHEAP_PHASES|GAFFER_BUDGET_USD|keep
GAFFER_REWORK_BUDGET_USD|GAFFER_BUDGET_USD|less
GAFFER_PAUSE_ON_CAP|GAFFER_DAILY_BUDGET_USD|drop
GAFFER_USAGE_PAUSE_DEFAULT_MIN|GAFFER_DAILY_BUDGET_USD|drop
GAFFER_PLAN_DEBATE|GAFFER_MODELS|off
GAFFER_PLAN_DEBATE_MODELS|GAFFER_MODELS|drop
GAFFER_PLAN_DEBATE_MAX_ROUNDS|GAFFER_MODELS|less
GAFFER_PLAN_DEBATE_MIN_ESTIMATE|GAFFER_MODELS|more
GAFFER_NOTIFY_WEBHOOK_URL|GAFFER_NOTIFY|keep
GAFFER_NOTIFY_SLACK_URL|GAFFER_NOTIFY|keep
GAFFER_NOTIFY_DESKTOP|GAFFER_NOTIFY|keep
GAFFER_NOTIFY_EVENTS|GAFFER_NOTIFY|keep
GAFFER_NOTIFY_FULL_PAYLOAD|GAFFER_NOTIFY|off
GAFFER_CREATE_PR|GAFFER_LANDING|on
GAFFER_PR_MERGE_METHOD|GAFFER_LANDING|drop
GAFFER_REQUIRE_CI|GAFFER_LANDING|on
HYGIENE_ENFORCE|GAFFER_GATES|on
GAFFER_DOD_ENV_PASS|GAFFER_GATES|drop
MINIMALISM_REQUIRE_NOTE|GAFFER_GATES|on
OVERSIZED_MAX_FILES|GAFFER_GATES|less0
OVERSIZED_MAX_LINES|GAFFER_GATES|less0
GAFFER_REVIEW_RULE_REPEAT|GAFFER_GATES|drop
'

# ENVIRONMENT-ONLY keys are never taken from the file.
# GAFFER_ALLOW_UNCAPPED lifts the dollar-cap requirement (lib/budget.sh
# gaffer_spend_cap_ok); a hand-edited or otherwise written settings.json must not be
# able to switch that off. Only the operator's real environment can (SECURITY.md).
# The worker provider knobs are environment-only too: a file that picks which program
# runs every agent turn (and which secrets it gets) must not be one an agent's sandbox
# might reach. GAFFER_PRINCIPAL_TOKEN is a person's credential (package H1): the runner
# never acts as a principal, so a file must not hand it one after factory.config.sh took
# it out. The same list is packages/dispatch/src/api/settings.ts ENV_ONLY_KEYS.
_GAFFER_ENV_ONLY_KEYS="
  GAFFER_ALLOW_UNCAPPED GAFFER_WORKER_PROVIDER GAFFER_WORKER_COMMAND GAFFER_WORKER_COMMAND_ENV
  GAFFER_WORKER_COMMAND_COST_USD GAFFER_SANDBOX_WORKER_COMMAND GAFFER_PRINCIPAL_TOKEN
"

# THE LOADER. The dashboard persists a flat {"KEY":"value"} map to
# $GAFFER_DATA/settings.json, read (strictly) at the top of factory.config.sh into
# $_gs_out; an unreadable one applied nothing and set _GAFFER_SETTINGS_UNREADABLE (see
# FAIL CLOSED there). A setting from the file is a default: a real environment variable
# always wins. SECURITY: do NOT eval. eval re-parses the whole string, so both a crafted
# key and a crafted value would be command-injection vectors; the key is FULLY anchored
# to a shell identifier, then tested and assigned with indirect expansion (`${!_sk}`)
# and `printf -v`, neither of which re-parses $_sk or $_sv as a command.
# THE ALLOWLIST (security, F1 of the sandbox audit; now the fourteen). settings.json
# lives in $GAFFER_DATA, and a file there must never pick code or policy the runner
# obeys outside the sandbox (NODE_OPTIONS, BASH_ENV, DYLD_*/LD_*, PATH,
# CLAUDE_BIN/CLAUDE_FLAGS, the idle host-exec switch, the gate sandbox opt-out...). So
# the loader takes from the file ONLY the fourteen settings (each value validated: an
# unknown one stops the config, fail closed). An old dashboard key is kept aside for the
# migration (_gaffer_old_key); every other key is ignored with one stderr line naming
# it. A sandboxed agent or gate cannot write the file at all (lib/sandbox.sh denies it,
# the docker provider never mounts it).
# Fresh on every source (a second source in one shell must leave the same state).
for _gk in $(compgen -v _GAFFER_OLD_ 2>/dev/null); do unset "$_gk"; done
_GAFFER_OLD_KEYS=" "; _GAFFER_OLD_DONE=" "; _GAFFER_MIGRATION_LOG=""; _GAFFER_FROM_FILE=" "
while IFS='|' read -r _gk _gks _gkp; do
  [ -n "$_gk" ] && printf -v "_GAFFER_OM_$_gk" '%s|%s' "$_gks" "$_gkp"
done <<<"$_GAFFER_MIGRATION_MAP"
unset _gk _gks _gkp
if [ -n "$_gs_out" ]; then
  _gs_envonly=" $(printf '%s' "$_GAFFER_ENV_ONLY_KEYS" | tr -s '[:space:]' ' ') "
  while IFS=$'\t' read -r _sk _sv; do
    [[ "$_sk" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue   # whole-key anchor (^…$)
    case "$_gs_envonly" in *" $_sk "*) continue ;; esac
    # Internal names (a leading underscore: the re-source records, the warn-once marks,
    # runner file paths such as _GAFFER_USAGE_PAUSE_MJS that node runs) and the test
    # seams whose value is a command to run or a module to load are never settings: a
    # file an agent's sandbox might reach must not pick code the runner executes.
    case "$_sk" in
      _*)
        printf 'gaffer: ignoring %s from settings.json: an internal name, never a setting\n' "$_sk" >&2
        continue ;;
      GAFFER_WG_LIST_CMD | GAFFER_WG_SHOW_CMD | GAFFER_WG_DELIVERIES_CMD | GAFFER_REDACTION_MODULE | \
        DISPATCH_TESTER_VERDICT_CMD | DISPATCH_LANE_VERDICT_CMD | DISPATCH_ACCEPTANCE_EVIDENCE_CMD)
        printf 'gaffer: ignoring %s from settings.json: a command or module test seam; only the environment can set it\n' "$_sk" >&2
        continue ;;
    esac
    # A settings.json GAFFER_STRICT_REQUIRE=0 is NOT the operator's out-of-band
    # assertion (the opt-out from the OS sandbox every agent launch requires): only the
    # real environment can make it, under every worker provider. Skipped (said in its
    # own words), so the requirement stays on.
    if [ "$_sk" = GAFFER_STRICT_REQUIRE ]; then
      case "$(printf '%s' "$_sv" | tr '[:upper:]' '[:lower:]')" in
        0 | false | no | off)
          printf 'gaffer: ignoring GAFFER_STRICT_REQUIRE=%s from settings.json: only the environment can opt out of the OS sandbox\n' "$_sv" >&2
          continue ;;
      esac
    fi
    case "$_GAFFER_SETTINGS_KEYS" in
      *" $_sk "*)
        # One of the fourteen: validated (fail closed), then a default under the env.
        if [ "$_sk" = GAFFER_DATA ]; then
          printf 'gaffer: ignoring GAFFER_DATA from settings.json: the file lives inside it, so only the environment can move it\n' >&2
          continue
        fi
        # An EMPTY value is "cleared back to the default": the dashboard stores "" when a
        # person clears a setting (packages/dispatch/src/api/settings.ts writeSettings),
        # and the loader before the fourteen took it as unset. It is not validated (no
        # setting value is empty), so a cleared setting never stops the config.
        if [ -n "$_sv" ]; then
          _gaffer_setting_problem "$_sk" "$_sv" settings.json
          [ -z "$_GAFFER_SP" ] || _gaffer_setting_refuse "$_sk" "$_sv" settings.json
        fi
        # assign-if-unset, no eval, and EXPORT: a setting must reach the processes that
        # read it (the dispatch CLI, the memory server, crew), not only this shell.
        if [ -z "${!_sk:-}" ]; then
          printf -v "$_sk" '%s' "$_sv"; export "${_sk?}"
          [ -z "$_sv" ] || _GAFFER_FROM_FILE="$_GAFFER_FROM_FILE$_sk "
        fi
        continue ;;
    esac
    _gk="_GAFFER_OM_$_sk"
    if [ -n "${!_gk:-}" ]; then
      # An old dashboard key: kept aside, compared with what the settings derive where
      # that name gets its value (_gaffer_old_key), and said once.
      printf -v "_GAFFER_OLD_$_sk" '%s' "$_sv"
      _GAFFER_OLD_KEYS="$_GAFFER_OLD_KEYS$_sk "
      continue
    fi
    # Not a setting: ignored, named once on stderr. Values stay data: nothing here is
    # evaluated or sourced.
    printf 'gaffer: ignoring %s from settings.json: not a dashboard setting; only the environment can set it\n' "$_sk" >&2
  done <<<"$_gs_out"
  unset _sk _sv _gs_envonly _gk
fi
unset _gs_out
# The newer settings are validated wherever they come from (the environment included);
# the older names keep their environment reading (see _GAFFER_SETTINGS_ENV_AS_BEFORE).
for _gk in $_GAFFER_SETTINGS_KEYS; do
  [ -n "${!_gk:-}" ] || continue
  case "$_GAFFER_FROM_FILE" in *" $_gk "*) continue ;; esac
  case "$_GAFFER_SETTINGS_ENV_AS_BEFORE" in *" $_gk "*) continue ;; esac
  _gaffer_setting_problem "$_gk" "${!_gk}" "the environment"
  [ -z "$_GAFFER_SP" ] || _gaffer_setting_refuse "$_gk" "${!_gk}" "the environment"
done
unset _gk

# _gaffer_preset <SETTING>: which column of its table applies now. Sets _GAFFER_PRESET
# (the value, or the default), _GAFFER_PRESET_COL (1-based column; 0 for a setting whose
# table has one column), _GAFFER_PRESET_NCOLS and _GAFFER_PRESET_DEFAULT (1 when the
# setting is at its default, so every derived value is today's built-in one).
_gaffer_preset() {
  local spec kind choices dflt v c i=0
  spec="_GAFFER_SK_$1"; spec="${!spec-}"
  kind="${spec%%|*}"; choices="${spec#*|}"; dflt="${choices#*|}"; choices="${choices%%|*}"
  v="${!1:-}"
  _GAFFER_PRESET_COL=0; _GAFFER_PRESET_NCOLS=1; _GAFFER_PRESET_DEFAULT=1
  case "$kind" in
    choice | gates | models)
      # A gates list runs the standard column (the list then turns the gates it leaves
      # out off, in 07-limits.sh); three model ids run the models' own lines in 04.
      # A value the environment set the old way (GAFFER_MODE=yolo) reads as the default
      # (15-modes.sh says so).
      [ -n "$v" ] && case " $choices " in *" $v "*) ;; *) v="$dflt" ;; esac
      [ -n "$v" ] || v="$dflt"
      [ "$v" = "$dflt" ] || _GAFFER_PRESET_DEFAULT=0
      for c in $choices; do
        i=$((i + 1))
        [ "$c" = "$v" ] && _GAFFER_PRESET_COL=$i
      done
      _GAFFER_PRESET_NCOLS=$i ;;
    *)
      [ -z "$v" ] || _GAFFER_PRESET_DEFAULT=0 ;;
  esac
  _GAFFER_PRESET="${v:-$dflt}"
}

# _gaffer_derive <SETTING> [--no-export] <<'_GAFFER_TABLE_' ... _GAFFER_TABLE_
# Apply one setting's derivation table. A row is `NAME value...   # note`: one value
# for every preset, or one per accepted value of the setting in its spec order. A value
# is a literal, "" (empty), - (left unset), @NAME (NAME's value), @?NAME (NAME's value,
# left unset when that is empty) or ~ (not assigned here: a constant `: "${NAME:=v}"`
# line in its part, a value computed in code, or one read with its default where it is
# used; the row says which setting it belongs to). A row assigns only what nobody set
# before it (a real environment variable wins), with `:=` semantics; a `?NAME` row only
# when NAME is unset (an explicit empty value stays empty). A value a non-default preset
# derived is exported (as a settings.json value always was), unless --no-export. A row
# whose name holds an old settings.json key is compared with it here (_gaffer_old_key).
# A malformed row stops the config (fail closed).
_gaffer_derive() {
  local setting="$1" noexport="${2:-}" line name cell v assign unset_only col ncols isdef had_f=0
  local IFS=$' \t\n'
  _gaffer_preset "$setting"
  col="$_GAFFER_PRESET_COL"; ncols="$_GAFFER_PRESET_NCOLS"; isdef="$_GAFFER_PRESET_DEFAULT"
  case "$-" in *f*) had_f=1 ;; esac
  set -f
  while IFS= read -r line; do
    line="${line%%#*}"
    # shellcheck disable=SC2086  # the row's words
    set -- $line
    [ "$#" -gt 0 ] || continue
    name="$1"; shift
    unset_only=0; case "$name" in '?'*) unset_only=1; name="${name#?}" ;; esac
    if ! [[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || [ "$#" -eq 0 ]; then
      printf 'gaffer: the %s table has a malformed row (%s); refusing to go on (fail closed)\n' "$setting" "$line" >&2
      exit 1
    fi
    if [ "$#" -eq 1 ]; then cell="$1"
    elif [ "$#" -eq "$ncols" ] && [ "$col" -gt 0 ]; then cell="${!col}"
    else
      printf 'gaffer: the %s table row %s has %s values, not 1 or %s; refusing to go on (fail closed)\n' "$setting" "$name" "$#" "$ncols" >&2
      exit 1
    fi
    assign=1; v=""
    case "$cell" in
      '~') continue ;;
      '-') assign=0 ;;
      '""') v="" ;;
      '@?'*) v="${cell#@?}"; v="${!v-}"; [ -n "$v" ] || assign=0 ;;
      '@'*) v="${cell#@}"; v="${!v-}" ;;
      *) v="$cell" ;;
    esac
    if [ "$assign" = 1 ]; then
      if [ "$unset_only" = 1 ]; then
        [ -n "${!name+x}" ] && assign=0
      else
        [ -n "${!name:-}" ] && assign=0
      fi
    fi
    if [ "$assign" = 1 ]; then
      printf -v "$name" '%s' "$v"
      [ "$isdef" = 1 ] || [ "$noexport" = --no-export ] || export "${name?}"
    fi
    _gaffer_old_key "$name"
  done
  [ "$had_f" = 1 ] || set +f
  return 0
}

# _gaffer_truthy <value>: 1/true/yes/on, in any case.
_gaffer_truthy() {
  case "$1" in 1 | [Tt][Rr][Uu][Ee] | [Yy][Ee][Ss] | [Oo][Nn]) return 0 ;; esac
  return 1
}
# _gaffer_bool01 <value>: sets _GAFFER_B to 1 (1/true/yes/on), 0 (empty, 0/false/no/off),
# any case, or "" for anything else (padded, a typo, garbage): a value no switch reads the
# same way everywhere (bash readers do not trim, Node readers do) is never compared.
_gaffer_bool01() {
  _GAFFER_B=""
  case "$1" in
    1 | [Tt][Rr][Uu][Ee] | [Yy][Ee][Ss] | [Oo][Nn]) _GAFFER_B=1 ;;
    '' | 0 | [Ff][Aa][Ll][Ss][Ee] | [Nn][Oo] | [Oo][Ff][Ff]) _GAFFER_B=0 ;;
  esac
}
# THE OLD NUMBERS (external review 21). The old dashboard API (bf5e305 api/settings.ts)
# checked an `int` key's TRIMMED value against digits and stored the raw string (" 3",
# "3 " and "03" are in real files), and a `number` key (the dollar keys below) against
# `^(\d+(\.\d*)?|\.\d+)$` (".5" and "5." too). The old runner read both with awk and
# `[ -ge ]`, which skip the padding and the leading zeros. The migration reads each such
# string to that same number (_gaffer_old_number) before it compares; a value no old
# reading accepts is unreadable, and an unreadable cap never becomes "no limit" nor the
# setting's limit (_gaffer_old_unreadable: the config refuses to start, naming the key).
_GAFFER_OLD_USD_KEYS=" GAFFER_REWORK_BUDGET_USD GAFFER_BUDGET_LOW_THRESHOLD "
_GAFFER_OLD_SPEND_CAPS=" GAFFER_REWORK_BUDGET_USD "
# _gaffer_trim <value>: _GAFFER_TRIM = the value without leading or trailing ASCII white
# space (the settings.json reader turned tabs, newlines and CRs into spaces already; a
# vertical tab or form feed is left, and awk, `[ -ge ]` and parseInt all skip it, so it
# is trimmed here too: review of external review 21).
_gaffer_trim() {
  local v="$1" ws=$' \v\f'
  v="${v#"${v%%[!$ws]*}"}"
  _GAFFER_TRIM="${v%"${v##*[!$ws]}"}"
}
# _gaffer_trim_js <value>: _GAFFER_TRIM = the value without the white space JavaScript's
# trim() removes (what the old dashboard API trimmed before it checked a boolean): ASCII
# white space and the Unicode spaces, as UTF-8 bytes. Bash 3.2 safe (no ${x,,}, no
# arrays of patterns).
_gaffer_trim_js() {
  local v="$1" p changed=1
  while [ "$changed" = 1 ]; do
    changed=0
    _gaffer_trim "$v"; [ "$_GAFFER_TRIM" = "$v" ] || changed=1; v="$_GAFFER_TRIM"
    for p in $'\xc2\xa0' $'\xe1\x9a\x80' $'\xe2\x80\x80' $'\xe2\x80\x81' $'\xe2\x80\x82' \
      $'\xe2\x80\x83' $'\xe2\x80\x84' $'\xe2\x80\x85' $'\xe2\x80\x86' $'\xe2\x80\x87' \
      $'\xe2\x80\x88' $'\xe2\x80\x89' $'\xe2\x80\x8a' $'\xe2\x80\xa8' $'\xe2\x80\xa9' \
      $'\xe2\x80\xaf' $'\xe2\x81\x9f' $'\xe3\x80\x80' $'\xef\xbb\xbf'; do
      case "$v" in "$p"*) v="${v#"$p"}"; changed=1 ;; esac
      case "$v" in *"$p") v="${v%"$p"}"; changed=1 ;; esac
    done
  done
  _GAFFER_TRIM="$v"
}
# The ship switches whose old readers took exactly "1" (memory's auto-approve, the idle
# drafters, the sandbox network switch, the self-delivery ban): any other spelling was off
# there, so the migration reads it as off. The rest of the off switches were read by the
# runner's _gaffer_flag_on (a 1/true/yes/on word, any case, no padding).
_GAFFER_OLD_EXACT_ONE=" MEMORY_AUTO_APPROVE CLARIFY_DRAFTS_WHEN_IDLE IDLE_DRAFT_WHEN_IDLE STRICT_ALLOW_NETWORK GAFFER_ALLOW_SELF_DELIVERY GAFFER_NOTIFY_FULL_PAYLOAD "
# _gaffer_old_number <NAME> <stored>: _GAFFER_ON = the number the old runner read from a
# stored old value, written plainly (".5" -> 0.5, "5." -> 5, " 03" -> 3); returns 1 (and
# _GAFFER_ON empty) when no old reading accepts it (a sign, an exponent, a unit, a
# decimal for a whole-number key, a non-ASCII digit or space).
_gaffer_old_number() {
  local name="$1" v re
  _GAFFER_ON=""
  _gaffer_trim "$2"; v="$_GAFFER_TRIM"
  case "$_GAFFER_OLD_USD_KEYS" in
    *" $name "*) re='^([0-9]+([.][0-9]*)?|[.][0-9]+)$' ;;
    *) re='^[0-9]+$' ;;
  esac
  [[ "$v" =~ $re ]] || return 1
  case "$v" in .*) v="0$v" ;; esac
  v="${v%.}"
  while [ "${#v}" -gt 1 ] && [ "${v:0:1}" = 0 ] && [ "${v:1:1}" != . ]; do v="${v:1}"; done
  _GAFFER_ON="$v"
  return 0
}
# _gaffer_stricter <policy words...> -- <old> <derived>: which reading is stricter.
# Sets _GAFFER_ST to old (the old value is stricter), new (the derived one is: the old
# was more permissive or costlier), same, or other (not comparable / not a number), and
# _GAFFER_ST_VALUE to the value to apply when it is old (a switch is applied as 0 or 1).
_gaffer_stricter() {
  local -a pol=()
  while [ "$#" -gt 0 ] && [ "$1" != -- ]; do pol+=("$1"); shift; done
  shift
  local o="$1" d="$2" lvl i=0 ro=-1 rd=-1 a re='^[0-9]+([.][0-9]+)?$'
  _GAFFER_ST=other; _GAFFER_ST_VALUE="$o"
  case "${pol[0]}" in off | on) ;; *) [ "$o" = "$d" ] && { _GAFFER_ST=same; return 0; } ;; esac
  case "${pol[0]}" in
    off | on)
      local to td
      # An empty old value is a setting the dashboard cleared back to its default, not
      # a 0: before the fourteen the default filled it (`:=`), so it is not compared.
      [ -n "$o" ] || return 0
      _gaffer_bool01 "$o"; to="$_GAFFER_B"
      _gaffer_bool01 "$d"; td="$_GAFFER_B"
      [ -n "$to" ] && [ -n "$td" ] || return 0
      _GAFFER_ST_VALUE="$to"
      if [ "$to" = "$td" ]; then _GAFFER_ST=same
      elif { [ "${pol[0]}" = off ] && [ "$to" = 0 ]; } || { [ "${pol[0]}" = on ] && [ "$to" = 1 ]; }; then _GAFFER_ST=old
      else _GAFFER_ST=new; fi ;;
    less | less0 | more)
      [[ "$o" =~ $re ]] || return 0
      [ -z "$d" ] || [[ "$d" =~ $re ]] || return 0
      if [ "${pol[0]}" = more ]; then
        a="$(awk -v o="$o" -v d="${d:-0}" 'BEGIN { print (o + 0 > d + 0) ? "old" : (o + 0 < d + 0) ? "new" : "same" }')"
      else
        # less: 0 or empty is no limit, the most permissive reading.
        a="$(awk -v o="$o" -v d="$d" -v z="${pol[0]}" 'BEGIN {
          inf = 1e300; oo = o + 0; dd = d + 0
          if (d == "") dd = inf
          if (z == "less" && oo == 0) oo = inf
          if (z == "less" && d != "" && dd == 0) dd = inf
          print (oo < dd) ? "old" : (oo > dd) ? "new" : "same" }')"
      fi
      _GAFFER_ST="${a:-other}" ;;
    rank)
      i=0
      for lvl in "${pol[@]:1}"; do
        case "/$lvl/" in *"/${o:--}/"*) ro=$i ;; esac
        case "/$lvl/" in *"/${d:--}/"*) rd=$i ;; esac
        i=$((i + 1))
      done
      # An empty derived value on no level reads as the first (most permissive) one.
      [ "$rd" -ge 0 ] || { [ -z "$d" ] && rd=0; }
      [ "$ro" -ge 0 ] && [ "$rd" -ge 0 ] || return 0
      if [ "$ro" -gt "$rd" ]; then _GAFFER_ST=old
      elif [ "$ro" -lt "$rd" ]; then _GAFFER_ST=new
      else _GAFFER_ST=same; fi ;;
    keep)
      if [ -z "$d" ] && [ -n "$o" ]; then _GAFFER_ST=old; fi ;;
  esac
  return 0
}
# _gaffer_old_key <NAME>: an old settings.json key for NAME (a knob that is no longer a
# setting) meets the value NAME has now. Called by a table row as it assigns, and for
# every remaining old key at the end of the config (20-gates.sh). The stricter reading
# wins: the old value is applied (and exported, as settings.json values were) only when
# it is stricter than the derived one; otherwise the old key is ignored. Either way one
# warning, once per process tree, names the setting that decides it now, and
# _GAFFER_MIGRATION_LOG gets one line (KEY, old value, setting, derived value, what was
# done) for `gaffer config show --json`. A real environment variable for NAME wins over
# both. URLs are never printed (a webhook URL holds its token).
_gaffer_old_key() {
  local name="$1" om setting policy old cur dec msg shown_old shown_cur cmp
  case "$_GAFFER_OLD_KEYS" in *" $name "*) ;; *) return 0 ;; esac
  case "$_GAFFER_OLD_DONE" in *" $name "*) return 0 ;; esac
  _GAFFER_OLD_DONE="$_GAFFER_OLD_DONE$name "
  om="_GAFFER_OM_$name"; om="${!om}"; setting="${om%%|*}"; policy="${om#*|}"
  old="_GAFFER_OLD_$name"; old="${!old}"
  cur="${!name-}"
  case "$_GAFFER_ENV_AT_SOURCE" in
    *" $name "*) dec=environment ;;
    *)
      # The old value as the old runner read it: a number in its stored spellings
      # (_gaffer_old_number), a switch or a level without its padding (the old API
      # trimmed a boolean before checking it and stored it as typed; the readers it
      # reached read " 0" as off). An alert channel (keep) is applied as stored.
      cmp="$old"
      case "$policy" in
        less | less0 | more)
          if [ -n "$old" ] && ! _gaffer_old_number "$name" "$old"; then cmp=$'\x01'; else cmp="$_GAFFER_ON"; fi ;;
        # A SHIP SWITCH (off: 0 is stricter) is read as the strictest of its old readers
        # (review of external review 21): the runner's flag check took a word with no
        # padding, some readers took exactly "1", and the dashboard trimmed; so " 1" was
        # off in the runner and on in the dashboard, and is off here. A GATE (on: 1 is
        # stricter) is read the way its most generous reader did (JavaScript's trim), so
        # a padded 1 a reader honoured is never dropped.
        off)
          if [ -z "$old" ]; then cmp=""
          else
            case "$_GAFFER_OLD_EXACT_ONE" in
              *" $name "*) if [ "$old" = 1 ]; then cmp=1; else cmp=0; fi ;;
              *) _gaffer_bool01 "$old"; if [ "$_GAFFER_B" = 1 ]; then cmp=1; else cmp=0; fi ;;
            esac
          fi ;;
        on) _gaffer_trim_js "$old"; cmp="$_GAFFER_TRIM" ;;
        rank*) _gaffer_trim "$old"; cmp="$_GAFFER_TRIM" ;;
      esac
      if [ "$cmp" = $'\x01' ]; then
        _gaffer_old_unreadable "$name" "$old" "$setting" "$policy" "$cur"
        dec=unreadable
      else
        # shellcheck disable=SC2086  # the policy's words
        _gaffer_stricter $policy -- "$cmp" "$cur"
        case "$_GAFFER_ST" in
          old) dec=kept; printf -v "$name" '%s' "$_GAFFER_ST_VALUE"; export "${name?}" ;;
          new) dec=stricter-derived ;;
          same) dec=same ;;
          *) dec=ignored ;;
        esac
      fi ;;
  esac
  _GAFFER_MIGRATION_LOG="$_GAFFER_MIGRATION_LOG$name	$old	$setting	$cur	$dec
"
  case "${_GAFFER_DEPRECATED_SAID:-}" in *" settings.json:$name "*) return 0 ;; esac
  shown_old="'$old'"; shown_cur="'$cur'"
  case "$name" in *_URL) shown_old="(a URL)"; shown_cur="(the derived URL)" ;; esac
  [ -n "$cur" ] || shown_cur="unset"
  case "$dec" in
    environment) msg="ignored: the environment sets $name, and $setting decides it otherwise" ;;
    kept)
      if [ "$policy" = keep ]; then
        msg="$setting leaves it unset, so the file's $shown_old still applies (an alert channel is never dropped in silence); put it in $setting and remove the key"
      else
        msg="the file's $shown_old is stricter than what $setting derives ($shown_cur), so it still applies; choose a $setting value (or export $name) and remove the key"
      fi ;;
    stricter-derived) msg="ignored: $setting decides it, and the file's $shown_old was more permissive or costlier than what it derives ($shown_cur), so the stricter value applies" ;;
    unreadable) msg="the file's $shown_old could not be read as a number (the old dashboard stored digits, or dollars such as 5 or 0.50), so the limit $setting derives ($shown_cur) applies; fix the key or remove it" ;;
    same) msg="ignored: $setting decides it and derives the same value ($shown_cur); remove the key" ;;
    *) msg="ignored: $setting decides it (now $shown_cur, the file said $shown_old); choose a $setting value, or export $name to override" ;;
  esac
  printf 'gaffer: settings.json key %s is no longer a setting; %s\n' "$name" "$msg" >&2
  _GAFFER_DEPRECATED_SAID="${_GAFFER_DEPRECATED_SAID:- } settings.json:$name "
  export _GAFFER_DEPRECATED_SAID
}

# _gaffer_old_unreadable <NAME> <stored> <setting> <policy> <derived>: an old numeric
# value no old reading accepts. It is never read as "no limit", and never replaced by the
# setting's limit either (review of external review 21): the old runner's readers did
# not agree on such a string (`[ -lt ]` stops on it, so MAX_TICKS ran no tick at all;
# awk reads a leading NBSP as 0; parseInt skips it), so the setting's limit could be
# looser than what the old runner enforced. The config refuses to start and names the
# key and what to write; only a value the old dashboard could not normally store (a
# hand edit, a non-ASCII space pasted in) reaches this.
_gaffer_old_unreadable() {
  local name="$1" stored="$2" setting="$3" why
  case "$_GAFFER_OLD_SPEND_CAPS" in
    *" $name "*) why="it capped spending, and a dollar cap is never guessed" ;;
    *) why="it was a limit, and what the old runner enforced from it cannot be known" ;;
  esac
  local shown="'$stored'"
  # A character a person cannot see (a non-ASCII space pasted in) is shown escaped.
  case "$stored" in *[!\ -~]*) shown="$shown (as bytes: $(printf '%q' "$stored"))" ;; esac
  printf "gaffer: settings.json key %s holds %s, which is not a number the old dashboard stored (digits, or dollars such as 5 or 0.50); %s. Write the plain number you meant (for example \"%s\": \"3\"), or remove the key (the limit then comes from %s); refusing to load the config (fail closed)\n" \
    "$name" "$shown" "$why" "$name" "$setting" >&2
  exit 1
}

# _gaffer_deprecated <old-name> <what to set instead>: a deprecated variable that is
# set says so on stderr once per process tree (the parent's mark is exported, so a
# child that sources this file again stays quiet). Deprecated names keep working for
# one release; docs/CONFIG.md lists them with their replacement.
_gaffer_deprecated() {
  [ -n "${!1:-}" ] || return 0
  case "${_GAFFER_DEPRECATED_SAID:-}" in *" $1 "*) return 0 ;; esac
  printf 'gaffer: %s is deprecated and goes in the next release; %s\n' "$1" "$2" >&2
  _GAFFER_DEPRECATED_SAID="${_GAFFER_DEPRECATED_SAID:- } $1 "
  export _GAFFER_DEPRECATED_SAID
}

# _gaffer_removed <old-name> <what happens now>: a removed variable that is set says so
# on stderr once per process tree (the same mark as _gaffer_deprecated): its value is
# ignored and the built-in behaviour is fixed. docs/CONFIG.md lists them under Removed.
_gaffer_removed() {
  [ -n "${!1:-}" ] || return 0
  case "${_GAFFER_DEPRECATED_SAID:-}" in *" $1 "*) return 0 ;; esac
  printf 'gaffer: %s was removed and its value is ignored; %s\n' "$1" "$2" >&2
  _GAFFER_DEPRECATED_SAID="${_GAFFER_DEPRECATED_SAID:- } $1 "
  export _GAFFER_DEPRECATED_SAID
}
# The knobs the config diet removed (nothing set them; each held its built-in value,
# which is now fixed in the code). Said once if one is still set.
while IFS='|' read -r _gr_name _gr_now; do
  [ -n "$_gr_name" ] && _gaffer_removed "$_gr_name" "$_gr_now"
done <<'_GAFFER_REMOVED_'
GAFFER_REWORK_HISTORY_BYTES|a rework prompt carries the last 8000 bytes of earlier attempts' feedback
GAFFER_JUDGE_DIFF_BYTES|the eval judge grades the first 120000 bytes of a diff
GAFFER_MERGE_GATE_RETRIES|a landing whose target moved is re-gated up to twice
GAFFER_PREFLIGHT_LIVE_TIMEOUT|the live preflight call gets 60 seconds
GAFFER_ACCEPTANCE_TIMEOUT_MS|one acceptance profile run gets 5 minutes
GAFFER_AGENT_NAME|the factory agent registers as gaffer-factory
GAFFER_AGENT_EMAIL|a greenfield repo's first commit is by gaffer-factory@users.noreply.invalid
GAFFER_BUDGET_LOW_FRACTION|the low-budget threshold is 20% of the ceiling (export GAFFER_BUDGET_LOW_THRESHOLD to change it)
GAFFER_INHERIT_PLAN_TIMEOUT|the inherit planner gets 60 seconds
GAFFER_INHERIT_AMB_TIMEOUT|the inherit ambiguity call gets 300 seconds
GAFFER_ONBOARD_TIMEOUT|onboarding calls follow GAFFER_TICK_TIMEOUT
GAFFER_REAPPROVAL_ATTEMPTS|a re-approval is tried 3 times
GAFFER_TESTER_REPLAY_TIMEOUT_MS|the tester's replay gets 10 minutes
GAFFER_DECOMPOSE_MOCK|a dry-run planner takes mockOutput from its request
GAFFER_SPEC_AUTHOR_MOCK|a dry-run spec author takes mockOutput from its request
GAFFER_AGENT_ID_FILE|the factory agent's id is kept in $GAFFER_DATA/agent_id
GAFFER_REVIEWER_ID_FILE|the reviewer's id is kept in $GAFFER_DATA/agent_reviewer_id
GAFFER_EVAL_LEDGER|the eval judge writes $GAFFER_DATA/eval-ledger.jsonl, the file the dashboard reads
_GAFFER_REMOVED_
unset _gr_name _gr_now

_GAFFER_CONFIG_PART=01-settings
