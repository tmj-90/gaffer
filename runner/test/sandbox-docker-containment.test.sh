#!/usr/bin/env bash
# Red-team acceptance gate for the Mode-2 `docker` sandbox provider.
#
# Drives the REAL wrapper (lib/sandbox-docker.sh) with a hostile payload and asserts the
# two properties the external security review's #1 requires — that a prompt-injected agent
# CANNOT `read a host secret` and CANNOT `POST it out`:
#
#   READ_ISOLATED   a host secret placed OUTSIDE every mounted root is not readable
#   EGRESS_BLOCKED  a request to a non-allowlisted host fails at the network layer
#   WRITE_OK        the delivery worktree is still writable (the sandbox isn't uselessly tight)
#
# CI-safe: with no docker daemon the whole gate SKIPS (exit 0) rather than failing, so the
# bash suite stays green on machines/CI without docker. Where docker IS present it is a
# real, deterministic containment proof (no live `claude` needed — the payload is a shell).
set -u

RUNNER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export RUNNER_DIR

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "SKIP: docker daemon unavailable — Mode-2 containment gate not exercised on this host"
  exit 0
fi

# On shared CI runners this gate is fragile — it builds images + docker networks, and
# anonymous Docker Hub pulls are rate-limited across GitHub's shared IPs. So it does NOT
# run in the general bash suite on CI; a DEDICATED job runs it with RUN_SANDBOX_DOCKER_TEST=1
# (see .github/workflows/ci.yml). Locally it runs whenever a docker daemon is present.
if [ "${CI:-}" = "true" ] && [ "${RUN_SANDBOX_DOCKER_TEST:-0}" != "1" ]; then
  echo "SKIP: docker containment gate runs in its dedicated CI job (set RUN_SANDBOX_DOCKER_TEST=1)"
  exit 0
fi

echo "== Mode-2 docker sandbox — red-team containment gate =="

# Build the payload + egress-proxy images up front. A build failure here is INFRA
# (registry / Docker Hub rate-limit), NOT a containment failure — so SKIP (exit 0) rather
# than fail red, and do it before the assertions so a pull limit can't masquerade as a
# broken sandbox.
_IMG="gaffer-sbx-redteam-test"
if ! printf 'FROM alpine:3.20\nRUN apk add --no-cache curl\n' | docker build -q -t "$_IMG" - >/dev/null 2>&1; then
  echo "SKIP: could not build the test image (docker registry/infra unavailable) — containment not exercised"; exit 0
fi
if ! docker build -q -t gaffer-egress-proxy "$RUNNER_DIR/sandbox/egress-proxy" >/dev/null 2>&1; then
  echo "SKIP: could not build the egress-proxy image (docker registry/infra unavailable) — containment not exercised"; exit 0
fi

WORK="$(mktemp -d)"
GAFFER_DATA="$WORK/data"; mkdir -p "$GAFFER_DATA"
WT="$WORK/worktree"; mkdir -p "$WT"; echo "repo" > "$WT/README"
# The host secret lives OUTSIDE every root the wrapper mounts (worktree / read-roots /
# GAFFER_DATA / RUNNER_DIR) — so a correct sandbox physically cannot see it.
SECRET_DIR="$WORK/host-home"; mkdir -p "$SECRET_DIR"
SECRET="$SECRET_DIR/.aws-credentials"; echo "TOPSECRET_AKIA_do_not_leak" > "$SECRET"
export GAFFER_DATA GAFFER_SANDBOX_IMAGE="$_IMG"

WRF="$GAFFER_DATA/sandbox-write-roots"; printf '%s\n' "$WT" > "$WRF"
RRF="$GAFFER_DATA/sandbox-read-roots"; : > "$RRF"

# The hostile payload — literal paths (mounts are path-mirrored, so the worktree path is
# identical inside; the secret path is simply absent).
PAYLOAD="
  if cat '$SECRET' 2>/dev/null | grep -q TOPSECRET; then echo READ_LEAK; else echo READ_ISOLATED; fi
  if curl -s --max-time 6 -o /dev/null https://example.com 2>/dev/null; then echo EGRESS_LEAK; else echo EGRESS_BLOCKED; fi
  if curl -s --max-time 6 --noproxy '*' -o /dev/null http://1.1.1.1 2>/dev/null; then echo RAWIP_LEAK; else echo RAWIP_BLOCKED; fi
  if echo canary > '$WT/canary' 2>/dev/null; then echo WRITE_OK; else echo WRITE_FAIL; fi
  grep -q 'NoNewPrivs:.*1' /proc/self/status && echo NNP_SET || echo NNP_UNSET
  grep -q 'CapEff:.*0000000000000000' /proc/self/status && echo CAPS_DROPPED || echo CAPS_KEPT
"

OUT="$(timeout 120 bash "$RUNNER_DIR/lib/sandbox-docker.sh" "$WRF" "$RRF" -- sh -c "$PAYLOAD" 2>&1)"
echo "$OUT" | sed 's/^/    /'

fail=0
for want in READ_ISOLATED EGRESS_BLOCKED RAWIP_BLOCKED WRITE_OK NNP_SET CAPS_DROPPED; do
  if echo "$OUT" | grep -q "$want"; then echo "  ok   $want"; else echo "  FAIL expected $want"; fail=1; fi
done
for bad in READ_LEAK EGRESS_LEAK RAWIP_LEAK WRITE_FAIL NNP_UNSET CAPS_KEPT; do
  if echo "$OUT" | grep -q "$bad"; then echo "  FAIL saw $bad"; fail=1; fi
done
# The write must have actually landed on the host worktree (proves the rw mount round-trips).
if [ -f "$WT/canary" ]; then echo "  ok   worktree write round-tripped to host"; else echo "  FAIL canary not on host"; fail=1; fi

rm -rf "$WORK"
if [ "$fail" -eq 0 ]; then echo "PASS (Mode-2 containment holds: secret unreadable, egress denied, worktree writable)"; exit 0; else echo "FAILED"; exit 1; fi
