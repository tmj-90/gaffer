#!/usr/bin/env bash
# =====================================================================
# THE TICK'S DISPATCH SERVER, the bash side (runner/config/17-cli.sh `wg`).
# ---------------------------------------------------------------------
# A tick starts one long-lived dispatch process and `wg` sends it each call instead of
# starting node. These pin, against a real server and a real database:
#   W1  a served call prints the same stdout and stderr bytes and returns the same exit
#       code as the one-shot call, refusals and hostile arguments included, and starts
#       no node process; a command the server does not run goes one-shot by itself;
#   W2  calls from `$(...)`, a pipeline, a subshell and parallel background jobs each get
#       their own reply (no interleaving);
#   W3  the environment of the call is honoured per call (a principal token, USER) and
#       a changed PATH sends the call one-shot;
#   W4  a server that hangs, answers garbage, answers another call's nonce, dies during
#       a call or loses a segment fails THAT call closed (non-zero, WG_SERVER_FAILED,
#       never a success), and every later call runs one-shot and works; a server that is
#       gone between calls is not noticed at all (the call runs one-shot);
#   W5  output segments keep their write order and a NUL byte survives;
#   W6  stop removes the process and its directory; GAFFER_WG_SERVE=0 never starts one;
#       a stale dir of a dead tick is swept;
#   W7  sandboxed code cannot write the server's pipes: the sandbox-exec agent and
#       validation profiles deny every path under $GAFFER_DATA/wg-serve, it is not one of
#       the in-sandbox writers, and the docker wrapper creates its parent before masking.
# The tick-level checks (no server outlives a tick, spawns per tick, the same rows and
# events as one-shot ticks) are in wg-serve-tick.test.sh.
# Run: bash runner/test/wg-serve.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
. "$HERE/lib/tmpdir.sh"
. "$HERE/lib/skip.sh"
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
command -v node >/dev/null 2>&1 || gaffer_skip "node required"
for f in packages/dispatch/dist/cli/index.js packages/dispatch/dist/cli/serve.js; do
  [ -f "$ROOT/$f" ] || gaffer_skip "$f not built (run pnpm -r build)"
done

PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(gaffer_test_tmpdir wg-serve)" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
trap 'gaffer_wg_serve_stop 2>/dev/null; gaffer_test_rm_work "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/data"
REAL_NODE="$(command -v node)"
# A node that logs every start, so "this call started no node" is checkable.
NODE_LOG="$WORK/node.log"; : > "$NODE_LOG"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> "%s"\nexec "%s" "$@"\n' "$NODE_LOG" "$REAL_NODE" > "$WORK/bin/node"
chmod +x "$WORK/bin/node"
export PATH="$WORK/bin:$PATH"
export GAFFER_DATA="$WORK/data" GAFFER_WG_SERVE=1 GAFFER_WG_SERVE_TIMEOUT=5
unset DISPATCH_DB MEMORY_DB GAFFER_PRINCIPAL_TOKEN
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
CLI="$DISPATCH_DIR/dist/cli/index.js"
oneshot() { "$REAL_NODE" "$CLI" --db "$DISPATCH_DB" "$@"; }

wg init >/dev/null 2>&1
wg repo add -n repo --path "$WORK" --branch main >/dev/null 2>&1
HOSTILE=$'A "quoted" $HOME `id` \'single\'\ttab\nsecond line\\ back'
wg ticket create -t "$HOSTILE" -d "$HOSTILE" --risk low >/dev/null 2>&1
wg ticket create -t "Second" -d "plain" >/dev/null 2>&1
TOKEN="$(oneshot principal create reader --read 2>/dev/null | "$REAL_NODE" -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).token))')"

served_count() { grep -c 'dist/cli/index.js' "$NODE_LOG" 2>/dev/null || true; }

# capture <file-prefix> <cmd...>: stdout, stderr and the exit code of one call.
capture() {
  local p="$1"; shift
  "$@" >"$p.out" 2>"$p.err"; echo $? > "$p.rc"
}
same_as_oneshot() {  # <label> <wg args...>: the served call equals the one-shot call
  local label="$1"; shift
  local before after
  before="$(served_count)"
  capture "$WORK/s" wg "$@"
  after="$(served_count)"
  capture "$WORK/o" oneshot "$@"
  # A write made twice differs only in its new ids and timestamps.
  local f; for f in s.out s.err o.out o.err; do
    LC_ALL=C sed -E 's/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/<uuid>/g; s/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z/<ts>/g' "$WORK/$f" > "$WORK/$f.n"
  done
  if cmp -s "$WORK/s.out.n" "$WORK/o.out.n" && cmp -s "$WORK/s.err.n" "$WORK/o.err.n" && cmp -s "$WORK/s.rc" "$WORK/o.rc"; then
    if [ "$before" = "$after" ]; then ok "W1: $label: same bytes and exit code ($(cat "$WORK/s.rc")), no node started"
    else fail "W1: $label: same output but the call started node (not served)"; fi
  else
    fail "W1: $label: served and one-shot differ: rc $(cat "$WORK/s.rc")/$(cat "$WORK/o.rc"); out $(diff "$WORK/s.out.n" "$WORK/o.out.n" | head -3 | tr '\n' ' '); err $(diff "$WORK/s.err.n" "$WORK/o.err.n" | head -3 | tr '\n' ' ')"
  fi
}

BASH_OK=0
[ "${BASH_VERSINFO[0]}" -gt 4 ] || { [ "${BASH_VERSINFO[0]}" -eq 4 ] && [ "${BASH_VERSINFO[1]}" -ge 4 ]; } && BASH_OK=1

if [ "$BASH_OK" != 1 ]; then
  gaffer_wg_serve_start
  [ -z "$_GAFFER_WG_PID" ] && ok "W6: under bash $BASH_VERSION no server starts" || fail "W6: a server started under bash $BASH_VERSION"
  [ "$(wg ticket show 2 2>/dev/null | "$REAL_NODE" -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).ticket.title))')" = "Second" ] \
    && ok "W6: wg works one-shot there" || fail "W6: one-shot wg broken under bash $BASH_VERSION"
  gaffer_skip_part "served wg needs bash 4.4 or later (the macOS-only /bin/bash 3.2 runs every call one-shot)"
else

echo "== W1: a served call equals the one-shot call =="
gaffer_wg_serve_start
[ -n "$_GAFFER_WG_PID" ] && kill -0 "$_GAFFER_WG_PID" 2>/dev/null && ok "W1: the server started (pid $_GAFFER_WG_PID)" || fail "W1: no server"
case "$_GAFFER_WG_DIR" in "$GAFFER_DATA/wg-serve/$$."*) ok "W1: its dir is \$GAFFER_DATA/wg-serve/<tick pid>.<random>" ;; *) fail "W1: dir=$_GAFFER_WG_DIR" ;; esac
[ "$(stat -c %a "$_GAFFER_WG_DIR" 2>/dev/null || stat -f %Lp "$_GAFFER_WG_DIR")" = 700 ] && ok "W1: the dir is 0700" || fail "W1: dir mode"
same_as_oneshot "ticket show (hostile title)" ticket show 1
same_as_oneshot "ticket list" ticket list -s draft
same_as_oneshot "unknown ticket" ticket show 999
same_as_oneshot "refused transition" ticket move 2 done --as system
same_as_oneshot "landing refused" ticket landing-begin 1
same_as_oneshot "hostile evidence summary" attach-evidence 1 --type manual_note --summary "$HOSTILE"
same_as_oneshot "usage error" ticket show
same_as_oneshot "unknown option" ticket show 1 --bogus
same_as_oneshot "empty argument" ticket list -s ""
# A command the server does not serve: it answers NOT-RUN and the call runs one-shot.
before="$(served_count)"
capture "$WORK/n" wg ticket create -t "made one-shot" -d x
after="$(served_count)"
[ "$(cat "$WORK/n.rc")" = 0 ] && [ "$after" -gt "$before" ] && grep -q '"made one-shot"' "$WORK/n.out" \
  && ok "W1: a command the server does not run (ticket create) went one-shot and worked" || fail "W1: not-run fallback rc=$(cat "$WORK/n.rc")"

echo "== W2: \$(...), pipelines, subshells and background jobs =="
t="$(wg ticket show 2 | jget 'd.ticket.title')"
[ "$t" = "Second" ] && ok "W2: \$(wg | jget) got its reply" || fail "W2: pipeline got '$t'"
t="$( ( wg ticket show 1 ) | jget 'd.ticket.title')"
[ "$t" = "$HOSTILE" ] && ok "W2: a subshell's call got its own reply (hostile title intact)" || fail "W2: subshell got '$t'"
for i in 1 2 3 4 5 6 7 8; do
  ( if [ $((i % 2)) = 0 ]; then n=1; else n=2; fi
    wg ticket show "$n" > "$WORK/par.$i.out" 2>&1; echo $? > "$WORK/par.$i.rc" ) &
done
wait
bad=0
for i in 1 2 3 4 5 6 7 8; do
  if [ $((i % 2)) = 0 ]; then want="$HOSTILE"; else want="Second"; fi
  got="$(jget 'd.ticket.title' < "$WORK/par.$i.out" 2>/dev/null)"
  [ "$(cat "$WORK/par.$i.rc")" = 0 ] && [ "$got" = "$want" ] || bad=$((bad + 1))
done
[ "$bad" = 0 ] && ok "W2: 8 parallel background calls each got their own reply" || fail "W2: $bad of 8 parallel calls got a wrong reply"
[ ! -e "$_GAFFER_WG_DIR/broken" ] && ok "W2: ...and the server is still trusted" || fail "W2: the server was marked broken"

echo "== W3: the environment, per call =="
same_as_oneshot "a read-only principal's write (token in the env)" ticket move 1 refining
GAFFER_PRINCIPAL_TOKEN="$TOKEN" capture "$WORK/p" wg ticket move 1 refining
GAFFER_PRINCIPAL_TOKEN="$TOKEN" capture "$WORK/q" oneshot ticket move 1 refining
cmp -s "$WORK/p.err" "$WORK/q.err" && [ "$(cat "$WORK/p.rc")" = "$(cat "$WORK/q.rc")" ] && [ "$(cat "$WORK/p.rc")" != 0 ] \
  && ok "W3: GAFFER_PRINCIPAL_TOKEN=<read-only> on one call is refused exactly as one-shot ($(head -c 60 "$WORK/p.err"))" \
  || fail "W3: principal token per call: rc $(cat "$WORK/p.rc")/$(cat "$WORK/q.rc")"
capture "$WORK/p2" wg ticket show 1
[ "$(cat "$WORK/p2.rc")" = 0 ] && ok "W3: ...and the next call without it is the operator again" || fail "W3: the token leaked into the next call"
USER=someone-else capture "$WORK/u" wg attach-evidence 2 --type manual_note --summary "by user"
[ "$(cat "$WORK/u.rc")" = 0 ] && ok "W3: a call with its own USER ran" || fail "W3: USER call rc=$(cat "$WORK/u.rc")"
before="$(served_count)"
PATH="$WORK/bin:$PATH" wg ticket show 2 >/dev/null 2>&1
after="$(served_count)"
[ "$after" -gt "$before" ] && ok "W3: a changed PATH sends the call one-shot (node could resolve elsewhere)" || fail "W3: a changed PATH was still served"

echo "== W4: a server gone between calls is not noticed =="
kill -KILL "$_GAFFER_WG_PID" 2>/dev/null; sleep 0.3
capture "$WORK/g" wg ticket show 2
[ "$(cat "$WORK/g.rc")" = 0 ] && ! grep -q WG_SERVER_FAILED "$WORK/g.err" \
  && ok "W4: the next call ran one-shot and succeeded" || fail "W4: after a kill between calls rc=$(cat "$WORK/g.rc") $(head -c 200 "$WORK/g.err")"
gaffer_wg_serve_stop
[ -z "$(ls -A "$GAFFER_DATA/wg-serve" 2>/dev/null)" ] && ok "W6: stop removed the dir" || fail "W6: left: $(ls -A "$GAFFER_DATA/wg-serve")"

echo "== W4: faults during a call fail closed =="
cat > "$WORK/fake-serve.mjs" <<'FAKE'
// A dispatch server that misbehaves on purpose (mode in FAKE_MODE): the client must fail
// the call closed. It speaks the real protocol for everything else.
import fs from "node:fs";
import net from "node:net";
import readline from "node:readline";
const dir = process.argv[3];
const mode = process.env.FAKE_MODE;
const fd = fs.openSync(`${dir}/req`, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
const rl = readline.createInterface({ input: new net.Socket({ fd, readable: true, writable: false }) });
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => undefined);
const reply = (nonce, line) => {
  const o = fs.openSync(`${dir}/r.${nonce}`, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
  fs.writeSync(o, line);
  fs.closeSync(o);
};
rl.on("line", (line) => {
  if (line === "Q") process.exit(0);
  if (line.startsWith("D ")) return;
  const nonce = line;
  if (mode === "hang") return;
  if (mode === "die") process.exit(3);
  if (mode === "garbage") return reply(nonce, "HTTP/1.1 200 OK\n");
  if (mode === "wrong-nonce") return reply(nonce, "GWG1 9.9.9 R 0 -\n");
  if (mode === "failed") return reply(nonce, `GWG1 ${nonce} F\n`);
  if (mode === "lost-segment") return reply(nonce, `GWG1 ${nonce} R 0 o\n`);
  if (mode === "partial") {
    const o = fs.openSync(`${dir}/r.${nonce}`, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    fs.writeSync(o, `GWG1 ${nonce} R 0`);
    return; // never finishes the line, keeps the FIFO open
  }
  if (mode === "segments") {
    fs.writeFileSync(`${dir}/s.${nonce}.0`, "err-1\n");
    fs.writeFileSync(`${dir}/s.${nonce}.1`, "out-2\n");
    fs.writeFileSync(`${dir}/s.${nonce}.2`, Buffer.from("err\u00003\n"));
    return reply(nonce, `GWG1 ${nonce} R 7 eoE\n`);
  }
});
FAKE
fault() {  # <mode> <label>
  local mode="$1" label="$2"
  _GAFFER_WG_SERVE_BIN="$WORK/fake-serve.mjs" FAKE_MODE="$mode" gaffer_wg_serve_start
  local pid="$_GAFFER_WG_PID" dir="$_GAFFER_WG_DIR"
  [ -n "$pid" ] || { fail "W4 $mode: the fake server did not start"; return; }
  sleep 0.3
  capture "$WORK/f" wg ticket show 2
  if [ "$(cat "$WORK/f.rc")" != 0 ] && grep -q '"code":"WG_SERVER_FAILED"' "$WORK/f.err" && [ ! -s "$WORK/f.out" ]; then
    ok "W4 $mode: $label: the call failed closed ($(grep -o 'server [^;]*' "$WORK/f.err" | head -1))"
  else
    fail "W4 $mode: rc=$(cat "$WORK/f.rc") out=$(head -c 80 "$WORK/f.out") err=$(head -c 200 "$WORK/f.err")"
  fi
  [ -e "$dir/broken" ] || [ ! -d "$dir" ] && ok "W4 $mode: the server is marked broken" || fail "W4 $mode: not marked broken"
  local i; for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  kill -0 "$pid" 2>/dev/null && fail "W4 $mode: the misbehaving server is still running" || ok "W4 $mode: the misbehaving server was stopped"
  local b; b="$(served_count)"
  capture "$WORK/f2" wg ticket show 2
  [ "$(cat "$WORK/f2.rc")" = 0 ] && [ "$(served_count)" -gt "$b" ] && ok "W4 $mode: the next call ran one-shot and succeeded" || fail "W4 $mode: the next call rc=$(cat "$WORK/f2.rc")"
  gaffer_wg_serve_stop
}
fault hang "a hang past GAFFER_WG_SERVE_TIMEOUT=5s"
fault garbage "a garbage reply"
fault wrong-nonce "a reply to another call"
fault die "death during the call"
fault failed "an F (failed after start) reply"
fault lost-segment "a reply whose output file is missing"
fault partial "a reply line that never ends"

echo "== W5: segment order and a NUL byte =="
_GAFFER_WG_SERVE_BIN="$WORK/fake-serve.mjs" FAKE_MODE=segments gaffer_wg_serve_start
sleep 0.3
wg ticket show 2 > "$WORK/seg.all" 2>&1; rc=$?
[ "$rc" = 7 ] && ok "W5: the exit code is the reply's (7)" || fail "W5: rc=$rc"
printf 'err-1\nout-2\nerr\x003\n' | cmp -s - "$WORK/seg.all" && ok "W5: stderr/stdout/stderr in write order, the NUL byte kept" || fail "W5: got $(od -c "$WORK/seg.all" | head -3 | tr '\n' ' ')"
wg ticket show 2 2>/dev/null > "$WORK/seg.out"
printf 'out-2\n' | cmp -s - "$WORK/seg.out" && ok "W5: stdout alone holds only the stdout segment" || fail "W5: stdout got $(od -c "$WORK/seg.out" | head -2 | tr '\n' ' ')"
gaffer_wg_serve_stop

echo "== W6: the switch and the sweep =="
GAFFER_WG_SERVE=0 gaffer_wg_serve_start
[ -z "$_GAFFER_WG_PID" ] && ok "W6: GAFFER_WG_SERVE=0 starts no server" || { fail "W6: a server started with GAFFER_WG_SERVE=0"; gaffer_wg_serve_stop; }
( sleep 30 & echo $! > "$WORK/deadpid"; wait ) &
sleep 0.2; DEAD="$(cat "$WORK/deadpid")"; kill -KILL "$DEAD" 2>/dev/null; sleep 0.2
mkdir -p "$GAFFER_DATA/wg-serve/$DEAD.stale1"
mkdir -p "$GAFFER_DATA/wg-serve/$$.mine1"
gaffer_wg_serve_start
[ ! -d "$GAFFER_DATA/wg-serve/$DEAD.stale1" ] && ok "W6: a dead tick's dir was swept at start" || fail "W6: stale dir left"
[ -d "$GAFFER_DATA/wg-serve/$$.mine1" ] && ok "W6: a live tick's dir was kept" || fail "W6: a live tick's dir was removed"
gaffer_wg_serve_stop
rm -rf "$GAFFER_DATA/wg-serve/$$.mine1"
fi

echo "== W7: sandboxed code cannot write the server's pipes =="
(
  export HOME="/nonexistent-gaffer-test-home.$$"
  WT="$GAFFER_DATA/worktrees/ticket-1"; mkdir -p "$WT"
  # shellcheck source=../lib/sandbox.sh
  source "$RUNNER_DIR/lib/sandbox.sh"
  P="$GAFFER_DATA/wg-serve/4242.AbC123"
  for variant in "" validation; do
    prof="$WORK/profile-${variant:-agent}.sb"
    GAFFER_SANDBOX_PROFILE="$variant" _sandbox_exec_profile "$WT" "$prof" "" || { echo "FAIL profile ${variant:-agent} refused"; continue; }
    out="$(node "$HERE/lib/sbpl-eval.mjs" "$prof" write "$P/req" "$P/q.1.2.3" "$P/r.1.2.3" "$P/s.1.2.3.0" "$P" "$GAFFER_DATA/wg-serve" 2>&1)"
    if [ -n "$out" ] && ! printf '%s\n' "$out" | grep -qv '^deny '; then echo "OK ${variant:-agent}"; else echo "FAIL ${variant:-agent}: $out"; fi
  done
  if gaffer_sandbox_data_writers | grep -q 'wg-serve'; then echo "FAIL writers"; else echo "OK writers"; fi
) > "$WORK/w7.out" 2>&1
grep -q '^OK agent$' "$WORK/w7.out" && ok "W7: the sandbox-exec agent profile denies writing anything under \$GAFFER_DATA/wg-serve" || fail "W7: agent profile: $(tr '\n' ' ' < "$WORK/w7.out")"
grep -q '^OK validation$' "$WORK/w7.out" && ok "W7: so does the validation profile (the gates)" || fail "W7: validation profile: $(tr '\n' ' ' < "$WORK/w7.out")"
grep -q '^OK writers$' "$WORK/w7.out" && ok "W7: wg-serve is not one of the in-sandbox writers" || fail "W7: wg-serve is an in-sandbox writer"
# The docker legacy layout masks the entries of $GAFFER_DATA that exist when it starts; the
# wrapper creates wg-serve/ first, so a sibling tick's server made later stays hidden.
grep -q 'mkdir -p "$GAFFER_DATA/wg-serve"' "$RUNNER_DIR/lib/sandbox-docker.sh" \
  && awk '/mkdir -p "\$GAFFER_DATA\/wg-serve"/{m=NR} /for _e in "\$GAFFER_DATA"\/\*/{if(!f)f=NR} END{exit !(m && f && m < f)}' "$RUNNER_DIR/lib/sandbox-docker.sh" \
  && ok "W7: the docker wrapper creates \$GAFFER_DATA/wg-serve before it computes the masks" || fail "W7: the docker wrapper does not create wg-serve before masking"

echo
echo "wg-serve: $PASS passed, ${#FAILURES[@]} failed"
[ "${#FAILURES[@]}" -eq 0 ]
