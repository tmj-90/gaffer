#!/usr/bin/env bash
# =====================================================================
# OS isolation is the DEFAULT for every agent launch (task #47, package isolation-default).
# ---------------------------------------------------------------------
# GAFFER_STRICT_REQUIRE defaults to 1 in every mode (supervised included) and STRICT_MODE
# with it, so an agent runs inside the OS sandbox or does not run. The opt-out is
# GAFFER_STRICT_REQUIRE=0 in the ENVIRONMENT (settings.json cannot loosen it). The two
# SPEC criteria: a fresh Linux install without Docker refuses to run agents with a clear
# message; with Docker it runs sandboxed without configuration. Proves, on a PATH with
# neither sandbox-exec nor docker (every other tool is linked in) and the REAL tick,
# dispatch and config:
#   1. no opt-out: a live tick refuses BEFORE claiming (setup_error, rc non-zero), the
#      message names the host's situation, the fix and the opt-out, the ticket stays
#      ready, no branch, no agent call; `gaffer run` refuses the same way (exit 3) and
#      the dashboard's poll says "not polling"; the Node seam (the dashboard's
#      launchers: Plan a build, the spec author) refuses too, with the same message
#   2. GAFFER_STRICT_REQUIRE=0 in the environment: the same tick delivers, and the
#      opt-out is said exactly once
#   3. GAFFER_STRICT_REQUIRE=0 in settings.json alone does NOT opt out
#   4. a stub `docker` on PATH that answers the probes, no SANDBOX_PROVIDER, no
#      STRICT_MODE, no opt-out: the config picks docker, the gate passes, and both
#      worker seams wrap the launch in the docker wrapper
#   5. `gaffer sandbox-status` prints the posture as JSON (missing / available / opted out)
#   6. setup.sh on the no-provider PATH exits 0 and prints the posture and the fix; with
#      a docker CLI and a reachable daemon it builds the sandbox images (compose), and
#      skips with the exact command when the daemon is down or the build fails
#   7. a dry run on the no-provider PATH exits 0 and moves nothing
# Run: bash runner/test/isolation-default.test.sh   (bash 3.2 safe)
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
# shellcheck source=lib/skip.sh
. "$HERE/lib/skip.sh"
command -v node >/dev/null 2>&1 || gaffer_skip "node required"
command -v git >/dev/null 2>&1 || gaffer_skip "git required"
[ -f "$ROOT/packages/dispatch/dist/cli/index.js" ] || gaffer_skip "dispatch not built (pnpm -r build)"
[ -f "$ROOT/packages/crew/dist/runtime/context/renderPromptCli.js" ] || gaffer_skip "crew not built (pnpm -r build)"
command -v sandbox-exec >/dev/null 2>&1 && gaffer_skip "sandbox-exec is a system binary on this host (macOS): a PATH without it cannot be built here; the Linux CI cells run this"

export GAFFER_ALLOW_UNCAPPED=1
STUB_TICK_NAME=isolation-default
# shellcheck source=lib/stub-tick.sh
. "$HERE/lib/stub-tick.sh"
# The stub world sourced the config with the opt-out; every case below picks its own.
unset _GAFFER_STRICT_OPTOUT_WARNED

# A PATH with every executable this host has EXCEPT docker and sandbox-exec (a host
# docker CLI must not leak in): one directory of links, first match wins like PATH.
NOP="$WORK/nopbin"; mkdir -p "$NOP"
_old_ifs="$IFS"; IFS=:
for d in $PATH; do
  [ -d "$d" ] || continue
  for f in "$d"/*; do
    b="${f##*/}"
    case "$b" in docker | sandbox-exec | '*') continue ;; esac
    [ -x "$f" ] && [ ! -d "$f" ] && [ ! -e "$NOP/$b" ] && ln -s "$f" "$NOP/$b" 2>/dev/null
  done
done
IFS="$_old_ifs"
[ ! -e "$NOP/docker" ] && [ ! -e "$NOP/sandbox-exec" ] && [ -e "$NOP/node" ] && [ -e "$NOP/git" ] \
  && ok "the no-provider PATH has node and git and neither docker nor sandbox-exec" \
  || fail "could not build the no-provider PATH"

# Run a command in a FRESH environment for the requirement: no opt-out, nothing said yet.
fresh() { env -u GAFFER_STRICT_REQUIRE -u _GAFFER_STRICT_OPTOUT_WARNED -u STRICT_MODE -u SANDBOX_PROVIDER "$@"; }
tick_in() {  # $@ = NAME=value env → sets TOUT (stdout+stderr) and TRC
  TOUT="$(cd "$RUNNER_DIR" && fresh "$@" bash ./tick.sh 2>&1)"; TRC=$?
}
calls() { ls -1 "$CALLS" 2>/dev/null | wc -l | tr -d ' '; }

echo "== 1: no provider, no opt-out: every launch path refuses before it claims =="
T1="$(new_ready "isolation one" "deliver a helper")"
before="$(calls)"
tick_in PATH="$NOP"
[ "$TRC" -ne 0 ] && ok "the live tick exits non-zero (rc=$TRC)" || fail "the tick exited 0 with no sandbox: $(printf '%s' "$TOUT" | tail -3)"
case "$TOUT" in *"TICK_RESULT=setup_error"*) ok "it reports setup_error" ;; *) fail "no setup_error: $(printf '%s' "$TOUT" | grep TICK_RESULT)" ;; esac
LOGMSG="$(grep 'SANDBOX:' "$GAFFER_DATA/factory.log" 2>/dev/null | tail -1)"
case "$LOGMSG" in *"Docker is not installed"*"install Docker"*"GAFFER_STRICT_REQUIRE=0 in the environment"*)
  ok "the message names the host's situation, the fix and the opt-out" ;;
  *) fail "refusal message: '$LOGMSG'" ;; esac
[ "$(st "$T1")" = ready ] && ok "the ticket was not claimed (still ready)" || fail "ticket moved to $(st "$T1")"
[ -z "$(branch_of "$T1")" ] && ok "no delivery branch was cut" || fail "a branch exists: $(branch_of "$T1")"
[ "$(calls)" = "$before" ] && ok "no agent was launched" || fail "the stub agent ran with no sandbox"

GOUT="$(fresh PATH="$NOP" bash "$RUNNER_DIR/gaffer" run 2>&1)"; GRC=$?
[ "$GRC" = 3 ] && ok "gaffer run refuses a live run (exit 3)" || fail "gaffer run rc=$GRC: $(printf '%s' "$GOUT" | tail -3)"
case "$GOUT" in *"refusing a live run"*"install Docker"*"GAFFER_STRICT_REQUIRE=0"*"--dry-run"*) ok "gaffer run says why, the fix, the opt-out and the preview" ;;
  *) fail "gaffer run message: $GOUT" ;; esac
[ "$(st "$T1")" = ready ] && [ "$(calls)" = "$before" ] && ok "gaffer run moved nothing and launched nothing" || fail "gaffer run moved the ticket ($(st "$T1"))"

POUT="$(cd "$RUNNER_DIR" && fresh PATH="$NOP" bash ./bin/poll-once.sh 2>&1)"
case "$POUT" in *"gaffer poll: agents run inside an OS sandbox"*"not polling."*) ok "the dashboard's Poll for work refuses with the message" ;;
  *) fail "poll-once: $(printf '%s' "$POUT" | tail -3)" ;; esac
[ "$(st "$T1")" = ready ] && ok "the poll claimed nothing" || fail "the poll moved the ticket"

MARK="$WORK/node-spawned"; FAKE="$WORK/fake-agent.sh"
printf '#!/usr/bin/env bash\n: > "%s"\necho "{\\"result\\":\\"ok\\"}"\n' "$MARK" > "$FAKE"; chmod +x "$FAKE"
# (a leading `x`: worker.mjs runs its CLI when argv[1] is its own path)
node_deliver() {  # $@ = env → "<status>|<message>|<stdout>"
  ( cd "$WORK" && fresh "$@" node --input-type=module -e '
    const { Worker } = await import(process.argv[2]);
    const r = Worker.deliver({ bin: "bash", argv: [process.argv[3]], cwd: process.argv[4], timeoutMs: 20000, maxBuffer: 1 << 20, env: process.env });
    process.stdout.write(`${r.status}|${r.error ? r.error.message : ""}|${(r.stdout || "").replace(/\n/g, " ")}`);
  ' x "$RUNNER_DIR/lib/worker.mjs" "$FAKE" "$WORK" 2>/dev/null )
}
rm -f "$MARK"; NOUT="$(node_deliver PATH="$NOP")"
[ "${NOUT%%|*}" = 75 ] && [ ! -e "$MARK" ] && ok "the Node seam (dashboard launchers) refuses: status 75, nothing spawned" \
  || fail "Node seam: ${NOUT%%|*} spawned=$([ -e "$MARK" ] && echo yes || echo no)"
case "$NOUT" in *"install Docker"*"GAFFER_STRICT_REQUIRE=0"*) ok "the Node refusal carries the same message" ;; *) fail "Node message: $NOUT" ;; esac

# The dashboard's launchers on top of that seam: Plan a build (decompose) and the spec
# author (which used to spawn claude itself, outside the seam, under claude-code).
AGENT_MARK="$WORK/launcher-agent-ran"
printf '#!/usr/bin/env bash\n: > "%s"\necho "{\\"type\\":\\"result\\",\\"result\\":\\"{}\\"}"\n' "$AGENT_MARK" > "$WORK/launcher-claude"
chmod +x "$WORK/launcher-claude"
for helper in decompose spec-author; do
  rm -f "$AGENT_MARK"
  LOUT="$(cd "$WORK" && echo '{"brief":"a todo app"}' | fresh PATH="$NOP" CLAUDE_BIN="$WORK/launcher-claude" node "$RUNNER_DIR/bin/$helper.mjs" 2>&1 | tail -n 3)"
  [ ! -e "$AGENT_MARK" ] && ok "$helper: no agent launched with no sandbox" || fail "$helper launched the agent unwrapped"
  case "$LOUT" in *"install Docker"*) ok "$helper: the refusal names the fix" ;; *) fail "$helper output: $LOUT" ;; esac
done

echo "== 2: GAFFER_STRICT_REQUIRE=0 in the environment: the same run proceeds, said once =="
tick_in PATH="$NOP" GAFFER_STRICT_REQUIRE=0
case "$TOUT" in *"TICK_RESULT=worked"*) ok "the tick delivers under the opt-out" ;; *) fail "opt-out tick: $(printf '%s' "$TOUT" | grep TICK_RESULT)" ;; esac
[ "$(st "$T1")" = in_review ] && ok "the ticket went to review" || fail "ticket is $(st "$T1")"
n="$(printf '%s\n' "$TOUT" | grep -c 'WARNING: GAFFER_STRICT_REQUIRE=0 in the environment')"
[ "$n" = 1 ] && ok "the opt-out is logged loudly exactly once" || fail "opt-out warning count: $n"
retire "$T1"
rm -f "$MARK"; NOUT="$(node_deliver PATH="$NOP" GAFFER_STRICT_REQUIRE=0)"
[ "${NOUT%%|*}" = 0 ] && [ -e "$MARK" ] && ok "the Node seam launches under the environment opt-out" || fail "Node opt-out: $NOUT"

echo "== 3: GAFFER_STRICT_REQUIRE=0 in settings.json alone does not opt out =="
T3="$(new_ready "isolation three" "deliver a helper")"
printf '{"GAFFER_STRICT_REQUIRE":"0"}\n' > "$GAFFER_DATA/settings.json"
before="$(calls)"
tick_in PATH="$NOP"
case "$TOUT" in *"TICK_RESULT=setup_error"*) ok "the tick still refuses" ;; *) fail "settings.json opted out: $(printf '%s' "$TOUT" | grep TICK_RESULT)" ;; esac
case "$TOUT" in *"ignoring GAFFER_STRICT_REQUIRE=0 from settings.json"*) ok "and says it ignored the settings.json value" ;; *) fail "no 'ignoring' line" ;; esac
[ "$(st "$T3")" = ready ] && [ "$(calls)" = "$before" ] && ok "nothing claimed, nothing launched" || fail "ticket $(st "$T3")"
GOUT="$(fresh PATH="$NOP" bash "$RUNNER_DIR/gaffer" run 2>&1)"; GRC=$?
[ "$GRC" = 3 ] && ok "gaffer run refuses too" || fail "gaffer run rc=$GRC with settings.json opt-out"
rm -f "$GAFFER_DATA/settings.json"

echo "== 4: a docker CLI that answers the probes: docker, sandboxed, no configuration =="
DBIN="$WORK/dockbin"; mkdir -p "$DBIN"
cat > "$DBIN/docker" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "${FAKE_DOCKER_LOG:-/dev/null}"
case "${1:-}" in
  info) exit 0 ;;
  image) [ "${2:-}" = inspect ] && exit 0 ;;
  compose) [ -n "${FAKE_DOCKER_BUILD_FAIL:-}" ] && exit 1; exit 0 ;;
esac
exit 0
STUB
chmod +x "$DBIN/docker"
CFG="$(cd "$WORK" && fresh PATH="$DBIN:$NOP" bash -c '
  source "$1/factory.config.sh" >/dev/null 2>&1
  printf "%s|%s|%s|" "$SANDBOX_PROVIDER" "$STRICT_MODE" "$GAFFER_STRICT_REQUIRE"
  gaffer_isolation_gate && printf gate-ok || printf gate-refused' x "$RUNNER_DIR")"
[ "$CFG" = "docker|1|1|gate-ok" ] && ok "the config picks docker, STRICT_MODE=1, required, and the gate passes" || fail "docker config: $CFG"
SEAM="$(cd "$WORK" && fresh PATH="$DBIN:$NOP" GAFFER_SANDBOX_DRY_RUN=1 bash -c '
  source "$1/factory.config.sh" >/dev/null 2>&1
  WORKER_CALL_ENV=( "GAFFER_WRITE_ROOTS=$2" "GAFFER_READ_ROOTS=" )
  printf "{}" > "$2/mcp.json"
  worker_deliver "$2" "the prompt" "" "$2/mcp.json" "$2/out.json" "" 2>/dev/null; echo "rc=$?"' x "$RUNNER_DIR" "$WORK")"
case "$SEAM" in *"rc=0"*) ok "worker_deliver launched (rc 0)" ;; *) fail "worker_deliver: $SEAM" ;; esac
grep -qx -- "$WORK:$WORK:rw" "$WORK/out.json" && grep -qx claude "$WORK/out.json" \
  && ok "the bash seam's launch is wrapped in the docker sandbox (the write root mounted, the image's claude)" \
  || fail "no docker wrap in the bash seam: $(tr '\n' ' ' < "$WORK/out.json" | cut -c1-200)"
rm -f "$MARK"; NOUT="$(node_deliver PATH="$DBIN:$NOP" GAFFER_SANDBOX_DRY_RUN=1)"
[ "${NOUT%%|*}" = 0 ] && [ ! -e "$MARK" ] && ok "the Node seam's launch is wrapped (the host agent did not run directly)" || fail "Node docker: $NOUT"
case "$NOUT" in *"$WORK:$WORK:rw"*) ok "…in the docker wrapper (the write root mounted rw)" ;; *) fail "Node docker argv: $NOUT" ;; esac

echo "== 5: gaffer sandbox-status =="
J="$(fresh PATH="$NOP" bash "$RUNNER_DIR/gaffer" sandbox-status 2>/dev/null)"
jv() { printf '%s' "$J" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const d=JSON.parse(s);process.stdout.write(String(d[process.argv[1]]))})' "$1"; }
[ "$(jv provider)|$(jv available)|$(jv required)|$(jv optedOut)" = "sandbox-exec|false|true|false" ] && ok "no provider: missing and required" || fail "status: $J"
case "$(jv fix)" in *"install Docker"*) ok "…with the fix" ;; *) fail "status fix: $J" ;; esac
J="$(fresh PATH="$DBIN:$NOP" bash "$RUNNER_DIR/gaffer" sandbox-status 2>/dev/null)"
[ "$(jv provider)|$(jv available)|$(jv required)" = "docker|true|true" ] && ok "docker answering: available and required" || fail "status docker: $J"
J="$(fresh PATH="$NOP" GAFFER_STRICT_REQUIRE=0 bash "$RUNNER_DIR/gaffer" sandbox-status 2>/dev/null)"
[ "$(jv required)|$(jv optedOut)" = "false|true" ] && ok "the environment opt-out reads as opted out" || fail "status opt-out: $J"

echo "== 6: setup never fails for lack of a sandbox =="
HR="$WORK/home-real"; mkdir -p "$HR" "$WORK/pnpmbin"
printf '{"name":"g","engines":{"node":">=18"}}\n' > "$HR/package.json"
ln -s "$ROOT/packages" "$HR/packages"
printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/pnpmbin/pnpm"; chmod +x "$WORK/pnpmbin/pnpm"
setup_in() {  # $1 = data dir, then NAME=value env
  local d="$1"; shift
  SOUT="$(fresh GAFFER_HOME="$HR" GAFFER_DATA="$d" "$@" bash "$RUNNER_DIR/setup.sh" 2>&1)"; SRC=$?
}
setup_in "$WORK/sd1" PATH="$WORK/pnpmbin:$NOP"
[ "$SRC" = 0 ] && ok "setup.sh exits 0 on a host with no sandbox" || fail "setup rc=$SRC: $(printf '%s' "$SOUT" | tail -4)"
case "$SOUT" in *"OS sandbox: sandbox-exec, missing: this is "*"Docker is not installed"*"Fix: install Docker"*"GAFFER_STRICT_REQUIRE=0 in the environment"*)
  ok "it prints the posture (provider, missing, what) and the exact fix and opt-out" ;; *) fail "setup posture: $(printf '%s' "$SOUT" | sed -n '/agent isolation/,$p')" ;; esac
export FAKE_DOCKER_LOG="$WORK/docker.log"; : > "$FAKE_DOCKER_LOG"
setup_in "$WORK/sd2" PATH="$WORK/pnpmbin:$DBIN:$NOP"
[ "$SRC" = 0 ] && grep -qx 'compose --profile sandbox build sandbox-image egress-proxy' "$FAKE_DOCKER_LOG" \
  && ok "with a reachable daemon setup builds the sandbox images (docker compose --profile sandbox build sandbox-image egress-proxy)" \
  || fail "no image build: rc=$SRC log=$(cat "$FAKE_DOCKER_LOG")"
case "$SOUT" in *"building the docker sandbox images"*"✓ sandbox images built"*"OS sandbox: docker, available"*) ok "with a line before and after, then the posture" ;;
  *) fail "build lines: $(printf '%s' "$SOUT" | sed -n '/agent isolation/,$p')" ;; esac
setup_in "$WORK/sd3" PATH="$WORK/pnpmbin:$DBIN:$NOP" FAKE_DOCKER_BUILD_FAIL=1
[ "$SRC" = 0 ] && ok "a failed image build does not fail setup" || fail "setup rc=$SRC on a failed build"
case "$SOUT" in *"image build failed"*"retry with: (cd $HR && docker compose --profile sandbox build sandbox-image egress-proxy)"*) ok "it skips with the exact command" ;;
  *) fail "failed-build line: $(printf '%s' "$SOUT" | sed -n '/agent isolation/,$p')" ;; esac
DOWN="$WORK/downbin"; mkdir -p "$DOWN"
printf '#!/usr/bin/env bash\necho "$*" >> "$FAKE_DOCKER_LOG"\n[ "${1:-}" = info ] && exit 1\nexit 0\n' > "$DOWN/docker"; chmod +x "$DOWN/docker"
: > "$FAKE_DOCKER_LOG"
setup_in "$WORK/sd4" PATH="$WORK/pnpmbin:$DOWN:$NOP"
[ "$SRC" = 0 ] && ! grep -q '^compose' "$FAKE_DOCKER_LOG" && ok "an unreachable daemon: no build attempted, setup exits 0" || fail "daemon down: rc=$SRC log=$(cat "$FAKE_DOCKER_LOG")"
case "$SOUT" in *"docker daemon not reachable"*"(cd $HR && docker compose --profile sandbox build sandbox-image egress-proxy)"*"daemon is not reachable"*) ok "it skips with the exact command and names the missing daemon" ;;
  *) fail "daemon-down lines: $(printf '%s' "$SOUT" | sed -n '/agent isolation/,$p')" ;; esac
unset FAKE_DOCKER_LOG

echo "== 7: a dry run needs no sandbox =="
T7="$(new_ready "isolation seven" "deliver a helper")"
before="$(calls)"
DOUT="$(fresh PATH="$NOP" bash "$RUNNER_DIR/gaffer" run --dry-run 2>&1)"; DRC=$?
[ "$DRC" = 0 ] && ok "gaffer run --dry-run exits 0 on the no-provider PATH" || fail "dry run rc=$DRC: $(printf '%s' "$DOUT" | tail -3)"
tick_in PATH="$NOP" DRY_RUN=1
[ "$TRC" = 0 ] && ok "a DRY_RUN=1 tick exits 0" || fail "dry tick rc=$TRC: $(printf '%s' "$TOUT" | grep TICK_RESULT)"
[ "$(st "$T7")" = ready ] && [ "$(calls)" = "$before" ] && ok "the dry runs moved nothing and launched nothing" || fail "dry run moved $(st "$T7")"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "isolation-default: ALL $PASS checks passed"
  exit 0
fi
echo "isolation-default: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
