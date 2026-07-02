#!/usr/bin/env bash
# =====================================================================
# AFK-LOOP Phase 1 — dashboard deep-link env (runner/gaffer).
# ---------------------------------------------------------------------
# Proves `gaffer dashboard` exports GAFFER_DASHBOARD_URL into the server
# env so push-notification deep-links (emitDecisionGate / ticketUrl in
# core.ts) actually resolve:
#   AC1  `gaffer dashboard --lan` passes GAFFER_DASHBOARD_URL=http://<LAN>:<port>
#        to the launched server process
#   AC2  `gaffer dashboard` (loopback) passes http://127.0.0.1:<port>
#
# Hermetic: shadows `node` + `curl` on PATH with fakes. The fake `node`
# records its GAFFER_DASHBOARD_URL env when launched as the api server;
# the fake `curl` reports the health check green. No real dist build, no
# real network, no real server — so this runs even when unbuilt.
# Run: bash test/dashboard-deeplink.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0; FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/dashboard-deeplink-test.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

BINDIR="$WORK/bin"; mkdir -p "$BINDIR"
CAPTURE="$WORK/captured-url"

# Fake node: when launched as the dashboard server (argv carries the api bin),
# record the deep-link base it was handed, then exit 0 so nothing lingers. Every
# other invocation (factory.config's settings.json reader `node -e …`) is a
# silent no-op success.
cat > "$BINDIR/node" <<EOF
#!/usr/bin/env bash
for a in "\$@"; do
  case "\$a" in
    */dist/api/bin.js) printf '%s\n' "\${GAFFER_DASHBOARD_URL:-<UNSET>}" > "$CAPTURE"; exit 0 ;;
  esac
done
exit 0
EOF
chmod +x "$BINDIR/node"

# Fake curl: the health-check probe always reports the server up.
cat > "$BINDIR/curl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$BINDIR/curl"

run_gaffer() {
  # Fresh data dir per run so a prior run's (dead) pid file never masks the launch.
  local data="$1"; shift
  mkdir -p "$data"
  rm -f "$CAPTURE"
  PATH="$BINDIR:$PATH" GAFFER_DATA="$data" GAFFER_HOME="$RUNNER_DIR/.." \
    bash "$RUNNER_DIR/gaffer" dashboard "$@" >/dev/null 2>&1
  # The server launch is backgrounded; wait briefly for the fake to record.
  local i=0
  while [ ! -s "$CAPTURE" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i+1)); done
  cat "$CAPTURE" 2>/dev/null || true
}

echo "== AC1: --lan exports GAFFER_DASHBOARD_URL=http://<LAN>:<port> =="
url_lan="$(run_gaffer "$WORK/data-lan" --lan)"
if printf '%s' "$url_lan" | grep -Eq '^http://.+:8787$'; then
  ok "--lan server env carried GAFFER_DASHBOARD_URL ($url_lan)"
else
  fail "--lan did not export a http://<host>:8787 deep-link base (got '$url_lan')"
fi

# BUG #6: --lan must PERSIST that LAN base to $GAFFER_DATA/dashboard-url so the
# SEPARATE factory loop process (which only sees factory.config.sh's loopback
# default) deep-links its AFK ping to the reachable LAN url, not 127.0.0.1.
if [ -s "$WORK/data-lan/dashboard-url" ] \
   && grep -Eq '^http://.+:8787$' "$WORK/data-lan/dashboard-url"; then
  ok "--lan persists the LAN deep-link base to \$GAFFER_DATA/dashboard-url (loop reads it)"
else
  fail "--lan did not persist a LAN url to dashboard-url (got '$(cat "$WORK/data-lan/dashboard-url" 2>/dev/null)')"
fi

echo "== AC2: loopback dashboard exports the 127.0.0.1 base =="
# Pre-seed a stale persisted LAN url so the degrade assertion is meaningful.
mkdir -p "$WORK/data-local"; printf 'http://10.0.0.9:8787\n' > "$WORK/data-local/dashboard-url"
url_local="$(run_gaffer "$WORK/data-local")"
if [ "$url_local" = "http://127.0.0.1:8787" ]; then
  ok "loopback server env carried $url_local"
else
  fail "loopback did not export http://127.0.0.1:8787 (got '$url_local')"
fi

# BUG #6 (degrade): a non-lan dashboard is loopback-only, so it must drop any stale
# persisted LAN url — else the loop would keep deep-linking to an unserved address.
if [ -e "$WORK/data-local/dashboard-url" ]; then
  fail "loopback dashboard left a stale persisted LAN url (should be removed)"
else
  ok "loopback dashboard removes any stale persisted LAN url (degrades to loopback)"
fi

# PROOF (static): the front door builds the var in both dashboard paths.
grep -q 'export GAFFER_DASHBOARD_URL="http://\$LAN:\$DASH_PORT"' "$RUNNER_DIR/gaffer" \
  && ok "gaffer sets the LAN deep-link base" || fail "gaffer missing the LAN deep-link base"
grep -q 'export GAFFER_DASHBOARD_URL="http://127.0.0.1:\$DASH_PORT"' "$RUNNER_DIR/gaffer" \
  && ok "gaffer sets the loopback deep-link base" || fail "gaffer missing the loopback deep-link base"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "  ALL PASS ($PASS checks)"; exit 0
else printf '  %d FAILURE(S), %d passed\n' "${#FAILURES[@]}" "$PASS"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1; fi
