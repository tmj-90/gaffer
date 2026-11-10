#!/usr/bin/env bash
# =====================================================================
# SIGNED GATE EVENTS (package H2): the factory key stays out of agents' reach.
# One section per guard (the safety hook's own cases are in
# safety-hook-factory-key.test.mjs; the MCP server's refusal in dispatch's
# gate-seal.test.ts):
#   G1  the agent environment (gaffer_agent_env, lib/worker.mjs commandWorkerEnv) carries
#       neither the key nor its path, even when the runner's env names it
#   G2  the docker env forwarding names no key and no key path (the generated argv)
#   G3  the sandbox-exec profiles (delivery and replay) deny reads and writes of the keys
#       directory, after every grant (profile text everywhere; on Darwin the kernel too)
#   G4  docker never mounts it: the generated mount list carries no path at, under or
#       above the keys directory, and a write root that would carry it is refused
# Run: bash runner/test/run.sh -j 1 runner/test/gate-key-guards.test.sh   (bash 3.2 safe)
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
# shellcheck source=lib/isolate.sh
. "$HERE/lib/isolate.sh"
gaffer_test_isolate
WORK="$(gaffer_test_tmpdir gate-key-guards)" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
trap 'gaffer_test_rm_work "$WORK"; gaffer_test_rm_work "$GAFFER_TEST_ISO"' EXIT
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }

AHOME="$WORK/home"; KEYS="$AHOME/.config/gaffer/keys"
mkdir -p "$KEYS"; chmod 700 "$KEYS"
node -e 'require("fs").writeFileSync(process.argv[1], require("crypto").randomBytes(32), { mode: 0o600 })' "$KEYS/abc.key"
KEYHEX="$(node -e 'process.stdout.write(require("fs").readFileSync(process.argv[1]).toString("hex"))' "$KEYS/abc.key")"

echo "== G1: the agent environment carries neither the key nor its path =="
AGENT_ENV="$(
  env -i PATH="/usr/bin:/bin" HOME="$AHOME" RUNNER_DIR="$RUNNER_DIR" \
    XDG_CONFIG_HOME="$AHOME/.config" \
    GAFFER_FACTORY_KEY_FILE="$KEYS/abc.key" GAFFER_KEYS_DIR="$KEYS" GAFFER_FACTORY_KEY="$KEYHEX" \
    GAFFER_DATA="$GAFFER_DATA" \
    bash -c '
      source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
      gaffer_agent_env
      for kv in "${GAFFER_AGENT_ENV[@]}"; do printf "%s\n" "$kv"; done
    '
)"
[ -n "$AGENT_ENV" ] && ok "G1: gaffer_agent_env built an env" || fail "G1: empty agent env"
case "$AGENT_ENV" in *gaffer/keys*) fail "G1: a key path reached the agent env: $(grep -F 'gaffer/keys' <<<"$AGENT_ENV")" ;; *) ok "G1: no variable names the keys directory" ;; esac
case "$AGENT_ENV" in *"$KEYHEX"*) fail "G1: the key bytes reached the agent env" ;; *) ok "G1: the key bytes are not in it" ;; esac
case "$AGENT_ENV" in *XDG_CONFIG_HOME=*) fail "G1: XDG_CONFIG_HOME is forwarded" ;; *) ok "G1: XDG_CONFIG_HOME is not forwarded" ;; esac
WENV="$(AGENT_ENV="$AGENT_ENV" KEYS="$KEYS" node --input-type=module -e '
  const { commandWorkerEnv } = await import(process.argv[1]);
  const caller = Object.fromEntries(process.env.AGENT_ENV.split("\n").filter(Boolean).map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
  caller.GAFFER_SNEAKED = process.env.KEYS + "/abc.key";
  const out = commandWorkerEnv(caller, {}, { GAFFER_WORKER_COMMAND_ENV: "MY_KEY_DIR", MY_KEY_DIR: process.env.KEYS });
  process.stdout.write(Object.entries(out).map(([k, v]) => `${k}=${v}`).join("\n"));' "$RUNNER_DIR/lib/worker.mjs")"
case "$WENV" in *gaffer/keys*) fail "G1: lib/worker.mjs passed a key path to the worker" ;; *) ok "G1: lib/worker.mjs commandWorkerEnv drops any value naming the keys directory" ;; esac

echo "== G2 + G4: docker: no key in the env forwarding, never mounted =="
export GAFFER_DATA DISPATCH_DB="$GAFFER_DATA/dispatch.sqlite" MEMORY_DB="$GAFFER_DATA/memory.sqlite"
WT="$WORK/wt"; mkdir -p "$WT"
WRF="$WORK/wroots"; printf '%s\n' "$WT" > "$WRF"
RRF="$WORK/rroots"; : > "$RRF"
ARGV="$(HOME="$AHOME" GAFFER_SANDBOX_DRY_RUN=1 GAFFER_MCP_BRIDGE=0 GAFFER_FACTORY_KEY_FILE="$KEYS/abc.key" \
  bash "$RUNNER_DIR/lib/sandbox-docker.sh" "$WRF" "$RRF" -- true 2>"$WORK/docker.err")"; rc=$?
[ "$rc" -eq 0 ] && ok "G4: the ordinary layout assembles (rc 0)" || fail "G4: dry run rc=$rc $(tail -2 "$WORK/docker.err")"
case "$ARGV" in *gaffer/keys*) fail "G2/G4: the docker argv names the keys directory: $(grep -F 'gaffer/keys' <<<"$ARGV")" ;; *) ok "G2/G4: no mount and no env entry names the keys directory" ;; esac
case "$ARGV" in *"$KEYHEX"*) fail "G2: the key bytes are in the docker argv" ;; *) ok "G2: the key bytes are not forwarded" ;; esac
# A write root that would carry the keys directory (HOME itself): refused, nothing runs.
printf '%s\n' "$AHOME" > "$WORK/wroots-home"
HOME="$AHOME" GAFFER_SANDBOX_DRY_RUN=1 GAFFER_MCP_BRIDGE=0 bash "$RUNNER_DIR/lib/sandbox-docker.sh" "$WORK/wroots-home" "$RRF" -- true >"$WORK/home.out" 2>"$WORK/home.err"; rc=$?
[ "$rc" -ne 0 ] && grep -q "factory key directory" "$WORK/home.err" && ! grep -q '^docker$' "$WORK/home.out" \
  && ok "G4: a mount above the keys directory (HOME) is refused" || fail "G4: HOME mount rc=$rc $(cat "$WORK/home.err" | tail -2)"
printf '%s\n' "$KEYS" > "$WORK/rroots-keys"
HOME="$AHOME" GAFFER_SANDBOX_DRY_RUN=1 GAFFER_MCP_BRIDGE=0 bash "$RUNNER_DIR/lib/sandbox-docker.sh" "$WRF" "$WORK/rroots-keys" -- true >/dev/null 2>"$WORK/keys.err"; rc=$?
[ "$rc" -ne 0 ] && grep -q "factory key directory" "$WORK/keys.err" && ok "G4: a read root AT the keys directory is refused" || fail "G4: keys read root rc=$rc"
XDGC="$WORK/xdg"; mkdir -p "$XDGC/gaffer/keys"; printf '%s\n' "$XDGC" > "$WORK/rroots-xdg"
HOME="$AHOME" XDG_CONFIG_HOME="$XDGC" GAFFER_SANDBOX_DRY_RUN=1 GAFFER_MCP_BRIDGE=0 bash "$RUNNER_DIR/lib/sandbox-docker.sh" "$WRF" "$WORK/rroots-xdg" -- true >/dev/null 2>"$WORK/xdg.err"; rc=$?
[ "$rc" -ne 0 ] && grep -q "factory key directory" "$WORK/xdg.err" && ok "G4: under XDG_CONFIG_HOME the moved keys directory is guarded too" || fail "G4: xdg rc=$rc"

echo "== G3: the sandbox-exec profiles deny the keys directory =="
export STRICT_ALLOW_NETWORK=1 STRICT_ALLOW_HOME=""
# shellcheck source=../lib/sandbox.sh
source "$RUNNER_DIR/lib/sandbox.sh"
KREAL="$(cd "$KEYS" && pwd -P)"
for variant in delivery replay; do
  P="$WORK/profile-$variant.sb"
  if [ "$variant" = replay ]; then
    HOME="$AHOME" GAFFER_SANDBOX_PROFILE=replay _sandbox_exec_profile "$WT" "$P" ""
  else
    HOME="$AHOME" GAFFER_SANDBOX_PROFILE="" _sandbox_exec_profile "$WT" "$P" ""
  fi
  # The deny must come after the last allow (SBPL: last match wins).
  last_allow="$(grep -n '^(allow' "$P" | tail -1 | cut -d: -f1)"
  deny_line="$(grep -n '^(deny file-read\* file-write\*' "$P" | tail -1 | cut -d: -f1)"
  sed -n "${deny_line:-1},\$p" "$P" > "$P.tail"
  if [ -n "$deny_line" ] && [ "$deny_line" -gt "${last_allow:-0}" ] \
     && grep -qF "(subpath \"$KREAL\")" "$P.tail"; then
    ok "G3: the $variant profile denies reads and writes of the keys directory, after every allow"
  else
    fail "G3: $variant profile: $(cat "$P")"
  fi
done
if [ "$(uname -s)" = Darwin ] && command -v sandbox-exec >/dev/null 2>&1; then
  for variant in delivery replay; do
    P="$WORK/profile-$variant.sb"
    if sandbox-exec -f "$P" cat "$KEYS/abc.key" >/dev/null 2>&1; then fail "G3: $variant: the key was READ under sandbox-exec"
    else ok "G3: $variant: the kernel refuses to read the key"; fi
    if sandbox-exec -f "$P" ls "$KEYS" >/dev/null 2>&1; then fail "G3: $variant: the keys directory was LISTED"
    else ok "G3: $variant: the keys directory cannot be listed"; fi
  done
else
  echo "  (kernel enforcement runs on Darwin only; the profile text is asserted above)"
fi

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "gate-key-guards: ALL $PASS checks passed"; exit 0
else echo "gate-key-guards: ${#FAILURES[@]} FAILED (of $((PASS + ${#FAILURES[@]})))"; exit 1; fi
