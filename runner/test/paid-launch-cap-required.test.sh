#!/usr/bin/env bash
# =====================================================================
# EVERY paid launch needs a dollar cap, not only `gaffer run` (exploratory finding
# fresh-user/F-09).
# ---------------------------------------------------------------------
# lib/budget-admission.mjs treated an unset cap as "off", so onboarding analysis,
# Plan a build (decompose), Suggest work (product owner), the spec author, the merge
# resolver and the tester launched paid calls with no cap anywhere, while a live run
# refused to start without one. Proves (stub claude, no model call):
#   C1. the shared check: no cap → refused (exit 3) with the live run's hint; either
#       cap → admitted; GAFFER_ALLOW_UNCAPPED=1 in the environment → admitted; the
#       same key in settings.json → still refused
#   C2. decompose, product owner and spec author refuse before spawning and say why
#   C3. Worker.deliver (tester, merge resolver, onboarding analysis, …) → status 77,
#       no spawn; the shell seam (worker_deliver) → rc 77, no spawn
#   C4. `gaffer onboard` with no cap: succeeds with the mechanical digest, calls no
#       model, and the summary says the analysis was skipped for the missing cap
# Run: bash runner/test/paid-launch-cap-required.test.sh   (bash 3.2 safe)
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
has()  { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }
_t() { perl -e 'alarm shift; exec @ARGV' "$@"; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/cap-required.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"; trap 'gaffer_test_rm_work "$WORK"' EXIT
DATA="$WORK/data"; mkdir -p "$DATA"; INV="$WORK/invocations"
cat > "$WORK/claude" <<STUB
#!/usr/bin/env bash
[ "\${1:-}" = "--version" ] && { echo "0.0.0 stub"; exit 0; }
echo "invoked" >> "$INV"
printf '{"type":"result","subtype":"success","is_error":false,"result":"{}","total_cost_usd":0.01,"num_turns":1}\n'
STUB
chmod +x "$WORK/claude"
calls() { [ -f "$INV" ] && wc -l < "$INV" | tr -d ' ' || echo 0; }
export GAFFER_DATA="$DATA" CLAUDE_BIN="$WORK/claude" GAFFER_STRICT_REQUIRE=0 STRICT_MODE=0
unset GAFFER_DAILY_BUDGET_USD GAFFER_BUDGET_USD GAFFER_USAGE_LEDGER GAFFER_ALLOW_UNCAPPED
printf '{}' > "$DATA/settings.json"

echo "== C1. the shared check =="
OUT="$(node "$RUNNER_DIR/lib/budget-admission.mjs" check --kind decompose 2>&1)"; rc=$?
[ "$rc" = 3 ] && ok "C1: no cap → refused (exit 3)" || fail "C1: no cap rc=$rc: $OUT"
has "$OUT" "refuses to start without a dollar cap" && has "$OUT" "GAFFER_DAILY_BUDGET_USD (try 5)" \
  && ok "C1: the refusal carries the live run's hint" || fail "C1: reason: $OUT"
GAFFER_DAILY_BUDGET_USD=5 node "$RUNNER_DIR/lib/budget-admission.mjs" check >/dev/null 2>&1 && ok "C1: a daily cap → admitted" || fail "C1: daily cap refused"
GAFFER_BUDGET_USD=5 node "$RUNNER_DIR/lib/budget-admission.mjs" check >/dev/null 2>&1 && ok "C1: a lifetime cap → admitted" || fail "C1: lifetime cap refused"
printf '{"GAFFER_DAILY_BUDGET_USD":"5"}' > "$DATA/settings.json"
node "$RUNNER_DIR/lib/budget-admission.mjs" check >/dev/null 2>&1 && ok "C1: a cap in settings.json → admitted" || fail "C1: settings cap refused"
printf '{}' > "$DATA/settings.json"
GAFFER_ALLOW_UNCAPPED=1 node "$RUNNER_DIR/lib/budget-admission.mjs" check >/dev/null 2>&1 && ok "C1: GAFFER_ALLOW_UNCAPPED=1 (environment) → admitted" || fail "C1: the opt-out refused"
printf '{"GAFFER_ALLOW_UNCAPPED":"1"}' > "$DATA/settings.json"
node "$RUNNER_DIR/lib/budget-admission.mjs" check >/dev/null 2>&1 && fail "C1: GAFFER_ALLOW_UNCAPPED in settings.json lifted the cap" || ok "C1: GAFFER_ALLOW_UNCAPPED in settings.json is ignored"
printf '{}' > "$DATA/settings.json"
GAFFER_DAILY_BUDGET_USD=0 node "$RUNNER_DIR/lib/budget-admission.mjs" check >/dev/null 2>&1 && fail "C1: a 0 cap admitted" || ok "C1: a 0 cap is no cap → refused"

echo "== C2. the planning launchers refuse before spawning =="
rm -f "$INV"
OUT="$(echo '{"brief":"a todo app"}' | _t 120 node "$RUNNER_DIR/bin/decompose.mjs" 2>/dev/null | tail -n1)"
[ "$(calls)" = 0 ] && has "$OUT" "without a dollar cap" && ok "C2: decompose (Plan a build): no spawn, says why" || fail "C2: decompose calls=$(calls) out=$OUT"
node -e '
const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1]);
db.exec("CREATE TABLE repositories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, local_path TEXT, default_branch TEXT NOT NULL DEFAULT '"'"'main'"'"'); CREATE TABLE tickets (id TEXT PRIMARY KEY, number INTEGER, title TEXT, status TEXT NOT NULL, updated_at TEXT); CREATE TABLE ticket_repos (ticket_id TEXT NOT NULL, repo_id TEXT NOT NULL);");
db.prepare("INSERT INTO repositories (id,name,local_path) VALUES (?,?,?)").run("r1","demo",process.argv[2]);' "$WORK/po.sqlite" "$WORK" 2>/dev/null
rm -f "$INV"
OUT="$(DISPATCH_DB="$WORK/po.sqlite" DISPATCH_PRODUCT_OWNER_REPO=demo _t 120 node "$RUNNER_DIR/bin/product-owner-run.mjs" 2>/dev/null | tail -n1)"
[ "$(calls)" = 0 ] && has "$OUT" "without a dollar cap" && ok "C2: product owner (Suggest work): no spawn, says why" || fail "C2: product owner calls=$(calls) out=$OUT"
rm -f "$INV"
OUT="$(echo '{"brief":"a todo app"}' | _t 120 node "$RUNNER_DIR/bin/spec-author.mjs" 2>/dev/null | tail -n1)"
[ "$(calls)" = 0 ] && has "$OUT" "without a dollar cap" && ok "C2: spec author: no spawn, says why" || fail "C2: spec author calls=$(calls) out=$OUT"

echo "== C3. the worker seams =="
export RUNNER_DIR
for kind in tester merge-resolver onboarding-analysis; do
  rm -f "$INV"
  R="$(K="$kind" node --input-type=module -e '
    const W = await import(process.env.RUNNER_DIR + "/lib/worker.mjs");
    const r = W.deliver({ bin: process.env.CLAUDE_BIN, argv: ["-p", "x"], cwd: process.cwd(), timeoutMs: 10000, env: {}, kind: process.env.K });
    process.stdout.write(String(r.status) + " " + String(r.budgetRefused));' 2>/dev/null)"
  [ "$R" = "77 true" ] && [ "$(calls)" = 0 ] && ok "C3: Worker.deliver(kind=$kind) with no cap: status 77, no spawn" || fail "C3: Worker.deliver($kind): $R calls=$(calls)"
done
SH_OUT="$(
  # shellcheck source=../factory.config.sh
  source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
  export GAFFER_DATA="$DATA" CLAUDE_BIN="$WORK/claude" GAFFER_STRICT_REQUIRE=0 STRICT_MODE=0; unset GAFFER_ALLOW_UNCAPPED
  GAFFER_LOG="$WORK/log"; rm -f "$INV"; printf '{}' > "$WORK/mcp.json"
  GAFFER_LAUNCH_KIND=review worker_deliver "$WORK" "prompt" "" "$WORK/mcp.json" "$WORK/out.json" 2>"$WORK/err"; echo "rc=$? calls=$(calls) $(tr '\n' ' ' < "$WORK/err")"
)"
case "$SH_OUT" in *"rc=77 calls=0"*"without a dollar cap"*) ok "C3: worker_deliver (review) with no cap: rc 77, no spawn, the reason named" ;; *) fail "C3: worker_deliver: $SH_OUT" ;; esac

echo "== C4. onboarding with no cap falls back to the mechanical digest =="
if [ -f "$ROOT/packages/crew/dist/cli/index.js" ] && [ -f "$ROOT/packages/dispatch/dist/cli/index.js" ]; then
  mkdir -p "$WORK/repo"
  ( cd "$WORK/repo" && git init -q -b main && printf '{"name":"capdemo","scripts":{"test":"node -e 0"}}\n' > package.json \
    && printf 'export const a = 1;\n' > index.js \
    && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init )
  rm -f "$INV"
  OB="$(
    export GAFFER_DATA_DIR="$WORK/crew-data" GAFFER_PLAN_MODEL=stub
    # shellcheck source=../factory.config.sh
    source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
    export GAFFER_DATA="$DATA" CLAUDE_BIN="$WORK/claude"; unset GAFFER_ALLOW_UNCAPPED
    wg init >/dev/null 2>&1; lg init >/dev/null 2>&1
    ( cd "$WORK" && _t 240 bash "$RUNNER_DIR/gaffer" onboard "$WORK/repo" 2>&1 ); echo "rc=$?"
  )"
  OB="$(printf '%s' "$OB" | sed 's/\x1b\[[0-9;]*m//g')"
  has "$OB" "rc=0" && ok "C4: the onboard succeeds" || fail "C4: onboard: $(printf '%s' "$OB" | tail -5)"
  [ "$(calls)" = 0 ] && ok "C4: no model call was made" || fail "C4: $(calls) model call(s)"
  printf '%s\n' "$OB" | grep -i 'analysis' | sed 's/^/    | /'
  has "$OB" "model analysis skipped" && has "$OB" "dollar cap" && ok "C4: the summary says the analysis was skipped for the missing cap" || fail "C4: summary: $(printf '%s' "$OB" | grep -i 'analysis')"
else
  echo "  SKIP C4: crew or dispatch not built"
fi

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
