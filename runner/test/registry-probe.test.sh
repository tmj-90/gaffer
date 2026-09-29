#!/usr/bin/env bash
# =====================================================================
# lib/registry-probe.sh — the EXECUTION preflight: `npm ping` from inside the
# agent's allowlisted env, bounded, retries off; preflight.sh reports it and the
# bootstrap path parks BEFORE spawning when it fails. Deterministic: `npm` is a
# stub on PATH that records the env it saw and answers as told.
#   1. reachable → rc 0
#   2. TLS failure → rc 1, code SELF_SIGNED_CERT_IN_CHAIN, CA hint, detail line
#   3. DNS failure → rc 1, code ENOTFOUND, proxy-route hint
#   4. a hung registry → rc 1, code timeout (bounded by the timeout arg)
#   5. knob off / npm missing → rc 2 (skipped), never a refusal
#   6. the stub ran under the AGENT env (env -i: a runner-only secret is absent,
#      the trust store is present) with retries off
#   7. preflight.sh prints ✓ on success and ✗ + code + hint on failure
#   8. WIRING: tick.sh gates the bootstrap on the probe, parks to blocked with
#      env_registry_unreachable BEFORE gaffer_bootstrap_init
# Run: bash runner/test/registry-probe.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/registry-probe.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"
# The stub: MODE file decides the answer; it dumps its env for check 6.
cat > "$WORK/bin/npm" <<'STUB'
#!/usr/bin/env bash
env > "${STUB_ENV_DUMP_FILE:-/dev/null}" 2>/dev/null || true
mode="$(cat "$STUB_MODE_FILE" 2>/dev/null || echo ok)"
case "$mode" in
  ok)   echo "npm notice PONG 12ms"; exit 0 ;;
  tls)  echo "npm error code SELF_SIGNED_CERT_IN_CHAIN" >&2
        echo "npm error errno SELF_SIGNED_CERT_IN_CHAIN" >&2
        echo "npm error request to https://registry.npmjs.org/-/ping failed, reason: self-signed certificate in certificate chain" >&2; exit 1 ;;
  dns)  echo "npm error code ENOTFOUND" >&2; echo "npm error network getaddrinfo ENOTFOUND registry.npmjs.org" >&2; exit 1 ;;
  hang) sleep 30; exit 0 ;;
esac
STUB
chmod +x "$WORK/bin/npm"
MODE="$WORK/mode"; DUMP="$WORK/env.dump"
# STUB_* must reach the stub THROUGH the agent allowlist → ride the GAFFER_ prefix?
# No: the allowlist is the thing under test, so the stub reads them from files
# named by absolute paths baked in here instead.
sed -i.bak "s|\${STUB_MODE_FILE}|$MODE|; s|\${STUB_ENV_DUMP_FILE:-/dev/null}|$DUMP|; s|\$STUB_MODE_FILE|$MODE|" "$WORK/bin/npm" && rm -f "$WORK/bin/npm.bak"

export PATH="$WORK/bin:$PATH"
export HOME="$WORK/home"; mkdir -p "$HOME"
export RUNNER_SECRET_TOKEN="leak-me-not" NODE_EXTRA_CA_CERTS="/etc/corp/ca.pem" HTTPS_PROXY="http://proxy:3128"
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
declare -F gaffer_registry_probe >/dev/null || { echo "FAIL: gaffer_registry_probe not sourced via factory.config.sh"; exit 1; }

echo "== 1: reachable =="
echo ok > "$MODE"
gaffer_registry_probe 5; rc=$?
[ "$rc" -eq 0 ] && ok "reachable registry → rc 0" || fail "reachable → rc $rc (code=$GAFFER_REGISTRY_PROBE_CODE)"

echo "== 2: TLS failure names the code + the CA hint =="
echo tls > "$MODE"
gaffer_registry_probe 5; rc=$?
[ "$rc" -eq 1 ] && ok "TLS failure → rc 1" || fail "TLS failure → rc $rc"
[ "$GAFFER_REGISTRY_PROBE_CODE" = "SELF_SIGNED_CERT_IN_CHAIN" ] && ok "code parsed from 'npm error code …'" || fail "code='$GAFFER_REGISTRY_PROBE_CODE'"
case "$GAFFER_REGISTRY_PROBE_DETAIL" in *"SELF_SIGNED_CERT_IN_CHAIN"*) ok "detail carries the first npm error line" ;; *) fail "detail='$GAFFER_REGISTRY_PROBE_DETAIL'" ;; esac
case "$(gaffer_registry_probe_hint "$GAFFER_REGISTRY_PROBE_CODE")" in
  *NODE_EXTRA_CA_CERTS*cafile*) ok "hint: CA bundle via NODE_EXTRA_CA_CERTS + npm cafile" ;;
  *) fail "TLS hint wrong: $(gaffer_registry_probe_hint "$GAFFER_REGISTRY_PROBE_CODE")" ;;
esac
case "$(gaffer_registry_probe_hint SELF_SIGNED_CERT_IN_CHAIN)" in *"never disable TLS"*) ok "hint never suggests disabling TLS verification" ;; *) fail "hint lacks the never-disable-TLS line" ;; esac

echo "== 3: DNS failure → proxy-route hint =="
echo dns > "$MODE"
gaffer_registry_probe 5; rc=$?
[ "$rc" -eq 1 ] && [ "$GAFFER_REGISTRY_PROBE_CODE" = "ENOTFOUND" ] && ok "ENOTFOUND parsed" || fail "dns: rc=$rc code=$GAFFER_REGISTRY_PROBE_CODE"
case "$(gaffer_registry_probe_hint ENOTFOUND)" in *HTTPS_PROXY*) ok "hint names the proxy route" ;; *) fail "ENOTFOUND hint wrong" ;; esac

echo "== 4: a hung registry is bounded =="
echo hang > "$MODE"
s=$(date +%s); gaffer_registry_probe 2; rc=$?; took=$(( $(date +%s) - s ))
[ "$rc" -eq 1 ] && [ "$GAFFER_REGISTRY_PROBE_CODE" = "timeout" ] && ok "hang → rc 1, code timeout" || fail "hang: rc=$rc code=$GAFFER_REGISTRY_PROBE_CODE"
[ "$took" -lt 15 ] && ok "bounded (${took}s, not the stub's 30s)" || fail "took ${took}s"

echo "== 5: skipped is never a refusal =="
echo ok > "$MODE"
GAFFER_REGISTRY_PROBE=0 gaffer_registry_probe 5; rc=$?
[ "$rc" -eq 2 ] && [ "$GAFFER_REGISTRY_PROBE_CODE" = "skipped" ] && ok "GAFFER_REGISTRY_PROBE=0 → rc 2 skipped" || fail "knob off: rc=$rc code=$GAFFER_REGISTRY_PROBE_CODE"
( PATH="/nonexistent"; export PATH; gaffer_registry_probe 5; rc=$?; [ "$rc" -eq 2 ] && [ "$GAFFER_REGISTRY_PROBE_CODE" = "no-npm" ] ) && ok "npm missing → rc 2 no-npm" || fail "npm missing not skipped"

echo "== 6: the probe runs under the AGENT env =="
echo ok > "$MODE"; : > "$DUMP"
gaffer_registry_probe 5 >/dev/null
grep -q '^RUNNER_SECRET_TOKEN=' "$DUMP" && fail "a runner-only *_TOKEN reached the probe (not the agent env)" || ok "env -i + allowlist: runner secret absent"
grep -q '^NODE_EXTRA_CA_CERTS=/etc/corp/ca.pem$' "$DUMP" && ok "trust store present (as the agent gets it)" || fail "NODE_EXTRA_CA_CERTS missing from the probe env"
grep -q '^HTTPS_PROXY=' "$DUMP" && ok "proxy route present" || fail "HTTPS_PROXY missing"
grep -q '^npm_config_fetch_retries=0$' "$DUMP" && ok "retries off (one attempt answers)" || fail "fetch_retries not 0"
grep -q "^HOME=$HOME\$" "$DUMP" && ok "HOME passed (so ~/.npmrc cafile applies)" || fail "HOME wrong"

echo "== 7: preflight.sh reports the probe =="
echo ok > "$MODE"
OUT="$(bash "$RUNNER_DIR/preflight.sh" 2>&1)"
printf '%s\n' "$OUT" | grep -q 'npm registry reachable from the agent env' && ok "preflight ✓ line on success" || fail "preflight success line missing"
echo tls > "$MODE"
OUT="$(bash "$RUNNER_DIR/preflight.sh" 2>&1)"
printf '%s\n' "$OUT" | grep -q 'npm registry UNREACHABLE from the agent env (SELF_SIGNED_CERT_IN_CHAIN)' && ok "preflight ✗ line names the code" || fail "preflight failure line missing: $(printf '%s\n' "$OUT" | grep -i registry)"
printf '%s\n' "$OUT" | grep -q 'NODE_EXTRA_CA_CERTS' && ok "preflight failure line carries the fix hint" || fail "preflight hint missing"
echo ok > "$MODE"
OUT="$(GAFFER_REGISTRY_PROBE=0 bash "$RUNNER_DIR/preflight.sh" 2>&1)"
printf '%s\n' "$OUT" | grep -q 'npm registry probe skipped (skipped)' && ok "preflight ! line when skipped" || fail "preflight skipped line missing"

echo "== 8: WIRING — tick.sh gates the bootstrap before spawning =="
TICK="$RUNNER_DIR/tick.sh"
PROBE_LINE="$(grep -n 'gaffer_registry_probe || _PROBE_RC' "$TICK" | head -1 | cut -d: -f1)"
INIT_LINE="$(grep -n 'if ! gaffer_bootstrap_init "\$B_DIR"' "$TICK" | head -1 | cut -d: -f1)"
[ -n "$PROBE_LINE" ] && ok "tick.sh calls gaffer_registry_probe on the bootstrap path" || fail "no probe call in tick.sh"
[ -n "$PROBE_LINE" ] && [ -n "$INIT_LINE" ] && [ "$PROBE_LINE" -lt "$INIT_LINE" ] && ok "probe runs BEFORE gaffer_bootstrap_init (nothing created, nothing spent)" || fail "probe not before init ($PROBE_LINE vs $INIT_LINE)"
grep -q 'gaffer_release_delivery blocked "\$_PROBE_WHY" env_registry_unreachable' "$TICK" && ok "unreachable → blocked with reason code env_registry_unreachable" || fail "park shape missing"
grep -q 'python\*|go|golang|rust' "$TICK" && ok "clearly non-node stacks skip the probe" || fail "stack filter missing"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "registry-probe: ALL $PASS checks passed"; exit 0; fi
echo "registry-probe: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1
