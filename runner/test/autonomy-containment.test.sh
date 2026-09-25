#!/usr/bin/env bash
# =====================================================================
# AUTONOMY REQUIRES CONTAINMENT — enforced at the spawn, on EVERY spawn site.
# ---------------------------------------------------------------------
# The bug this pins: `GAFFER_MODE=autonomous` (or any single ship/mutate flag)
# exported GAFFER_STRICT_REQUIRE=1 and printed "fails closed without an OS sandbox",
# but tick.sh consulted the sandbox provider only under STRICT_MODE=1 — which only
# `GAFFER_MODE=strict` defaulted on. So the requirement was announced and never
# evaluated: the agent launched with no OS sandbox. Separately, only the delivery
# spawn ever received a $wrap; bootstrap / reviewer / clarify / judge ran bare even
# under STRICT_MODE=1.
#
#   1. config: every autonomy entry point (autonomous mode, lite mode, each raw flag)
#      defaults STRICT_MODE=1 alongside GAFFER_STRICT_REQUIRE=1; supervised stays 0.
#   2. worker seam: with the sandbox REQUIRED and no provider available,
#      worker_deliver FAILS CLOSED (rc 75, no spawn, empty envelope) even when the
#      caller passes NO wrap — i.e. the reviewer/clarify/bootstrap/judge sites are
#      covered, not just delivery.
#   3. worker seam: with the sandbox off, the invocation is unchanged (spawns).
#   4. worker seam: a provider that DOES wrap is applied at a wrap-less call site
#      (positive control via SANDBOX_PROVIDER=docker + a fake docker on PATH).
#   5. tick.sh consults the provider when strict is REQUIRED, not only when
#      STRICT_MODE=1 (source pin on the guard).
#   6. docker wrapper (dry-run): mounts $GAFFER_HOME/packages + node_modules ro and
#      follows a write root's node_modules symlink to its target — the MCP servers
#      and the DoD test gate cannot run inside the container without them.
# Zero deps beyond bash. Run: bash runner/test/autonomy-containment.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/autonomy-containment.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/data"

# ── 1. config: autonomy entry points default STRICT_MODE=1 ──────────────────
probe() {
  env -i PATH="$PATH" HOME="$HOME" GAFFER_DATA="$WORK/data" "$@" \
    bash -c '
      source "'"$RUNNER_DIR"'/factory.config.sh" >/dev/null 2>&1
      printf "STRICT_MODE=%s STRICT_REQUIRE=%s\n" "${STRICT_MODE:-}" "${GAFFER_STRICT_REQUIRE:-}"
    '
}
echo "== 1: autonomy → STRICT_MODE defaults on (the requirement is actually evaluated) =="
[ "$(probe)" = "STRICT_MODE=0 STRICT_REQUIRE=" ] \
  && ok "supervised (default): STRICT_MODE=0, strict-require unset" \
  || fail "supervised should stay STRICT_MODE=0 / no strict-require (got: $(probe))"
for entry in "GAFFER_MODE=autonomous" "GAFFER_MODE=strict" "GAFFER_MODE=lite" \
             "DISPATCH_ALLOW_AGENT_APPROVE=1" "MERGE_ON_AGENT_REVIEW=1" "AUTO_MERGE=1" "MEMORY_AUTO_APPROVE=1"; do
  got="$(probe "$entry")"
  [ "$got" = "STRICT_MODE=1 STRICT_REQUIRE=1" ] \
    && ok "$entry → STRICT_MODE=1 + GAFFER_STRICT_REQUIRE=1" \
    || fail "$entry should default STRICT_MODE=1 + strict-require (got: $got)"
done
got="$(probe GAFFER_MODE=autonomous GAFFER_STRICT_REQUIRE=0)"
[ "$got" = "STRICT_MODE=0 STRICT_REQUIRE=0" ] \
  && ok "explicit GAFFER_STRICT_REQUIRE=0 opt-out leaves STRICT_MODE at its default (0)" \
  || fail "strict-require opt-out should not force STRICT_MODE (got: $got)"
got="$(probe GAFFER_MODE=autonomous STRICT_MODE=0)"
[ "$got" = "STRICT_MODE=0 STRICT_REQUIRE=1" ] \
  && ok "explicit STRICT_MODE=0 is honoured (worker seam still fails closed — see 2)" \
  || fail "explicit STRICT_MODE=0 should be honoured (got: $got)"

# ── 2–4. worker seam ───────────────────────────────────────────────────────
export GAFFER_DATA="$WORK/.gaffer"; mkdir -p "$GAFFER_DATA"
MARKER="$WORK/spawned.marker"
FAKE_CLAUDE="$WORK/fake-claude"
cat > "$FAKE_CLAUDE" <<EOF
#!/usr/bin/env bash
: > "$MARKER"
printf '%s\n' '{"result":"ok","total_cost_usd":0.01,"num_turns":1}'
EOF
chmod +x "$FAKE_CLAUDE"
export CLAUDE_BIN="$FAKE_CLAUDE"
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
MCP="$WORK/mcp.json"; printf '{}' > "$MCP"
CWD="$WORK/cwd"; mkdir -p "$CWD"

run_bare() {   # worker_deliver with NO wrap (the reviewer/clarify/bootstrap/judge shape)
  local out="$WORK/out.json" errf="$WORK/err"
  rm -f "$MARKER"; : > "$out"
  WORKER_CALL_ENV=( "GAFFER_WRITE_ROOTS=$CWD" "GAFFER_READ_ROOTS=" )
  worker_deliver "$CWD" "the prompt" "" "$MCP" "$out" "" 2>"$errf"
  RC=$?; OUT_SIZE="$(wc -c < "$out" | tr -d ' ')"; ERR="$(cat "$errf")"
}

echo "== 2: sandbox REQUIRED + no provider → worker_deliver fails closed at a wrap-less site =="
STRICT_MODE=0 GAFFER_STRICT_REQUIRE=1 SANDBOX_PROVIDER=none run_bare
[ "$RC" = "75" ] && ok "rc 75 (fail closed)" || fail "expected rc 75, got $RC"
[ ! -f "$MARKER" ] && ok "the agent was NOT spawned" || fail "agent spawned despite a required, unavailable sandbox"
[ "$OUT_SIZE" = "0" ] && ok "no envelope written (parseResult reads unknown, never a fake 0)" || fail "envelope written ($OUT_SIZE bytes)"
case "$ERR" in *"fail closed"*) ok "refusal is loud and says 'fail closed'" ;; *) fail "no fail-closed message (got: $ERR)" ;; esac

STRICT_MODE=1 GAFFER_STRICT_REQUIRE=1 SANDBOX_PROVIDER=lima run_bare
[ "$RC" = "75" ] && [ ! -f "$MARKER" ] && ok "STRICT_MODE=1 + stub provider 'lima' → refused, no spawn" \
  || fail "lima stub under strict-require should refuse (rc=$RC marker=$([ -f "$MARKER" ] && echo yes || echo no))"

echo "== 3: sandbox off → invocation unchanged (spawns) =="
STRICT_MODE=0 GAFFER_STRICT_REQUIRE=0 SANDBOX_PROVIDER=none run_bare
[ "$RC" = "0" ] && [ -f "$MARKER" ] && ok "STRICT off: agent spawned, rc 0" || fail "sandbox off should spawn (rc=$RC)"
STRICT_MODE=1 GAFFER_STRICT_REQUIRE=0 SANDBOX_PROVIDER=none run_bare
[ "$RC" = "0" ] && [ -f "$MARKER" ] && ok "STRICT_MODE=1 + provider 'none' (not required) degrades and still spawns" \
  || fail "STRICT_MODE=1/none/not-required should degrade (rc=$RC)"

echo "== 4: a wrapping provider is APPLIED at a wrap-less call site =="
# Fake `docker` so sandbox_wrap_cmd emits the docker prefix; the wrapper runs in dry-run
# mode and prints the argv instead of executing — proving the wrap reached the seam.
FAKEBIN="$WORK/bin"; mkdir -p "$FAKEBIN"
printf '#!/usr/bin/env bash\nexit 0\n' > "$FAKEBIN/docker"; chmod +x "$FAKEBIN/docker"
out="$WORK/out.docker.json"; : > "$out"; rm -f "$MARKER"
WORKER_CALL_ENV=( "GAFFER_WRITE_ROOTS=$CWD" "GAFFER_READ_ROOTS=" )
PATH="$FAKEBIN:$PATH" STRICT_MODE=1 SANDBOX_PROVIDER=docker GAFFER_SANDBOX_DRY_RUN=1 \
  worker_deliver "$CWD" "the prompt" "" "$MCP" "$out" "" 2>/dev/null
rc=$?
[ "$rc" = "0" ] && ok "docker provider (dry-run) wrapped a wrap-less worker_deliver call (rc 0)" || fail "docker dry-run wrap rc=$rc"
[ ! -f "$MARKER" ] && ok "the host claude binary was NOT run directly (the wrap intercepted the spawn)" \
  || fail "host claude ran directly — the wrap was not applied"
grep -qx -- "$CWD:$CWD:rw" "$out" && ok "the write root is mounted rw in the container argv" || fail "write root mount missing from docker argv"
grep -qx "claude" "$out" && ok "inside docker the image's own \`claude\` is invoked, not the host path" \
  || fail "expected the container claude binary in argv (got: $(tr '\n' ' ' < "$out" | cut -c1-200))"
grep -q "^HOME=/root$" "$out" && ok "HOME is rebased to the container's /root" || fail "HOME not rebased for the container"

echo "== 5: tick.sh consults the provider when strict is REQUIRED, not only STRICT_MODE=1 =="
grep -qE 'if \[ "\$\{STRICT_MODE:-0\}" = "1" \] \|\| _sandbox_strict_required; then' "$RUNNER_DIR/tick.sh" \
  && ok "tick.sh guard: STRICT_MODE=1 OR _sandbox_strict_required" \
  || fail "tick.sh still gates the sandbox on STRICT_MODE alone"

echo "== 6: docker wrapper mounts the factory's packages + node_modules and follows symlinks =="
HOME_FAKE="$WORK/home"; mkdir -p "$HOME_FAKE/packages/dispatch/dist" "$HOME_FAKE/node_modules/.pnpm" "$HOME_FAKE/runner"
REAL_REPO="$WORK/real-repo"; mkdir -p "$REAL_REPO/node_modules/.bin"
WT="$WORK/wt"; mkdir -p "$WT"; ln -s "$REAL_REPO/node_modules" "$WT/node_modules"
WRF="$WORK/wr"; printf '%s\n' "$WT" > "$WRF"; RRF="$WORK/rr"; : > "$RRF"
ARGV="$(cd "$WT" && GAFFER_HOME="$HOME_FAKE" RUNNER_DIR="$HOME_FAKE/runner" GAFFER_DATA="$GAFFER_DATA" GAFFER_SANDBOX_DRY_RUN=1 \
  bash "$RUNNER_DIR/lib/sandbox-docker.sh" "$WRF" "$RRF" -- true 2>&1)"
grep -q -- "$HOME_FAKE/packages:$HOME_FAKE/packages:ro" <<<"$ARGV" && ok "\$GAFFER_HOME/packages mounted ro (MCP dist bins reachable)" || fail "packages/ not mounted"
grep -q -- "$HOME_FAKE/node_modules:$HOME_FAKE/node_modules:ro" <<<"$ARGV" && ok "\$GAFFER_HOME/node_modules mounted ro (MCP imports resolve)" || fail "node_modules/ not mounted"
grep -q -- "$REAL_REPO/node_modules:$REAL_REPO/node_modules:ro" <<<"$ARGV" && ok "worktree node_modules symlink target mounted ro (DoD gate can run)" || fail "symlink target not mounted"
! grep -q -- "$HOME_FAKE:$HOME_FAKE:" <<<"$ARGV" && ok "the WHOLE \$GAFFER_HOME is NOT mounted (factory .env stays unreadable)" || fail "GAFFER_HOME root mounted"
[ "$(grep -c -- "$HOME_FAKE/runner:$HOME_FAKE/runner:ro" <<<"$ARGV")" = "1" ] && ok "runner dir mounted exactly once" || fail "runner dir mount count wrong"

echo "== 7: SANDBOX_PROVIDER auto-detects docker where the CLI exists (explicit env wins) =="
provider_for() {   # $1 = PATH to use; prints the resolved default provider
  env -i PATH="$1" HOME="$HOME" GAFFER_DATA="$WORK/data" bash -c '
    source "'"$RUNNER_DIR"'/factory.config.sh" >/dev/null 2>&1; printf "%s" "${SANDBOX_PROVIDER:-}"'
}
DBIN="$WORK/dbin"; mkdir -p "$DBIN"; printf '#!/usr/bin/env bash\nexit 0\n' > "$DBIN/docker"; chmod +x "$DBIN/docker"
if command -v sandbox-exec >/dev/null 2>&1; then
  [ "$(provider_for "$PATH")" = "sandbox-exec" ] && ok "macOS host: default provider is sandbox-exec" || fail "expected sandbox-exec on a host with the binary"
else
  [ "$(provider_for "$DBIN:$PATH")" = "docker" ] && ok "no sandbox-exec + docker CLI on PATH → default provider docker" || fail "expected docker default (got $(provider_for "$DBIN:$PATH"))"
  # A PATH with every tool the config needs EXCEPT docker (the host may have a real docker CLI).
  NBIN="$WORK/nbin"; mkdir -p "$NBIN"
  for t in bash sh env node python3 jq git uname id mktemp date sed awk grep cut tr head tail cat sort wc dirname basename readlink realpath command; do
    src="$(command -v "$t" 2>/dev/null || true)"; [ -n "$src" ] && ln -sf "$src" "$NBIN/$t"
  done
  [ "$(provider_for "$NBIN")" = "sandbox-exec" ] && ok "no sandbox-exec, no docker → default stays sandbox-exec (honest refusal text)" || fail "expected sandbox-exec fallback (got $(provider_for "$NBIN"))"
fi
[ "$(env -i PATH="$DBIN:$PATH" HOME="$HOME" GAFFER_DATA="$WORK/data" SANDBOX_PROVIDER=none bash -c 'source "'"$RUNNER_DIR"'/factory.config.sh" >/dev/null 2>&1; printf "%s" "$SANDBOX_PROVIDER"')" = "none" ] \
  && ok "explicit SANDBOX_PROVIDER=none wins over auto-detect" || fail "explicit provider should win"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "autonomy-containment: ALL $PASS checks passed"; exit 0
fi
echo "autonomy-containment: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
