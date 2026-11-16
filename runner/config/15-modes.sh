# shellcheck shell=bash
# runner/config/15-modes.sh: modes and autonomy: the GAFFER_MODE presets, autonomy requires containment
# (the strict-require derivation), the review / merge / push flags.
# Sourced by runner/factory.config.sh only, in its fixed order, never directly or on
# its own: it reads what the parts before it set. Lines moved verbatim from
# factory.config.sh. The last line tells factory.config.sh this part loaded whole.

# ── Autonomy MODE (single cluster selector) ──────────────────────────────────
# GAFFER_MODE sets a whole GROUP of autonomy flags at once, so an operator can
# never HALF-configure autonomy. (The classic footgun: flip AUTO_MERGE=1 but
# leave REVIEW_MODE=human + MERGE_ON_AGENT_REVIEW=0 — approved agent work then
# silently never merges, and the factory looks stalled.) One mode moves the
# whole cluster together:
#   supervised  (DEFAULT, safe)  — a human approves every merge
#   graduated   (earned trust)   — the reviewer agent runs, but the env autonomy floor
#                                  stays at supervised (approve off, merge held): the
#                                  per-repo/risk autonomy POLICY is the sole allow-path,
#                                  so the runner ships only what each repo has EARNED at
#                                  its risk level and holds everything else for a human.
#   autonomous  (walk-away / AFK) — agents approve; approved work auto-merges + pushes;
#                                  the OS sandbox is required (containment block below).
#                                  Never at critical risk (a person always decides those),
#                                  nor for a repo x risk whose autonomy stepped down.
#   strict      (same flags as autonomous; the one difference is that STRICT_MODE
#                                  stays on even with an explicit GAFFER_STRICT_REQUIRE=0)
#
# PRECEDENCE (highest wins):
#   real env var  >  the GAFFER_MODE table below  >  (nothing else)
# GAFFER_MODE is one of the fourteen settings; the flags it moves are derived values,
# no longer settings.json keys (an old key for one is compared with the table in
# 01-settings.sh: a stricter old value wins, a more permissive one is ignored). The
# table only FILLS a flag nobody pinned: a real env var is in this shell before the
# file runs and wins. Net effect: with GAFFER_MODE unset, the 'supervised' column
# equals the historical hard defaults exactly, so existing setups behave identically
# (runner/test/config-defaults.test.sh pins every mode against the values before).
#
# Parity note: the 5 shell flags (REVIEW_MODE/AUTO_MERGE/MERGE_ON_AGENT_REVIEW/
# GAFFER_AUTO_PUSH/STRICT_MODE) are read in-process by tick.sh; the 2 external flags
# (DISPATCH_ALLOW_AGENT_APPROVE/MEMORY_AUTO_APPROVE) are read from the env of the
# dispatch/memory processes. None are exported from here, so the mode sets plain
# (unexported) shell vars, as it always did.
: "${GAFFER_MODE:=supervised}"
# A typo (`yolo`, `autonomus`) in the ENVIRONMENT keeps its old reading: said once per
# process tree (the config is re-sourced by every child script), and the supervised
# column applies. (A settings.json value is validated in 01-settings.sh and stops the
# config instead.)
case "$GAFFER_MODE" in
  supervised | lite | graduated | autonomous | strict) ;;
  *)
    if [ "${_GAFFER_MODE_WARNED:-}" != "$GAFFER_MODE" ]; then
      printf "gaffer: GAFFER_MODE='%s' is not a mode (supervised, graduated, lite, autonomous, strict) — using supervised: a human approves every merge\n" "$GAFFER_MODE" >&2
      export _GAFFER_MODE_WARNED="$GAFFER_MODE"
    fi ;;
esac
# The mode's table. supervised (the default, safe): a human approves every merge.
# lite: auto-approve genuinely TRIVIAL work, hold everything else for a human, and a
# human still MERGES; lite relaxes ONLY the human-review requirement, and only for
# tickets that are low-risk, tiny (within GAFFER_LITE_MAX_DIFF), touch no sensitive
# path, passed EVERY deterministic gate and earned an APPROVE from the reviewer agent.
# The approve FLOOR is on so the server accepts the runner's agent-approve; the RUNNER
# narrows that to trivial tickets (gaffer_ticket_is_trivial), and the floor trips the
# autonomy->containment rule below. graduated (earned trust): the reviewer AGENT runs so
# there is a verdict to act on, but the env floor equals supervised: the per-repo/risk
# autonomy POLICY is the only allow-path (tick.sh -> `wg ticket auto-decision`), inert
# until the operator adds `auto` policy rows, and an earned merge is not pushed.
# autonomous / strict: agents approve; approved work auto-merges and pushes; the OS
# sandbox is required (containment block below).
# These values are plain (unexported) shell variables, exactly as the mode set them
# before: tick.sh reads the shell flags in-process, and the dispatch and memory
# processes get theirs where the runner starts them.
_gaffer_derive GAFFER_MODE --no-export <<'_GAFFER_TABLE_'
#                              supervised  lite   graduated  autonomous  strict
REVIEW_MODE                    human       agent  agent      agent       agent   # who reviews in_review tickets: human, agent (a reviewer agent, never the implementer) or both (an agent screens, a person approves)
DISPATCH_ALLOW_AGENT_APPROVE   0           1      0          1           1       # 1 = dispatch accepts an approval the runner makes on an agent reviewer verdict (the env floor)
MERGE_ON_AGENT_REVIEW          0           0      0          1           1       # 1 (with AUTO_MERGE) = an agent-approved ticket merges with no person in the loop
AUTO_MERGE                     0           0      0          1           1       # 1 = an approved ticket lands on the default branch without a second click
GAFFER_AUTO_PUSH               0           0      0          1           1       # 1 = landed agent work is pushed to origin (a plain git push, from the runner)
MEMORY_AUTO_APPROVE            0           0      0          1           1       # 1 = a lesson an agent proposes goes live without review
GAFFER_MEMORY_AUTO_PROMOTE     ~           # follows MEMORY_AUTO_APPROVE: 1 = a requirement distilled from a delivered ticket goes live at once; 0 = it lands as a draft
GAFFER_SECURITY_REVIEW         ~           # 1 = a delivery that touches a sensitive path gets a second, security-focused review; 0 disables the lane
GAFFER_MERGE_LANE              ~           # 1 = a tick lands a ticket that is ready to merge and allowed to (a person approved it, or it earned it); 0 = a person merges
GAFFER_CONFLICT_RESOLVER       ~           # 1 = a merge conflict is resolved by an agent and re-reviewed; 0 = the ticket waits for a person
GAFFER_LITE_MAX_DIFF           ~           # lite mode trivial-diff bounds as "lines=60 files=4" (the defaults)
GAFFER_ALLOW_SELF_DELIVERY     ~           # 1 = let the factory deliver to its own source (first-party dogfooding); 0 refuses
_GAFFER_TABLE_
# strict = the autonomous cluster with STRICT_MODE pinned on. autonomous gets STRICT_MODE=1
# too (from GAFFER_STRICT_REQUIRE, below), so the two differ only when the operator sets
# GAFFER_STRICT_REQUIRE=0: strict still wraps the agent in the sandbox where one exists.
if [ "$GAFFER_MODE" = "strict" ]; then
  : "${STRICT_MODE:=1}"
fi

# ── Autonomy REQUIRES containment (enforced in code, not docs) ────────────────
# Any flag that lets the agent SHIP or MUTATE without a human — agent-approve,
# merge-on-agent-review, auto-merge, memory-auto-approve, or the autonomous/strict
# clusters that set them — removes the human review gate. In that posture the OS
# sandbox is the ONLY remaining containment boundary for a prompt-injected agent
# (see SECURITY.md). So when autonomy is on we DEFAULT GAFFER_STRICT_REQUIRE=1 — the
# runner then fails closed (tick.sh) if no OS sandbox provider is available — rather
# than letting docs be the gate. An operator who supplies containment out-of-band (a
# VM/container around the whole runner) opts out by setting GAFFER_STRICT_REQUIRE=0
# EXPLICITLY: honoured, but logged loudly. (Graduated mode ships only via earned
# per-repo/risk policy; its containment is enforced at the per-ticket ship gate, not
# here — see the auto-decision path in tick.sh.)
_gaffer_flag_on() {
  case "$(printf '%s' "${1:-0}" | tr '[:upper:]' '[:lower:]')" in
    1 | true | yes | on) return 0 ;;
    *) return 1 ;;
  esac
}
# GRADUATED autonomy ships through STORED policy rows, not env flags: a mode='auto'
# row in dispatch's autonomy_policy table is an unattended ship allow-path the AFK
# gate honours in EVERY mode (isAutonomyAllowed = env floor OR policy). The graduated
# cluster above leaves every env flag off, so nothing here used to turn the
# autonomy→containment defaults on — a factory that had earned `auto` rows shipped
# agent work with no OS sandbox, and neither review.sh nor the dispatch policy
# service ever checked STRICT. Consult the rows (read-only, through the dispatch CLI
# the other gates use) so an earned allow-path counts exactly like a ship flag.
# FAIL-SOFT to "no rows proven" when the DB or the CLI is absent (a fresh checkout
# or a hermetic test has neither): an unqueryable store cannot be the thing that
# turns containment ON, and the env-flag paths above are unaffected. (`wg`/`jget`
# are defined further down this file, so the CLI is invoked directly here.)
_gaffer_autonomy_policy_active() {
  [ -f "${DISPATCH_DB:-}" ] || return 1
  [ -f "$DISPATCH_DIR/dist/cli/index.js" ] || return 1
  local _n
  _n="$(node "$DISPATCH_DIR/dist/cli/index.js" --db "$DISPATCH_DB" autonomy list 2>/dev/null \
        | node "$RUNNER_DIR/lib/json-tool.mjs" expr 'd.auto_count ?? 0' 2>/dev/null)" || _n=0
  [ "${_n:-0}" -gt 0 ] 2>/dev/null
}
_gaffer_autonomy_on() {
  _gaffer_flag_on "${DISPATCH_ALLOW_AGENT_APPROVE:-0}" && return 0
  _gaffer_flag_on "${MERGE_ON_AGENT_REVIEW:-0}" && return 0
  _gaffer_flag_on "${AUTO_MERGE:-0}" && return 0
  _gaffer_flag_on "${MEMORY_AUTO_APPROVE:-0}" && return 0
  # GAFFER_AUTO_PUSH pushes landed agent work to origin with no person in the loop: a
  # ship flag like the four above (exploratory docs audit: it alone left the sandbox off).
  _gaffer_flag_on "${GAFFER_AUTO_PUSH:-0}" && return 0
  case "$GAFFER_MODE" in autonomous | strict) return 0 ;; esac
  _gaffer_autonomy_policy_active && return 0
  return 1
}
# THE COMMAND WORKER REQUIRES CONTAINMENT (enforced in code, like autonomy below).
# GAFFER_WORKER_PROVIDER=command runs an operator-supplied program instead of
# `claude -p`, so the in-process PreToolUse safety hook is not there: the OS sandbox
# is its only containment boundary. Default GAFFER_STRICT_REQUIRE=1 (and STRICT_MODE=1,
# so tick.sh actually asks the provider): the runner then refuses to launch it where
# no OS sandbox is available. The worker seam enforces the same rule on its own (it
# also covers the Node launchers the dashboard starts). An explicit
# GAFFER_STRICT_REQUIRE=0 is the operator asserting out-of-band containment: honoured,
# logged loudly here and again at every spawn.
if [ "${GAFFER_WORKER_PROVIDER:-claude-code}" = command ]; then
  case "$(printf '%s' "${GAFFER_STRICT_REQUIRE-}" | tr '[:upper:]' '[:lower:]')" in
    0 | false | no | off)
      if [ -n "${GAFFER_STRICT_REQUIRE+x}" ]; then
        printf 'WARNING: GAFFER_WORKER_PROVIDER=command with GAFFER_STRICT_REQUIRE=%s — the command worker has no in-process safety hook and the OS sandbox is NOT required, so nothing contains it but what you provide out-of-band (a VM or container). Only safe if you do.\n' "${GAFFER_STRICT_REQUIRE}" >&2
      fi ;;
    1 | true | yes | on) : "${STRICT_MODE:=1}" ;;
    *)
      export GAFFER_STRICT_REQUIRE=1
      : "${STRICT_MODE:=1}"
      printf 'worker: GAFFER_WORKER_PROVIDER=command has no in-process safety hook → defaulting GAFFER_STRICT_REQUIRE=1 (OS sandbox mandatory; the runner refuses to launch the worker without one). Set GAFFER_STRICT_REQUIRE=0 if you contain the runner out-of-band.\n' >&2
      ;;
  esac
fi
if _gaffer_autonomy_on; then
  if [ -z "${GAFFER_STRICT_REQUIRE+x}" ]; then
    export GAFFER_STRICT_REQUIRE=1
    printf 'autonomy: agent ship/mutate flags are on (or an `auto` autonomy policy row is stored) → defaulting GAFFER_STRICT_REQUIRE=1 (OS sandbox mandatory; the runner fails closed without one). Set GAFFER_STRICT_REQUIRE=0 to override if you provide containment out-of-band.\n' >&2
  elif ! _gaffer_flag_on "${GAFFER_STRICT_REQUIRE}"; then
    printf 'WARNING: autonomy flags are ON but GAFFER_STRICT_REQUIRE=%s — the OS sandbox is NOT required, so a prompt-injected agent has no containment boundary beyond the deterministic hook. Only safe if you provide containment out-of-band (VM/container).\n' "${GAFFER_STRICT_REQUIRE}" >&2
  fi
  # Requiring the sandbox is only meaningful if the launch path actually ASKS for one.
  # Historically only GAFFER_MODE=strict defaulted STRICT_MODE=1, so `autonomous` (and
  # any single ship/mutate flag) exported GAFFER_STRICT_REQUIRE=1, printed the
  # fail-closed notice above, and then launched the agent with NO OS sandbox — the
  # wrap is consulted only when STRICT_MODE=1 (tick.sh) — i.e. the requirement was
  # never evaluated. Default STRICT_MODE=1 whenever autonomy is on, so the requirement
  # is enforced at the spawn. An explicit STRICT_MODE=0 in the env is honoured, but
  # worker_deliver still fails closed while GAFFER_STRICT_REQUIRE is on (lib/worker.sh).
  if _gaffer_flag_on "${GAFFER_STRICT_REQUIRE}"; then
    : "${STRICT_MODE:=1}"
  fi
fi

# ── OS isolation is the DEFAULT for every agent launch, in every mode ──────────
# The two blocks above are the stronger rules (the command worker needs docker
# specifically; autonomy warns when the operator opts out). Below them, whatever the
# mode: GAFFER_STRICT_REQUIRE defaults to 1, so every launch (delivery, review,
# clarify, bootstrap, the idle lanes, onboarding, Plan a build, Suggest work, the spec
# author, the merge resolver, the tester, the judge) goes through the OS sandbox or
# refuses (fail closed, lib/sandbox.sh gaffer_isolation_gate and the worker seams).
# Required ⇒ STRICT_MODE defaults to 1 too, so the launch path asks the provider.
# The opt-out is an explicit GAFFER_STRICT_REQUIRE=0 (false/no/off) in the ENVIRONMENT
# (01-settings.sh skips it from settings.json): the operator asserting the whole runner
# is contained out-of-band. It is honoured, agents then run unwrapped unless STRICT_MODE
# or GAFFER_MODE=strict asks for the sandbox, and it is said loudly once per process
# tree by the launch gate (lib/sandbox.sh gaffer_isolation_gate: `gaffer run`, the loop,
# a tick, Poll for work) and by the Node seam, not by every command that sources this
# file. Any other value (empty, a typo) is not an opt-out: required.
if [ -z "${GAFFER_STRICT_REQUIRE:-}" ]; then
  export GAFFER_STRICT_REQUIRE=1
fi
case "$(printf '%s' "$GAFFER_STRICT_REQUIRE" | tr '[:upper:]' '[:lower:]')" in
  0 | false | no | off) ;;   # the opt-out: said by the launch gate, where an agent would start
  *)
    _gaffer_flag_on "$GAFFER_STRICT_REQUIRE" || export GAFFER_STRICT_REQUIRE=1
    : "${STRICT_MODE:=1}" ;;
esac
export GAFFER_STRICT_REQUIRE

# Idle-loop host exec under strict containment. The idle loops run repo commands
# directly on the host, in the real checkout, outside any sandbox: the COVERAGE
# loop's coverage_command (the repo's own test suite, i.e. code agents wrote), the
# DEPENDENCY loop's audit_command (e.g. `pnpm outdated`, which loads the repo's
# .pnpmfile.cjs) and the tsc/semgrep ORACLES. When GAFFER_STRICT_REQUIRE is on
# (autonomy mode turns it on) crew REFUSES all of them and records
# coverage_scan_refused / dependency_audit_refused / oracles_refused (the in-process
# heuristic scans still run); set this to 1 only if you contain the whole runner
# out-of-band (VM/container).
: "${GAFFER_IDLE_HOST_EXEC:=0}"   # 1 = allow idle repo commands (coverage_command, audit_command, tsc/semgrep oracles) on the host under GAFFER_STRICT_REQUIRE
export GAFFER_IDLE_HOST_EXEC

# What the GAFFER_MODE table's flags mean (their values come from the table above):
# Who reviews in_review tickets before they can be approved to done (REVIEW_MODE):
#   human → only a person approves (dispatch review approve, or the board)
#   agent → a reviewer AGENT (≠ the implementer) reviews via the review-ticket skill
#   both  → an agent screens first, then a human confirms: the agent's CHANGES verdict
#           can bounce the delivery to rework (when the approve gate is earned), but its
#           APPROVE is never an approval — the ticket waits in_review for the human,
#           in every autonomy mode (gaffer_afk_ship_plan)

# AUTO_MERGE ("Auto-merge on approval") — land a HUMAN-approved ticket's branch on the
# repo's default branch without a second click.
#   0 = off (DEFAULT): an approval moves the ticket to ready_for_merge and it WAITS there
#       for a human to merge it (the dashboard's "Merge now", or `gaffer merge <n>`). The
#       dashboard Approve does NOT fire the merge runner, and the merge lane holds it.
#   1 = on: the dashboard Approve fires the merge runner (bin/merge-ticket.mjs), and the
#       merge lane (lib/merge-lane.sh) lands any ticket a HUMAN approved by any route
#       (`gaffer approve`, `wg review approve`, a human approval the tester then passed).
# An AGENT approval never lands on AUTO_MERGE alone: that also needs MERGE_ON_AGENT_REVIEW
# (below) or an earned `auto` merge policy row.
# Conflict-safe: a clean merge lands; a CONFLICT does NOT force-merge — it spawns a
# resolver agent, re-gates the resolution (conflict markers + the DoD gates) and re-queues
# the ticket for re-review of the resolved diff. Never pushes — except in PR MODE (the
# ticket carries a pr_url from GAFFER_CREATE_PR), where the merge happens THROUGH the PR
# via `gh pr merge` and the local default branch is fast-forwarded from the remote (see
# the H4 block below).

# MERGE_ON_AGENT_REVIEW ("Auto-merge on agent review") EXTENDS AUTO_MERGE to approvals the
# runner made on an agent reviewer's verdict. The merge gate is AUTO_MERGE=1 AND
# MERGE_ON_AGENT_REVIEW=1 (dispatch envAllowsAuto('merge')) — this flag on its own merges
# nothing (agent-approved work waits at ready_for_merge, and the tick logs a once-per-run
# warning, gaffer_half_merge_config_check). Without it an AGENT review is advisory: the
# ticket stays in_review (or, with an earned approve gate, waits at ready_for_merge) for a
# human.
#
# MERGE_ON_AGENT_REVIEW=1 (with AUTO_MERGE=1) is NOT A SAFE UNATTENDED POSTURE. It removes
# the human merge gate entirely: an agent-approved ticket may merge to the default branch
# with NO human in the loop, so a single prompt-injected or mistaken review can land code
# unreviewed. Do NOT set it for any factory you would leave running overnight without an
# OS sandbox. Keep it 0 (the supervised, lite and graduated value) unless you are actively
# supervising a fully-autonomous experiment and accept that risk.

# GAFFER_AUTO_PUSH=1 — the final step of the AFK cycle. After the runner auto-approves and
# safe-merges an agent-reviewed ticket into the default branch (AUTO_MERGE=1 +
# MERGE_ON_AGENT_REVIEW=1), push that branch to origin. OFF by default; force-free (a plain
# `git push`), and it runs in the RUNNER, not the agent, so it is a deliberate autonomy-mode
# capability rather than an agent action. Leave OFF to keep the factory fully local (merges
# accumulate on the default branch locally; you push when you choose).

_GAFFER_CONFIG_PART=15-modes
