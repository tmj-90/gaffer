#!/usr/bin/env bash
# =====================================================================
# Greenfield behind a TLS-intercepting proxy: no `npm config set cafile` step.
# ---------------------------------------------------------------------
# The quickstart used to tell a person behind a corporate proxy to export the trust
# store AND run `npm config set cafile <bundle>`, because "npm reads its CA from its
# own config". npm (10.x) honours NODE_EXTRA_CA_CERTS like any Node program, and the
# DoD pre-gate install runs with a THROWAWAY HOME, so a ~/.npmrc cafile never reached
# it anyway. The gap is the operator who exported the bundle for curl / git / python
# (SSL_CERT_FILE, CURL_CA_BUNDLE, REQUESTS_CA_BUNDLE, GIT_SSL_CAINFO) but not for
# Node: the agent's npm then fails the proxy's certificate. The runner now derives
# NODE_EXTRA_CA_CERTS from that bundle for the agent env and the DoD install env.
# It only EXTENDS Node's roots (never replaces them) and never overrides an explicit
# NODE_EXTRA_CA_CERTS.
#   1. agent env: SSL_CERT_FILE only → NODE_EXTRA_CA_CERTS=<that bundle>
#   2. an explicit NODE_EXTRA_CA_CERTS is kept, never replaced
#   3. a bundle path that is not a readable file is not used
#   4. the DoD install env carries the derived value too
#   5. REAL npm against a local HTTPS registry with a self-signed certificate, the
#      certificate exported only as SSL_CERT_FILE: the registry probe (npm ping in
#      the agent env) reaches it. Before the change it failed DEPTH_ZERO_SELF_SIGNED_CERT.
# Run: bash runner/test/greenfield-proxy-ca.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
# shellcheck source=lib/skip.sh
. "$HERE/lib/skip.sh"

command -v node >/dev/null 2>&1 || gaffer_skip "node required"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/proxy-ca.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
SRV_PID=""
trap '[ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null; gaffer_test_rm_work "$WORK"' EXIT

# A clean network env: no inherited proxy route or trust store from the caller.
unset HTTPS_PROXY HTTP_PROXY ALL_PROXY https_proxy http_proxy all_proxy NO_PROXY no_proxy \
  NODE_EXTRA_CA_CERTS SSL_CERT_FILE SSL_CERT_DIR CURL_CA_BUNDLE REQUESTS_CA_BUNDLE GIT_SSL_CAINFO
for _v in $(compgen -e | grep -i '^npm_config_' || true); do unset "$_v"; done
export HOME="$WORK/home"; mkdir -p "$HOME"
BUNDLE="$WORK/corp-ca.pem"; printf 'placeholder\n' > "$BUNDLE"

# shellcheck source=lib/isolate.sh
. "$HERE/lib/isolate.sh"; gaffer_test_isolate "$WORK"
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
declare -F gaffer_agent_env >/dev/null || { echo "FAIL: gaffer_agent_env not sourced"; exit 1; }

agent_env_value() {  # $1 = name → its value in GAFFER_AGENT_ENV (empty when absent)
  gaffer_agent_env
  local kv
  for kv in ${GAFFER_AGENT_ENV[@]+"${GAFFER_AGENT_ENV[@]}"}; do
    case "$kv" in "$1="*) printf '%s' "${kv#"$1="}"; return 0 ;; esac
  done
}

echo "== 1: a bundle exported for other tools reaches Node in the agent env =="
for var in SSL_CERT_FILE CURL_CA_BUNDLE REQUESTS_CA_BUNDLE GIT_SSL_CAINFO; do
  got="$(env "$var=$BUNDLE" bash -c '
    . "$1/factory.config.sh" >/dev/null 2>&1
    gaffer_agent_env
    for kv in ${GAFFER_AGENT_ENV[@]+"${GAFFER_AGENT_ENV[@]}"}; do
      case "$kv" in NODE_EXTRA_CA_CERTS=*) printf "%s" "${kv#NODE_EXTRA_CA_CERTS=}" ;; esac
    done' _ "$RUNNER_DIR")"
  [ "$got" = "$BUNDLE" ] && ok "$var only → the agent env gets NODE_EXTRA_CA_CERTS=<that bundle>" \
    || fail "$var only → NODE_EXTRA_CA_CERTS='$got' (want $BUNDLE)"
done

echo "== 2: an explicit NODE_EXTRA_CA_CERTS is never replaced =="
OTHER="$WORK/node-ca.pem"; printf 'x\n' > "$OTHER"
got="$(NODE_EXTRA_CA_CERTS="$OTHER" SSL_CERT_FILE="$BUNDLE" bash -c '
  . "$1/factory.config.sh" >/dev/null 2>&1; gaffer_agent_env
  n=0; for kv in "${GAFFER_AGENT_ENV[@]}"; do case "$kv" in NODE_EXTRA_CA_CERTS=*) n=$((n+1)); printf "%s;" "${kv#NODE_EXTRA_CA_CERTS=}" ;; esac; done' _ "$RUNNER_DIR")"
[ "$got" = "$OTHER;" ] && ok "the operator's NODE_EXTRA_CA_CERTS is kept, once" || fail "explicit value changed: '$got'"

echo "== 3: a path that is not a readable file is not used =="
got="$(SSL_CERT_FILE="$WORK/missing.pem" bash -c '
  . "$1/factory.config.sh" >/dev/null 2>&1; gaffer_agent_env
  for kv in "${GAFFER_AGENT_ENV[@]}"; do case "$kv" in NODE_EXTRA_CA_CERTS=*) printf "%s" "$kv" ;; esac; done' _ "$RUNNER_DIR")"
[ -z "$got" ] && ok "a missing bundle derives nothing" || fail "derived from a missing file: '$got'"
[ -z "$(agent_env_value NODE_EXTRA_CA_CERTS)" ] && ok "nothing exported → nothing derived" || fail "derived with no bundle exported"

echo "== 4: the DoD pre-gate install env carries it too =="
got="$(SSL_CERT_FILE="$BUNDLE" bash -c '
  . "$1/factory.config.sh" >/dev/null 2>&1
  declare -F gaffer_dod_install_env >/dev/null || { echo "no-fn"; exit 0; }
  GAFFER_DOD_WRAP="" gaffer_dod_install_env ienv ihome
  for kv in "${ienv[@]}"; do case "$kv" in NODE_EXTRA_CA_CERTS=*) printf "%s" "${kv#NODE_EXTRA_CA_CERTS=}" ;; esac; done
  [ -n "$ihome" ] && rm -rf "$ihome"' _ "$RUNNER_DIR")"
[ "$got" = "$BUNDLE" ] && ok "gaffer_dod_install_env: NODE_EXTRA_CA_CERTS=<bundle> (its throwaway HOME never reads ~/.npmrc)" \
  || fail "DoD install env NODE_EXTRA_CA_CERTS='$got'"

echo "== 5: REAL npm, a self-signed local registry, the CA exported only as SSL_CERT_FILE =="
if command -v npm >/dev/null 2>&1 && command -v openssl >/dev/null 2>&1; then
  cat > "$WORK/openssl.cnf" <<'CNF'
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = localhost
[ext]
subjectAltName = DNS:localhost,IP:127.0.0.1
basicConstraints = critical,CA:TRUE
CNF
  if openssl req -x509 -newkey rsa:2048 -nodes -days 2 -keyout "$WORK/key.pem" -out "$WORK/cert.pem" \
       -config "$WORK/openssl.cnf" >/dev/null 2>&1; then
    cat > "$WORK/registry.js" <<'JS'
const https = require("node:https"), fs = require("node:fs"), dir = process.argv[2];
const srv = https.createServer(
  { key: fs.readFileSync(dir + "/key.pem"), cert: fs.readFileSync(dir + "/cert.pem") },
  (_req, res) => { res.setHeader("content-type", "application/json"); res.end("{}"); },
);
srv.listen(0, "127.0.0.1", () => fs.writeFileSync(dir + "/port", String(srv.address().port)));
JS
    node "$WORK/registry.js" "$WORK" & SRV_PID=$!
    i=0; while [ ! -s "$WORK/port" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i+1)); done
    PORT="$(cat "$WORK/port" 2>/dev/null || echo '')"
    if [ -n "$PORT" ]; then
      probe() {  # extra env assignments → "rc code"
        env "$@" npm_config_registry="https://localhost:$PORT/" bash -c '
          . "$1/factory.config.sh" >/dev/null 2>&1
          gaffer_registry_probe 20; rc=$?
          printf "%s %s" "$rc" "$GAFFER_REGISTRY_PROBE_CODE"' _ "$RUNNER_DIR"
      }
      got="$(probe GAFFER_REGISTRY_PROBE=1)"
      case "$got" in "1 "*) ok "control: no CA exported → the probe fails (${got#1 })" ;;
        *) fail "control: the self-signed registry was reachable without its CA ('$got')" ;; esac
      got="$(probe GAFFER_REGISTRY_PROBE=1 SSL_CERT_FILE="$WORK/cert.pem")"
      [ "${got%% *}" = "0" ] && ok "SSL_CERT_FILE only → npm in the agent env reaches the registry (no npm cafile step)" \
        || fail "SSL_CERT_FILE only → probe '$got' (the agent's npm does not trust the bundle)"
      got="$(probe GAFFER_REGISTRY_PROBE=1 NODE_EXTRA_CA_CERTS="$WORK/cert.pem")"
      [ "${got%% *}" = "0" ] && ok "NODE_EXTRA_CA_CERTS alone is enough for npm (no ~/.npmrc cafile needed)" \
        || fail "NODE_EXTRA_CA_CERTS → probe '$got'"
    else
      fail "the local HTTPS registry did not start"
    fi
  else
    fail "openssl could not mint a self-signed certificate"
  fi
else
  gaffer_skip_part "check 5 — npm or openssl missing"
fi

echo "== 6: the CA hint no longer sends the operator to npm config =="
case "$(gaffer_registry_probe_hint SELF_SIGNED_CERT_IN_CHAIN)" in
  *"npm config set cafile"*) fail "the TLS hint still asks for \`npm config set cafile\`" ;;
  *NODE_EXTRA_CA_CERTS*SSL_CERT_FILE*) ok "the TLS hint names NODE_EXTRA_CA_CERTS or SSL_CERT_FILE, nothing else to run" ;;
  *) fail "TLS hint: $(gaffer_registry_probe_hint SELF_SIGNED_CERT_IN_CHAIN)" ;;
esac

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "greenfield-proxy-ca: ALL $PASS checks passed"; exit 0; fi
echo "greenfield-proxy-ca: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1
