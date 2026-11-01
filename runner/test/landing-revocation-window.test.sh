#!/usr/bin/env bash
# =====================================================================
# A REVOCATION BETWEEN THE LAST PRE-LANDING CHECK AND GIT (adversarial review of #8).
# ---------------------------------------------------------------------
# `wg ticket landing-begin` is the last word before a default branch moves. A revocation
# recorded after it cannot stop that landing. It used to be accepted, and then:
#   - the landing's record was refused (the ticket was no longer ready_for_merge), so
#     the change sat on main with nothing on the ticket's record;
#   - `gaffer merge` and the Poll path reported a clean merge (exit 0) on a cancelled or
#     blocked ticket, the shape of the original finding;
#   - a cancellation after git moved but before the record was written bypassed the
#     partly-landed guard, and a two-repo merge then read success with one repo landed.
# Now the landing is recorded (it started on the approval the ticket had), the merge says
# LANDED AFTER A REVOCATION and exits 4, and a cancellation once git shows the started
# landing is refused (PARTLY_LANDED). A git wrapper holds the landing's git command.
#   A  gaffer merge, cancel before git moves      B  Poll (lib/land.sh), red CI before git
#   C  gaffer merge, two repos, cancel after the first repo's git move, before its record
# Run: bash test/landing-revocation-window.test.sh   (bash 3.2 safe)
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
WORK="$(gaffer_test_tmpdir landing-revocation-window)" || exit 70
trap 'touch "$WORK"/*/release 2>/dev/null; gaffer_test_rm_work "$WORK"' EXIT
REALGIT="$(command -v git)"
mkdir -p "$WORK/bin"
printf '#!/bin/sh\nexit 1\n' > "$WORK/bin/claude"; chmod +x "$WORK/bin/claude"
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
export CLAUDE_BIN="$WORK/bin/claude" GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 LC_ALL=C \
  GAFFER_DOD_SANDBOX=0 GAFFER_DIGEST_DISABLE=1 GAFFER_MEMORY_INDEX=0 GAFFER_CONFLICT_RESOLVER=0 \
  DISPATCH_AUDIT_OFF=1 MEMORY_AUDIT_OFF=1

D=""
wgd() { node "$DISPATCH_JS" --db "$D/data/dispatch.sqlite" "$@"; }
jf() { node "$RUNNER_DIR/lib/json-tool.mjs" expr "$1"; }
g() { "$REALGIT" -C "$D/$1" "${@:2}"; }

# world <case> <before|after> <repos...>: approved ticket #1 over the repos; a git wrapper
# first on PATH holds the first landing git command on main (before or after running it)
# once `armed` exists, until `release`.
world() {
  D="$WORK/$1"; local when="$2"; shift 2
  mkdir -p "$D/home" "$D/tmp" "$D/data" "$D/bin"
  cat > "$D/bin/git" <<G
#!/bin/bash
hold() { [ -e "$D/armed" ] && [ ! -e "$D/held" ] || return 0; : > "$D/held"; : > "$D/inside"; i=0; while [ ! -e "$D/release" ] && [ \$i -lt 600 ]; do sleep 0.2; i=\$((i + 1)); done; }
hit=0
case " \$* " in *" merge --quiet --ff-only "*) hit=1 ;; *" update-ref -m gaffer: land"*) hit=1 ;; esac
[ "\$hit" = 1 ] && [ "$when" = before ] && hold
"$REALGIT" "\$@"; rc=\$?
[ "\$hit" = 1 ] && [ "$when" = after ] && hold
exit \$rc
G
  chmod +x "$D/bin/git"
  export HOME="$D/home" TMPDIR="$D/tmp" GAFFER_DATA="$D/data" DISPATCH_DB="$D/data/dispatch.sqlite" MEMORY_DB="$D/data/memory.sqlite"
  wgd init >/dev/null
  local name; local -a commits=()
  for name in "$@"; do
    mkdir -p "$D/$name"; g "$name" init -q -b main; g "$name" config user.name F; g "$name" config user.email f@example.invalid
    echo base > "$D/$name/base.txt"; g "$name" add base.txt; g "$name" commit -qm baseline
    wgd repo add -n "$name" --path "$D/$name" --branch main --test "true" >/dev/null
  done
  wgd ticket create -t "Change" --description "d" --policy team_light --risk low >/dev/null
  AC="$(wgd ac add 1 -t "AC" | jf 'd.ac_id')"
  for name in "$@"; do wgd ticket repo-access set 1 "$name" --access write --relation confirmed >/dev/null; done
  wgd ticket ready 1 >/dev/null
  AGENT="$(wgd agent register -n fx --max-risk high | jf 'd.agent.id')"
  TOKEN="$(wgd claim-ticket 1 --agent "$AGENT" --ttl 900 | jf 'd.claimToken')"
  for name in "$@"; do
    g "$name" switch -qc gaffer/fx; echo change > "$D/$name/d.txt"; g "$name" add d.txt; g "$name" commit -qm change
    commits+=(--commit "$name=$(g "$name" rev-parse HEAD)"); g "$name" switch -q main
    wgd ticket repo-delivery record 1 "$name" --branch gaffer/fx >/dev/null
  done
  PIN_A="$(g repoA rev-parse gaffer/fx)"; MAIN_A="$(g repoA rev-parse main)"
  wgd evidence 1 --token "$TOKEN" --type test_output --summary s --ac "$AC" >/dev/null
  wgd submit 1 --token "$TOKEN" --reason r >/dev/null
  wgd delivery-artifact 1 --branch gaffer/fx --diff d --as system >/dev/null
  wgd ticket ci-result 1 --commit "$PIN_A" --state pass >/dev/null
  wgd review approve 1 --reviewer op "${commits[@]}" >/dev/null
  : > "$D/armed"
}
status() { wgd ticket show 1 | jf 'd.ticket.status'; }
recorded() { node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1],{readOnly:true});console.log(db.prepare(\"SELECT count(*) AS n FROM evidence WHERE uri LIKE 'gaffer-landed-commit:%' AND recorded_by_actor_type='system'\").get().n)" "$D/data/dispatch.sqlite" 2>/dev/null; }
wait_inside() { local i=0; while [ ! -e "$D/inside" ] && [ "$i" -lt 900 ]; do sleep 0.2; i=$((i + 1)); done; [ -e "$D/inside" ]; }
land_via() {
  if [ "$1" = merge ]; then
    ( cd "$D" && PATH="$D/bin:$PATH" exec bash "$RUNNER_DIR/gaffer" merge 1 ) > "$D/land.log" 2>&1 &
  else
    ( cd "$D" || exit 2
      PATH="$D/bin:$PATH"
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
      gaffer_land_delivery 1 "$D/repoA" gaffer/fx main "$(wg ticket show 1)" MERGE ) > /dev/null 2>&1 &
  fi
  LAND_PID=$!
}

for c in "A merge cancel cancelled" "B poll ci blocked"; do
  # shellcheck disable=SC2086
  set -- $c; id="$1"; path="$2"; change="$3"; want="$4"
  echo "== $id: $path, $change after the last pre-landing check, before git moves =="
  world "$id" before repoA
  land_via "$path"
  if wait_inside; then
    if [ "$change" = cancel ]; then wgd review reject 1 --reason stop --to cancelled --reviewer op >/dev/null 2>"$D/rev.err"
    else wgd ticket ci-result 1 --commit "$PIN_A" --state fail --detail red >/dev/null 2>"$D/rev.err"; fi
    [ "$(status)" = "$want" ] && grep -q "landing in progress" "$D/rev.err" \
      && ok "$id: the revocation is acknowledged ($want) and says a landing is in progress" || fail "$id: $(status) $(cat "$D/rev.err")"
    : > "$D/release"; wait "$LAND_PID"; rc=$?
    [ "$(g repoA rev-parse main)" != "$MAIN_A" ] && ok "$id: the started landing went through (it cannot be stopped)" || fail "$id: main did not move"
    [ "$(recorded)" = 1 ] && ok "$id: and it is on the ticket's record" || fail "$id: landing not recorded ($(recorded))"
    [ "$(status)" = "$want" ] && ok "$id: the ticket stays $want, not done" || fail "$id: status $(status)"
    if [ "$path" = merge ]; then
      [ "$rc" -eq 4 ] && ok "$id: gaffer merge exits 4, not success" || fail "$id: gaffer merge exit $rc"
    fi
    grep -q "LANDED AFTER A REVOCATION" "$D/land.log" && ok "$id: the merge says LANDED AFTER A REVOCATION" || fail "$id: $(tail -3 "$D/land.log")"
  else
    fail "$id: the landing never reached git: $(tail -5 "$D/land.log")"; : > "$D/release"; wait "$LAND_PID" 2>/dev/null
  fi
done

echo "== C: two repos, a cancellation after the first repo's git move, before its record =="
world C after repoA repoB
land_via merge
if wait_inside; then
  [ "$(g repoA rev-parse main)" != "$MAIN_A" ] && [ "$(recorded)" = 0 ] && ok "C: repoA's main moved, no landing on record yet" || fail "C: fixture invalid"
  if wgd review reject 1 --reason stop --to cancelled --reviewer op >/dev/null 2>"$D/rev.err"; then
    fail "C: the cancellation was accepted with repoA on main"
  else
    grep -q "PARTLY_LANDED" "$D/rev.err" && grep -q "already landed in repoA" "$D/rev.err" \
      && ok "C: the cancellation is refused: repoA already landed" || fail "C: $(cat "$D/rev.err")"
  fi
  : > "$D/release"; wait "$LAND_PID"; rc=$?
  [ "$rc" -eq 0 ] && [ "$(status)" = done ] && [ "$(recorded)" = 2 ] && ok "C: the merge finishes both repos and the ticket is done" || fail "C: rc=$rc status=$(status) recorded=$(recorded)"
else
  fail "C: the landing never reached git: $(tail -5 "$D/land.log")"; : > "$D/release"; wait "$LAND_PID" 2>/dev/null
fi

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "landing-revocation-window: ALL $PASS checks passed"; exit 0
else echo "landing-revocation-window: ${#FAILURES[@]} FAILED (of $((PASS + ${#FAILURES[@]})))"; exit 1; fi
