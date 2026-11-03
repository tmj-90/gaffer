#!/usr/bin/env bash
# =====================================================================
# REPLAY MANIFEST per delivery attempt (delta roadmap gap 4, P0): lib/replay-manifest.mjs
# (the builder) and lib/replay-manifest.sh (tick.sh's gatherer).
# ---------------------------------------------------------------------
#   U. the builder: a manifest holds hashes of the prompt and the packet, never their
#      text; a test command loses its credentials; settings are short tokens only; the
#      file stays under its byte bound; the first outcome wins; a lane verdict and the
#      landed sha are added later; an unwritable dir fails without a crash.
#   E. END TO END through the REAL tick.sh with a stub agent (real dispatch, real git),
#      one manifest per attempt under $GAFFER_DATA/manifests/<ticket>-<n>.json:
#      E1 submit           outcome submit, the base and head commits, the router's
#                          decision, and the ledger row it joins to (same attempt_id)
#      E2 rework then park attempt 1 rework:definition-of-done, attempt 2
#                          park:definition-of-done, each with its gate rows
#      E3 paused           a commit then a hang past the tick timeout: paused:timeout
#      E4 killed           the tick is sent SIGTERM mid-attempt: killed
#      E5 a write failure  an unwritable manifests dir: the delivery still submits
# Run: bash runner/test/replay-manifest.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }
command -v perl >/dev/null 2>&1 || { echo "SKIP: perl required (timeout primitive)"; exit 0; }

PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/replay-manifest.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
[ "${KEEP:-0}" = 1 ] || trap 'gaffer_test_rm_work "$WORK"' EXIT
MJS="$RUNNER_DIR/lib/replay-manifest.mjs"
# jq-free JSON probe: jt <file> '<js expression over d>'
jt() { node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=(new Function("d","return ("+process.argv[2]+")"))(d);process.stdout.write(typeof v==="string"?v:JSON.stringify(v))' "$1" "$2" 2>/dev/null; }

echo "== U. the builder =="
if [ ! -f "$MJS" ]; then
  fail "U: runner/lib/replay-manifest.mjs does not exist"
else
  U="$WORK/u"; mkdir -p "$U/m"
  printf '{"ticket":{"id":"tk-1","number":7,"risk_level":"low"},"repositories":[{"id":"r1","name":"app","test_command":"API_TOKEN=s3cr3tvalue npm test --password hunter2","stack":"node"}]}' > "$U/show.json"
  printf 'r1\tapp\t/x/app\tmain\t/x/wt\n' > "$U/repos.tsv"
  printf '/x/app\t0123456789abcdef0123456789abcdef01234567\n' > "$U/bases.tsv"
  printf '{"phase":"implement","tier":"mid","model":"model-b","reasons":["phase default","risk high"]}' > "$U/route.json"
  printf '{"files":["a.js"]}' > "$U/packet.json"
  P="$(printf 'PROMPT-TEXT-MARKER secret instructions' | GAFFER_SCOUT=auto GAFFER_TESTING='rm -rf /' GAFFER_SCOUT_PACKET=1 \
        node "$MJS" start --dir "$U/m" --ticket 7 --attempt 1 --max-attempts 3 --attempt-id 'cabc123def456/1' \
          --show-file "$U/show.json" --repos-file "$U/repos.tsv" --bases-file "$U/bases.tsv" \
          --route-file "$U/route.json" --packet-file "$U/packet.json" --risk-effective high --ac-count 2 \
          --skills "tdd, minimalism" --product-context 1 --file-cards 0 --prompt-stdin)"
  [ "$P" = "$U/m/7-1.json" ] && ok "U: the first attempt's file is <ticket>-1.json" || fail "U: path '$P'"
  [ "$(jt "$P" 'd.status')" = open ] && ok "U: opened as status open" || fail "U: status $(jt "$P" 'd.status')"
  grep -q 'PROMPT-TEXT-MARKER' "$P" && fail "U: the prompt TEXT is in the manifest" || ok "U: the prompt text is not in the manifest"
  [ "$(jt "$P" 'd.hashes.prompt_sha256.length')" = 64 ] && ok "U: the prompt is a sha256" || fail "U: prompt hash $(jt "$P" 'd.hashes')"
  [ "$(jt "$P" 'd.hashes.scout_packet_sha256.length')" = 64 ] && ok "U: the scout packet is a sha256" || fail "U: packet hash"
  grep -qE 's3cr3tvalue|hunter2' "$P" && fail "U: a credential from the test command leaked" || ok "U: credentials in the test command are redacted"
  # Review: a bare credential name (`TOKEN=x`, `PASSWORD=x`), a header value and a URL's
  # user:password are redacted too; the file is private to its owner (mode 600, dir 700).
  RED="$(node --input-type=module -e '
    import { redactCommand } from "'"$MJS"'";
    process.stdout.write(["TOKEN=t0ken1 npm test", "PASSWORD=pw2 make test", "export SECRET=sec3 && npm test",
      "npm test --header \"Authorization: Bearer bear4\"", "curl https://u:pw5@h/x && npm test", "npm test --api-key=k6"]
      .map(redactCommand).join("\n"));')"
  case "$RED" in
    *t0ken1* | *pw2* | *sec3* | *bear4* | *pw5* | *k6*) fail "U: a credential survived the redaction: $RED" ;;
    *"TOKEN=<redacted> npm test"*) ok "U: bare credential names, header values and URL passwords are redacted" ;;
    *) fail "U: redaction output $RED" ;;
  esac
  [ "$(ls -l "$P" | cut -c1-10)" = "-rw-------" ] && ok "U: the manifest file is mode 600" || fail "U: mode $(ls -l "$P" | cut -c1-10)"
  printf 'x' | node "$MJS" start --dir "$U/fresh/m" --ticket 7 --prompt-stdin >/dev/null 2>&1
  [ "$(ls -ld "$U/fresh/m" | cut -c1-10)" = "drwx------" ] && ok "U: a new manifests dir is mode 700" || fail "U: dir mode $(ls -ld "$U/fresh/m" | cut -c1-10)"
  [ "$(jt "$P" 'd.repos[0].base_commit')" = "0123456789abcdef0123456789abcdef01234567" ] && ok "U: the repo's base commit" || fail "U: base $(jt "$P" 'd.repos')"
  [ "$(jt "$P" 'd.routing.declared_risk+"/"+d.routing.effective_risk+"/"+d.routing.risk_raised')" = "low/high/true" ] && ok "U: declared and effective risk" || fail "U: risk $(jt "$P" 'd.routing')"
  [ "$(jt "$P" 'd.routing.tier+"/"+d.routing.model+"/"+d.routing.reasons.length')" = "mid/model-b/2" ] && ok "U: the router's tier, model and reasons" || fail "U: routing $(jt "$P" 'd.routing')"
  [ "$(jt "$P" 'd.settings.GAFFER_SCOUT')" = auto ] && [ "$(jt "$P" '"GAFFER_TESTING" in d.settings')" = false ] \
    && ok "U: a setting is kept only as a short token" || fail "U: settings $(jt "$P" 'd.settings')"
  [ "$(jt "$P" 'd.settings.memory_priming.product_context+"/"+d.settings.skills_mounted.join(",")')" = "true/tdd,minimalism" ] && ok "U: memory priming and the mounted skills" || fail "U: priming $(jt "$P" 'd.settings')"
  [ "$(jt "$P" 'd.ledger.attempt_id')" = "cabc123def456/1" ] && ok "U: the ledger join key" || fail "U: ledger $(jt "$P" 'd.ledger')"
  printf 'GATE\ttests\tapp\tFAIL\t1\tx\n' > "$U/gates"; printf 'app\tfedcba9876543210fedcba9876543210fedcba98\n' > "$U/heads"
  node "$MJS" finish --file "$P" --outcome rework:definition-of-done --rc 0 --gates-file "$U/gates" --heads-file "$U/heads"
  node "$MJS" finish --file "$P" --outcome submit --rc 0
  [ "$(jt "$P" 'd.status+"/"+d.outcome.result+"/"+d.outcome.gate')" = "complete/rework:definition-of-done/definition-of-done" ] \
    && ok "U: finish completes it; the first outcome wins" || fail "U: outcome $(jt "$P" 'd.outcome')"
  [ "$(jt "$P" 'd.outcome.gates[0].gate+"/"+d.outcome.gates[0].status+"/"+d.repos[0].head_commit.slice(0,6)')" = "tests/FAIL/fedcba" ] && ok "U: gate rows and the head commit" || fail "U: gates $(jt "$P" 'd.outcome.gates') $(jt "$P" 'd.repos')"
  node "$MJS" annotate --dir "$U/m" --ticket 7 --lane tester --verdict pass
  node "$MJS" annotate --dir "$U/m" --ticket 7 --landed-sha 1111111111111111111111111111111111111111
  [ "$(jt "$P" 'd.outcome.tester_verdict+"/"+d.outcome.lane_verdicts.tester+"/"+d.outcome.landed_sha.slice(0,4)')" = "pass/pass/1111" ] && ok "U: a lane verdict and the landed sha are added later" || fail "U: annotate $(jt "$P" 'd.outcome')"
  P2="$(printf 'x' | node "$MJS" start --dir "$U/m" --ticket 7 --attempt 1 --prompt-stdin)"
  [ "$P2" = "$U/m/7-2.json" ] && ok "U: the next attempt gets the next slot" || fail "U: second path '$P2'"
  node "$MJS" close --file "$P2" --cause signal; node "$MJS" close --file "$P" --cause signal
  [ "$(jt "$P2" 'd.outcome.result')" = killed ] && [ "$(jt "$P" 'd.outcome.result')" = "rework:definition-of-done" ] \
    && ok "U: close marks only an OPEN manifest (killed on a signal)" || fail "U: close $(jt "$P2" 'd.outcome')"
  node "$MJS" finish --file "$(printf 'x' | node "$MJS" start --dir "$U/m" --ticket 7 --prompt-stdin)" --outcome 'weird; rm -rf /'
  [ "$(jt "$U/m/7-3.json" 'd.outcome.result')" = other ] && ok "U: an unknown outcome string is stored as other" || fail "U: outcome $(jt "$U/m/7-3.json" 'd.outcome.result')"
  BIG="$(node -e 'process.stdout.write(Array.from({length:400},(_,i)=>"skill"+i).join(","))')"
  P4="$(printf 'x' | node "$MJS" start --dir "$U/m" --ticket 7 --skills "$BIG" --prompt-stdin)"
  [ "$(wc -c < "$P4" | tr -d ' ')" -le 16385 ] && ok "U: the manifest stays within its byte bound" || fail "U: $(wc -c < "$P4") bytes"
  printf 'a file' > "$U/afile"
  printf 'x' | node "$MJS" start --dir "$U/afile/m" --ticket 7 --prompt-stdin >/dev/null 2>&1
  [ $? -ne 0 ] && ok "U: an unwritable dir is an error exit, not a crash trace on stdout" || fail "U: unwritable dir succeeded"
fi

echo "== E. end to end through tick.sh =="
for f in packages/dispatch/dist/cli/index.js packages/memory/dist/bin/memory.js packages/crew/dist/cli/index.js; do
  [ -f "$ROOT/$f" ] || { echo "SKIP E: $f not built (run pnpm -r build)"; f=""; break; }
done
mkdir -p "$WORK/data" "$WORK/bin"
R="$WORK/repo"; mkdir -p "$R/src" "$R/test"
( cd "$R" && git init -q -b main
  printf '{ "name": "r", "version": "0.1.0", "private": true, "type": "module", "scripts": { "test": "node --test", "lint": "node -e 0" } }\n' > package.json
  printf 'export function a() { return 1; }\n' > src/a.js
  printf 'import test from "node:test"; import assert from "node:assert/strict";\nimport { a } from "../src/a.js";\ntest("a", () => { assert.equal(a(), 1); });\n' > test/a.test.js
  git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init )
MODE="$WORK/mode"; echo deliver > "$MODE"
MARK="$WORK/spawned"
cat > "$WORK/bin/claude" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
MODE="$(cat "__MODE__")"
prompt=""; prev=""
for a in "$@"; do [ "$prev" = "-p" ] && prompt="$a"; prev="$a"; done
if [ -e .git ]; then
  fn="helper${GAFFER_TICKET:-0}"
  n="$(git log --oneline main..HEAD 2>/dev/null | wc -l | tr -d ' ')"
  case "$MODE" in
    fail)
      printf 'export function %s%s(){return 2;}\n' "$fn" "$n" >> src/a.js
      printf 'import test from "node:test"; import assert from "node:assert/strict";\nimport { %s%s } from "../src/a.js";\ntest("%s", () => { assert.equal(%s%s(), %s); });\n' "$fn" "$n" "$fn" "$fn" "$n" "$((n + 3))" > "test/$fn.test.js"
      git -c user.email=s@s -c user.name=s add -A >/dev/null; git -c user.email=s@s -c user.name=s commit -qm "feat: $fn try $n" >/dev/null 2>&1 || true
      printf '{"type":"result","subtype":"success","is_error":false,"result":"done.\\n\\nSmallest-change note: src/a.js helper.","total_cost_usd":0.02,"num_turns":1}\n'; exit 0 ;;
    commit-hang)
      printf 'export function %s(){return 2;}\n' "$fn" >> src/a.js
      git -c user.email=s@s -c user.name=s add -A >/dev/null; git -c user.email=s@s -c user.name=s commit -qm "feat: $fn partial" >/dev/null 2>&1 || true
      sleep 30; exit 0 ;;
    hang)
      : > "__MARK__"; sleep 60; exit 0 ;;
    *)
      printf 'export function %s(){return 2;}\n' "$fn" >> src/a.js
      git -c user.email=s@s -c user.name=s add -A >/dev/null; git -c user.email=s@s -c user.name=s commit -qm "feat: $fn" >/dev/null 2>&1 || true
      printf '{"type":"result","subtype":"success","is_error":false,"result":"done.\\n\\nSmallest-change note: src/a.js helper.","total_cost_usd":0.02,"num_turns":1}\n'; exit 0 ;;
  esac
fi
printf '{"type":"result","subtype":"success","is_error":false,"result":"ok"}\n'
STUB
sed -i.bak "s|__MODE__|$MODE|; s|__MARK__|$MARK|" "$WORK/bin/claude" && rm -f "$WORK/bin/claude.bak"; chmod +x "$WORK/bin/claude"

export GAFFER_DATA="$WORK/data" CLAUDE_BIN="$WORK/bin/claude" CLAUDE_FLAGS="" \
       GAFFER_MAX_TURNS=3 GAFFER_TICK_TIMEOUT=60 GAFFER_CARD_MODEL=stub GAFFER_PLAN_MODEL=stub GAFFER_IMPL_MODEL=stub \
       REVIEW_MODE=human DRY_RUN=0 GAFFER_MAINTENANCE=0 AUTO_MERGE=0 GAFFER_STRICT_REQUIRE=0 GAFFER_SECURITY_REVIEW=0 GAFFER_TESTING=0 \
       GAFFER_ALLOW_UNCAPPED=1 MAX_OPEN_AGENT_BRANCHES_PER_REPO=10 MAX_IN_REVIEW_PER_REPO=10
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
wg init >/dev/null 2>&1; lg init >/dev/null 2>&1
wg repo add -n repo --path "$R" --branch main --stack node --test "npm test" --lint "npm run lint" >/dev/null 2>&1

run_tick() { ( cd "$RUNNER_DIR" && bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep '^TICK_RESULT=' ; }
new_ready() { local n; n="$(wg ticket create -t "$1" -d "$2" --risk low 2>/dev/null | jget 'd.ticket.number')"; wg ac add "$n" -t "helper added" >/dev/null 2>&1; wg ticket repo-access set "$n" repo --access write --relation confirmed >/dev/null 2>&1; wg ticket ready "$n" >/dev/null 2>&1; printf '%s' "$n"; }
M="$GAFFER_DATA/manifests"

echo "-- E1 submit --"
echo deliver > "$MODE"
T1="$(new_ready "Manifest submit TITLE-MARKER-E1" "deliver a helper")"
OUT1="$(run_tick)"
F1="$M/$T1-1.json"
grep -q '^TICK_RESULT=worked$' <<<"$OUT1" && ok "E1: the tick delivered ($OUT1)" || fail "E1: tick result $OUT1"
if [ -f "$F1" ]; then
  [ "$(jt "$F1" 'd.status+"/"+d.outcome.result')" = "complete/submit" ] && ok "E1: outcome submit" || fail "E1: $(jt "$F1" 'd.status+" "+JSON.stringify(d.outcome)')"
  [ "$(jt "$F1" 'd.ticket.number')" = "$T1" ] && [ "$(jt "$F1" 'd.attempt.n+"/"+d.attempt.in_tick+"/"+d.attempt.phase')" = "1/1/implement" ] && ok "E1: ticket and attempt" || fail "E1: attempt $(jt "$F1" 'd.attempt')"
  BASE="$(git -C "$R" rev-parse main)"
  [ "$(jt "$F1" 'd.repos[0].base_commit')" = "$BASE" ] && ok "E1: the repo's base commit" || fail "E1: base $(jt "$F1" 'd.repos')"
  BR="$(git -C "$R" branch --list "gaffer/ticket-$T1-*" | tr -d ' *+' | head -1)"
  [ -n "$BR" ] && [ "$(jt "$F1" 'd.repos[0].head_commit')" = "$(git -C "$R" rev-parse "$BR")" ] && ok "E1: the head commit of the delivered branch" || fail "E1: head $(jt "$F1" 'd.repos') vs $BR"
  [ "$(jt "$F1" 'd.repos[0].test_command')" = "npm test" ] && ok "E1: the registered test command" || fail "E1: test cmd $(jt "$F1" 'd.repos[0]')"
  [ "$(jt "$F1" 'd.routing.model')" = stub ] && [ -n "$(jt "$F1" 'd.routing.reasons.length||""')" ] && ok "E1: the routing decision (model, reasons)" || fail "E1: routing $(jt "$F1" 'd.routing')"
  grep -q 'TITLE-MARKER-E1' "$F1" && fail "E1: ticket text reached the manifest" || ok "E1: no ticket or prompt text in the manifest"
  [ "$(jt "$F1" 'd.outcome.gates.some(g=>g.gate==="tests"&&g.status==="PASS")')" = true ] && ok "E1: the DoD gate rows" || fail "E1: gates $(jt "$F1" 'd.outcome.gates')"
  AID="$(jt "$F1" 'd.ledger.attempt_id')"
  ROW="$(grep '"kind":"delivery"' "$GAFFER_DATA/usage-ledger.jsonl" 2>/dev/null | grep "\"ticket\":$T1," | tail -1)"
  [ -n "$AID" ] && [ -n "$ROW" ] && node -e 'process.exit(JSON.parse(process.argv[1]).attempt_id===process.argv[2]?0:1)' "$ROW" "$AID" \
    && ok "E1: joins to its ledger row by attempt_id ($AID)" || fail "E1: ledger join: manifest '$AID' row ${ROW:-<none>}"
else
  fail "E1: no manifest at $F1 ($(ls "$M" 2>/dev/null | tr '\n' ' '))"
fi

echo "-- E2 rework then park --"
echo fail > "$MODE"
T2="$(new_ready "Manifest rework" "deliver a helper")"
GAFFER_MAX_DELIVERY_ATTEMPTS=2 run_tick >/dev/null
for n in 1 2; do
  want="rework:definition-of-done"; [ "$n" = 2 ] && want="park:definition-of-done"
  if [ -f "$M/$T2-$n.json" ]; then
    [ "$(jt "$M/$T2-$n.json" 'd.outcome.result')" = "$want" ] && ok "E2: attempt $n is $want" || fail "E2: attempt $n $(jt "$M/$T2-$n.json" 'd.outcome')"
    [ "$(jt "$M/$T2-$n.json" 'd.outcome.gates.some(g=>g.gate==="tests"&&g.status==="FAIL")')" = true ] && ok "E2: attempt $n carries the failing gate row" || fail "E2: attempt $n gates $(jt "$M/$T2-$n.json" 'd.outcome.gates')"
  else
    fail "E2: no manifest for attempt $n"
  fi
done
[ "$(jt "$M/$T2-2.json" 'd.attempt.in_tick')" = 2 ] && ok "E2: the in-tick attempt number" || fail "E2: in_tick $(jt "$M/$T2-2.json" 'd.attempt')"

echo "-- E3 paused at the tick timeout --"
echo commit-hang > "$MODE"
T3="$(new_ready "Manifest pause" "deliver a helper")"
GAFFER_TICK_TIMEOUT=3 GAFFER_REAP_GRACE=1 run_tick >/dev/null
[ "$(jt "$M/$T3-1.json" 'd.outcome.result')" = "paused:timeout" ] && ok "E3: paused:timeout" || fail "E3: $(jt "$M/$T3-1.json" 'd.outcome' 2>/dev/null || echo no manifest)"
[ "$(jt "$M/$T3-1.json" 'd.outcome.rc')" = 124 ] && ok "E3: rc 124" || fail "E3: rc $(jt "$M/$T3-1.json" 'd.outcome.rc')"

echo "-- E4 killed --"
echo hang > "$MODE"; rm -f "$MARK"
T4="$(new_ready "Manifest kill" "deliver a helper")"
( cd "$RUNNER_DIR" && exec bash ./tick.sh >>"$GAFFER_DATA/tick.e4.log" 2>&1 ) &
TPID=$!
i=0; while [ ! -e "$MARK" ] && [ "$i" -lt 300 ]; do sleep 0.1; i=$((i + 1)); done
kill -TERM "$TPID" 2>/dev/null; wait "$TPID" 2>/dev/null
[ "$(jt "$M/$T4-1.json" 'd.outcome.result+"/"+d.outcome.exit_cause')" = "killed/signal" ] && ok "E4: killed (signal)" || fail "E4: $(jt "$M/$T4-1.json" 'd.status+" "+JSON.stringify(d.outcome)' 2>/dev/null || echo no manifest)"

echo "-- E5 a manifest write failure never blocks the delivery --"
echo deliver > "$MODE"
mv "$M" "$M.keep"; printf 'not a dir' > "$M"
T5="$(new_ready "Manifest fail-soft" "deliver a helper")"
OUT5="$(run_tick)"
grep -q '^TICK_RESULT=worked$' <<<"$OUT5" && ok "E5: the delivery still submits ($OUT5)" || fail "E5: tick result $OUT5"
grep -q "MANIFEST: could not write the replay manifest for #$T5" "$GAFFER_DATA/factory.log" && ok "E5: the failure is logged" || fail "E5: no MANIFEST log line"
rm -f "$M"; mv "$M.keep" "$M"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "replay-manifest: all $PASS passed"; exit 0; fi
echo "replay-manifest: ${#FAILURES[@]} FAILED (of $((PASS + ${#FAILURES[@]})))"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
tail -40 "$GAFFER_DATA/factory.log" 2>/dev/null
exit 1
