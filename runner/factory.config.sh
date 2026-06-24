# Gaffer factory configuration — source-controlled defaults; override any with env.
# shellcheck shell=bash

# This file lives in runner/ of the Gaffer monorepo, so RUNNER_DIR is its own dir
# and GAFFER_HOME is the mono root — which holds runner/ alongside
# packages/{dispatch,crew,memory}. Derive both from the script location
# so the suite works under any checkout root — no hardcoded /Users/<name> path.
# Still env-overridable: a side-by-side (non-mono) checkout can point these elsewhere.
: "${RUNNER_DIR:=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
: "${GAFFER_HOME:=$(cd "$RUNNER_DIR/.." && pwd)}"
: "${GAFFER_DATA:=$GAFFER_HOME/.gaffer}"                       # factory state (dbs, logs, agent id)

# UI-editable settings. The dashboard Settings panel persists a flat {"KEY":"value"}
# map to $GAFFER_DATA/settings.json. Apply them as defaults HERE — before the config
# defaults below — with `:=` so a real env var ALWAYS overrides the file (env wins).
# Keys are validated to env-var-name shape so a tampered file can't inject anything;
# values are bash vars (never eval'd), tabs/newlines stripped.
if [ -f "$GAFFER_DATA/settings.json" ] && command -v node >/dev/null 2>&1; then
  while IFS=$'\t' read -r _sk _sv; do
    # eval KEPT: this is a dynamic-NAME `:=` default assignment (env always wins),
    # not a command seam. The key is shape-validated above; the value is only ever
    # *assigned* to that var, never re-parsed as a command. No argv form expresses
    # "assign-if-unset to a variable whose name is in $_sk".
    case "$_sk" in [A-Z_][A-Z0-9_]*) eval ": \${$_sk:=\$_sv}" ;; esac
  done < <(node -e 'try{const s=require(process.argv[1]);for(const[k,v]of Object.entries(s))process.stdout.write(k+"\t"+String(v).replace(/[\t\n\r]/g," ")+"\n")}catch{}' "$GAFFER_DATA/settings.json")
  unset _sk _sv
fi

# Product locations (mono layout: packages/* under the repo root)
: "${DISPATCH_DIR:=$GAFFER_HOME/packages/dispatch}"
: "${CREW_DIR:=$GAFFER_HOME/packages/crew}"
: "${MEMORY_DIR:=$GAFFER_HOME/packages/memory}"   # memory-mcp, vendored into the mono

# Shared databases (the two MCP servers read these)
: "${DISPATCH_DB:=$GAFFER_DATA/dispatch.sqlite}"
: "${MEMORY_DB:=$GAFFER_DATA/memory.sqlite}"
: "${CREW_CONFIG:=$GAFFER_DATA/crew.yaml}"

# Claude Code wiring
: "${MCP_CONFIG:=$RUNNER_DIR/.mcp.json}"
: "${CLAUDE_SETTINGS:=$RUNNER_DIR/claude/settings.json}"
: "${SKILLS_DIR:=$RUNNER_DIR/skills}"
: "${CLAUDE_BIN:=claude}"                                   # headless `claude -p`
: "${CLAUDE_FLAGS:=--permission-mode acceptEdits}"          # tune to your Claude Code version

# Model tiering: a strong model PLANS, a fast model IMPLEMENTS + TESTS. Set either
# to empty to fall back to the Claude default for that step. The steps split as:
#   PLAN  → decompose (plan-build), clarify, product-owner   (deep reasoning)
#   IMPL  → delivery, greenfield bootstrap, merge-conflict resolve (write code + tests)
# The .mjs steps read GAFFER_PLAN_MODEL / GAFFER_IMPL_MODEL from the env (exported
# below); the bash call sites use the pre-split *_FLAG vars.
# No colon: default only when UNSET, so an explicit empty value disables tiering
# (falls back to the Claude default) rather than being re-defaulted.
: "${GAFFER_PLAN_MODEL=opus}"
: "${GAFFER_IMPL_MODEL=sonnet}"
export GAFFER_PLAN_MODEL GAFFER_IMPL_MODEL
GAFFER_PLAN_MODEL_FLAG=""; [ -n "${GAFFER_PLAN_MODEL:-}" ] && GAFFER_PLAN_MODEL_FLAG="--model $GAFFER_PLAN_MODEL"
GAFFER_IMPL_MODEL_FLAG=""; [ -n "${GAFFER_IMPL_MODEL:-}" ] && GAFFER_IMPL_MODEL_FLAG="--model $GAFFER_IMPL_MODEL"

# Optional two-model PLANNING DEBATE (decompose only). When ON *and* the work is
# big enough (the size gate below), bin/decompose.mjs gaffers the epic via a
# BOUNDED adversarial debate between two DIFFERENT models instead of one call:
#   round 1  → proposer (model A) drafts the plan
#   each later round → critic (model B) is given the plan + an ADVERSARIAL prompt
#                      ("find the real weaknesses — do NOT just agree"); proposer
#                      then revises, folding in valid critiques.
#   stop at GAFFER_PLAN_DEBATE_MAX_ROUNDS or when the critic raises nothing material.
# The final plan flows through the SAME validator/output contract as today, and
# EVERY turn is captured in the usage ledger (kind=decompose) under the existing
# per-call caps (GAFFER_TICK_TIMEOUT / GAFFER_MAX_TURNS).
#
# HONEST/COST: a debate is N× the single-agent planning cost. That is why it is
# OFF by default, SIZE-GATED, and ROUND-CAPPED. With every knob unset, decompose
# behaviour is byte-for-byte identical to the single-agent path.
: "${GAFFER_PLAN_DEBATE:=0}"                 # 1/true/yes/on to enable; default OFF
: "${GAFFER_PLAN_DEBATE_MODELS:=opus,sonnet}" # proposer,critic (empty slot → Claude default)
: "${GAFFER_PLAN_DEBATE_MAX_ROUNDS:=2}"      # total plan-producing rounds (draft = round 1)
# SIZE GATE: only debate when the work is big enough to justify N× the spend.
# Signal (documented in bin/decompose.mjs sizeGate): the spend estimate when the
# usage ledger is reachable + has enough measured `decompose` history (median
# predicted INPUT TOKENS for a decompose call); otherwise a cheap fallback proxy
# = brief length (chars) + requested ticket count × 40. Below the gate → single
# agent even when DEBATE=1. Unset/0 → any positive signal passes (gate disabled).
: "${GAFFER_PLAN_DEBATE_MIN_ESTIMATE:=0}"    # min size signal to trigger a debate (0 = off)
export GAFFER_PLAN_DEBATE GAFFER_PLAN_DEBATE_MODELS GAFFER_PLAN_DEBATE_MAX_ROUNDS GAFFER_PLAN_DEBATE_MIN_ESTIMATE

# --- Per-call resource caps (P1 denial-of-wallet / token runaway) ------------
# Every headless `claude -p` call (delivery, bootstrap, agent-review, clarify) —
# and the whole tick.sh from loop.sh — runs under TWO bounds so a single runaway
# call can't burn unbounded wall-clock OR unbounded tokens:
#   GAFFER_TICK_TIMEOUT — wall-clock seconds before the call is killed (SIGTERM).
#   GAFFER_MAX_TURNS    — agent turn cap, passed to `claude --max-turns`. Bounds the
#                        number of model round-trips (the real token-spend driver).
# macOS ships NO GNU `timeout`, so gaffer_timeout is a portable shim built on perl's
# alarm(): `gaffer_timeout <secs> <cmd> [args…]` runs <cmd> and kills it after <secs>.
# If perl is somehow absent it falls back to GNU `timeout`/`gtimeout` when present,
# else runs the command unbounded (best-effort — never breaks the call).
: "${GAFFER_TICK_TIMEOUT:=1800}"   # 30 min hard wall-clock cap per claude -p call
: "${GAFFER_MAX_TURNS:=60}"        # max agent turns per claude -p call
GAFFER_MAX_TURNS_FLAG=""; [ -n "${GAFFER_MAX_TURNS:-}" ] && GAFFER_MAX_TURNS_FLAG="--max-turns $GAFFER_MAX_TURNS"
export GAFFER_TICK_TIMEOUT GAFFER_MAX_TURNS

# Portable wall-clock timeout. Usage: gaffer_timeout <seconds> <command> [args...]
# Exit 124 on timeout (matching GNU timeout's convention) so callers can detect it.
gaffer_timeout() {
  local secs="$1"; shift
  if [ -z "$secs" ] || [ "$secs" -le 0 ] 2>/dev/null; then "$@"; return $?; fi
  if command -v perl >/dev/null 2>&1; then
    # perl alarm() + fork: the child exec's the command; the parent arms alarm($t)
    # and waits. On SIGALRM the parent kills the child's process group and exits
    # 124 (GNU timeout's convention); otherwise it relays the child's exit status.
    perl -e '
      my $t = shift;
      my $pid = fork();
      die "fork: $!" unless defined $pid;
      if ($pid == 0) { setpgrp(0,0); exec @ARGV or exit 127; }
      $SIG{ALRM} = sub { kill "TERM", -$pid; kill "TERM", $pid; exit 124 };
      alarm $t;
      waitpid($pid, 0);
      exit($? >> 8 ? $? >> 8 : ($? & 127 ? 128 + ($? & 127) : 0));
    ' "$secs" "$@"
    return $?
  fi
  if command -v timeout >/dev/null 2>&1; then timeout "$secs" "$@"; return $?; fi
  if command -v gtimeout >/dev/null 2>&1; then gtimeout "$secs" "$@"; return $?; fi
  "$@"   # no timeout primitive available — run unbounded (best-effort)
}

# --- Agent child-env scrub (C1/M2) -------------------------------------------
# The live `claude -p` launches (delivery, bootstrap, agent-review, clarify) run
# in a subshell that, by default, INHERITS the full parent environment. That env
# carries ambient credentials the runner needs but the AGENT does not —
# GITHUB_TOKEN, AWS_* keys, DISPATCH_API_TOKEN, and anything else matching
# *_TOKEN / *_SECRET / *_KEY / *_PASSWORD. A prompt-injected agent that can read
# its own environment could exfiltrate those. The .mjs runners already scrub
# their child env (agentChildEnv); this is the shell parity for the bash call
# sites, and it is intentionally an ALLOWLIST rather than a denylist: we start
# from nothing (`env -i`) and hand the agent ONLY what `claude -p`, its MCP
# tools, and the per-call boundary vars need. Nothing else can leak by accident,
# including credentials we haven't thought of yet.
#
# Usage:
#   gaffer_agent_env                       # populates the GAFFER_AGENT_ENV array
#   ( cd "$dir" && env -i "${GAFFER_AGENT_ENV[@]}" VAR=val … \
#       gaffer_timeout … "$CLAUDE_BIN" -p … )
#
# What we KEEP (and why):
#   - PATH, HOME, SHELL, USER, LOGNAME, TMPDIR — a working shell so `claude`
#     resolves its binary, reads ~/.claude credentials, and child tools run.
#     (PWD is intentionally NOT carried: the caller cd's first and env -i runs in
#     that cwd; passing the parent's PWD would hand the agent a stale directory.)
#   - LANG / LC_* / TERM / TZ — locale + terminal sanity.
#   - ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL,
#     ANTHROPIC_MODEL, CLAUDE_CODE_* and other CLAUDE_*  — claude -p AUTH and
#     config. NOTE: ANTHROPIC_API_KEY is deliberately the ONE *_KEY we keep; the
#     allowlist below names it explicitly so the generic *_KEY strip can't take it.
#   - AWS_REGION / AWS_DEFAULT_REGION — needed for Bedrock-backed claude; these
#     are NON-secret (the AWS_*_KEY / AWS_SESSION_TOKEN credentials are NOT kept).
#   - MCP_CONFIG, DISPATCH_DB, MEMORY_DB, DISPATCH_MCP_BIN, MEMORY_MCP_BIN — the
#     agent's MCP servers + their DB paths (its only data-plane reach).
#   - GAFFER_* knobs the agent or its hooks read (models, caps, write/read roots,
#     skill/quarantine wiring). The per-call boundary vars are layered on top by
#     the caller AFTER this array, so they always win.
#   - npm_config_* — the scoped/locked bootstrap install knobs.
# Everything NOT named here is dropped — in particular GITHUB_TOKEN, AWS access
# keys/secrets/session tokens, DISPATCH_API_TOKEN, and any *_TOKEN / *_SECRET /
# *_KEY (besides ANTHROPIC_API_KEY) / *_PASSWORD.
GAFFER_AGENT_ENV=()
gaffer_agent_env() {
  GAFFER_AGENT_ENV=()
  # Exact var names the agent legitimately needs. ANTHROPIC_API_KEY is listed
  # explicitly so it survives despite ending in _KEY.
  local keep_exact=(
    PATH HOME SHELL USER LOGNAME TMPDIR TMP TEMP
    LANG LC_ALL LC_CTYPE LC_MESSAGES LC_NUMERIC TERM TZ COLUMNS LINES
    ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL ANTHROPIC_MODEL
    AWS_REGION AWS_DEFAULT_REGION
    MCP_CONFIG DISPATCH_DB MEMORY_DB DISPATCH_MCP_BIN MEMORY_MCP_BIN
    GAFFER_WRITE_ROOTS GAFFER_READ_ROOTS
  )
  # Prefixes whose whole namespace the agent (or its hooks/tools) may read.
  # CLAUDE_*  → claude -p config/auth (CLAUDE_BIN, CLAUDE_CODE_*, CLAUDE_FLAGS…).
  # GAFFER_*  → factory knobs (models, caps, skill/quarantine wiring, boundary).
  # npm_config_* → the scoped, lifecycle-disabled bootstrap install knobs.
  local keep_prefix=( CLAUDE_ GAFFER_ npm_config_ )
  local name val
  # compgen -e enumerates EXPORTED (i.e. environment) variable names, one per
  # line. Names can never contain a newline or '=', so line-reading is safe; the
  # VALUE is read separately via indirect expansion and preserved verbatim.
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    # Drop the credential-shaped vars even if a prefix below would re-admit them.
    case "$name" in
      ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN) : ;;  # explicitly allowed below
      *_TOKEN|*_SECRET|*_KEY|*_PASSWORD|*_PASSWD|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|GITHUB_TOKEN|GH_TOKEN|DISPATCH_API_TOKEN)
        continue ;;
    esac
    local matched=0
    local k
    for k in "${keep_exact[@]}"; do [ "$name" = "$k" ] && { matched=1; break; }; done
    if [ "$matched" -eq 0 ]; then
      local p
      for p in "${keep_prefix[@]}"; do case "$name" in "$p"*) matched=1; break;; esac; done
    fi
    [ "$matched" -eq 1 ] || continue
    # Read the value via indirect expansion; preserve it verbatim.
    val="${!name}"
    GAFFER_AGENT_ENV+=( "$name=$val" )
  done < <(compgen -e)
}

# NOTE on the DISPATCH_*_CMD defaults below: these are plain command STRINGS that
# Dispatch's parseCommand whitespace-splits. The space-safe form is a JSON argv
# array (e.g. ["node","/abs path/x.mjs"]) which parseCommand also accepts — and
# `runner/gaffer dashboard` builds exactly that from $RUNNER_DIR when it exports
# these into the dashboard's env, so the supported launch path is space-safe. The
# string defaults here assume a $RUNNER_DIR with no spaces; if you launch the
# Dispatch API directly from a checkout path containing spaces, set these to JSON
# argv arrays yourself.

# The dashboard's "Suggest work" button (POST /product-owner/runs) spawns this
# command (detached, with DISPATCH_PRODUCT_OWNER_REPO in its env naming the repo to
# suggest work for). It runs the product-owner skill headlessly and files draft
# tickets into the backlog. `gaffer dashboard` exports this into the dashboard's env;
# set it here for a fresh setup. Absolute path so the detached child resolves it.
: "${DISPATCH_PRODUCT_OWNER_CMD:=node $RUNNER_DIR/bin/product-owner-run.mjs}"

# The dashboard Memory view's "Onboard a repo" button (POST /repos/onboard) spawns
# this command (detached, with DISPATCH_ONBOARD_REPO in its env naming the repo —
# a registered name/id OR a local path — to onboard). The wrapper resolves the
# target to an on-disk path and runs crew's real `repo onboard <path>
# --standalone`, so the repo is scanned, registered in Dispatch, and its digest +
# feature inventory land in the memory store the Memory views read. `gaffer
# dashboard` exports this into the dashboard's env; set it here for a fresh setup.
# Absolute path so the detached child resolves it.
: "${DISPATCH_ONBOARD_CMD:=node $RUNNER_DIR/bin/onboard-run.mjs}"

# BBT-001: the independent black-box tester runner. When GAFFER_TESTING is on and a
# ticket is approved+testable, the dispatch state machine routes it in_review ->
# in_testing; this command is the seam that assembles a CONTRACT-ONLY context (AC +
# test_contract — never the diff) and would spawn the tester agent, recording the
# pass/fail verdict back through dispatch. Mirrors DISPATCH_MERGE_CMD /
# DISPATCH_ONBOARD_CMD: a fixed operator command, no shell, absolute path so the
# detached child resolves it. The live `claude -p` tester is the documented
# follow-up; the seam + context assembly + verdict→transition wiring are real today.
: "${DISPATCH_TESTER_CMD:=node $RUNNER_DIR/bin/tester-run.mjs}"

# Factory identity + bookkeeping
: "${GAFFER_AGENT_NAME:=gaffer-factory}"
: "${GAFFER_AGENT_ID_FILE:=$GAFFER_DATA/agent_id}"
: "${GAFFER_LOG:=$GAFFER_DATA/factory.log}"

# --- Self-operation ban (refuse to deliver to Gaffer's own source) ------------
# When Gaffer is open-sourced and someone points the factory at a Gaffer component
# (dispatch / crew / memory / the runner itself), the factory ends up
# editing its OWN source — a footgun and a weird self-modifying recursion. So by
# default the runner REFUSES any delivery (or greenfield bootstrap) whose target
# IS, or is INSIDE, one of the factory's own component dirs (DISPATCH_DIR,
# CREW_DIR, MEMORY_DIR, RUNNER_DIR — all defined above, so this works in
# BOTH the mono layout and the side-by-side layout). First-party dogfooding
# overrides it: set GAFFER_ALLOW_SELF_DELIVERY=1 to restore today's behaviour
# exactly. NOTE: not bulletproof — the check is in-tree and removable — but it
# stops the casual case, which is the accepted bar.
: "${GAFFER_ALLOW_SELF_DELIVERY:=0}"

# gaffer_is_self_target <path>
# Returns success (0) when <path> IS, or is INSIDE, any of the factory's own
# component dirs (DISPATCH_DIR / CREW_DIR / MEMORY_DIR / RUNNER_DIR).
# Both sides are CANONICALISED (symlinks resolved via `cd … && pwd -P`, trailing
# slashes normalised) before an equal-or-subdir match (`case "$canon/" in
# "$comp/"*)`). Empty/missing component vars are skipped. A non-existent or
# non-resolvable <path> can't match (returns 1) — the guard is additive and must
# never misfire on a normal repo.
gaffer_is_self_target() {
  local target="${1:-}"
  [ -n "$target" ] || return 1
  # Canonicalise the target (resolve symlinks, strip trailing slash). If it
  # doesn't resolve to a real dir, fall back to a literal trailing-slash strip so
  # we still compare something sane rather than silently passing.
  local canon
  if canon="$(cd "$target" 2>/dev/null && pwd -P)"; then :; else
    canon="${target%/}"
  fi
  local comp comp_canon
  for comp in "${DISPATCH_DIR:-}" "${CREW_DIR:-}" "${MEMORY_DIR:-}" "${RUNNER_DIR:-}"; do
    [ -n "$comp" ] || continue
    if comp_canon="$(cd "$comp" 2>/dev/null && pwd -P)"; then :; else
      comp_canon="${comp%/}"
    fi
    [ -n "$comp_canon" ] || continue
    case "$canon/" in
      "$comp_canon"/*) return 0 ;;
    esac
  done
  return 1
}

# --- Safety / stop conditions ------------------------------------------------
# DRY_RUN=1 prints what it WOULD do and never invokes Claude or mutates a repo.
# Flip to 0 only when you've reviewed everything and want it live.
: "${DRY_RUN:=1}"
: "${MAX_TICKS:=5}"           # hard cap on ticks per loop run (cost guard)
: "${EMPTY_POLL_LIMIT:=2}"    # stop after this many consecutive no-work polls
: "${TICK_SLEEP:=30}"         # seconds between ticks
# Per-CALENDAR-DAY tick cap across loop.sh runs (overnight cost guard): MAX_TICKS
# bounds one run, but launchd re-runs loop.sh, so this bounds the whole day's
# spend. The count persists in DAILY_COUNTER_FILE and resets each day. 0 = off.
: "${MAX_TICKS_PER_DAY:=50}"
: "${DAILY_COUNTER_FILE:=$GAFFER_DATA/.daily-ticks}"

# --- Honest USAGE LEDGER (per agent invocation) ------------------------------
# Every headless `claude -p` call is switched to `--output-format json` and its
# real usage (tokens verbatim, dollars RELAYED from Claude Code's own
# total_cost_usd / modelUsage[*].costUSD — never computed from a price table) is
# appended as one JSONL record to the usage ledger. Mirrors the safety-block
# ledger: best-effort, gated on GAFFER_DATA, fully swallowed — a ledger failure
# NEVER fails or alters a tick. A call that can't be measured (timeout / crash /
# missing/unparseable JSON / no usage field) is recorded as "unknown", never 0,
# so a partial run can't read as "cheap". run-summary.sh renders the run-scoped
# Usage section. Override the ledger PATH here (mirrors GAFFER_BLOCK_LEDGER's
# run-summary default); empty/unset → $GAFFER_DATA/usage-ledger.jsonl.
: "${GAFFER_USAGE_LEDGER:=$GAFFER_DATA/usage-ledger.jsonl}"
export GAFFER_USAGE_LEDGER

# gaffer_usage_record <kind> <ticket-or-empty> <rc> <captured-json-file>
# Hands the captured `--output-format json` stdout to the usage-ledger CLI, which
# PRINTS the agent's `.result` text to stdout (so the caller keeps a
# human-readable log) and appends one ledger record. Fully swallowed: a missing
# module / node error must never affect the tick (we still emit nothing and
# return 0). Stdout of this function is the agent's text only.
gaffer_usage_record() {
  local kind="$1" ticket="${2:-}" rc="${3:-0}" jsonfile="$4"
  local mod="$RUNNER_DIR/lib/usage-ledger.mjs"
  [ -f "$mod" ] || return 0
  node "$mod" --kind "$kind" ${ticket:+--ticket "$ticket"} --rc "$rc" --json-file "$jsonfile" 2>/dev/null || true
}

# Who reviews in_review tickets before they can be approved to done:
#   human → only a person approves (dispatch review approve, or the board)
#   agent → a reviewer AGENT (≠ the implementer) reviews via the review-ticket skill
#   both  → an agent screens first, then a human confirms
: "${REVIEW_MODE:=human}"

# Auto-merge an approved (done) ticket's branch into the repo's default branch.
# 0 = off (DEFAULT — humans run the merge themselves), 1 = on (opt in per-run).
# Auto-merge ONLY fires after a ticket reaches an APPROVED done-state via a HUMAN
# (or server-side) approval. Agent reviews never trigger a merge — they are advisory
# and the ticket stays in_review — unless MERGE_ON_AGENT_REVIEW=1 (see below; not a
# safe unattended posture).
# Conflict-safe: a clean merge lands on approval; a CONFLICT does NOT force-merge —
# it spawns a resolver agent + re-queues the ticket for re-approval (with the
# resolved diff). Never pushes.
: "${AUTO_MERGE:=0}"

# A MERGE REQUIRES A HUMAN APPROVAL. Even with AUTO_MERGE=1, an AGENT review
# (REVIEW_MODE=agent/both) is ADVISORY ONLY — the reviewer records a verdict via
# the scoped MCP and the ticket STAYS in_review; it does NOT mint an approval and
# does NOT auto-merge. Only a HUMAN approval (the dashboard Approve action →
# merge-ticket, or a human `dispatch review approve`) crosses the final gate.
#
# MERGE_ON_AGENT_REVIEW=1 is NOT A SAFE UNATTENDED POSTURE. It removes the human
# merge gate entirely: an agent-driven 'done' may merge to the default branch with
# NO human in the loop, so a single prompt-injected or mistaken review can land
# code unreviewed. Do NOT set it for any factory you would leave running
# overnight. Keep it 0 (the default) unless you are actively supervising a
# fully-autonomous experiment and accept that risk. The tick logs a WARNING on
# every merge it performs under this flag.
: "${MERGE_ON_AGENT_REVIEW:=0}"

# --- Strict execution mode (OPTIONAL OS-level containment) -------------------
# Best-effort OS-level containment layered ON TOP OF the worktree isolation +
# the deterministic safety hook. NOT a security guarantee — see STRICT_MODE.md.
# Default OFF: behaviour is byte-for-byte as before unless explicitly enabled.
: "${STRICT_MODE:=0}"          # 1 = wrap the live `claude -p` in the OS sandbox provider
# Which provider supplies the OS-level containment. This is a PROVIDER SEAM, not
# a hard dependency on any one tool: `sandbox-exec` is the one a spike proved on
# macOS today; `docker`/`lima`/VM are future providers (currently fall back to
# no extra containment). `none` disables OS wrapping while keeping STRICT_MODE
# semantics togglable. A new provider = a new case in lib/sandbox.sh.
: "${SANDBOX_PROVIDER:=sandbox-exec}"
# Allow outbound network from inside the sandbox. IMPORTANT HONEST NOTE: because
# strict mode wraps the WHOLE `claude -p` process, network CANNOT be denied
# without breaking Claude's own API calls — so this defaults to 1 (allow). True
# per-subprocess network isolation (deny the agent's children network while
# Claude itself reaches the API) is a FUTURE-PROVIDER capability (docker/lima/VM),
# not something `sandbox-exec` wrapping the whole process can deliver.
: "${STRICT_ALLOW_NETWORK:=1}"
# Space-separated HOME paths the sandbox may WRITE to even though they live
# outside the worktree. Claude Code keeps state/cache here; denying them would
# break legitimate runtime writes. Add per-host paths as needed.
: "${STRICT_ALLOW_HOME:=$HOME/.claude $HOME/.cache}"

# --- Stabilisation / hardening (post unattended-run leak findings) -----------
# These guards harden the delivery lifecycle against the real leaks an overnight
# factory run produced (a copied src tree in a repo root, a leaked
# .crew/events.jsonl, self-referential node_modules / .claude/skills
# symlinks committed onto a delivery branch, node_modules deleted during salvage).
# Each is configurable; the defaults below are the ones the run-summary report,
# tick lifecycle, and tests use.

# (1) Worktree HYGIENE assertion (HARD FAIL). After delivery, BEFORE submitting
# for review, the branch diff is asserted hygienic; a violation PARKS the ticket
# (review reject --to refining) and fails the tick — it is never submitted. The
# real main checkout is also asserted clean after worktree teardown. 1 = enforce
# (default), 0 = log-only (skip the hard fail — for debugging, not production).
: "${HYGIENE_ENFORCE:=1}"
# Newline/space-separated glob fragments that, if ADDED or DELETED by the diff,
# fail the hygiene check. Defaults cover every leak class seen in the wild:
#   node_modules        — a copied/symlinked or deleted node_modules path
#   .crew/              — a leaked crew events/state dir
#   *.events.jsonl      — any leaked events log
#   .claude/            — project-local Claude config injected per worktree (never deliver)
#   CLAUDE.factory.md   — the factory's own agent brief (never deliver)
#   .mcp.json / mcp-runtime.json — runtime MCP wiring (never deliver)
# MUST match the library fallback in lib/hygiene.sh — keep the two in sync.
: "${HYGIENE_FORBIDDEN_PATHS:=node_modules .crew/ *.events.jsonl .claude/ CLAUDE.factory.md .mcp.json mcp-runtime.json}"

# (2) MINIMALISM hard post-condition. Every completed delivery MUST record a
# smallest-change note (+ files/lines counts computed from the diff, why-each-file,
# tests-run, evidence). A MISSING smallest-change note FAILS the post-condition
# (park/flag — must not glide through). An oversized diff does NOT fail but flags
# the ticket `needs_human_review: oversized_diff` visibly.
: "${MINIMALISM_ENFORCE:=1}"          # 1 = a missing smallest-change note fails the post-condition
: "${OVERSIZED_MAX_LINES:=400}"       # > this many changed lines → flag (not fail) oversized_diff
: "${OVERSIZED_MAX_FILES:=12}"        # > this many changed files → flag (not fail) oversized_diff

# (4) GREENFIELD bootstrap ("create-a-repo") mode. A dispatch `bootstrap` ticket
# has no repo to branch — the runner CREATES one at <root>/<name>, git-inits it,
# runs the delivery agent there to scaffold the stack + initial commit, then
# registers + onboards it into the factory (so the now-done bootstrap unblocks the
# dependent feature tickets, which then target the new repo via the normal flow).
# A non-empty existing target dir is REFUSED (we never clobber existing work). A
# fresh scaffold may legitimately be larger than a normal change, so the oversized
# minimalism HARD-fail is exempted for bootstrap tickets (the note is still
# recorded; an oversized scaffold is flagged needs_human_review, not failed).
: "${GAFFER_BOOTSTRAP_ROOT:=$HOME/git}"   # parent dir new bootstrap repos are created under
# During a bootstrap delivery the runner additionally exports, FOR THAT TICK ONLY,
# GAFFER_BOOTSTRAP_INSTALL=1 and GAFFER_BOOTSTRAP_DIR=<new repo dir> so the safety
# hook permits exactly the first dependency install INSIDE that fresh dir
# (bootstrap-only relaxation — every other ticket keeps installs hard-blocked).
# These are set per-tick by the runner, never globally; documented here only.

# (3) Per-repo BACKPRESSURE. Before claiming/delivering for a repo, its outstanding
# work is counted (unmerged gaffer/* branches + in_review tickets + active claims).
# At/over ANY cap the repo is in BACKPRESSURE: new claims for it are skipped and
# review/merge/cleanup/blocked work is prioritised, so the loop never piles up more
# than the cap per repo. 0 = that dimension is unlimited.
: "${MAX_OPEN_AGENT_BRANCHES_PER_REPO:=3}"   # unmerged gaffer/* branches in the real repo
: "${MAX_OPEN_AGENT_PRS_PER_REPO:=3}"        # in_review tickets targeting the repo
: "${MAX_CONCURRENT_TICKETS_PER_REPO:=2}"    # active (unexpired) claims targeting the repo

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
fg() { node "$CREW_DIR/dist/cli/index.js" -c "$CREW_CONFIG" "$@"; }
lg() { gaffer_assert_db_vars || return 1; MEMORY_DB="$MEMORY_DB" node "$MEMORY_CLI_BIN" "$@"; }

# Tiny JSON field reader (python3): jget '<expr starting with d>' <<< "$json"
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }

# Strict-execution-mode provider seam (defines sandbox_wrap_cmd). Sourced last so
# it can read the GAFFER_DATA / STRICT_* config above. Best-effort: a missing file
# must not break the suite, but it ships in-tree so this is just defensive.
# shellcheck source=lib/sandbox.sh
[ -f "$RUNNER_DIR/lib/sandbox.sh" ] && source "$RUNNER_DIR/lib/sandbox.sh"

# Per-day cost guard helpers (gaffer_day_count / gaffer_bump_day_count /
# gaffer_day_cap_ok). Sourced after the config above so they read MAX_TICKS_PER_DAY
# and DAILY_COUNTER_FILE.
# shellcheck source=lib/budget.sh
[ -f "$RUNNER_DIR/lib/budget.sh" ] && source "$RUNNER_DIR/lib/budget.sh"

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

# Minimalism post-condition (defines gaffer_diff_stats / gaffer_check_minimalism).
# shellcheck source=lib/minimalism.sh
[ -f "$RUNNER_DIR/lib/minimalism.sh" ] && source "$RUNNER_DIR/lib/minimalism.sh"

# Per-repo backpressure (defines gaffer_repo_pressure / gaffer_repo_in_backpressure).
# shellcheck source=lib/backpressure.sh
[ -f "$RUNNER_DIR/lib/backpressure.sh" ] && source "$RUNNER_DIR/lib/backpressure.sh"

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
