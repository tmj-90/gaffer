#!/usr/bin/env bash
# =====================================================================
# BUDGET ADMISSION BEFORE EVERY PAID LAUNCH (external review #6).
# ---------------------------------------------------------------------
# With the daily AND lifetime budgets exhausted, the dashboard's planning launchers
# (Plan a build → bin/decompose.mjs; Suggest work → bin/product-owner-run.mjs) still
# invoked the worker and booked a call. Every paid launcher now passes ONE admission
# check (lib/budget-admission.mjs) immediately before it spawns:
#   • Node launchers through lib/worker.mjs `deliver` (tester, decompose, product owner,
#     onboarding analysis, merge resolver) and spec-author's own spawn;
#   • shell launchers through lib/worker.sh `worker_deliver` (delivery, bootstrap,
#     review, clarify, eval judge) via lib/budget.sh `gaffer_paid_launch_admitted`;
#   • the ambiguous-sibling inherit classifier (lib/greenfield.sh, kind inherit), which
#     asks gaffer_paid_launch_admitted directly before its own spawn.
# A stub claude records every invocation; no real model is ever called.
# Run: bash test/paid-launch-admission.test.sh   (bash 3.2 safe)
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
_t() { perl -e 'alarm shift; exec @ARGV' "$@"; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/paid-admission.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"; trap 'gaffer_test_rm_work "$WORK"' EXIT

DATA="$WORK/data"; mkdir -p "$DATA"
INV="$WORK/invocations"
cat > "$WORK/claude" <<STUB
#!/usr/bin/env bash
echo "invoked" >> "$INV"
printf '{"type":"result","subtype":"success","is_error":false,"result":"{\\\\"phase\\\\":\\\\"clarify\\\\",\\\\"questions\\\\":[\\\\"q?\\\\"]}\\\\nPO_RESULT filed=0 reason=stub","total_cost_usd":0.5,"num_turns":1}\n'
STUB
chmod +x "$WORK/claude"
TODAY="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
YESTERDAY="2000-01-01T00:00:00Z"
ledger() { : > "$DATA/usage-ledger.jsonl"; for row in "$@"; do printf '%s\n' "$row" >> "$DATA/usage-ledger.jsonl"; done; }
calls() { [ -f "$INV" ] && wc -l < "$INV" | tr -d ' ' || echo 0; }
export GAFFER_DATA="$DATA" CLAUDE_BIN="$WORK/claude" GAFFER_STRICT_REQUIRE=0 STRICT_MODE=0
unset GAFFER_DAILY_BUDGET_USD GAFFER_BUDGET_USD GAFFER_USAGE_LEDGER GAFFER_ALLOW_UNCAPPED

echo "== the shared check (lib/budget-admission.mjs) =="
adm() { node "$RUNNER_DIR/lib/budget-admission.mjs" check --kind test >/dev/null 2>&1; }
printf '{}' > "$DATA/settings.json"; ledger "{\"ts\":\"$TODAY\",\"total_cost_usd\":5}"
adm && fail "no cap configured admitted (paid-launch-cap-required.test.sh)" || ok "no cap configured ⇒ refused, like a live run"
GAFFER_ALLOW_UNCAPPED=1 adm && ok "no cap + GAFFER_ALLOW_UNCAPPED=1 ⇒ admitted" || fail "the opt-out refused"
printf '{"GAFFER_DAILY_BUDGET_USD":"1"}' > "$DATA/settings.json"
adm && fail "daily cap exhausted (settings.json) admitted" || ok "daily cap from settings.json exhausted ⇒ refused"
ledger "{\"ts\":\"$YESTERDAY\",\"total_cost_usd\":5}"
adm && ok "yesterday's spend does not count against today's cap" || fail "yesterday's spend refused today"
printf '{"GAFFER_BUDGET_USD":"2"}' > "$DATA/settings.json"
adm && fail "lifetime budget exhausted admitted" || ok "lifetime budget exhausted ⇒ refused (all-time spend)"
ledger "{\"ts\":\"$TODAY\",\"estimated_cost_usd\":3}"
adm && fail "an estimated (killed-call) spend was not counted" || ok "a killed call's estimated cost counts"
ledger 'not json'
adm && fail "an unreadable ledger with a cap set admitted" || ok "an unparseable ledger with a cap set ⇒ refused (fail closed)"
printf '{oops' > "$DATA/settings.json"; ledger
adm && fail "an unparseable settings.json admitted" || ok "an unparseable settings.json ⇒ refused (caps unknowable)"
printf '{}' > "$DATA/settings.json"
GAFFER_DAILY_BUDGET_USD=10 GAFFER_BUDGET_USD=10 adm && ok "within both caps (env) ⇒ admitted" || fail "within budget refused"

echo "== the check reads the ledger the writer appends to =="
# A RELATIVE GAFFER_USAGE_LEDGER is booked under GAFFER_DATA (lib/usage-ledger.mjs), so
# it must be read there too — not from the cwd, where it read as "spent 0, admitted".
printf '{"GAFFER_DAILY_BUDGET_USD":"1"}' > "$DATA/settings.json"
printf '%s\n' "{\"ts\":\"$TODAY\",\"total_cost_usd\":5}" > "$DATA/my-ledger.jsonl"
mkdir -p "$WORK/elsewhere"
_rel_out="$(cd "$WORK/elsewhere" && GAFFER_USAGE_LEDGER=my-ledger.jsonl node "$RUNNER_DIR/lib/budget-admission.mjs" check --kind test 2>/dev/null)"; _rel_rc=$?
[ "$_rel_rc" = 3 ] && ok "relative GAFFER_USAGE_LEDGER is read under GAFFER_DATA ⇒ exhausted cap refused" || fail "relative ledger path admitted (rc=$_rel_rc: $_rel_out)"
case "$_rel_out" in *'"spent":5'*) ok "the refusal reports the \$5 booked under GAFFER_DATA" ;; *) fail "relative ledger: spend not read from GAFFER_DATA ($_rel_out)" ;; esac
# The same writer resolver, cross-checked: appendUsageRecord books where the check reads.
_xpath="$(GAFFER_USAGE_LEDGER=my-ledger.jsonl node --input-type=module -e "import { resolveLedgerPath } from '$RUNNER_DIR/lib/usage-ledger.mjs'; process.stdout.write(String(resolveLedgerPath()))" 2>/dev/null)"
[ "$_xpath" = "$DATA/my-ledger.jsonl" ] && ok "writer and check resolve the same file" || fail "writer resolves '$_xpath', expected $DATA/my-ledger.jsonl"
# A ledger that is turned off, or has no location, books nothing: with a cap set the
# spend is unknowable, so the launch is refused (fail closed) — never "spent 0".
for _off in 0 off false no OFF; do
  GAFFER_USAGE_LEDGER="$_off" adm && fail "GAFFER_USAGE_LEDGER=$_off with a cap set admitted" || ok "GAFFER_USAGE_LEDGER=$_off with a cap set ⇒ refused"
done
_nod_rc=0; (cd "$WORK/elsewhere" && env -u GAFFER_DATA -u GAFFER_USAGE_LEDGER HOME="$WORK/elsewhere" GAFFER_DAILY_BUDGET_USD=1 node "$RUNNER_DIR/lib/budget-admission.mjs" check --kind test >/dev/null 2>&1) || _nod_rc=$?
[ "$_nod_rc" = 3 ] && ok "a cap with no ledger location (no GAFFER_DATA) ⇒ refused" || fail "a cap with no ledger location admitted (rc=$_nod_rc)"
printf '{}' > "$DATA/settings.json"
GAFFER_ALLOW_UNCAPPED=1 GAFFER_USAGE_LEDGER=0 adm && ok "uncapped by opt-out ⇒ a disabled ledger still admits" || fail "a disabled ledger with the opt-out refused"
rm -f "$DATA/my-ledger.jsonl"

# Exhausted from here on: settings.json caps (what the dashboard writes), ledger above both.
printf '{"GAFFER_DAILY_BUDGET_USD":"1","GAFFER_BUDGET_USD":"2"}' > "$DATA/settings.json"
ledger "{\"ts\":\"$TODAY\",\"kind\":\"delivery\",\"total_cost_usd\":5}"

echo "== Node launchers: no worker spawned, nothing booked =="
rm -f "$INV"
OUT="$(echo '{"brief":"a todo app"}' | _t 120 node "$RUNNER_DIR/bin/decompose.mjs" 2>/dev/null | tail -n1)"
[ "$(calls)" = 0 ] && case "$OUT" in *"budget is exhausted"*"decompose"*) true ;; *) false ;; esac \
  && ok "decompose (Plan a build): refused before the spawn, says why" || fail "decompose launched past the budget (calls=$(calls), out=$OUT)"
node -e '
const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1]);
db.exec("CREATE TABLE repositories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, local_path TEXT, default_branch TEXT NOT NULL DEFAULT '"'"'main'"'"'); CREATE TABLE tickets (id TEXT PRIMARY KEY, number INTEGER, title TEXT, status TEXT NOT NULL, updated_at TEXT); CREATE TABLE ticket_repos (ticket_id TEXT NOT NULL, repo_id TEXT NOT NULL);");
db.prepare("INSERT INTO repositories (id,name,local_path) VALUES (?,?,?)").run("r1","demo",process.argv[2]);' "$WORK/po.sqlite" "$WORK" 2>/dev/null
rm -f "$INV"
OUT="$(DISPATCH_DB="$WORK/po.sqlite" DISPATCH_PRODUCT_OWNER_REPO=demo _t 120 node "$RUNNER_DIR/bin/product-owner-run.mjs" 2>/dev/null | tail -n1)"
[ "$(calls)" = 0 ] && case "$OUT" in *"budget is exhausted"*"product-owner"*) true ;; *) false ;; esac \
  && ok "product owner (Suggest work): refused before the spawn, says why" || fail "product owner launched past the budget (calls=$(calls), out=$OUT)"
rm -f "$INV"
OUT="$(echo '{"brief":"a todo app"}' | _t 120 node "$RUNNER_DIR/bin/spec-author.mjs" 2>/dev/null | tail -n1)"
[ "$(calls)" = 0 ] && case "$OUT" in *"budget is exhausted"*"spec-author"*) true ;; *) false ;; esac \
  && ok "spec author: refused before its own spawn" || fail "spec author launched past the budget (calls=$(calls), out=$OUT)"
[ "$(wc -l < "$DATA/usage-ledger.jsonl" | tr -d ' ')" = 1 ] && ok "no refused launch booked a ledger row" || fail "the ledger grew: $(cat "$DATA/usage-ledger.jsonl")"
# The seam itself, under each Node launcher's kind (tester, onboarding analysis and the
# merge resolver spawn through it too; their wiring is pinned below).
export RUNNER_DIR
for kind in tester onboarding-analysis merge-resolver decompose product-owner; do
  rm -f "$INV"
  R="$(K="$kind" node --input-type=module -e '
    const W = await import(process.env.RUNNER_DIR + "/lib/worker.mjs");
    const r = W.deliver({ bin: process.env.CLAUDE_BIN, argv: ["-p", "x"], cwd: process.cwd(), timeoutMs: 10000, env: {}, kind: process.env.K });
    process.stdout.write(String(r.status) + " " + String(r.budgetRefused));' 2>/dev/null)"
  [ "$R" = "77 true" ] && [ "$(calls)" = 0 ] && ok "Worker.deliver(kind=$kind): status 77, no spawn" || fail "Worker.deliver(kind=$kind) spawned or wrong status ($R, calls=$(calls))"
done
for pair in "tester-run.mjs:tester" "merge-ticket.mjs:merge-resolver" "decompose.mjs:decompose" "product-owner-run.mjs:product-owner"; do
  f="${pair%%:*}"; k="${pair##*:}"
  grep -q "kind: \"$k\"" "$RUNNER_DIR/bin/$f" && ok "bin/$f spawns through Worker.deliver as kind $k" || fail "bin/$f does not pass kind $k to Worker.deliver"
done
grep -q 'kind: "onboarding-analysis"' "$RUNNER_DIR/lib/onboard-analyze.mjs" && ok "lib/onboard-analyze.mjs spawns through Worker.deliver as onboarding-analysis" || fail "onboard-analyze does not name its kind"
grep -q 'paidLaunchAdmission({ kind: "spec-author" })' "$RUNNER_DIR/bin/spec-author.mjs" && ok "bin/spec-author.mjs asks the shared check before its direct spawn" || fail "spec-author lacks the admission check"

echo "== shell launchers: worker_deliver refuses (rc 77), no spawn =="
# shellcheck source=lib/isolate.sh
. "$HERE/lib/isolate.sh"
SH_OUT="$(
  export GAFFER_DATA="$DATA" CLAUDE_BIN="$WORK/claude"
  # shellcheck source=../factory.config.sh
  source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
  export GAFFER_DATA="$DATA" CLAUDE_BIN="$WORK/claude" GAFFER_STRICT_REQUIRE=0 STRICT_MODE=0
  GAFFER_LOG="$WORK/log"
  for kind in delivery bootstrap review clarify eval-judge; do
    rm -f "$INV"
    printf '{}' > "$WORK/mcp.json"
    GAFFER_LAUNCH_KIND="$kind" worker_deliver "$WORK" "prompt" "" "$WORK/mcp.json" "$WORK/out.json" 2>"$WORK/err"; rc=$?
    printf '%s rc=%s calls=%s err=%s\n' "$kind" "$rc" "$(calls)" "$(tr '\n' ' ' < "$WORK/err" | cut -c1-160)"
  done
)"
for kind in delivery bootstrap review clarify eval-judge; do
  line="$(printf '%s\n' "$SH_OUT" | grep "^$kind rc=")"
  case "$line" in *"rc=77 calls=0"*"budget"*) ok "worker_deliver ($kind): rc 77, no spawn, the reason named" ;; *) fail "worker_deliver ($kind) was not refused: $line" ;; esac
done
grep -q 'GAFFER_LAUNCH_KIND=delivery worker_deliver' "$RUNNER_DIR/tick.sh" && grep -q 'GAFFER_LAUNCH_KIND=bootstrap worker_deliver' "$RUNNER_DIR/tick.sh" \
  && ok "tick.sh's delivery and bootstrap spawns go through the seam with their kind" || fail "tick.sh launch kinds missing"
[ "$(grep -c 'GAFFER_LAUNCH_KIND=review worker_deliver' "$RUNNER_DIR/lib/review.sh")" = 2 ] && ok "review.sh's reviewer + security reviewer spawns name their kind" || fail "review.sh launch kinds missing"
grep -q 'GAFFER_LAUNCH_KIND=clarify worker_deliver' "$RUNNER_DIR/lib/clarify.sh" && ok "clarify.sh names its kind" || fail "clarify.sh launch kind missing"
# worker.sh sourced on its own (budget.sh not loaded): the seam loads the sibling check
# rather than skipping it, so the launch is still refused.
W_OUT="$(
  export GAFFER_DATA="$DATA" CLAUDE_BIN="$WORK/claude"
  unset -f gaffer_paid_launch_admitted 2>/dev/null
  # shellcheck source=../lib/worker.sh
  . "$RUNNER_DIR/lib/worker.sh"
  rm -f "$INV"; printf '{}' > "$WORK/mcp.json"
  GAFFER_LAUNCH_KIND=delivery worker_deliver "$WORK" "prompt" "" "$WORK/mcp.json" "$WORK/out.json" 2>/dev/null; echo "rc=$? calls=$(calls)"
)"
case "$W_OUT" in *"rc=77 calls=0"*) ok "worker_deliver with budget.sh not sourced: the check is still asked (rc 77, no spawn)" ;; *) fail "worker.sh alone skipped the admission: $W_OUT" ;; esac
grep -q 'gaffer_paid_launch_admitted' "$RUNNER_DIR/lib/worker.sh" && ok "worker_deliver asks gaffer_paid_launch_admitted before every spawn" || fail "worker.sh lacks the admission"

echo "== the ambiguous-sibling inherit classifier (lib/greenfield.sh) refuses too =="
# tick.sh runs gaffer_inherit_repo right after a bootstrap delivery; for an ambiguous
# sibling it starts a paid `claude -p` booked as kind `inherit`. With the caps exhausted
# it must not spawn, must book nothing, and must answer empty (the link stays for a human).
INH_PLAN="{\"ambiguous\":[{\"ticket\":30,\"candidates\":[{\"repo\":\"a\"}],\"argv\":[\"-p\",\"pick\",\"--output-format\",\"json\"],\"claudeBin\":\"$WORK/claude\"}]}"
_ledger_rows() { wc -l < "$DATA/usage-ledger.jsonl" | tr -d ' '; }
_rows0="$(_ledger_rows)"
rm -f "$INV"
INH_OUT="$(
  export GAFFER_DATA="$DATA" CLAUDE_BIN="$WORK/claude"
  # shellcheck source=../factory.config.sh
  source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
  export GAFFER_DATA="$DATA" CLAUDE_BIN="$WORK/claude" GAFFER_STRICT_REQUIRE=0 STRICT_MODE=0
  export GAFFER_LOG="$WORK/log"
  printf '%s' "$INH_PLAN" | _gaffer_inherit_amb_spawn 0 30 2>"$WORK/inh-err"
)"
[ "$(calls)" = 0 ] && ok "inherit classifier (factory.config.sh sourced): no spawn with the caps exhausted" || fail "inherit classifier SPAWNED despite exhausted caps (calls=$(calls))"
[ -z "$INH_OUT" ] && ok "inherit classifier: a refusal answers empty (the link is left for a human)" || fail "inherit classifier answered '$INH_OUT' after a refusal"
[ "$(_ledger_rows)" = "$_rows0" ] && ok "inherit classifier: the refused launch booked no ledger row" || fail "inherit refusal grew the ledger: $(cat "$DATA/usage-ledger.jsonl")"
INH_ERR="$(cat "$WORK/inh-err" "$WORK/log" 2>/dev/null)"
case "$INH_ERR" in *"budget admission refused the paid repo classifier for #30"*) ok "inherit classifier: the refusal is logged with the ticket" ;; *) fail "inherit refusal not logged ($INH_ERR)" ;; esac
# greenfield.sh on its own (budget.sh not sourced): it loads the sibling check, never skips it.
rm -f "$INV"
INH_OUT="$(
  export GAFFER_DATA="$DATA" CLAUDE_BIN="$WORK/claude"
  unset -f gaffer_paid_launch_admitted 2>/dev/null
  # shellcheck source=../lib/greenfield.sh
  . "$RUNNER_DIR/lib/greenfield.sh"
  gaffer_timeout() { shift; "$@"; }
  printf '%s' "$INH_PLAN" | _gaffer_inherit_amb_spawn 0 30 2>/dev/null
)"
[ "$(calls)" = 0 ] && [ -z "$INH_OUT" ] && ok "inherit classifier (greenfield.sh alone): the check is still asked, no spawn" || fail "greenfield.sh alone spawned past the budget (calls=$(calls), out=$INH_OUT)"
[ "$(_ledger_rows)" = "$_rows0" ] && ok "inherit classifier (greenfield.sh alone): nothing booked" || fail "greenfield.sh alone grew the ledger"
grep -q 'gaffer_paid_launch_admitted inherit' "$RUNNER_DIR/lib/greenfield.sh" && ok "greenfield.sh asks the shared check as kind inherit" || fail "greenfield.sh lacks the inherit admission"

echo "== within budget the launch proceeds (the check is not a blanket refusal) =="
printf '{"GAFFER_DAILY_BUDGET_USD":"100","GAFFER_BUDGET_USD":"100"}' > "$DATA/settings.json"
rm -f "$INV"
echo '{"brief":"a todo app"}' | _t 120 node "$RUNNER_DIR/bin/decompose.mjs" >/dev/null 2>&1
[ "$(calls)" -ge 1 ] && ok "decompose spawns when the budget has headroom" || fail "decompose did not spawn within budget"
rm -f "$INV"
INH_OUT="$(
  export GAFFER_DATA="$DATA" CLAUDE_BIN="$WORK/claude"
  # shellcheck source=../factory.config.sh
  source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
  export GAFFER_DATA="$DATA" CLAUDE_BIN="$WORK/claude" GAFFER_STRICT_REQUIRE=0 STRICT_MODE=0
  export GAFFER_LOG="$WORK/log"
  printf '%s' "$INH_PLAN" | _gaffer_inherit_amb_spawn 0 30 2>/dev/null
)"
[ "$(calls)" = 1 ] && [ -n "$INH_OUT" ] && ok "the inherit classifier spawns (once) when the budget has headroom" || fail "inherit classifier did not spawn within budget (calls=$(calls), out=$INH_OUT)"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "paid-launch-admission: ALL $PASS checks passed"; exit 0
else echo "paid-launch-admission: ${#FAILURES[@]} FAILED (of $((PASS + ${#FAILURES[@]})))"; exit 1; fi
