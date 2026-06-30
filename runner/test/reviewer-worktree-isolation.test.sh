#!/bin/bash
# =====================================================================
# BLOCKING 1 + 2 regression guard — reviewer must run in a throwaway
# worktree and must clean up under INT/TERM, never touching the
# registered repo's working tree or its .claude/ wiring.
# ---------------------------------------------------------------------
# Before the fix the reviewer:
#   1. Checked out $RBRANCH directly in $RREPO (mutating its HEAD).
#   2. Wrote .claude/settings.json, .claude/skills, CLAUDE.factory.md
#      INTO $RREPO, then deleted them — clobbering any pre-existing files.
#   3. Only installed an EXIT trap; a SIGINT/SIGTERM during review would
#      skip _review_cleanup and leave the working tree mutated.
#
# After the fix:
#   1. The reviewer runs in a throwaway `git worktree` under $GAFFER_DATA.
#   2. .claude/ wiring and CLAUDE.factory.md go into the worktree, never
#      into $RREPO.
#   3. EXIT + INT + TERM traps all call _review_cleanup (worktree remove).
#
# Tests:
#   A. Seed $RREPO with real .claude/settings.json, .claude/skills
#      (symlink), and CLAUDE.factory.md.  Drive the reviewer block with
#      a fake claude that exits 0.  Assert all three paths survive
#      UNCHANGED and the repo is still on its original branch.
#   B. Same setup with a fake claude that sleeps.  Send SIGTERM to the
#      runner mid-review.  Assert exit 143, worktree gone, $RREPO
#      and its .claude/ untouched.
#
# Zero deps beyond bash and git.  Run: bash runner/test/reviewer-worktree-isolation.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/review-wt-iso.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT

# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

# Build a registered repo with one commit on 'main' + a delivery branch.
# Seeds .claude/settings.json, .claude/skills (symlink target), and
# CLAUDE.factory.md with KNOWN content so we can detect clobbering.
make_repo() {
  local repo="$1"
  mkdir -p "$repo"
  git -C "$repo" init -q
  git -C "$repo" config user.email "t@e"
  git -C "$repo" config user.name "t"
  echo "seed" > "$repo/seed.txt"
  git -C "$repo" add seed.txt
  git -C "$repo" commit -qm "initial"
  # delivery branch
  git -C "$repo" checkout -qb "gaffer/ticket-99-fix" 2>/dev/null
  echo "change" >> "$repo/seed.txt"
  git -C "$repo" add seed.txt
  git -C "$repo" commit -qm "delivery"
  git -C "$repo" checkout -q main 2>/dev/null || git -C "$repo" checkout -q master 2>/dev/null
  # pre-existing .claude/ wiring the reviewer MUST NOT clobber
  mkdir -p "$repo/.claude"
  echo '{"original":true}' > "$repo/.claude/settings.json"
  mkdir -p "$repo/.claude/skills-target"
  echo "skill-content" > "$repo/.claude/skills-target/SKILL.md"
  ln -sfn "$repo/.claude/skills-target" "$repo/.claude/skills"
  echo "ORIGINAL CLAUDE.factory.md" > "$repo/CLAUDE.factory.md"
}

# A minimal reviewer runner that mirrors tick.sh's new worktree block.
# Arguments: <RREPO> <RBRANCH> <GAFFER_DATA> <CLAUDE_BIN> [sleep|exit0]
make_reviewer_script() {
  cat > "$WORK/reviewer.sh" <<'SCRIPT'
#!/bin/bash
set -uo pipefail
RREPO="$1"
RBRANCH="$2"
GAFFER_DATA="$3"
CLAUDE_BIN="$4"
MODE="${5:-exit0}"

# ── mirror tick.sh's global cleanup infrastructure ──
GAFFER_DELIVERY_COMPLETE="${GAFFER_DELIVERY_COMPLETE:-0}"
gaffer_crash_cleanup() {
  [ "${GAFFER_DELIVERY_COMPLETE:-0}" = "1" ] && return 0
  return 0
}
gaffer_on_exit() {
  local rc=$?
  trap - EXIT INT TERM
  gaffer_crash_cleanup
  exit "$rc"
}
gaffer_on_signal() {
  trap - EXIT INT TERM
  gaffer_crash_cleanup
  exit "$1"
}
trap gaffer_on_exit EXIT
trap 'gaffer_on_signal 130' INT
trap 'gaffer_on_signal 143' TERM

# ── mirror tick.sh's reviewer worktree block (post-fix) ──
WT="$GAFFER_DATA/review-wt-99"
_review_cleanup() {
  if [ -n "${WT:-}" ] && [ -e "$WT" ]; then
    git -C "$RREPO" worktree remove --force "$WT" 2>/dev/null || true
    git -C "$RREPO" worktree prune 2>/dev/null || true
  fi
}
_review_on_exit() {
  local rc=$?
  trap - EXIT INT TERM
  _review_cleanup
  gaffer_crash_cleanup
  exit "$rc"
}
_review_on_int()  { trap - EXIT INT TERM; _review_cleanup; gaffer_crash_cleanup; exit 130; }
_review_on_term() { trap - EXIT INT TERM; _review_cleanup; gaffer_crash_cleanup; exit 143; }
trap _review_on_exit EXIT
trap _review_on_int  INT
trap _review_on_term TERM

if [ -z "${RBRANCH:-}" ]; then
  echo "REVIEW-ERROR: no branch" >&2; exit 1
fi
if ! git -C "$RREPO" worktree add --force "$WT" "$RBRANCH" >/dev/null 2>&1; then
  echo "REVIEW-ERROR: worktree add failed" >&2; exit 1
fi
# write wiring into the worktree — never into $RREPO
mkdir -p "$WT/.claude"
echo '{"wt":true}' > "$WT/.claude/settings.json"
echo "REVIEWER CLAUDE.factory.md" > "$WT/CLAUDE.factory.md"

# simulate agent run
case "$MODE" in
  sleep) sleep 60 & wait $! ;;  # interrupted by TERM before this returns
  exit0) "$CLAUDE_BIN" ;;
esac

# normal completion: restore global traps
_review_cleanup
trap gaffer_on_exit EXIT
trap 'gaffer_on_signal 130' INT
trap 'gaffer_on_signal 143' TERM
exit 0
SCRIPT
  chmod +x "$WORK/reviewer.sh"
}

# ---------------------------------------------------------------------------
# Fake claude binaries
# ---------------------------------------------------------------------------
FAKE_BIN="$WORK/bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/claude-exit0" <<'SH'
#!/bin/sh
exit 0
SH
chmod +x "$FAKE_BIN/claude-exit0"

cat > "$FAKE_BIN/claude-sleep" <<'SH'
#!/bin/sh
sleep 60
SH
chmod +x "$FAKE_BIN/claude-sleep"

# ---------------------------------------------------------------------------
# TEST A: successful review — $RREPO files survive unchanged
# ---------------------------------------------------------------------------
echo "== A: successful review does not clobber registered repo =="

REPO_A="$WORK/repo-a"
DATA_A="$WORK/data-a"
mkdir -p "$DATA_A"
make_repo "$REPO_A"

# Capture original content and branch
ORIG_BRANCH_A="$(git -C "$REPO_A" rev-parse --abbrev-ref HEAD)"
ORIG_SETTINGS_A="$(cat "$REPO_A/.claude/settings.json")"
ORIG_FACTORY_A="$(cat "$REPO_A/CLAUDE.factory.md")"
ORIG_SKILLS_TARGET_A="$(readlink "$REPO_A/.claude/skills")"

make_reviewer_script
bash "$WORK/reviewer.sh" "$REPO_A" "gaffer/ticket-99-fix" "$DATA_A" "$FAKE_BIN/claude-exit0" "exit0"
rc_a=$?

if [ "$rc_a" -eq 0 ]; then
  ok "A: reviewer script exits 0"
else
  fail "A: reviewer script exited $rc_a (expected 0)"
fi

# Branch unchanged
AFTER_BRANCH_A="$(git -C "$REPO_A" rev-parse --abbrev-ref HEAD)"
if [ "$AFTER_BRANCH_A" = "$ORIG_BRANCH_A" ]; then
  ok "A: registered repo is on its original branch ($ORIG_BRANCH_A)"
else
  fail "A: repo branch changed from $ORIG_BRANCH_A to $AFTER_BRANCH_A"
fi

# settings.json unchanged
AFTER_SETTINGS_A="$(cat "$REPO_A/.claude/settings.json" 2>/dev/null || echo MISSING)"
if [ "$AFTER_SETTINGS_A" = "$ORIG_SETTINGS_A" ]; then
  ok "A: .claude/settings.json is byte-for-byte unchanged"
else
  fail "A: .claude/settings.json was modified (before='$ORIG_SETTINGS_A' after='$AFTER_SETTINGS_A')"
fi

# CLAUDE.factory.md unchanged
AFTER_FACTORY_A="$(cat "$REPO_A/CLAUDE.factory.md" 2>/dev/null || echo MISSING)"
if [ "$AFTER_FACTORY_A" = "$ORIG_FACTORY_A" ]; then
  ok "A: CLAUDE.factory.md is byte-for-byte unchanged"
else
  fail "A: CLAUDE.factory.md was modified (before='$ORIG_FACTORY_A' after='$AFTER_FACTORY_A')"
fi

# skills symlink unchanged
AFTER_SKILLS_A="$(readlink "$REPO_A/.claude/skills" 2>/dev/null || echo MISSING)"
if [ "$AFTER_SKILLS_A" = "$ORIG_SKILLS_TARGET_A" ]; then
  ok "A: .claude/skills symlink is unchanged"
else
  fail "A: .claude/skills symlink changed (before='$ORIG_SKILLS_TARGET_A' after='$AFTER_SKILLS_A')"
fi

# worktree cleaned up
if [ -e "$DATA_A/review-wt-99" ]; then
  fail "A: throwaway worktree was not removed after a successful review"
else
  ok "A: throwaway worktree was removed on normal completion"
fi

# ---------------------------------------------------------------------------
# TEST B: SIGTERM mid-review — cleanup runs, $RREPO untouched, exit 143
# ---------------------------------------------------------------------------
echo "== B: SIGTERM mid-review cleans up worktree and leaves repo untouched =="

REPO_B="$WORK/repo-b"
DATA_B="$WORK/data-b"
mkdir -p "$DATA_B"
make_repo "$REPO_B"

ORIG_BRANCH_B="$(git -C "$REPO_B" rev-parse --abbrev-ref HEAD)"
ORIG_SETTINGS_B="$(cat "$REPO_B/.claude/settings.json")"
ORIG_FACTORY_B="$(cat "$REPO_B/CLAUDE.factory.md")"

make_reviewer_script
bash "$WORK/reviewer.sh" "$REPO_B" "gaffer/ticket-99-fix" "$DATA_B" "$FAKE_BIN/claude-sleep" "sleep" &
CHILD_PID=$!
# Give the reviewer time to create the worktree and enter the sleep
sleep 1
# Deliver SIGTERM to the child
kill -TERM "$CHILD_PID" 2>/dev/null || true
wait "$CHILD_PID" 2>/dev/null; rc_b=$?

if [ "$rc_b" -eq 143 ]; then
  ok "B: SIGTERM exits 143 (not swallowed)"
else
  fail "B: SIGTERM did not exit 143 (got $rc_b)"
fi

# worktree cleaned up
if [ -e "$DATA_B/review-wt-99" ]; then
  fail "B: throwaway worktree left behind after SIGTERM"
else
  ok "B: throwaway worktree removed after SIGTERM"
fi

# repo branch unchanged
AFTER_BRANCH_B="$(git -C "$REPO_B" rev-parse --abbrev-ref HEAD)"
if [ "$AFTER_BRANCH_B" = "$ORIG_BRANCH_B" ]; then
  ok "B: registered repo is on its original branch after SIGTERM"
else
  fail "B: repo branch changed from $ORIG_BRANCH_B to $AFTER_BRANCH_B after SIGTERM"
fi

# settings.json unchanged
AFTER_SETTINGS_B="$(cat "$REPO_B/.claude/settings.json" 2>/dev/null || echo MISSING)"
if [ "$AFTER_SETTINGS_B" = "$ORIG_SETTINGS_B" ]; then
  ok "B: .claude/settings.json is byte-for-byte unchanged after SIGTERM"
else
  fail "B: .claude/settings.json was modified by SIGTERM path (before='$ORIG_SETTINGS_B' after='$AFTER_SETTINGS_B')"
fi

# CLAUDE.factory.md unchanged
AFTER_FACTORY_B="$(cat "$REPO_B/CLAUDE.factory.md" 2>/dev/null || echo MISSING)"
if [ "$AFTER_FACTORY_B" = "$ORIG_FACTORY_B" ]; then
  ok "B: CLAUDE.factory.md is byte-for-byte unchanged after SIGTERM"
else
  fail "B: CLAUDE.factory.md was modified by SIGTERM path (before='$ORIG_FACTORY_B' after='$AFTER_FACTORY_B')"
fi

# ---------------------------------------------------------------------------
echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS — $PASS checks passed"
  exit 0
else
  echo "FAILED — ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]})) failed"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
