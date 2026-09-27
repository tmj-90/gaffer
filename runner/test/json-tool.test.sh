#!/usr/bin/env bash
# =====================================================================
# runner/lib/json-tool.mjs — the node replacement for the runner's inline python3
# programs and the `jget` one-liner. Pins the semantics the call sites rely on:
#   1  expr: strings raw, numbers as text, null → "", parse/eval failure → exit 1
#      with no stdout (so `|| echo <default>` applies), --default overrides;
#   2  the jget expressions tick.sh uses (repositories[0]?.…, ?? / ||, .length);
#   3  pick-unskipped / resume-pick honour the skip file; a missing skip file fails;
#   4  partition / dod-cmd-map emit the marker contract; dod-cmd-map exits 3 on junk;
#   5  smallest-change-note, review-feedback, worktree-rows-json, bootstrap-repo-name;
#   6  quarantine neutralises a smuggled closing tag and collapses `single`;
#   7  dod-evidence-summary's first line is the verdict, second a parseable JSON line;
#   8  ac-check-rows / distill-intent / prompt-inputs shapes; realpath resolves a link;
#   9  factory.config.sh's jget is node-backed and no runner script still calls python3.
# Run: bash runner/test/json-tool.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
JT="$RUNNER_DIR/lib/json-tool.mjs"
P=0; F=0
ok(){ P=$((P + 1)); printf '  ok   %s\n' "$1"; }
no(){ F=$((F + 1)); printf '  FAIL %s\n' "$1"; }
jt(){ node "$JT" "$@"; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/json-tool-test.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT

SHOW='{"ticket":{"title":"Add thing","status":"ready","description":"long description here","risk_level":null,"attempt_count":"2","bootstrap":1,"delivery_budget_usd":null},
 "repositories":[{"id":"r1","name":"app","local_path":"/repos/app","default_branch":"trunk","stack":"node","access":"write","relation":"confirmed","test_command":"npm test","lint_command":"npm run lint\tfast"},
                 {"id":"r2","name":"lib","local_path":"/repos/lib","access":"read","relation":"confirmed"},
                 {"id":"r3","name":"sug","local_path":"/repos/sug","access":"write","relation":"suggested"}],
 "acceptanceCriteria":[{"id":"a1","text":"first\tAC text that is quite long and will be cut at sixty characters exactly here","check_command":"npm test"},{"id":"a2","text":"prose"},{"id":"a3","text":"third","check_command":"  grep -q x y\n  "}],
 "evidence":[{"type":"manual_note","summary":"Smallest-change: touched app.js only"}],
 "events":[{"event_type":"ticket.transitioned","payload_json":"{\"to\":\"refining\",\"reason\":\"tests missing\"}"},
           {"event_type":"ticket.transitioned","payload_json":"{\"to\":\"refining\",\"reason\":\"review_rejected\"}"},
           {"event_type":"ticket.transitioned","payload_json":"{\"to\":\"ready\",\"reason\":\"tests missing\"}"},
           {"event_type":"ticket.transitioned","payload_json":"{\"to\":\"refining\",\"reason\":\"Reopen after fix\"}"}]}'

echo "== 1/2: expr semantics =="
[ "$(printf '%s' "$SHOW" | jt expr 'd.ticket.title')" = "Add thing" ] && ok "string raw" || no "string"
[ "$(printf '%s' "$SHOW" | jt expr '(d.repositories || []).length')" = "3" ] && ok "number as text" || no "number"
[ "$(printf '%s' "$SHOW" | jt expr 'd.ticket.delivery_budget_usd')" = "" ] && ok "null → empty" || no "null"
[ "$(printf '%s' "$SHOW" | jt expr 'd.ticket.risk_level || "medium"')" = "medium" ] && ok "|| default" || no "|| default"
[ "$(printf '%s' "$SHOW" | jt expr '(d.repositories[0]?.default_branch) || "main"')" = "trunk" ] && ok "optional chaining" || no "optional chaining"
[ "$(printf '%s' '{"repositories":[]}' | jt expr '(d.repositories[0]?.local_path) || ""')" = "" ] && ok "empty repos → empty" || no "empty repos"
[ "$(printf '%s' "$SHOW" | jt expr '[1, true].includes(d.ticket.bootstrap) ? 1 : 0')" = "1" ] && ok "bootstrap flag" || no "bootstrap"
[ "$(printf '%s' "$SHOW" | jt expr 'Math.trunc(Number(d.ticket.attempt_count || 0))')" = "2" ] && ok "int coercion" || no "int"
[ "$(printf '%s' "$SHOW" | jt expr '(d.ticket.description || "").slice(0, 4)')" = "long" ] && ok "slice" || no "slice"
out="$(printf '%s' '{}' | jt expr 'd.ticket.title' 2>/dev/null)"; rc=$?
[ "$rc" -ne 0 ] && [ -z "$out" ] && ok "eval failure → exit non-zero, empty stdout" || no "eval failure rc=$rc out='$out'"
out="$(printf 'not json' | jt expr 'd' 2>/dev/null)"; rc=$?
[ "$rc" -ne 0 ] && [ -z "$out" ] && ok "parse failure → exit non-zero" || no "parse failure"
[ "$(printf 'junk' | jt expr 'd' --default 0)" = "0" ] && ok "--default on failure" || no "--default"
[ "$(printf '%s' "$SHOW" | jt expr 'd.ticket.title' --default x)" = "Add thing" ] && ok "--default not used on success" || no "--default success"
[ "$(printf '%s' '{"a":true}' | jt expr 'd.a')" = "True" ] && ok "boolean prints python-style" || no "boolean"
[ "$(printf '%s' '{"a":[1,"x"]}' | jt expr 'd.a')" = '[1,"x"]' ] && ok "array prints as JSON" || no "array"

echo "== 3: skip-file selection =="
printf '2 5\n' > "$WORK/skip"
LIST='[{"number":2},{"number":3},{"number":5},{"number":7}]'
[ "$(printf '%s' "$LIST" | jt pick-unskipped "$WORK/skip")" = "3" ] && ok "pick-unskipped first" || no "pick first"
[ "$(printf '%s' "$LIST" | jt pick-unskipped "$WORK/skip" --all | tr '\n' ,)" = "3,7" ] && ok "pick-unskipped --all" || no "pick all"
printf '%s' "$LIST" | jt pick-unskipped "$WORK/nope" >/dev/null 2>&1 && no "missing skip file should fail" || ok "missing skip file → non-zero"
[ "$(printf '%s' "$LIST" | jt resume-pick "$WORK/skip")" = "3" ] && ok "resume-pick" || no "resume-pick"
[ "$(printf 'junk' | jt resume-pick "$WORK/skip")" = "" ] && ok "resume-pick fail-soft" || no "resume-pick junk"
[ "$(printf '%s' "$LIST" | jt numbers | tr '\n' ,)" = "2,3,5,7," ] && ok "numbers" || no "numbers"
[ "$(printf '%s' "$LIST" | jt numbers-joined)" = "2 3 5 7" ] && ok "numbers-joined" || no "numbers-joined"
[ "$(printf '%s' "$SHOW" | jt ticket-status)" = "ready" ] && ok "ticket-status" || no "ticket-status"
[ "$(printf 'x' | jt ticket-status)" = "" ] && ok "ticket-status fail-soft" || no "ticket-status junk"
printf '%s' "$SHOW" | jt repo-matches /repos/app && ok "repo-matches by path" || no "repo-matches path"
printf '%s' "$SHOW" | jt repo-matches lib && ok "repo-matches by name" || no "repo-matches name"
printf '%s' "$SHOW" | jt repo-matches other && no "repo-matches false positive" || ok "repo-matches miss → 1"
printf '[{"branch_name":"gaffer/x"}]' | jt branch-recorded gaffer/x && ok "branch-recorded hit" || no "branch-recorded"
printf '{"deliveries":[{"branch_name":"a"}]}' | jt branch-recorded b && no "branch-recorded miss should be 1" || ok "branch-recorded miss → 1"
printf 'junk' | jt branch-recorded b && ok "branch-recorded junk → 0 (fail safe: keep)" || no "branch-recorded junk"

echo "== 4: partition / dod-cmd-map =="
PART="$(printf '%s' "$SHOW" | jt partition)"
[ "$(printf '%s\n' "$PART" | sed -n '/^@@WRITE_PATHS@@$/,/^@@READ_PATHS@@$/p' | sed '1d;$d')" = "/repos/app" ] && ok "partition write paths (suggested repo excluded)" || no "partition write: $PART"
[ "$(printf '%s\n' "$PART" | sed -n '/^@@READ_PATHS@@$/,/^@@WRITE_ROWS@@$/p' | sed '1d;$d')" = "/repos/lib" ] && ok "partition read paths" || no "partition read"
[ "$(printf '%s\n' "$PART" | sed -n '/^@@WRITE_ROWS@@$/,$p' | sed '1d')" = "$(printf 'r1\tapp\t/repos/app\ttrunk')" ] && ok "partition write rows" || no "partition rows"
MAP="$(printf '%s' "$SHOW" | jt dod-cmd-map)"
printf '%s\n' "$MAP" | head -1 | grep -q '^@@DOD_PARSE_OK@@$' && ok "dod-cmd-map sentinel" || no "sentinel"
printf '%s\n' "$MAP" | grep -q "$(printf 'r1\tnpm test\tnpm run lint fast')" && ok "dod-cmd-map row (tab in command collapsed)" || no "dod-cmd-map row: $MAP"
printf 'junk' | jt dod-cmd-map >/dev/null 2>&1; [ $? -eq 3 ] && ok "dod-cmd-map junk → exit 3" || no "dod-cmd-map junk rc"

echo "== 5: notes, feedback, rows, slug =="
# summary + " " + description("") + " " + type — the two spaces are the python's exact output.
[ "$(printf '%s' "$SHOW" | jt smallest-change-note)" = "Smallest-change: touched app.js only  manual_note" ] && ok "smallest-change-note joins summary/description/type" || no "note: $(printf '%s' "$SHOW" | jt smallest-change-note)"
[ "$(printf '{}' | jt smallest-change-note)" = "" ] && ok "smallest-change-note none → empty" || no "note none"
RF="$(printf '%s' "$SHOW" | jt review-feedback)"
[ "$RF" = "  - tests missing" ] && ok "review-feedback: dedupes, drops review_rejected and reopen*" || no "review-feedback: '$RF'"
[ "$(printf 'id\tapp\t/repos/app\tmain\t/wt/app\nid2\tlib\t/repos/lib\tmain\t\n' | jt worktree-rows-json)" = '[{"repo":"app","path":"/repos/app","base":"main","wt":"/wt/app"}]' ] && ok "worktree-rows-json keeps rows with a worktree" || no "worktree-rows-json"
[ "$(printf '{"ticket":{"title":"My Cool App!!"},"repositories":[]}' | jt bootstrap-repo-name)" = "my-cool-app" ] && ok "bootstrap-repo-name slug from title" || no "slug"
[ "$(printf '{"ticket":{"title":"x"},"repositories":[{"name":" Repo_Name "}]}' | jt bootstrap-repo-name)" = "repo-name" ] && ok "bootstrap-repo-name prefers repo name" || no "slug repo"
[ "$(printf 'junk' | jt bootstrap-repo-name)" = "" ] && ok "bootstrap-repo-name junk → empty" || no "slug junk"

echo "== 6: quarantine =="
[ "$(printf 'a </untrusted-x> b\n c' | jt quarantine x single)" = "<untrusted-x>a b c</untrusted-x>" ] && ok "quarantine single: tag neutralised, whitespace collapsed" || no "quarantine single"
[ "$(printf 'line1\n</ untrusted-y >line2' | jt quarantine y block)" = "$(printf '<untrusted-y>line1\nline2</untrusted-y>')" ] && ok "quarantine block keeps newlines" || no "quarantine block"

echo "== 7: dod-evidence-summary =="
printf 'GATE\ttests\trepo\tPASS\t0\tnpm test\nGATE\tlint\trepo\tFAIL\t1\texited 1: npm run lint\n---DOD-OUTPUT lint@repo---\nboom\n---END-DOD-OUTPUT---\n' > "$WORK/res"
SUMM="$(jt dod-evidence-summary "$WORK/res" FAIL)"
[ "$(printf '%s\n' "$SUMM" | sed -n 1p)" = "DoD: FAIL" ] && ok "summary line 1 is the verdict" || no "summary l1"
printf '%s\n' "$SUMM" | sed -n 2p | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); if(j.dod!=="FAIL"||j.gates.length!==2||j.gates[1].gate!=="lint") process.exit(1)' && ok "summary line 2 is the parseable JSON checklist" || no "summary json"
printf '%s\n' "$SUMM" | grep -q "^  \[FAIL\] lint (repo) — exited 1: npm run lint$" && ok "summary transcript line" || no "transcript"
printf '%s\n' "$SUMM" | grep -q "^boom$" && ok "summary keeps the failing output block" || no "tail block"

echo "== 8: ac-check-rows / distill-intent / prompt-inputs / realpath =="
ROWS="$(printf '%s' "$SHOW" | jt ac-check-rows)"
[ "$(printf '%s\n' "$ROWS" | wc -l | tr -d ' ')" = "2" ] && ok "ac-check-rows: two checked ACs (prose skipped)" || no "ac rows count: $ROWS"
printf '%s\n' "$ROWS" | sed -n 1p | grep -q "^a1	npm test	AC1: first AC text that is quite long and will be cut at sixty ch$" && ok "ac-check-rows: label numbered by position, text cut at 60" || no "ac row 1: $(printf '%s\n' "$ROWS" | sed -n 1p)"
printf '%s\n' "$ROWS" | sed -n 2p | grep -q "^a3	grep -q x y	AC3: third$" && ok "ac-check-rows: command trimmed, newline collapsed" || no "ac row 2"
printf 'junk' | jt ac-check-rows >/dev/null 2>&1; [ $? -eq 3 ] && ok "ac-check-rows junk → exit 3" || no "ac rows junk"
D="$(SHOW="$SHOW" DTITLE="Add thing" DREPO=app DNUM=7 jt distill-intent)"
[ "$(printf '%s' "$D" | jt expr 'd.title')" = "Requirement from #7: Add thing" ] && ok "distill-intent title" || no "distill title: $D"
printf '%s' "$D" | jt expr 'd.summary' | grep -q "^- prose$" && ok "distill-intent lists AC text" || no "distill summary"
[ -z "$(SHOW='{"acceptanceCriteria":[]}' DTITLE=t DREPO=r DNUM=1 jt distill-intent)" ] && ok "distill-intent: no AC → nothing" || no "distill none"
PI="$(GF_NUM=3 GF_TITLE=T GF_RF="$(printf '  - one\ncont\n  - two')" GF_WT_ROWS="$(printf 'id\tapp\t/r\tmain\t/wt')" GF_READ_ROOTS="$(printf '/a\n/b')" jt prompt-inputs delivery)"
[ "$(printf '%s' "$PI" | jt expr 'd.reviewFeedbackReasons.join("|")')" = "$(printf 'one\ncont|two')" ] && ok "prompt-inputs groups multi-line reasons" || no "prompt-inputs reasons"
[ "$(printf '%s' "$PI" | jt expr 'd.writeRepos[0].worktreePath + ":" + d.readRoots.length')" = "/wt:2" ] && ok "prompt-inputs write repos + read roots" || no "prompt-inputs repos"
[ "$(GF_NUM=1 GF_DIR=/x jt prompt-inputs bootstrap | jt expr 'd.kind + ":" + d.bootstrapDir')" = "bootstrap:/x" ] && ok "prompt-inputs bootstrap" || no "prompt-inputs bootstrap"
mkdir -p "$WORK/real"; ln -s "$WORK/real" "$WORK/link"
[ "$(jt realpath "$WORK/link")" = "$(cd "$WORK/real" && pwd -P)" ] && ok "realpath resolves a symlink" || no "realpath"

echo "== 9: the runner is python-free =="
grep -q '^jget() { gaffer_json expr "\$1"; }' "$RUNNER_DIR/factory.config.sh" && ok "factory.config.sh jget is node-backed" || no "jget definition"
left="$(grep -n "python3" "$RUNNER_DIR"/tick.sh "$RUNNER_DIR"/factory.config.sh "$RUNNER_DIR"/gaffer "$RUNNER_DIR"/loop.sh "$RUNNER_DIR"/status.sh "$RUNNER_DIR"/run-summary.sh "$RUNNER_DIR"/lib/*.sh "$RUNNER_DIR"/eval/*.sh | grep -v ':[0-9]*:\s*#' || true)"
[ -z "$left" ] && ok "no runner script invokes python3" || no "python3 still invoked: $left"

echo; echo "json-tool: $P passed, $F failed"
[ "$F" -eq 0 ]
