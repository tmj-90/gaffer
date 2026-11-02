#!/usr/bin/env bash
# =====================================================================
# DOCKER-PROVIDER DELIVERY END TO END: a real ticket delivered INSIDE the container.
# ---------------------------------------------------------------------
# The capstone the containment gate (sandbox-docker-containment.test.sh) left open:
# that gate proves the boundary with a shell payload; this test proves a whole
# delivery works THROUGH it. One ticket goes through the REAL tick.sh with
# SANDBOX_PROVIDER=docker, STRICT_MODE=1, GAFFER_STRICT_REQUIRE=1 and the MCP bridge on
# (lib/docker-delivery-world.sh), on a real docker daemon:
#   • the image is the shipped delivery image (runner/sandbox/Dockerfile) plus a probe
#     file, and, in the default deterministic run, the stub agent
#     (lib/docker-delivery-stub.mjs) installed as the image's own `claude`;
#   • the agent runs INSIDE the container: its probes (recorded through MCP and in its
#     commit) must show a container, no $GAFFER_DATA database or settings file, no host
#     HOME, an unreadable host canary, a refused write beside it and no claim token;
#   • the MCP round trip goes through the bridge: the agent's token-free
#     record_ac_evidence lands in the host's canonical DB and satisfies the criterion;
#   • the agent's commit (made inside, through the mounted .git) is on the host branch;
#   • the DoD gates run in their own container under the validation profile: the repo's
#     test command starts with `node gate-probe.mjs --require`, which FAILS the gate
#     unless it runs in a container with no database, no bridge socket, no host HOME,
#     no canary and no model credential, so review is only reachable that way;
#   • the result envelope is parsed (the usage ledger books its cost) and the ticket
#     reaches in_review; the host canary is unchanged and nothing was written beside it.
#
# LIVE VARIANT (opt-in, spends real credits): GAFFER_LIVE_DOCKER_DELIVERY=1 with
# ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN set runs the SAME delivery with the
# image's real `claude` (no stub). The host-side assertions stay (in_review, a commit,
# the envelope booked with a real cost, the canary untouched, the gates contained);
# the agent's own probes cannot be asserted, because a real agent decides what it
# runs. CI runs it only from the workflow_dispatch workflow sandbox-live.yml.
#
# Posture (same as the containment gate): no docker daemon ⇒ SKIP; on CI it runs only
# in its dedicated job (RUN_SANDBOX_DOCKER_TEST=1); GAFFER_SANDBOX_TEST_REQUIRE=1 turns
# every infra skip into a failure. The daemon-free twin, run in the normal suite, is
# sandbox-docker-delivery-seam.test.sh.
# Run: bash runner/test/sandbox-docker-delivery.test.sh   (bash 3.2 safe)
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
export RUNNER_DIR

_skip() {
  if [ "${GAFFER_SANDBOX_TEST_REQUIRE:-0}" = "1" ]; then
    echo "FAIL (required): $1"; echo "::error::docker delivery e2e did not run: $1"; exit 1
  fi
  echo "SKIP: $1"; exit 0
}

LIVE="${GAFFER_LIVE_DOCKER_DELIVERY:-0}"
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  _skip "docker daemon unavailable: the docker-provider delivery e2e was not exercised on this host"
fi
if [ "${CI:-}" = "true" ] && [ "${RUN_SANDBOX_DOCKER_TEST:-0}" != "1" ]; then
  echo "SKIP: docker delivery e2e runs in its dedicated CI job (set RUN_SANDBOX_DOCKER_TEST=1)"
  exit 0
fi
# A host that HAS a daemon but lacks node/git/perl or the built packages is not an infra
# outage: the reason never names docker, so the runner suite's strict allowlist
# (lib/skip.sh) fails it, and in the dedicated CI job (which builds first) it is red.
_prereq() {
  if [ "${RUN_SANDBOX_DOCKER_TEST:-0}" = "1" ] || [ "${GAFFER_SANDBOX_TEST_REQUIRE:-0}" = "1" ]; then
    echo "FAIL: $1 (the delivery e2e job must have it)"; exit 1
  fi
  echo "SKIP: $1"; exit 0
}
command -v node >/dev/null 2>&1 || _prereq "node required for the delivery e2e"
command -v git >/dev/null 2>&1 || _prereq "git required for the delivery e2e"
command -v perl >/dev/null 2>&1 || _prereq "perl required for the delivery e2e (timeout primitive)"
for f in packages/dispatch/dist/cli/index.js packages/dispatch/dist/mcp/bin.js packages/memory/dist/bin/memory.js packages/crew/dist/cli/index.js; do
  [ -f "$ROOT/$f" ] || _prereq "$f not built (run pnpm -r build)"
done
if [ "$LIVE" = 1 ]; then
  # A workflow exports an unset secret as an empty string: drop the empty one.
  [ -n "${ANTHROPIC_API_KEY:-}" ] || unset ANTHROPIC_API_KEY
  [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || unset CLAUDE_CODE_OAUTH_TOKEN
fi
if [ "$LIVE" = 1 ] && [ -z "${ANTHROPIC_API_KEY:-}${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  echo "FAIL: GAFFER_LIVE_DOCKER_DELIVERY=1 needs ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN"; exit 1
fi
# The per-call cap is a hard requirement of the live run: the runner turns
# GAFFER_MAX_CALL_USD into `claude --max-budget-usd`, but a value it cannot read (empty,
# "$2", "two", 0) silently means NO flag, so refuse anything but a positive dollar figure.
LIVE_CAP="${GAFFER_LIVE_MAX_CALL_USD:-2}"
if [ "$LIVE" = 1 ] && ! awk -v c="$LIVE_CAP" 'BEGIN { exit !(c ~ /^[0-9]*\.?[0-9]+$/ && c + 0 > 0) }'; then
  echo "FAIL: GAFFER_LIVE_MAX_CALL_USD='$LIVE_CAP' is not a positive dollar figure (e.g. 2 or 0.5): the live call would run without a per-call cap"; exit 1
fi

echo "== docker-provider delivery e2e ($([ "$LIVE" = 1 ] && echo "LIVE: the image's real claude" || echo "deterministic: stub agent")) =="

# Images first: a build failure is INFRA (registry / Docker Hub rate limit), not a
# delivery failure, so it skips (or fails under GAFFER_SANDBOX_TEST_REQUIRE=1) before
# anything is asserted.
_BASE_IMG="${GAFFER_SANDBOX_E2E_BASE_IMAGE:-gaffer-sandbox:delivery-e2e}"
if [ -z "${GAFFER_SANDBOX_E2E_BASE_IMAGE:-}" ]; then
  docker build -q -t "$_BASE_IMG" "$RUNNER_DIR/sandbox" >/dev/null 2>&1 \
    || _skip "could not build the delivery image runner/sandbox/Dockerfile (docker registry/infra unavailable): delivery not exercised"
fi
docker build -q -t gaffer-egress-proxy "$RUNNER_DIR/sandbox/egress-proxy" >/dev/null 2>&1 \
  || _skip "could not build the egress-proxy image (docker registry/infra unavailable): delivery not exercised"

# shellcheck disable=SC2034  # read by lib/docker-delivery-world.sh
DDW_NAME=docker-delivery DDW_LIVE="$LIVE"
# shellcheck source=lib/docker-delivery-world.sh
source "$HERE/lib/docker-delivery-world.sh"
if [ "$LIVE" = 1 ]; then
  # The real CLI picks its own model and turns; a per-call dollar cap keeps it bounded.
  unset GAFFER_CARD_MODEL GAFFER_PLAN_MODEL GAFFER_IMPL_MODEL GAFFER_CLAUDE_VERSION
  export GAFFER_MAX_CALL_USD="$LIVE_CAP"
  # ...and prove the runner resolves it to a flag (gaffer_call_budget_usd is what tick.sh
  # and lib/worker.sh pass as --max-budget-usd) before any credit is spent.
  _cb="$(gaffer_call_budget_usd 2>/dev/null)"
  if [ -z "$_cb" ]; then
    fail "the runner resolves GAFFER_MAX_CALL_USD=$LIVE_CAP to no --max-budget-usd: refusing to run uncapped"; exit 1
  fi
  ok "live per-call cap: the runner passes --max-budget-usd $_cb to the agent call (daily budget \$$GAFFER_DAILY_BUDGET_USD)"
fi

# The test image: the delivery image + the probe file (+ the stub as `claude`).
IMG_CTX="$WORK/image"; mkdir -p "$IMG_CTX"
ddw_write_probe_json "$IMG_CTX/probe.json"
{
  printf 'FROM %s\n' "$_BASE_IMG"
  printf 'COPY probe.json /etc/gaffer-e2e/probe.json\n'
  if [ "$LIVE" != 1 ]; then
    cp "$STUB" "$IMG_CTX/stub.mjs"
    printf '#!/bin/sh\nexec node /usr/local/lib/gaffer-e2e/stub.mjs "$@"\n' > "$IMG_CTX/claude"
    chmod 755 "$IMG_CTX/claude"
    # The image's own CLI entry is replaced (rm first: npm installs it as a symlink).
    # ...but only after checking the shipped image really installed one, so the stub
    # cannot mask an image whose CLI install went missing.
    printf 'RUN test -e /usr/local/bin/claude && rm -f /usr/local/bin/claude\n'
    printf 'COPY stub.mjs /usr/local/lib/gaffer-e2e/stub.mjs\n'
    printf 'COPY claude /usr/local/bin/claude\n'
  fi
} > "$IMG_CTX/Dockerfile"
_IMG="gaffer-sbx-delivery-e2e"
if docker build -q -t "$_IMG" "$IMG_CTX" >"$WORK/image-build.log" 2>&1; then
  ok "test image built from the delivery image ($_BASE_IMG)"
else
  fail "could not build the test image on top of $_BASE_IMG: $(tail -5 "$WORK/image-build.log")"
  exit 1
fi
export GAFFER_SANDBOX_IMAGE="$_IMG"
# What the containers wrote on a Linux host is root-owned: hand it back to this user
# before the temp dir is removed (best-effort; the image's root may chown, the
# delivery containers could not).
# shellcheck disable=SC2317  # called from the world's EXIT trap
ddw_pre_cleanup() {
  # A delivery that failed midway (a tick timeout kills the docker CLI, not its
  # container) can leave a container of this image running: stop it first.
  local c
  for c in $(docker ps -q --filter "ancestor=$_IMG" 2>/dev/null); do docker rm -f "$c" >/dev/null 2>&1 || true; done
  [ "$(id -u)" = 0 ] && return 0
  docker run --rm -v "$WORK:$WORK" "$_IMG" chown -R "$(id -u):$(id -g)" "$WORK" >/dev/null 2>&1 || true
}
unset GAFFER_SANDBOX_CLAUDE_BIN GAFFER_SANDBOX_PATH GAFFER_SANDBOX_HOME

# --require: the tests gate fails unless it runs contained (see the header).
ddw_add_repo "node gate-probe.mjs --require && node --test"
N="$(ddw_new_ready "Docker delivery e2e")"
[ -n "$N" ] && ok "setup: ready ticket #$N" || fail "setup: no ticket"

echo "== one tick: SANDBOX_PROVIDER=docker, real daemon =="
REFS_BEFORE="$(ddw_host_refs)"
OUT="$(ddw_run_tick)"
echo "    $OUT"
ddw_common_asserts "$N"
ddw_refs_asserts "$N" "$REFS_BEFORE"

[ "$(ddw_gate "$N" tests)" = "PASS node gate-probe.mjs --require && node --test" ] \
  && ok "the DoD tests gate PASSED with gate-probe --require: it ran in a container with no database, bridge socket, host HOME, canary or credential" \
  || fail "tests gate evidence: '$(ddw_gate "$N" tests)' (expected PASS for the --require probe command)"
[ ! -e "$CANARY_DIR/written-from-container" ] \
  && ok "nothing was written beside the host canary" || fail "a file appeared beside the host canary"
read -r LROWS LCOST <<<"$(ddw_ledger_cost "$N")"
if [ "$LIVE" = 1 ]; then
  [ "${LROWS:-0}" -ge 1 ] && awk -v c="${LCOST:-0}" 'BEGIN{exit !(c > 0)}' \
    && ok "the live envelope was parsed: the usage ledger booked a measured cost (\$$LCOST)" \
    || fail "usage ledger: rows=${LROWS:-?} cost=${LCOST:-?}"
  EV="$(ddw_evidence "$N")"
  case "$EV" in *"Agent run, attempt"*) ok "the agent run was recorded as evidence" ;; *) fail "no agent-run evidence on #$N" ;; esac
  echo "  note the live agent's own evidence (MCP round trip) is reported, not asserted: $(printf '%s' "$EV" | grep -vc 'Agent run, attempt' | tr -d ' ') other evidence row(s)"
else
  [ "${LROWS:-0}" -ge 1 ] && [ "${LCOST:-0}" = "0.0200" ] \
    && ok "the result envelope was parsed: the usage ledger booked its cost (\$$LCOST)" \
    || fail "usage ledger: rows=${LROWS:-?} cost=${LCOST:-?}"
  echo "== what the agent saw from inside the container (recorded through MCP) =="
  EV="$(ddw_evidence "$N" | grep 'docker-delivery-stub:' | head -1)"
  [ -n "$EV" ] && ok "the agent's record_ac_evidence reached the host DB through the bridge" || fail "no agent evidence on #$N"
  echo "    $EV" | cut -c1-400
  for want in INSIDE_CONTAINER TOKEN_ABSENT CREDENTIAL_FORWARDED MCP_CONFIG_BRIDGED GIT_SAFE_DIRECTORY EGRESS_PROXY_SET TMPDIR_USABLE PROBE_FILE DB_UNMOUNTED SETTINGS_ABSENT HOME_UNREADABLE CANARY_UNREADABLE HOST_WRITE_CONTAINED MCP_ROUND_TRIP MAIN_MOVED_INSIDE; do
    case " $EV " in *" $want "*) ok "agent probe: $want" ;; *) fail "agent probe: expected $want" ;; esac
  done
  for bad in NOT_IN_CONTAINER MAIN_MOVE_FAIL MAIN_MOVE_SKIPPED_NO_CONTAINER TOKEN_LEAK CREDENTIAL_MISSING MCP_CONFIG_NOT_BRIDGED GIT_SAFE_DIRECTORY_MISSING EGRESS_PROXY_MISSING TMPDIR_UNUSABLE NO_PROBE_FILE DB_VISIBLE SETTINGS_VISIBLE HOME_READABLE CANARY_LEAK HOST_WRITE_POSSIBLE; do
    case " $EV " in *" $bad "*) fail "agent probe: saw $bad" ;; esac
  done
  [ "$(ddw_acs_satisfied "$N")" = yes ] \
    && ok "the token-free evidence write satisfied the criterion (the claim token stayed on the host)" \
    || fail "acceptance criterion not satisfied ($(ddw_acs_satisfied "$N"))"
  BR="$(ddw_branch "$N")"
  grep -q 'INSIDE_CONTAINER.*MCP_OK' <<<"$(git -C "$R" log -1 --format=%B "$BR" 2>/dev/null)" \
    && ok "the commit on $BR was made inside the container (its probes are in the message)" \
    || fail "the branch tip was not committed by the in-container agent: $(git -C "$R" log -1 --format=%B "$BR" 2>/dev/null | tr '\n' ' ' | cut -c1-300)"
fi

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "sandbox-docker-delivery: ALL $PASS checks passed"; exit 0; fi
echo "sandbox-docker-delivery: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
echo "--- factory.log (tail) ---"; tail -40 "$GAFFER_DATA/factory.log" 2>/dev/null
echo "--- tick.stderr.log (tail) ---"; tail -40 "$GAFFER_DATA/tick.stderr.log" 2>/dev/null
ddw_save_evidence "$N"
exit 1
