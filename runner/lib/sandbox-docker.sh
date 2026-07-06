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
#     the write-roots (rw), the read-roots (ro), and $GAFFER_DATA (rw, the MCP db copies
#     + runtime). Host $HOME, ~/.ssh, ~/.aws, sibling repos, the canonical DBs — none are
#     present, so `read host secret` has nothing to read. Mounts are PATH-MIRRORED
#     (host path == container path) so the absolute paths in the command and the rendered
#     .mcp.json resolve identically inside — no path translation needed.
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

command -v docker >/dev/null 2>&1 || _die "docker not found"
docker info >/dev/null 2>&1 || _die "docker daemon unavailable"

# --- ensure the egress network + proxy are up (idempotent) ---
_ensure_egress() {
  docker network inspect "$_NET_UP"  >/dev/null 2>&1 || docker network create "$_NET_UP" >/dev/null
  docker network inspect "$_NET_INT" >/dev/null 2>&1 || docker network create --internal "$_NET_INT" >/dev/null
  if ! docker ps --filter "name=^${_PROXY_NAME}$" --filter status=running -q | grep -q .; then
    docker rm -f "$_PROXY_NAME" >/dev/null 2>&1 || true
    docker image inspect "$_PROXY_IMAGE" >/dev/null 2>&1 \
      || docker build -q -t "$_PROXY_IMAGE" "$_RUNNER_DIR/sandbox/egress-proxy" >/dev/null \
      || _die "could not build the egress proxy image"
    docker run -d --name "$_PROXY_NAME" --network "$_NET_UP" "$_PROXY_IMAGE" >/dev/null \
      || _die "could not start the egress proxy"
    docker network connect --alias egress-proxy "$_NET_INT" "$_PROXY_NAME" >/dev/null \
      || _die "could not attach the egress proxy to the internal network"
  fi
}
_ensure_egress

# --- assemble mount + env args ---
_mounts=()
while IFS= read -r root; do
  [ -n "$(printf '%s' "$root" | tr -d '[:space:]')" ] || continue
  [ -e "$root" ] || continue
  _mounts+=( -v "$root:$root:rw" )
done < "$_WRITE_ROOTS_FILE"
while IFS= read -r root; do
  [ -n "$(printf '%s' "$root" | tr -d '[:space:]')" ] || continue
  [ -e "$root" ] || continue
  _mounts+=( -v "$root:$root:ro" )
done < "$_READ_ROOTS_FILE"
# GAFFER_DATA holds the MCP db copies + agent runtime — rw, path-mirrored.
[ -n "${GAFFER_DATA:-}" ] && [ -d "$GAFFER_DATA" ] && _mounts+=( -v "$GAFFER_DATA:$GAFFER_DATA:rw" )
# The factory's own dir (dist bins, skills, safety hook) — ro, path-mirrored.
[ -d "$_RUNNER_DIR" ] && _mounts+=( -v "$_RUNNER_DIR:$_RUNNER_DIR:ro" )

# Forward ONLY the allowlisted env. The model credential (ONE of ANTHROPIC_API_KEY or
# CLAUDE_CODE_OAUTH_TOKEN — the latter is a subscription token from `claude setup-token`,
# the supported headless-Max path) plus the MCP data-plane vars. Nothing else.
_envs=()
for k in ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN GAFFER_DATA GAFFER_FACTORY \
         GAFFER_CLAIM_TOKEN DISPATCH_DB MEMORY_DB DISPATCH_MCP_BIN MEMORY_MCP_BIN; do
  [ -n "${!k:-}" ] && _envs+=( -e "$k" )
done
# Fallback: if the operator has placed a Claude credentials file, mount it read-only into
# the container's home so claude authenticates. The runner never reads its contents.
_cred="${GAFFER_SANDBOX_CLAUDE_CREDENTIALS:-}"
[ -n "$_cred" ] && [ -f "$_cred" ] && _mounts+=( -v "$_cred:/root/.claude/.credentials.json:ro" )
if [ -z "${ANTHROPIC_API_KEY:-}${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ ! -f "${_cred:-/nonexistent}" ]; then
  printf 'sandbox-docker: no model credential — set CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`), ANTHROPIC_API_KEY, or GAFFER_SANDBOX_CLAUDE_CREDENTIALS; claude will not authenticate inside the container\n' >&2
fi
# Route all egress through the allowlist proxy.
_envs+=( -e "HTTP_PROXY=http://egress-proxy:8888" -e "HTTPS_PROXY=http://egress-proxy:8888" )
_envs+=( -e "http_proxy=http://egress-proxy:8888" -e "https_proxy=http://egress-proxy:8888" )
# No proxy for loopback + the docker-internal proxy hostname itself.
_envs+=( -e "NO_PROXY=localhost,127.0.0.1,egress-proxy" -e "no_proxy=localhost,127.0.0.1,egress-proxy" )

docker image inspect "$_IMAGE" >/dev/null 2>&1 || _die "sandbox image '$_IMAGE' not found — build it first (runner/sandbox/Dockerfile)"

exec docker run --rm --network "$_NET_INT" \
  -w "$(pwd)" \
  "${_mounts[@]}" \
  "${_envs[@]}" \
  "$_IMAGE" \
  "$@"
