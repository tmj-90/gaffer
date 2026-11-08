#!/usr/bin/env bash
# =====================================================================
# The MATCHED EXPERIMENT runner (runner/eval/experiment.sh + experiment.mjs, delta roadmap
# gap 4, P2), end to end with the stub agent: no model, no spend, no dispatch.
#   A  two gate fixtures x two arms (baseline, never:stub=noop) with a seed: results.json
#      has every run, the paired differences per ticket with mean, interval and n, the arm
#      that never submits counts as a failure (not missing data), the judge score where
#      the fixture records one, report.md
#   B  the order is randomised from the seed: the same seed gives the same order, other
#      seeds give others; the order is in results.json
#   C  through the worker seam: every call booked as kind `experiment` with no ticket in
#      the experiment's OWN ledger, the safety-hook settings written into each run's repo
#      (and never committed), `wg` only a recorder, the caller's GAFFER_DATA untouched
#   D  a recorded ticket from a replay manifest: its base and recorded change re-created
#      from the repo and replayed through the gates
#   E  a priming experiment (arms differing only in memory) fills memory_matched
#   F  refusals: one arm, an unknown setting, a tier the registry lacks, --live without a
#      USD cap, --live from an agent's call, --live over manifests; `gaffer eval experiment`
#      reaches the runner
#   G  LIVE mode with a fake paid agent (it reports $0.40 a call): the factory's budget
#      admission refuses with no factory cap and stops the run; with one, every call is
#      booked in the FACTORY's ledger as kind experiment with no ticket, each call gets the
#      remaining run budget as --max-budget-usd, and the run's USD cap stops the rest
#      (left out of the pairs, the report says why)
# Run: bash runner/test/eval-experiment.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
XS="$RUNNER_DIR/eval/experiment.sh"
XP="$RUNNER_DIR/eval/experiment.mjs"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }
command -v perl >/dev/null 2>&1 || { echo "SKIP: perl required"; exit 0; }

PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/eval-experiment.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
[ "${KEEP:-0}" = 1 ] || trap 'gaffer_test_rm_work "$WORK"' EXIT
jt() { node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=(new Function("d","return ("+process.argv[2]+")"))(d);process.stdout.write(typeof v==="string"?v:JSON.stringify(v))' "$1" "$2" 2>/dev/null; }
# The caller's own data dir: the stub-mode experiment must not touch it.
export GAFFER_DATA="$WORK/caller-data"; mkdir -p "$GAFFER_DATA"
unset GAFFER_WRITE_ROOTS GAFFER_TICKET

if [ ! -f "$XS" ] || [ ! -f "$XP" ]; then
  fail "runner/eval/experiment.sh and experiment.mjs exist"
else
echo "== A. two fixtures x two arms, stub agent =="
OUT="$WORK/a"
KEEP_REPOS=1 bash "$XS" --only clean-feature,breaks-tests --arm baseline --arm never:stub=noop --seed 42 --out "$OUT" > "$WORK/a.txt" 2>&1
rc=$?
R="$OUT/results.json"
[ "$rc" -eq 0 ] && [ -f "$R" ] && ok "A: the run exits 0 and writes results.json" || fail "A: rc=$rc $(tail -5 "$WORK/a.txt")"
[ "$(jt "$R" 'd.schema+"/"+d.mode+"/"+d.seed+"/"+d.baseline')" = "gaffer.experiment/1/stub/42/baseline" ] && ok "A: schema, mode, seed and baseline" || fail "A: header $(jt "$R" '[d.schema,d.mode,d.seed,d.baseline]')"
[ "$(jt "$R" 'd.runs.length+"/"+d.tickets.length+"/"+d.arms.length')" = "4/2/2" ] && ok "A: four runs over two tickets and two arms" || fail "A: shape $(jt "$R" '[d.runs.length,d.tickets.length,d.arms.length]')"
run() { jt "$R" "(d.runs.find(r=>r.ticket===\"$1\"&&r.arm===\"$2\")||{})$3"; }
# review14/3: the margin that would judge the result is stored with it.
[ "$(jt "$R" 'd.non_inferiority_margin')" = 0.1 ] && ok "A: results.json names the non-inferiority margin (default 0.1)" || fail "A: margin $(jt "$R" 'd.non_inferiority_margin')"
[ "$(run clean-feature baseline '.submitted')" = true ] && [ "$(run clean-feature baseline '.accepted')" = true ] && [ "$(run clean-feature baseline '.attempts')" = 1 ] \
  && ok "A: clean-feature baseline submits on attempt 1 and is accepted" || fail "A: clean-feature baseline $(run clean-feature baseline '')"
[ "$(run breaks-tests baseline '.outcome')" = "rework:definition-of-done" ] && [ "$(run breaks-tests baseline '.attempts')" = 2 ] \
  && ok "A: breaks-tests baseline fails its gate on both attempts (every attempt counted)" || fail "A: breaks-tests baseline $(run breaks-tests baseline '')"
[ "$(jt "$R" 'd.runs.filter(r=>r.arm==="never").every(r=>r.ran===true&&r.submitted===false&&r.accepted===false&&r.outcome==="empty")')" = true ] \
  && ok "A: the noop arm never submits, and its runs count (ran, not accepted)" || fail "A: never arm $(jt "$R" 'd.runs.filter(r=>r.arm==="never")')"
C='d.comparisons[0]'
[ "$(jt "$R" "$C.arm+\"/\"+$C.vs+\"/\"+$C.n+\"/\"+$C.excluded+\"/\"+$C.differs_in.join(\",\")")" = "never/baseline/2/0/stub" ] \
  && ok "A: one comparison, paired over both tickets, differing in stub" || fail "A: comparison $(jt "$R" "$C")"
[ "$(jt "$R" "$C.per_ticket.map(p=>p.ticket+\":\"+p.acceptance+\":\"+p.attempts).sort().join(\" \")")" = "breaks-tests:0:-1 clean-feature:-1:0" ] \
  && ok "A: the paired differences per ticket (a never-submitting arm counts as failure)" || fail "A: per ticket $(jt "$R" "$C.per_ticket")"
[ "$(jt "$R" "$C.acceptance.mean+\"/\"+$C.acceptance.n+\"/\"+$C.acceptance.ci95.length")" = "-0.5/2/2" ] && ok "A: mean, n and a 95% interval" || fail "A: acceptance $(jt "$R" "$C.acceptance")"
[ "$(run clean-feature baseline '.judge_score')" = 4.8 ] && [ "$(run breaks-tests baseline '.judge_score')" = null ] \
  && ok "A: the judge score where the fixture records one for the delivered change" || fail "A: judge $(run clean-feature baseline '.judge_score') $(run breaks-tests baseline '.judge_score')"
[ -s "$OUT/report.md" ] && grep -q '^## never vs baseline (differs in: stub)' "$OUT/report.md" && grep -q 'counts as that arm.s failure' "$OUT/report.md" \
  && ok "A: report.md with the comparison" || fail "A: report.md"

echo "== B. the order is randomised from the seed =="
for s in 42 42 1 2 3; do
  node "$XP" plan --out "$WORK/b-$s-$RANDOM" --fixtures "$RUNNER_DIR/eval/fixtures" --only clean-feature,breaks-tests,missing-note \
    --arm baseline --arm cheap:tier=cheap --seed "$s" >/dev/null 2>&1
done
ORDERS="$(for d in "$WORK"/b-*; do node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1]+"/plan.json","utf8"));console.log(p.seed+" "+p.order.map(o=>o.ticket+"/"+o.arm).join(","))' "$d"; done | sort)"
[ "$(printf '%s\n' "$ORDERS" | awk '$1==42{print $2}' | sort -u | wc -l | tr -d ' ')" = 1 ] && ok "B: the same seed gives the same order" || fail "B: seed 42 orders differ: $ORDERS"
[ "$(printf '%s\n' "$ORDERS" | awk '{print $2}' | sort -u | wc -l | tr -d ' ')" -ge 3 ] && ok "B: other seeds give other orders" || fail "B: orders: $ORDERS"
[ "$(jt "$R" 'd.order.length===4&&d.order.every((o,i)=>o.order===i+1)')" = true ] && ok "B: the order is in results.json" || fail "B: order $(jt "$R" 'd.order')"

echo "== C. through the worker seam, nothing recorded anywhere else =="
L="$OUT/data/usage-ledger.jsonl"
[ "$(grep -c '"kind":"experiment"' "$L" 2>/dev/null)" = 5 ] && ok "C: every attempt booked as kind experiment in the experiment's own ledger (5)" || fail "C: ledger $(cat "$L" 2>/dev/null)"
[ "$(node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);process.stdout.write(String(l.every(r=>r.ticket===null)))' "$L")" = true ] \
  && ok "C: no ledger row names a ticket" || fail "C: a row names a ticket"
[ ! -e "$GAFFER_DATA/usage-ledger.jsonl" ] && [ -z "$(ls -A "$GAFFER_DATA")" ] && ok "C: the caller's GAFFER_DATA is untouched in stub mode" || fail "C: caller data: $(ls -A "$GAFFER_DATA")"
SETTINGS="$(ls "$OUT"/runs/*/repo/.claude/settings.json 2>/dev/null | head -1)"
[ -n "$SETTINGS" ] && grep -qF "$RUNNER_DIR/safety-hook.mjs" "$SETTINGS" && ok "C: each run's repo carries the verified safety-hook settings" || fail "C: no settings in a run repo"
CF="$(ls -d "$OUT"/runs/*-clean-feature-baseline/repo)"
[ -z "$(git -C "$CF" ls-files .claude)" ] && [ "$(git -C "$CF" rev-list --count main..HEAD)" = 1 ] && ok "C: the settings were never committed; the delivery is one commit" || fail "C: committed .claude or wrong commits"
grep -q '^ac check-result' "$OUT"/runs/*-clean-feature-baseline/a1/wg-calls.log 2>/dev/null && ok "C: the acceptance check's record went to the wg recorder" || fail "C: wg recorder log"

echo "== D. a recorded ticket from a replay manifest =="
REPO="$WORK/d-repo"; mkdir -p "$REPO/test"
( cd "$REPO" && git init -q -b main
  printf 'export const v = 1;\n' > v.mjs
  printf 'import test from "node:test"; import assert from "node:assert/strict"; import { v } from "../v.mjs";\ntest("v", () => assert.ok(v >= 1));\n' > test/v.test.mjs
  git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm base
  git checkout -qb gaffer/ticket-9-x; printf 'export const v = 2;\n' > v.mjs
  git -c user.email=t@t -c user.name=t commit -qam deliver; git checkout -q main )
BASE="$(git -C "$REPO" rev-parse main)"; HEADC="$(git -C "$REPO" rev-parse gaffer/ticket-9-x)"
mkdir -p "$WORK/manifests"
printf '{"schema":"gaffer.replay-manifest/1","ticket":{"number":9},"attempt":{"n":1},"repos":[{"name":"d","path":"%s","base_commit":"%s","head_commit":"%s","test_command":"node --test"}],"routing":{"effective_risk":"low"}}' "$REPO" "$BASE" "$HEADC" > "$WORK/manifests/9-1.json"
bash "$XS" --manifests "$WORK/manifests" --arm baseline --arm never:stub=noop --seed 3 --margin 0.05 --out "$WORK/d" > "$WORK/d.txt" 2>&1
RD="$WORK/d/results.json"
[ "$(jt "$RD" 'd.non_inferiority_margin')" = 0.05 ] && grep -q 'non-inferiority margin 0.05' "$WORK/d/report.md" \
  && ok "D: --margin 0.05 is stored in results.json and printed in the report" || fail "D: margin $(jt "$RD" 'd.non_inferiority_margin')"
for m in 0 0.5 0.7 -0.1 abc; do
  O="$(bash "$XS" --margin "$m" --arm baseline --arm never:stub=noop --out "$WORK/m-bad" 2>&1)"; mrc=$?
  case "$O" in *"--margin must be"*) mok=1 ;; *) mok=0 ;; esac
  [ "$mrc" -eq 2 ] && [ "$mok" = 1 ] && ok "D: --margin $m is refused (0 < m < 0.5)" || fail "D: --margin $m: rc=$mrc $O"
done
[ "$(jt "$RD" '(d.runs.find(r=>r.arm==="baseline")||{}).outcome')" = submit ] && [ "$(jt "$RD" 'd.tickets[0].source')" = manifest ] \
  && ok "D: the recorded change replays from its base commit and submits" || fail "D: $(jt "$RD" 'd.runs') $(tail -3 "$WORK/d.txt")"
[ "$(git -C "$REPO" branch --list | wc -l | tr -d ' ')" = 2 ] && [ "$(git -C "$REPO" rev-parse main)" = "$BASE" ] \
  && ok "D: the source repo's refs are untouched (a shared clone)" || fail "D: source repo changed"

echo "== E. a priming experiment fills memory_matched =="
FXD="$WORK/fixtures"; mkdir -p "$FXD"
cp -R "$RUNNER_DIR/eval/fixtures/_base" "$FXD/_base"
for n in clean-feature missing-note; do
  cp -R "$RUNNER_DIR/eval/fixtures/$n" "$FXD/$n"
  node -e 'const f=process.argv[1];const j=JSON.parse(require("fs").readFileSync(f,"utf8"));j.memory="Tasks are plain objects { title, done }.";require("fs").writeFileSync(f,JSON.stringify(j))' "$FXD/$n/fixture.json"
done
bash "$XS" --fixtures "$FXD" --arm primed:memory=on --arm unprimed:memory=off --seed 5 --out "$WORK/e" > "$WORK/e.txt" 2>&1
RE="$WORK/e/results.json"
[ "$(jt "$RE" 'd.memory_matched.measure+"/"+d.memory_matched.tickets+"/"+d.memory_matched.with_memory+"/"+d.memory_matched.without_memory')" = "matched_memory_priming/2/primed/unprimed" ] \
  && ok "E: memory_matched names the arms and the ticket count" || fail "E: $(jt "$RE" 'd.memory_matched') $(tail -3 "$WORK/e.txt")"
[ "$(jt "$RE" 'd.arms.find(a=>a.name==="unprimed").unapplied["clean-feature"].length')" = 0 ] && ok "E: the memory setting applies where the fixture carries memory" || fail "E: unapplied $(jt "$RE" 'd.arms')"
[ "$(node "$XP" prompt --plan "$WORK/e/plan.json" --ticket clean-feature --arm primed | grep -c 'Product memory:')" = 1 ] \
  && [ "$(node "$XP" prompt --plan "$WORK/e/plan.json" --ticket clean-feature --arm unprimed | grep -c 'Product memory:')" = 0 ] \
  && ok "E: the primed arm's brief carries the memory block, the unprimed one does not" || fail "E: prompt memory block"

echo "== F. refusals =="
bash "$XS" --arm only >/dev/null 2>&1; [ $? -eq 2 ] && ok "F: one arm is refused" || fail "F: one arm accepted"
bash "$XS" --only clean-feature --arm a --arm b:temperature=2 --out "$WORK/f1" >/dev/null 2>&1; [ $? -eq 2 ] && ok "F: an unknown setting is refused" || fail "F: unknown setting accepted"
bash "$XS" --only clean-feature --arm a --arm b:tier=nope --out "$WORK/f2" >/dev/null 2>&1; [ $? -eq 2 ] && ok "F: a tier the registry lacks is refused" || fail "F: unknown tier accepted"
O="$(bash "$XS" --live --only clean-feature --arm a --arm b:tier=cheap --out "$WORK/f3" 2>&1)"; rc=$?
[ "$rc" -eq 2 ] && grep -q 'hard USD cap' <<<"$O" && ok "F: --live without a USD cap is refused" || fail "F: live no cap rc=$rc $O"
O="$(GAFFER_WRITE_ROOTS=/tmp/x bash "$XS" --live --max-usd 1 --only clean-feature --arm a --arm b:tier=cheap --out "$WORK/f4" 2>&1)"; rc=$?
[ "$rc" -eq 2 ] && grep -q "inside an agent" <<<"$O" && ok "F: --live from an agent's call is refused" || fail "F: live from agent rc=$rc $O"
O="$(bash "$XS" --live --max-usd 1 --manifests "$WORK/manifests" --arm a --arm b:tier=cheap --out "$WORK/f5" 2>&1)"; rc=$?
[ "$rc" -eq 2 ] && grep -q 'live mode re-delivers fixtures only' <<<"$O" && ok "F: --live over manifests is refused (no prompt text is kept)" || fail "F: live manifests rc=$rc $O"
O="$(bash "$RUNNER_DIR/gaffer" eval experiment --arm only 2>&1)"; rc=$?
[ "$rc" -eq 2 ] && grep -q 'at least two arms' <<<"$O" && ok "F: gaffer eval experiment reaches the runner" || fail "F: front door rc=$rc $O"
fi

echo "== G. live mode: budget admission, the factory ledger, the run's USD cap =="
mkdir -p "$WORK/bin"
cat > "$WORK/bin/paid-agent" <<'STUB'
#!/usr/bin/env bash
case "${1:-}" in --version) echo "9.9.9 (fake)"; exit 0 ;; esac
prev=""; for a in "$@"; do [ "$prev" = "--max-budget-usd" ] && printf '%s\n' "$a" >> "__ARGS__"; prev="$a"; done
printf '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"made nothing","total_cost_usd":0.4}\n'
STUB
sed -i.bak "s|__ARGS__|$WORK/paid-args|" "$WORK/bin/paid-agent" && rm -f "$WORK/bin/paid-agent.bak"; chmod +x "$WORK/bin/paid-agent"
LD="$WORK/live-data"; mkdir -p "$LD"
O="$(GAFFER_DATA="$LD" CLAUDE_BIN="$WORK/bin/paid-agent" GAFFER_ALLOW_UNCAPPED= GAFFER_DAILY_BUDGET_USD= GAFFER_BUDGET_USD= \
     STRICT_MODE=0 GAFFER_STRICT_REQUIRE=0 bash "$XS" --live --max-usd 0.5 --only clean-feature,breaks-tests \
     --arm baseline --arm cheap:tier=cheap --seed 9 --out "$WORK/g1" 2>&1)"
RG="$WORK/g1/results.json"
[ "$(jt "$RG" 'd.mode+"/"+d.runs.every(r=>r.ran===false)+"/"+d.runs[0].outcome')" = "live/true/budget_refused" ] \
  && [ ! -s "$WORK/paid-args" ] && ok "G: with no factory cap the budget admission refuses and nothing is spawned" || fail "G: no cap $(jt "$RG" 'd.runs') $O"
O="$(GAFFER_DATA="$LD" CLAUDE_BIN="$WORK/bin/paid-agent" GAFFER_DAILY_BUDGET_USD=5 \
     STRICT_MODE=0 GAFFER_STRICT_REQUIRE=0 bash "$XS" --live --max-usd 0.5 --only clean-feature,breaks-tests \
     --arm baseline --arm cheap:tier=cheap --seed 9 --out "$WORK/g2" 2>&1)"
RG="$WORK/g2/results.json"
[ "$(grep -c '"kind":"experiment"' "$LD/usage-ledger.jsonl" 2>/dev/null)" = 2 ] \
  && [ "$(node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);process.stdout.write(String(l.every(r=>r.ticket===null&&r.total_cost_usd===0.4)))' "$LD/usage-ledger.jsonl")" = true ] \
  && ok "G: two paid calls booked in the factory's ledger, kind experiment, no ticket" || fail "G: ledger $(cat "$LD/usage-ledger.jsonl" 2>/dev/null) $O"
[ "$(sed -n 1p "$WORK/paid-args")" = "0.5000" ] && [ "$(sed -n 2p "$WORK/paid-args")" = "0.1000" ] \
  && ok "G: each call is capped at the run's remaining budget" || fail "G: per-call caps $(cat "$WORK/paid-args")"
[ "$(jt "$RG" 'd.runs.filter(r=>r.ran===false).length+"/"+d.spent_usd+"/"+/USD cap/.test(d.stopped)')" = "2/0.8/true" ] \
  && ok "G: the run's USD cap stops the rest; spent and why are reported" || fail "G: cap $(jt "$RG" '[d.spent_usd,d.stopped,d.runs.map(r=>r.outcome)]')"
[ "$(jt "$RG" 'd.comparisons[0].n+"/"+d.comparisons[0].excluded')" = "0/2" ] && ok "G: runs the cap stopped are left out of the pairs" || fail "G: pairs $(jt "$RG" 'd.comparisons[0]')"

echo "== H. arms compared on their effective settings (review) =="
# `memory=on` against a baseline that names no memory is the SAME arm (priming is on by
# default): it must not read as a memory difference nor fill the matched-memory seam; and
# the seam counts only tickets where the memory setting took effect.
H="$(node --input-type=module -e '
  import { report } from "'"$XP"'";
  const arm = (name, overrides, unapplied = {}) => ({ name, overrides, unapplied });
  const runs = [];
  for (const t of ["t1", "t2"]) for (const a of ["base", "same", "off"])
    runs.push({ ticket: t, arm: a, ran: true, accepted: a !== "off", attempts: 1, spend_usd: 1, judge_score: null });
  const plan = { mode: "stub", seed: 1, baseline: "base", tickets: [{ id: "t1" }, { id: "t2" }], order: [],
    arms: [arm("base", {}), arm("same", { memory: "on" }),
           arm("off", { memory: "off" }, { t2: ["memory (the ticket carries no memory to prime)"] })] };
  const r = report(plan, runs);
  process.stdout.write([r.comparisons[0].differs_in.length, r.comparisons[1].differs_in.join(","),
    r.memory_matched.without_memory, r.memory_matched.tickets, JSON.stringify(r.comparisons[1].vs_overrides)].join("/"));')"
[ "$H" = "0/memory/off/1/{}" ] && ok "H: memory=on against the default is no difference; the seam counts only tickets primed differently" \
  || fail "H: effective settings $H"

# Review: a call whose spend cannot be read (killed, timed out, no envelope) used to add
# nothing to the run's spend, so every later call got the whole cap again. It now counts
# its whole per-call cap against the run: the run stops after it.
cat > "$WORK/bin/silent-agent" <<'STUB'
#!/usr/bin/env bash
case "${1:-}" in --version) echo "9.9.9 (fake)"; exit 0 ;; esac
prev=""; for a in "$@"; do [ "$prev" = "--max-budget-usd" ] && printf '%s\n' "$a" >> "__ARGS__"; prev="$a"; done
exit 1
STUB
sed -i.bak "s|__ARGS__|$WORK/silent-args|" "$WORK/bin/silent-agent" && rm -f "$WORK/bin/silent-agent.bak"; chmod +x "$WORK/bin/silent-agent"
LD3="$WORK/live-data3"; mkdir -p "$LD3"
O="$(GAFFER_DATA="$LD3" CLAUDE_BIN="$WORK/bin/silent-agent" GAFFER_DAILY_BUDGET_USD=5 \
     STRICT_MODE=0 GAFFER_STRICT_REQUIRE=0 bash "$XS" --live --max-usd 0.5 --only clean-feature,breaks-tests \
     --arm baseline --arm cheap:tier=cheap --seed 9 --out "$WORK/g3" 2>&1)"
RG="$WORK/g3/results.json"
[ "$(wc -l < "$WORK/silent-args" 2>/dev/null | tr -d ' ')" = 1 ] \
  && [ "$(jt "$RG" 'd.runs.filter(r=>r.ran===false).length+"/"+/could not be read/.test(d.stopped)')" = "3/true" ] \
  && ok "G: a call with an unreadable spend counts its whole cap: the run stops after it" \
  || fail "G: unknown spend: calls=$(cat "$WORK/silent-args" 2>/dev/null | tr '\n' ' ') $(jt "$RG" '[d.stopped,d.runs.map(r=>r.outcome)]')"
[ "$(grep -c '"kind":"experiment"' "$LD3/usage-ledger.jsonl" 2>/dev/null)" = 1 ] \
  && ok "G: the unreadable call is still booked in the factory's ledger" || fail "G: ledger3 $(cat "$LD3/usage-ledger.jsonl" 2>/dev/null)"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "eval-experiment: all $PASS passed"; exit 0; fi
echo "eval-experiment: ${#FAILURES[@]} FAILED (of $((PASS + ${#FAILURES[@]})))"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
