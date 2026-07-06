# Gaffer strict-execution-mode provider seam (sourced by factory.config.sh).
# shellcheck shell=bash
#
# WHAT THIS IS — and IS NOT
# -------------------------
# This is OPTIONAL, best-effort OS-level containment layered ON TOP OF the
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
#     • Returns 0 even when a provider is unsupported: strict mode is best-effort
#       and must NEVER break a run — it degrades to "no extra containment, the
#       worktree isolation + safety hook still apply".

# Resolve a path to its canonical (symlink-free) form. macOS aliases /tmp and
# /var to /private/*, so the literal path the agent uses and the path the kernel
# enforces can differ; sandbox-exec matches on the canonical path. We canonicalise
# every subpath we emit so an allow-rule actually covers what the agent writes.
_sandbox_realpath() {
  local p="$1"
  # Prefer the directory itself if it exists; else its nearest existing parent
  # (a worktree may be created after this runs — its parent base already exists).
  if [ -e "$p" ]; then
    ( cd "$p" 2>/dev/null && pwd -P ) || python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$p" 2>/dev/null || printf '%s' "$p"
  else
    python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$p" 2>/dev/null || printf '%s' "$p"
  fi
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
_sandbox_exec_profile() {
  local write_roots="$1"
  local profile_path="$2"
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
    _sandbox_subpath_rule "${GAFFER_DATA:-}"
    # Temp dirs: many tools (python tempfile, pytest, build caches) write here.
    _sandbox_subpath_rule "${TMPDIR:-/tmp}"
    _sandbox_subpath_rule "/private/var/folders"
    _sandbox_subpath_rule "/tmp"
    # Operator-allowed HOME paths (e.g. Claude's own state/cache dirs).
    local home_entry
    for home_entry in ${STRICT_ALLOW_HOME:-}; do
      _sandbox_subpath_rule "$home_entry"
    done
    # Std streams + the null sink.
    printf '  (literal "/dev/null")\n'
    printf '  (literal "/dev/stdout")\n'
    printf '  (literal "/dev/stderr"))\n'
  } > "$profile_path"
}

# ── The provider seam ────────────────────────────────────────────────────────
# Dispatch on $SANDBOX_PROVIDER. A new provider == a new case; nothing else
# changes. Echoes the wrapping command prefix to stdout; diagnostics to stderr.
# STRICT-REQUIRE (C4). The provider paths below that cannot supply an OS sandbox
# normally warn + DEGRADE (return 0 → run with worktree isolation + the safety hook,
# no OS sandbox). When the operator sets GAFFER_STRICT_REQUIRE=1 they are asserting
# "do NOT run without an OS sandbox" — so those paths FAIL CLOSED instead. This makes
# the macOS-only OS sandbox HONEST on Linux: strict-require refuses to launch rather
# than silently no-op-ing. Helper: true when strict containment is required.
_sandbox_strict_required() {
  case "${GAFFER_STRICT_REQUIRE:-0}" in 1 | true | yes | on) return 0 ;; *) return 1 ;; esac
}

sandbox_wrap_cmd() {
  local write_roots="${1:-}"
  local read_roots="${2:-}"   # accepted for symmetry; unused by sandbox-exec (reads broad)

  case "${SANDBOX_PROVIDER:-sandbox-exec}" in
    none)
      # No OS-level wrapping. Worktree isolation + safety hook still apply — UNLESS
      # the operator required an OS sandbox, in which case "none" is a contradiction.
      if _sandbox_strict_required; then
        printf 'strict-mode: SANDBOX_PROVIDER=none but GAFFER_STRICT_REQUIRE=1 demands an OS sandbox — refusing to run (fail closed)\n' >&2
        return 1
      fi
      return 0
      ;;

    sandbox-exec)
      if ! command -v sandbox-exec >/dev/null 2>&1; then
        if _sandbox_strict_required; then
          printf 'strict-mode: sandbox-exec not found (macOS-only) and GAFFER_STRICT_REQUIRE=1 — refusing to run without an OS sandbox (fail closed)\n' >&2
          return 1
        fi
        printf 'strict-mode: sandbox-exec not found on this host — falling back to no OS sandbox (worktree isolation + safety hook still apply)\n' >&2
        return 0
      fi
      mkdir -p "${GAFFER_DATA:-/tmp}" 2>/dev/null || true
      local profile_path="${GAFFER_DATA:-/tmp}/strict-profile.sb"
      _sandbox_exec_profile "$write_roots" "$profile_path"
      printf 'sandbox-exec -f %s' "$profile_path"
      return 0
      ;;

    docker)
      # Mode 2: run the agent inside a container with read + egress isolation (see
      # lib/sandbox-docker.sh + docs/vm-sandbox-provider.md). Unlike sandbox-exec this
      # is a full execution context, not a syscall filter — so it wraps by emitting a
      # prefix that runs the command in the container. Needs a live docker daemon.
      if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
        if _sandbox_strict_required; then
          printf 'strict-mode: docker provider selected but the docker daemon is unavailable and GAFFER_STRICT_REQUIRE=1 — refusing to run (fail closed)\n' >&2
          return 1
        fi
        printf 'strict-mode: docker daemon unavailable — falling back to no OS sandbox (worktree isolation + safety hook still apply)\n' >&2
        return 0
      fi
      mkdir -p "${GAFFER_DATA:-/tmp}" 2>/dev/null || true
      # write/read roots can be multi-line — hand them to the wrapper via files.
      local wrf="${GAFFER_DATA:-/tmp}/sandbox-write-roots" rrf="${GAFFER_DATA:-/tmp}/sandbox-read-roots"
      printf '%s\n' "$write_roots" > "$wrf"
      printf '%s\n' "$read_roots" > "$rrf"
      printf 'bash %s/lib/sandbox-docker.sh %s %s --' "${RUNNER_DIR:-.}" "$wrf" "$rrf"
      return 0
      ;;

    lima)
      if _sandbox_strict_required; then
        printf "strict-mode: provider 'lima' not yet supported and GAFFER_STRICT_REQUIRE=1 — refusing to run without an OS sandbox (fail closed)\n" >&2
        return 1
      fi
      printf "strict-mode: provider 'lima' not yet supported — falling back to no OS sandbox (worktree isolation still applies)\n" >&2
      return 0
      ;;

    *)
      if _sandbox_strict_required; then
        printf "strict-mode: unknown provider '%s' and GAFFER_STRICT_REQUIRE=1 — refusing to run without an OS sandbox (fail closed)\n" "${SANDBOX_PROVIDER}" >&2
        return 1
      fi
      printf "strict-mode: unknown provider '%s' — falling back to no OS sandbox (worktree isolation still applies)\n" "${SANDBOX_PROVIDER}" >&2
      return 0
      ;;
  esac
}
