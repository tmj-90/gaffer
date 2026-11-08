#!/usr/bin/env bash
# =====================================================================
# THE COMMAND WORKER PROVIDER (GAFFER_WORKER_PROVIDER=command), end to end.
# ---------------------------------------------------------------------
# A second, real worker provider: the runner runs an operator-supplied program
# (GAFFER_WORKER_COMMAND) under the contract in docs/worker-providers.md. It has no
# in-process safety hook (that lives inside `claude -p`), so the containment rule is:
# launching it REQUIRES an OS sandbox wrap, unless the operator sets
# GAFFER_STRICT_REQUIRE=0 to assert containment out-of-band (logged loudly).
#
#   1. config: provider=command defaults GAFFER_STRICT_REQUIRE=1 + STRICT_MODE=1 and
#      says why; an explicit GAFFER_STRICT_REQUIRE=0 is honoured with a loud WARNING.
#   2. seam containment (lib/worker.sh worker_deliver): no sandbox → rc 75, nothing
#      spawned, no envelope, and the refusal names the fix; the opt-out runs with a
#      WARNING; a misconfigured command refuses rc 70; the budget admission refuses
#      rc 77 before the spawn; a worker cannot fake a runner refusal code.
#      Only the docker sandbox counts (sandbox-exec leaves $GAFFER_DATA writable, and
#      only claude-code's in-process hook guards it), and only with the host-side MCP
#      bridge (the legacy layout mounts the databases read-write); a caller-supplied
#      non-docker wrap is refused too.
#   2b. hardening: settings.json cannot pick the provider, the program or its env, nor
#      opt the command worker out of the sandbox; the program must live outside every
#      directory an agent can write; a prompt too big for the environment still
#      reaches the worker (GAFFER_WORKER_PROMPT_FILE); an unreported or under-reported
#      cost is booked at the per-call floor; under docker the call's MCP config and
#      prompt file are mounted and no claude credential is forwarded.
#   3. a REAL tick.sh delivery under a fake docker (the real sandbox-docker.sh wrapper,
#      a `docker` stub that records the mounts and runs the command locally) and the
#      real host-side MCP bridge: the stub command worker edits the worktree, talks to
#      the dispatch MCP server through the bridge, returns its envelope; the ticket
#      reaches in_review, the DoD gates ran (inside the same wrap), the usage ledger
#      row names the provider and the reported cost, and `claude` was never run.
#   4. the same tick with no sandbox available refuses before the spawn and parks the
#      ticket with strict_require_unavailable.
#   5. the greenfield repo classifier (the one lane that spawned `claude` outside the
#      seam) goes through the command worker too: no paid claude call.
# Run: bash runner/test/worker-command.test.sh   (bash 3.2 ok)
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
DISPATCH_CLI="$ROOT/packages/dispatch/dist/cli/index.js"
MEMORY_CLI="$ROOT/packages/memory/dist/bin/memory.js"
FIXTURE="$HERE/fixtures/command-worker.mjs"
# shellcheck source=lib/skip.sh
. "$HERE/lib/skip.sh"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/worker-command.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
trap 'gaffer_test_rm_work "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/probe-data"

# A fake OS sandbox: SANDBOX_PROVIDER=sandbox-exec finds this on PATH, and sandbox.sh
# hands back `sandbox-exec -f <profile>` as the wrap. It records every wrapped command
# and runs it (no real containment: a test seam that proves the wrap is APPLIED).
SBX_LOG="$WORK/sandbox-exec.log"; : > "$SBX_LOG"
cat > "$WORK/bin/sandbox-exec" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$SBX_LOG"
[ "\$1" = "-f" ] && shift 2
exec "\$@"
EOF
chmod +x "$WORK/bin/sandbox-exec"
# A fake docker: `docker info` and the egress-proxy plumbing succeed, `docker run` records
# its mounts (-v) and forwarded env names (-e), then runs the command after the image
# locally (no containment: a test seam that proves the REAL sandbox-docker.sh wrapper
# was applied and what it would have mounted).
DOCKER_LOG="$WORK/docker.log"; : > "$DOCKER_LOG"
mkdir -p "$WORK/dockerbin"
cat > "$WORK/dockerbin/docker" <<EOF
#!/usr/bin/env bash
case "\$1" in
  ps) echo fake-proxy; exit 0 ;;
  run) ;;
  *) exit 0 ;;
esac
shift
for a in "\$@"; do [ "\$a" = -d ] && exit 0; done
line="RUN"; w=""
while [ "\$#" -gt 0 ]; do
  case "\$1" in
    fake-sbx-image) shift; break ;;
    -w) w="\$2"; shift 2 ;;
    -v|-e|--tmpfs) line="\$line \$1 \$2"; shift 2 ;;
    --network|--pids-limit|--memory|--cpus|--name) shift 2 ;;
    *) shift ;;
  esac
done
printf '%s\n' "\$line" >> "$DOCKER_LOG"
printf 'CMD %s\n' "\$*" >> "$DOCKER_LOG"
[ -n "\$w" ] && cd "\$w"
exec "\$@"
EOF
chmod +x "$WORK/dockerbin/docker"
DOCKER_ENV=( SANDBOX_PROVIDER=docker GAFFER_SANDBOX_IMAGE=fake-sbx-image GAFFER_SANDBOX_PATH="$PATH" GAFFER_MCP_BRIDGE=1 )
# The worker program the tests run: a copy of the fixture OUTSIDE every write root and
# $GAFFER_DATA, mode 755 whatever the checkout's umask was.
mkdir -p "$WORK/tools"
cp "$FIXTURE" "$WORK/tools/command-worker.mjs"; chmod 755 "$WORK/tools/command-worker.mjs"
FIXTURE="$WORK/tools/command-worker.mjs"
# A tripwire `claude`: the command provider must never run it.
CLAUDE_TRIP="$WORK/claude-ran"
printf '#!/usr/bin/env bash\n: > "%s"\nprintf "{}\\n"\n' "$CLAUDE_TRIP" > "$WORK/bin/claude"
chmod +x "$WORK/bin/claude"
chmod +x "$FIXTURE" 2>/dev/null || true

# ── 1. config defaults ──────────────────────────────────────────────────────
echo "== 1: config — the command provider makes the OS sandbox mandatory =="
probe() {
  env -i PATH="$PATH" HOME="$HOME" GAFFER_DATA="$WORK/probe-data" "$@" \
    bash -c 3>"$WORK/probe.prov" '
      source "'"$RUNNER_DIR"'/factory.config.sh" 2>"'"$WORK"'/probe.err" >/dev/null
      printf "STRICT_MODE=%s STRICT_REQUIRE=%s\n" "${STRICT_MODE:-}" "${GAFFER_STRICT_REQUIRE:-}"
      printf "PROVIDER=%s COMMAND=%s CMDENV=%s\n" "${GAFFER_WORKER_PROVIDER:-}" "${GAFFER_WORKER_COMMAND:-}" "${GAFFER_WORKER_COMMAND_ENV:-}" >&3
    '
}
got="$(probe)"
# OS isolation is the default for every launch (isolation-default.test.sh): claude-code
# requires the sandbox too; the command provider adds its own, stronger rule (docker).
[ "$got" = "STRICT_MODE=1 STRICT_REQUIRE=1" ] && ok "claude-code (default): the sandbox is required by default" \
  || fail "default provider should require the sandbox by default (got: $got)"
got="$(probe GAFFER_WORKER_PROVIDER=command GAFFER_WORKER_COMMAND="$FIXTURE")"
[ "$got" = "STRICT_MODE=1 STRICT_REQUIRE=1" ] && ok "provider=command → STRICT_MODE=1 + GAFFER_STRICT_REQUIRE=1" \
  || fail "provider=command should default the sandbox on and required (got: $got)"
grep -q "GAFFER_WORKER_PROVIDER=command" "$WORK/probe.err" && grep -q "safety hook" "$WORK/probe.err" \
  && ok "…and says why (no in-process safety hook)" || fail "no notice for the command provider default (stderr: $(cat "$WORK/probe.err"))"
got="$(probe GAFFER_WORKER_PROVIDER=command GAFFER_WORKER_COMMAND="$FIXTURE" GAFFER_STRICT_REQUIRE=0)"
[ "$got" = "STRICT_MODE=0 STRICT_REQUIRE=0" ] && ok "explicit GAFFER_STRICT_REQUIRE=0 is honoured" \
  || fail "the opt-out should be honoured (got: $got)"
grep -q "^WARNING: GAFFER_WORKER_PROVIDER=command" "$WORK/probe.err" && grep -q "out-of-band" "$WORK/probe.err" \
  && ok "…and logged loudly (WARNING naming out-of-band containment)" || fail "the opt-out was not logged loudly (stderr: $(cat "$WORK/probe.err"))"

# settings.json lives in $GAFFER_DATA, which an agent's sandbox may be able to write, so
# none of the command worker's knobs and not its opt-out may come from there.
printf '{"GAFFER_WORKER_PROVIDER":"command","GAFFER_WORKER_COMMAND":"%s","GAFFER_WORKER_COMMAND_ENV":"GITHUB_TOKEN"}\n' "$FIXTURE" > "$WORK/probe-data/settings.json"
probe >/dev/null
[ "$(cat "$WORK/probe.prov")" = "PROVIDER=claude-code COMMAND= CMDENV=" ] \
  && ok "settings.json cannot pick the worker provider, its program or its env (env-only)" \
  || fail "settings.json set the worker knobs: $(cat "$WORK/probe.prov")"
printf '{"GAFFER_STRICT_REQUIRE":"0"}\n' > "$WORK/probe-data/settings.json"
got="$(probe GAFFER_WORKER_PROVIDER=command GAFFER_WORKER_COMMAND="$FIXTURE")"
[ "$got" = "STRICT_MODE=1 STRICT_REQUIRE=1" ] && ok "settings.json GAFFER_STRICT_REQUIRE=0 does not opt the command worker out" \
  || fail "a settings.json opt-out was honoured for the command worker (got: $got)"
got="$(probe)"
[ "$got" = "STRICT_MODE=1 STRICT_REQUIRE=1" ] && ok "…and does not opt claude-code out either (the opt-out is environment-only for every provider)" \
  || fail "a settings.json opt-out was honoured for claude-code (got: $got)"
rm -f "$WORK/probe-data/settings.json"

# ── 2. seam containment ─────────────────────────────────────────────────────
echo "== 2: worker_deliver — containment rule at the seam =="
export GAFFER_DATA="$WORK/seam-data"; mkdir -p "$GAFFER_DATA"
export CLAUDE_BIN="$WORK/bin/claude"
unset GAFFER_STRICT_REQUIRE STRICT_MODE
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
unset GAFFER_STRICT_REQUIRE STRICT_MODE
export GAFFER_ALLOW_UNCAPPED=1
MCP="$WORK/mcp.json"; printf '{}' > "$MCP"
CWD="$WORK/cwd"; mkdir -p "$CWD"
CALLS="$GAFFER_DATA/command-worker.jsonl"
# run_cmd <env assignments…> — worker_deliver in a fresh shell. RC_WRAP (a caller wrap),
# RC_MCP (the MCP config) and RC_PROMPT_FILE (read the prompt from a file) override the
# defaults for one call.
run_cmd() {
  local out="$WORK/out.json" errf="$WORK/err"
  : > "$out"; : > "$CALLS"
  env RC_CWD="$CWD" RC_MCP="$MCP" RC_OUT="$out" RC_WRAP="" RC_PROMPT_FILE="" "$@" \
    bash -c '
    source "'"$RUNNER_DIR"'/factory.config.sh" >/dev/null 2>&1
    p="the prompt"; [ -n "$RC_PROMPT_FILE" ] && p="$(cat "$RC_PROMPT_FILE")"
    WORKER_CALL_ENV=( "GAFFER_WRITE_ROOTS=$RC_CWD" "GAFFER_READ_ROOTS=" "GAFFER_DATA=$GAFFER_DATA" )
    worker_deliver "$RC_CWD" "$p" "--model stub-model" "$RC_MCP" "$RC_OUT" "$RC_WRAP" 7
  ' 2>"$errf"
  RC=$?; OUT_SIZE="$(wc -c < "$out" | tr -d ' ')"; ERR="$(cat "$errf")"
  RAN=0; [ -s "$CALLS" ] && RAN=1
  cp "$out" "$WORK/last-out.json" 2>/dev/null || true
}
BASE=( PATH="$WORK/bin:$PATH" GAFFER_WORKER_PROVIDER=command GAFFER_WORKER_COMMAND="$FIXTURE" )

run_cmd "${BASE[@]}" SANDBOX_PROVIDER=none
[ "$RC" = "75" ] && ok "no sandbox available → rc 75 (fail closed)" || fail "expected rc 75 without a sandbox (got $RC; $ERR)"
[ "$RAN" = "0" ] && ok "…the command worker was NOT spawned" || fail "the command worker ran without a sandbox"
[ "$OUT_SIZE" = "0" ] && ok "…no envelope written" || fail "an envelope was written ($OUT_SIZE bytes)"
case "$ERR" in *"GAFFER_WORKER_PROVIDER=command"*"SANDBOX_PROVIDER=docker"*"GAFFER_STRICT_REQUIRE=0"*) ok "…the refusal names the cause and the fix" ;;
  *) fail "the refusal does not name the cause and the fix (got: $ERR)" ;; esac

run_cmd "${BASE[@]}" SANDBOX_PROVIDER=none GAFFER_STRICT_REQUIRE=1
[ "$RC" = "75" ] && [ "$RAN" = "0" ] && ok "GAFFER_STRICT_REQUIRE=1 + no sandbox → rc 75, no spawn" || fail "strict-require + no sandbox should refuse (rc=$RC ran=$RAN)"

mkdir -p "$WORK/baddocker"; printf '#!/usr/bin/env bash\nexit 1\n' > "$WORK/baddocker/docker"; chmod +x "$WORK/baddocker/docker"
run_cmd "${BASE[@]}" SANDBOX_PROVIDER=docker GAFFER_STRICT_REQUIRE=yes PATH="$WORK/baddocker:$WORK/bin:$PATH"
[ "$RC" = "75" ] && [ "$RAN" = "0" ] && ok "docker selected but unavailable → rc 75, no spawn" || fail "docker unavailable should refuse (rc=$RC ran=$RAN)"

run_cmd "${BASE[@]}" SANDBOX_PROVIDER=none GAFFER_STRICT_REQUIRE=0
[ "$RC" = "0" ] && [ "$RAN" = "1" ] && ok "explicit GAFFER_STRICT_REQUIRE=0 → the worker runs (operator asserts out-of-band containment)" \
  || fail "the opt-out should run the worker (rc=$RC ran=$RAN; $ERR)"
case "$ERR" in *"WARNING: GAFFER_WORKER_PROVIDER=command"*"no OS sandbox"*) ok "…logged loudly at the spawn" ;; *) fail "the opt-out spawn was not logged loudly (got: $ERR)" ;; esac

# sandbox-exec is a write-only boundary whose profile still grants writes under
# $GAFFER_DATA (SECURITY.md, command workers): settings.json, the databases, the usage ledger.
# claude-code's in-process hook refuses those writes; a command worker has none, so
# sandbox-exec does not count as containment for it (a fake one on PATH here, so the
# refusal is the policy, not a missing binary).
: > "$SBX_LOG"
run_cmd "${BASE[@]}" SANDBOX_PROVIDER=sandbox-exec
[ "$RC" = "75" ] && [ "$RAN" = "0" ] && ok "SANDBOX_PROVIDER=sandbox-exec (available) → rc 75, the command worker NOT spawned" \
  || fail "sandbox-exec must not count as containment for the command worker (rc=$RC ran=$RAN; $ERR)"
case "$ERR" in *sandbox-exec*GAFFER_DATA*SANDBOX_PROVIDER=docker*) ok "…the refusal says why (sandbox-exec leaves \$GAFFER_DATA writable) and names docker" ;;
  *) fail "the sandbox-exec refusal does not explain itself (got: $ERR)" ;; esac
[ ! -s "$SBX_LOG" ] && ok "…and nothing ran under sandbox-exec" || fail "something ran under sandbox-exec: $(cat "$SBX_LOG")"
run_cmd "${BASE[@]}" SANDBOX_PROVIDER=sandbox-exec RC_WRAP="$WORK/bin/sandbox-exec -f /dev/null"
[ "$RC" = "75" ] && [ "$RAN" = "0" ] && ok "a caller-supplied sandbox-exec wrap is refused the same way (rc 75)" \
  || fail "a caller-supplied non-docker wrap let the command worker run (rc=$RC ran=$RAN; $ERR)"
run_cmd "${BASE[@]}" "${DOCKER_ENV[@]}" PATH="$WORK/dockerbin:$WORK/bin:$PATH" RC_WRAP="$WORK/bin/sandbox-exec -f /dev/null"
[ "$RC" = "75" ] && [ "$RAN" = "0" ] && ok "SANDBOX_PROVIDER=docker but a non-docker caller wrap → rc 75" \
  || fail "a non-docker wrap under SANDBOX_PROVIDER=docker let the command worker run (rc=$RC ran=$RAN; $ERR)"

# docker WITHOUT the host-side MCP bridge is the legacy layout: the dispatch and memory
# databases are mounted read-write into the container, where the command worker could
# rewrite ticket state with no hook to stop it.
SRVMCP="$WORK/mcp-servers.json"
printf '{"mcpServers":{"dispatch":{"command":"%s","args":["-e","0"],"env":{"GAFFER_CLAIM_TOKEN":"TOPSECRET_CLAIM"}}}}\n' "$(command -v node)" > "$SRVMCP"
: > "$DOCKER_LOG"
run_cmd "${BASE[@]}" "${DOCKER_ENV[@]}" PATH="$WORK/dockerbin:$WORK/bin:$PATH" GAFFER_MCP_BRIDGE=0 RC_MCP="$SRVMCP"
[ "$RC" = "75" ] && [ "$RAN" = "0" ] && ok "docker with GAFFER_MCP_BRIDGE=0 (databases in the container) → rc 75, no spawn" \
  || fail "the legacy docker layout let the command worker run (rc=$RC ran=$RAN; $ERR)"
case "$ERR" in *GAFFER_MCP_BRIDGE*) ok "…naming GAFFER_MCP_BRIDGE" ;; *) fail "the legacy-layout refusal does not name the bridge (got: $ERR)" ;; esac

: > "$DOCKER_LOG"
run_cmd "${BASE[@]}" "${DOCKER_ENV[@]}" PATH="$WORK/dockerbin:$WORK/bin:$PATH" ANTHROPIC_API_KEY=sk-test-not-real CLAUDE_CODE_OAUTH_TOKEN=oat-test-not-real RC_MCP="$SRVMCP"
[ "$RC" = "0" ] && [ "$RAN" = "1" ] && ok "docker + the MCP bridge → the worker runs (rc 0)" || fail "the docker-wrapped worker should run (rc=$RC ran=$RAN; $ERR)"
grep -q "^CMD env -i .* $FIXTURE\$" "$DOCKER_LOG" \
  && ok "…INSIDE the docker wrapper (env -i … $(basename "$FIXTURE") after the image)" || fail "the worker did not run under the docker wrap (log: $(cat "$DOCKER_LOG"))"
BRIDGED="$(sed -n 's/.*GAFFER_WORKER_MCP_CONFIG=\([^ ]*\).*/\1/p' "$DOCKER_LOG" | head -1)"
case "$BRIDGED" in *.bridge.json) ok "…handed the BRIDGED MCP config" ;; *) fail "the worker was not handed the bridged config (got: ${BRIDGED:-<none>})" ;; esac
grep -q -- "-v $BRIDGED:$BRIDGED:ro" "$DOCKER_LOG" && ok "…and the wrapper mounts that config read-only (the worker can read it inside)" \
  || fail "the bridged MCP config is not mounted into the container (log: $(head -1 "$DOCKER_LOG"))"
grep -q "TOPSECRET_CLAIM" "$DOCKER_LOG" && fail "the claim token reached the container argv" || ok "…and the claim token stays host-side (not in the container argv)"
grep -q -- "-e ANTHROPIC_API_KEY\|-e CLAUDE_CODE_OAUTH_TOKEN" "$DOCKER_LOG" \
  && fail "the claude credential was forwarded into the command worker's container" \
  || ok "…and no claude credential is forwarded into the command worker's container"
[ ! -e "$CLAUDE_TRIP" ] && ok "…and claude was never run" || fail "the command provider ran claude"

run_cmd PATH="$WORK/dockerbin:$WORK/bin:$PATH" "${DOCKER_ENV[@]}" GAFFER_WORKER_PROVIDER=command
[ "$RC" = "70" ] && [ "$RAN" = "0" ] && ok "GAFFER_WORKER_COMMAND unset → rc 70, no spawn" || fail "unset command should refuse rc 70 (rc=$RC)"
case "$ERR" in *GAFFER_WORKER_COMMAND*) ok "…naming GAFFER_WORKER_COMMAND" ;; *) fail "the misconfig refusal should name GAFFER_WORKER_COMMAND (got: $ERR)" ;; esac
run_cmd PATH="$WORK/dockerbin:$WORK/bin:$PATH" "${DOCKER_ENV[@]}" GAFFER_WORKER_PROVIDER=command GAFFER_WORKER_COMMAND=relative/worker
[ "$RC" = "70" ] && [ "$RAN" = "0" ] && ok "a relative GAFFER_WORKER_COMMAND → rc 70" || fail "relative command should refuse (rc=$RC)"
printf 'not executable\n' > "$WORK/noexec"; chmod -x "$WORK/noexec"
run_cmd PATH="$WORK/dockerbin:$WORK/bin:$PATH" "${DOCKER_ENV[@]}" GAFFER_WORKER_PROVIDER=command GAFFER_WORKER_COMMAND="$WORK/noexec"
[ "$RC" = "70" ] && ok "a non-executable GAFFER_WORKER_COMMAND → rc 70" || fail "non-executable command should refuse (rc=$RC)"

# The budget admission runs BEFORE the containment check and the spawn.
mkdir -p "$WORK/budget-data"
printf '{"ts":"%s","kind":"delivery","measured":true,"total_cost_usd":9}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$WORK/budget-data/usage-ledger.jsonl"
run_cmd "${BASE[@]}" "${DOCKER_ENV[@]}" PATH="$WORK/dockerbin:$WORK/bin:$PATH" GAFFER_ALLOW_UNCAPPED=0 GAFFER_DAILY_BUDGET_USD=1 GAFFER_USAGE_LEDGER="$WORK/budget-data/usage-ledger.jsonl"
[ "$RC" = "77" ] && [ "$RAN" = "0" ] && ok "daily budget spent → the budget admission refuses rc 77, nothing spawned" \
  || fail "the budget admission should refuse the command worker (rc=$RC ran=$RAN; $ERR)"

run_cmd "${BASE[@]}" "${DOCKER_ENV[@]}" PATH="$WORK/dockerbin:$WORK/bin:$PATH" GAFFER_TEST_COMMAND_WORKER_EXIT=77
[ "$RC" = "1" ] && ok "a worker exiting 77 cannot pose as the runner's budget refusal (remapped to 1)" || fail "reserved exit code not remapped (rc=$RC)"

# ── 2b. hardening ───────────────────────────────────────────────────────────
echo "== 2b: hardening — where the program lives, settings.json, prompt size, cost floor =="
DBASE=( "${BASE[@]}" "${DOCKER_ENV[@]}" PATH="$WORK/dockerbin:$WORK/bin:$PATH" )
# The program must live outside every directory an agent can write: a copy in the write
# root (the worktree), one in $GAFFER_DATA, a symlink in the write root to a good copy
# (the agent could re-point it), and a group-writable copy are all refused.
cp "$FIXTURE" "$CWD/worker-in-root.mjs"; chmod 755 "$CWD/worker-in-root.mjs"
cp "$FIXTURE" "$GAFFER_DATA/worker-in-data.mjs"; chmod 755 "$GAFFER_DATA/worker-in-data.mjs"
ln -sf "$FIXTURE" "$CWD/worker-link.mjs"
cp "$FIXTURE" "$WORK/tools/worker-gw.mjs"; chmod 775 "$WORK/tools/worker-gw.mjs"
for bad in "$CWD/worker-in-root.mjs" "$GAFFER_DATA/worker-in-data.mjs" "$CWD/worker-link.mjs" "$WORK/tools/worker-gw.mjs"; do
  run_cmd "${DBASE[@]}" GAFFER_WORKER_COMMAND="$bad"
  [ "$RC" = "70" ] && [ "$RAN" = "0" ] && ok "GAFFER_WORKER_COMMAND=${bad#"$WORK"/} → rc 70, not spawned" \
    || fail "GAFFER_WORKER_COMMAND=${bad#"$WORK"/} should be refused (rc=$RC ran=$RAN; $ERR)"
done
case "$ERR" in *"writable by its group or others"*) ok "…the refusal names the problem" ;; *) fail "the group-writable refusal does not say why (got: $ERR)" ;; esac
rm -f "$CWD/worker-in-root.mjs" "$GAFFER_DATA/worker-in-data.mjs" "$CWD/worker-link.mjs"

# A settings.json opt-out does not reach the seam either (it may have been written by an
# agent; only the operator's real environment opts out).
printf '{"GAFFER_STRICT_REQUIRE":"0"}\n' > "$GAFFER_DATA/settings.json"
run_cmd "${BASE[@]}" SANDBOX_PROVIDER=none
[ "$RC" = "75" ] && [ "$RAN" = "0" ] && ok "settings.json GAFFER_STRICT_REQUIRE=0 → still rc 75 at the seam" \
  || fail "a settings.json opt-out let the command worker run uncontained (rc=$RC ran=$RAN)"
rm -f "$GAFFER_DATA/settings.json"

# A prompt bigger than one environment string may be (128 KiB on Linux, and macOS caps the
# whole argv + env near 1 MiB): the worker still gets it, through GAFFER_WORKER_PROMPT_FILE.
node -e 'process.stdout.write(("#big "+"context block line\n".repeat(17000)).trimEnd())' > "$WORK/big-prompt.txt"
BIG_BYTES="$(wc -c < "$WORK/big-prompt.txt" | tr -d ' ')"
run_cmd "${DBASE[@]}" RC_PROMPT_FILE="$WORK/big-prompt.txt"
[ "$RC" = "0" ] && [ "$RAN" = "1" ] && ok "a ${BIG_BYTES}-byte prompt still spawns the worker (rc 0)" \
  || fail "a ${BIG_BYTES}-byte prompt failed to spawn the worker (rc=$RC ran=$RAN; $(printf '%s' "$ERR" | tail -c 300))"
node -e '
const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").pop()||"{}");
const want=Number(process.argv[2]);
process.exit(r.promptBytes===want&&r.promptInlineBytes===0&&r.promptFile&&!r.promptFileError?0:1);' "$CALLS" "$BIG_BYTES" 2>/dev/null \
  && ok "…it read the whole prompt from GAFFER_WORKER_PROMPT_FILE (GAFFER_WORKER_PROMPT left empty)" \
  || fail "the big prompt did not reach the worker intact: $(head -c 400 "$CALLS")"
PF="$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").pop()||"{}");process.stdout.write(r.promptFile||"")' "$CALLS" 2>/dev/null)"
[ -n "$PF" ] && grep -q -- "-v $PF:$PF:ro" "$DOCKER_LOG" && ok "…the prompt file is mounted read-only into the container" \
  || fail "the prompt file is not mounted into the container (file: ${PF:-<none>})"
[ -n "$PF" ] && [ ! -e "$PF" ] && ok "…and removed after the call" || fail "the prompt file was left behind: ${PF:-<none>}"
run_cmd "${DBASE[@]}"
node -e '
const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").pop()||"{}");
process.exit(r.promptInlineBytes===10&&r.promptBytes===10&&r.promptFile?0:1);' "$CALLS" 2>/dev/null \
  && ok "a small prompt rides GAFFER_WORKER_PROMPT inline as well as the file" || fail "small prompt not inline: $(head -c 300 "$CALLS")"

# Cost: the envelope's cost is the operator's program talking, so the runner books at
# least a per-call floor (GAFFER_WORKER_COMMAND_COST_USD, else this call's dollar cap,
# else the kill-estimate floor). A worker cannot beat the daily cap by reporting $0.
envfield() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")||"{}");const v=j[process.argv[2]];process.stdout.write(v===undefined?"<absent>":String(v))' "$WORK/last-out.json" "$1" 2>/dev/null; }
run_cmd "${DBASE[@]}" GAFFER_TEST_COMMAND_WORKER_STDOUT='{"result":"done","num_turns":3}'
[ "$(envfield total_cost_usd)" = "0.05" ] && [ "$(envfield gaffer_cost_basis)" = "floor" ] \
  && ok "an unreported cost is booked at the default floor (\$0.05, basis floor), not \$0" \
  || fail "unreported cost: total=$(envfield total_cost_usd) basis=$(envfield gaffer_cost_basis)"
run_cmd "${DBASE[@]}" GAFFER_WORKER_COMMAND_COST_USD=0.3 GAFFER_TEST_COMMAND_WORKER_STDOUT='{"result":"done","cost_usd":0}'
[ "$(envfield total_cost_usd)" = "0.3" ] && [ "$(envfield gaffer_cost_basis)" = "floor" ] && [ "$(envfield gaffer_reported_cost_usd)" = "0" ] \
  && ok "a cost reported below GAFFER_WORKER_COMMAND_COST_USD is booked at the floor, the reported figure kept beside it" \
  || fail "under-reported cost: total=$(envfield total_cost_usd) basis=$(envfield gaffer_cost_basis) reported=$(envfield gaffer_reported_cost_usd)"
run_cmd "${DBASE[@]}" GAFFER_WORKER_COMMAND_COST_USD=0.3 GAFFER_TEST_COMMAND_WORKER_STDOUT='{"result":"done","cost_usd":0.75}'
[ "$(envfield total_cost_usd)" = "0.75" ] && [ "$(envfield gaffer_cost_basis)" = "reported" ] \
  && ok "a cost above the floor is booked as reported" || fail "over-floor cost: total=$(envfield total_cost_usd) basis=$(envfield gaffer_cost_basis)"
run_cmd "${DBASE[@]}" GAFFER_WORKER_COMMAND_COST_USD=0 GAFFER_TEST_COMMAND_WORKER_STDOUT='{"result":"done","num_turns":3}'
[ "$(envfield total_cost_usd)" = "<absent>" ] && [ "$(envfield gaffer_cost_basis)" = "unreported" ] \
  && ok "GAFFER_WORKER_COMMAND_COST_USD=0 trusts the worker: unreported stays unknown" \
  || fail "explicit 0 floor: total=$(envfield total_cost_usd) basis=$(envfield gaffer_cost_basis)"
run_cmd "${DBASE[@]}" GAFFER_TEST_COMMAND_WORKER_STDOUT='{"result":"partial","cap_hit":true,"num_turns":7,"cost_usd":0.2}'
[ "$(envfield subtype)" = "error_max_turns" ] \
  && node "$RUNNER_DIR/lib/worker.mjs" parse-result stopreason-maxturns --json-file "$WORK/last-out.json" 2>/dev/null \
  && ok "cap_hit true reads as a turn-cap stop to the bash cap guard (parse-result stopreason-maxturns)" \
  || fail "cap_hit did not map to the turn-cap path (subtype=$(envfield subtype))"

GAFFER_WORKER_PROVIDER=made-up worker_deliver "$CWD" "p" "" "$MCP" "$WORK/out.unknown.json" "" 2>"$WORK/err.unknown"
urc=$?
[ "$urc" = "70" ] && grep -q "not yet supported" "$WORK/err.unknown" && ok "an unknown provider still refuses rc 70" \
  || fail "unknown provider should still refuse rc 70 (rc=$urc)"

# ── 3. a real tick.sh delivery ─────────────────────────────────────────────
echo "== 3: tick.sh delivers a ticket through the command worker =="
command -v git >/dev/null 2>&1 || gaffer_skip "git required"
node --input-type=commonjs -e "require('node:sqlite')" 2>/dev/null || gaffer_skip "node:sqlite requires Node >= 22.5"
[ -f "$DISPATCH_CLI" ] || gaffer_skip "dispatch CLI not built ($DISPATCH_CLI)"

setup_world() {   # setup_world <name> → REPO, GAFFER_DATA, DISPATCH_DB, MEMORY_DB, TID
  local n="$1"
  REPO="$WORK/$n-repo"; mkdir -p "$REPO/test"
  printf '{"name":"widget","version":"1.0.0","private":true,"scripts":{"test":"node --test"}}\n' >"$REPO/package.json"
  printf 'const t=require("node:test");const a=require("node:assert");t.test("baseline",()=>{a.equal(1+1,2);});\n' >"$REPO/test/base.test.js"
  git -C "$REPO" init -q -b main
  git -C "$REPO" -c user.email=t@e -c user.name=t -c commit.gpgsign=false add -A
  git -C "$REPO" -c user.email=t@e -c user.name=t -c commit.gpgsign=false commit -qm init
  export GAFFER_DATA="$WORK/$n-data"; mkdir -p "$GAFFER_DATA"
  export DISPATCH_DB="$GAFFER_DATA/dispatch.sqlite" MEMORY_DB="$GAFFER_DATA/memory.sqlite"
  node "$DISPATCH_CLI" --db "$DISPATCH_DB" init >/dev/null
  [ -f "$MEMORY_CLI" ] && node "$MEMORY_CLI" init >/dev/null 2>&1
  node "$DISPATCH_CLI" --db "$DISPATCH_DB" repo add -n widget --path "$REPO" --branch main --stack node --test "node --test" >/dev/null
  TID="$(node "$DISPATCH_CLI" --db "$DISPATCH_DB" ticket create -t "Add DELIVERED marker" -d "Add DELIVERED.txt at the repo root." --risk low 2>/dev/null |
    node -e 'let r="";process.stdin.on("data",c=>r+=c);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(r).ticket.id)}catch{}})')"
  node -e '
const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.env.DISPATCH_DB);
const rid=db.prepare("select id from repositories where name=?").get("widget").id;
db.prepare("insert into ticket_repos(ticket_id,repo_id,role,access,relation,source) values(?,?,?,?,?,?)").run(process.argv[1],rid,"primary","write","confirmed","manual");
db.prepare("insert into acceptance_criteria(id,ticket_id,text,sort_order) values(?,?,?,0)").run("ac-1",process.argv[1],"DELIVERED.txt exists");
' "$TID"
  node "$DISPATCH_CLI" --db "$DISPATCH_DB" ticket ready "$TID" >/dev/null 2>&1
}
ticket_status() { node "$DISPATCH_CLI" --db "$DISPATCH_DB" ticket show "$TID" 2>/dev/null | node "$RUNNER_DIR/lib/json-tool.mjs" expr 'd.ticket.status' 2>/dev/null; }
run_tick() {   # run_tick <log> <env assignments…>
  local log="$1"; shift
  env -u GAFFER_STRICT_REQUIRE -u STRICT_MODE -u ANTHROPIC_API_KEY -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN \
    PATH="$WORK/bin:$PATH" CLAUDE_BIN="$WORK/bin/claude" DRY_RUN=0 GAFFER_ALLOW_UNCAPPED=1 GAFFER_TICK_TIMEOUT=120 \
    GAFFER_IMPL_MODEL=stub-impl-model GAFFER_PLAN_MODEL=none \
    GAFFER_WORKER_PROVIDER=command GAFFER_WORKER_COMMAND="$FIXTURE" "$@" \
    bash "$RUNNER_DIR/tick.sh" >"$log" 2>&1 || true
}

setup_world ok
[ -n "$TID" ] || { fail "could not create a ticket"; exit 1; }
: > "$SBX_LOG"; rm -f "$CLAUDE_TRIP"
# Fake (not real) credentials: the scrub must drop the claude-code auth surface and the
# runner-only GITHUB_TOKEN even when GAFFER_WORKER_COMMAND_ENV names it, and pass the
# worker's own named credential.
: > "$DOCKER_LOG"
run_tick "$WORK/tick-ok.log" "${DOCKER_ENV[@]}" PATH="$WORK/dockerbin:$WORK/bin:$PATH" \
  ANTHROPIC_API_KEY=sk-test-not-real GITHUB_TOKEN=ghp-test-not-real STUB_WORKER_KEY=stub-key-not-real \
  GAFFER_WORKER_COMMAND_ENV="STUB_WORKER_KEY GITHUB_TOKEN"
CALLS="$GAFFER_DATA/command-worker.jsonl"
[ "$(ticket_status)" = "in_review" ] && ok "the ticket reached in_review (the human gate)" \
  || { fail "ticket not in_review (got '$(ticket_status)')"; tail -25 "$WORK/tick-ok.log"; }
[ -s "$CALLS" ] && ok "the command worker ran" || fail "the command worker never ran"
node -e '
const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n")[0]);
const bad=[];
if(r.contract!=="1")bad.push("contract");
if(r.kind!=="delivery")bad.push("kind="+r.kind);
if(r.model!=="stub-impl-model")bad.push("model="+r.model);
if(!/^\d+$/.test(r.maxTurns||""))bad.push("maxTurns="+r.maxTurns);
if(!r.mcpConfig)bad.push("mcpConfig");
if(r.promptHasTicket!==true)bad.push("prompt");
if(!r.committed)bad.push("not committed");
for(const n of ["ANTHROPIC_API_KEY","GITHUB_TOKEN","DISPATCH_API_TOKEN","CLAUDE_BIN","CLAUDE_FLAGS"]) if(r.envNames.includes(n))bad.push("leaked "+n);
if(!r.envNames.includes("STUB_WORKER_KEY"))bad.push("GAFFER_WORKER_COMMAND_ENV name not passed");
if(bad.length){console.error(bad.join(", "));process.exit(1);}' "$CALLS" 2>"$WORK/contract.err" \
  && ok "it received the contract (prompt, model hint, turn cap, MCP config, kind) under the scrubbed env (its own named key, no Claude or runner secrets), in the worktree" \
  || fail "contract not honoured: $(cat "$WORK/contract.err")"
node -e '
const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n")[0]);
const g=r.mcp.find(m=>m.tool==="get_ticket"&&m.ok);const e=r.mcp.find(m=>m.tool==="record_ac_evidence"&&m.ok);
process.exit(g&&e?0:1);' "$CALLS" \
  && ok "it talked to the dispatch MCP server (get_ticket + record_ac_evidence)" || fail "MCP calls failed: $(head -c 600 "$CALLS")"
EVN="$(node -e '
const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.env.DISPATCH_DB);
process.stdout.write(String(db.prepare("select count(*) n from evidence where ticket_id=? and summary like ?").get(process.argv[1],"command worker:%").n));' "$TID" 2>/dev/null)"
[ "${EVN:-0}" -ge 1 ] && ok "the worker's MCP evidence landed on the ticket" || fail "no command-worker evidence on the ticket ($EVN)"
grep -q "GAFFER_WORKER_KIND=delivery" "$DOCKER_LOG" && grep -q " $FIXTURE\$" "$DOCKER_LOG" && ok "the delivery ran INSIDE the docker wrapper" \
  || fail "the delivery did not run under the docker wrap (log: $(grep -c . "$DOCKER_LOG") lines; $(grep '^CMD' "$DOCKER_LOG" | cut -c1-200 | head -3))"
grep -q "^CMD .* bash -c node --test\$" "$DOCKER_LOG" && ok "the DoD tests gate ran too, inside the same wrapper" \
  || fail "no DoD gate ran under the wrap (log: $(grep '^CMD' "$DOCKER_LOG" | grep -v GAFFER_WORKER | head -5))"
grep -q "GAFFER_WORKER_MCP_CONFIG=[^ ]*\.bridge\.json" "$DOCKER_LOG" && ok "the delivery's MCP traffic went through the host-side bridge (bridged config)" \
  || fail "the delivery was not handed the bridged MCP config"
grep -q "GAFFER_CLAIM_TOKEN" "$DOCKER_LOG" && fail "the claim token name reached the container argv" || ok "…the claim token never entered the container argv"
grep -q "DoD: #[0-9]* PASSED" "$WORK/tick-ok.log" && ok "tick.log records the DoD gate pass" || fail "no DoD pass in the tick log"
ROW="$(grep '"kind":"delivery"' "$GAFFER_DATA/usage-ledger.jsonl" 2>/dev/null | tail -1)"
node -e 'const r=JSON.parse(process.argv[1]);process.exit(r.worker_provider==="command"&&r.total_cost_usd===0.05&&r.cost_basis==="floor"&&r.reported_cost_usd===0.0123&&r.measured===true&&r.num_turns===2&&r.models&&r.models["stub-command-model"]?0:1)' "${ROW:-{\}}" \
  && ok "ledger: the delivery row names the provider, turns and serving model, and books the \$0.05 floor over the \$0.0123 it reported" \
  || fail "ledger row: ${ROW:-<none>}"
[ ! -e "$CLAUDE_TRIP" ] && ok "claude was never run" || fail "claude ran during a command-provider tick"

echo "== 4: the same tick with no sandbox available refuses before the spawn =="
setup_world refuse
: > "$SBX_LOG"
run_tick "$WORK/tick-refuse.log" SANDBOX_PROVIDER=none
[ ! -s "$GAFFER_DATA/command-worker.jsonl" ] && ok "the command worker was NOT spawned" || fail "the command worker ran with no sandbox"
# No OS sandbox at all: the tick's admission refuses before the claim (OS isolation is the
# default for every launch), so the ticket is not even claimed. 4b covers the park below it.
[ "$(ticket_status)" = "ready" ] && ok "the ticket was not claimed (refused before the claim)" || fail "ticket should stay ready (got '$(ticket_status)')"
grep -q "strict_require_unavailable\|refusing to launch an\? agent" "$WORK/tick-refuse.log" \
  && ok "tick.log says the agent was refused for want of an OS sandbox" || fail "no refusal in the tick log: $(tail -5 "$WORK/tick-refuse.log")"
grep -q "GAFFER_WORKER_PROVIDER=command" "$WORK/tick-refuse.log" \
  && ok "…and names the command provider as the reason the sandbox is required" || fail "the refusal does not name the provider"

echo "== 4b: a tick under SANDBOX_PROVIDER=sandbox-exec (available) parks before the spawn =="
setup_world sbx
: > "$SBX_LOG"
run_tick "$WORK/tick-sbx.log" SANDBOX_PROVIDER=sandbox-exec
[ ! -s "$GAFFER_DATA/command-worker.jsonl" ] && ok "the command worker was NOT spawned under sandbox-exec" || fail "the command worker ran under sandbox-exec"
grep -q "$FIXTURE" "$SBX_LOG" && fail "the worker program ran under sandbox-exec" || ok "…nothing of the worker's ran under sandbox-exec"
[ "$(ticket_status)" = "blocked" ] && ok "the ticket is parked blocked (not a counted failed attempt)" || fail "ticket should be blocked (got '$(ticket_status)')"
grep -q "strict_require_unavailable" "$WORK/tick-sbx.log" && grep -q "sandbox-exec" "$WORK/tick-sbx.log" \
  && ok "tick.log parks it strict_require_unavailable and names sandbox-exec as not enough" || fail "no sandbox-exec park in the tick log: $(grep -i 'strict\|sandbox' "$WORK/tick-sbx.log" | tail -4)"

echo "== 5: the greenfield repo classifier goes through the command worker, not claude =="
INH_DATA="$WORK/inherit-data"; mkdir -p "$INH_DATA"
INH_PLAN="{\"ambiguous\":[{\"ticket\":30,\"candidates\":[{\"repo\":\"a\"}],\"argv\":[\"-p\",\"pick the repo\",\"--output-format\",\"json\",\"--model\",\"m-inherit\",\"--max-turns\",\"2\",\"--tools\",\"\"],\"claudeBin\":\"$WORK/bin/claude\"}]}"
rm -f "$CLAUDE_TRIP"
INH_OUT="$(
  env -u GAFFER_STRICT_REQUIRE -u STRICT_MODE PATH="$WORK/dockerbin:$WORK/bin:$PATH" "${DOCKER_ENV[@]}" \
    GAFFER_DATA="$INH_DATA" CLAUDE_BIN="$WORK/bin/claude" GAFFER_ALLOW_UNCAPPED=1 GAFFER_LOG="$WORK/inherit.log" \
    GAFFER_WORKER_PROVIDER=command GAFFER_WORKER_COMMAND="$FIXTURE" GAFFER_TEST_COMMAND_WORKER_STDOUT='{"result":"a","cost_usd":0.01}' \
    bash -c '
      source "'"$RUNNER_DIR"'/factory.config.sh" >/dev/null 2>&1
      printf "%s" "$1" | _gaffer_inherit_amb_spawn 0 30
    ' _ "$INH_PLAN" 2>"$WORK/inherit.err"
)"
[ ! -e "$CLAUDE_TRIP" ] && ok "the classifier did NOT run claude under the command provider" || fail "the greenfield classifier made a claude call under GAFFER_WORKER_PROVIDER=command"
[ "$INH_OUT" = "a" ] && ok "…the command worker answered it (\"a\")" || fail "classifier answer '$INH_OUT' ($(tail -c 300 "$WORK/inherit.err"))"
node -e '
const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").pop()||"{}");
process.exit(r.kind==="inherit"&&r.tools==="none"&&r.model==="m-inherit"&&r.maxTurns==="2"?0:1);' "$INH_DATA/command-worker.jsonl" 2>/dev/null \
  && ok "…as a text-only inherit call (kind inherit, tools none, its model and turn cap)" || fail "classifier contract: $(head -c 300 "$INH_DATA/command-worker.jsonl" 2>/dev/null)"
grep -q '"kind":"inherit"' "$INH_DATA/usage-ledger.jsonl" 2>/dev/null && grep -q '"worker_provider":"command"' "$INH_DATA/usage-ledger.jsonl" \
  && ok "…and booked on the ledger as an inherit call by the command provider" || fail "no inherit ledger row: $(cat "$INH_DATA/usage-ledger.jsonl" 2>/dev/null)"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "worker-command: all $PASS passed"; exit 0; fi
echo "worker-command: ${#FAILURES[@]} FAILED (of $((PASS + ${#FAILURES[@]})))"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
