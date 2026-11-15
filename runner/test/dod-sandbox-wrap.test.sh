#!/usr/bin/env bash
# =====================================================================
# VALIDATION ISOLATION — the DoD gates run under the agent's OS sandbox.
# ---------------------------------------------------------------------
# The gate commands (tests / typecheck / lint, and AC check commands via the same
# runner) execute code the agent has just modified, with the runner's privileges.
# Sandboxing only `claude -p` left that step bare. tick.sh now exports the SAME wrap
# prefix it gave the agent as GAFFER_DOD_WRAP, and gaffer_dod_run_one runs every gate
# through it. Proven with a recording wrap stub (no real sandbox needed) + source pins.
# Run: bash test/dod-sandbox-wrap.test.sh   (bash 3.2 safe)
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/dod-wrap.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"; trap 'gaffer_test_rm_work "$WORK"' EXIT   # canonical: macOS TMPDIR ends in "/" and /var → /private/var

gaffer_timeout() { shift; "$@"; }   # the gate runner's timeout seam — inert here
export GAFFER_DOD_TIMEOUT=30
# shellcheck source=../lib/dod.sh
source "$RUNNER_DIR/lib/dod.sh"

WT="$WORK/wt"; mkdir -p "$WT"
# A wrap stub: records that it ran + its cwd, then executes the wrapped command.
cat > "$WORK/wrap.sh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "wrapped profile=${GAFFER_SANDBOX_PROFILE:-none} cwd=$(pwd -P) argv=$*" >> "${WRAP_LOG:?}"
exec "$@"
STUB
chmod +x "$WORK/wrap.sh"
export WRAP_LOG="$WORK/wrap.log"

echo "== 1: no wrap ⇒ the bare invocation (unchanged) =="
: > "$WRAP_LOG"; unset GAFFER_DOD_WRAP
gaffer_dod_run_one "$WT" "$WORK/out" 'echo bare-ok; exit 0'; rc=$?
[ "$rc" -eq 0 ] && grep -q bare-ok "$WORK/out" && ok "gate ran and passed without a wrap" || fail "bare gate should pass (rc=$rc)"
[ ! -s "$WRAP_LOG" ] && ok "wrap stub never invoked when GAFFER_DOD_WRAP is empty" || fail "wrap ran with no GAFFER_DOD_WRAP"

echo "== 2: GAFFER_DOD_WRAP set ⇒ every gate runs THROUGH the wrap, in the worktree =="
: > "$WRAP_LOG"; export GAFFER_DOD_WRAP="$WORK/wrap.sh"
gaffer_dod_run_one "$WT" "$WORK/out" 'echo wrapped-ok; exit 0'; rc=$?
[ "$rc" -eq 0 ] && grep -q wrapped-ok "$WORK/out" && ok "gate output + rc pass through the wrap" || fail "wrapped gate should pass (rc=$rc)"
grep -qF " cwd=$(cd "$WT" && pwd -P) " "$WRAP_LOG" \
  && ok "the wrap ran with the delivery worktree as cwd" || fail "wrap cwd was not the worktree: $(cat "$WRAP_LOG")"
grep -q 'argv=env -i .* bash -c echo wrapped-ok; exit 0' "$WRAP_LOG" && ok "the wrap received env -i <gate env> bash -c plus the gate command" || fail "wrap argv unexpected: $(cat "$WRAP_LOG")"
gaffer_dod_run_one "$WT" "$WORK/out" 'echo boom >&2; exit 3'; rc=$?
[ "$rc" -eq 3 ] && grep -q boom "$WORK/out" && ok "a failing gate's rc + stderr still surface through the wrap" || fail "wrapped failing gate should return 3 (got $rc)"

echo "== 3: gaffer_run_dod_gates (the real driver) goes through the same runner =="
: > "$WRAP_LOG"; RES="$WORK/res"
printf 'repo\t%s\t1\t1\t1\ttrue\t-\ttrue\n' "$WT" | gaffer_run_dod_gates "$RES"; rc=$?
[ "$rc" -eq 0 ] && [ "$(grep -c '^wrapped' "$WRAP_LOG")" = "2" ] && ok "both configured gates (tests, lint) ran under the wrap" || fail "expected 2 wrapped gate runs (got $(grep -c '^wrapped' "$WRAP_LOG"), rc=$rc)"

echo "== 4: docker provider ⇒ the image's HOME/PATH are applied inside the wrap =="
: > "$WRAP_LOG"; SANDBOX_PROVIDER=docker GAFFER_SANDBOX_HOME=/root GAFFER_SANDBOX_PATH=/usr/bin:/bin \
  gaffer_dod_run_one "$WT" "$WORK/out" 'echo x'
grep -q 'argv=env -i HOME=/root PATH=/usr/bin:/bin .*bash -c echo x' "$WRAP_LOG" \
  && ok "docker wrap prepends the image env (host PATH/HOME do not exist inside)" || fail "docker env substitution missing: $(cat "$WRAP_LOG")"
unset SANDBOX_PROVIDER

echo "== 6: the PRE-GATE dependency install runs inside the SAME wrap (external review #1) =="
# A repository install hook (.pnpmfile.cjs, yarnPath, a lifecycle script) is repository
# code. A stub package manager stands in for it: it writes a marker OUTSIDE the worktree
# and records the env it saw. A denying wrap must stop it; a pass-through wrap must see
# a stripped env (no operator token, a throwaway HOME).
IW="$WORK/iwt"; MARK="$WORK/outside-marker"; BIN="$WORK/bin"; mkdir -p "$IW" "$BIN"
printf '{"name":"x","version":"1.0.0"}' > "$IW/package.json"; printf "lockfileVersion: '9.0'\n" > "$IW/pnpm-lock.yaml"
cat > "$BIN/pnpm" <<STUB
#!/usr/bin/env bash
printf 'hook ran token=%s dispatch=%s home=%s\n' "\${SECRET_TOKEN:-none}" "\${DISPATCH_API_TOKEN:-none}" "\$HOME" > "$MARK"
mkdir -p node_modules/.x
STUB
chmod +x "$BIN/pnpm"
printf '#!/usr/bin/env bash\nprintf "denied argv=%%s\\n" "$*" >> "${WRAP_LOG:?}"; exit 126\n' > "$WORK/deny.sh"; chmod +x "$WORK/deny.sh"
: > "$WRAP_LOG"; rm -f "$MARK"
v="$(PATH="$BIN:$PATH" SECRET_TOKEN=s3cret GAFFER_DOD_WRAP="$WORK/deny.sh" gaffer_dod_install_deps "$IW" 2>/dev/null)"
[ ! -e "$MARK" ] && ok "a denying validation wrap stops the install hook (no marker outside the worktree)" || fail "install hook ran outside the wrap: $(cat "$MARK" 2>/dev/null)"
grep -q '^denied argv=env -i .*bash -c pnpm install' "$WRAP_LOG" && ok "the install was handed to the wrap as env -i … bash -c <install>" || fail "install did not go through the wrap: $(cat "$WRAP_LOG")"
case "$v" in FAILED:pnpm) ok "denied install reports FAILED:pnpm (the gate surfaces it)" ;; *) fail "unexpected verdict under a denying wrap: '$v'" ;; esac
rm -rf "$IW/node_modules"; : > "$WRAP_LOG"; rm -f "$MARK"
v="$(PATH="$BIN:$PATH" SECRET_TOKEN=s3cret DISPATCH_API_TOKEN=tok GAFFER_DOD_WRAP="$WORK/wrap.sh" gaffer_dod_install_deps "$IW" 2>/dev/null)"
[ "$v" = pnpm ] && ok "a pass-through wrap still installs (verdict pnpm)" || fail "pass-through install verdict '$v'"
grep -q 'token=none dispatch=none' "$MARK" 2>/dev/null && ok "the install env is stripped (no operator token, no DISPATCH_API_TOKEN)" || fail "install saw operator secrets: $(cat "$MARK" 2>/dev/null)"
grep -q "home=$HOME\$" "$MARK" 2>/dev/null && fail "install saw the operator HOME" || ok "the install runs with a throwaway HOME (no ~/.npmrc, no HOME secrets)"
grep -q '^wrapped profile=validation .*argv=env -i ' "$WRAP_LOG" && ok "the install ran through the wrap with the validation profile" || fail "pass-through wrap not used with the validation profile: $(cat "$WRAP_LOG")"
rm -rf "$IW/node_modules"; rm -f "$MARK"
v="$(PATH="$BIN:$PATH" GAFFER_STRICT_REQUIRE=1 GAFFER_DOD_WRAP= gaffer_dod_install_deps "$IW" 2>/dev/null)"
[ "$v" = "SKIPPED:sandbox_unavailable:pnpm" ] && [ ! -e "$MARK" ] && ok "strict-require with no wrap ⇒ the install is refused, nothing executes (fail closed)" || fail "strict-require with no wrap ran the install (verdict '$v', marker $( [ -e "$MARK" ] && echo present || echo absent))"
# The host-side primary prime (greenfield.sh) runs before any wrap exists: under
# strict-require it must not execute the repository's install at all, and otherwise it
# runs with the same stripped env.
# shellcheck source=../lib/greenfield.sh
source "$RUNNER_DIR/lib/greenfield.sh"
rm -rf "$IW/node_modules"; rm -f "$MARK"
v="$(PATH="$BIN:$PATH" GAFFER_STRICT_REQUIRE=1 gaffer_ensure_node_modules "$IW" 2>/dev/null)"
[ -z "$v" ] && [ ! -e "$MARK" ] && ok "strict-require ⇒ the host primary prime does not run the install" || fail "greenfield prime ran under strict-require (verdict '$v')"
rm -rf "$IW/node_modules"; rm -f "$MARK"
v="$(PATH="$BIN:$PATH" SECRET_TOKEN=s3cret gaffer_ensure_node_modules "$IW" 2>/dev/null)"
grep -q 'token=none' "$MARK" 2>/dev/null && ok "the host primary prime runs with the stripped env" || fail "greenfield prime saw operator secrets: $(cat "$MARK" 2>/dev/null)"
grep -q 'SKIPPED:sandbox_unavailable' "$RUNNER_DIR/lib/tick-gates.sh" && ok "tick.sh logs the refused install" || fail "tick.sh does not handle SKIPPED:sandbox_unavailable"

echo "== 7: under the docker provider the install container gets the CONTAINER's env, not the host's =="
# The install runs `env -i <install env> bash -c <install>` inside the container, so the
# wrapper's own -e list (safe.directory, the egress proxy) never reaches it unless the
# install env names it too (the same class as worker.sh's agent env, b279e1e). Driven
# through the REAL lib/sandbox-docker.sh with the recording fake daemon
# (lib/fake-docker.sh): the "container" is this host, so the stub pnpm records the env
# the install would have seen inside.
DBIN="$WORK/dbin"; SBX="$WORK/sbx-path"; DW="$WORK/docker-iwt"; mkdir -p "$DBIN" "$SBX" "$DW" "$WORK/sbx-home" "$WORK/host-tmp"
cp "$HERE/lib/fake-docker.sh" "$DBIN/docker"; chmod +x "$DBIN/docker"
for t in bash env mkdir; do ln -s "$(command -v "$t")" "$SBX/$t"; done
cat > "$SBX/pnpm" <<'STUB'
#!/usr/bin/env bash
env > "$PWD/.install-env"
mkdir -p node_modules/.x
STUB
chmod +x "$SBX/pnpm"
printf '{"name":"x","version":"1.0.0"}' > "$DW/package.json"; printf "lockfileVersion: '9.0'\n" > "$DW/pnpm-lock.yaml"
printf '%s\n' "$DW" > "$WORK/wr.txt"; : > "$WORK/rr.txt"
v="$(cd "$DW" && PATH="$DBIN:$SBX:$PATH" FAKE_DOCKER_LOG="$WORK/docker-calls" SANDBOX_PROVIDER=docker \
  GAFFER_SANDBOX_PATH="$SBX" GAFFER_SANDBOX_HOME="$WORK/sbx-home" GAFFER_DATA="$WORK/ddata" \
  HTTPS_PROXY=http://host-proxy.invalid:3128 HTTP_PROXY=http://host-proxy.invalid:3128 \
  https_proxy=http://host-proxy.invalid:3128 NO_PROXY=host.invalid TMPDIR="$WORK/host-tmp" \
  NODE_EXTRA_CA_CERTS="$WORK/host-ca.pem" \
  GAFFER_DOD_WRAP="bash $RUNNER_DIR/lib/sandbox-docker.sh $WORK/wr.txt $WORK/rr.txt --" \
  gaffer_dod_install_deps "$DW" 2>"$WORK/docker-install.err")"
IE="$DW/.install-env"
[ "$v" = pnpm ] && [ -f "$IE" ] && ok "the install ran through sandbox-docker.sh under the fake daemon (verdict pnpm)" || fail "docker install verdict '$v': $(tail -3 "$WORK/docker-install.err" 2>/dev/null | tr '\n' '|')"
grep -qx 'GIT_CONFIG_COUNT=1' "$IE" 2>/dev/null && grep -qx 'GIT_CONFIG_KEY_0=safe.directory' "$IE" && grep -qx 'GIT_CONFIG_VALUE_0=\*' "$IE" \
  && ok "install container: git's safe.directory reaches the install (a host-owned mount is not 'dubious')" || fail "install container: no safe.directory in the install env"
grep -qx 'HTTPS_PROXY=http://egress-proxy:8888' "$IE" 2>/dev/null && grep -qx 'HTTP_PROXY=http://egress-proxy:8888' "$IE" && grep -qx 'https_proxy=http://egress-proxy:8888' "$IE" \
  && ok "install container: the registry fetch goes through the egress proxy" || fail "install container: egress proxy not in the install env ($(grep -i 'proxy=' "$IE" 2>/dev/null | tr '\n' ' '))"
grep -qx 'NO_PROXY=localhost,127.0.0.1,egress-proxy' "$IE" 2>/dev/null && ok "install container: NO_PROXY is the container's" || fail "install container: NO_PROXY is not the container's ($(grep -i '^no_proxy=' "$IE" 2>/dev/null | tr '\n' ' '))"
grep -qE 'host-proxy[.]invalid|host[.]invalid' "$IE" 2>/dev/null && fail "install container: the HOST's proxy leaked into the install env" || ok "install container: the host's proxy settings stay on the host"
grep -qx 'TMPDIR=/tmp' "$IE" 2>/dev/null && ok "install container: TMPDIR is the container's /tmp" || fail "install container: TMPDIR is '$(grep '^TMPDIR=' "$IE" 2>/dev/null)', not /tmp"
grep -q "host-ca.pem" "$IE" 2>/dev/null && fail "install container: a host CA bundle path leaked in (it does not exist in the container)" || ok "install container: no host CA bundle path"
grep -qx "HOME=$WORK/sbx-home" "$IE" 2>/dev/null && ok "install container: the image's HOME" || fail "install container: HOME is '$(grep '^HOME=' "$IE" 2>/dev/null)'"
# The host side (no docker): unchanged, the host's proxy, TMPDIR and CA still apply.
_hostenv=(); _hosthome=""
gaffer_dod_install_env _hostenv _hosthome
[ -n "$_hosthome" ] && rm -rf "$_hosthome"
_hostenv_s="$(printf '%s\n' "${_hostenv[@]}")"
grep -qx "TMPDIR=${TMPDIR:-/tmp}" <<<"$_hostenv_s" && ok "host install env: the host TMPDIR (unchanged)" || fail "host install env lost the host TMPDIR"
grep -qE 'egress-proxy|GIT_CONFIG' <<<"$_hostenv_s" && fail "host install env carries the container's settings" || ok "host install env: no container-only settings"

echo "== 8: sandbox-exec: a gate never runs under the AGENT's profile (sandbox audit F1c) =="
# A stub sandbox-exec (this host may have none) records the profile it was handed, then
# runs the command. The agent's wrap names an agent profile (databases and ~/.claude
# writable); the gate must get a fresh VALIDATION profile instead, removed after the run.
SBIN="$WORK/sbin"; SDATA="$WORK/sdata"; mkdir -p "$SBIN" "$SDATA"
cat > "$SBIN/sandbox-exec" <<'STUB'
#!/usr/bin/env bash
[ "$1" = "-f" ] || exit 64
cp "$2" "${SBX_SEEN:?}.$(date +%s%N 2>/dev/null || echo 0).$$"; printf '%s\n' "$2" >> "${SBX_SEEN}.paths"
shift 2; exec "$@"
STUB
chmod +x "$SBIN/sandbox-exec"
export SBX_SEEN="$WORK/seen"
( export PATH="$SBIN:$PATH" GAFFER_DATA="$SDATA" HOME="/nonexistent-dod-home.$$" STRICT_ALLOW_HOME="/nonexistent-dod-home.$$/.claude"
  # shellcheck source=../lib/sandbox.sh
  source "$RUNNER_DIR/lib/sandbox.sh"
  AGENT_WRAP="$(SANDBOX_PROVIDER=sandbox-exec sandbox_wrap_cmd "$WT" "")"
  export GAFFER_DOD_WRAP="$AGENT_WRAP" SANDBOX_PROVIDER=sandbox-exec
  gaffer_dod_run_one "$WT" "$WORK/out8" 'echo gate-ran'; echo "rc=$?" > "$WORK/rc8"
  printf '%s\n' "${AGENT_WRAP#sandbox-exec -f }" > "$WORK/agentprof8"
  # A validation profile that cannot be generated: the gate is not run.
  GAFFER_DATA="$WORK/bad\"data" gaffer_dod_run_one "$WT" "$WORK/out8b" 'echo SHOULD-NOT-RUN'; echo "rc=$?" > "$WORK/rc8b"
)
SEEN="$(ls "$WORK"/seen.[0-9]* 2>/dev/null | head -1)"
grep -q '^rc=0$' "$WORK/rc8" && grep -q gate-ran "$WORK/out8" && ok "the gate ran through sandbox-exec" || fail "gate did not run: $(cat "$WORK/rc8" "$WORK/out8" 2>/dev/null)"
[ -n "$SEEN" ] && grep -q '^;; variant: validation$' "$SEEN" && ok "the gate's profile is the validation variant" || fail "the gate ran under: $(head -3 "$SEEN" 2>/dev/null)"
grep -qxF "$(cat "$WORK/agentprof8")" "$WORK/seen.paths" && fail "the gate was handed the agent's own profile file" || ok "the agent's profile file was never handed to the gate"
V="$(node "$HERE/lib/sbpl-eval.mjs" "$SEEN" write "$SDATA/dispatch.sqlite" "$SDATA/settings.json" "$SDATA/usage-ledger.jsonl" "/nonexistent-dod-home.$$/.claude/projects/x" "$WT/out.txt" 2>&1 | tr '\n' ' ')"
case "$V" in
  "deny $SDATA/dispatch.sqlite deny $SDATA/settings.json deny $SDATA/usage-ledger.jsonl deny /nonexistent-dod-home.$$/.claude/projects/x allow $WT/out.txt ")
    ok "under it the gate can write its worktree but no database, settings, ledger or HOME path" ;;
  *) fail "validation profile verdicts: $V" ;;
esac
GPROF="$(tail -1 "$WORK/seen.paths")"
[ -n "$GPROF" ] && [ ! -e "$GPROF" ] && ok "the gate's profile file is removed after the run" || fail "gate profile left behind: $GPROF"
grep -q '^rc=127$' "$WORK/rc8b" && ! grep -q SHOULD-NOT-RUN "$WORK/out8b" && grep -q 'not run' "$WORK/out8b" \
  && ok "a validation profile that cannot be set up fails the gate without running it (fail closed)" || fail "unbuildable profile: $(cat "$WORK/rc8b" "$WORK/out8b")"
grep -q 'GAFFER_SANDBOX_PROFILE=validation sandbox_wrap_cmd "$WT"' "$RUNNER_DIR/bin/dod-regate.sh" \
  && ok "dod-regate.sh (the merge gate, the conflict re-gate, the tester replay) asks for the validation profile" || fail "dod-regate.sh does not ask for the validation profile"

echo "== 9: every gate run starts from env -i (sandbox audit F2) =="
# The runner's environment carries the operator's credentials; a gate runs agent-written
# code. Whatever wraps it (nothing, sandbox-exec, docker), the gate sees none of them.
LEAKS='^(ANTHROPIC_[A-Z_]*|[A-Z_]*_TOKEN|[A-Z_]*_KEY|[A-Z_]*_SECRET|DISPATCH_[A-Z_]*|GAFFER_PRINCIPAL_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|AWS_[A-Z_]*)='
gate_env() {   # <label> [VAR=value ...]: run `env` as a gate with the operator's secrets exported
  local label="$1"; shift
  ( export ANTHROPIC_API_KEY=sk-x ANTHROPIC_AUTH_TOKEN=at-x CLAUDE_CODE_OAUTH_TOKEN=oa-x GITHUB_TOKEN=ghp_x GH_TOKEN=gh-x \
      DISPATCH_API_TOKEN=dt-x DISPATCH_DB=/x/dispatch.sqlite GAFFER_PRINCIPAL_TOKEN=pt-x AWS_SECRET_ACCESS_KEY=aws-x \
      NPM_TOKEN=npm-x SOME_SECRET=s-x MY_PRIVATE_KEY=k-x GAFFER_NOTIFY_SLACK_URL=https://hooks.invalid/x \
      GAFFER_DOD_ENV_PASS="MY_SETTING GITHUB_TOKEN ANTHROPIC_API_KEY DISPATCH_DB SOME_SECRET GAFFER_NOTIFY_SLACK_URL NOT_SET" \
      MY_SETTING=kept-value
    for kv in "$@"; do export "${kv?}"; done
    gaffer_dod_run_one "$WT" "$WORK/env-$label" 'env' >/dev/null 2>"$WORK/err-$label"
    echo "$?" >"$WORK/rc-$label" )
}
# Why a gate_env run produced no usable env file: its exit status and what it wrote to
# stderr, so a gate that never started is told apart from a name the filter dropped.
gate_diag() { printf 'rc=%s stderr=%s' "$(cat "$WORK/rc-$1" 2>/dev/null)" "$(head -c 400 "$WORK/err-$1" 2>/dev/null | tr '\n' ' ')"; }
unset GAFFER_DOD_WRAP
gate_env none
grep -E "$LEAKS" "$WORK/env-none" >/dev/null && fail "no wrap: the gate saw $(grep -E "$LEAKS" "$WORK/env-none" | cut -d= -f1 | tr '\n' ' ')" \
  || ok "no wrap: the gate sees no ANTHROPIC_*, *_TOKEN, *_KEY, *_SECRET, DISPATCH_*, AWS_* or principal token"
grep -q '^MY_SETTING=kept-value$' "$WORK/env-none" && ok "no wrap: a name in GAFFER_DOD_ENV_PASS passes" || fail "no wrap: GAFFER_DOD_ENV_PASS name missing"
grep -qE '^(GITHUB_TOKEN|ANTHROPIC_API_KEY|DISPATCH_DB|SOME_SECRET|GAFFER_NOTIFY_SLACK_URL|NOT_SET)=' "$WORK/env-none" \
  && fail "no wrap: the knob let a credential or factory name through" || ok "no wrap: the knob cannot pass a credential, endpoint, dispatch or unset name"
grep -q '^CI=1$' "$WORK/env-none" && grep -q '^PATH=' "$WORK/env-none" && ok "no wrap: PATH and CI=1 are there" || fail "no wrap: base env missing"
GH="$(sed -n 's/^HOME=//p' "$WORK/env-none")"
[ -n "$GH" ] && [ "$GH" != "$HOME" ] && [ ! -e "$GH" ] && ok "no wrap: HOME is a throwaway dir, removed after the run" || fail "no wrap: HOME=$GH (real HOME $HOME)"
# The knob never passes a loader-injection or environment-control name, nor a credential
# spelled in lower case, whatever the operator lists.
# The filter decides on the NAME alone, so it is asked directly first, on every host.
NEVER=""
for n in NODE_OPTIONS BASH_ENV ENV LD_PRELOAD LD_LIBRARY_PATH DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH GIT_SSH_COMMAND \
  GIT_CONFIG_GLOBAL SSH_AUTH_SOCK PYTHONSTARTUP PERL5OPT RUBYOPT github_token my_Api_Key dyld_insert_libraries; do
  gaffer_env_name_never_for_gates "$n" || NEVER="$NEVER $n"
done
[ -z "$NEVER" ] && ok "the filter refuses every loader, environment-control and lower-case credential name by name" \
  || fail "the filter would pass:$NEVER"
gaffer_env_name_never_for_gates KEEP_ME && fail "the filter refuses an ordinary name (KEEP_ME)" || ok "the filter passes an ordinary name"
# Then the live run. The runner's own shell holds these values while it starts the gate, so
# a value has to be one the host can live with: on macOS a DYLD_INSERT_LIBRARIES naming a
# library that does not exist aborts every unprotected program the runner itself starts
# (bash, node, timeout) before any gate runs, which is the loader working, not the filter.
# There the live run leaves that one value out; its name is still in the knob, and the
# name check above covers it on every host.
DYLD_LIVE="DYLD_INSERT_LIBRARIES=/tmp/x.dylib"
[ "$(uname -s)" = Darwin ] && DYLD_LIVE="KEEP_ME_TOO=unlisted"
gate_env knob GAFFER_DOD_ENV_PASS="NODE_OPTIONS,BASH_ENV ENV LD_PRELOAD DYLD_INSERT_LIBRARIES GIT_SSH_COMMAND GIT_CONFIG_GLOBAL SSH_AUTH_SOCK PYTHONSTARTUP PERL5OPT RUBYOPT github_token my_Api_Key KEEP_ME" \
  NODE_OPTIONS="--require /tmp/x.js" BASH_ENV=/tmp/x.sh ENV=/tmp/x.sh LD_PRELOAD=/tmp/x.so "$DYLD_LIVE" \
  GIT_SSH_COMMAND="sh /tmp/x" GIT_CONFIG_GLOBAL=/tmp/gc SSH_AUTH_SOCK=/tmp/agent.sock PYTHONSTARTUP=/tmp/x.py PERL5OPT=-Mx RUBYOPT=-rx \
  github_token=gh-lower my_Api_Key=k-lower KEEP_ME=yes
if grep -qE '^(NODE_OPTIONS|BASH_ENV|ENV|LD_PRELOAD|DYLD_INSERT_LIBRARIES|GIT_SSH_COMMAND|GIT_CONFIG_GLOBAL|SSH_AUTH_SOCK|PYTHONSTARTUP|PERL5OPT|RUBYOPT|github_token|my_Api_Key)=' "$WORK/env-knob"; then
  fail "the knob passed a loader, environment-control or lower-case credential name: $(grep -E '^(NODE_OPTIONS|BASH_ENV|ENV|LD_|DYLD_|GIT_SSH|GIT_CONFIG_G|SSH_AUTH|PYTHONSTARTUP|PERL5OPT|RUBYOPT|github_token|my_Api_Key)=' "$WORK/env-knob" | cut -d= -f1 | tr '\n' ' ')"
else
  grep -q '^KEEP_ME=yes$' "$WORK/env-knob" && ok "the knob refuses loader-injection, environment-control and lower-case credential names, and passes an ordinary one" \
    || fail "the knob dropped an ordinary name ($(gate_diag knob))"
fi
gate_env inv _GAFFER_DOD_INVOCATION_ENV="NODE_OPTIONS GAFFER_REPLAY_PROOF_KEY_FILE GITHUB_TOKEN" NODE_OPTIONS=--no-warnings GAFFER_REPLAY_PROOF_KEY_FILE=/p/k
grep -q '^NODE_OPTIONS=--no-warnings$' "$WORK/env-inv" && grep -q '^GAFFER_REPLAY_PROOF_KEY_FILE=/p/k$' "$WORK/env-inv" \
  && ! grep -q '^GITHUB_TOKEN=' "$WORK/env-inv" && ok "the runner's own invocation names (the tester replay's) pass; a credential among them does not" \
  || fail "invocation env: $(grep -E '^(NODE_OPTIONS|GAFFER_REPLAY|GITHUB)' "$WORK/env-inv" | tr '\n' ' ')"
gate_env sbx PATH="$SBIN:$PATH" GAFFER_DATA="$SDATA" SANDBOX_PROVIDER=sandbox-exec \
  GAFFER_DOD_WRAP="sandbox-exec -f $SDATA/agent-profile-placeholder"
grep -q '^CI=1$' "$WORK/env-sbx" && ok "sandbox-exec wrap: the gate ran" || fail "sandbox-exec wrap: no gate output: $(head -3 "$WORK/env-sbx")"
grep -E "$LEAKS" "$WORK/env-sbx" >/dev/null && fail "sandbox-exec wrap: the gate saw $(grep -E "$LEAKS" "$WORK/env-sbx" | cut -d= -f1 | tr '\n' ' ')" \
  || ok "sandbox-exec wrap: the gate sees none of the operator's credentials"
gate_env dock SANDBOX_PROVIDER=docker GAFFER_DOD_WRAP="$WORK/wrap.sh" GAFFER_SANDBOX_HOME=/root GAFFER_SANDBOX_PATH=/usr/bin:/bin
grep -q '^HOME=/root$' "$WORK/env-dock" && ok "docker wrap: the gate ran with the image's HOME" || fail "docker wrap: $(head -3 "$WORK/env-dock")"
grep -E "$LEAKS" "$WORK/env-dock" >/dev/null && fail "docker wrap: the gate saw $(grep -E "$LEAKS" "$WORK/env-dock" | cut -d= -f1 | tr '\n' ' ')" \
  || ok "docker wrap: the gate sees none of the operator's credentials"
# An ordinary node test still runs in the stripped environment.
if command -v node >/dev/null 2>&1; then
  printf 'const t=require("node:test");const a=require("node:assert");t.test("ok",()=>a.strictEqual(1+1,2));\n' > "$WT/sum.test.js"
  ( unset GAFFER_DOD_WRAP; gaffer_dod_run_one "$WT" "$WORK/out9" 'node --test sum.test.js' ); rc=$?
  [ "$rc" -eq 0 ] && grep -q 'pass 1' "$WORK/out9" && ok "an ordinary node --test suite passes in the gate env" || fail "node --test in the gate env: rc=$rc $(tail -5 "$WORK/out9")"
  rm -f "$WT/sum.test.js"
fi
if command -v pnpm >/dev/null 2>&1; then
  printf '{"name":"g","version":"1.0.0","scripts":{"test":"node -e \\"process.exit(0)\\""}}\n' > "$WT/package.json"
  ( unset GAFFER_DOD_WRAP; gaffer_dod_run_one "$WT" "$WORK/out9p" 'pnpm test' ); rc=$?
  [ "$rc" -eq 0 ] && ok "pnpm test runs in the gate env" || fail "pnpm test in the gate env: rc=$rc $(tail -5 "$WORK/out9p")"
  rm -f "$WT/package.json"
fi

echo "== 5: source pins — tick.sh hands the agent's wrap to the gates =="
grep -q 'export GAFFER_DOD_WRAP="$WRAP"' "$RUNNER_DIR/lib/tick-launch.sh" && ok "tick.sh exports GAFFER_DOD_WRAP=\$WRAP under an active provider" || fail "tick.sh should export GAFFER_DOD_WRAP from the agent's WRAP"
grep -q 'export GAFFER_DOD_WRAP=""' "$RUNNER_DIR/lib/tick-launch.sh" && ok "tick.sh resets GAFFER_DOD_WRAP per tick (no stale wrap leaks across ticks)" || fail "tick.sh should reset GAFFER_DOD_WRAP"
grep -q 'GAFFER_DOD_SANDBOX' "$RUNNER_DIR/lib/tick-launch.sh" && ok "GAFFER_DOD_SANDBOX=0 is the documented opt-out" || fail "opt-out knob missing"
grep -q 'gaffer_dod_run_one "$wt" "$tmpout" "$cmd"' "$RUNNER_DIR/lib/ac-checks.sh" && ok "AC check commands use the same (wrapped) runner" || fail "ac-checks.sh no longer routes through gaffer_dod_run_one"
grep -q 'strict-profile.\$\$.XXXXXX' "$RUNNER_DIR/lib/sandbox.sh" && ok "sandbox-exec profile is a per-call mktemp file (no shared-filename race)" || fail "sandbox-exec still writes a fixed strict-profile.sb"
grep -q 'strict-profile.\$\$.\*' "$RUNNER_DIR/lib/tick-recovery.sh" && ok "tick.sh sweeps its own per-call profile on exit" || fail "tick.sh cleanup does not sweep strict-profile.\$\$.*"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "dod-sandbox-wrap: ALL $PASS checks passed"; exit 0
else echo "dod-sandbox-wrap: ${#FAILURES[@]} FAILED (of $((PASS + ${#FAILURES[@]})))"; exit 1; fi
