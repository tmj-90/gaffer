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
REFS_BEFORE="$(ddw_host_refs)"
OUT="$(ddw_run_tick)"
echo "    $OUT"
ddw_common_asserts "$N"
ddw_refs_asserts "$N" "$REFS_BEFORE"

echo "== the containers the runner asked for =="
argv_of() { tr '\0' '\n' < "$FAKE_DOCKER_LOG/$1.argv"; }
# The values of a recorded container's `-e` flags / the sources of its `-v` mounts.
env_flags() { grep -A1 -x -- '-e' "$1" | grep -v -x -e '-e' -e '--'; }
mount_sources() { grep -A1 -x -- '-v' "$1" | grep -v -x -e '-v' -e '--' | cut -d: -f1; }
# mount_covering <argv-file> <path>…: the first mount source that IS one of the paths or
# a directory above one (empty when none does).
mount_covering() {
  local f="$1" src p; shift
  while IFS= read -r src; do
    [ -n "$src" ] || continue
    for p in "$@"; do
      case "$p/" in "${src%/}/"*) printf '%s' "$src"; return 0 ;; esac
    done
  done <<<"$(mount_sources "$f")"
  return 0
}
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
  # A mount whose SOURCE is one of these paths or any directory above one (a parent
  # mount exposes everything below it) would hand the container what must stay out.
  bad_src="$(mount_covering "$A" "$GAFFER_DATA" "$GAFFER_DATA/dispatch.sqlite" "$GAFFER_DATA/memory.sqlite" "$GAFFER_DATA/settings.json")"
  [ -z "$bad_src" ] && ok "agent container: \$GAFFER_DATA, the databases and settings.json are not mounted (nor any directory above them)" || fail "agent container: '$bad_src' is mounted and covers \$GAFFER_DATA or a database/settings file"
  bad_src="$(mount_covering "$A" "$HOST_HOME" "$CANARY_DIR")"
  [ -z "$bad_src" ] && ok "agent container: the host HOME and the canary dir are not mounted (nor any directory above them)" || fail "agent container: '$bad_src' is mounted and covers the host HOME or the canary dir"
  grep -qx 'ANTHROPIC_API_KEY' <<<"$(env_flags "$A")" && ok "agent container: the model credential is forwarded by name (the decoy: so the gates' 'no credential' check below is not vacuous)" || fail "agent container: the model credential was not forwarded"
  # Only the `-e` flags cross into a container (the agent's own `env -i` list inside it
  # names the DB paths, which do not exist there); the claim token appears nowhere.
  grep -qE '^(DISPATCH_DB|MEMORY_DB|DISPATCH_MCP_BIN|MEMORY_MCP_BIN)(=|$)' <<<"$(grep -A1 -x -- '-e' "$A")" && fail "agent container: a data-plane var is forwarded" || ok "agent container: no DISPATCH_DB / MEMORY_DB / server bin forwarded"
  grep -q 'GAFFER_CLAIM_TOKEN' "$A" && fail "agent container: the claim token is in the argv" || ok "agent container: the claim token is nowhere in the container argv"
fi
if [ "${#GATES[@]}" -ge 1 ]; then
  ok "the DoD gates ran as ${#GATES[@]} separate container(s)"
  gate_test=""; for i in "${GATES[@]}"; do grep -qx 'node gate-probe.mjs && node --test' <<<"$(argv_of "$i")" && gate_test="$i"; done
  [ -n "$gate_test" ] && ok "gate container: the repo's test command ran inside (docker call #$gate_test)" || fail "no gate container ran the repo's test command"
  # EVERY gate container (tests, lint, …) runs under the validation profile.
  for i in "${GATES[@]}"; do
    G="$WORK/gate-$i.argv"; argv_of "$i" > "$G"
    grep -q 'gaffer-mcp\.' "$G" && fail "gate container #$i: the bridge socket reached the gate" || ok "gate container #$i: no bridge socket (validation profile)"
    grep -qE -- '--mcp-config|\.bridge\.json' "$G" && fail "gate container #$i: an MCP config reached the gate" || ok "gate container #$i: no MCP config"
    grep -qE '^(GAFFER_DATA|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|DISPATCH_DB|MEMORY_DB|DISPATCH_MCP_BIN|MEMORY_MCP_BIN|GAFFER_CLAIM_TOKEN)(=|$)' <<<"$(env_flags "$G")" \
      && fail "gate container #$i: data-plane env or a credential forwarded" || ok "gate container #$i: no GAFFER_DATA, database path or credential forwarded"
    bad_src=""
    while IFS= read -r spec; do
      src="${spec%%:*}"; dst="${spec#*:}"; dst="${dst%%:*}"
      case "$src" in
        "$GAFFER_DATA/worktrees/ticket-$N/"*) ;;
        # A wrapper that gives each container a PRIVATE git dir (built under
        # $GAFFER_DATA/sandbox-git/, mounted at the worktree's own git dir) is fine.
        "$GAFFER_DATA/sandbox-git/"*) case "$dst" in "$R/.git/worktrees/"*) ;; *) bad_src="$src" ;; esac ;;
        "$GAFFER_DATA"/*) bad_src="$src" ;;
      esac
    done <<<"$(grep -A1 -x -- '-v' "$G" | grep -v -x -e '-v' -e '--')"
    [ -n "$bad_src" ] || bad_src="$(mount_covering "$G" "$GAFFER_DATA" "$HOST_HOME" "$CANARY_DIR")"
    [ -z "$bad_src" ] && ok "gate container #$i: nothing of \$GAFFER_DATA but the worktree mounted, no host HOME or canary dir" \
      || fail "gate container #$i: '$bad_src' is mounted (from or above \$GAFFER_DATA, the host HOME or the canary dir: not the validation profile)"
    grep -q 'GAFFER_CLAIM_TOKEN' "$G" && fail "gate container #$i: the claim token is in the argv"
  done
else
  fail "no DoD gate container recorded"
fi

echo "== the MCP round trip and the result envelope =="
EV="$(ddw_evidence "$N")"
case "$EV" in *"docker-delivery-stub:"*"MCP_CONFIG_BRIDGED"*"MCP_ROUND_TRIP"*) ok "the agent's record_ac_evidence reached the canonical DB through the host-side bridge (its config was the bridged one)" ;; *) fail "no agent evidence on #$N (evidence: $(printf '%s' "$EV" | head -c 400))" ;; esac
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

echo "== the real-daemon test's skip / require posture (no daemon needed) =="
# sandbox-docker-delivery.test.sh, copied into a scratch tree and run against a scripted
# `docker`: an infra outage (no daemon, an image that cannot be built) is an allowlisted
# SKIP that GAFFER_SANDBOX_TEST_REQUIRE=1 turns red; anything else on a host WITH a daemon
# (unbuilt packages, a live run without a credential or with an unreadable cap) is never
# a docker-allowlisted skip.
. "$HERE/lib/skip.sh"
PT="$WORK/posture"; mkdir -p "$PT/bin" "$PT/bare/runner/test" "$PT/bare/runner/sandbox/egress-proxy" "$PT/built/runner/test" "$PT/built/runner/sandbox/egress-proxy"
cp "$HERE/sandbox-docker-delivery.test.sh" "$PT/bare/runner/test/"
cp "$HERE/sandbox-docker-delivery.test.sh" "$PT/built/runner/test/"
ln -s "$ROOT/packages" "$PT/built/packages"
cat > "$PT/bin/docker" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$POSTURE_LOG"
case "$1" in info) exit "${POSTURE_INFO_RC:-0}" ;; build) exit "${POSTURE_BUILD_RC:-0}" ;; esac
exit 0
SH
chmod +x "$PT/bin/docker"
# posture <tree> <env assignment>… → "<rc>|<first SKIP/FAIL line>"
posture() {
  local tree="$1" out rc; shift
  : > "$PT/calls.log"
  out="$(env -u CI -u GITHUB_ACTIONS -u RUN_SANDBOX_DOCKER_TEST -u GAFFER_SANDBOX_TEST_REQUIRE \
            -u GAFFER_LIVE_DOCKER_DELIVERY -u GAFFER_LIVE_MAX_CALL_USD -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN \
            POSTURE_LOG="$PT/calls.log" PATH="$PT/bin:$PATH" "$@" bash "$PT/$tree/runner/test/sandbox-docker-delivery.test.sh" 2>&1 </dev/null)"
  rc=$?
  printf '%s|%s' "$rc" "$(grep -E '^(SKIP|FAIL)' <<<"$out" | head -1)"
}
why() { local r="${1#*|}"; r="${r#SKIP: }"; printf '%s' "$r"; }
r="$(posture built POSTURE_INFO_RC=1)"
case "$r" in "0|SKIP: docker daemon unavailable"*) gaffer_skip_allowed "$(why "$r")" && ok "posture: no daemon is an allowlisted SKIP" || fail "posture: the no-daemon skip is not allowlisted ($r)" ;; *) fail "posture: no daemon gave '$r'" ;; esac
r="$(posture built POSTURE_INFO_RC=1 GAFFER_SANDBOX_TEST_REQUIRE=1)"
case "$r" in "1|FAIL (required): docker daemon unavailable"*) ok "posture: no daemon under GAFFER_SANDBOX_TEST_REQUIRE=1 is a failure" ;; *) fail "posture: no daemon + REQUIRE gave '$r'" ;; esac
r="$(posture built CI=true)"
case "$r" in "0|SKIP: docker delivery e2e runs in its dedicated CI job"*) ok "posture: a CI runner shard defers to the dedicated job" ;; *) fail "posture: CI=true without RUN_SANDBOX_DOCKER_TEST gave '$r'" ;; esac
r="$(posture bare)"
case "$r" in "0|SKIP: "*"not built"*) gaffer_skip_allowed "$(why "$r")" && fail "posture: 'not built' on a host with a daemon is allowlisted under strict ($r)" || ok "posture: 'not built' with a daemon present is a skip the strict allowlist refuses" ;; *) fail "posture: unbuilt packages gave '$r'" ;; esac
r="$(posture bare RUN_SANDBOX_DOCKER_TEST=1)"
case "$r" in "1|FAIL: "*"not built"*) ok "posture: 'not built' in the dedicated job is a failure, on a pull request too" ;; *) fail "posture: unbuilt packages in the dedicated job gave '$r'" ;; esac
r="$(posture built POSTURE_BUILD_RC=1)"
case "$r" in "0|SKIP: could not build the delivery image"*) gaffer_skip_allowed "$(why "$r")" && ok "posture: an image that cannot be built is an allowlisted infra SKIP" || fail "posture: the image-build skip is not allowlisted ($r)" ;; *) fail "posture: a failed image build gave '$r'" ;; esac
r="$(posture built POSTURE_BUILD_RC=1 GAFFER_SANDBOX_TEST_REQUIRE=1)"
case "$r" in "1|FAIL (required): could not build the delivery image"*) ok "posture: a failed image build under REQUIRE is a failure" ;; *) fail "posture: failed build + REQUIRE gave '$r'" ;; esac
r="$(posture built GAFFER_LIVE_DOCKER_DELIVERY=1 ANTHROPIC_API_KEY=)"
case "$r" in "1|FAIL: GAFFER_LIVE_DOCKER_DELIVERY=1 needs"*) ok "posture: a live run without a credential fails at once" ;; *) fail "posture: live without a credential gave '$r'" ;; esac
for cap in two '$2' 0 -1; do
  r="$(posture built GAFFER_LIVE_DOCKER_DELIVERY=1 ANTHROPIC_API_KEY=decoy GAFFER_LIVE_MAX_CALL_USD="$cap")"
  case "$r" in "1|FAIL: GAFFER_LIVE_MAX_CALL_USD="*) grep -q '^build' "$PT/calls.log" && fail "posture: live cap '$cap' refused only after an image build" || ok "posture: live cap '$cap' is refused before anything is built" ;; *) fail "posture: live cap '$cap' gave '$r'" ;; esac
done

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "sandbox-docker-delivery-seam: ALL $PASS checks passed"; exit 0; fi
echo "sandbox-docker-delivery-seam: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
ddw_save_evidence "$N"
exit 1
