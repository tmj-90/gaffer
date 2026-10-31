#!/usr/bin/env bash
# =====================================================================
# DOCKER PERSISTENCE (external review #10) — under the shipped Compose defaults a
# repository the factory BOOTSTRAPS must land on a persistent mount.
# ---------------------------------------------------------------------
# The runner's default GAFFER_BOOTSTRAP_ROOT is $HOME/git; in the image HOME is
# /home/node, which is not a volume. Recreating the container lost a new repo while its
# registration (in the gaffer-data volume) survived. Compose and the image now set
# GAFFER_BOOTSTRAP_ROOT=/repos, the bind mount the operator's repos already live on.
#   S1-S3  static: compose.yaml's dashboard resolves GAFFER_BOOTSTRAP_ROOT to /repos, the
#          Dockerfile sets the same, and /repos is one of the dashboard's mounts
#   S4     the runner honours it: greenfield's target path is under the root it is given
#   D1     with a docker daemon: a repo created under GAFFER_BOOTSTRAP_ROOT in one
#          container is still there in a FRESH container on the same mounts
#          (SKIPPED with the reason when no daemon is reachable)
# Run: bash test/docker-persistence.test.sh   (bash 3.2 safe)
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

COMPOSE="$ROOT/compose.yaml"; DOCKERFILE="$ROOT/Dockerfile"
echo "== static: the bootstrap root is a mounted path =="
CROOT="$(sed -n 's/^ *GAFFER_BOOTSTRAP_ROOT: *//p' "$COMPOSE" | head -1)"
CROOT_DEFAULT="$(printf '%s' "$CROOT" | sed -n 's/^\${GAFFER_BOOTSTRAP_ROOT:-\(.*\)}$/\1/p')"
[ "$CROOT_DEFAULT" = "/repos" ] && ok "S1: compose.yaml sets GAFFER_BOOTSTRAP_ROOT (default /repos) for the dashboard" || fail "S1: compose GAFFER_BOOTSTRAP_ROOT is '$CROOT'"
grep -qE '^ *GAFFER_BOOTSTRAP_ROOT=/repos' "$DOCKERFILE" && ok "S2: the image sets GAFFER_BOOTSTRAP_ROOT=/repos (a plain docker run persists too)" || fail "S2: Dockerfile lacks GAFFER_BOOTSTRAP_ROOT=/repos"
grep -qE '^ *- *"?\$\{GAFFER_REPOS:-\./repos\}:/repos"?' "$COMPOSE" && ok "S3: /repos is a bind mount of the dashboard (host ./repos)" || fail "S3: /repos is not mounted in compose.yaml"

echo "== the runner creates bootstrap repos under the root it is given =="
# shellcheck source=../lib/greenfield.sh
source "$RUNNER_DIR/lib/greenfield.sh"
T="$(GAFFER_BOOTSTRAP_ROOT=/repos gaffer_bootstrap_repo_dir "newapp" 2>/dev/null || true)"
case "$T" in /repos/*) ok "S4: a bootstrap target resolves under /repos ($T)" ;; *) fail "S4: bootstrap target '$T' is not under /repos" ;; esac

echo "== D1: a recreated container keeps the bootstrapped repo =="
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "  SKIP D1: no docker daemon reachable on this host — the recreate test needs one (the static checks above still hold)"
else
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/docker-persist.XXXXXX")"
  gaffer_test_check_tmp "$WORK" || exit 70
  trap 'gaffer_test_rm_work "$WORK"' EXIT
  IMG="alpine:3.20"
  if ! docker pull -q "$IMG" >/dev/null 2>&1; then
    echo "  SKIP D1: could not pull $IMG (registry unavailable)"
  else
    docker run --rm -e GAFFER_BOOTSTRAP_ROOT=/repos -v "$WORK:/repos" "$IMG" sh -c 'mkdir -p "$GAFFER_BOOTSTRAP_ROOT/newapp" && echo seed > "$GAFFER_BOOTSTRAP_ROOT/newapp/README"' >/dev/null 2>&1
    if docker run --rm -v "$WORK:/repos" "$IMG" sh -c 'test -f /repos/newapp/README' >/dev/null 2>&1; then
      ok "D1: a fresh container on the same mounts still has the bootstrapped repo"
    else
      fail "D1: the bootstrapped repo did not survive the container"
    fi
  fi
fi

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "docker-persistence: ALL $PASS checks passed"; exit 0
else echo "docker-persistence: ${#FAILURES[@]} FAILED (of $((PASS + ${#FAILURES[@]})))"; exit 1; fi
