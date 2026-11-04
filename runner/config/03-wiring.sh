# shellcheck shell=bash
# runner/config/03-wiring.sh: Claude Code wiring (MCP config, settings, skills, the claude binary and
# flags) and the worker provider knobs (environment only).
# Sourced by runner/factory.config.sh only, in its fixed order, never directly or on
# its own: it reads what the parts before it set. Lines moved verbatim from
# factory.config.sh. The last line tells factory.config.sh this part loaded whole.

# Claude Code wiring
: "${MCP_CONFIG:=$RUNNER_DIR/.mcp.json}"
: "${CLAUDE_SETTINGS:=$RUNNER_DIR/claude/settings.json}"
: "${SKILLS_DIR:=$RUNNER_DIR/skills}"
# Exported so the crew CLI the runner spawns (`fg skills`, `fg idle`, `fg maintain`)
# reads the SAME SKILL.md library the agents are mounted (crew's loadSkillRegistry).
export SKILLS_DIR
: "${CLAUDE_BIN:=claude}"                                   # headless `claude -p`
: "${CLAUDE_FLAGS:=--permission-mode acceptEdits}"          # tune to your Claude Code version

# --- Worker provider ---
# Which worker program the runner launches for every agent turn (lib/worker.sh and
# lib/worker.mjs dispatch on it; docs/worker-providers.md is the contract).
: "${GAFFER_WORKER_PROVIDER:=claude-code}"   # which worker runs agent turns: claude-code (headless `claude -p`, guarded by the in-process safety hook) or command (your own program at GAFFER_WORKER_COMMAND, under the contract in docs/worker-providers.md; it has no in-process safety hook, so it requires the docker sandbox with the host-side MCP bridge, SANDBOX_PROVIDER=docker on a Linux host, unless you set GAFFER_STRICT_REQUIRE=0 in the environment to say the runner is contained out-of-band). Any other value refuses to run. Environment only: settings.json cannot set it.
: "${GAFFER_WORKER_COMMAND:=}"   # absolute path of the worker program GAFFER_WORKER_PROVIDER=command runs, with no arguments, in the call's working directory; it must live outside $GAFFER_DATA and every write root and not be writable by its group or others. It reads GAFFER_WORKER_PROMPT_FILE, GAFFER_WORKER_MCP_CONFIG, GAFFER_WORKER_MODEL, GAFFER_WORKER_MAX_TURNS and the other GAFFER_WORKER_* variables, prints one JSON object on stdout (result, stop_reason, cap_hit, num_turns, cost_usd, model, usage; all optional) and exits 0 when it finished (docs/worker-providers.md). Environment only.
: "${GAFFER_WORKER_COMMAND_ENV:=}"   # space-separated env var names the command worker also receives (its own model credential, for example); the scrub drops them otherwise. The runner-only secrets (DISPATCH_API_TOKEN, GAFFER_CLAIM_TOKEN, GITHUB_TOKEN, GH_TOKEN, notify and webhook settings) are never passed. Environment only.
: "${GAFFER_WORKER_COMMAND_COST_USD:=}"   # the least each command-worker call is booked at in the usage ledger, in USD, because the cost it reports is its own word: a cost it leaves out or reports lower is booked at this floor (cost_basis floor). Empty = this call's dollar cap (GAFFER_MAX_CALL_USD) when set, else GAFFER_KILL_ESTIMATE_USD; 0 = trust the worker's figure. Environment only.
: "${GAFFER_SANDBOX_WORKER_COMMAND:=}"   # where the command worker's program lives INSIDE the docker sandbox image; empty = the same path as GAFFER_WORKER_COMMAND (the runner dir is mounted read-only at its host path, so a program kept under it works as is). Environment only.

# SINGLE RUNTIME. The runner's text processing — prompt / MCP / context-primer
# renders, the DoD distill helpers, the worktree key, the hygiene forbidden-path
# scan, minimalism and the CI-check parse — runs through packages/crew's typed CLIs
# only. The bash/awk twins that once backed a GAFFER_RUNTIME / GAFFER_DOD_DISTILL
# switch were deleted after the typed defaults soaked green; their outputs are
# pinned by runner/test/*-golden.test.sh. A gate whose CLI cannot run FAILS CLOSED
# (never decides); a feedback helper prints nothing. The crew dist is therefore a
# runtime requirement, like the dispatch CLI: `pnpm -r build` before running.

_GAFFER_CONFIG_PART=03-wiring
