#!/usr/bin/env bash
# =====================================================================
# THE TICK'S DISPATCH SERVER changes nothing a tick records.
# ---------------------------------------------------------------------
# The same scenario runs twice through the REAL tick.sh with a stub agent
# (lib/stub-tick.sh), each in its own world: once with GAFFER_WG_SERVE=1 (one
# long-lived dispatch process per tick) and once with GAFFER_WG_SERVE=0 (every `wg`
# call its own process, as before). Scenario: a delivery tick, an agent-review tick,
# then a second delivery that a person approves and the next tick's merge lane lands.
#   E1  each tick prints the same TICK_RESULT in both worlds;
#   E2  both databases hold the same rows in every table, the event log included,
#       once ids, tokens, hashes, commit ids, timestamps, durations and the world's
#       own path are normalised;
#   E3  the served world started a server per tick and the one-shot world none.
# Run: bash runner/test/wg-serve-equivalence.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
. "$HERE/lib/skip.sh"
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN

# ── one world (a child process of this test): run the scenario, dump the database ──
if [ "${1:-}" = "--world" ]; then
  MODE_ARG="$2"; OUT="$3"
  STUB_TICK_NAME="wg-equiv-$MODE_ARG"
  # shellcheck source=lib/stub-tick.sh
  source "$HERE/lib/stub-tick.sh"
  if [ "$MODE_ARG" = served ]; then export GAFFER_WG_SERVE=1; else export GAFFER_WG_SERVE=0; fi
  REAL_NODE="$(command -v node)"
  mkdir -p "$WORK/shim"
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> "%s"\nexec "%s" "$@"\n' "$OUT.nodes" "$REAL_NODE" > "$WORK/shim/node"
  chmod +x "$WORK/shim/node"
  : > "$OUT.nodes"
  tick() {  # <tick id> [env...]: one tick, the node shim on PATH
    local id="$1"; shift
    ( cd "$RUNNER_DIR" && env GAFFER_TICK_ID="equiv-$id" PATH="$WORK/shim:$PATH" "$@" bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep '^TICK_RESULT='
  }
  A="$(new_ready "Equivalent delivery" "deliver a helper")"
  echo "deliver: $(tick 1)" >> "$OUT.results"
  echo "review: $(rm -f "$GAFFER_DATA/.reviewed-tickets"; tick 2 REVIEW_MODE=agent DISPATCH_ALLOW_AGENT_APPROVE=1)" >> "$OUT.results"
  B="$(new_ready "Equivalent landing" "deliver a helper")"
  rm -f "$GAFFER_DATA/.failed-tickets"
  echo "deliver2: $(tick 3)" >> "$OUT.results"
  wg review approve "$B" >/dev/null 2>&1
  echo "land: $(tick 4 AUTO_MERGE=1)" >> "$OUT.results"
  echo "status: #$A $(st "$A") #$B $(st "$B")" >> "$OUT.results"
  cat > "$WORK/dump.mjs" <<'DUMP'
// Every row of every table, in rowid order, with what differs by construction normalised.
import { DatabaseSync } from "node:sqlite";
const [db, work] = process.argv.slice(2);
const conn = new DatabaseSync(db, { readOnly: true });
const norm = (s) =>
  s
    .split(work).join("<work>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(\.\d+)?Z?/g, "<ts>")
    .replace(/\b(gfc|gft|gfp)_[A-Za-z0-9_-]+/g, "<token>")
    .replace(/\b[0-9a-f]{7,128}\b/g, "<hex>")
    .replace(/\\?"([a-z_]*(duration|elapsed|_ms|seconds|took)[a-z_]*)\\?":\s*[0-9.]+/gi, '"$1":0')
    .replace(/\b\d+(\.\d+)?\s?(ms|s)\b/g, "<dur>");
const tables = conn
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all();
for (const { name } of tables) {
  let rows;
  try {
    rows = conn.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
  } catch {
    rows = conn.prepare(`SELECT * FROM "${name}"`).all();
  }
  for (const r of rows) process.stdout.write(`${name}\t${norm(JSON.stringify(r))}\n`);
}
DUMP
  "$REAL_NODE" "$WORK/dump.mjs" "$DISPATCH_DB" "$WORK" > "$OUT.rows"
  exit 0
fi

command -v node >/dev/null 2>&1 || gaffer_skip "node required"
command -v git >/dev/null 2>&1 || gaffer_skip "git required"
for f in packages/dispatch/dist/cli/index.js packages/dispatch/dist/cli/serve.js packages/memory/dist/bin/memory.js packages/crew/dist/cli/index.js; do
  [ -f "$ROOT/$f" ] || gaffer_skip "$f not built (run pnpm -r build)"
done
if [ "${BASH_VERSINFO[0]}" -lt 4 ] || { [ "${BASH_VERSINFO[0]}" -eq 4 ] && [ "${BASH_VERSINFO[1]}" -lt 4 ]; }; then
  gaffer_skip "served wg needs bash 4.4 or later (the macOS-only /bin/bash 3.2 runs every call one-shot)"
fi
. "$HERE/lib/tmpdir.sh"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
OUTD="$(gaffer_test_tmpdir wg-equiv-out)" || exit 70
trap 'gaffer_test_rm_work "$OUTD"' EXIT

bash "$0" --world served "$OUTD/served"
bash "$0" --world oneshot "$OUTD/oneshot"

echo "== E1: the same tick results =="
sed 's/^/    served:  /' "$OUTD/served.results"
if cmp -s "$OUTD/served.results" "$OUTD/oneshot.results"; then
  ok "E1: every tick printed the same result in both worlds"
else
  fail "E1: results differ: $(diff "$OUTD/served.results" "$OUTD/oneshot.results" | tr '\n' ' ')"
fi
grep -q '^deliver: TICK_RESULT=worked$' "$OUTD/served.results" && grep -q '^land: ' "$OUTD/served.results" \
  && grep -qE '^status: #[0-9]+ [a-z_]+ #[0-9]+ done$' "$OUTD/served.results" \
  && ok "E1: the scenario delivered, reviewed and landed (the second ticket is done)" \
  || fail "E1: the scenario did not reach a landing: $(tr '\n' ' ' < "$OUTD/served.results")"

echo "== E2: the same rows, the event log included =="
N="$(wc -l < "$OUTD/served.rows" | tr -d ' ')"
EV="$(grep -c '^work_events	' "$OUTD/served.rows" || true)"
if cmp -s "$OUTD/served.rows" "$OUTD/oneshot.rows"; then
  ok "E2: both databases hold the same $N rows ($EV events)"
else
  fail "E2: the databases differ:"
  diff "$OUTD/served.rows" "$OUTD/oneshot.rows" | head -20 | cut -c1-400
fi
[ "$EV" -gt 10 ] && ok "E2: the event log was compared ($EV events)" || fail "E2: only $EV events"

echo "== E3: how each world ran wg =="
SS="$(grep -c 'dispatch/dist/cli/serve.js' "$OUTD/served.nodes" || true)"
SO="$(grep -c 'dispatch/dist/cli/serve.js' "$OUTD/oneshot.nodes" || true)"
WS="$(grep -c 'dispatch/dist/cli/index.js' "$OUTD/served.nodes" || true)"
WO="$(grep -c 'dispatch/dist/cli/index.js' "$OUTD/oneshot.nodes" || true)"
echo "    served: $SS servers, $WS one-shot dispatch calls; one-shot: $SO servers, $WO one-shot dispatch calls"
[ "$SS" = 4 ] && [ "$SO" = 0 ] && [ "$WO" -gt "$WS" ] && ok "E3: a server per tick in the served world, none in the other" || fail "E3: servers $SS/$SO, one-shot calls $WS/$WO"

echo
echo "wg-serve-equivalence: $PASS passed, ${#FAILURES[@]} failed"
[ "${#FAILURES[@]}" -eq 0 ]
