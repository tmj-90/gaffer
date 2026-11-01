#!/usr/bin/env bash
# =====================================================================
# REVOCATION DURING THE MERGE GATE (external review #8, finding 1).
# ---------------------------------------------------------------------
# A cancellation or a red required check recorded while the merge gate ran used to be
# acknowledged by Dispatch and then overridden: both default branches advanced, `gaffer
# merge` exited 0 and the ticket still read cancelled. Both landing paths now re-check,
# after the gates pass and immediately before a default branch moves, per repo
# (`wg ticket landing-begin`), and land NOTHING once the delivery was revoked.
#   A/B  `gaffer merge` (bin/merge-ticket.mjs): cancel / CI fail while the gate waits
#   C/D  the Poll path (lib/land.sh gaffer_land_delivery): the same two revocations
#   E    a revocation that arrives after one repo already landed: the revocation reports
#        that landing (landed_already + a WARNING naming it); the other repo never lands
# Ported from the reviewer's landing/run.mjs fixture: real git, the real Dispatch CLI, a
# registered test command that waits on a file barrier; no model, no network.
# Run: bash test/landing-revocation.test.sh   (bash 3.2 safe)
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
DISPATCH_JS="$ROOT/packages/dispatch/dist/cli/index.js"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
[ -f "$DISPATCH_JS" ] || { echo "SKIP: build the workspace first (no $DISPATCH_JS)"; exit 0; }
WORK="$(gaffer_test_tmpdir landing-revocation)" || exit 70
trap 'touch "$WORK"/*/release 2>/dev/null; gaffer_test_rm_work "$WORK"' EXIT
mkdir -p "$WORK/bin"
printf '#!/bin/sh\nexit 1\n' > "$WORK/bin/claude"; chmod +x "$WORK/bin/claude"
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
export CLAUDE_BIN="$WORK/bin/claude" GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 LC_ALL=C \
  GAFFER_DOD_SANDBOX=0 GAFFER_DIGEST_DISABLE=1 GAFFER_MEMORY_INDEX=0 GAFFER_CONFLICT_RESOLVER=0 \
  DISPATCH_AUDIT_OFF=1 MEMORY_AUDIT_OFF=1

D=""   # the current case's directory
wgd() { node "$DISPATCH_JS" --db "$D/data/dispatch.sqlite" "$@"; }
jf() { node "$RUNNER_DIR/lib/json-tool.mjs" expr "$1"; }
g() { git -C "$D/$1" "${@:2}"; }

# world <case> <wait-at-entry>: two repos, one approved two-repo ticket (#1). The registered
# test command of BOTH repos is gate.cjs, which (once `armed` exists) waits for `release`
# at its <wait-at-entry>-th invocation (1 = the first repo gated, 2 = the second).
world() {
  D="$WORK/$1"; mkdir -p "$D/home" "$D/tmp" "$D/data"
  export HOME="$D/home" TMPDIR="$D/tmp" GAFFER_DATA="$D/data" DISPATCH_DB="$D/data/dispatch.sqlite" MEMORY_DB="$D/data/memory.sqlite"
  wgd init >/dev/null
  local name
  for name in repoA repoB; do
    mkdir -p "$D/$name"
    g "$name" init -q -b main; g "$name" config user.name Fixture; g "$name" config user.email fixture@example.invalid
    cat > "$D/$name/gate.cjs" <<GATE
const fs = require("node:fs"), p = require("node:path"); const dir = "$D";
const f = (n) => p.join(dir, n);
if (fs.existsSync(f("armed"))) {
  fs.appendFileSync(f("entries"), "x");
  if (fs.readFileSync(f("entries"), "utf8").length === $2) {
    fs.writeFileSync(f("inside"), "1");
    const until = Date.now() + 120000;
    const t = setInterval(() => { if (fs.existsSync(f("release")) || Date.now() > until) clearInterval(t); }, 100);
  }
}
GATE
    g "$name" add gate.cjs; g "$name" commit -qm baseline
    wgd repo add -n "$name" --path "$D/$name" --branch main --test "node gate.cjs" >/dev/null
  done
  wgd ticket create -t "Update both repositories" --description "one marker per repo" --policy team_light --risk low >/dev/null
  AC="$(wgd ac add 1 -t "The marker is present" | jf 'd.ac_id')"
  for name in repoA repoB; do wgd ticket repo-access set 1 "$name" --access write --relation confirmed >/dev/null; done
  wgd ticket ready 1 >/dev/null
  AGENT="$(wgd agent register -n fixture-delivery --max-risk high | jf 'd.agent.id')"
  TOKEN="$(wgd claim-ticket 1 --agent "$AGENT" --ttl 900 | jf 'd.claimToken')"
  for name in repoA repoB; do
    g "$name" switch -qc gaffer/fixture
    printf '%s changed\n' "$name" > "$D/$name/delivered.txt"
    g "$name" add delivered.txt; g "$name" commit -qm "Deliver $name"
    eval "PIN_$name=\"\$(g \"\$name\" rev-parse HEAD)\""
    g "$name" switch -q main
    wgd ticket repo-delivery record 1 "$name" --branch gaffer/fixture >/dev/null
  done
  wgd evidence 1 --token "$TOKEN" --type test_output --summary "markers verified" --ac "$AC" >/dev/null
  wgd submit 1 --token "$TOKEN" --reason "ready" >/dev/null
  wgd delivery-artifact 1 --branch gaffer/fixture --diff "a marker each" --as system >/dev/null
  wgd ticket ci-result 1 --commit "$PIN_repoA" --state pass >/dev/null
  wgd review approve 1 --reviewer fixture-operator --commit "repoA=$PIN_repoA" --commit "repoB=$PIN_repoB" >/dev/null
  MAIN_A="$(g repoA rev-parse main)"; MAIN_B="$(g repoB rev-parse main)"
  touch "$D/armed"
}
status() { wgd ticket show 1 | jf 'd.ticket.status'; }
wait_inside() { local i=0; while [ ! -e "$D/inside" ] && [ "$i" -lt 900 ]; do sleep 0.2; i=$((i + 1)); done; [ -e "$D/inside" ]; }
cancel() { wgd review reject 1 --reason "Operator cancelled release" --to cancelled --reviewer fixture-operator 2>"$D/revoke.err"; }
redci() { wgd ticket ci-result 1 --commit "$PIN_repoA" --state fail --detail "Required checks failed" 2>"$D/revoke.err"; }
untouched() { [ "$(g repoA rev-parse main)" = "$MAIN_A" ] && [ "$(g repoB rev-parse main)" = "$MAIN_B" ]; }

# land_via <merge|poll>: start a landing of #1 in the background (pid in LAND_PID).
land_via() {
  if [ "$1" = merge ]; then
    ( cd "$D" && exec bash "$RUNNER_DIR/gaffer" merge 1 ) > "$D/land.log" 2>&1 &
  else
    ( cd "$D" || exit 2
      log() { printf '%s\n' "$*" >> "$D/land.log"; }
      wg() { node "$DISPATCH_JS" --db "$DISPATCH_DB" "$@"; }
      jget() { node "$RUNNER_DIR/lib/json-tool.mjs" expr "$1"; }
      gaffer_refresh_cards() { :; }
      _gaffer_flag_on() { case "${1:-}" in 1|true|yes|on) return 0 ;; *) return 1 ;; esac; }
      export RUNNER_DIR
      # shellcheck source=../lib/automerge.sh
      source "$RUNNER_DIR/lib/automerge.sh"
      # shellcheck source=../lib/land.sh
      source "$RUNNER_DIR/lib/land.sh"
      gaffer_land_delivery 1 "$D/repoA" gaffer/fixture main "$(wg ticket show 1)" MERGE ) > /dev/null 2>&1 &
  fi
  LAND_PID=$!
}

for path in merge poll; do
  for change in cancel ci; do
    echo "== $path: $change while the merge gate runs =="
    world "$path-$change" 1
    land_via "$path"
    if wait_inside; then
      if [ "$change" = cancel ]; then cancel >/dev/null; want=cancelled; else redci >/dev/null; want=blocked; fi
      [ "$(status)" = "$want" ] && untouched && ok "$path/$change: Dispatch acknowledged ($want) with both main branches still at baseline" \
        || fail "$path/$change: fixture invalid — not acknowledged ($(status)) or main moved early"
      touch "$D/release"; wait "$LAND_PID"; rc=$?
      untouched && ok "$path/$change: neither default branch advanced" || fail "$path/$change: a default branch advanced after the revocation"
      [ "$(status)" = "$want" ] && ok "$path/$change: the ticket stays $want" || fail "$path/$change: ticket is $(status), want $want"
      [ "$rc" -ne 0 ] && ok "$path/$change: the landing exits non-zero (rc=$rc)" || fail "$path/$change: the landing reported success"
      grep -q "not landed:" "$D/land.log" && ok "$path/$change: it says 'not landed: <reason>'" || fail "$path/$change: no 'not landed' line: $(tail -3 "$D/land.log")"
    else
      fail "$path/$change: the landing never reached the gate: $(tail -5 "$D/land.log")"
      touch "$D/release"; wait "$LAND_PID" 2>/dev/null
    fi
  done
done

echo "== merge: a cancellation after one repo landed reports that landing; the rest never lands =="
world after-first 2
land_via merge
if wait_inside; then
  landed_first=""
  if [ "$(g repoA rev-parse main)" != "$MAIN_A" ]; then landed_first=repoA; other=repoB; fi
  if [ "$(g repoB rev-parse main)" != "$MAIN_B" ]; then landed_first=repoB; other=repoA; fi
  [ -n "$landed_first" ] && ok "the first repo ($landed_first) landed before the revocation" || fail "no repo landed before the second gate"
  out="$(cancel)"
  [ "$(printf '%s' "$out" | jf '(d.landed_already || []).filter(l => l.landed).map(l => l.repo).join(",")')" = "$landed_first" ] \
    && ok "reject --to cancelled reports the landing that already happened ($landed_first)" || fail "the revocation did not report the landing: $out"
  grep -q "a landing had already started" "$D/revoke.err" && grep -q "$landed_first" "$D/revoke.err" \
    && ok "the revocation WARNs on stderr, naming the landing" || fail "no WARNING on stderr: $(cat "$D/revoke.err")"
  touch "$D/release"; wait "$LAND_PID"; rc=$?
  if [ "$other" = repoA ]; then o_main="$MAIN_A"; else o_main="$MAIN_B"; fi
  [ "$(g "$other" rev-parse main)" = "$o_main" ] && ok "$other never landed after the acknowledged cancellation" || fail "$other landed after the cancellation"
  [ "$(status)" = cancelled ] && [ "$rc" -ne 0 ] && ok "the ticket stays cancelled and the merge exits non-zero (rc=$rc)" || fail "status=$(status) rc=$rc"
  grep -q "not landed:" "$D/land.log" && ok "the merge says 'not landed' for $other" || fail "no 'not landed' line: $(tail -3 "$D/land.log")"
else
  fail "the second repo's gate was never reached: $(tail -5 "$D/land.log")"
  touch "$D/release"; wait "$LAND_PID" 2>/dev/null
fi

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "landing-revocation: ALL $PASS checks passed"; exit 0
else echo "landing-revocation: ${#FAILURES[@]} FAILED (of $((PASS + ${#FAILURES[@]})))"; exit 1; fi
