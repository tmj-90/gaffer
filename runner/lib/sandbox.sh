# Gaffer strict-execution-mode provider seam (sourced by factory.config.sh).
# shellcheck shell=bash
#
# WHAT THIS IS — and IS NOT
# -------------------------
# This is best-effort OS-level containment, REQUIRED by default for every agent
# launch (GAFFER_STRICT_REQUIRE=0 in the environment opts out), layered ON TOP OF the
# existing two safety pillars (throwaway git worktree isolation + the
# deterministic PreToolUse safety hook). It is NOT a security sandbox and NOT a
# guarantee. Its single job: catch writes the agent makes OUTSIDE the worktree
# that the in-process safety hook cannot see (e.g. a dynamically-constructed
# path inside a `python3 -c …` the hook allowed, an exec'd child process, a
# library that writes via a syscall path the hook never inspected). The OS, not
# our shell, refuses those writes.
#
# PROVIDER ABSTRACTION (the load-bearing design constraint)
# ---------------------------------------------------------
# The system is built around a PROVIDER SEAM, NOT around `sandbox-exec`.
# `sandbox-exec` is ONE provider (the one a spike proved on macOS today). Docker,
# Lima, and full VMs are future providers with stronger (and different)
# guarantees — notably true per-subprocess network isolation, which `sandbox-exec`
# wrapping the WHOLE `claude -p` process fundamentally cannot offer (see the
# network caveat in factory.config.sh). To add a provider you add ONE `case`
# branch below and nothing else changes: tick.sh, the config, and the profile
# generator all dispatch through `sandbox_wrap_cmd`.
#
# CONTRACT
# --------
#   sandbox_wrap_cmd <write-roots> <read-roots>
#     • write-roots / read-roots: newline-separated absolute paths (the SAME
#       lists tick.sh already computes for the safety hook). read-roots are
#       accepted for symmetry / future providers; the sandbox-exec provider
#       reads broadly, so it needs no per-read rule.
#     • ECHOES a command PREFIX to stdout (possibly empty) that the caller
#       prepends to the `claude -p …` invocation. Empty prefix == no wrapping.
#     • Diagnostics go to STDERR so they never pollute the echoed prefix.
#     • Returns NON-ZERO when the host cannot supply the provider and the sandbox is
#       required, which is the default: the caller then does not launch (fail
#       closed). Only under the operator's GAFFER_STRICT_REQUIRE=0 opt-out does an
#       unsupported provider return 0 and degrade to "no extra containment, the
#       worktree isolation + safety hook still apply".

# Resolve a path to its canonical (symlink-free) form. macOS aliases /tmp and
# /var to /private/*, so the literal path the agent uses and the path the kernel
# enforces can differ; sandbox-exec matches on the canonical path. We canonicalise
# every subpath we emit so an allow-rule actually covers what the agent writes.
# A directory resolves in this shell (`cd && pwd -P`). A path that does not exist yet (a
# worktree created after this runs, the replay variant's HOME secrets, most of which a
# host does not have) resolves through its nearest existing parent with the rest
# appended. Only a symlinked FILE needs node's realpath: a node start per path cost the
# replay profile (16 such paths) seconds on a loaded macOS runner, every replay.
_sandbox_realpath() {
  local p="$1" head rest="" d
  if [ -d "$p" ]; then
    ( cd "$p" 2>/dev/null && pwd -P ) && return 0
  elif [ -L "$p" ]; then
    node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$p" 2>/dev/null && return 0
    printf '%s' "$p"; return 0
  fi
  case "$p" in /*) ;; *) printf '%s' "$p"; return 0 ;; esac
  head="${p%/}"
  while [ -n "$head" ] && [ ! -d "$head" ]; do
    rest="/${head##*/}$rest"; head="${head%/*}"
  done
  d="$( cd "${head:-/}" 2>/dev/null && pwd -P )" || { printf '%s' "$p"; return 0; }
  [ "$d" = / ] && d=""
  printf '%s' "$d$rest"
}

# Emit a single SBPL `(subpath "…")` line for a path, canonicalised + escaped.
# Skips empties. Escapes backslash and double-quote for SBPL string literals.
_sandbox_subpath_rule() {
  local p="$1"
  [ -n "$(printf '%s' "$p" | tr -d '[:space:]')" ] || return 0
  local real esc
  real="$(_sandbox_realpath "$p")"
  [ -n "$real" ] || return 0
  esc="$(printf '%s' "$real" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
  printf '  (subpath "%s")\n' "$esc"
}

# ── sandbox-exec provider: generate an SBPL profile ──────────────────────────
# SBPL is LAST-MATCH-WINS, so the order is deliberate:
#   1. (allow default)        → reads (and everything) broadly permitted
#   2. (deny file-write*)     → revoke ALL writes
#   3. (allow file-write* …)  → re-grant writes ONLY to the explicit subpaths
# Writes are allowed to: each write-root (worktree), $GAFFER_DATA (MCP dbs +
# agent files + this profile + the mcp runtime), the temp dirs, each
# $STRICT_ALLOW_HOME entry, and the std streams. process-exec + network are
# allowed (network gated on $STRICT_ALLOW_NETWORK). READ-roots need no rule —
# reads are broadly allowed by (allow default).
#
# THE REPLAY VARIANT (GAFFER_SANDBOX_PROFILE=replay: the tester lane's clean replay of the
# tester's own test files, bin/tester-run.mjs). The validation profile above stays as it
# is for the gates and acceptance profiles; the replay gets it with three changes, each
# appended after the write grant so it wins (last match):
#   • $GAFFER_DATA is NOT a write root, and writes into it are denied (a temp-dir grant
#     that contains it included), then the write roots (the replay checkout and its
#     scratch dirs, which may live under it) are granted again;
#   • READS of file contents under $GAFFER_DATA are denied (the databases, settings, the
#     dashboard token, other worktrees, the factory log), then allowed again for the write
#     roots and the read roots (the dependency links and the repo's git directory);
#   • HOME's secret folders and files (_SANDBOX_REPLAY_HOME_SECRETS: .ssh, .aws, the gh
#     and gcloud configs, .claude, .npmrc, .netrc, .git-credentials, cargo's credentials,
#     .gnupg, ...) cannot be read or written at all, and $STRICT_ALLOW_HOME is not
#     granted (the replay's HOME is a scratch directory).
# Only file-read-data is denied under $GAFFER_DATA (metadata stays readable, so resolving
# the checkout's own path through it still works).
#   _sandbox_exec_profile <write-roots> <profile-path> [read-roots]
_sandbox_exec_profile() {
  local write_roots="$1"
  local profile_path="$2"
  local read_roots="${3:-}"
  local replay=0
  [ "${GAFFER_SANDBOX_PROFILE:-}" = "replay" ] && replay=1
  {
    printf '(version 1)\n'
    printf ';; Gaffer strict-mode profile — generated, do not edit. Best-effort only.\n'
    printf '(allow default)\n'
    printf '(allow process-exec*)\n'
    printf '(allow process-fork)\n'
    if [ "${STRICT_ALLOW_NETWORK:-1}" = "1" ]; then
      printf '(allow network*)\n'
    else
      # NOTE: denying network here breaks Claude's OWN API calls because we wrap
      # the whole `claude -p` process. Left in as the explicit, honest knob;
      # true per-subprocess network isolation is a future-provider capability.
      printf '(deny network*)\n'
    fi
    printf '(deny file-write*)\n'
    # Re-grant writes ONLY to the explicit subpaths, as a SINGLE allow form (all
    # the (subpath …)/(literal …) clauses must be children of one `(allow
    # file-write* …)` — bare (subpath …) expressions grant nothing in SBPL).
    printf '(allow file-write*\n'
    # Each write-root (the worktree(s)).
    while IFS= read -r root; do
      _sandbox_subpath_rule "$root"
    done <<EOF
$write_roots
EOF
    # GAFFER_DATA: MCP sqlite dbs, agent id/log, the mcp runtime, and this profile.
    # (Not for the replay variant: its test code never writes the factory's state.)
    [ "$replay" = 1 ] || _sandbox_subpath_rule "${GAFFER_DATA:-}"
    # Temp dirs: many tools (python tempfile, pytest, build caches) write here.
    _sandbox_subpath_rule "${TMPDIR:-/tmp}"
    _sandbox_subpath_rule "/private/var/folders"
    _sandbox_subpath_rule "/tmp"
    # Operator-allowed HOME paths (e.g. Claude's own state/cache dirs). Not for the
    # replay variant: its test code runs with a scratch HOME and must never write the
    # runner's real one (a planted ~/.claude/settings.json hook would run outside the
    # sandbox on the next agent start).
    local home_entry
    if [ "$replay" != 1 ]; then
      for home_entry in ${STRICT_ALLOW_HOME:-}; do
        _sandbox_subpath_rule "$home_entry"
      done
    fi
    # Std streams + the null sink.
    printf '  (literal "/dev/null")\n'
    printf '  (literal "/dev/stdout")\n'
    printf '  (literal "/dev/stderr"))\n'
    if [ "$replay" = 1 ]; then _sandbox_exec_replay_rules "$write_roots" "$read_roots"; fi
  } > "$profile_path"
}

# HOME's folders and files the replay variant can neither read nor write (credentials and
# the agent's own configuration). Paths relative to $HOME, space separated.
_SANDBOX_REPLAY_HOME_SECRETS=".ssh .aws .config/gh .config/gcloud .azure .kube .docker .claude .npmrc .netrc .pypirc .git-credentials .cargo/credentials .cargo/credentials.toml .gnupg"
# The replay variant's extra rules (see above), printed after the write grant.
#   _sandbox_exec_replay_rules <write-roots> <read-roots>
_sandbox_exec_replay_rules() {
  local write_roots="$1" read_roots="$2" data_rule root secret
  data_rule="$(_sandbox_subpath_rule "${GAFFER_DATA:-}")"
  if [ -n "$data_rule" ]; then
    printf '(deny file-write*\n%s)\n' "$data_rule"
    printf '(allow file-write*\n'
    while IFS= read -r root; do _sandbox_subpath_rule "$root"; done <<EOF
$write_roots
EOF
    printf '  (literal "/dev/null"))\n'
    printf '(deny file-read-data\n%s)\n' "$data_rule"
    printf '(allow file-read-data\n'
    while IFS= read -r root; do _sandbox_subpath_rule "$root"; done <<EOF
$write_roots
$read_roots
EOF
    printf '  (literal "/dev/null"))\n'
  fi
  if [ -n "${HOME:-}" ]; then
    printf '(deny file-read* file-write*\n'
    for secret in $_SANDBOX_REPLAY_HOME_SECRETS; do
      _sandbox_subpath_rule "$HOME/$secret"
    done
    printf ')\n'
  fi
  return 0
}

# ── The provider seam ────────────────────────────────────────────────────────
# Dispatch on $SANDBOX_PROVIDER. A new provider == a new case; nothing else
# changes. Echoes the wrapping command prefix to stdout; diagnostics to stderr.
# STRICT-REQUIRE (C4), THE DEFAULT. The provider paths below that cannot supply an OS
# sandbox FAIL CLOSED unless the operator opted out with an explicit
# GAFFER_STRICT_REQUIRE=0 (or false/no/off) in the environment: OS isolation is the
# normal path for every agent launch, so unset, empty or any other value means
# "required". Only under the opt-out do those paths warn and DEGRADE (return 0 → run
# with worktree isolation + the safety hook, no OS sandbox). Helper: true when strict
# containment is required.
_sandbox_strict_required() {
  case "$(printf '%s' "${GAFFER_STRICT_REQUIRE:-1}" | tr '[:upper:]' '[:lower:]')" in
    0 | false | no | off) return 1 ;;
  esac
  return 0
}

# The provider when SANDBOX_PROVIDER is unset: the same auto-detection as
# runner/config/16-sandbox.sh (sandbox-exec where the binary exists, else docker where
# the docker CLI exists, else sandbox-exec so the refusal names the macOS-only tool).
# Repeated here because the Node launchers the dashboard starts reach this file without
# the config (lib/worker.mjs sandboxWrapArgv), so nothing else has set it for them.
gaffer_sandbox_default_provider() {
  if command -v sandbox-exec >/dev/null 2>&1; then printf 'sandbox-exec'
  elif command -v docker >/dev/null 2>&1; then printf 'docker'
  else printf 'sandbox-exec'; fi
}
_sandbox_provider() { printf '%s' "${SANDBOX_PROVIDER:-$(gaffer_sandbox_default_provider)}"; }

# THE ISOLATION PROBE: can this host supply the configured OS sandbox right now? No
# write roots and no side effects: it asks what sandbox_wrap_cmd asks (the binary, the
# docker CLI and daemon) and, for docker, whether the sandbox image is built (a launch
# without it fails inside the wrapper). Sets, for the caller:
#   GAFFER_SBX_PROVIDER   the provider in force (SANDBOX_PROVIDER or the detected one)
#   GAFFER_SBX_AVAILABLE  1 when it can wrap an agent, 0 when not
#   GAFFER_SBX_MISSING    what this host lacks, in words ("" when available)
#   GAFFER_SBX_FIX        the fix for it ("" when available)
# Always returns 0. The image name is GAFFER_SANDBOX_IMAGE, as in sandbox-docker.sh.
_SBX_BUILD_CMD='docker compose --profile sandbox build sandbox-image egress-proxy'
gaffer_sandbox_probe() {
  GAFFER_SBX_PROVIDER="$(_sandbox_provider)"
  GAFFER_SBX_AVAILABLE=0; GAFFER_SBX_MISSING=""; GAFFER_SBX_FIX=""
  local os; os="$(uname -s 2>/dev/null || echo unknown)"
  case "$GAFFER_SBX_PROVIDER" in
    sandbox-exec)
      if command -v sandbox-exec >/dev/null 2>&1; then GAFFER_SBX_AVAILABLE=1; return 0; fi
      if [ "$os" = Darwin ]; then
        GAFFER_SBX_MISSING="sandbox-exec is not on PATH"
        GAFFER_SBX_FIX="put /usr/bin (where macOS keeps sandbox-exec) back on PATH"
      elif command -v docker >/dev/null 2>&1; then
        GAFFER_SBX_MISSING="SANDBOX_PROVIDER=sandbox-exec, which exists only on macOS, and this is $os"
        GAFFER_SBX_FIX="unset SANDBOX_PROVIDER (or set it to docker) to use the Docker you have, and build its images once with \`$_SBX_BUILD_CMD\` (gaffer setup does this)"
      else
        GAFFER_SBX_MISSING="this is $os, where sandbox-exec does not exist, and Docker is not installed"
        GAFFER_SBX_FIX="install Docker, then run \`gaffer setup\` again (it builds the sandbox images with \`$_SBX_BUILD_CMD\`)"
      fi ;;
    docker)
      if ! command -v docker >/dev/null 2>&1; then
        GAFFER_SBX_MISSING="SANDBOX_PROVIDER=docker but the docker CLI is not installed"
        GAFFER_SBX_FIX="install Docker, then run \`gaffer setup\` again (it builds the sandbox images with \`$_SBX_BUILD_CMD\`)"
      elif ! docker info >/dev/null 2>&1; then
        GAFFER_SBX_MISSING="Docker is installed but its daemon is not reachable"
        GAFFER_SBX_FIX="start the docker daemon (or give this user access to it), then build the images once with \`$_SBX_BUILD_CMD\` (gaffer setup does this)"
      elif ! docker image inspect "${GAFFER_SANDBOX_IMAGE:-gaffer-sandbox:latest}" >/dev/null 2>&1; then
        GAFFER_SBX_MISSING="the docker sandbox image ${GAFFER_SANDBOX_IMAGE:-gaffer-sandbox:latest} is not built"
        GAFFER_SBX_FIX="build it once with \`$_SBX_BUILD_CMD\` in ${GAFFER_HOME:-the gaffer checkout} (gaffer setup does this)"
      else
        GAFFER_SBX_AVAILABLE=1
      fi ;;
    none)
      GAFFER_SBX_MISSING="SANDBOX_PROVIDER=none turns the OS sandbox off"
      GAFFER_SBX_FIX="unset SANDBOX_PROVIDER to auto-detect one (sandbox-exec on macOS, docker on Linux)" ;;
    *)
      GAFFER_SBX_MISSING="SANDBOX_PROVIDER=$GAFFER_SBX_PROVIDER is not a provider"
      GAFFER_SBX_FIX="set SANDBOX_PROVIDER to docker (any host with Docker) or sandbox-exec (macOS), or unset it to auto-detect" ;;
  esac
  return 0
}

# THE ONE MESSAGE a person can act on when an agent launch is refused because this host
# has no OS sandbox: the host's situation, the fix for it, then the opt-out (the
# environment only: settings.json cannot loosen it). Shown by `gaffer run`, the loop,
# a refused tick (the setup error the dashboard shows), the parked ticket's reason on
# the Team sheet (with "ticket", which adds the last step) and the Node launchers.
#   gaffer_sandbox_unavailable_hint [ticket] → the line (never empty)
gaffer_sandbox_unavailable_hint() {
  gaffer_sandbox_probe
  local why="$GAFFER_SBX_MISSING" fix="$GAFFER_SBX_FIX"
  if [ -z "$why" ]; then
    # Available to the probe but a wrap still failed (the daemon went away, a profile
    # file could not be written): name the provider and send the person to the log.
    why="the $GAFFER_SBX_PROVIDER sandbox could not be set up for this launch"
    fix="see \$GAFFER_DATA/factory.log for the provider's message"
  fi
  printf '%s' "agents run inside an OS sandbox and this host cannot supply one: $why. Fix: $fix. Or set GAFFER_STRICT_REQUIRE=0 in the environment (settings.json cannot) to run agents without one, only when the runner already runs inside a VM or container you trust."
  [ "${1:-}" = ticket ] && printf '%s' " Then move the ticket back to ready."
  return 0
}

# THE LAUNCH GATE, asked once before anything is claimed or spawned (`gaffer run`, the
# loop, the dashboard's Poll for work, every live tick). Returns 0 when an agent may
# launch: a dry run (DRY_RUN=1 never launches one), the sandbox is available, or the
# operator opted out in the environment (said loudly, once per process tree). Returns 1
# when it may not; the caller prints gaffer_sandbox_unavailable_hint in its own voice.
# The worker seams (lib/worker.sh, lib/worker.mjs) refuse each spawn on their own too.
gaffer_isolation_gate() {
  [ "${DRY_RUN:-0}" = 1 ] && return 0
  if ! _sandbox_strict_required; then
    gaffer_isolation_optout_notice
    return 0
  fi
  gaffer_sandbox_probe
  [ "$GAFFER_SBX_AVAILABLE" = 1 ]
}

# The opt-out, said once per process tree (the config is re-sourced by every child).
gaffer_isolation_optout_notice() {
  [ "${_GAFFER_STRICT_OPTOUT_WARNED:-}" = 1 ] && return 0
  printf 'WARNING: GAFFER_STRICT_REQUIRE=%s in the environment: agents run without the required OS sandbox. Only the worktree and the safety hook contain them, so this is safe only when the runner already runs inside a VM or container you trust.\n' "${GAFFER_STRICT_REQUIRE-}" >&2
  _GAFFER_STRICT_OPTOUT_WARNED=1; export _GAFFER_STRICT_OPTOUT_WARNED
  return 0
}

# AGENTS WRAPPED: true when an agent launch is wrapped in the OS sandbox now, read after
# gaffer_sandbox_probe: the provider is available and the launch asks for it (required, or
# STRICT_MODE=1; lib/tick-launch.sh). When false, nothing but the safety hook stands
# between an agent and a person's act (a tester waiver included): `gaffer preflight` and
# `gaffer status` say so (package H1).
_gaffer_agents_wrapped_probed() {
  [ "$GAFFER_SBX_AVAILABLE" = 1 ] || return 1
  _sandbox_strict_required && return 0
  [ "${STRICT_MODE:-0}" = 1 ]
}
gaffer_agents_wrapped() { gaffer_sandbox_probe; _gaffer_agents_wrapped_probed; }

# The one warning both say when agents run without OS isolation.
gaffer_human_verdict_isolation_warning() {
  printf '%s' "agents run without OS isolation, so a person's tester verdict (and every other human act) is guarded by the safety hook only; a waiver recorded now says \"recorded without OS isolation\""
}

# The isolation posture as one JSON object, for `gaffer sandbox-status` and the
# dashboard's Settings line: {provider, available, required, optedOut, missing, fix,
# wrapped}. `wrapped` is whether an agent launch is wrapped in the OS sandbox now: the
# provider is available AND the launch asks for it (required, or STRICT_MODE=1; see
# lib/tick-launch.sh). Dispatch records it on a person's tester waiver (package H1).
gaffer_sandbox_status_json() {
  gaffer_sandbox_probe
  local req=true opt=false wrapped=false
  if ! _sandbox_strict_required; then req=false; opt=true; fi
  if _gaffer_agents_wrapped_probed; then wrapped=true; fi
  node -e 'const [p,a,r,o,m,f,w]=process.argv.slice(1);process.stdout.write(JSON.stringify({provider:p,available:a==="1",required:r==="true",optedOut:o==="true",missing:m,fix:f,wrapped:w==="true"})+"\n")' \
    "$GAFFER_SBX_PROVIDER" "$GAFFER_SBX_AVAILABLE" "$req" "$opt" "$GAFFER_SBX_MISSING" "$GAFFER_SBX_FIX" "$wrapped"
}

sandbox_wrap_cmd() {
  local write_roots="${1:-}"
  local read_roots="${2:-}"   # used only by sandbox-exec's replay variant (reads are broad otherwise)

  case "$(_sandbox_provider)" in
    none)
      # No OS-level wrapping. Worktree isolation + safety hook still apply — UNLESS
      # the operator required an OS sandbox, in which case "none" is a contradiction.
      if _sandbox_strict_required; then
        printf 'strict-mode: SANDBOX_PROVIDER=none but the OS sandbox is required (GAFFER_STRICT_REQUIRE) — refusing to run (fail closed)\n' >&2
        return 1
      fi
      return 0
      ;;

    sandbox-exec)
      if ! command -v sandbox-exec >/dev/null 2>&1; then
        if _sandbox_strict_required; then
          printf 'strict-mode: sandbox-exec not found (macOS-only) and the OS sandbox is required (GAFFER_STRICT_REQUIRE) — refusing to run without an OS sandbox (fail closed)\n' >&2
          return 1
        fi
        printf 'strict-mode: sandbox-exec not found on this host — falling back to no OS sandbox (worktree isolation + safety hook still apply)\n' >&2
        return 0
      fi
      mkdir -p "${GAFFER_DATA:-/tmp}" 2>/dev/null || true
      # PER-CALL profile file, never a fixed shared path. Every invocation used to write
      # `$GAFFER_DATA/strict-profile.sb` and hand back a command that loads it LATER —
      # under GAFFER_CONCURRENCY>1 worker B could overwrite it between worker A composing
      # its wrap and A's sandbox-exec starting, so A ran under B's write roots. Same
      # pattern as the docker branch below: mktemp'd, prefixed with the tick's PID so
      # tick.sh's exit cleanup sweeps exactly its own files.
      local profile_path
      profile_path="$(mktemp "${GAFFER_DATA:-/tmp}/strict-profile.$$.XXXXXX" 2>/dev/null)" || {
        printf 'strict-mode: sandbox-exec provider could not create the per-call profile file under %s\n' "${GAFFER_DATA:-/tmp}" >&2
        return 1
      }
      _sandbox_exec_profile "$write_roots" "$profile_path" "$read_roots"
      printf 'sandbox-exec -f %s' "$profile_path"
      return 0
      ;;

    docker)
      # Mode 2: run the agent inside a container with read + egress isolation (see
      # lib/sandbox-docker.sh + docs/sandbox.md). Unlike sandbox-exec this
      # is a full execution context, not a syscall filter — so it wraps by emitting a
      # prefix that runs the command in the container. Needs a live docker daemon.
      if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
        if _sandbox_strict_required; then
          printf 'strict-mode: docker provider selected but the docker daemon is unavailable and the OS sandbox is required (GAFFER_STRICT_REQUIRE) — refusing to run (fail closed)\n' >&2
          return 1
        fi
        printf 'strict-mode: docker daemon unavailable — falling back to no OS sandbox (worktree isolation + safety hook still apply)\n' >&2
        return 0
      fi
      mkdir -p "${GAFFER_DATA:-/tmp}" 2>/dev/null || true
      # write/read roots can be multi-line — hand them to the wrapper via files.
      # B25(a): PER-CALL files, never a fixed shared path. Under GAFFER_CONCURRENCY>1
      # every worker used to write `$GAFFER_DATA/sandbox-write-roots`: worker B's
      # roots could overwrite worker A's between A composing its wrap and A's
      # container starting, so A's agent was mounted B's worktree READ-WRITE (and
      # lost its own). Each call now gets its own mktemp'd pair, prefixed with the
      # tick's PID so tick.sh's exit cleanup can sweep exactly its own files.
      local wrf rrf
      wrf="$(mktemp "${GAFFER_DATA:-/tmp}/sandbox-write-roots.$$.XXXXXX" 2>/dev/null)" || {
        printf 'strict-mode: docker provider could not create the per-call write-roots file under %s\n' "${GAFFER_DATA:-/tmp}" >&2
        return 1
      }
      rrf="$(mktemp "${GAFFER_DATA:-/tmp}/sandbox-read-roots.$$.XXXXXX" 2>/dev/null)" || {
        rm -f "$wrf"
        printf 'strict-mode: docker provider could not create the per-call read-roots file under %s\n' "${GAFFER_DATA:-/tmp}" >&2
        return 1
      }
      printf '%s\n' "$write_roots" > "$wrf"
      printf '%s\n' "$read_roots" > "$rrf"
      printf 'bash %s/lib/sandbox-docker.sh %s %s --' "${RUNNER_DIR:-.}" "$wrf" "$rrf"
      return 0
      ;;

    # (The former `lima` stub case is gone: an unimplemented provider is simply an
    # unknown one — same fail-closed / degrade behaviour below, no misleading choice.)
    *)
      if _sandbox_strict_required; then
        printf "strict-mode: unknown provider '%s' and the OS sandbox is required (GAFFER_STRICT_REQUIRE) — refusing to run without an OS sandbox (fail closed)\n" "${SANDBOX_PROVIDER}" >&2
        return 1
      fi
      printf "strict-mode: unknown provider '%s' — falling back to no OS sandbox (worktree isolation still applies)\n" "${SANDBOX_PROVIDER}" >&2
      return 0
      ;;
  esac
}
