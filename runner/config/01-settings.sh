# shellcheck shell=bash
# runner/config/01-settings.sh: settings precedence: the settings.json values (read by the prologue of
# factory.config.sh) applied as defaults, so a real env var always wins; the
# environment-only keys a settings.json can never set.
# Sourced by runner/factory.config.sh only, in its fixed order, never directly or on
# its own: it reads what the parts before it set. Lines moved verbatim from
# factory.config.sh. The last line tells factory.config.sh this part loaded whole.

# UI-editable settings. The dashboard Settings panel persists a flat {"KEY":"value"}
# map to $GAFFER_DATA/settings.json. Apply them as defaults HERE — before the config
# defaults below — so a real env var ALWAYS overrides the file (env wins).
# SECURITY: do NOT eval. eval re-parses the whole string, so BOTH a crafted key and a
# crafted value are command-injection vectors — the old `case "$_sk" in [A-Z_][A-Z0-9_]*`
# glob pinned only the first two chars ('*' swallows `}; cmd; :`), and a value with a `}`
# closes the `${...}` early and runs the trailing text. Instead: FULLY anchor the key to
# a shell identifier, then test-and-assign with indirect expansion (`${!_sk}`) + `printf
# -v`, neither of which re-parses $_sk or $_sv as a command.
# The file was read (strictly) at the top of this file, into $_gs_out; an unreadable
# one applied nothing and set _GAFFER_SETTINGS_UNREADABLE (see FAIL CLOSED above).
# THE ALLOWLIST (security, F1 of the sandbox audit). settings.json lives in $GAFFER_DATA,
# and a file there must never pick code or policy the runner obeys outside the sandbox
# (NODE_OPTIONS, BASH_ENV, DYLD_*/LD_*, PATH, CLAUDE_BIN/CLAUDE_FLAGS, the idle host-exec
# switch, the gate sandbox opt-out...). So the loader takes from the file ONLY the keys
# the dashboard's settings API can write (packages/dispatch/src/api/settings.ts
# SETTING_DEFS) minus the environment-only keys below; every other key is ignored with
# one stderr line naming it. The two lists are pinned against settings.ts by
# packages/dispatch/test/settings.test.ts (it fails when either side gains a key the
# other lacks): add a dashboard setting there AND here. The budget and autonomy keys
# the dashboard edits stay settable from the file, because writing it is a person's act
# through the API; a sandboxed agent or gate cannot write the file at all
# (lib/sandbox.sh denies it, the docker provider never mounts it).
_GAFFER_SETTINGS_KEYS="
  GAFFER_MODE DISPATCH_ALLOW_AGENT_APPROVE MERGE_ON_AGENT_REVIEW MEMORY_AUTO_APPROVE
  GAFFER_TESTING GAFFER_IDLE_FEATURE_BACKLOG GAFFER_MAINTENANCE GAFFER_IDLE_MODE MAX_TICKS
  MAX_TICKS_PER_DAY GAFFER_DAILY_BUDGET_USD GAFFER_TICK_TIMEOUT GAFFER_MAX_TURNS
  GAFFER_BUDGET_USD GAFFER_BUDGET_LOW_THRESHOLD GAFFER_CHEAP_PHASES GAFFER_PLAN_DEBATE
  GAFFER_PLAN_DEBATE_MODELS GAFFER_PLAN_DEBATE_MAX_ROUNDS GAFFER_PLAN_DEBATE_MIN_ESTIMATE
  GAFFER_NOTIFY_WEBHOOK_URL GAFFER_NOTIFY_SLACK_URL GAFFER_NOTIFY_DESKTOP
  GAFFER_NOTIFY_EVENTS GAFFER_NOTIFY_FULL_PAYLOAD REVIEW_MODE AUTO_MERGE GAFFER_AUTO_PUSH
  GAFFER_CREATE_PR GAFFER_PR_MERGE_METHOD GAFFER_REQUIRE_CI GAFFER_ALLOW_SELF_DELIVERY
  GAFFER_CONCURRENCY TICK_SLEEP EMPTY_POLL_LIMIT MAX_CONCURRENT_TICKETS_PER_REPO
  MAX_CANDIDATES GAFFER_MAX_DELIVERY_ATTEMPTS DISPATCH_MAX_ATTEMPTS
  GAFFER_MAX_NOCOMMIT_FAILURES GAFFER_REWORK_BUDGET_USD GAFFER_PAUSE_ON_CAP
  GAFFER_USAGE_PAUSE_DEFAULT_MIN GAFFER_CI_POLL_ATTEMPTS GAFFER_CI_POLL_INTERVAL_SECS
  MAX_OPEN_AGENT_BRANCHES_PER_REPO MAX_OPEN_AGENT_PRS_PER_REPO CLARIFY_DRAFTS_WHEN_IDLE
  IDLE_DRAFT_WHEN_IDLE HYGIENE_ENFORCE MINIMALISM_REQUIRE_NOTE OVERSIZED_MAX_FILES
  OVERSIZED_MAX_LINES GAFFER_REVIEW_RULE_REPEAT STRICT_MODE STRICT_ALLOW_NETWORK
  SANDBOX_PROVIDER STRICT_ALLOW_HOME
"
# ENVIRONMENT-ONLY keys are never taken from the file, whatever the allowlist says.
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
if [ -n "$_gs_out" ]; then
  _gs_allow=" $(printf '%s' "$_GAFFER_SETTINGS_KEYS" | tr -s '[:space:]' ' ') "
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
    # Not a dashboard setting: ignored, named once on stderr. Values stay data: nothing
    # here is evaluated or sourced.
    case "$_gs_allow" in
      *" $_sk "*) ;;
      *)
        printf 'gaffer: ignoring %s from settings.json: not a dashboard setting; only the environment can set it\n' "$_sk" >&2
        continue ;;
    esac
    # assign-if-unset, no eval — and EXPORT: a dashboard setting must reach the
    # processes that read it (the dispatch CLI's notifier, the memory server, crew),
    # not only this shell. Unexported, notifications/auto-approve set in the UI
    # silently never fired.
    if [ -z "${!_sk:-}" ]; then printf -v "$_sk" '%s' "$_sv"; export "${_sk?}"; fi
  done <<<"$_gs_out"
  unset _sk _sv _gs_allow _gs_envonly
fi
unset _gs_out

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
GAFFER_BUDGET_LOW_FRACTION|the low-budget threshold is 20% of the ceiling (set GAFFER_BUDGET_LOW_THRESHOLD to change it)
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
