#!/usr/bin/env bash
# =====================================================================
# The CLI names the next command: approve, status's waiting list, recent ticks.
# ---------------------------------------------------------------------
#   1  `gaffer approve N --reviewer R` with no terminal prints the re-run command WITH
#      --reviewer R (it used to drop it, so the re-run recorded $USER);
#   2  a successful approve prints one line (ticket, reviewer, commits, new status) and
#      `next: gaffer merge N` instead of the raw JSON; a refusal passes through, exit ≠ 0;
#   3  `gaffer status` lists each waiting ticket with its command: approve (in review),
#      merge (approved), ticket show (blocked), ticket continue (paused);
#   4  recent ticks show PARKED / submitted for a delivery instead of the bare
#      "finished (rc=0)" that preceded it; a tick with no outcome line keeps it.
# Hermetic: a fake dispatch CLI (DISPATCH_DIR) and stubbed status seams.
# Run: bash runner/test/next-step-hints.test.sh   (bash 3.2 safe)
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
has()  { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/next-step-hints.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT
export GAFFER_DATA="$WORK/data"; mkdir -p "$GAFFER_DATA"
unset NO_COLOR

# A fake dispatch CLI: `ticket diff`, `review approve` (5 approves, 6 is refused).
FD="$WORK/fakedispatch"; mkdir -p "$FD/dist/cli"
cat > "$FD/dist/cli/index.js" <<'JS'
const a = process.argv.slice(2).filter((x, i, all) => x !== "--db" && all[i - 1] !== "--db");
const fs = require("node:fs");
if (a[0] === "ticket" && a[1] === "diff" && a.includes("--heads")) { console.log("demo=abc123def4567890abc123def4567890abc12345"); process.exit(0); }
if (a[0] === "ticket" && a[1] === "diff") { console.log(JSON.stringify({ repos: [{ repo: "demo", files: 1, additions: 2, deletions: 0 }] })); process.exit(0); }
if (a[0] === "review" && a[1] === "approve") {
  fs.appendFileSync(process.env.CALLS, a.join(" ") + "\n");
  if (a[2] === "6") { console.error("error: stale_revision: demo moved past the reviewed commit"); process.exit(1); }
  console.log(JSON.stringify({ ok: true, status: "ready_for_merge", event: "e1", policy: {} }));
  process.exit(0);
}
process.exit(0);
JS
export CALLS="$WORK/calls"
ap() { RC=0; OUT="$(env DISPATCH_DIR="$FD" bash "$RUNNER_DIR/gaffer" approve "$@" 2>&1 </dev/null)" || RC=$?; }

echo "== 1: no terminal: the re-run command keeps --reviewer =="
ap 5 --reviewer "ana b"
[ "$RC" -eq 2 ] && ok "exit 2 (nothing approved without a terminal)" || fail "rc=$RC: $OUT"
has "$OUT" "gaffer approve 5 --reviewer ana\\ b --commit demo=abc123def4567890abc123def4567890abc12345" \
  && ok "the hint keeps --reviewer (shell-quoted) and adds the commits" || fail "hint: $OUT"
[ ! -s "$CALLS" ] && ok "nothing was approved" || fail "approve ran: $(cat "$CALLS")"

echo "== 2: a successful approve: one line + the next command =="
ap 5 --reviewer ana --commit demo=abc123def4567890abc123def4567890abc12345
[ "$RC" -eq 0 ] && ok "exit 0" || fail "rc=$RC: $OUT"
has "$OUT" "✓ approved ticket 5 as ana (covers demo=abc123def456) → ready_for_merge" && ok "one-line summary" || fail "summary: $OUT"
has "$OUT" "next: gaffer merge 5" && ok "names the next command" || fail "no next command: $OUT"
has "$OUT" '"ok":true' && fail "raw JSON printed: $OUT" || ok "no raw JSON"
has "$(cat "$CALLS")" "review approve 5 --reviewer ana --commit demo=abc123def4567890abc123def4567890abc12345" && ok "the approval carried reviewer + commit" || fail "calls: $(cat "$CALLS")"
ap 6 --commit demo=abc123def4567890abc123def4567890abc12345
[ "$RC" -eq 1 ] && has "$OUT" "stale_revision" && ! has "$OUT" "next: gaffer merge" && ok "a refusal passes through with its exit code, no next step" || fail "refusal rc=$RC: $OUT"

echo "== 3: status lists each waiting ticket with its command =="
cat > "$WORK/list.sh" <<'SH'
#!/usr/bin/env bash
case "$1" in
  in_review) echo '[{"number":4,"title":"Add login"}]' ;;
  ready_for_merge) echo '[{"number":7,"title":"Fix footer"}]' ;;
  blocked) echo '[{"number":9,"title":"Flaky tests"}]' ;;
  paused) echo '[{"number":11,"title":"Big refactor"}]' ;;
  *) echo '[]' ;;
esac
SH
printf '#!/usr/bin/env bash\necho Healthy.\n' > "$WORK/doc.sh"
printf '#!/usr/bin/env bash\necho %s\n' "'{\"ticketsByStatus\":{\"in_review\":1,\"ready_for_merge\":1,\"blocked\":1,\"paused\":1,\"ready\":0}}'" > "$WORK/stats.sh"
printf '#!/usr/bin/env bash\necho "[]"\n' > "$WORK/empty.sh"
chmod +x "$WORK"/*.sh
cat > "$WORK/factory.log" <<'LOG'
2026-01-01T10:00:00 ready=2 → delivering #3 ('Parked one') in /r [stack=node]
2026-01-01T10:05:00 delivery tick for #3 finished (rc=0)
2026-01-01T10:05:09 delivery PARKED for #3 — tests not met (rework_exhausted, 3/3); worktree removed, branch gaffer/ticket-3 PRESERVED, VISIBLE in blocked
2026-01-01T10:06:00 ready=1 → delivering #4 ('Add login') in /r [stack=node]
2026-01-01T10:09:00 delivery tick for #4 finished (rc=0)
2026-01-01T10:09:30 submitted #4 for review (→ in_review) — runner-owned submit
2026-01-01T10:10:00 ready=1 → delivering #5 ('Still going') in /r [stack=node]
2026-01-01T10:12:00 delivery tick for #5 finished (rc=0)
LOG
OUT="$(env WG_DOCTOR_CMD="$WORK/doc.sh" FG_DOCTOR_CMD="$WORK/doc.sh" LG_DOCTOR_CMD="$WORK/doc.sh" STATS_CMD="$WORK/stats.sh" \
  REPOS_CMD="$WORK/empty.sh" HUMAN_QUEUE_CMD="$WORK/empty.sh" RESUME_REQ_CMD="$WORK/empty.sh" STATUS_TICKETS_CMD="$WORK/list.sh" \
  GAFFER_LOG="$WORK/factory.log" STATUS_TICKS=10 DASHBOARD_PROBE_URL="http://127.0.0.1:9/healthz" bash "$RUNNER_DIR/status.sh" 2>&1)"
has "$OUT" "#4 Add login  →  gaffer approve 4" && ok "in review → gaffer approve N" || fail "approve line: $OUT"
has "$OUT" "#7 Fix footer  →  gaffer merge 7" && ok "approved → gaffer merge N" || fail "merge line missing"
has "$OUT" "#9 Flaky tests  →  gaffer wg ticket show 9" && ok "blocked → gaffer wg ticket show N" || fail "blocked line missing"
has "$OUT" "#11 Big refactor  →  gaffer wg ticket continue 11" && ok "paused → gaffer wg ticket continue N" || fail "paused line missing"

echo "== 4: recent ticks show the outcome =="
has "$OUT" "delivery PARKED for #3" && ok "the PARKED line is shown" || fail "no PARKED line: $(printf '%s' "$OUT" | sed -n '/recent ticks/,$p')"
has "$OUT" "delivery tick for #3 finished" && fail "#3 still reads 'finished (rc=0)'" || ok "the parked delivery no longer reads 'finished (rc=0)'"
has "$OUT" "submitted #4 for review" && ! has "$OUT" "delivery tick for #4 finished" && ok "a submitted delivery shows 'submitted'" || fail "#4 outcome"
has "$OUT" "delivery tick for #5 finished (rc=0)" && ok "a delivery with no outcome yet keeps its 'finished' line" || fail "#5 line dropped"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "next-step-hints: ALL $PASS checks passed"; exit 0; fi
echo "next-step-hints: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
