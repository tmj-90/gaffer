#!/usr/bin/env bash
# `gaffer dashboard --foreground` — the container / supervisor launch path. It must
# exec the SAME server with the SAME action-command env as the detached paths (so
# every dashboard button works), always token-protected, binding loopback by
# default and every interface with --lan, and print the login URL before exec.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; RUNNER_DIR="$(cd "$HERE/.." && pwd)"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/gaffer-fg.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
BINDIR="$WORK/bin"; mkdir -p "$BINDIR"; CAP="$WORK/capture"
# Fake node: when asked to run the dashboard bin, record argv + the env it received, then
# exit. Every OTHER node call (factory.config.sh reading settings.json, the launcher
# reading the setting keys from the dispatch dist) runs the real node, so the env scrub
# is exercised exactly as it runs live.
REAL_NODE="$(command -v node)"
cat > "$BINDIR/node" <<EOF2
#!/usr/bin/env bash
for a in "\$@"; do case "\$a" in */dist/api/bin.js) { printf 'ARGV:%s\n' "\$*"; env | grep -E '^(DISPATCH_|GAFFER_|MAX_|_GAFFER_)' | sort; } > "$CAP"; exit 0 ;; esac; done
exec "$REAL_NODE" "\$@"
EOF2
chmod +x "$BINDIR/node"

run_fg() { local data="$1"; shift; mkdir -p "$data"; rm -f "$CAP"
  PATH="$BINDIR:$PATH" GAFFER_DATA="$data" GAFFER_HOME="$RUNNER_DIR/.." GAFFER_TICK_TIMEOUT=77 bash "$RUNNER_DIR/gaffer" dashboard --foreground "$@" 2>&1; }

echo "== loopback default =="
OUT="$(run_fg "$WORK/d1")"; RC=$?
[ "$RC" -eq 0 ] && ok "exits with the server's status (fake server 0)" || fail "rc=$RC"
grep -q "ARGV:.*--host 127.0.0.1" "$CAP" && ok "binds loopback without --lan" || fail "host wrong: $(grep ARGV "$CAP")"
grep -q "ARGV:.*--port 8787" "$CAP" && ok "passes the port" || fail "port missing"
[ -s "$WORK/d1/dashboard-token" ] && ok "token file created (always token-protected)" || fail "no token file"
TOK="$(cat "$WORK/d1/dashboard-token")"
grep -q "^DISPATCH_API_TOKEN=$TOK$" "$CAP" && ok "the server received the token" || fail "server token missing"
grep -q "?token=$TOK" <<<"$OUT" && ok "login URL with the token printed BEFORE exec (for container logs)" || fail "login URL not printed: $OUT"
for v in DISPATCH_TICK_CMD DISPATCH_MERGE_CMD DISPATCH_ONBOARD_CMD DISPATCH_PRODUCT_OWNER_CMD DISPATCH_EPIC_FEATURE_CMD DISPATCH_DB GAFFER_DASHBOARD_URL; do
  grep -q "^$v=." "$CAP" && ok "action-command env wired: $v" || fail "$v missing from the server env"
done
# The tester has no dashboard button and the tick runs the bundled bin/tester-run.mjs,
# so a DISPATCH_TESTER_CMD knob would be a setting that changes nothing.
grep -q "^DISPATCH_TESTER_CMD=" "$CAP" && fail "the dead DISPATCH_TESTER_CMD is still exported to the server" \
  || ok "no dead DISPATCH_TESTER_CMD in the server env (the tick runs bin/tester-run.mjs itself)"
grep -q "^GAFFER_TICK_TIMEOUT=" "$CAP" && fail "runner-only knob leaked into the server env" || ok "runner-only knobs are unset for the server (same scrub as the detached path)"
# …and so are the bounds the config derived from them (else a dashboard tick kept a
# 77s-derived outer bound under the default 1800s per-call cap).
for k in GAFFER_TICK_OUTER_TIMEOUT GAFFER_CLAIM_TTL; do
  grep -q "^$k=" "$CAP" && fail "$k (derived from the dropped GAFFER_TICK_TIMEOUT) leaked into the server env" || ok "$k derived from a tick-only knob is not in the server env"
done
GAFFER_TICK_OUTER_TIMEOUT=999 run_fg "$WORK/d1b" >/dev/null
grep -q "^GAFFER_TICK_OUTER_TIMEOUT=999$" "$CAP" && ok "an operator-set GAFFER_TICK_OUTER_TIMEOUT stays" || fail "the operator's GAFFER_TICK_OUTER_TIMEOUT was scrubbed"
[ -f "$WORK/d1/dashboard.pid" ] && fail "foreground must not write a pid file" || ok "no pid file (the supervisor owns the process)"

echo "== config-derived settings never reach the server as env (else the UI shows them env-locked) =="
if [ -f "$RUNNER_DIR/../packages/dispatch/dist/api/settings.js" ]; then
  mkdir -p "$WORK/d3"
  # A value saved through the dashboard earlier, and one the operator set for real.
  printf '{"MAX_TICKS_PER_DAY":"7","GAFFER_IDLE_MODE":""}\n' > "$WORK/d3/settings.json"
  ERR="$(GAFFER_REWORK_BUDGET_USD=3 run_fg "$WORK/d3" 2>&1 >/dev/null)"
  for k in GAFFER_CONCURRENCY GAFFER_DAILY_BUDGET_USD GAFFER_PAUSE_ON_CAP GAFFER_REQUIRE_CI MAX_TICKS_PER_DAY GAFFER_CI_POLL_ATTEMPTS; do
    grep -q "^$k=" "$CAP" && fail "$k (a default / settings.json value) leaked into the server env — the UI would lock it" || ok "$k is not in the server env (editable in the UI)"
  done
  grep -q "^GAFFER_REWORK_BUDGET_USD=3$" "$CAP" && ok "an operator-set key stays (a real env override locks it)" || fail "the operator's GAFFER_REWORK_BUDGET_USD was scrubbed"
  grep -q "^_GAFFER_" "$CAP" && fail "the launcher's re-source bookkeeping leaked into the server env: $(grep '^_GAFFER_' "$CAP" | cut -d= -f1 | head -3 | tr '\n' ' ')" || ok "no _GAFFER_* bookkeeping in the server env"
  grep -q "could not read the setting keys" <<<"$ERR" && fail "the setting-key reader failed: $ERR" || ok "the setting keys were read from the dispatch dist (no warning)"
  # A dist the reader cannot load is reported, never silently ignored.
  mkdir -p "$WORK/baddist/dist/api"; printf 'export const SETTING_DEFS = [;\n' > "$WORK/baddist/dist/api/settings.js"
  ( source "$RUNNER_DIR/lib/dashboard.sh"; DISPATCH_DIR="$WORK/baddist" PATH="$BINDIR:$PATH" gaffer_dashboard_env_unset_flags ) 2>"$WORK/bad.err" >/dev/null
  grep -q "could not read the setting keys" "$WORK/bad.err" && ok "an unreadable settings dist warns loudly (no silent || true)" || fail "an unreadable settings dist was swallowed: $(cat "$WORK/bad.err")"
else
  echo "SKIP: dispatch dist not built (pnpm -C packages/dispatch build)"
fi

echo "== --lan binds every interface =="
run_fg "$WORK/d2" --lan >/dev/null
grep -q "ARGV:.*--host 0.0.0.0" "$CAP" && ok "--foreground --lan binds 0.0.0.0" || fail "lan host wrong: $(grep ARGV "$CAP")"

echo "== compose + devcontainer are well-formed =="
[ -f "$RUNNER_DIR/../compose.yaml" ] && grep -q 'dashboard.*--foreground\|"--foreground"' "$RUNNER_DIR/../Dockerfile" && ok "Dockerfile CMD runs the foreground dashboard" || fail "Dockerfile does not run gaffer dashboard --foreground"
python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$RUNNER_DIR/../.devcontainer/devcontainer.json" && ok "devcontainer.json parses" || fail "devcontainer.json invalid"

echo; [ "${#FAILURES[@]}" -eq 0 ] && echo "gaffer-dashboard-foreground: ALL $PASS checks passed" || { echo "gaffer-dashboard-foreground: ${#FAILURES[@]} FAILURE(S)"; exit 1; }
