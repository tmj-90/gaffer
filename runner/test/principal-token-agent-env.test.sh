#!/usr/bin/env bash
# =====================================================================
# PACKAGE H1: a person's principal token never reaches an agent process.
# GAFFER_PRINCIPAL_TOKEN makes the dispatch CLI act as a human or admin principal, which
# a person's tester verdict needs. A token the operator exported before `gaffer run`:
#   A. is taken out of the runner's environment when the config loads (factory.config.sh),
#      and `gaffer wg` alone hands it back to the CLI the person typed;
#   B. never survives the bash agent-env allowlist (gaffer_agent_env), for the claude-code
#      provider or a command worker that names it in GAFFER_WORKER_COMMAND_ENV;
#   C. never reaches a process the Node worker seam starts (lib/worker.mjs deliver): a
#      stub agent dumps its env, whether the launcher passed an env holding the token or
#      none at all (the inherited env);
#   D. is not something the command worker can be handed (commandEnvPassNames).
# The docker forwarding is proven on the seam test's recorded containers
# (sandbox-docker-delivery-seam.test.sh); the tester and reviewer launches go through C
# and B. No model. Run: bash runner/test/principal-token-agent-env.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
# shellcheck source=lib/isolate.sh
. "$HERE/lib/isolate.sh"
gaffer_test_isolate; trap 'gaffer_test_rm_work "$GAFFER_TEST_ISO"' EXIT
WORK="$GAFFER_TEST_ISO"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
TOK="gfp_operator_person_token_$$"

echo "== A: the config takes the token out of the runner's environment =="
OUT="$(GAFFER_PRINCIPAL_TOKEN="$TOK" RUNNER_DIR="$RUNNER_DIR" bash -c '
  source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
  printf "env=%s\n" "$(printenv GAFFER_PRINCIPAL_TOKEN || true)"
  printf "kept=%s\n" "${_GAFFER_PERSON_TOKEN:-}"
  printf "child=%s\n" "$(bash -c "printenv GAFFER_PRINCIPAL_TOKEN; printenv _GAFFER_PERSON_TOKEN" || true)"
  gaffer_agent_env
  for kv in "${GAFFER_AGENT_ENV[@]}"; do printf "agent:%s\n" "${kv%%=*}"; done
')"
grep -qx 'env=' <<<"$OUT" && ok "GAFFER_PRINCIPAL_TOKEN is not in the runner's env after the config loads" || fail "the runner's env still holds the token: $(grep '^env=' <<<"$OUT")"
grep -qx "kept=$TOK" <<<"$OUT" && ok "the config keeps it in an unexported shell variable for gaffer wg" || fail "the token was not kept for gaffer wg"
grep -qx 'child=' <<<"$OUT" && ok "no child process of the runner sees the token (or the kept copy)" || fail "a child saw it: $(grep '^child=' <<<"$OUT")"
grep -q '^agent:GAFFER_PRINCIPAL_TOKEN$\|^agent:_GAFFER_PERSON_TOKEN$' <<<"$OUT" && fail "the agent env carries the token" || ok "the agent env carries neither the token nor the kept copy"

echo "== A1: settings.json cannot hand the runner a principal token =="
mkdir -p "$WORK/sdata"
printf '{"GAFFER_PRINCIPAL_TOKEN":"%s"}\n' "$TOK" > "$WORK/sdata/settings.json"
OUT="$(env -u GAFFER_PRINCIPAL_TOKEN GAFFER_DATA="$WORK/sdata" RUNNER_DIR="$RUNNER_DIR" bash -c '
  source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
  printf "env=%s\n" "$(printenv GAFFER_PRINCIPAL_TOKEN || true)"
')"
grep -qx 'env=' <<<"$OUT" && ok "a settings.json GAFFER_PRINCIPAL_TOKEN is ignored" || fail "settings.json set the token: $(grep '^env=' <<<"$OUT")"

echo "== A2: gaffer wg hands it back to the CLI the person typed, and only it =="
if [ -f "$ROOT/packages/dispatch/dist/cli/index.js" ]; then
  export GAFFER_DATA="$WORK/data"; mkdir -p "$GAFFER_DATA"
  bash "$RUNNER_DIR/gaffer" wg init >/dev/null 2>&1
  T="$(bash "$RUNNER_DIR/gaffer" wg principal create tom 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).token||"")}catch{}})')"
  W="$(GAFFER_PRINCIPAL_TOKEN="$T" bash "$RUNNER_DIR/gaffer" wg whoami 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);process.stdout.write(String(j.authenticated)+":"+(j.principal&&j.principal.name))}catch{}})')"
  [ "$W" = "true:tom" ] && ok "gaffer wg whoami with the token acts as principal tom" || fail "gaffer wg did not act as the principal: '$W'"
  W="$(bash "$RUNNER_DIR/gaffer" wg whoami 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(d).authenticated))}catch{}})')"
  [ "$W" = "false" ] && ok "without the token gaffer wg is the unauthenticated operator" || fail "tokenless gaffer wg: '$W'"
else
  echo "  (skip A2: dispatch CLI not built)"
fi

echo "== B: the bash agent-env allowlist drops it, for every provider =="
for prov in claude-code command; do
  OUT="$(RUNNER_DIR="$RUNNER_DIR" GAFFER_WORKER_PROVIDER="$prov" GAFFER_WORKER_COMMAND_ENV="GAFFER_PRINCIPAL_TOKEN,MY_WORKER_KEY" bash -c '
    source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
    export GAFFER_PRINCIPAL_TOKEN="'"$TOK"'" MY_WORKER_KEY=k
    gaffer_agent_env
    for kv in "${GAFFER_AGENT_ENV[@]}"; do printf "%s\n" "${kv%%=*}"; done
    printf "pass:%s\n" $(gaffer_command_env_pass_names)
  ')"
  grep -qx 'GAFFER_PRINCIPAL_TOKEN' <<<"$OUT" && fail "$prov: the token survived gaffer_agent_env" || ok "$prov: gaffer_agent_env drops a token exported after the config loaded"
  grep -qx 'pass:GAFFER_PRINCIPAL_TOKEN' <<<"$OUT" && fail "$prov: the command worker may be handed the token" || ok "$prov: GAFFER_WORKER_COMMAND_ENV cannot hand the command worker the token"
done

echo "== C: the Node worker seam strips it from every launch (stub agent dumps its env) =="
STUB="$WORK/stub-agent.sh"; DUMP="$WORK/dumps"; mkdir -p "$DUMP"
cat > "$STUB" <<SH
#!/usr/bin/env bash
case "\${1:-}" in --version) echo "stub 1.0"; exit 0 ;; esac
env > "$DUMP/\$\$.env"
echo '{"type":"result","subtype":"success","result":"ok","total_cost_usd":0,"num_turns":1}'
SH
chmod +x "$STUB"
RES="$(cd "$WORK" && GAFFER_PRINCIPAL_TOKEN="$TOK" GAFFER_STRICT_REQUIRE=0 STRICT_MODE=0 SANDBOX_PROVIDER=none GAFFER_ALLOW_UNCAPPED=1 \
  GAFFER_WORKER_PROVIDER=claude-code GAFFER_DATA="$WORK/data" STUB="$STUB" \
  WORKER_MJS="$RUNNER_DIR/lib/worker.mjs" node --input-type=module -e '
    const w = await import(process.env.WORKER_MJS);
    const out = [];
    // A launcher that hands the seam an env holding the token (as a careless one would).
    const a = w.deliver({ bin: process.env.STUB, argv: ["-p", "x"], cwd: process.cwd(), timeoutMs: 20000,
      env: { ...process.env, GAFFER_TICKET: "1" }, kind: "tester" });
    out.push("a:" + a.status);
    // A launcher that hands it no env at all (the spawn would inherit this process env).
    const b = w.deliver({ bin: process.env.STUB, argv: ["-p", "x"], cwd: process.cwd(), timeoutMs: 20000, kind: "reviewer" });
    out.push("b:" + b.status);
    out.push("pass:" + w.commandEnvPassNames({ GAFFER_WORKER_COMMAND_ENV: "GAFFER_PRINCIPAL_TOKEN,FOO" }).join(","));
    out.push("strip:" + ("GAFFER_PRINCIPAL_TOKEN" in w.withoutPersonCredentials({ GAFFER_PRINCIPAL_TOKEN: "x", A: "1" })));
    console.log(out.join("\n"));
  ' 2>"$WORK/seam.err")"
n_dumps="$(find "$DUMP" -name '*.env' | wc -l | tr -d ' ')"
[ "$n_dumps" -ge 2 ] && ok "the stub agent ran for both launches ($n_dumps env dumps)" || fail "the stub agent did not run twice ($n_dumps dumps; $RES; $(tail -3 "$WORK/seam.err"))"
leaks="$(grep -l -F "$TOK" "$DUMP"/*.env 2>/dev/null | wc -l | tr -d ' ')"
[ "${leaks:-0}" = 0 ] && [ "$n_dumps" -ge 2 ] && ok "no agent process the seam started holds the principal token" || fail "the token reached $leaks agent process(es)"
grep -qx 'pass:FOO' <<<"$RES" && ok "D: commandEnvPassNames never lets GAFFER_PRINCIPAL_TOKEN through" || fail "D: commandEnvPassNames: $(grep '^pass:' <<<"$RES")"
grep -qx 'strip:false' <<<"$RES" && ok "withoutPersonCredentials removes the token" || fail "withoutPersonCredentials kept it"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "principal-token-agent-env: all $PASS checks passed"
  exit 0
fi
echo "principal-token-agent-env: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
