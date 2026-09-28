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
# and, since B25(c), that the $GAFFER_DATA mount is HONEST and git WORKS:
#   DATA_MASKED     settings.json / dashboard-token / another worker's mcp-runtime (claim
#                   token) / a sibling delivery worktree under $GAFFER_DATA are NOT readable,
#                   while this call's own mcp-runtime file and the SQLite DB stay usable
#   GIT_COMMIT_OK   the LINKED delivery worktree can `git status` + `git commit` inside
#                   (its repo's .git is mounted ro with only the commit path rw; the
#                   commit round-trips to the host), and .git/config stays read-only
#
# CI-safe: with no docker daemon the whole gate SKIPS (exit 0) rather than failing, so the
# bash suite stays green on machines/CI without docker. Where docker IS present it is a
# real, deterministic containment proof (no live `claude` needed — the payload is a shell).
set -u

RUNNER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export RUNNER_DIR

# GAFFER_SANDBOX_TEST_REQUIRE=1 turns every infra SKIP below into a FAILURE — the CI job on
# pushes to main sets it so "the gate did not run" can never read as green there.
_skip() {
  if [ "${GAFFER_SANDBOX_TEST_REQUIRE:-0}" = "1" ]; then
    echo "FAIL (required): $1"; echo "::error::docker containment gate did not run: $1"; exit 1
  fi
  echo "SKIP: $1"; exit 0
}

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  _skip "docker daemon unavailable — Mode-2 containment gate not exercised on this host"
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
if ! printf 'FROM alpine:3.20\nRUN apk add --no-cache curl git nodejs\n' | docker build -q -t "$_IMG" - >/dev/null 2>&1; then
  _skip "could not build the test image (docker registry/infra unavailable) — containment not exercised"
fi
if ! docker build -q -t gaffer-egress-proxy "$RUNNER_DIR/sandbox/egress-proxy" >/dev/null 2>&1; then
  _skip "could not build the egress-proxy image (docker registry/infra unavailable) — containment not exercised"
fi

WORK="$(mktemp -d)"
WORK="$(cd "$WORK" && pwd -P)"
GAFFER_DATA="$WORK/data"; mkdir -p "$GAFFER_DATA/worktrees"
# B25(c): the delivery worktree is a REAL linked worktree of a real repo, laid out the
# way tick.sh lays it out ($GAFFER_DATA/worktrees/ticket-N) — so the git-metadata mounts
# and the GAFFER_DATA masking are exercised exactly as a live delivery exercises them.
REPO="$WORK/repo"; mkdir -p "$REPO"
git -C "$REPO" init -q -b main
git -C "$REPO" config user.email t@e; git -C "$REPO" config user.name t
echo "repo" > "$REPO/README"; git -C "$REPO" add -A; git -C "$REPO" commit -qm seed
WT="$GAFFER_DATA/worktrees/ticket-1"
git -C "$REPO" worktree add -q -b gaffer/ticket-1 "$WT" main
GIT_COMMON="$(cd "$REPO/.git" && pwd -P)"
# What must NOT be visible inside: the dashboard's secrets, another worker's claim
# token and a sibling delivery's worktree — all of them live in $GAFFER_DATA.
printf '{"GAFFER_MODE":"autonomous","note":"TOPSECRET_SETTINGS"}\n' > "$GAFFER_DATA/settings.json"
printf 'TOPSECRET_DASHBOARD_TOKEN\n' > "$GAFFER_DATA/dashboard-token"
printf '{"claim":"TOPSECRET_OTHER_CLAIM"}\n' > "$GAFFER_DATA/mcp-runtime.other.json"
printf '{"claim":"SELF_CLAIM_OK"}\n' > "$GAFFER_DATA/mcp-runtime.self.json"
SIB="$GAFFER_DATA/worktrees/ticket-2"; mkdir -p "$SIB"; echo "TOPSECRET_SIBLING" > "$SIB/secret"
: > "$GAFFER_DATA/dispatch.sqlite"; : > "$GAFFER_DATA/memory.sqlite"
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
  # CapEff = 0000000000000002 = only CAP_DAC_OVERRIDE (kept so root can write the mounted
  # worktree on Linux); every other capability dropped by --cap-drop=ALL.
  grep -q 'CapEff:.*0000000000000002' /proc/self/status && echo CAPS_DROPPED || echo CAPS_KEPT
  # B25(c): \$GAFFER_DATA is mounted for the SQLite DBs — everything else in it is masked.
  if cat '$GAFFER_DATA/settings.json' '$GAFFER_DATA/dashboard-token' '$GAFFER_DATA/mcp-runtime.other.json' '$SIB/secret' 2>/dev/null | grep -q TOPSECRET; then echo DATA_LEAK; else echo DATA_MASKED; fi
  if grep -q SELF_CLAIM_OK '$GAFFER_DATA/mcp-runtime.self.json' 2>/dev/null; then echo OWN_MCP_OK; else echo OWN_MCP_MISSING; fi
  if echo x >> '$GAFFER_DATA/dispatch.sqlite' 2>/dev/null; then echo DB_RW_OK; else echo DB_RW_FAIL; fi
  # B25(c): the linked worktree's git metadata is mounted — status + commit work inside.
  if git -C '$WT' status >/dev/null 2>&1; then echo GIT_STATUS_OK; else echo GIT_STATUS_FAIL; fi
  if git -C '$WT' add canary >/dev/null 2>&1 && git -C '$WT' -c user.email=s@x -c user.name=s commit -qm sandbox-commit >/dev/null 2>&1; then echo GIT_COMMIT_OK; else echo GIT_COMMIT_FAIL; fi
  if echo x >> '$GIT_COMMON/config' 2>/dev/null; then echo GITCONFIG_WRITABLE; else echo GITCONFIG_RO; fi
"

# The wrapped argv names THIS call's --mcp-config so the wrapper keeps that one file
# visible (sh ignores the extra positional args).
OUT="$(timeout 120 bash "$RUNNER_DIR/lib/sandbox-docker.sh" "$WRF" "$RRF" -- sh -c "$PAYLOAD" gaffer-sbx --mcp-config "$GAFFER_DATA/mcp-runtime.self.json" 2>&1)"
echo "$OUT" | sed 's/^/    /'

fail=0
for want in READ_ISOLATED EGRESS_BLOCKED RAWIP_BLOCKED WRITE_OK NNP_SET CAPS_DROPPED \
            DATA_MASKED OWN_MCP_OK DB_RW_OK GIT_STATUS_OK GIT_COMMIT_OK GITCONFIG_RO; do
  if echo "$OUT" | grep -q "$want"; then echo "  ok   $want"; else echo "  FAIL expected $want"; fail=1; fi
done
for bad in READ_LEAK EGRESS_LEAK RAWIP_LEAK WRITE_FAIL NNP_UNSET CAPS_KEPT \
           DATA_LEAK OWN_MCP_MISSING DB_RW_FAIL GIT_STATUS_FAIL GIT_COMMIT_FAIL GITCONFIG_WRITABLE; do
  if echo "$OUT" | grep -q "$bad"; then echo "  FAIL saw $bad"; fail=1; fi
done
# The write must have actually landed on the host worktree (proves the rw mount round-trips).
if [ -f "$WT/canary" ]; then echo "  ok   worktree write round-tripped to host"; else echo "  FAIL canary not on host"; fail=1; fi
# The commit made INSIDE must be on the host repo's branch (the .git mounts round-trip).
if git -C "$REPO" log --oneline gaffer/ticket-1 2>/dev/null | grep -q sandbox-commit; then
  echo "  ok   in-container commit round-tripped to the host repo branch"
else
  echo "  FAIL in-container commit not on the host branch"; fail=1
fi
# And the host's canonical settings.json was not touched by the mask.
grep -q TOPSECRET_SETTINGS "$GAFFER_DATA/settings.json" && echo "  ok   host settings.json intact after masking" || { echo "  FAIL host settings.json damaged"; fail=1; }

# ── BRIDGE MODE (lib/mcp-bridge.mjs): the MCP data plane on the HOST, DBs unmounted ──
# The round above is the LEGACY layout (GAFFER_MCP_BRIDGE off: the DB directory mounted,
# masked). With the bridge, the host runs the MCP servers and the container reaches them
# over ONE mounted unix socket — so the assertions flip: no database, no ledger, no
# settings/token file exists in the container at all, the claim token never enters it,
# and a bridged round trip still works from inside.
echo "== bridge mode: MCP servers on the host, nothing of \$GAFFER_DATA in the container =="
STUB="$WORK/stub-mcp.mjs"
cat > "$STUB" <<'JS'
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
rl.on("line", (l) => process.stdout.write(JSON.stringify({ echo: l, db: process.env.DISPATCH_DB || null, tok: (process.env.GAFFER_CLAIM_TOKEN || "").length }) + "\n"));
rl.on("close", () => process.exit(0));
JS
BCFG="$GAFFER_DATA/mcp-runtime.bridge-src.json"
printf '{"mcpServers":{"dispatch":{"command":"%s","args":["%s"],"env":{"DISPATCH_DB":"%s/dispatch.sqlite","GAFFER_CLAIM_TOKEN":"TOPSECRET_CLAIM"}}}}\n' \
  "$(command -v node)" "$STUB" "$GAFFER_DATA" > "$BCFG"
SOCK="$GAFFER_DATA/mcp-bridge.test.sock"
BRIDGED="$GAFFER_DATA/mcp-runtime.self.bridge.json"
node "$RUNNER_DIR/lib/mcp-bridge.mjs" render --config "$BCFG" --out "$BRIDGED" --socket "$SOCK" --bridge "$RUNNER_DIR/lib/mcp-bridge.mjs" \
  || { echo "  FAIL bridge render failed"; fail=1; }
node "$RUNNER_DIR/lib/mcp-bridge.mjs" serve --socket "$SOCK" --config "$BCFG" >"$WORK/bridge.log" 2>&1 &
BPID=$!
for _ in $(seq 1 100); do [ -S "$SOCK" ] && break; sleep 0.05; done
if [ -S "$SOCK" ]; then
  PAYLOAD2="
    if [ -e '$GAFFER_DATA/dispatch.sqlite' ] || [ -e '$GAFFER_DATA/memory.sqlite' ]; then echo DB_VISIBLE; else echo DB_UNMOUNTED; fi
    if cat '$GAFFER_DATA/settings.json' '$GAFFER_DATA/dashboard-token' '$GAFFER_DATA/mcp-runtime.other.json' '$SIB/secret' 2>/dev/null | grep -q TOPSECRET; then echo BDATA_LEAK; else echo BDATA_ABSENT; fi
    if [ -e '$GAFFER_DATA/settings.json' ] || [ -e '$GAFFER_DATA/dashboard-token' ] || [ -e '$GAFFER_DATA/mcp-runtime.other.json' ]; then echo BFILES_PRESENT; else echo BFILES_ABSENT; fi
    if grep -q TOPSECRET_CLAIM '$BRIDGED' 2>/dev/null || env | grep -q TOPSECRET_CLAIM; then echo TOKEN_LEAK; else echo TOKEN_ABSENT; fi
    if env | grep -q '^DISPATCH_DB='; then echo DBENV_PRESENT; else echo DBENV_ABSENT; fi
    r=\$(echo '{\"ping\":1}' | node '$RUNNER_DIR/lib/mcp-bridge.mjs' connect --socket '$SOCK' --server dispatch 2>/dev/null)
    case \"\$r\" in *'\"db\":\"$GAFFER_DATA/dispatch.sqlite\"'*'\"tok\":15'*) echo BRIDGE_OK;; *) echo \"BRIDGE_FAIL:\$r\";; esac
    if echo '{}' | node '$RUNNER_DIR/lib/mcp-bridge.mjs' connect --socket '$SOCK' --server nosuch >/dev/null 2>&1; then echo UNKNOWN_ACCEPTED; else echo UNKNOWN_REFUSED; fi
    if echo canary2 > '$WT/canary2' 2>/dev/null; then echo BWRITE_OK; else echo BWRITE_FAIL; fi
  "
  OUT2="$(GAFFER_MCP_BRIDGE_SOCKET="$SOCK" timeout 120 bash "$RUNNER_DIR/lib/sandbox-docker.sh" "$WRF" "$RRF" -- sh -c "$PAYLOAD2" gaffer-sbx --mcp-config "$BRIDGED" 2>&1)"
  echo "$OUT2" | sed 's/^/    /'
  for want in DB_UNMOUNTED BDATA_ABSENT BFILES_ABSENT TOKEN_ABSENT DBENV_ABSENT BRIDGE_OK UNKNOWN_REFUSED BWRITE_OK; do
    if echo "$OUT2" | grep -q "$want"; then echo "  ok   $want"; else echo "  FAIL expected $want"; fail=1; fi
  done
  for bad in DB_VISIBLE BDATA_LEAK BFILES_PRESENT TOKEN_LEAK DBENV_PRESENT BRIDGE_FAIL UNKNOWN_ACCEPTED BWRITE_FAIL; do
    if echo "$OUT2" | grep -q "$bad"; then echo "  FAIL saw $bad"; fail=1; fi
  done
  # The legacy round must have WARNED that the data plane ran inside; the bridge round not.
  if echo "$OUT" | grep -q 'MCP data plane runs INSIDE the container'; then echo "  ok   legacy layout warns that the DBs are reachable"; else echo "  FAIL legacy layout did not warn"; fail=1; fi
  if echo "$OUT2" | grep -q 'MCP data plane runs INSIDE the container'; then echo "  FAIL bridge round still warned"; fail=1; else echo "  ok   bridge round: no data-plane-inside warning"; fi
else
  echo "  FAIL bridge socket never appeared: $(cat "$WORK/bridge.log" 2>/dev/null)"; fail=1
fi
kill "$BPID" 2>/dev/null || true; wait "$BPID" 2>/dev/null || true

git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1 || true
rm -rf "$WORK"
if [ "$fail" -eq 0 ]; then echo "PASS (Mode-2 containment holds: secret unreadable, egress denied, worktree writable, data dir masked, git works; bridge mode: databases unmounted, token absent, MCP round-trips over the socket)"; exit 0; else echo "FAILED"; exit 1; fi
