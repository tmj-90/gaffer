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
  [ -n "$(docker ps --filter "name=^${_PROXY_NAME}$" --filter status=running -q)" ] && running=1
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
# --- repo-controlled paths never choose a mount (external review #6) ---------------------
# Everything under a write root is writable by the repository (its committed tree) and by
# whatever runs inside the container (tests, the agent), so no path read from there may
# decide WHAT host directory gets bind-mounted. Two such inputs feed the mounts below —
# the worktree's `.git` file (which names the git metadata to mount) and the node_modules
# symlinks (which name dependency trees to mount) — and both are checked against what
# the RUNNER created, failing closed with a WARNING that names the path:
#   • the `.git` file is honoured only when git's own registration agrees both ways: the
#     private dir it names is <common>/worktrees/<name>, and that dir's `gitdir` file
#     points back at THIS write root. A forged `.git` naming another repo is refused.
#   • a node_modules symlink is mounted only when it resolves EXACTLY to the verified
#     primary checkout's own node_modules at the same relative path — the one shape
#     gaffer_link_node_modules (lib/agent-env.sh) creates. A link to $HOME, /etc, another
#     repo, through a chain or a `..` escape, or a primary-side node_modules that is itself
#     a symlink, is never mounted.
_readlink_f() { readlink -f "$1" 2>/dev/null || node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]) + "\n")' "$1" 2>/dev/null; }
_warn() { printf 'sandbox-docker: WARNING — %s\n' "$1" >&2; }
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
# _verified_linked_worktree <write-root>: when <write-root> is a linked worktree whose
# registration checks out, set _VW_COMMON / _VW_GITDIR (canonical) and return 0; else 1.
_VW_COMMON=""; _VW_GITDIR=""
_verified_linked_worktree() {
  local wr="$1" back wrc
  _VW_COMMON=""; _VW_GITDIR=""
  # A `.git` SYMLINK (to a real, registered worktree's `.git` file — another repo's, or a
  # sibling delivery's) would make the two-way check below agree with ITSELF: git follows
  # the link and the registration points back at the link's target. git never creates one.
  [ -L "$wr/.git" ] && return 1
  [ -f "$wr/.git" ] || return 1
  wrc="$(_readlink_f "$wr")"
  [ -n "$wrc" ] || return 1
  command -v git >/dev/null 2>&1 || return 1
  _VW_COMMON="$(_git_path "$wr" --git-common-dir)"
  _VW_GITDIR="$(_git_path "$wr" --git-dir)"
  if [ -z "$_VW_COMMON" ] || [ ! -d "$_VW_COMMON" ] || [ -z "$_VW_GITDIR" ] || [ ! -d "$_VW_GITDIR" ] \
     || [ "$(dirname "$_VW_GITDIR")" != "$_VW_COMMON/worktrees" ]; then
    _VW_COMMON=""; _VW_GITDIR=""; return 1
  fi
  back="$(head -n 1 "$_VW_GITDIR/gitdir" 2>/dev/null || true)"
  case "$back" in "") _VW_COMMON=""; _VW_GITDIR=""; return 1 ;; /*) ;; *) back="$_VW_GITDIR/$back" ;; esac
  if [ "$(_readlink_f "$back")" != "$wrc/.git" ]; then
    _VW_COMMON=""; _VW_GITDIR=""; return 1
  fi
  return 0
}
# _primary_checkout <write-root>: the canonical primary checkout a VERIFIED linked
# worktree belongs to (the common dir's parent when it is `<checkout>/.git`), or nothing.
_primary_checkout() {
  _verified_linked_worktree "$1" || return 0
  [ "$(basename "$_VW_COMMON")" = ".git" ] || return 0
  dirname "$_VW_COMMON"
}

# _warn_skills_links: a write root's `.claude/skills` link is never followed. The runner
# installs skills as REAL COPIES inside the worktree (lib/skills-mount.sh,
# lib/agent-home.mjs), which the write root's own mount already carries, and replaces an
# older runner's link before the agent starts; it creates no `.claude/skills` link. Such
# a link lives in the writable worktree (the repository or the agent made it), so its
# target is never mounted and, in the legacy layout, never unmasked — not even one that
# names $GAFFER_DATA/skills-mounts/<key>, which now holds only the host-side telemetry
# manifest. It is named in a WARNING instead.
_warn_skills_links() {
  local wr
  for wr in ${_WRITE_ROOTS[@]+"${_WRITE_ROOTS[@]}"}; do
    [ -L "$wr/.claude/skills" ] || continue
    _warn "not mounting or unmasking the target of the symlink $wr/.claude/skills: skills are installed as copies inside the worktree, and a .claude/skills link is never followed"
  done
  return 0
}

# Each write root's node_modules are SYMLINKS into the real checkout (tick.sh links
# them in because installs are hook-blocked in a worktree). Mounts are path-mirrored,
# so the link resolves inside the container ONLY if its target is mounted too — bind
# each AUTHORISED target ro (dedup'd, skipped when an existing mount already covers it).
# Depth 4 mirrors tick.sh's workspace-package sweep (`find -maxdepth 3 -name node_modules`).
for _wr in ${_WRITE_ROOTS[@]+"${_WRITE_ROOTS[@]}"}; do
  _prim="$(_primary_checkout "$_wr")"
  while IFS= read -r -d '' _lnk; do
    [ -n "$_lnk" ] || continue
    # A `:` splits docker's -v spec and a newline cannot survive the argv/printf round
    # trip: such a path is never runner-created, so skip it (WARNED) rather than let
    # docker reject the whole run or mis-split the mount.
    case "$_lnk" in *:* | *$'\n'*)
      _warn "not mounting anything for the symlink $_lnk: its path contains ':' or a newline"
      continue ;;
    esac
    _tgt="$(_readlink_f "$_lnk")"
    [ -n "$_tgt" ] && [ -d "$_tgt" ] || continue      # dangling: nothing to mount
    _covered "$_tgt" && continue                       # already inside a chosen mount: no new host path
    _rel="${_lnk#"$_wr"/}"
    if [ -z "$_prim" ]; then
      _warn "not mounting $_tgt for the symlink $_lnk: $_wr is not a verified linked worktree of a primary checkout, so no dependency link in it is runner-created"
      continue
    fi
    if [ "$_tgt" != "$_prim/$_rel" ]; then
      _warn "not mounting $_tgt for the symlink $_lnk: only $_prim/$_rel (the primary checkout's own dependencies, linked by the runner) may be mounted there"
      continue
    fi
    # Mount the resolved host directory AT THE PATH THE LINK NAMES. Inside the
    # container the symlink is followed literally, so a mount at the canonical path
    # alone dangles wherever the two differ — on macOS every temp/worktree path under
    # /var is really /private/var, which left the DoD gate without node_modules. An
    # absolute link gets the mount at its own path; a relative link resolves inside
    # the (already mounted) root or falls back to the canonical target.
    _raw="$(readlink "$_lnk" 2>/dev/null || true)"
    case "$_raw" in /*) _at="$_raw" ;; *) _at="$_tgt" ;; esac
    case "$_at" in *:* | *$'\n'*)
      _warn "not mounting $_tgt for the symlink $_lnk: the path it names contains ':' or a newline"
      continue ;;
    esac
    _covered "$_at" && continue
    _add_mount_at "$_tgt" "$_at" ro
  done < <(find "$_wr" -maxdepth 4 -name node_modules -type l -print0 2>/dev/null)
done

# --- the delivery worktree's git metadata: a PRIVATE repository (B25c; external review #9) --
# A delivery worktree is a LINKED worktree: its `.git` is a FILE ("gitdir: …") naming the
# repo's `.git/worktrees/<name>`, and the objects/refs live in the repo's `.git` (the
# common dir). Git must work inside (status, commit), but NOTHING under the host's `.git`
# may be writable from the container: with `.git/refs` mounted rw, any command inside (a
# test, a build script, the agent) could `git update-ref refs/heads/main …` and move the
# operator's branch before a reviewer saw anything (external review #9, finding 1).
#
# So the container gets its OWN repository. For each verified linked worktree the wrapper
# builds a private git dir on the host (outside every write root) and mounts it AT the
# path the worktree's `.git` file names:
#   • HEAD       the worktree's own HEAD (its ticket branch, or a detached sha);
#   • refs       a SNAPSHOT of the host's refs (packed-refs), so `git log main..` and
#                `git diff main...` work, but every write lands in the private copy;
#   • objects    empty and writable; the host's object store is reached READ-ONLY
#                through objects/info/alternates (the host `$common/objects` mount is ro);
#   • index      a copy of the worktree's index; config a minimal one the wrapper writes
#                (identity + object format only: no hooks, no filters, no fsmonitor);
#   • no `commondir` file, so git treats it as a standalone repository.
# The host's `.git` config, hooks, HEAD, refs, logs, packed-refs and every other
# worktree's private dir are not mounted at all. When the container exits (agent runs
# only, never the validation profile, whose commits are discarded), the TRUSTED runner
# imports exactly one ref: the worktree's own branch tip, fetched from the private repo
# into the host repo (hooks off, the private config rewritten first) and moved with a
# compare-and-swap `update-ref`. Every other ref the container wrote (main, tags, other
# branches) is dropped with the private dir. The landing of that branch onto the
# target stays where it was: on the host, after approval.
# The `.git` FILE lives in the writable worktree, so it is honoured only when git's
# registration confirms it (_verified_linked_worktree above); otherwise nothing is
# mounted for it and git simply does not work inside (fail closed, WARNED).
# A write root that is itself a full repo (`.git` is a directory) is a scratch checkout
# the runner made for that call (clarify/review/eval cwd), not the operator's repo; it is
# already inside its rw mount.
_HOSTGIT=( git -c core.hooksPath=/dev/null -c core.fsmonitor=false )
_SHADOWS=()        # "<write-root>\t<private-git-dir>\t<ref>\t<old-sha>\t<common>" per linked worktree
_shadow_config() {  # <host-worktree> <private-git-dir>: the ONLY config the private repo has
  local wt="$1" sd="$2" k v fmt
  fmt="$("${_HOSTGIT[@]}" -C "$wt" rev-parse --show-object-format 2>/dev/null || echo sha1)"
  {
    if [ "$fmt" = "sha1" ]; then
      printf '[core]\n\trepositoryformatversion = 0\n'
    else
      printf '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tobjectformat = %s\n[core]\n' "$fmt"
    fi
    printf '\tbare = false\n\tlogallrefupdates = true\n\thooksPath = /dev/null\n\tfsmonitor = false\n'
    for k in user.name user.email core.autocrlf core.filemode core.ignorecase core.precomposeunicode; do
      v="$("${_HOSTGIT[@]}" -C "$wt" config --get "$k" 2>/dev/null)" || continue
      case "$v" in *$'\n'* | *'"'* | *'\'*) continue ;; esac
      printf '[%s]\n\t%s = "%s"\n' "${k%%.*}" "${k#*.}" "$v"
    done
  } > "$sd/config.gaffer-new"
  # Replace, never write through: unlinking first breaks a hard link the container may
  # have left (a symlink or other special file is refused before this runs on import).
  mv -f "$sd/config.gaffer-new" "$sd/config"
  mkdir -p "$sd/objects/info" "$sd/refs/heads" "$sd/refs/tags" "$sd/info"
  rm -rf "$sd/hooks" "$sd/commondir" "$sd/worktrees" "$sd/gitdir" 2>/dev/null || true
  rm -f "$sd/objects/info/alternates" "$sd/objects/info/http-alternates" 2>/dev/null || true
  printf '%s\n' "$_common/objects" > "$sd/objects/info/alternates"
}
_GIT_PRIV_BASE="${GAFFER_DATA:-${TMPDIR:-/tmp}}"
mkdir -p "$_GIT_PRIV_BASE" 2>/dev/null || true
for _wr in ${_WRITE_ROOTS[@]+"${_WRITE_ROOTS[@]}"}; do
  [ -f "$_wr/.git" ] || continue          # only LINKED worktrees have a .git FILE
  if ! _verified_linked_worktree "$_wr"; then
    _warn "not mounting any git metadata for $_wr: its .git file does not match a worktree registered in the repository it names (a forged or stale .git is never mounted)"
    continue
  fi
  _common="$_VW_COMMON"; _gitdir="$_VW_GITDIR"
  _under_write_root "$_common" && continue   # the repo itself is a write root: covered rw
  case "$_gitdir" in *:* | *$'\n'*)
    _warn "not mounting any git metadata for $_wr: its git dir path contains ':' or a newline"
    continue ;;
  esac
  _sd="$(mktemp -d "$_GIT_PRIV_BASE/sandbox-git.$$.XXXXXX" 2>/dev/null)" \
    || _die "could not create the private git directory for $_wr under $_GIT_PRIV_BASE"
  _shadow_config "$_wr" "$_sd"
  # HEAD: the worktree's branch (symbolic) or its detached commit.
  _ref="$("${_HOSTGIT[@]}" -C "$_wr" symbolic-ref -q HEAD 2>/dev/null || true)"
  _old="$("${_HOSTGIT[@]}" -C "$_wr" rev-parse -q --verify 'HEAD^{commit}' 2>/dev/null || true)"
  if [ -n "$_ref" ]; then printf 'ref: %s\n' "$_ref" > "$_sd/HEAD"
  elif [ -n "$_old" ]; then printf '%s\n' "$_old" > "$_sd/HEAD"; _ref=HEAD
  else _die "could not read HEAD of $_wr"
  fi
  # A snapshot of the host's shared refs (branches, tags, remotes): read-only context.
  "${_HOSTGIT[@]}" -C "$_wr" for-each-ref --format='%(objectname) %(refname)' \
      refs/heads refs/tags refs/remotes > "$_sd/packed-refs" 2>/dev/null || : > "$_sd/packed-refs"
  [ -f "$_gitdir/index" ] && cp "$_gitdir/index" "$_sd/index" 2>/dev/null || true
  # A shallow host repo (a CI clone) needs its shallow boundary, or history walks fail.
  [ -f "$_common/shallow" ] && cp "$_common/shallow" "$_sd/shallow" 2>/dev/null || true
  for _f in exclude attributes; do
    [ -f "$_common/info/$_f" ] && cp "$_common/info/$_f" "$_sd/info/$_f" 2>/dev/null || true
  done
  [ -d "$_common/objects" ] && ! _covered "$_common/objects" && _add_mount "$_common/objects" ro
  _add_mount_at "$_sd" "$_gitdir" rw
  _SHADOWS+=( "$_wr"$'\t'"$_sd"$'\t'"$_ref"$'\t'"$_old"$'\t'"$_common"$'\t'"$_gitdir" )
done

# _import_private_git: after the container exits, bring each worktree's OWN ref back from
# its private repository into the host repo (agent runs only). The private dir was
# writable from the container, so its config/hooks/alternates are rewritten by the host
# before any host git command reads it, the fetch runs with hooks off, the fetched tip
# must be a commit, and the host ref moves only from the value it had when the container
# started (compare-and-swap). Returns non-zero (and says why) when an import fails.
_import_private_git() {
  local row wr sd ref old gd tip tmpref rc=0
  for row in ${_SHADOWS[@]+"${_SHADOWS[@]}"}; do
    IFS=$'\t' read -r wr sd ref old _common gd <<<"$row"
    # The worktree's `.git` FILE is in the writable worktree: the container could point it
    # at another repository. Re-check the two-way registration, and run every host git
    # command below against the git dir recorded at start, never the pointer.
    if ! _verified_linked_worktree "$wr" || [ "$_VW_GITDIR" != "$gd" ] || [ "$_VW_COMMON" != "$_common" ]; then
      printf 'sandbox-docker: import: the .git file of %s no longer names its registered git dir %s; nothing imported\n' "$wr" "$gd" >&2
      rc=1; continue
    fi
    # The container could write anything here. A symlink (or a FIFO, socket, device) in
    # the private dir would make the host's rewrite below, or the git commands reading
    # it, follow a path the container chose to a host file; git never creates such
    # entries in a git dir, so their presence refuses the import.
    if [ -L "$sd" ] || [ ! -d "$sd" ] || [ -n "$(find "$sd" ! -type f ! -type d -print 2>/dev/null | head -n 1)" ]; then
      printf 'sandbox-docker: import: the private repository for %s holds a symlink or special file (%s); nothing imported\n' \
        "$wr" "$(find "$sd" ! -type f ! -type d -print 2>/dev/null | head -n 1)" >&2
      rc=1; continue
    fi
    _shadow_config "$wr" "$sd"
    tip="$(GIT_DIR="$sd" "${_HOSTGIT[@]}" rev-parse -q --verify "$ref^{commit}" 2>/dev/null || true)"
    [ -n "$tip" ] || { printf 'sandbox-docker: import: the private repository for %s has no commit at %s; nothing imported\n' "$wr" "$ref" >&2; continue; }
    [ "$tip" = "$old" ] && continue
    tmpref="refs/gaffer-sandbox/import-$$"
    if ! "${_HOSTGIT[@]}" --git-dir="$gd" --work-tree="$wr" fetch -q --no-tags --no-write-fetch-head --no-recurse-submodules \
         "$sd" "+$ref:$tmpref" >/dev/null 2>&1; then
      printf 'sandbox-docker: import: could not fetch %s from the private repository of %s\n' "$ref" "$wr" >&2
      rc=1; continue
    fi
    if [ "$("${_HOSTGIT[@]}" --git-dir="$gd" --work-tree="$wr" rev-parse -q --verify "$tmpref^{commit}" 2>/dev/null)" != "$tip" ]; then
      printf 'sandbox-docker: import: fetched tip for %s does not match the private repository (%s)\n' "$wr" "$tip" >&2
      "${_HOSTGIT[@]}" --git-dir="$gd" --work-tree="$wr" update-ref -d "$tmpref" >/dev/null 2>&1 || true
      rc=1; continue
    fi
    if [ "$ref" = "HEAD" ]; then
      "${_HOSTGIT[@]}" --git-dir="$gd" --work-tree="$wr" update-ref --no-deref -m "gaffer: import sandbox commits" HEAD "$tip" "$old" >/dev/null 2>&1
    else
      "${_HOSTGIT[@]}" --git-dir="$gd" --work-tree="$wr" update-ref -m "gaffer: import sandbox commits" "$ref" "$tip" "$old" >/dev/null 2>&1
    fi || { printf 'sandbox-docker: import: %s moved on the host while the container ran; not importing %s\n' "$ref" "$tip" >&2; rc=1; }
    "${_HOSTGIT[@]}" --git-dir="$gd" --work-tree="$wr" update-ref -d "$tmpref" >/dev/null 2>&1 || true
    # The host index still describes the old tip; reset it to the imported commit (the
    # working tree is the shared mount and already matches).
    "${_HOSTGIT[@]}" --git-dir="$gd" --work-tree="$wr" read-tree HEAD >/dev/null 2>&1 || true
  done
  return "$rc"
}
_cleanup_private_git() {
  local row wr sd rest
  for row in ${_SHADOWS[@]+"${_SHADOWS[@]}"}; do
    IFS=$'\t' read -r wr sd rest <<<"$row"
    case "$sd" in "$_GIT_PRIV_BASE"/sandbox-git.*) rm -rf "$sd" 2>/dev/null || true ;; esac
  done
}

# --- $GAFFER_DATA: the MCP data plane's DB directory, everything else MASKED (B25c) ------
# See the header. The directory must be mounted (SQLite siblings), so mount it rw and
# mask every top-level entry that is not on the allowlist below. The masks are ordinary
# mounts nested inside the GAFFER_DATA mount; docker applies mounts parent-first, so a
# write root that lives UNDER a masked dir (the default `$GAFFER_DATA/worktrees/ticket-N`
# layout) is bind-mounted back on top of the tmpfs that hides its siblings.
# ── DATA-PLANE MODE ──────────────────────────────────────────────────────────────
#   validation  GAFFER_SANDBOX_PROFILE=validation (the DoD gates / AC checks): NOTHING
#               from $GAFFER_DATA and NO model credential — a gate needs neither.
#   bridge      GAFFER_MCP_BRIDGE_SOCKET set: MCP servers on the host, only the socket.
#   none        no --mcp-config in the argv, or GAFFER_SANDBOX_DATA_PLANE=none (an
#               empty MCP config): no databases; the hook's ledgers only.
#   legacy      --mcp-config present, no socket, GAFFER_MCP_BRIDGE OFF: the DB dir
#               mounted rw + masked, servers inside (WARNED).
#   refused     --mcp-config present, no socket, bridge ON: the caller wanted the data
#               plane but the host-side bridge is not up — never fall back to mounting
#               the databases silently (fail closed).
_bridge_wanted() {
  case "${GAFFER_MCP_BRIDGE:-auto}" in
    1 | true | yes | on) return 0 ;;
    0 | false | no | off) return 1 ;;
    *) [ "$(uname -s 2>/dev/null)" != "Darwin" ] ;;
  esac
}
_HAS_MCP=0; _prev=""
for _a in "$@"; do [ "$_prev" = "--mcp-config" ] && _HAS_MCP=1; _prev="$_a"; done
if [ "${GAFFER_SANDBOX_PROFILE:-}" = "validation" ]; then _MODE=validation
elif [ -n "${GAFFER_MCP_BRIDGE_SOCKET:-}" ]; then _MODE=bridge
elif [ "${GAFFER_SANDBOX_DATA_PLANE:-}" = "none" ] || [ "$_HAS_MCP" = 0 ]; then _MODE=none
elif _bridge_wanted; then
  _die "the command carries an MCP config but GAFFER_MCP_BRIDGE_SOCKET is unset — the host-side MCP bridge is not up (GAFFER_MCP_BRIDGE=${GAFFER_MCP_BRIDGE:-auto}); refusing to run with the databases mounted (set GAFFER_MCP_BRIDGE=0 to accept the legacy layout)"
else _MODE=legacy
fi
_BRIDGED=0
if [ "$_MODE" = "validation" ]; then
  : # nothing from $GAFFER_DATA is mounted; the write roots (the worktree) carry the tests
elif [ "$_MODE" = "bridge" ] || [ "$_MODE" = "none" ]; then
  # ── BRIDGE MODE (lib/mcp-bridge.mjs; external review, finding 2) ─────────────
  # The MCP data plane runs on the HOST. NOTHING under $GAFFER_DATA is mounted except:
  #   • the bridge's unix socket (rw) — the container's only path to dispatch/memory;
  #   • THIS call's bridged --mcp-config (ro; token-free: every server is `connect`);
  #   • the safety hook's two append-only ledgers (rw) — telemetry, not decision state;
  #   • the crew events log the hook appends to (rw), if it lives there;
  # No database, usage ledger, settings.json, dashboard token or other worker's claim
  # token exists in the container's filesystem, and the write root (the worktree under
  # $GAFFER_DATA/worktrees/) is mounted on its own above.
  if [ "$_MODE" = "bridge" ]; then
    [ -e "$GAFFER_MCP_BRIDGE_SOCKET" ] || _die "GAFFER_MCP_BRIDGE_SOCKET=$GAFFER_MCP_BRIDGE_SOCKET does not exist — the host-side MCP bridge is not up"
    _add_mount "$GAFFER_MCP_BRIDGE_SOCKET" rw
  fi
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
    _warn_skills_links
  fi
  _BRIDGED=1
elif [ "$_MODE" = "legacy" ] && [ -n "${GAFFER_DATA:-}" ] && [ -d "$GAFFER_DATA" ] && ! _covered "$GAFFER_DATA"; then
  # ── LEGACY MODE: the MCP servers run INSIDE the container ──────────────────────
  # Only when the bridge is OFF (GAFFER_MCP_BRIDGE=0, or macOS Docker Desktop, which
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
  _warn_skills_links
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
# The validation profile forwards NO model credential (a test suite never needs one)
# and no data-plane vars; only the legacy layout forwards the DB paths + server bins.
case "$_MODE" in
  # GAFFER_REPLAY_PROOF_KEY: the tester replay's node:test reporter signs its events with
  # it (lib/tester-replay.mjs); it is set only for a replay run and deleted from the
  # runner's environment before any test file starts.
  validation) _fwd=( GAFFER_FACTORY GAFFER_REPLAY_PROOF_KEY ) ;;
  legacy)     _fwd=( ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN GAFFER_DATA GAFFER_FACTORY DISPATCH_DB MEMORY_DB DISPATCH_MCP_BIN MEMORY_MCP_BIN ) ;;
  *)          _fwd=( ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN GAFFER_DATA GAFFER_FACTORY ) ;;
esac
for k in "${_fwd[@]}"; do
  [ -n "${!k:-}" ] && _envs+=( -e "$k" )
done
# Fallback: if the operator has placed a Claude credentials file, mount it read-only into
# the container's home so claude authenticates. The runner never reads its contents.
# Never under the validation profile.
_cred="${GAFFER_SANDBOX_CLAUDE_CREDENTIALS:-}"
[ "$_MODE" = "validation" ] && _cred=""
[ -n "$_cred" ] && [ -f "$_cred" ] && _mounts+=( -v "$_cred:/root/.claude/.credentials.json:ro" )
if [ "$_MODE" != "validation" ] && [ -z "${ANTHROPIC_API_KEY:-}${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ ! -f "${_cred:-/nonexistent}" ]; then
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
# Not `exec`: the wrapper outlives the container to import the worktree's own branch from
# its private repository (see the git-metadata section above). docker runs in the
# background so a TERM/INT/HUP sent to this wrapper (a tick timeout) is forwarded to it at
# once instead of waiting for the container to finish.
trap '_cleanup_private_git' EXIT
docker run --rm --network "$_NET_INT" \
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
  "$@" &
_DOCKER_PID=$!
_forward() { kill -"$1" "$_DOCKER_PID" 2>/dev/null || true; }
trap '_forward TERM' TERM; trap '_forward INT' INT; trap '_forward HUP' HUP
while :; do
  _rc=0; wait "$_DOCKER_PID" || _rc=$?
  kill -0 "$_DOCKER_PID" 2>/dev/null || break
done
trap - TERM INT HUP
# The validation profile (DoD gates, AC checks) never changes the branch it validates:
# whatever a test committed inside is dropped with the private repository.
if [ "$_MODE" != "validation" ] && ! _import_private_git; then
  printf 'sandbox-docker: the commits made inside the container could not all be imported into the host repository (see above)\n' >&2
  [ "$_rc" -ne 0 ] || _rc=1
fi
exit "$_rc"
