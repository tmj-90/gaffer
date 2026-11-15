#!/usr/bin/env bash
# =====================================================================
# A LANDING THAT IS NOT MARKED DONE IS NOT A MERGE (audit finding 5).
# ---------------------------------------------------------------------
# When `wg ticket mark-merged` failed after a clean landing, lib/land.sh logged it, ran
# the post-merge digest / feature step, deleted the delivery branch and returned 0: the
# merge lane counted it landed and the tick said `merged` while the ticket was still
# ready_for_merge (its dependents blocked). bin/merge-ticket.mjs had the same shape.
#
#   L1  Poll path (gaffer_land_delivery), mark-merged fails once: non-zero (held), no
#       digest step, the delivery branch kept, the ticket still ready_for_merge
#   L2  the next pass heals it: rc 0, done, branch deleted, main not merged twice
#   M1  gaffer merge (merge-ticket.mjs), mark-merged fails once: exit 4, branch kept,
#       still ready_for_merge
#   M2  the next gaffer merge heals it: done
#
# A dispatch CLI wrapper fails `ticket mark-merged` while $D/fail-mark exists.
# Run: bash test/land-mark-merged-failure.test.sh
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
WORK="$(gaffer_test_tmpdir land-mark-merged)" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT
mkdir -p "$WORK/bin"
printf '#!/bin/sh\nexit 1\n' > "$WORK/bin/claude"; chmod +x "$WORK/bin/claude"
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
export CLAUDE_BIN="$WORK/bin/claude" GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 LC_ALL=C \
  GAFFER_DOD_SANDBOX=0 GAFFER_MEMORY_INDEX=0 GAFFER_CONFLICT_RESOLVER=0 \
  DISPATCH_AUDIT_OFF=1 MEMORY_AUDIT_OFF=1

# The dispatch CLI, failing `ticket mark-merged` (once per fail-mark file) when asked.
cat > "$WORK/bin/dispatch-wrap.mjs" <<EOF
import { existsSync, rmSync } from "node:fs";
const f = process.env.FAIL_MARK;
if (f && existsSync(f) && process.argv.includes("mark-merged")) {
  rmSync(f);
  process.stderr.write("SQLITE_BUSY: database is locked\n");
  process.exit(1);
}
await import("$DISPATCH_JS");
EOF

D=""
wgd() { node "$DISPATCH_JS" --db "$D/data/dispatch.sqlite" "$@"; }
jf() { node "$RUNNER_DIR/lib/json-tool.mjs" expr "$1"; }
g() { git -C "$D/repoA" "$@"; }
status() { wgd ticket show 1 | jf 'd.ticket.status'; }
branch_kept() { g show-ref --verify --quiet refs/heads/gaffer/fx; }

# An approved ticket #1 over repoA, its delivery on gaffer/fx.
world() {
  D="$WORK/$1"
  mkdir -p "$D/home" "$D/tmp" "$D/data" "$D/repoA"
  export HOME="$D/home" TMPDIR="$D/tmp" GAFFER_DATA="$D/data" DISPATCH_DB="$D/data/dispatch.sqlite" \
    MEMORY_DB="$D/data/memory.sqlite" FAIL_MARK="$D/fail-mark" DISPATCH_CLI="$WORK/bin/dispatch-wrap.mjs"
  wgd init >/dev/null
  g init -q -b main; g config user.name F; g config user.email f@example.invalid
  echo base > "$D/repoA/base.txt"; g add base.txt; g commit -qm baseline
  wgd repo add -n repoA --path "$D/repoA" --branch main --test "true" >/dev/null
  wgd ticket create -t "Change" --description "d" --policy team_light --risk low >/dev/null
  AC="$(wgd ac add 1 -t "AC" | jf 'd.ac_id')"
  wgd ticket repo-access set 1 repoA --access write --relation confirmed >/dev/null
  wgd ticket ready 1 >/dev/null
  AGENT="$(wgd agent register -n fx --max-risk high | jf 'd.agent.id')"
  TOKEN="$(wgd claim-ticket 1 --agent "$AGENT" --ttl 900 | jf 'd.claimToken')"
  g switch -qc gaffer/fx; echo change > "$D/repoA/d.txt"; g add d.txt; g commit -qm change
  PIN="$(g rev-parse HEAD)"; g switch -q main
  wgd ticket repo-delivery record 1 repoA --branch gaffer/fx >/dev/null
  wgd evidence 1 --token "$TOKEN" --type test_output --summary s --ac "$AC" >/dev/null
  wgd submit 1 --token "$TOKEN" --reason r >/dev/null
  wgd delivery-artifact 1 --branch gaffer/fx --diff d --as system >/dev/null
  wgd review approve 1 --reviewer op --commit "repoA=$PIN" >/dev/null
}

poll_land() {
  ( cd "$D" || exit 2
    log() { printf '%s\n' "$*" >> "$D/land.log"; }
    wg() { node "$DISPATCH_CLI" --db "$DISPATCH_DB" "$@"; }
    jget() { node "$RUNNER_DIR/lib/json-tool.mjs" expr "$1"; }
    gaffer_refresh_cards() { :; }
    _gaffer_flag_on() { case "${1:-}" in 1|true|yes|on) return 0 ;; *) return 1 ;; esac; }
    export RUNNER_DIR GAFFER_DIGEST_DISABLE=0
    # The digest step runs for real when reached (GAFFER_DIGEST_DISABLE=0); its log line
    # ("digest/feature ...") says whether it ran.
    # shellcheck source=../lib/automerge.sh
    source "$RUNNER_DIR/lib/automerge.sh"
    # shellcheck source=../lib/land.sh
    source "$RUNNER_DIR/lib/land.sh"
    gaffer_land_delivery 1 "$D/repoA" gaffer/fx main "$(wg ticket show 1)" MERGE ) > "$D/poll.out" 2>&1
}

echo "== L1: Poll path, mark-merged fails once =="
world L
: > "$D/fail-mark"
MAIN0="$(g rev-parse main)"
poll_land; rc=$?
[ "$rc" -ne 0 ] && ok "L1 the landing returns non-zero (rc $rc), not merged" || fail "L1 rc 0 although mark-merged failed: $(tail -3 "$D/land.log")"
[ "$(status)" = ready_for_merge ] && ok "L1 the ticket is still ready_for_merge" || fail "L1 status $(status)"
branch_kept && ok "L1 the delivery branch is kept" || fail "L1 the delivery branch was deleted"
grep -q "digest/feature" "$D/land.log" && fail "L1 the digest / feature step ran: $(grep digest "$D/land.log")" \
  || ok "L1 the digest / feature step did not run"
grep -q "LANDED but NOT marked done" "$D/land.log" && ok "L1 the log says landed but not marked done" || fail "L1 log: $(tail -2 "$D/land.log")"
[ "$(g rev-parse main)" != "$MAIN0" ] && ok "L1 main carries the landing" || fail "L1 main did not move"
MAIN1="$(g rev-parse main)"

echo "== L2: the next pass marks it done =="
export GAFFER_DIGEST_DISABLE=1
poll_land; rc=$?
[ "$rc" -eq 0 ] && [ "$(status)" = done ] && ok "L2 the next pass heals it (rc 0, done)" || fail "L2 rc=$rc status=$(status): $(tail -3 "$D/land.log")"
[ "$(g rev-parse main)" = "$MAIN1" ] && ok "L2 main was not merged again" || fail "L2 main moved again"
branch_kept && fail "L2 the merged branch is still there" || ok "L2 the merged branch is deleted once done"

echo "== M1: gaffer merge, mark-merged fails once =="
world M
: > "$D/fail-mark"
( cd "$D" && GAFFER_DIGEST_DISABLE=1 bash "$RUNNER_DIR/gaffer" merge 1 ) > "$D/merge.log" 2>&1; rc=$?
[ "$rc" -eq 4 ] && ok "M1 gaffer merge exits 4 (held), not success" || fail "M1 exit $rc: $(tail -3 "$D/merge.log")"
[ "$(status)" = ready_for_merge ] && ok "M1 the ticket is still ready_for_merge" || fail "M1 status $(status)"
branch_kept && ok "M1 the delivery branch is kept" || fail "M1 the delivery branch was deleted"
grep -q "LANDED but NOT marked done" "$D/merge.log" && ok "M1 it says landed but not marked done" || fail "M1 log: $(tail -3 "$D/merge.log")"

echo "== M2: the next gaffer merge marks it done =="
( cd "$D" && GAFFER_DIGEST_DISABLE=1 bash "$RUNNER_DIR/gaffer" merge 1 ) > "$D/merge2.log" 2>&1; rc=$?
[ "$(status)" = done ] && ok "M2 the next merge heals it (done, exit $rc)" || fail "M2 rc=$rc status=$(status): $(tail -4 "$D/merge2.log")"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "land-mark-merged-failure: ALL $PASS checks passed"; exit 0
else echo "land-mark-merged-failure: ${#FAILURES[@]} FAILED (of $((PASS + ${#FAILURES[@]})))"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1; fi
