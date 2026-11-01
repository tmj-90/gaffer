#!/usr/bin/env bash
# =====================================================================
# DOCKER-PROVIDER DELIVERY, NO DAEMON: the wiring of a whole delivery.
# ---------------------------------------------------------------------
# The daemon-free twin of sandbox-docker-delivery.test.sh: the SAME world
# (lib/docker-delivery-world.sh), one ticket through the REAL tick.sh with
# SANDBOX_PROVIDER=docker + STRICT_MODE=1 + GAFFER_STRICT_REQUIRE=1 + the MCP bridge
# on, but `docker` is lib/fake-docker.sh: it records every container the runner asks
# for and runs its command on this host. Nothing is isolated, so this proves the
# WIRING, on every OS the bash suite runs on, and the real-daemon test proves the
# containment:
#   • the agent is spawned as `docker run … <image> env -i … claude -p … --mcp-config
#     <bridged.json>` (the image's own claude, the bridged config) and its container
#     gets the bridge socket, the bridged config and the worktree, and NOT $GAFFER_DATA,
#     the databases, the host HOME, the canary or the claim token;
#   • the agent's MCP round trip goes through the host-side bridge: its token-free
#     record_ac_evidence lands in the canonical DB and satisfies the criterion;
#   • the DoD tests gate runs as its own `docker run … bash -c <test command>` with the
#     validation profile: no socket, no bridged config, no data-plane env, no credential;
#   • the result envelope is parsed (usage booked) and the ticket reaches in_review.
# Run: bash runner/test/sandbox-docker-delivery-seam.test.sh   (bash 3.2 safe)
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }
command -v perl >/dev/null 2>&1 || { echo "SKIP: perl required (timeout primitive)"; exit 0; }
for f in packages/dispatch/dist/cli/index.js packages/dispatch/dist/mcp/bin.js packages/memory/dist/bin/memory.js packages/crew/dist/cli/index.js; do
  [ -f "$ROOT/$f" ] || { echo "SKIP: $f not built (run pnpm -r build)"; exit 0; }
done

# shellcheck disable=SC2034  # read by lib/docker-delivery-world.sh
DDW_NAME=docker-delivery-seam
# shellcheck source=lib/docker-delivery-world.sh
source "$HERE/lib/docker-delivery-world.sh"

# The fake daemon, first on PATH for tick.sh and everything it starts.
FAKEBIN="$WORK/fakebin"; mkdir -p "$FAKEBIN"
cp "$HERE/lib/fake-docker.sh" "$FAKEBIN/docker"; chmod +x "$FAKEBIN/docker"
export FAKE_DOCKER_LOG="$WORK/docker-calls" PATH="$FAKEBIN:$PATH"
# Inside a real container the image's `claude` is the stub; here the "container" is
# this host, so name the stub by its absolute path (never a `claude` found on PATH) and
# give the container a PATH that holds node, git and bash only.
SBXBIN="$WORK/sbx-bin"; mkdir -p "$SBXBIN"
for t in node git bash sh env; do ln -s "$(command -v "$t")" "$SBXBIN/$t"; done
export GAFFER_SANDBOX_CLAUDE_BIN="$STUB" GAFFER_SANDBOX_PATH="$SBXBIN" \
       GAFFER_SANDBOX_HOME="$WORK/sbx-home" GAFFER_SANDBOX_IMAGE="gaffer-sbx-delivery-seam"
mkdir -p "$WORK/sbx-home"

ddw_add_repo "node gate-probe.mjs && node --test"
N="$(ddw_new_ready "Docker seam delivery")"
[ -n "$N" ] && ok "setup: ready ticket #$N" || fail "setup: no ticket"

echo "== one tick: SANDBOX_PROVIDER=docker, fake daemon =="
OUT="$(ddw_run_tick)"
echo "    $OUT"
ddw_common_asserts "$N"

echo "== the containers the runner asked for =="
argv_of() { tr '\0' '\n' < "$FAKE_DOCKER_LOG/$1.argv"; }
# Each recorded `run --rm` (the egress proxy's `run -d` is skipped), one arg per line.
runs=()
while read -r i sub; do
  [ "$sub" = run ] || continue
  grep -qx -- '-d' <<<"$(argv_of "$i")" && continue
  runs+=( "$i" )
done < "$FAKE_DOCKER_LOG/calls.txt"
AGENT=""; GATES=()
for i in ${runs[@]+"${runs[@]}"}; do
  if grep -qx -- '-p' <<<"$(argv_of "$i")"; then AGENT="$i"; else GATES+=( "$i" ); fi
done
[ -n "$AGENT" ] && ok "the agent ran as a container (docker call #$AGENT)" || fail "no agent container recorded ($(cat "$FAKE_DOCKER_LOG/calls.txt" 2>/dev/null | tr '\n' ' '))"
if [ -n "$AGENT" ]; then
  A="$WORK/agent.argv"; argv_of "$AGENT" > "$A"
  grep -qx 'gaffer-sbx-delivery-seam' "$A" && ok "agent container: the sandbox image" || fail "agent container: image missing"
  grep -qx -- "$STUB" "$A" && ok "agent container: the image's claude ran (GAFFER_SANDBOX_CLAUDE_BIN), not the host CLAUDE_BIN path" || fail "agent container: claude binary not the sandbox one"
  BRIDGED="$(grep -A1 -x -- '--mcp-config' "$A" | tail -1)"
  case "$BRIDGED" in *.bridge.json) ok "agent container: --mcp-config is the bridged copy ($(basename "$BRIDGED"))" ;; *) fail "agent container: --mcp-config is '$BRIDGED', not a bridged copy" ;; esac
  grep -qE '^/tmp/gaffer-mcp\.[^/]+/b\.sock:/tmp/gaffer-mcp\.[^/]+/b\.sock:rw$' "$A" && ok "agent container: the bridge socket is mounted rw" || fail "agent container: no bridge socket mount"
  grep -qx -- "$BRIDGED:$BRIDGED:ro" "$A" && ok "agent container: the bridged config is mounted ro" || fail "agent container: bridged config not mounted ro"
  grep -qE "^$GAFFER_DATA/worktrees/ticket-$N/[^:]+:$GAFFER_DATA/worktrees/ticket-$N/[^:]+:rw$" "$A" && ok "agent container: the delivery worktree is mounted rw" || fail "agent container: worktree not mounted rw"
  grep -qE "^($GAFFER_DATA|$GAFFER_DATA/dispatch\.sqlite|$GAFFER_DATA/memory\.sqlite|$GAFFER_DATA/settings\.json):" "$A" && fail "agent container: \$GAFFER_DATA or a database/settings file is mounted" || ok "agent container: \$GAFFER_DATA, the databases and settings.json are not mounted"
  grep -qE "^($HOST_HOME|$CANARY_DIR)(/|:)" "$A" && fail "agent container: the host HOME or the canary dir is mounted" || ok "agent container: the host HOME and the canary dir are not mounted"
  # Only the `-e` flags cross into a container (the agent's own `env -i` list inside it
  # names the DB paths, which do not exist there); the claim token appears nowhere.
  grep -qE '^(DISPATCH_DB|MEMORY_DB|DISPATCH_MCP_BIN|MEMORY_MCP_BIN)(=|$)' <<<"$(grep -A1 -x -- '-e' "$A")" && fail "agent container: a data-plane var is forwarded" || ok "agent container: no DISPATCH_DB / MEMORY_DB / server bin forwarded"
  grep -q 'GAFFER_CLAIM_TOKEN' "$A" && fail "agent container: the claim token is in the argv" || ok "agent container: the claim token is nowhere in the container argv"
fi
if [ "${#GATES[@]}" -ge 1 ]; then
  ok "the DoD gates ran as ${#GATES[@]} separate container(s)"
  gate_test=""; for i in "${GATES[@]}"; do grep -qx 'node gate-probe.mjs && node --test' <<<"$(argv_of "$i")" && gate_test="$i"; done
  if [ -n "$gate_test" ]; then
    G="$WORK/gate.argv"; argv_of "$gate_test" > "$G"
    ok "gate container: the repo's test command ran inside (docker call #$gate_test)"
    grep -q 'gaffer-mcp\.' "$G" && fail "gate container: the bridge socket reached the gate" || ok "gate container: no bridge socket (validation profile)"
    grep -q -- '--mcp-config\|\.bridge\.json' "$G" && fail "gate container: an MCP config reached the gate" || ok "gate container: no MCP config"
    grep -qE '^(GAFFER_DATA|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|DISPATCH_DB|MEMORY_DB)(=|$)' <<<"$(grep -A1 -x -- '-e' "$G")" && fail "gate container: data-plane env or a credential forwarded" || ok "gate container: no GAFFER_DATA, database path or credential forwarded"
    grep -q 'safety-blocks.jsonl' "$G" && fail "gate container: the hook ledgers are mounted (not the validation profile)" || ok "gate container: nothing of \$GAFFER_DATA mounted"
  else
    fail "no gate container ran the repo's test command"
  fi
else
  fail "no DoD gate container recorded"
fi

echo "== the MCP round trip and the result envelope =="
EV="$(ddw_evidence "$N")"
case "$EV" in *"docker-delivery-stub:"*"MCP_BRIDGED"*) ok "the agent's record_ac_evidence reached the canonical DB through the host-side bridge" ;; *) fail "no agent evidence on #$N (evidence: $(printf '%s' "$EV" | head -c 400))" ;; esac
case "$EV" in *"docker-delivery-stub:"*"TOKEN_ABSENT"*) ok "the claim token never reached the agent's env or its MCP config" ;; *) fail "the stub saw the claim token (or no probe ran)" ;; esac
# The agent's own env is `env -i <allowlist>` INSIDE the container: what the real CLI
# needs there must be on that list, not only on the wrapper's -e flags.
for want in GIT_SAFE_DIRECTORY EGRESS_PROXY_SET TMPDIR_USABLE; do
  case "$EV" in *"docker-delivery-stub:"*" $want "*) ok "the agent's env inside the container: $want" ;; *) fail "the agent's env inside the container: expected $want" ;; esac
done
AC_OK="$(ddw_acs_satisfied "$N")"
[ "$AC_OK" = yes ] && ok "the token-free evidence write satisfied the criterion (the host-side server held the claim token)" || fail "acceptance criterion not satisfied ($AC_OK)"
grep -q 'Implemented helper' "$GAFFER_DATA/factory.log" 2>/dev/null && ok "the result envelope was parsed (the agent's result text is in the run log)" || fail "the agent's result text never reached factory.log"
[ "$(ddw_gate "$N" tests)" = "PASS node gate-probe.mjs && node --test" ] && ok "the DoD evidence records the tests gate PASS for the repo's command" || fail "tests gate evidence: '$(ddw_gate "$N" tests)'"
read -r LROWS LCOST <<<"$(ddw_ledger_cost "$N")"
[ "${LROWS:-0}" -ge 1 ] && [ "${LCOST:-0}" = "0.0200" ] && ok "the usage ledger booked the envelope's cost (\$$LCOST)" || fail "usage ledger: rows=${LROWS:-?} cost=${LCOST:-?}"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "sandbox-docker-delivery-seam: ALL $PASS checks passed"; exit 0; fi
echo "sandbox-docker-delivery-seam: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
