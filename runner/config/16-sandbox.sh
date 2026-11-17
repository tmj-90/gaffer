# shellcheck shell=bash
# runner/config/16-sandbox.sh: sandbox and hardening: strict execution mode and the sandbox provider, the
# delivery hygiene, minimalism, greenfield and backpressure knobs.
# Sourced by runner/factory.config.sh only, in its fixed order, never directly or on
# its own: it reads what the parts before it set. Lines moved verbatim from
# factory.config.sh. The last line tells factory.config.sh this part loaded whole.

# --- Strict execution mode (OS-level containment, ON by default) -------------
# Best-effort OS-level containment layered ON TOP OF the worktree isolation +
# the deterministic safety hook. NOT a security guarantee — see docs/sandbox.md.
# 15-modes.sh defaults GAFFER_STRICT_REQUIRE=1 in every mode and STRICT_MODE=1 with
# it, so this 0 is reached only under the operator's GAFFER_STRICT_REQUIRE=0 opt-out
# in the environment (agents then run unwrapped unless you set STRICT_MODE=1).
: "${STRICT_MODE:=0}"          # 1 = wrap the live `claude -p` in the OS sandbox provider (defaults to 1 while the sandbox is required, which is the default)
# Which provider supplies the OS-level containment. This is a PROVIDER SEAM, not
# a hard dependency on any one tool. Two providers are real: `sandbox-exec` (macOS,
# write-only) and `docker` (any host with a daemon: read + egress isolation);
# `none` disables OS wrapping while keeping STRICT_MODE semantics togglable; any
# other value is unknown (fails closed under GAFFER_STRICT_REQUIRE=1). A new
# provider = a new case in lib/sandbox.sh.
#
# AUTO-DETECTED default (explicit env always wins): `sandbox-exec` where the binary
# exists (macOS), else `docker` where the docker CLI exists (Linux hosts — the daemon
# is probed at wrap time and STRICT_REQUIRE fails closed if it is down), else
# `sandbox-exec` so the degrade/refusal messages name the macOS-only tool honestly.
# Before this the default was always `sandbox-exec`, which on Linux silently meant
# "no OS sandbox" even on a host with Docker right there.
# GAFFER_SANDBOX (a setting) picks it: auto is that detection, docker or sandbox-exec
# name the provider. `none` is not a setting value: only an environment
# SANDBOX_PROVIDER=none (or the GAFFER_STRICT_REQUIRE=0 opt-out) runs agents unwrapped.
_GAFFER_SANDBOX_DETECTED=sandbox-exec
if [ -z "${SANDBOX_PROVIDER+x}" ]; then
  if command -v sandbox-exec >/dev/null 2>&1; then _GAFFER_SANDBOX_DETECTED=sandbox-exec
  elif command -v docker >/dev/null 2>&1; then _GAFFER_SANDBOX_DETECTED=docker; fi
fi
_gaffer_derive GAFFER_SANDBOX <<'_GAFFER_TABLE_'
#                     auto                       docker  sandbox-exec
?SANDBOX_PROVIDER     @_GAFFER_SANDBOX_DETECTED  docker  sandbox-exec   # the OS sandbox provider every agent launch runs in (auto: sandbox-exec where it exists, else docker)
STRICT_MODE           ~   # 1 = wrap every agent launch in the provider. Effectively 1: 15-modes.sh turns it on whenever the sandbox is required (every mode); this 0 applies only under the environment opt-out GAFFER_STRICT_REQUIRE=0
STRICT_ALLOW_NETWORK  ~   # 1 = the sandbox lets the agent reach the network (the agent CLI needs its API); the docker provider still allows only its egress list
STRICT_ALLOW_HOME     ~   # HOME paths the sandbox may write (the agent CLI state and cache)
GAFFER_SANDBOX_IMAGE  ~   # the image the docker provider runs each delivery in (read in lib/sandbox-docker.sh)
GAFFER_SANDBOX_LIMITS ~   # docker sandbox caps as "cpus=4 memory=4g pids=512"; a cap not named keeps that default
GAFFER_MCP_BRIDGE     ~   # docker provider: auto (on, except macOS) runs the MCP data plane on the host behind one socket; 1 forces on, 0 off
GAFFER_DOD_SANDBOX    ~   # 1 = the Definition-of-Done gates and criterion checks run inside the agent sandbox; 0 opts out, logged
GAFFER_EGRESS_ALLOW   ~   # extra hosts the docker sandbox egress proxy lets through (read in lib/egress-allowlist.mjs)
GAFFER_REGISTRY_PROBE ~   # 1 = check before a docker launch that the package registries answer through the egress proxy; 0 skips it
GAFFER_IDLE_HOST_EXEC ~   # 1 = allow idle repo commands (coverage, audit, oracles) on the host while the sandbox is required; 0 refuses them
_GAFFER_TABLE_
unset _GAFFER_SANDBOX_DETECTED
# Allow outbound network from inside the sandbox. IMPORTANT HONEST NOTE: because
# strict mode wraps the WHOLE `claude -p` process, network CANNOT be denied
# without breaking Claude's own API calls — so this defaults to 1 (allow). True
# per-subprocess network isolation (deny the agent's children network while
# Claude itself reaches the API) is a FUTURE-PROVIDER capability (docker / a microVM),
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
#   .mcp.json / mcp-runtime. — runtime MCP wiring (never deliver). The
#     `mcp-runtime.` fragment (note the trailing dot) covers the generated
#     `mcp-runtime.json` / per-tick `mcp-runtime.<pid>.json` files WITHOUT
#     false-positiving on a legit source dir like `src/mcp-runtime/` (finding 11).
# MUST match the library fallback in lib/hygiene.sh — keep the two in sync.
: "${HYGIENE_FORBIDDEN_PATHS:=node_modules .crew/ *.events.jsonl .claude/ CLAUDE.factory.md .mcp.json mcp-runtime. .terraform/}"

# (2) MINIMALISM post-condition. Every completed delivery should record a
# smallest-change note (+ files/lines counts computed from the diff, why-each-file,
# tests-run, evidence). A MISSING note is flagged `needs_human_review` by default
# and the delivery goes on to review, where the human judges minimality from the
# diff; MINIMALISM_REQUIRE_NOTE=1 sends it back to rework instead (for unsupervised
# runs). An oversized diff never fails: it flags `needs_human_review: oversized_diff`
# visibly, also when the note is missing or boilerplate.
# MINIMALISM_REQUIRE_NOTE, OVERSIZED_MAX_LINES and OVERSIZED_MAX_FILES are derived from
# GAFFER_GATES (its table in 07-limits.sh).

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
# The third backpressure dimension — active (claimed/in_progress) tickets per repo
# — is MAX_CONCURRENT_TICKETS_PER_REPO, defined once above (default 1). It is NOT
# re-defaulted here: a second `:=` would be dead (the value is already set) and any
# different number in it would be a silently-ignored lie.

_GAFFER_CONFIG_PART=16-sandbox
