#!/usr/bin/env bash
# =====================================================================
# ACCESS BOUNDARY — a ticket with no WRITE repo is never delivered into a
# read-only repo, and a ticket that cannot be delivered does not wedge the queue.
# ---------------------------------------------------------------------
# Two defects this pins (both reachable from the dashboard's ticket panel):
#   1. A ticket whose only linked repo is `read` produced an EMPTY write-root list
#      that tick.sh mistook for a legacy (pre-boundary) ticket and fell back to
#      "write into repositories[0]" — a worktree + branch + hook-allowed writes in a
#      repo the operator had marked read-only. Now: park → blocked (no_write_repo),
#      skip, no worktree.
#   2. A ticket linked (access=write) to a repo with no local path was released back
#      to `ready` WITHOUT being skipped, so the next tick re-claimed the same head
#      ticket forever. Now: parked → blocked (no_local_repo_path, not no_write_repo —
#      its access already is write) AND skipped.
#   3. A ticket with NO repo linked at all (the default solo_loose pack readies it
#      with only a REPO_RECOMMENDED warning) was released back to `ready`; the skip
#      file is per loop run, so every later run re-claimed and re-released it. Now:
#      parked → blocked (no_write_repo), and a NEW run (skip file cleared, as
#      loop.sh does) claims nothing.
# Real dispatch dist + real tick.sh + a stub worker that must NEVER be invoked.
# Run: bash runner/test/boundary-no-write-repo.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }
for f in packages/dispatch/dist/cli/index.js packages/memory/dist/bin/memory.js; do
  [ -f "$ROOT/$f" ] || { echo "SKIP: $f not built (run pnpm -r build)"; exit 0; }
done

PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/boundary-nowrite.XXXXXX")"; WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/data" "$WORK/bin"

R="$WORK/readonly-repo"; mkdir -p "$R"
( cd "$R" && git init -q -b main && printf '{ "name": "ro", "private": true, "scripts": { "test": "node -e 0" } }\n' > package.json \
  && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init )

# A stub worker that records every invocation — the assertion is that it is never called.
cat > "$WORK/bin/claude" <<'STUB'
#!/usr/bin/env bash
printf 'INVOKED cwd=%s\n' "$PWD" >> "${GAFFER_DATA:-/tmp}/stub-claude.log"
printf '{"type":"result","subtype":"success","is_error":false,"result":"should not run"}\n'
STUB
chmod +x "$WORK/bin/claude"

export GAFFER_DATA="$WORK/data" CLAUDE_BIN="$WORK/bin/claude" CLAUDE_FLAGS="" \
       GAFFER_TICK_TIMEOUT=60 GAFFER_MAX_TURNS=10 GAFFER_CARD_MODEL=stub GAFFER_PLAN_MODEL=stub GAFFER_IMPL_MODEL=stub \
       REVIEW_MODE=human DRY_RUN=0 GAFFER_MAINTENANCE=0
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
wg init >/dev/null 2>&1; lg init >/dev/null 2>&1
wg repo add -n readonly-repo --path "$R" --branch main --test "node -e 0" >/dev/null 2>&1
wg repo add -n pathless-repo --remote "https://example.invalid/pathless.git" --branch main >/dev/null 2>&1 \
  || wg repo add -n pathless-repo --branch main >/dev/null 2>&1

run_tick() { ( cd "$RUNNER_DIR" && bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep '^TICK_RESULT=' ; }
st() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.status'; }

echo "== 1. only READ access on the linked repo → parked, skipped, no worktree, no agent =="
A="$(wg ticket create -t "Read-only scoped ticket" -d "must not be delivered into a read-only repo" 2>/dev/null | jget 'd.ticket.number')"
wg ac add "$A" -t "nothing happens" >/dev/null 2>&1
wg ticket repo-access set "$A" readonly-repo --access read --relation confirmed >/dev/null 2>&1
wg ticket ready "$A" >/dev/null 2>&1
[ "$(st "$A")" = "ready" ] && ok "#$A is ready with a single READ-access repo" || fail "#$A not ready: $(st "$A")"
OUT1="$(run_tick)"
grep -q '^TICK_RESULT=no_work$' <<<"$OUT1" && ok "tick → no_work (nothing deliverable)" || fail "tick result: $OUT1"
grep -q "has no WRITE repo" "$GAFFER_DATA/factory.log" && ok "tick logs the refusal (no WRITE repo)" || fail "no 'no WRITE repo' log line"
[ "$(st "$A")" = "blocked" ] && ok "#$A parked → blocked for a human" || fail "#$A ended '$(st "$A")' (want blocked)"
grep -q "no_write_repo" "$GAFFER_DATA/factory.log" && ok "the park names reason_code no_write_repo" || fail "no no_write_repo in the park log"
[ ! -e "$GAFFER_DATA/stub-claude.log" ] && ok "the agent was never invoked" || fail "agent invoked: $(cat "$GAFFER_DATA/stub-claude.log")"
[ -z "$(ls -A "$GAFFER_DATA/worktrees" 2>/dev/null)" ] && ok "no delivery worktree was created" || fail "worktrees created: $(ls "$GAFFER_DATA/worktrees")"
[ "$(git -C "$R" branch --list 'gaffer/*' | wc -l | tr -d ' ')" = "0" ] && ok "no gaffer/ branch in the read-only repo" || fail "branch created in read-only repo: $(git -C "$R" branch --list 'gaffer/*')"
grep -qx "$A" "$GAFFER_DATA/.failed-tickets" 2>/dev/null && ok "#$A is in the skip file for the rest of this run" || fail "#$A not skipped (.failed-tickets: $(cat "$GAFFER_DATA/.failed-tickets" 2>/dev/null))"

echo "== 2. linked repo has no local path → released AND skipped; the next tick moves on =="
B="$(wg ticket create -t "Pathless repo ticket" -d "repo registered without a checkout" 2>/dev/null | jget 'd.ticket.number')"
wg ac add "$B" -t "nothing happens" >/dev/null 2>&1
wg ticket repo-access set "$B" pathless-repo --access write --relation confirmed >/dev/null 2>&1
wg ticket ready "$B" >/dev/null 2>&1
OUT2="$(run_tick)"
grep -q '^TICK_RESULT=no_work$' <<<"$OUT2" && ok "tick → no_work for the pathless ticket" || fail "tick result: $OUT2"
grep -q "ticket #$B has no local repo path" "$GAFFER_DATA/factory.log" && ok "tick logs that #$B's write repo has no local path" || fail "no 'has no local repo path' log line for #$B"
grep -q "no_local_repo_path" <<<"$(grep -E "ticket #$B has no local repo path" "$GAFFER_DATA/factory.log")" \
  && ok "#$B's park names reason_code no_local_repo_path" || fail "#$B's park log does not name no_local_repo_path"
# Its access IS write: the false "read/test/context-only … set its access to write"
# reason (an unblock just re-parks it) must not be what the human is told.
! grep -q "#$B has no WRITE repo" "$GAFFER_DATA/factory.log" \
  && ok "#$B is not misreported as having no WRITE repo" || fail "#$B misreported as no_write_repo: $(grep "#$B has no WRITE repo" "$GAFFER_DATA/factory.log")"
grep -q "register its path" <<<"$(grep -E "#$B → blocked" "$GAFFER_DATA/factory.log")" \
  && ok "#$B's human-queue reason says to register its path or clone it" || fail "#$B's release reason lacks the register/clone instruction"
grep -qx "$B" "$GAFFER_DATA/.failed-tickets" 2>/dev/null && ok "#$B is skipped (no re-claim loop)" || fail "#$B not in the skip file"
[ "$(st "$B")" = "blocked" ] && ok "#$B parked → blocked for a human" || fail "#$B ended '$(st "$B")' (want blocked)"
# With both head tickets skipped, another tick must not touch them again.
BEFORE="$(grep -c 'claimed #' "$GAFFER_DATA/factory.log")"
OUT3="$(run_tick)"
AFTER="$(grep -c 'claimed #' "$GAFFER_DATA/factory.log")"
grep -q '^TICK_RESULT=no_work$' <<<"$OUT3" && [ "$AFTER" = "$BEFORE" ] \
  && ok "a further tick claims nothing (queue not wedged)" \
  || fail "further tick re-claimed (claims before=$BEFORE after=$AFTER, result=$OUT3)"
[ ! -e "$GAFFER_DATA/stub-claude.log" ] && ok "the agent was never invoked across all ticks" || fail "agent invoked"

echo "== 3. NO repo linked at all → blocked (no_write_repo); a NEW run claims nothing =="
C="$(wg ticket create -t "Repo-less ticket" -d "no repo linked" 2>/dev/null | jget 'd.ticket.number')"
wg ac add "$C" -t "nothing happens" >/dev/null 2>&1
READY_OUT="$(wg ticket ready "$C" 2>&1)"
[ "$(st "$C")" = "ready" ] && grep -q REPO_RECOMMENDED <<<"$READY_OUT" \
  && ok "#$C readies under the default pack with a REPO_RECOMMENDED warning" \
  || fail "#$C did not ready with a warning (status $(st "$C"))"
run_tick >/dev/null
[ "$(st "$C")" = "blocked" ] && ok "#$C parked → blocked, not released to ready" || fail "#$C ended '$(st "$C")' (want blocked)"
grep -q "#$C has no WRITE repo (no repo is linked" "$GAFFER_DATA/factory.log" \
  && ok "the log says no repo is linked" || fail "no 'no repo is linked' log line for #$C"
# A new loop run clears the per-run skip file; the parked ticket must stay put.
rm -f "$GAFFER_DATA/.failed-tickets"
BEFORE="$(grep -c 'claimed #' "$GAFFER_DATA/factory.log")"
OUT4="$(run_tick)"
AFTER="$(grep -c 'claimed #' "$GAFFER_DATA/factory.log")"
grep -q '^TICK_RESULT=no_work$' <<<"$OUT4" && [ "$AFTER" = "$BEFORE" ] \
  && ok "a fresh run (skip file cleared) claims nothing — no claim/release spin" \
  || fail "fresh run re-claimed a parked ticket (claims before=$BEFORE after=$AFTER, result=$OUT4)"
[ ! -e "$GAFFER_DATA/stub-claude.log" ] && ok "the agent was never invoked for the repo-less ticket" || fail "agent invoked"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
