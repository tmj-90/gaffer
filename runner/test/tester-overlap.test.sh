#!/usr/bin/env bash
# =====================================================================
# OVERLAPPING TESTER RUNS AND STALE VERDICTS (external review 16).
# ---------------------------------------------------------------------
# bin/tester-run.mjs works in one directory per ticket ($GAFFER_DATA/worktrees/tester-<n>)
# and records its verdict through dispatch, which checks the ticket's status and contract.
# Two questions, asked of the real runner and the real dispatch:
#   T1  two tester runs for the same ticket: the second must not destroy the first's
#       workspace (nor the first's teardown the second's). The contract: a per-ticket
#       tester lock; a second run while the first holds it is refused (phase "busy",
#       the holder named), never started. The ticket ends with exactly one verdict for
#       its round.
#   T2  a FAIL from a run that started before a rework, released after the ticket is in
#       a NEW testing round: refused (phase "stale", both rounds named), kept as stale
#       evidence, never the current round's verdict; the new round's own tester run is
#       then recorded as usual.
#   T3  the same for a stale PASS (the dangerous direction: an old PASS must never send a
#       reworked revision on).
#   T4  a lock left by a run that is gone (its pid no longer runs, or now names another
#       process) is taken over, and a run releases its lock when it ends.
#   T5  the merge lane's inherited owner (GAFFER_MERGE_LOCK_OWNER) holds the merge lock only,
#       never the tester lock; --lock-hold keeps the merge-ticket-<n>.lock path
# Real dispatch + tick.sh (deliveries and rework), real git, bin/tester-run.mjs --live with
# a stub agent that blocks until the test releases it.
# Run: bash runner/test/tester-overlap.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
[ -f "$ROOT/packages/dispatch/dist/cli/index.js" ] || { echo "SKIP: dispatch CLI not built"; exit 0; }
[ -f "$ROOT/packages/crew/dist/runtime/context/renderPromptCli.js" ] || { echo "SKIP: crew not built"; exit 0; }
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tester-overlap.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
CTL="$WORK/ctl"
BG_PIDS=""
cleanup_bg() {
  # Release every blocked stub so no tester run outlives the test.
  mkdir -p "$CTL" 2>/dev/null; for t in A B C D E F; do : > "$CTL/release-$t" 2>/dev/null; done
  for p in $BG_PIDS; do wait "$p" 2>/dev/null; done
  [ "${KEEP:-0}" = 1 ] && echo "kept $WORK" || gaffer_test_rm_work "$WORK"
}
trap cleanup_bg EXIT
mkdir -p "$WORK/data" "$WORK/bin" "$CTL"
R="$WORK/repo"; mkdir -p "$R/src" "$R/test"
gitc() { git -c user.email=t@t -c user.name=t "$@"; }
( cd "$R" && git init -q -b main
  printf '{ "name": "r", "version": "0.1.0", "private": true, "type": "module", "scripts": { "test": "node --test", "lint": "node -e 0" } }\n' > package.json
  printf 'export const v = 1;\n' > src/v.js
  printf 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { v } from "../src/v.js";\ntest("smoke", () => { assert.equal(v, 1); });\n' > test/smoke.test.js
  gitc add -A && gitc commit -qm init )

# Stub agent.
#   delivery (any non-tester prompt in a checkout): a new line in docs/change.md, committed,
#     so every delivery (and every rework) is a new revision.
#   tester with no TESTER_STUB_TAG (a tick's own tester pass): no verdict, at once.
#   tester tagged <T>: writes its black-box test, says it started (and where), BLOCKS until
#     $CTL/release-<T>, then reports whether its workspace survived and answers the verdict
#     in $CTL/verdict-<T> (PASS | FAIL).
cat > "$WORK/bin/claude" <<STUB
#!/usr/bin/env bash
CTL="$CTL"
STUB
cat >> "$WORK/bin/claude" <<'STUB'
prompt=""; prev=""; for a in "$@"; do [ "$prev" = "-p" ] && prompt="$a"; prev="$a"; done
case "$prompt" in *"INDEPENDENT TESTER"*)
  tag="${TESTER_STUB_TAG:-}"
  if [ -z "$tag" ]; then printf '{"type":"result","subtype":"success","is_error":false,"result":"ok"}\n'; exit 0; fi
  mkdir -p test
  printf 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { v } from "../src/v.js";\ntest("bb %s", () => { assert.equal(v, 1); });\n' "$tag" > "test/bb-$tag.test.js"
  pwd > "$CTL/cwd-$tag"; : > "$CTL/started-$tag"
  i=0; while [ ! -e "$CTL/release-$tag" ] && [ "$i" -lt 1200 ]; do sleep 0.1; i=$((i + 1)); done
  if [ -f "test/bb-$tag.test.js" ]; then echo yes > "$CTL/intact-$tag"; else echo no > "$CTL/intact-$tag"; fi
  v="$(cat "$CTL/verdict-$tag" 2>/dev/null || echo NONE)"
  case "$v" in
    PASS) printf '{"type":"result","subtype":"success","is_error":false,"result":"PASS: v is 1\\n{\\"verdict\\":\\"PASS\\"}","total_cost_usd":0.01,"num_turns":2}\n' ;;
    FAIL) printf '{"type":"result","subtype":"success","is_error":false,"result":"FAIL: v is not what AC1 says\\n{\\"verdict\\":\\"FAIL\\"}","total_cost_usd":0.01,"num_turns":2}\n' ;;
    *) printf '{"type":"result","subtype":"success","is_error":false,"result":"no idea","total_cost_usd":0.01,"num_turns":1}\n' ;;
  esac
  exit 0 ;;
esac
if [ -e .git ]; then
  mkdir -p docs; printf 'change %s %s\n' "$$" "$RANDOM" >> docs/change.md
  git -c user.email=s@s -c user.name=s add -A >/dev/null; git -c user.email=s@s -c user.name=s commit -qm "feat: delivery" >/dev/null 2>&1 || true
  printf '{"type":"result","subtype":"success","is_error":false,"result":"done.\\n\\nSmallest-change note: one line.","total_cost_usd":0.01,"num_turns":1}\n'; exit 0
fi
printf '{"type":"result","subtype":"success","is_error":false,"result":"ok"}\n'
STUB
chmod +x "$WORK/bin/claude"
export GAFFER_DATA="$WORK/data" CLAUDE_BIN="$WORK/bin/claude" CLAUDE_FLAGS="" \
       GAFFER_MAX_TURNS=3 GAFFER_TICK_TIMEOUT=60 GAFFER_ROLE_MODELS=card=stub GAFFER_PLAN_MODEL=stub GAFFER_IMPL_MODEL=stub \
       REVIEW_MODE=human DRY_RUN=0 GAFFER_MAINTENANCE=0 GAFFER_STRICT_REQUIRE=0 GAFFER_SECURITY_REVIEW=0 GAFFER_TESTING=1 \
       MAX_OPEN_AGENT_BRANCHES_PER_REPO=12 MAX_OPEN_AGENT_PRS_PER_REPO=12 MAX_IN_REVIEW_PER_REPO=12 GAFFER_DIGEST_DISABLE=1 GAFFER_AUTO_PUSH=0
unset GAFFER_DOD_TYPECHECK_CMD GAFFER_TESTER_REPLAY TESTER_STUB_TAG
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
# shellcheck source=lib/principal.sh
. "$HERE/lib/principal.sh"
wg init >/dev/null 2>&1; lg init >/dev/null 2>&1
wg repo add -n repo --path "$R" --branch main --stack node --test "npm test" --lint "npm run lint" >/dev/null 2>&1
run_tick() { ( cd "$RUNNER_DIR" && bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep '^TICK_RESULT=' ; }
st() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.status'; }
new_ticket() { local n; n="$(wg ticket create -t "$1" -d "$2" --risk low 2>/dev/null | jget 'd.ticket.number')"; wg ac add "$n" -t "v is 1" >/dev/null 2>&1; wg ticket repo-access set "$n" repo --access write --relation confirmed >/dev/null 2>&1; wg ticket set-testable "$n" >/dev/null 2>&1; wg ticket ready "$n" >/dev/null 2>&1; printf '%s' "$n"; }
branch_head() { git -C "$R" rev-parse "refs/heads/$(wg ticket show "$1" 2>/dev/null | jget 'd.ticket.branch_name || ""')"; }
# The verdict events recorded since the ticket's latest entry into in_testing (this round).
round_verdicts() {
  wg ticket show "$1" 2>/dev/null | jget '(() => { const ev = d.events || []; let at = -1; ev.forEach((e, i) => { if (e.event_type === "ticket.transitioned") { try { if (JSON.parse(e.payload_json || "{}").to === "in_testing") at = i; } catch {} } }); return ev.slice(at + 1).filter(e => e.event_type === "ticket.tester_passed" || e.event_type === "ticket.tester_failed").map(e => e.event_type.slice(14)).join(",") || "none"; })()'
}
# The evidence rows a refused (stale) verdict left on the ticket.
stale_evidence() { wg ticket show "$1" 2>/dev/null | jget '(d.evidence || []).filter(e => { try { return JSON.parse(e.payload_json || "{}").stale === true; } catch { return false; } }).map(e => JSON.parse(e.payload_json).stale_verdict + " " + e.summary).join("\n")'; }
phase_of() { jget 'd.phase || ""' < "$CTL/out-$1" 2>/dev/null; }
field_of() { jget "String(d.$2 ?? '')" < "$CTL/out-$1" 2>/dev/null; }

# start_tester <ticket> <tag> <PASS|FAIL>: bin/tester-run.mjs --live in the background.
start_tester() {
  printf '%s\n' "$3" > "$CTL/verdict-$2"
  ( cd "$RUNNER_DIR" && TESTER_STUB_TAG="$2" node bin/tester-run.mjs --ticket "$1" --live >"$CTL/out-$2" 2>"$CTL/err-$2"; echo $? > "$CTL/rc-$2" ) &
  BG_PIDS="$BG_PIDS $!"
}
# wait_any <file>...: until one exists (60s cap).
wait_any() {
  local i=0 f
  while [ "$i" -lt 600 ]; do
    for f in "$@"; do [ -e "$f" ] && return 0; done
    sleep 0.1; i=$((i + 1))
  done
  return 1
}
release() { : > "$CTL/release-$1"; wait_any "$CTL/rc-$1" || fail "tester $1 did not finish after its release"; }

echo "== setup =="
N1="$(new_ticket "Overlap one" "v stays 1")"
run_tick >/dev/null
[ "$(st "$N1")" = in_testing ] && ok "#$N1 delivered and sent to the tester (in_testing)" || fail "#$N1 status=$(st "$N1")"

echo "== T1: two tester runs for the same ticket =="
start_tester "$N1" A PASS
wait_any "$CTL/started-A" "$CTL/rc-A" && [ -e "$CTL/started-A" ] && ok "T1: tester A started and is blocked in its workspace" || fail "T1: tester A did not start: $(cat "$CTL/out-A" "$CTL/err-A" 2>/dev/null | tail -5)"
start_tester "$N1" B PASS
wait_any "$CTL/started-B" "$CTL/rc-B"
if [ -e "$CTL/rc-B" ] && [ ! -e "$CTL/started-B" ]; then
  B_REFUSED=1
  [ "$(phase_of B)" = busy ] && ok "T1: tester B was refused while A holds the ticket's tester lock (phase busy)" || fail "T1: B ended without starting but phase=$(phase_of B) rc=$(cat "$CTL/rc-B"): $(cat "$CTL/out-B")"
  case "$(field_of B reason)" in *"#$N1"*) ok "T1: B's refusal names the ticket and the run that holds it" ;; *) fail "T1: B's refusal reason: $(field_of B reason)" ;; esac
else
  B_REFUSED=0
  ok "T1: tester B started alongside A (no lock)"
fi
[ -s "$GAFFER_DATA/locks/tester-$N1.lock/started" ] && ok "T1: A's lock records its start identity beside its pid" || fail "T1: A's lock has no start identity"
[ -f "$(cat "$CTL/cwd-A" 2>/dev/null)/test/bb-A.test.js" ] && ok "T1: A's workspace (its test file) is still there after B's start" || fail "T1: B's start destroyed A's workspace ($(cat "$CTL/cwd-A" 2>/dev/null))"
release A
[ "$(cat "$CTL/intact-A" 2>/dev/null)" = yes ] && ok "T1: A's workspace survived its whole run" || fail "T1: A's workspace was destroyed under it (intact=$(cat "$CTL/intact-A" 2>/dev/null))"
[ "$(phase_of A)" = verdict ] && ok "T1: A recorded its verdict (phase verdict)" || fail "T1: A phase=$(phase_of A) rc=$(cat "$CTL/rc-A" 2>/dev/null): $(field_of A reason)$(field_of A error)"
if [ "$B_REFUSED" = 0 ]; then
  release B
  [ "$(cat "$CTL/intact-B" 2>/dev/null)" = yes ] && ok "T1: B's workspace survived A's teardown" || fail "T1: A's teardown destroyed B's workspace (intact=$(cat "$CTL/intact-B" 2>/dev/null))"
fi
[ "$(round_verdicts "$N1")" = passed ] && ok "T1: the ticket has exactly one verdict for its round (A's PASS)" || fail "T1: verdicts this round: $(round_verdicts "$N1") (status $(st "$N1"))"
[ "$(st "$N1")" = in_review ] && ok "T1: A's PASS sent #$N1 back to review" || fail "T1: #$N1 status=$(st "$N1")"
[ ! -e "$GAFFER_DATA/worktrees/tester-$N1" ] && ok "T1: no tester workspace is left behind" || fail "T1: tester-$N1 left behind"

# stale_round <ticket> <tag> <PASS|FAIL>: A starts in round 1, a person FAILs the round,
# the rework is delivered and the ticket is back in_testing (round 2); then A is released.
stale_round() {
  local n="$1" tag="$2" verdict="$3" head1 head2
  head1="$(branch_head "$n")"
  start_tester "$n" "$tag" "$verdict"
  wait_any "$CTL/started-$tag" "$CTL/rc-$tag" && [ -e "$CTL/started-$tag" ] || { fail "$tag did not start: $(cat "$CTL/out-$tag" "$CTL/err-$tag" 2>/dev/null | tail -5)"; return 1; }
  # A person's FAIL is a principal's (package H1): runner/test/lib/principal.sh.
  gaffer_test_as_person ticket tester-fail "$n" --summary "a person saw AC1 fail" --to ready >/dev/null 2>"$CTL/person-fail-$tag.err" || { fail "the person's FAIL was refused: $(tail -1 "$CTL/person-fail-$tag.err")"; return 1; }
  run_tick >/dev/null
  head2="$(branch_head "$n")"
  [ "$(st "$n")" = in_testing ] && [ "$head1" != "$head2" ] && ok "rework delivered (${head1:0:8} -> ${head2:0:8}) and #$n is in a new testing round" || { fail "rework: status=$(st "$n") head ${head1:0:8} -> ${head2:0:8}"; return 1; }
  release "$tag"
}

echo "== T2: a stale FAIL from before a rework =="
N2="$(new_ticket "Overlap two" "v stays 1")"
run_tick >/dev/null
[ "$(st "$N2")" = in_testing ] && ok "#$N2 delivered and in_testing" || fail "#$N2 status=$(st "$N2")"
if stale_round "$N2" C FAIL; then
  [ "$(st "$N2")" = in_testing ] && ok "T2: the stale FAIL did not move the new round (still in_testing)" || fail "T2: the stale FAIL moved #$N2 to $(st "$N2")"
  [ "$(round_verdicts "$N2")" = none ] && ok "T2: no verdict is recorded for the new round" || fail "T2: verdicts this round: $(round_verdicts "$N2")"
  [ "$(phase_of C)" = stale ] && ok "T2: the runner reports the verdict as stale (phase stale)" || fail "T2: C phase=$(phase_of C) rc=$(cat "$CTL/rc-C" 2>/dev/null): $(field_of C reason)$(field_of C error)"
  case "$(field_of C reason)" in *"testing round "*", but the ticket is in testing round "*) ok "T2: the refusal names the run's round and the current one" ;; *) fail "T2: C reason: $(field_of C reason)" ;; esac
  case "$(stale_evidence "$N2")" in fail*) ok "T2: the stale FAIL is kept as stale evidence" ;; *) fail "T2: stale evidence: '$(stale_evidence "$N2")'" ;; esac
  # The new round's own tester run is recorded as usual.
  start_tester "$N2" D PASS
  wait_any "$CTL/started-D" "$CTL/rc-D"; release D
  [ "$(phase_of D)" = verdict ] && [ "$(st "$N2")" = in_review ] && ok "T2: the new round's own tester PASS is recorded (back in review)" || fail "T2: D phase=$(phase_of D) status=$(st "$N2"): $(field_of D reason)$(field_of D error)"
fi

echo "== T3: a stale PASS from before a rework =="
N3="$(new_ticket "Overlap three" "v stays 1")"
run_tick >/dev/null
[ "$(st "$N3")" = in_testing ] && ok "#$N3 delivered and in_testing" || fail "#$N3 status=$(st "$N3")"
if stale_round "$N3" E PASS; then
  [ "$(st "$N3")" = in_testing ] && ok "T3: the stale PASS did not send the reworked revision on (still in_testing)" || fail "T3: the stale PASS moved #$N3 to $(st "$N3")"
  [ "$(round_verdicts "$N3")" = none ] && ok "T3: no verdict is recorded for the new round" || fail "T3: verdicts this round: $(round_verdicts "$N3")"
  [ "$(phase_of E)" = stale ] && ok "T3: the runner reports the verdict as stale (phase stale)" || fail "T3: E phase=$(phase_of E) rc=$(cat "$CTL/rc-E" 2>/dev/null): $(field_of E reason)$(field_of E error)"
  case "$(stale_evidence "$N3")" in pass*) ok "T3: the stale PASS is kept as stale evidence" ;; *) fail "T3: stale evidence: '$(stale_evidence "$N3")'" ;; esac
fi

echo "== T4: a tester lock whose run is gone is taken over =="
# A run killed before it could release its lock (SIGKILL, a crash) leaves the lock with a
# pid that no longer runs: the next run takes it over instead of refusing for ever.
( exit 0 ) & DEAD=$!; wait "$DEAD" 2>/dev/null
mkdir -p "$GAFFER_DATA/locks/tester-$N3.lock"; printf '%s' "$DEAD" > "$GAFFER_DATA/locks/tester-$N3.lock/pid"
start_tester "$N3" F PASS
wait_any "$CTL/started-F" "$CTL/rc-F"
if [ -e "$CTL/started-F" ]; then
  ok "T4: the run started over a dead holder's lock"
  release F
  [ "$(phase_of F)" = verdict ] && [ "$(st "$N3")" = in_review ] && ok "T4: and recorded the current round's PASS" || fail "T4: F phase=$(phase_of F) status=$(st "$N3"): $(field_of F reason)$(field_of F error)"
else
  fail "T4: a dead holder's lock refused the run: $(cat "$CTL/out-F" 2>/dev/null)"
fi
[ ! -e "$GAFFER_DATA/locks/tester-$N3.lock" ] && ok "T4: the lock is released when the run ends" || fail "T4: the lock is still there after the run"
# PID REUSE: a lock whose pid now names another live process (after a reboot, or a pid
# wrap) is not that process's: the lock records its owner's start identity beside the
# pid, and a live pid whose start identity differs is taken over. A matching identity,
# or an older lock with no identity, is still held.
sleep 120 & LIVE=$!; BG_PIDS="$BG_PIDS $LIVE"
REUSE="$(cd "$RUNNER_DIR" && LD="$WORK/reuse" LIVE="$LIVE" node --input-type=module -e '
  import { mkdirSync, rmSync, writeFileSync } from "node:fs";
  import { acquireTicketLock, processStartId } from "./bin/merge-ticket.mjs";
  const dir = process.env.LD + "/locks/tester-9.lock";
  const seed = (started) => { rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
    writeFileSync(dir + "/pid", process.env.LIVE); if (started !== null) writeFileSync(dir + "/started", started); };
  const out = [];
  seed("not-the-same-process"); let r = acquireTicketLock("tester", 9, process.env.LD); out.push(r.ok); if (r.ok) r.release();
  seed(processStartId(Number(process.env.LIVE)) ?? ""); out.push(acquireTicketLock("tester", 9, process.env.LD).ok);
  seed(null); out.push(acquireTicketLock("tester", 9, process.env.LD).ok);
  process.stdout.write(out.join(","));' 2>&1)"
case "$REUSE" in
  true,false,false) ok "T4: a live pid with another start identity is taken over; the owner's own identity, or none, is held" ;;
  *) fail "T4: pid reuse: got '$REUSE' (want true,false,false)" ;;
esac
# INHERITANCE (integration of the landing package): the merge lane names itself in
# GAFFER_MERGE_LOCK_OWNER so the merge-ticket runs it makes under its lock are not
# refused. That applies to the merge lock only: a tester lock held by the same live pid is
# never this run's, with the variable set or the owner passed explicitly. The lane's own
# hold (--lock-hold --owner-pid) records the owner's start identity, not merge-ticket's.
INHERIT="$(cd "$RUNNER_DIR" && LD="$WORK/inherit" LIVE="$LIVE" GAFFER_MERGE_LOCK_OWNER="$LIVE" node --input-type=module -e '
  import { mkdirSync, rmSync, writeFileSync } from "node:fs";
  import { acquireMergeLock, acquireTicketLock, processStartId } from "./bin/merge-ticket.mjs";
  const seed = (kind) => { const dir = process.env.LD + "/locks/" + kind + "-9.lock";
    rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
    writeFileSync(dir + "/pid", process.env.LIVE);
    writeFileSync(dir + "/started", processStartId(Number(process.env.LIVE)) ?? ""); };
  const out = [];
  seed("tester"); out.push(acquireTicketLock("tester", 9, process.env.LD).ok);
  out.push(acquireTicketLock("tester", 9, process.env.LD, { inheritedOwner: process.env.LIVE }).ok);
  seed("merge-ticket"); const m = acquireMergeLock(9, process.env.LD); out.push(m.ok && m.inherited === true);
  process.stdout.write(out.join(","));' 2>&1)"
case "$INHERIT" in
  false,false,true) ok "T5: the merge lane's inherited owner holds the merge lock only, never the tester lock" ;;
  *) fail "T5: inheritance: got '$INHERIT' (want false,false,true)" ;;
esac
HOLD_OUT="$(GAFFER_DATA="$WORK/inherit-hold" node "$RUNNER_DIR/bin/merge-ticket.mjs" --lock-hold --ticket 9 --owner-pid "$LIVE" 2>&1)"; hrc=$?
WANT_ID="$(cd "$RUNNER_DIR" && LIVE="$LIVE" node --input-type=module -e 'import { processStartId } from "./bin/merge-ticket.mjs"; process.stdout.write(processStartId(Number(process.env.LIVE)) ?? "none")' 2>/dev/null)"
if [ "$hrc" -eq 0 ] && [ -d "$WORK/inherit-hold/locks/merge-ticket-9.lock" ] \
  && [ "$(cat "$WORK/inherit-hold/locks/merge-ticket-9.lock/pid" 2>/dev/null)" = "$LIVE" ] \
  && [ "$(cat "$WORK/inherit-hold/locks/merge-ticket-9.lock/started" 2>/dev/null)" = "$WANT_ID" ]; then
  ok "T5: --lock-hold keeps the merge-ticket-<n>.lock path and records the owner's pid and start identity"
else
  fail "T5: --lock-hold rc=$hrc out=$HOLD_OUT started=$(cat "$WORK/inherit-hold/locks/merge-ticket-9.lock/started" 2>/dev/null) want=$WANT_ID"
fi
GAFFER_DATA="$WORK/inherit-hold" node "$RUNNER_DIR/bin/merge-ticket.mjs" --lock-release --ticket 9 --owner-pid "$LIVE" >/dev/null 2>&1
[ ! -e "$WORK/inherit-hold/locks/merge-ticket-9.lock" ] && ok "T5: --lock-release by the owner frees it" || fail "T5: the lock survived --lock-release"
kill "$LIVE" 2>/dev/null; wait "$LIVE" 2>/dev/null

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "tester-overlap: ALL $PASS checks passed"; exit 0; fi
echo "tester-overlap: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1
