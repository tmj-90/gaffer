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
grep -q 'argv=bash -c echo wrapped-ok; exit 0' "$WRAP_LOG" && ok "the wrap received bash -c plus the gate command" || fail "wrap argv unexpected: $(cat "$WRAP_LOG")"
gaffer_dod_run_one "$WT" "$WORK/out" 'echo boom >&2; exit 3'; rc=$?
[ "$rc" -eq 3 ] && grep -q boom "$WORK/out" && ok "a failing gate's rc + stderr still surface through the wrap" || fail "wrapped failing gate should return 3 (got $rc)"

echo "== 3: gaffer_run_dod_gates (the real driver) goes through the same runner =="
: > "$WRAP_LOG"; RES="$WORK/res"
printf 'repo\t%s\t1\t1\t1\ttrue\t-\ttrue\n' "$WT" | gaffer_run_dod_gates "$RES"; rc=$?
[ "$rc" -eq 0 ] && [ "$(grep -c '^wrapped' "$WRAP_LOG")" = "2" ] && ok "both configured gates (tests, lint) ran under the wrap" || fail "expected 2 wrapped gate runs (got $(grep -c '^wrapped' "$WRAP_LOG"), rc=$rc)"

echo "== 4: docker provider ⇒ the image's HOME/PATH are applied inside the wrap =="
: > "$WRAP_LOG"; SANDBOX_PROVIDER=docker GAFFER_SANDBOX_HOME=/root GAFFER_SANDBOX_PATH=/usr/bin:/bin \
  gaffer_dod_run_one "$WT" "$WORK/out" 'echo x'
grep -q 'argv=env HOME=/root PATH=/usr/bin:/bin bash -c echo x' "$WRAP_LOG" \
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
grep -q 'SKIPPED:sandbox_unavailable' "$RUNNER_DIR/tick.sh" && ok "tick.sh logs the refused install" || fail "tick.sh does not handle SKIPPED:sandbox_unavailable"

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
