#!/usr/bin/env bash
# =====================================================================
# CLEANUP OWNERSHIP (external review #8, finding 2).
# ---------------------------------------------------------------------
# The worktree path and the delivery branch are per TICKET, so two attempts at one ticket
# share them. An old worker whose lease expired (or that was stopped and slow to tear
# down) ran its exit trap after its REPLACEMENT had claimed the ticket, committed and
# submitted it for review — and deleted that branch: the ticket read in_review with
# nothing to review. A tick now removes a worktree or branch only while it still owns it
# (lib/cleanup-ownership.sh, checked against Dispatch right before each step).
#   U  the ownership verdict (json-tool cleanup-owner / latest-claim-id) and the bash
#      helper, on canned `ticket show` JSON — fast, no tick
#   E  EXPIRY: A's real lease expires, B claims, commits and submits; A is then signalled
#      — B's branch survives (ported from the reviewer's lease/reproduce.sh)
#   S  STOP: A is stopped (long lease) and its teardown is held behind a git barrier
#      until B (through the real one-shot Poll) has submitted — B's branch survives
# Real tick.sh, real Dispatch, stub model workers (file barriers). bash 3.2 safe.
# Run: bash test/cleanup-ownership.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
JT="$RUNNER_DIR/lib/json-tool.mjs"
for exe in git node perl; do command -v "$exe" >/dev/null || { echo "SKIP: $exe missing"; exit 0; }; done
[ -f "$ROOT/packages/dispatch/dist/cli/index.js" ] || { echo "SKIP: build the workspace first"; exit 0; }
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
export STUB_TICK_NAME=cleanup-ownership
export GAFFER_DAILY_BUDGET_USD=5 GAFFER_DOD_INSTALL=0 GAFFER_NOCOMMIT_MAX=0
export GAFFER_MEMORY_INDEX=0 GAFFER_DIGEST_DISABLE=1 npm_config_offline=true
# shellcheck source=lib/stub-tick.sh
source "$HERE/lib/stub-tick.sh"

show_json() {  # <status> <claim ids…>: a minimal `ticket show` with claim.created events
  local st="$1"; shift
  local ev="" c
  for c in "$@"; do
    ev="${ev:+$ev,}{\"event_type\":\"claim.created\",\"payload_json\":\"{\\\"claim_id\\\":\\\"$c\\\"}\"}"
  done
  printf '{"ticket":{"number":7,"status":"%s"},"events":[%s]}' "$st" "$ev"
}
verdict() { show_json "$1" "${@:4}" | node "$JT" cleanup-owner --claim "$2" --what "$3" | cut -f1; }

echo "== U: the ownership verdict =="
[ "$(show_json claimed c1 c2 | node "$JT" latest-claim-id)" = c2 ] && ok "latest-claim-id is the newest claim.created" || fail "latest-claim-id"
[ "$(verdict claimed c1 worktree c1)" = owned ] && [ "$(verdict claimed c1 branch c1)" = owned ] \
  && ok "this run's claim is the newest: worktree and branch are its own" || fail "own claim not owned"
[ "$(verdict ready c1 worktree c1 c2)" = foreign ] && [ "$(verdict in_review c1 branch c1 c2)" = foreign ] \
  && ok "a newer claim (another attempt): neither worktree nor branch is this run's" || fail "newer claim not foreign"
[ "$(verdict in_review c1 worktree c1)" = owned ] && [ "$(verdict in_review c1 branch c1)" = foreign ] \
  && ok "a submitted review candidate: its worktree may go, its branch never" || fail "in_review branch not kept"
for s in in_testing ready_for_merge "done"; do
  [ "$(verdict "$s" "" branch)" = foreign ] || fail "branch of a $s ticket not kept"
done
ok "in_testing / ready_for_merge / done branches are kept too"
[ "$(printf 'not json' | node "$JT" cleanup-owner --claim c1 --what branch | cut -f1)" = unknown ] \
  && ok "an unreadable answer is unknown (the caller keeps everything)" || fail "unreadable not unknown"
# The bash helper, on a stubbed Dispatch read.
source "$RUNNER_DIR/lib/cleanup-ownership.sh"
show_json ready c1 c2 > "$WORK/show.json"
printf '#!/bin/sh\ncat "%s"\n' "$WORK/show.json" > "$WORK/bin/show"; chmod +x "$WORK/bin/show"
printf '#!/bin/sh\nexit 3\n' > "$WORK/bin/noshow"; chmod +x "$WORK/bin/noshow"
_GAFFER_OWN_CLAIM_ID=c1
if GAFFER_WG_SHOW_CMD="$WORK/bin/show" gaffer_cleanup_owned 7 branch; then fail "helper: a newer claim read as owned"
else [[ "$_GCO_WHY" == *"another attempt"* ]] && ok "helper: not owned, and says it belongs to another attempt" || fail "helper reason: $_GCO_WHY"; fi
if GAFFER_WG_SHOW_CMD="$WORK/bin/noshow" gaffer_cleanup_owned 7 worktree; then fail "helper: an unreadable Dispatch read as owned"
else [[ "$_GCO_WHY" == *"unknown"* ]] && ok "helper: Dispatch unreadable → not owned (nothing deleted)" || fail "helper reason: $_GCO_WHY"; fi
GAFFER_WG_SHOW_CMD="$WORK/bin/show" gaffer_note_own_claim 7
[ "$_GAFFER_OWN_CLAIM_ID" = c2 ] && ok "gaffer_note_own_claim records the newest claim" || fail "note_own_claim: $_GAFFER_OWN_CLAIM_ID"
_GAFFER_OWN_CLAIM_ID=""
gaffer_cleanup_owned "" branch && ok "no ticket yet: nothing to compare, owned" || fail "empty NUM not owned"

# ── E / S: the two interleavings, with real ticks ─────────────────────────────────
a_pid=""; b_pid=""
stop_worker() { if [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; then kill -TERM -- "-$1" 2>/dev/null || true; fi; }
on_exit() { touch "$WORK/allow-cleanup"; stop_worker "$a_pid"; stop_worker "$b_pid"; [ "${KEEP:-0}" = 1 ] || gaffer_test_rm_work "$WORK"; }
trap on_exit EXIT
for who in a b; do
  cat > "$WORK/bin/$who" <<'STUB'
#!/usr/bin/env bash
set -u
box="$(cat "$(cd "$(dirname "$0")" && pwd -P)/current-box")"; who=$(basename "$0")
if [[ ! -e .git ]]; then printf '%s\n' '{"type":"result","subtype":"success","result":"other"}'; exit 0; fi
if [[ "$who" = b ]]; then
  printf 'replacement work\n' > replacement.txt
  git add replacement.txt && git -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm 'feat: add replacement helper' || exit 2
  git rev-parse HEAD > "$box/b.commit"; git branch --show-current > "$box/b.branch"
fi
touch "$box/$who.started"
while [[ ! -f "$box/$who.finish" ]]; do sleep 0.2; done
printf '%s\n' '{"type":"result","subtype":"success","result":"done. Smallest-change note: helper.","num_turns":1}'
STUB
  chmod +x "$WORK/bin/$who"
done
mkdir -p "$WORK/old-git"
REAL_GIT="$(command -v git)"
cat > "$WORK/old-git/git" <<'PAUSE_GIT'
#!/usr/bin/env bash
set -u
# Hold only A's first teardown step after its claim was released; every call still runs.
for arg in "$@"; do
  if [[ "$arg" = remove && -f "$FIXTURE_WORK/stopping" && ! -e "$FIXTURE_WORK/old-at-cleanup" ]]; then
    touch "$FIXTURE_WORK/old-at-cleanup"
    for _ in $(seq 1 1200); do [[ -e "$FIXTURE_WORK/allow-cleanup" ]] && break; sleep 0.2; done
  fi
done
exec "$FIXTURE_REAL_GIT" "$@"
PAUSE_GIT
chmod +x "$WORK/old-git/git"
wait_file() { local _; for _ in $(seq 1 900); do [ -e "$1" ] && return 0; sleep 0.2; done; return 1; }
launch() {  # <mode> <label> <ttl> <box>
  ( cd "$RUNNER_DIR" || exit 2
    export CLAUDE_BIN="$WORK/bin/$2" GAFFER_CLAIM_TTL="$3"
    export GAFFER_MAX_DELIVERY_ATTEMPTS=1 GAFFER_TICK_TIMEOUT=240 GAFFER_TICK_OUTER_TIMEOUT=300
    if [ "$1" = stop ] && [ "$2" = a ]; then
      export PATH="$WORK/old-git:$PATH" FIXTURE_WORK="$WORK" FIXTURE_REAL_GIT="$REAL_GIT"
    elif [ "$1" = stop ] && [ "$2" = b ]; then
      exec perl -e 'setpgrp(0,0); exec @ARGV' bash ./bin/poll-once.sh
    fi
    exec perl -e 'setpgrp(0,0); exec @ARGV' bash ./tick.sh
  ) > "$4/tick-$2.log" 2>&1 &
  launched=$!
}

trial() {  # <expiry|stop>
  local mode="$1" box="$WORK/box-$1" num ready branch b_commit published after tip
  # (The agent's environment is scrubbed: the stubs find their barrier box through a file.)
  mkdir -p "$box"; printf '%s' "$box" > "$WORK/bin/current-box"
  rm -f "$WORK/stopping" "$WORK/old-at-cleanup" "$WORK/allow-cleanup"
  echo "== $(printf '%s' "$mode" | tr '[:lower:]' '[:upper:]'): A's teardown after B submitted =="
  num="$(new_ready "Add a customer helper ($mode)" "Add a customer helper")"
  [[ "$num" =~ ^[0-9]+$ ]] || { fail "$mode: could not prepare a ticket"; return; }
  if [ "$mode" = expiry ]; then launch "$mode" a 25 "$box"; else launch "$mode" a 6000 "$box"; fi
  a_pid=$launched
  wait_file "$box/a.started" || { fail "$mode: A never started: $(tail -5 "$box/tick-a.log")"; return; }
  [ "$(st "$num")" = claimed ] || { fail "$mode: A does not hold the claim"; return; }
  if [ "$mode" = expiry ]; then
    ready=0
    for _ in $(seq 1 90); do
      wg expire-claims >/dev/null 2>&1
      if [ "$(st "$num")" = ready ]; then ready=1; break; fi
      sleep 1
    done
    [ "$ready" -eq 1 ] || { fail "expiry: the lease did not expire"; return; }
  else
    touch "$WORK/stopping"; stop_worker "$a_pid"
    wait_file "$WORK/old-at-cleanup" || { fail "stop: A never reached its teardown"; return; }
    [ "$(st "$num")" = ready ] || { fail "stop: A did not release its claim on stop"; return; }
  fi
  launch "$mode" b 600 "$box"; b_pid=$launched
  wait_file "$box/b.started" || { fail "$mode: B never started: $(tail -5 "$box/tick-b.log")"; return; }
  branch="$(cat "$box/b.branch")"; b_commit="$(cat "$box/b.commit")"
  touch "$box/b.finish"; wait "$b_pid"; b_pid=""
  [ "$(st "$num")" = in_review ] || { fail "$mode: B did not submit for review ($(st "$num"))"; return; }
  published="$(git -C "$R" rev-parse --verify "refs/heads/$branch^{commit}" 2>/dev/null)" || { fail "$mode: B's branch missing before A's teardown"; return; }
  git -C "$R" merge-base --is-ancestor "$b_commit" "$published" && ok "$mode: B's commit is on the published branch, ticket in_review" || fail "$mode: published branch omits B's commit"
  if [ "$mode" = expiry ]; then stop_worker "$a_pid"; else touch "$WORK/allow-cleanup"; fi
  wait "$a_pid" 2>/dev/null; a_pid=""
  after="$(st "$num")"; tip="$(git -C "$R" rev-parse --verify --quiet "refs/heads/$branch^{commit}" 2>/dev/null || true)"
  [ "$after" = in_review ] && [ "$tip" = "$published" ] && ok "$mode: the review candidate survived A's teardown" \
    || fail "$mode: after A's teardown ticket=$after branch=${tip:-missing} (want in_review at ${published:0:12})"
  grep -q "belong to another attempt" "$box/tick-a.log" && ok "$mode: A logged that the resources belong to another attempt" \
    || fail "$mode: no ownership log line in A's tick log: $(tail -3 "$box/tick-a.log")"
  touch "$box/a.finish"
  retire "$num"
}
trial expiry
trial stop

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "cleanup-ownership: ALL $PASS checks passed"; exit 0
else echo "cleanup-ownership: ${#FAILURES[@]} FAILED (of $((PASS + ${#FAILURES[@]})))"; exit 1; fi
