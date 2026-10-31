#!/usr/bin/env bash
# =====================================================================
# USAGE WINDOW — the lanes beside the delivery honour a usage-limit refusal too.
# ---------------------------------------------------------------------
# The delivery path records the pause and releases its ticket without counting an
# attempt (usage-limit-tick.test.sh). The other paid lanes read the same refusal:
#   G. GREENFIELD: the bootstrap agent of a new repo is refused by the usage window
#      (is_error:true, the 2.1.316 wording). Before, that was "bootstrap failed": the
#      ticket was parked to `blocked` for a human and skip-listed, and nothing paused.
#      Now: TICK_RESULT=usage_paused, $GAFFER_DATA/usage-pause.json written (lane
#      bootstrap), the claim released to ready with reason-code usage_limit and
#      --paused-until, NOT blocked, NOT skip-listed, and the scaffold dir kept as a
#      resumable bootstrap target. Control G2: the same words in a SUCCESS envelope
#      (the agent's own reply) take the ordinary bootstrap path, with no pause.
#   H. DEFAULT DATA DIR: GAFFER_DATA not in the environment (an operator's plain
#      shell; factory.config.sh derives it unexported). The pause is still written
#      under it and honoured by the next tick, and the printed
#      `node runner/lib/usage-pause.mjs status|clear` works from a plain shell.
# Drives the REAL tick.sh against a STUB dispatch CLI (records every call) and a
# stub `claude`. Portable to macOS bash 3.2 (perl alarm, no GNU timeout).
# Run: bash runner/test/usage-limit-lanes.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
TICK="$RUNNER_DIR/tick.sh"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v git  >/dev/null 2>&1 || { echo "SKIP: git required";  exit 0; }
command -v perl >/dev/null 2>&1 || { echo "SKIP: perl required (timeout primitive)"; exit 0; }
[ -f "$ROOT/packages/crew/dist/runtime/context/renderPromptCli.js" ] \
  || { echo "SKIP: crew not built ($ROOT/packages/crew/dist) — run pnpm -r build"; exit 0; }

PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/usage-limit-lanes.XXXXXX")"; WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT

# ── STUB dispatch CLI: one ready BOOTSTRAP ticket (#7), a claim token, and a
#    recorder of every call. ───────────────────────────────────────────────────
DISPATCH_DIR="$WORK/dispatch"; mkdir -p "$DISPATCH_DIR/dist/cli"
cat > "$DISPATCH_DIR/dist/cli/index.js" <<'JS'
const fs = require("node:fs");
let a = process.argv.slice(2);
if (a[0] === "--db") a = a.slice(2);
fs.appendFileSync(process.env.WG_CALLS, JSON.stringify(a) + "\n");
const has = (...t) => t.every((x) => a.includes(x));
const out = (o) => process.stdout.write(JSON.stringify(o));
if (has("agent", "register")) out({ agent: { id: "stub-agent" } });
else if (has("ticket", "resume-requested")) out([]);
else if (has("ticket", "list", "-s", "ready")) out([{ number: 7, title: "Bootstrap newapp" }]);
else if (has("ticket", "list")) out([]);
else if (has("ticket", "show", "7"))
  out({
    ticket: { number: 7, title: "Bootstrap newapp", status: "claimed", bootstrap: true, source: "newapp", risk_level: "low" },
    repositories: [],
  });
else if (has("claim-ticket")) out({ claimToken: "tok-7" });
else if (has("repo", "list")) out([]);
else if (has("runner-release")) out({ ok: true });
else out({});
JS

# ── STUB agent: writes part of a scaffold (uncommitted), then prints the envelope in
#    $WORK/envelope and exits with $WORK/rc. (Files, not env: worker_deliver runs the
#    agent under an allowlisted env, so a test variable would not reach it.) ─────────
STUB="$WORK/stub-claude.sh"
cat > "$STUB" <<STUBSH
#!/usr/bin/env bash
[ -e .git ] && printf '{ "name": "newapp", "private": true }\\n' > package.json
cat "$WORK/envelope"
exit "\$(cat "$WORK/rc")"
STUBSH
chmod +x "$STUB"
REFUSED="$WORK/refused.json"
printf '%s\n' '{"type":"result","subtype":"success","is_error":true,"num_turns":2,"result":"You'"'"'ve hit your 5-hour limit · resets 11:58pm (UTC) · progress saved","total_cost_usd":0}' > "$REFUSED"
LIAR="$WORK/liar.json"
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"num_turns":9,"result":"You'"'"'ve hit your 5-hour limit · resets 11:58pm (UTC) · progress saved","total_cost_usd":0.4}' > "$LIAR"

# run_boot <case> <envelope> <rc> → sets OUT, CALLS, DATA, B_DIR for the case.
run_boot() {
  local c="$1"
  CALLS="$WORK/$c/wg-calls.log"; DATA="$WORK/$c/data"; B_DIR="$WORK/$c/git/newapp"
  mkdir -p "$DATA"; : > "$CALLS"
  cp "$2" "$WORK/envelope"; echo "$3" > "$WORK/rc"
  OUT="$(env WG_CALLS="$CALLS" RUNNER_DIR="$RUNNER_DIR" GAFFER_DATA="$DATA" DISPATCH_DIR="$DISPATCH_DIR" \
        GAFFER_BOOTSTRAP_ROOT="$WORK/$c/git" CLAUDE_BIN="$STUB" CLAUDE_FLAGS="" \
        DRY_RUN=0 REVIEW_MODE=human CLARIFY_DRAFTS_WHEN_IDLE=0 GAFFER_TESTING=0 GAFFER_MAINTENANCE=0 \
        STRICT_MODE=0 GAFFER_STRICT_REQUIRE=0 SANDBOX_PROVIDER=none GAFFER_TICK_TIMEOUT=120 GAFFER_GREENFIELD_INSTALL=0 \
        perl -e 'alarm shift; exec @ARGV' 300 bash "$TICK" 2>&1)"
}
release_call() { grep '"runner-release","7"' "$CALLS" | tail -1; }
pf() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=j[process.argv[2]];process.stdout.write(v==null?"":String(v))' "$DATA/usage-pause.json" "$1" 2>/dev/null; }

echo "== G. a greenfield bootstrap refused by the usage window pauses, it does not park =="
run_boot g "$REFUSED" 1
grep -q '"claim-ticket"' "$CALLS" && ok "fixture: the bootstrap ticket was claimed" || fail "fixture: no claim: $(printf '%s' "$OUT" | tail -4 | tr '\n' '|')"
grep -q '^TICK_RESULT=usage_paused$' <<<"$OUT" && ok "G: tick → usage_paused" \
  || fail "G: tick result $(printf '%s\n' "$OUT" | grep TICK_RESULT= | tr '\n' ' ') ($(printf '%s' "$OUT" | grep -E 'BOOTSTRAP|USAGE' | tail -3 | tr '\n' '|'))"
REL="$(release_call)"
grep -q '"--to","ready"' <<<"$REL" && grep -q '"--reason-code","usage_limit"' <<<"$REL" \
  && ok "G: the claim was released to ready with reason-code usage_limit" || fail "G: release call: ${REL:-none}"
grep -q '"--paused-until","20[0-9-]*T[0-9:.]*Z"' <<<"$REL" \
  && ok "G: the release carries --paused-until (the ticket.usage_limited event)" || fail "G: no --paused-until on the release: ${REL:-none}"
grep -q '"--to","blocked"' "$CALLS" && fail "G: the refused bootstrap was parked to blocked for a human" \
  || ok "G: not parked to blocked"
grep -qx 7 "$DATA/.failed-tickets" 2>/dev/null && fail "G: the ticket was skip-listed for the run" \
  || ok "G: not skip-listed (it is retried once the window resets)"
[ -s "$DATA/usage-pause.json" ] && [ "$(pf lane)" = "bootstrap" ] && [ "$(pf ticket)" = 7 ] && [ "$(pf basis)" = reset ] \
  && ok "G: usage-pause.json written (lane bootstrap, ticket 7, the printed reset)" \
  || fail "G: pause file: $(cat "$DATA/usage-pause.json" 2>/dev/null)"
[ -f "$B_DIR/package.json" ] && ok "G: the partial scaffold is kept in $B_DIR" || fail "G: scaffold dir/file missing"
( source "$RUNNER_DIR/lib/greenfield.sh" >/dev/null 2>&1; gaffer_bootstrap_target_ok "$B_DIR" >/dev/null 2>&1 ) \
  && ok "G: the kept dir is a resumable bootstrap target (the retry re-enters it)" || fail "G: the kept dir would be refused on the retry"

echo "== G2. the same words in a SUCCESS envelope are the agent's reply: ordinary park, no pause =="
run_boot g2 "$LIAR" 0
grep -q '^TICK_RESULT=usage_paused$' <<<"$OUT" && fail "G2: an agent's own reply paused the factory" || ok "G2: no usage_paused"
[ ! -e "$DATA/usage-pause.json" ] && ok "G2: no pause file" || fail "G2: a pause was written: $(cat "$DATA/usage-pause.json")"
grep -q '"--reason-code","usage_limit"' "$CALLS" && fail "G2: the ticket was released as a usage limit" \
  || ok "G2: no usage_limit release (the scaffold goes down the ordinary bootstrap path)"

echo "== H. the DEFAULT data dir (GAFFER_DATA not in the environment) still pauses =="
# An operator who runs \`gaffer run\` from a plain shell has no GAFFER_DATA exported:
# factory.config.sh derives it (\$GAFFER_HOME/.gaffer) as a plain shell variable. A
# GAFFER_HOME of symlinks to the real runner and packages reproduces that layout.
HOMEDIR="$WORK/h/home"; mkdir -p "$HOMEDIR"
ln -s "$RUNNER_DIR" "$HOMEDIR/runner"; ln -s "$ROOT/packages" "$HOMEDIR/packages"
CALLS="$WORK/h/wg-calls.log"; : > "$CALLS"; DATA="$HOMEDIR/.gaffer"; B_DIR="$WORK/h/git/newapp"
cp "$REFUSED" "$WORK/envelope"; echo 1 > "$WORK/rc"
run_home_tick() {
  env -u GAFFER_DATA -u DISPATCH_DB -u MEMORY_DB -u GAFFER_HOME -u RUNNER_DIR \
      WG_CALLS="$CALLS" DISPATCH_DIR="$DISPATCH_DIR" \
      GAFFER_BOOTSTRAP_ROOT="$WORK/h/git" CLAUDE_BIN="$STUB" CLAUDE_FLAGS="" \
      DRY_RUN=0 REVIEW_MODE=human CLARIFY_DRAFTS_WHEN_IDLE=0 GAFFER_TESTING=0 GAFFER_MAINTENANCE=0 \
      STRICT_MODE=0 GAFFER_STRICT_REQUIRE=0 SANDBOX_PROVIDER=none GAFFER_TICK_TIMEOUT=120 GAFFER_GREENFIELD_INSTALL=0 \
      perl -e 'alarm shift; exec @ARGV' 300 bash "$HOMEDIR/runner/tick.sh" 2>&1
}
OUT="$(run_home_tick)"
grep -q '^TICK_RESULT=usage_paused$' <<<"$OUT" && ok "H: tick → usage_paused" || fail "H: tick result $(printf '%s\n' "$OUT" | grep TICK_RESULT=)"
[ -s "$DATA/usage-pause.json" ] && ok "H: the pause was written to the default data dir ($DATA)" \
  || fail "H: no pause file under the default data dir: $(grep 'USAGE' "$DATA/factory.log" 2>/dev/null | tail -2 | tr '\n' '|')"
grep -qx 7 "$DATA/.failed-tickets" 2>/dev/null && fail "H: the refusal was skip-listed (the pause could not be written)" \
  || ok "H: not skip-listed"
: > "$CALLS"; rm -f "$DATA/.failed-tickets"   # a new run: only the pause can hold it back
OUT="$(run_home_tick)"
grep -q '^TICK_RESULT=no_work$' <<<"$OUT" && ! grep -q '"claim-ticket"' "$CALLS" \
  && ok "H: the next tick honours the pause (no_work, no claim)" || fail "H: next tick $(printf '%s\n' "$OUT" | grep TICK_RESULT=) claims=$(grep -c claim-ticket "$CALLS")"
# The operator's own commands, from a plain shell (no GAFFER_DATA / GAFFER_HOME): a
# checkout whose runner/lib holds the real files (node resolves symlinks, so a copy).
PLAIN="$WORK/plain"; mkdir -p "$PLAIN/runner/lib" "$PLAIN/.gaffer"
# usage-pause.mjs and its local import closure (worker.mjs → budget-admission.mjs →
# usage-ledger-path.mjs).
cp "$RUNNER_DIR/lib/usage-pause.mjs" "$RUNNER_DIR/lib/worker.mjs" "$RUNNER_DIR/lib/budget-admission.mjs" \
   "$RUNNER_DIR/lib/usage-ledger-path.mjs" "$PLAIN/runner/lib/"
node -e 'const ms=Date.now()+3600e3;require("fs").writeFileSync(process.argv[1],JSON.stringify({paused_until:new Date(ms).toISOString(),until_ms:ms,kind:"usage_limit",basis:"reset",message:"t",ticket:7,lane:"bootstrap",recorded_at:new Date().toISOString()}))' "$PLAIN/.gaffer/usage-pause.json"
SOUT="$(cd "$WORK" && env -u GAFFER_DATA -u GAFFER_HOME -u GAFFER_USAGE_PAUSE_FILE node "$PLAIN/runner/lib/usage-pause.mjs" status 2>&1)"; src=$?
[ "$src" = 0 ] && case "$SOUT" in "paused until "*) true ;; *) false ;; esac \
  && ok "H: 'node runner/lib/usage-pause.mjs status' from a plain shell sees the pause ($SOUT)" || fail "H: status from a plain shell: rc=$src '$SOUT'"
( cd "$WORK" && env -u GAFFER_DATA -u GAFFER_HOME -u GAFFER_USAGE_PAUSE_FILE node "$PLAIN/runner/lib/usage-pause.mjs" clear )
[ ! -e "$PLAIN/.gaffer/usage-pause.json" ] && ok "H: the printed 'usage-pause.mjs clear' from a plain shell lifts it" \
  || fail "H: 'clear' from a plain shell left the pause in place"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "usage-limit-lanes: ALL $PASS checks passed"; exit 0; fi
echo "usage-limit-lanes: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1
