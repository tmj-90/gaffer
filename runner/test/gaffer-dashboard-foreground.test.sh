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
# Fake node: when asked to run the dashboard bin, record argv + the env it received, then exit.
cat > "$BINDIR/node" <<EOF2
#!/usr/bin/env bash
for a in "\$@"; do case "\$a" in */dist/api/bin.js) { printf 'ARGV:%s\n' "\$*"; env | grep -E '^(DISPATCH_|GAFFER_DASHBOARD_URL|GAFFER_DATA|GAFFER_TICK_TIMEOUT)' | sort; } > "$CAP"; exit 0 ;; esac; done
exit 0
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
printf '%s' "$OUT" | grep -q "?token=$TOK" && ok "login URL with the token printed BEFORE exec (for container logs)" || fail "login URL not printed: $OUT"
for v in DISPATCH_TICK_CMD DISPATCH_MERGE_CMD DISPATCH_ONBOARD_CMD DISPATCH_PRODUCT_OWNER_CMD DISPATCH_TESTER_CMD DISPATCH_DB GAFFER_DASHBOARD_URL; do
  grep -q "^$v=." "$CAP" && ok "action-command env wired: $v" || fail "$v missing from the server env"
done
grep -q "^GAFFER_TICK_TIMEOUT=" "$CAP" && fail "runner-only knob leaked into the server env" || ok "runner-only knobs are unset for the server (same scrub as the detached path)"
[ -f "$WORK/d1/dashboard.pid" ] && fail "foreground must not write a pid file" || ok "no pid file (the supervisor owns the process)"

echo "== --lan binds every interface =="
run_fg "$WORK/d2" --lan >/dev/null
grep -q "ARGV:.*--host 0.0.0.0" "$CAP" && ok "--foreground --lan binds 0.0.0.0" || fail "lan host wrong: $(grep ARGV "$CAP")"

echo "== compose + devcontainer are well-formed =="
[ -f "$RUNNER_DIR/../compose.yaml" ] && grep -q 'dashboard.*--foreground\|"--foreground"' "$RUNNER_DIR/../Dockerfile" && ok "Dockerfile CMD runs the foreground dashboard" || fail "Dockerfile does not run gaffer dashboard --foreground"
python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$RUNNER_DIR/../.devcontainer/devcontainer.json" && ok "devcontainer.json parses" || fail "devcontainer.json invalid"

echo; [ "${#FAILURES[@]}" -eq 0 ] && echo "gaffer-dashboard-foreground: ALL $PASS checks passed" || { echo "gaffer-dashboard-foreground: ${#FAILURES[@]} FAILURE(S)"; exit 1; }
