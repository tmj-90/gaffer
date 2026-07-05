#!/usr/bin/env bash
# =====================================================================
# AFK DELIVERY-LOOP FIXES — two bugs that block unattended multi-ticket runs.
# ---------------------------------------------------------------------
# BUG 1 (HIGH) — reviewer deadlock. In REVIEW_MODE=agent, when ready tickets
#   exist but NONE are deliverable (e.g. all blocked by an unmet dependency
#   whose blocker is itself `in_review`), the delivery scan used to hit
#   `result no_work; exit 0` ~1900 lines BEFORE the agent-reviewer block, so the
#   blocker was never approved/merged and the chain deadlocked. The reviewer
#   block is now a function (_gaffer_agent_review_pass) invoked at BOTH the
#   normal end-of-tick site AND the "nothing deliverable" no_work juncture.
#     • Proven behaviourally by a DRY_RUN tick: ready is non-empty but skip-listed
#       (⇒ nothing deliverable) and an in_review ticket exists ⇒ the reviewer pass
#       is REACHED (DRY_RUN marker) and the tick reports `reviewed`, not `no_work`.
#     • Supervised (REVIEW_MODE=human) stays byte-identical: same setup yields
#       `no_work` with NO reviewer marker (the guarded call is skipped).
#
# BUG 2 (MED) — hygiene teardown leaves a broken symlink. `git worktree remove
#   --force` deregisters a worktree but REFUSES to delete untracked residue — the
#   `.claude/` the skill-mount installs, whose `.claude/skills` symlink is left
#   DANGLING once gaffer_skills_mount_cleanup drops the mount target. That residue
#   then trips the post-teardown hygiene gate (broken symlink: .claude/skills).
#   gaffer_cleanup_worktrees now `rm -rf`s the worktree path after the git remove.
#     • Proven with REAL git + the REAL skills-mount / hygiene libs.
#
# Hermetic: uses a stub dispatch CLI + real git; never invokes `claude -p`.
# Run: bash runner/test/afk-delivery-loop.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
TICK="$RUNNER_DIR/tick.sh"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

command -v node    >/dev/null 2>&1 || { echo "SKIP: node required";    exit 0; }
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 required"; exit 0; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/afk-delivery-loop.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT

mk_repo() {
  local repo="$1"
  git init -q -b main "$repo"
  git -C "$repo" config user.email gaffer@test
  git -C "$repo" config user.name gaffer-test
  printf 'export const x = 1;\n' > "$repo/index.ts"
  git -C "$repo" add -A && git -C "$repo" commit -q -m base
}

# ── Stub dispatch CLI — returns ONE ready ticket (#5) and ONE in_review (#3) ────
# The ready ticket models "B depends on A": it is `ready` but non-deliverable this
# run. The in_review ticket models the blocker A awaiting review.
DISPATCH_DIR="$WORK/dispatch"
mkdir -p "$DISPATCH_DIR/dist/cli"
cat > "$DISPATCH_DIR/dist/cli/index.js" <<'JS'
const a = process.argv.slice(2);
const has = (...t) => t.every((x) => a.includes(x));
const out = (o) => process.stdout.write(JSON.stringify(o));
const repo = process.env.WG_REPO || "";
const branch = process.env.WG_BRANCH || "gaffer/ticket-3-blocker";
if (has("agent", "register")) out({ agent: { id: "stub-agent" } });
else if (has("ticket", "resume-requested")) out([]);
else if (has("ticket", "list", "-s", "ready")) out([{ number: 5, title: "Dependent feature B" }]);
else if (has("ticket", "list", "-s", "in_review")) out([{ number: 3, title: "Blocker feature A" }]);
else if (has("ticket", "list")) out([]);
else if (has("ticket", "show", "3"))
  out({
    ticket: { title: "Blocker feature A", status: "in_review", branch_name: branch },
    repositories: [{ local_path: repo, default_branch: "main", stack: "node", name: "repo" }],
  });
else if (has("ticket", "show", "5"))
  out({
    ticket: { title: "Dependent feature B", status: "ready" },
    repositories: [{ local_path: repo, default_branch: "main", stack: "node", name: "repo" }],
  });
else out({});
JS

REPO="$WORK/repo"; mk_repo "$REPO"
git -C "$REPO" branch gaffer/ticket-3-blocker   # the blocker's delivered branch exists

# run_tick <review_mode>  → echoes combined stdout+stderr; seeds the skip file so the
# only ready ticket (#5) is filtered out ⇒ the candidate scan yields NOTHING deliverable.
run_tick() {
  local review_mode="$1"
  local data="$WORK/data-$review_mode"; rm -rf "$data"; mkdir -p "$data"
  printf '5\n' > "$data/.failed-tickets"    # #5 already "failed delivery this run"
  WG_REPO="$REPO" WG_BRANCH="gaffer/ticket-3-blocker" \
  RUNNER_DIR="$RUNNER_DIR" GAFFER_HOME="$WORK" GAFFER_DATA="$data" \
  DISPATCH_DIR="$DISPATCH_DIR" CREW_DIR="$WORK/crew-absent" \
  DRY_RUN=1 REVIEW_MODE="$review_mode" GAFFER_PAUSE_ON_CAP=1 \
  CLARIFY_DRAFTS_WHEN_IDLE=0 \
  bash "$TICK" 2>&1
}

echo "== BUG 1: reviewer pass IS reached at the no_work juncture (REVIEW_MODE=agent) =="
OUT_AGENT="$(run_tick agent || true)"
printf '%s\n' "$OUT_AGENT" | grep -q "all ready tickets failed delivery this run" \
  && ok "reached the 'nothing deliverable' no_work juncture (ready non-empty, none claimable)" \
  || fail "did not reach the no_work juncture — test setup wrong: $(printf '%s' "$OUT_AGENT" | tail -3 | tr '\n' '|')"
printf '%s\n' "$OUT_AGENT" | grep -q "would run a reviewer agent on #3" \
  && ok "agent reviewer INVOKED from the no_work juncture (blocker #3 reviewed → chain can unblock)" \
  || fail "reviewer NOT invoked at no_work juncture — deadlock persists: $(printf '%s' "$OUT_AGENT" | tail -5 | tr '\n' '|')"
printf '%s\n' "$OUT_AGENT" | grep -q "TICK_RESULT=reviewed" \
  && ok "tick reports 'reviewed' (progress made), not the dead-end 'no_work'" \
  || fail "tick did not report 'reviewed' (got: $(printf '%s' "$OUT_AGENT" | grep -o 'TICK_RESULT=[a-z_]*' | tail -1))"
printf '%s\n' "$OUT_AGENT" | grep -q "TICK_RESULT=no_work" \
  && fail "tick STILL exited no_work — reviewer was skipped (deadlock)" \
  || ok "tick did NOT fall through to no_work (reviewer short-circuited it)"

echo "== BUG 1: supervised (REVIEW_MODE=human) is byte-identical — no reviewer, no_work =="
OUT_HUMAN="$(run_tick human || true)"
printf '%s\n' "$OUT_HUMAN" | grep -q "TICK_RESULT=no_work" \
  && ok "human mode still yields no_work at the juncture (unchanged)" \
  || fail "human mode changed — expected no_work (got: $(printf '%s' "$OUT_HUMAN" | grep -o 'TICK_RESULT=[a-z_]*' | tail -1))"
printf '%s\n' "$OUT_HUMAN" | grep -q "would run a reviewer agent" \
  && fail "human mode invoked the agent reviewer — supervised MUST stay untouched" \
  || ok "human mode never invokes the agent reviewer (guarded call skipped)"

echo "== BUG 1: structural wiring (grep-proof, deterministic) =="
DEFS="$(grep -c '^_gaffer_agent_review_pass() {' "$TICK" || true)"
[ "$DEFS" = "1" ] \
  && ok "_gaffer_agent_review_pass defined exactly once" \
  || fail "_gaffer_agent_review_pass defined $DEFS time(s) — expected 1"
# The no_work juncture must invoke the reviewer BEFORE the exit, guarded by REVIEW_MODE.
awk '/all ready tickets failed delivery this run/{f=1}
     f && /_gaffer_agent_review_pass/{g=1}
     f && /result no_work; exit 0/{print (g?"WIRED":"MISSING"); exit}' "$TICK" | grep -q WIRED \
  && ok "reviewer pass invoked between the 'nothing deliverable' log and 'result no_work; exit 0'" \
  || fail "reviewer pass NOT wired at the no_work juncture"
CALLS="$(grep -c '^[[:space:]]*_gaffer_agent_review_pass$' "$TICK" || true)"
[ "$CALLS" = "2" ] \
  && ok "_gaffer_agent_review_pass invoked at exactly 2 sites (no_work juncture + end-of-tick)" \
  || fail "_gaffer_agent_review_pass invoked $CALLS time(s) — expected 2"
# The extracted block must still carry its load-bearing bits (byte-preservation).
for needle in "result reviewed; exit 0" "would run a reviewer agent" "MERGE_ON_AGENT_REVIEW" "gaffer_skills_mount_cleanup \"review-\$RNUM\""; do
  grep -qF "$needle" "$TICK" \
    && ok "reviewer block preserved: '$needle'" \
    || fail "reviewer block lost: '$needle'"
done

# ──────────────────────────────────────────────────────────────────────────────
echo
echo "== BUG 2: teardown leaves NO dangling .claude/skills (real git + real libs) =="
# shellcheck source=../lib/skills-mount.sh
source "$RUNNER_DIR/lib/skills-mount.sh"
# shellcheck source=../lib/hygiene.sh
source "$RUNNER_DIR/lib/hygiene.sh"

export GAFFER_DATA="$WORK/g2-data"; mkdir -p "$GAFFER_DATA"
export SKILLS_DIR="$WORK/skills-lib"
mkdir -p "$SKILLS_DIR/run-tests"; printf '# skill\n' > "$SKILLS_DIR/run-tests/SKILL.md"

REAL="$WORK/g2-real"; mk_repo "$REAL"
git -C "$REAL" branch gaffer/ticket-7
WTBASE="$GAFFER_DATA/worktrees/ticket-7"; mkdir -p "$WTBASE"
RWT="$WTBASE/primary"
git -C "$REAL" worktree add -q "$RWT" gaffer/ticket-7

# Mount skills into the worktree via the REAL function → creates .claude/skills.
gaffer_skills_mount "$RWT" "run-tests" "delivery-7"
[ -L "$RWT/.claude/skills" ] \
  && ok "skill-mount created .claude/skills symlink in the worktree" \
  || fail "skill-mount did not create .claude/skills (setup wrong)"

# Crash-trap ordering: the mount TARGET is dropped BEFORE the worktree teardown,
# leaving .claude/skills DANGLING — the exact trigger for the leak.
gaffer_skills_mount_cleanup "delivery-7"
[ -L "$RWT/.claude/skills" ] && [ ! -e "$RWT/.claude/skills" ] \
  && ok "mount cleanup left .claude/skills DANGLING (reproduces the leak trigger)" \
  || fail "expected a dangling .claude/skills after mount-target cleanup"

# The FIXED teardown sequence from gaffer_cleanup_worktrees: git remove, THEN rm -rf.
git -C "$REAL" worktree remove --force "$RWT" >/dev/null 2>&1 || true
rm -rf "$RWT" 2>/dev/null || true
git -C "$REAL" worktree prune >/dev/null 2>&1 || true

[ ! -e "$RWT" ] \
  && ok "teardown fully removed the worktree path (no .claude/ residue)" \
  || fail "worktree path still present after teardown: $(find "$RWT" 2>/dev/null | tr '\n' ' ')"
DANGLING="$(find "$WTBASE" -type l ! -exec test -e {} \; -print 2>/dev/null)"
[ -z "$DANGLING" ] \
  && ok "no dangling symlink survives teardown anywhere under the worktree base" \
  || fail "dangling symlink(s) survived teardown: $DANGLING"
gaffer_assert_repo_clean "$REAL" >/dev/null 2>&1 \
  && ok "gaffer_assert_repo_clean passes on the real repo after a clean teardown" \
  || fail "real repo flagged unclean after teardown: $(gaffer_assert_repo_clean "$REAL" 2>&1 | tr '\n' '|')"

echo "== BUG 2: the hygiene check itself still FIRES on a dangling .claude/skills =="
# Guard against 'fixing' the leak by weakening the detector. Plant the exact
# artefact in a repo and confirm the check reports it.
DIRTY="$WORK/g2-dirty"; mk_repo "$DIRTY"
mkdir -p "$DIRTY/.claude"; ln -sfn "$DIRTY/.claude/gone" "$DIRTY/.claude/skills"
CLEAN_OUT="$(gaffer_assert_repo_clean "$DIRTY" 2>&1 || true)"
printf '%s\n' "$CLEAN_OUT" | grep -q "broken symlink in real repo: .claude/skills" \
  && ok "hygiene check still detects a dangling .claude/skills (detector intact)" \
  || fail "hygiene check no longer catches a dangling .claude/skills: $CLEAN_OUT"

echo "== BUG 2: gaffer_cleanup_worktrees purges the worktree dir (grep-proof) =="
awk '/gaffer_cleanup_worktrees\(\) \{/{f=1}
     f && /worktree remove --force/{r=1}
     f && r && /rm -rf "\$_rwt"/{print "PURGE"; exit}
     f && /^  \}/{exit}' "$TICK" | grep -q PURGE \
  && ok "gaffer_cleanup_worktrees rm -rf's the worktree path after 'git worktree remove'" \
  || fail "gaffer_cleanup_worktrees missing the post-remove 'rm -rf \$_rwt' purge"

# ──────────────────────────────────────────────────────────────────────────────
echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS ($PASS checks)"; exit 0
else
  printf 'FAILED (%d of %d):\n' "${#FAILURES[@]}" "$((PASS + ${#FAILURES[@]}))"
  printf '  - %s\n' "${FAILURES[@]}"; exit 1
fi
