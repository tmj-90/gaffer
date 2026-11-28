#!/usr/bin/env bash
# =====================================================================
# `gaffer research` (backlog 69): research an idea on the web before the spec, from the
# front door. The launcher is a stub (GAFFER_RESEARCH_BIN) that records its stdin and
# prints a canned research result; R6 runs the REAL launcher to prove its refusal.
#   R1  a run: stored ready, the idea on the launcher's stdin, the next step printed
#   R2  --list and --show (the newest when no id is given)
#   R3  a person's edits (drop, add, drop a question) and draft-spec: the exact clauses
#   R4  --discard
#   R5  a launcher that reports an error: exit 1, the run stored failed
#   R6  the real launcher with no dollar cap: refused, exit 1, the agent CLI never runs
#   R7  usage errors exit 2 and start nothing
# Run: bash runner/test/gaffer-research.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
G="$RUNNER_DIR/gaffer"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
[ -f "$ROOT/packages/dispatch/dist/cli/index.js" ] || { echo "SKIP: build the packages first (pnpm -r build)"; exit 0; }
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
has()  { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/gaffer-research.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
trap 'gaffer_test_rm_work "$WORK"' EXIT
D="$WORK/data"; mkdir -p "$D" "$WORK/bin"
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN DISPATCH_DB DISPATCH_API_TOKEN
export NO_COLOR=1

# The canned launcher.
cat > "$WORK/out.json" <<'JSON'
{"phase":"research","result":{"summary":"Trackers exist.","findings":[{"id":"f1","claim":"Strong leads.","why":"bar","sources":[{"url":"https://www.strong.app/"}]}],"comparables":[],"features":[{"id":"ft1","title":"Log sets quickly","description":"Two taps.","priority":"must","backed_by":["f1"]},{"id":"ft2","title":"Offline mode","description":"","priority":"should","backed_by":[]},{"id":"ft3","title":"Social feed","description":"","priority":"wont","backed_by":[]}],"open_questions":[{"id":"q1","text":"Which platforms first?"},{"id":"q2","text":"Free or paid?"}],"risks":[],"dropped_urls":0},"log":{"fetches":[{"url":"https://www.strong.app/","host":"www.strong.app","ts":"2026-11-28T00:00:00Z"}],"searches":[]}}
JSON
cat > "$WORK/bin/research-stub.mjs" <<STUB
import { readFileSync, writeFileSync } from "node:fs";
writeFileSync("$WORK/stdin.json", readFileSync(0, "utf8"));
process.stdout.write(readFileSync(process.env.STUB_OUT, "utf8").trim() + "\n");
STUB
export GAFFER_RESEARCH_BIN="$WORK/bin/research-stub.mjs" STUB_OUT="$WORK/out.json"
ga() { OUT="$(GAFFER_DATA="$D" bash "$G" "$@" 2>&1 </dev/null)"; RC=$?; }
GAFFER_DATA="$D" bash "$G" wg init >/dev/null 2>&1 || { echo "dispatch init failed"; exit 1; }
field() { node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const i=s.indexOf("{");const j=JSON.parse(s.slice(i, s.lastIndexOf("}")+1));const v=process.argv[1].split(".").reduce((o,k)=>o==null?o:o[k],j);process.stdout.write(typeof v==="object"?JSON.stringify(v):String(v))})' "$1"; }

echo "== R1. a run =="
ga research "a web app that tracks gym workouts"
[ "$RC" = 0 ] && ok "gaffer research exits 0" || fail "exit $RC: $OUT"
ID="$(printf '%s' "$OUT" | field id)"
[ "$(printf '%s' "$OUT" | field status)" = ready ] && ok "the run is stored ready" || fail "status: $OUT"
has "$(cat "$WORK/stdin.json")" '"idea":"a web app that tracks gym workouts"' && ok "the idea reached the launcher on stdin" || fail "stdin: $(cat "$WORK/stdin.json")"
has "$OUT" "draft-spec" && ok "the next step is printed" || fail "no next step"

echo "== R2. --list and --show =="
ga research --list
has "$OUT" "$ID" && ok "--list shows the run" || fail "--list: $OUT"
ga research --show
[ "$(printf '%s' "$OUT" | field id)" = "$ID" ] && ok "--show with no id shows the newest" || fail "--show: $OUT"

echo "== R3. a person's edits and draft-spec =="
ga wg research feature "$ID" ft2 --drop
[ "$RC" = 0 ] && ok "drop a feature" || fail "drop: $OUT"
ga wg research feature-add "$ID" --title "Export CSV" --priority should
[ "$RC" = 0 ] && ok "add a feature" || fail "add: $OUT"
ga wg research question "$ID" q2 --drop
[ "$RC" = 0 ] && ok "drop a question" || fail "question: $OUT"
ga wg research draft-spec "$ID"
CL="$(printf '%s' "$OUT" | field spec.clauses_json)"
SPEC="$(printf '%s' "$OUT" | field spec.id)"
EXPECT="[{\"clause_id\":\"$SPEC:research-ft1\",\"kind\":\"requirement\",\"text\":\"Log sets quickly: Two taps.\",\"rationale\":\"From research $ID, feature ft1 (must).\"},{\"clause_id\":\"$SPEC:research-p1\",\"kind\":\"requirement\",\"text\":\"Export CSV\",\"rationale\":\"From research $ID, feature p1 (should, added by a person).\"},{\"clause_id\":\"$SPEC:research-ft3\",\"kind\":\"non-goal\",\"text\":\"Social feed\",\"rationale\":\"From research $ID, feature ft3 (wont).\"},{\"clause_id\":\"$SPEC:research-q1\",\"kind\":\"decision\",\"text\":\"To decide: Which platforms first?\",\"rationale\":\"From research $ID, open question q1.\"}]"
[ "$CL" = "$EXPECT" ] && ok "draft-spec: the exact clauses" || fail "clauses: $CL"

echo "== R4. --discard =="
ga research --discard "$ID"
[ "$(printf '%s' "$OUT" | field status)" = discarded ] && ok "--discard marks it discarded" || fail "discard: $OUT"

echo "== R5. a launcher error =="
printf '{"phase":"error","error":"refused: no OS sandbox for the research agent","code":"sandbox"}\n' > "$WORK/err.json"
OUT="$(GAFFER_DATA="$D" STUB_OUT="$WORK/err.json" bash "$G" research "another idea" 2>&1 </dev/null)"; RC=$?
[ "$RC" = 1 ] && ok "a failed run exits 1" || fail "exit $RC"
[ "$(printf '%s' "$OUT" | field status)" = failed ] && has "$OUT" "no OS sandbox" && ok "the run is stored failed with the reason" || fail "failed run: $OUT"

echo "== R6. the real launcher with no dollar cap =="
cat > "$WORK/bin/claude-tripwire" <<'TRIP'
#!/usr/bin/env bash
echo "called" >> "$TRIPWIRE_LOG"; exit 97
TRIP
chmod +x "$WORK/bin/claude-tripwire"
OUT="$(env -u GAFFER_RESEARCH_BIN -u GAFFER_ALLOW_UNCAPPED -u GAFFER_DAILY_BUDGET_USD -u GAFFER_BUDGET_USD \
  GAFFER_DATA="$D" CLAUDE_BIN="$WORK/bin/claude-tripwire" TRIPWIRE_LOG="$WORK/trip.log" bash "$G" research "a third idea" 2>&1 </dev/null)"; RC=$?
[ "$RC" = 1 ] && ok "refused without a dollar cap (exit 1)" || fail "exit $RC: $OUT"
has "$OUT" "dollar cap" && ok "the reason names the dollar cap" || fail "reason: $OUT"
[ ! -f "$WORK/trip.log" ] && ok "the agent CLI never ran" || fail "the agent CLI was called"

echo "== R7. usage errors =="
: > "$WORK/stdin.json"
ga research; [ "$RC" = 2 ] && ok "no idea: exit 2" || fail "no idea exit $RC"
ga research --bogus; [ "$RC" = 2 ] && ok "an unknown option: exit 2" || fail "bogus exit $RC"
ga research one two; [ "$RC" = 2 ] && ok "two ideas: exit 2" || fail "two ideas exit $RC"
[ ! -s "$WORK/stdin.json" ] && ok "a usage error starts nothing" || fail "the launcher ran on a usage error"

echo
if [ "${#FAILURES[@]}" -gt 0 ]; then
  printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"
  exit 1
fi
echo "gaffer-research: all $PASS checks passed"
