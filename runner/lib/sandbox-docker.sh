#!/usr/bin/env bash
# Gaffer Mode-2 sandbox runner — the `docker` provider's execution wrapper.
#
# Invoked as the wrap PREFIX emitted by `sandbox_wrap_cmd` (lib/sandbox.sh):
#
#     bash sandbox-docker.sh <write-roots-file> <read-roots-file> -- <cmd> [args...]
#
# It runs <cmd> inside a container that, unlike the macOS `sandbox-exec` write-sandbox,
# also closes the two gaps in the external security review's #1 (read + network):
#
#   • READ isolation — the container's filesystem is empty of the host. We mount ONLY
#     the write-roots (rw), the read-roots (ro), the delivery worktree's git metadata
#     (the repo's `.git` common dir read-only, with just the sub-paths a commit writes
#     read-write) and the factory's own code (runner/, packages/, node_modules — ro).
#     Host $HOME, ~/.ssh, ~/.aws, sibling repos — none are present, so `read host
#     secret` has nothing to read. Mounts are PATH-MIRRORED (host path == container
#     path) so the absolute paths in the command and the rendered .mcp.json resolve
#     identically inside — no path translation needed.
#
#     $GAFFER_DATA is the one exception and it is handled honestly (B25c): the MCP data
#     plane inside the container writes the CANONICAL dispatch/memory SQLite files
#     directly (DISPATCH_DB / MEMORY_DB default to `$GAFFER_DATA/*.sqlite`; there is no
#     copy-and-reconcile step), and SQLite needs the DIRECTORY for its -wal/-shm/-journal
#     siblings — so the directory is bind-mounted rw, and then EVERY OTHER entry in it is
#     MASKED (a file by binding /dev/null over it, a directory by a tmpfs): settings.json,
#     dashboard-token, the ledgers, other workers' mcp-runtime files (their claim
#     tokens), the sibling delivery worktrees under worktrees/, .workers/… Only the two
#     DBs (+ siblings), THIS call's own --mcp-config file, the crew events log and the
#     safety hook's own ledgers stay visible. Entries created after the container
#     starts are not masked — that is the residual gap; the per-tick files that matter
#     (mcp-runtime.<pid>.json) already exist when a worker's container starts.
#
#   • EGRESS isolation — the container sits on an --internal docker network (no NAT), so
#     it has no direct route out. Its only path to the internet is the allowlist proxy
#     (runner/sandbox/egress-proxy), reached via HTTP(S)_PROXY. The proxy default-denies
#     and forwards only the model endpoint + package registries, so `POST it out` fails
#     at the network layer.
#
#   • CREDENTIALS — the container env is built fresh: ONLY ANTHROPIC_API_KEY plus the
#     GAFFER_/DISPATCH_/MEMORY_ vars the MCP servers need are forwarded. Nothing else.
#
# Best-effort, like the whole strict-mode seam: on any setup failure it prints to stderr
# and returns non-zero, so the caller (tick.sh) fail-closes under GAFFER_STRICT_REQUIRE=1
# rather than silently running uncontained.
set -euo pipefail

_NET_INT="${GAFFER_SANDBOX_NET_INT:-gaffer-egress-int}"
_NET_UP="${GAFFER_SANDBOX_NET_UP:-gaffer-egress-uplink}"
_PROXY_NAME="${GAFFER_SANDBOX_PROXY:-gaffer-egress-proxy-svc}"
_PROXY_IMAGE="${GAFFER_SANDBOX_PROXY_IMAGE:-gaffer-egress-proxy}"
_IMAGE="${GAFFER_SANDBOX_IMAGE:-gaffer-sandbox:latest}"
_RUNNER_DIR="${RUNNER_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"

_die() { printf 'sandbox-docker: %s\n' "$1" >&2; exit 1; }

# --- parse args: <write-roots-file> <read-roots-file> -- <cmd...> ---
[ "$#" -ge 3 ] || _die "usage: sandbox-docker.sh <write-roots-file> <read-roots-file> -- <cmd...>"
_WRITE_ROOTS_FILE="$1"; _READ_ROOTS_FILE="$2"; shift 2
[ "$1" = "--" ] || _die "expected -- before the command, got '$1'"; shift
[ "$#" -ge 1 ] || _die "no command to run"

# GAFFER_SANDBOX_DRY_RUN=1: assemble the `docker run` argv and PRINT it (one arg per
# line) instead of executing — no daemon, no network, no image needed. This is the
# testable seam for the mount/env assembly below (test/sandbox-docker-mounts.test.sh).
_DRY_RUN="${GAFFER_SANDBOX_DRY_RUN:-0}"

if [ "$_DRY_RUN" != "1" ]; then
  command -v docker >/dev/null 2>&1 || _die "docker not found"
  docker info >/dev/null 2>&1 || _die "docker daemon unavailable"
fi

# --- render the effective egress allowlist (baked default + operator hosts) ---
# The proxy image bakes a default-deny host filter; this lets an operator permit
# EXTRA hosts (a private git host / package registry) via GAFFER_EGRESS_ALLOW
# (comma/space list) and/or an egress-allow.txt file, WITHOUT rebuilding the image.
# The builder anchors + regex-escapes each operator host, so default-deny can never
# be widened to match-all. Falls back to the baked filter if node is unavailable.
_render_egress_filter() {
  local data="${GAFFER_DATA:-$_RUNNER_DIR/.gaffer}"
  mkdir -p "$data" 2>/dev/null || true
  local base="$_RUNNER_DIR/sandbox/egress-proxy/filter"
  local allow="${GAFFER_EGRESS_ALLOW_FILE:-$data/egress-allow.txt}"
  _EGRESS_FILTER="$data/egress-filter"
  # NB: the builder writes the filter TEXT to stdout and operator-relevant messages
  # (added N hosts / ignored invalid entry / unreadable allow-file) to stderr. Do NOT
  # suppress stderr — a dropped private-registry host must surface, not vanish.
  if command -v node >/dev/null 2>&1 &&
    node "$_RUNNER_DIR/lib/egress-allowlist.mjs" --base "$base" --allow-file "$allow" \
      >"$_EGRESS_FILTER.tmp"; then
    mv "$_EGRESS_FILTER.tmp" "$_EGRESS_FILTER"
  else
    rm -f "$_EGRESS_FILTER.tmp" 2>/dev/null || true
    cp "$base" "$_EGRESS_FILTER" \
      || {
        printf 'sandbox-docker: _render_egress_filter: could not render the operator filter AND the fallback copy of the baked filter "%s" failed\n' \
          "$base" >&2
        return 1
      }
  fi
}

# --- ensure the egress network + proxy are up (idempotent) ---
_ensure_egress() {
  docker network inspect "$_NET_UP"  >/dev/null 2>&1 || docker network create "$_NET_UP" >/dev/null
  docker network inspect "$_NET_INT" >/dev/null 2>&1 || docker network create --internal "$_NET_INT" >/dev/null
  _render_egress_filter || _die "could not render the effective egress filter (see the message above)"
  # Restart the proxy when the effective filter changed — a RUNNING proxy still holds
  # the OLD mounted filter, so an operator's allowlist edit wouldn't take effect.
  local data="${GAFFER_DATA:-$_RUNNER_DIR/.gaffer}"
  local sha shafile prev running=0
  # sha256sum (GNU coreutils, Linux) or shasum (macOS/perl) — whichever this host has.
  sha="$( { sha256sum "$_EGRESS_FILTER" 2>/dev/null || shasum -a 256 "$_EGRESS_FILTER" 2>/dev/null; } | awk '{print $1}')"
  shafile="$data/.egress-filter.sha"
  [ -f "$shafile" ] && prev="$(cat "$shafile" 2>/dev/null)" || prev=""
  docker ps --filter "name=^${_PROXY_NAME}$" --filter status=running -q | grep -q . && running=1
  if [ "$running" = 1 ] && [ -n "$sha" ] && [ "$sha" != "$prev" ]; then
    docker rm -f "$_PROXY_NAME" >/dev/null 2>&1 || true
    running=0
  fi
  if [ "$running" = 0 ]; then
    docker rm -f "$_PROXY_NAME" >/dev/null 2>&1 || true
    docker image inspect "$_PROXY_IMAGE" >/dev/null 2>&1 \
      || docker build -q -t "$_PROXY_IMAGE" "$_RUNNER_DIR/sandbox/egress-proxy" >/dev/null \
      || _die "could not build the egress proxy image"
    # Mount the RENDERED filter over the baked one so operator hosts apply without a rebuild.
    docker run -d --name "$_PROXY_NAME" --network "$_NET_UP" \
      -v "$_EGRESS_FILTER:/etc/tinyproxy/filter:ro" \
      "$_PROXY_IMAGE" >/dev/null \
      || _die "could not start the egress proxy"
    docker network connect --alias egress-proxy "$_NET_INT" "$_PROXY_NAME" >/dev/null \
      || _die "could not attach the egress proxy to the internal network"
    [ -n "$sha" ] && printf '%s' "$sha" >"$shafile" 2>/dev/null || true
  fi
}
[ "$_DRY_RUN" = "1" ] || _ensure_egress

# --- assemble mount + env args ---
_mounts=()
_mounted_roots=()   # every host path we bind (any mode) — for the "already covered?" test
_add_mount() {      # <host-path> <rw|ro>
  local p="$1" mode="$2" m
  for m in ${_mounted_roots[@]+"${_mounted_roots[@]}"}; do [ "$m" = "$p" ] && return 0; done
  _mounts+=( -v "$p:$p:$mode" ); _mounted_roots+=( "$p" )
}
_add_mount_at() {   # <host-path> <container-path> <rw|ro> — dedup on the CONTAINER path
  local src="$1" at="$2" mode="$3" m
  for m in ${_mounted_roots[@]+"${_mounted_roots[@]}"}; do [ "$m" = "$at" ] && return 0; done
  _mounts+=( -v "$src:$at:$mode" ); _mounted_roots+=( "$at" )
}
_covered() {        # true when <path> is a mounted root or lives under one
  local p="$1" m
  for m in ${_mounted_roots[@]+"${_mounted_roots[@]}"}; do
    case "$p" in "$m"|"$m"/*) return 0 ;; esac
  done
  return 1
}
_WRITE_ROOTS=()
while IFS= read -r root; do
  [ -n "$(printf '%s' "$root" | tr -d '[:space:]')" ] || continue
  [ -e "$root" ] || continue
  _add_mount "$root" rw; _WRITE_ROOTS+=( "$root" )
done < "$_WRITE_ROOTS_FILE"
while IFS= read -r root; do
  [ -n "$(printf '%s' "$root" | tr -d '[:space:]')" ] || continue
  [ -e "$root" ] || continue
  _add_mount "$root" ro
done < "$_READ_ROOTS_FILE"
# The factory's own dir (skills, safety hook, worker seam) — ro, path-mirrored.
[ -d "$_RUNNER_DIR" ] && _add_mount "$_RUNNER_DIR" ro
# The factory's BUILT PACKAGES + their dependency tree — ro, path-mirrored. The MCP
# servers the agent delivers through are `node $GAFFER_HOME/packages/{dispatch,memory}/dist/…`
# (DISPATCH_MCP_BIN / MEMORY_MCP_BIN) and resolve their imports via the pnpm store in
# `$GAFFER_HOME/node_modules`. Without these two mounts neither MCP server can start
# inside the container — the worker has no data plane and every delivery is inert.
# Deliberately NOT the whole $GAFFER_HOME: that would expose the factory's own `.env`
# and any operator files kept beside the checkout to a kernel-level read the hook
# cannot see. `packages/` and `node_modules/` are code, not secrets.
_GAFFER_HOME="${GAFFER_HOME:-$(cd "$_RUNNER_DIR/.." && pwd)}"
for _d in "$_GAFFER_HOME/packages" "$_GAFFER_HOME/node_modules"; do
  [ -d "$_d" ] && ! _covered "$_d" && _add_mount "$_d" ro
done
# Each write root's node_modules are SYMLINKS into the real checkout (tick.sh links
# them in because installs are hook-blocked in a worktree). Mounts are path-mirrored,
# so the link resolves inside the container ONLY if its target is mounted too — bind
# each resolved target ro (dedup'd, skipped when an existing mount already covers it).
# Depth 4 mirrors tick.sh's workspace-package sweep (`find -maxdepth 3 -name node_modules`).
_readlink_f() { readlink -f "$1" 2>/dev/null || node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]) + "\n")' "$1" 2>/dev/null; }
for _wr in ${_WRITE_ROOTS[@]+"${_WRITE_ROOTS[@]}"}; do
  while IFS= read -r _lnk; do
    _tgt="$(_readlink_f "$_lnk")"
    [ -n "$_tgt" ] && [ -d "$_tgt" ] || continue
    # Mount the resolved host directory AT THE PATH THE LINK NAMES. Inside the
    # container the symlink is followed literally, so a mount at the canonical path
    # alone dangles wherever the two differ — on macOS every temp/worktree path under
    # /var is really /private/var, which left the DoD gate without node_modules. An
    # absolute link gets the mount at its own path; a relative link resolves inside
    # the (already mounted) root or falls back to the canonical target.
    _raw="$(readlink "$_lnk" 2>/dev/null || true)"
    case "$_raw" in /*) _at="$_raw" ;; *) _at="$_tgt" ;; esac
    _covered "$_at" && continue
    _add_mount_at "$_tgt" "$_at" ro
  done < <(find "$_wr" -maxdepth 4 -name node_modules -type l 2>/dev/null)
done

# --- the delivery worktree's git metadata (B25c) ---------------------------------------
# A delivery worktree is a LINKED worktree: its `.git` is a FILE ("gitdir: …") pointing
# into the real repo's `.git/worktrees/<name>`, and the objects/refs live in the repo's
# `.git` (the common dir). Neither was mounted, so inside the container every git
# command failed ("not a git repository") and the agent could not commit. Mount the
# common dir READ-ONLY and only what a commit must write READ-WRITE: objects/ (new
# blobs/trees/commits), refs/ + logs/ (the branch tip + its reflog) and the worktree's
# own private dir (index, HEAD, COMMIT_EDITMSG). config, hooks, packed-refs, the main
# checkout's HEAD and every OTHER worktree's private dir stay read-only. A write root
# that is itself a full repo (`.git` is a directory) is already inside its rw mount.
_under_write_root() {  # true when <path> is a write root or lives under one
  local p="$1" w
  for w in ${_WRITE_ROOTS[@]+"${_WRITE_ROOTS[@]}"}; do
    case "$p" in "$w"|"$w"/*) return 0 ;; esac
  done
  return 1
}
_git_path() {  # <worktree> <rev-parse flag> → absolute, symlink-resolved path (or nothing)
  local wt="$1" flag="$2" p
  p="$(git -C "$wt" rev-parse "$flag" 2>/dev/null)" || return 0
  [ -n "$p" ] || return 0
  case "$p" in /*) ;; *) p="$wt/$p" ;; esac
  _readlink_f "$p"
}
if command -v git >/dev/null 2>&1; then
  for _wr in ${_WRITE_ROOTS[@]+"${_WRITE_ROOTS[@]}"}; do
    [ -f "$_wr/.git" ] || continue          # only LINKED worktrees have a .git FILE
    _common="$(_git_path "$_wr" --git-common-dir)"
    _gitdir="$(_git_path "$_wr" --git-dir)"
    [ -n "$_common" ] && [ -d "$_common" ] || continue
    _under_write_root "$_common" && continue   # the repo itself is a write root: covered rw
    _covered "$_common" || _add_mount "$_common" ro
    # git creates logs/ lazily; make sure the reflog dir exists so its rw mount can land
    # (an empty dir under .git is exactly what git itself would create on first commit).
    mkdir -p "$_common/logs" 2>/dev/null || true
    for _sub in objects refs logs; do
      [ -d "$_common/$_sub" ] && _add_mount "$_common/$_sub" rw
    done
    if [ -n "$_gitdir" ] && [ -d "$_gitdir" ] && [ "$_gitdir" != "$_common" ]; then
      _add_mount "$_gitdir" rw
    fi
  done
fi

# --- $GAFFER_DATA: the MCP data plane's DB directory, everything else MASKED (B25c) ------
# See the header. The directory must be mounted (SQLite siblings), so mount it rw and
# mask every top-level entry that is not on the allowlist below. The masks are ordinary
# mounts nested inside the GAFFER_DATA mount; docker applies mounts parent-first, so a
# write root that lives UNDER a masked dir (the default `$GAFFER_DATA/worktrees/ticket-N`
# layout) is bind-mounted back on top of the tmpfs that hides its siblings.
_BRIDGED=0
if [ -n "${GAFFER_MCP_BRIDGE_SOCKET:-}" ]; then
  # ── BRIDGE MODE (lib/mcp-bridge.mjs; external review, finding 2) ─────────────
  # The MCP data plane runs on the HOST. NOTHING under $GAFFER_DATA is mounted except:
  #   • the bridge's unix socket (rw) — the container's only path to dispatch/memory;
  #   • THIS call's bridged --mcp-config (ro; token-free: every server is `connect`);
  #   • the safety hook's two append-only ledgers (rw) — telemetry, not decision state;
  #   • the crew events log the hook appends to (rw), if it lives there;
  #   • the agent's skills mount target (ro).
  # No database, usage ledger, settings.json, dashboard token or other worker's claim
  # token exists in the container's filesystem, and the write root (the worktree under
  # $GAFFER_DATA/worktrees/) is mounted on its own above.
  [ -e "$GAFFER_MCP_BRIDGE_SOCKET" ] || _die "GAFFER_MCP_BRIDGE_SOCKET=$GAFFER_MCP_BRIDGE_SOCKET does not exist — the host-side MCP bridge is not up"
  _add_mount "$GAFFER_MCP_BRIDGE_SOCKET" rw
  _prev=""
  for _a in "$@"; do
    if [ "$_prev" = "--mcp-config" ] && [ -f "$_a" ]; then _covered "$_a" || _add_mount "$_a" ro; fi
    _prev="$_a"
  done
  if [ -n "${GAFFER_DATA:-}" ] && [ -d "$GAFFER_DATA" ]; then
    for _f in "$GAFFER_DATA/safety-blocks.jsonl" "$GAFFER_DATA/tool-metrics.jsonl"; do
      [ -e "$_f" ] || : > "$_f" 2>/dev/null || true
      [ -f "$_f" ] && ! _covered "$_f" && _add_mount "$_f" rw
    done
    case "${GAFFER_CREW_EVENTS:-}" in
      "$GAFFER_DATA"/*) [ -e "$GAFFER_CREW_EVENTS" ] || : > "$GAFFER_CREW_EVENTS" 2>/dev/null || true
                        [ -f "$GAFFER_CREW_EVENTS" ] && ! _covered "$GAFFER_CREW_EVENTS" && _add_mount "$GAFFER_CREW_EVENTS" rw ;;
    esac
    for _wr in ${_WRITE_ROOTS[@]+"${_WRITE_ROOTS[@]}"}; do
      _sk="$(readlink "$_wr/.claude/skills" 2>/dev/null || true)"
      [ -n "$_sk" ] && [ -d "$_sk" ] && ! _covered "$_sk" && _add_mount "$_sk" ro
    done
  fi
  _BRIDGED=1
elif [ -n "${GAFFER_DATA:-}" ] && [ -d "$GAFFER_DATA" ] && ! _covered "$GAFFER_DATA"; then
  # ── LEGACY MODE: the MCP servers run INSIDE the container ──────────────────────
  # Only when the bridge is off (GAFFER_MCP_BRIDGE=0, or macOS Docker Desktop, which
  # cannot bind-mount a host unix socket). Say so loudly: the databases are reachable
  # from the worker's shell here (SECURITY.md, residual limits).
  printf 'sandbox-docker: WARNING — MCP data plane runs INSIDE the container (GAFFER_MCP_BRIDGE off): %s is mounted rw with the dispatch/memory databases reachable by the worker; set GAFFER_MCP_BRIDGE=1 on a Linux host to keep them out (SECURITY.md)\n' "$GAFFER_DATA" >&2
  _add_mount "$GAFFER_DATA" rw
  _keep=()
  for _db in "${DISPATCH_DB:-$GAFFER_DATA/dispatch.sqlite}" "${MEMORY_DB:-$GAFFER_DATA/memory.sqlite}"; do
    case "$_db" in "$GAFFER_DATA"/*) _keep+=( "${_db#"$GAFFER_DATA"/}" ) ;; esac
  done
  # THIS call's own rendered MCP config (`--mcp-config <path>` in the wrapped argv) —
  # never any other tick's (theirs carry other claim tokens).
  _prev=""
  for _a in "$@"; do
    if [ "$_prev" = "--mcp-config" ]; then
      case "$_a" in "$GAFFER_DATA"/*) _keep+=( "${_a#"$GAFFER_DATA"/}" ) ;; esac
    fi
    _prev="$_a"
  done
  # The crew events log the MCP servers append to, and the safety hook's own ledgers.
  case "${GAFFER_CREW_EVENTS:-}" in "$GAFFER_DATA"/*) _keep+=( "${GAFFER_CREW_EVENTS#"$GAFFER_DATA"/}" ) ;; esac
  _keep+=( safety-blocks.jsonl tool-metrics.jsonl )
  # The agent's per-agent skills mount (its `.claude/skills` symlink target) — links
  # into the read-only runner/skills library, nothing secret.
  for _wr in ${_WRITE_ROOTS[@]+"${_WRITE_ROOTS[@]}"}; do
    _sk="$(readlink "$_wr/.claude/skills" 2>/dev/null || true)"
    case "$_sk" in "$GAFFER_DATA"/*) _keep+=( "${_sk#"$GAFFER_DATA"/}" ) ;; esac
  done
  _kept() {  # true when top-level entry <name> is (or contains) an allowlisted path
    local b="$1" k
    for k in ${_keep[@]+"${_keep[@]}"}; do
      case "$b" in "$k"|"$k-wal"|"$k-shm"|"$k-journal") return 0 ;; esac   # SQLite siblings
      case "$k" in "$b"/*) return 0 ;; esac                                # nested keep
    done
    return 1
  }
  for _e in "$GAFFER_DATA"/* "$GAFFER_DATA"/.[!.]*; do
    [ -e "$_e" ] || [ -L "$_e" ] || continue
    _b="$(basename "$_e")"
    _kept "$_b" && continue
    # A symlink cannot be reliably masked (docker resolves the destination); its target
    # is only readable inside if it is under a mount we chose anyway.
    [ -L "$_e" ] && continue
    if [ -d "$_e" ]; then
      # rw (not ro): a write root nested under it needs its mountpoint dir created.
      _mounts+=( --tmpfs "$_e:rw,noexec,nosuid,size=65536k" )
    elif [ -f "$_e" ]; then
      _mounts+=( -v "/dev/null:$_e:ro" )
    fi
  done
fi

# Forward ONLY the allowlisted env. The model credential (ONE of ANTHROPIC_API_KEY or
# CLAUDE_CODE_OAUTH_TOKEN — the latter is a subscription token from `claude setup-token`,
# the supported headless-Max path) plus the MCP data-plane vars. Nothing else.
#
# GAFFER_CLAIM_TOKEN is deliberately NOT forwarded to the container's top-level env: it
# would land in the AGENT's own environment, where a prompt-injected agent could read it
# (`printenv`) and call the loopback dispatch API directly, bypassing the MCP tool gating.
# The dispatch MCP server still receives it — via the mounted mcp-runtime config's `env`
# block (sed-substituted in tick.sh), which sets it only for that server subprocess. This
# matches the non-docker agent-env design, where `*_TOKEN` is denied to the agent.
_envs=()
# In bridge mode the container runs NO MCP server, so the DB paths and server bins are
# not forwarded either — nothing inside names the databases.
_fwd=( ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN GAFFER_DATA GAFFER_FACTORY )
[ "$_BRIDGED" = 1 ] || _fwd+=( DISPATCH_DB MEMORY_DB DISPATCH_MCP_BIN MEMORY_MCP_BIN )
for k in "${_fwd[@]}"; do
  [ -n "${!k:-}" ] && _envs+=( -e "$k" )
done
# Fallback: if the operator has placed a Claude credentials file, mount it read-only into
# the container's home so claude authenticates. The runner never reads its contents.
_cred="${GAFFER_SANDBOX_CLAUDE_CREDENTIALS:-}"
[ -n "$_cred" ] && [ -f "$_cred" ] && _mounts+=( -v "$_cred:/root/.claude/.credentials.json:ro" )
if [ -z "${ANTHROPIC_API_KEY:-}${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ ! -f "${_cred:-/nonexistent}" ]; then
  printf 'sandbox-docker: no model credential — set CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`), ANTHROPIC_API_KEY, or GAFFER_SANDBOX_CLAUDE_CREDENTIALS; claude will not authenticate inside the container\n' >&2
fi
# The bind-mounted worktree + repo `.git` are owned by the HOST uid while the guest runs
# as root; git ≥ 2.35.2 refuses to touch a repo owned by another user ("dubious
# ownership") unless it is marked safe. Mark the mounted paths safe through git's
# env-config channel (no file is written): `*` is scoped to the container, whose only
# repos are the ones this wrapper mounted.
_envs+=( -e "GIT_CONFIG_COUNT=1" -e "GIT_CONFIG_KEY_0=safe.directory" -e "GIT_CONFIG_VALUE_0=*" )
# Route all egress through the allowlist proxy.
_envs+=( -e "HTTP_PROXY=http://egress-proxy:8888" -e "HTTPS_PROXY=http://egress-proxy:8888" )
_envs+=( -e "http_proxy=http://egress-proxy:8888" -e "https_proxy=http://egress-proxy:8888" )
# No proxy for loopback + the docker-internal proxy hostname itself.
_envs+=( -e "NO_PROXY=localhost,127.0.0.1,egress-proxy" -e "no_proxy=localhost,127.0.0.1,egress-proxy" )

if [ "$_DRY_RUN" = "1" ]; then
  printf '%s\n' docker run --rm --network "$_NET_INT" \
    --cap-drop=ALL --cap-add=DAC_OVERRIDE --security-opt=no-new-privileges \
    --pids-limit "${GAFFER_SANDBOX_PIDS:-512}" --memory "${GAFFER_SANDBOX_MEMORY:-4g}" --cpus "${GAFFER_SANDBOX_CPUS:-4}" \
    -w "$(pwd)" "${_mounts[@]}" "${_envs[@]}" "$_IMAGE" "$@"
  exit 0
fi

docker image inspect "$_IMAGE" >/dev/null 2>&1 || _die "sandbox image '$_IMAGE' not found — build it first (runner/sandbox/Dockerfile)"

# Container hardening. Drop ALL capabilities EXCEPT DAC_OVERRIDE: root inside the guest
# needs DAC_OVERRIDE to write the bind-mounted worktree + GAFFER_DATA, which on Linux are
# owned by the HOST uid (without it, cap-drop=ALL makes even root hit "permission denied"
# on the mount — macOS Docker Desktop masks this via file-sharing uid mapping). DAC_OVERRIDE
# only bypasses perms on files that EXIST in the guest (the worktree + GAFFER_DATA it is
# meant to write); host secrets aren't mounted, so read isolation is unaffected. Plus
# no-new-privileges + pid/mem/cpu caps. The containment test asserts CapEff is
# DAC_OVERRIDE-only + NoNewPrivs=1. (A non-root --user + --read-only root are the next
# hardening step — they need a tmpfs-backed writable HOME for claude/npm state and are
# validated with the live-delivery capstone; see docs/docker-sandbox-provider.md.)
exec docker run --rm --network "$_NET_INT" \
  --cap-drop=ALL \
  --cap-add=DAC_OVERRIDE \
  --security-opt=no-new-privileges \
  --pids-limit "${GAFFER_SANDBOX_PIDS:-512}" \
  --memory "${GAFFER_SANDBOX_MEMORY:-4g}" \
  --cpus "${GAFFER_SANDBOX_CPUS:-4}" \
  -w "$(pwd)" \
  "${_mounts[@]}" \
  "${_envs[@]}" \
  "$_IMAGE" \
  "$@"
