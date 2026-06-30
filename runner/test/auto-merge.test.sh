#!/usr/bin/env bash
# =====================================================================
# AUTO-MERGE validation (ticket #19).
# ---------------------------------------------------------------------
# Proves, against the REAL gaffer_auto_merge function and REAL git repos:
#   AC1  auto_merge is OFF by default and configurable on/off.
#         - sourcing factory.config.sh with no env sets AUTO_MERGE=0
#         - an AUTO_MERGE=1 env override is respected
#         - tick.sh only merges when status=done AND AUTO_MERGE=1
#   AC2  with auto_merge on, approving a ticket merges its branch into the
#        default branch; a conflict leaves the branch + flags a human.
#         - clean branch  → merged into the default branch (returns 0)
#         - conflicting branch → merge aborted, default branch unchanged,
#           delivery branch + its commit left intact (returns 1)
#   SAFETY  the merge is force-free / push-free (respects the safety hook).
#
# Zero deps; needs only git. Run: bash test/auto-merge.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

# shellcheck source=../lib/automerge.sh
source "$RUNNER_DIR/lib/automerge.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/automerge-test.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# Isolate default-resolution from the operator's real $GAFFER_DATA/settings.json:
# point GAFFER_DATA at an empty dir so the AC1 checks verify the hardcoded factory
# defaults (AUTO_MERGE / MERGE_ON_AGENT_REVIEW = 0), not whatever the dashboard
# Settings panel persisted on this machine.
export GAFFER_DATA="$WORK/gaffer-data"
mkdir -p "$GAFFER_DATA"

# Build a repo on `main` with one commit, plus a `feature` branch off it. The
# caller appends commits to feature/main to set up clean vs conflicting merges.
new_repo() {
  local repo="$1"
  git init -q -b main "$repo"
  git -C "$repo" config user.email gaffer@test
  git -C "$repo" config user.name gaffer-test
  printf 'base\n' > "$repo/file.txt"
  git -C "$repo" add file.txt
  git -C "$repo" commit -q -m base
  git -C "$repo" checkout -q -b feature
}

echo "== AC1: off by default + configurable =="

DEFVAL="$( unset AUTO_MERGE; source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1; printf '%s' "$AUTO_MERGE" )"
[ "$DEFVAL" = "0" ] && ok "AUTO_MERGE defaults to 0 (off) with no env" || fail "AUTO_MERGE default should be 0 (got: $DEFVAL)"

OVRVAL="$( AUTO_MERGE=1; export AUTO_MERGE; source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1; printf '%s' "$AUTO_MERGE" )"
[ "$OVRVAL" = "1" ] && ok "AUTO_MERGE=1 env override is respected (can be turned on)" || fail "AUTO_MERGE override should win (got: $OVRVAL)"

# The merge in tick.sh is gated on BOTH approval (status=done) AND AUTO_MERGE=1.
grep -Eq '\[ "\$NEWSTATUS" = "done" \] && \[ "\$\{AUTO_MERGE:-0\}" = "1" \]' "$RUNNER_DIR/tick.sh" \
  && ok "tick.sh merges only when status=done AND AUTO_MERGE=1" \
  || fail "tick.sh auto-merge guard (done + AUTO_MERGE=1) missing"

# A merge requires a HUMAN approval: an AGENT reviewer's approval does NOT merge
# unless MERGE_ON_AGENT_REVIEW=1 (default 0). This keeps a human as the merge gate.
MOAR="$( unset MERGE_ON_AGENT_REVIEW; source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1; printf '%s' "$MERGE_ON_AGENT_REVIEW" )"
[ "$MOAR" = "0" ] && ok "MERGE_ON_AGENT_REVIEW defaults to 0 (agent approval needs a human to merge)" || fail "MERGE_ON_AGENT_REVIEW should default to 0 (got: $MOAR)"
grep -q 'MERGE_ON_AGENT_REVIEW:-0' "$RUNNER_DIR/tick.sh" \
  && ok "tick.sh gates agent-review auto-merge behind MERGE_ON_AGENT_REVIEW" \
  || fail "tick.sh should gate agent-review auto-merge behind MERGE_ON_AGENT_REVIEW"

# Fix 4: an AGENT review is ADVISORY — the reviewer must NOT mint a human approval.
# The reviewer prompt must NOT instruct `review approve` (that would flip → done and
# could trigger a merge); it records an advisory recommendation instead.
RPROMPT_BLOCK="$(awk '/read -r -d .. RPROMPT <<EOF/{f=1} f{print} /^EOF$/{if(f){exit}}' "$RUNNER_DIR/tick.sh")"
# Any mention of `review approve` in the reviewer prompt must be a PROHIBITION
# (Do NOT / never / blocked), not an instruction to perform it. Strip the lines
# that forbid it; if any `review approve` mention remains, that's an approve
# instruction and a failure.
APPROVE_INSTRUCTIONS="$(echo "$RPROMPT_BLOCK" \
  | grep -iE 'review[ _-]?approve' \
  | grep -viE 'do not|don.t|never|must not|blocked|not.*approv|advisory|privileged|control-plane|mark-merged')"
[ -z "$APPROVE_INSTRUCTIONS" ] \
  && ok "reviewer prompt does NOT instruct the agent to 'review approve' (only forbids it)" \
  || fail "reviewer prompt still instructs 'review approve': $APPROVE_INSTRUCTIONS"
echo "$RPROMPT_BLOCK" | grep -qiE 'RECOMMEND APPROVE|advisory|recommendation' \
  && ok "reviewer prompt records an ADVISORY recommendation instead of approving" \
  || fail "reviewer prompt should record an advisory recommendation"
echo "$RPROMPT_BLOCK" | grep -qiE 'human' \
  && ok "reviewer prompt states a HUMAN makes the final decision" \
  || fail "reviewer prompt should state a human makes the final decision"
# The config comment must plainly state MERGE_ON_AGENT_REVIEW=1 is NOT safe unattended.
grep -qiE 'NOT A SAFE UNATTENDED POSTURE|NOT a safe unattended' "$RUNNER_DIR/factory.config.sh" \
  && ok "factory.config.sh states MERGE_ON_AGENT_REVIEW=1 is NOT a safe unattended posture" \
  || fail "factory.config.sh should plainly flag MERGE_ON_AGENT_REVIEW=1 as unsafe unattended"

echo "== AC2: clean merge into the default branch =="

REPO="$WORK/clean"
new_repo "$REPO"
printf 'base\nfeature-change\n' > "$REPO/file.txt"
git -C "$REPO" commit -q -am feature-change

if gaffer_auto_merge "$REPO" feature main; then
  ok "gaffer_auto_merge returns 0 on a clean merge"
else
  fail "gaffer_auto_merge should succeed on a clean merge"
fi
[ "$(git -C "$REPO" rev-parse --abbrev-ref HEAD)" = "main" ] \
  && ok "repo left on the default branch after merge" || fail "repo not on default branch after merge"
grep -q feature-change "$REPO/file.txt" \
  && ok "default branch now contains the merged change" || fail "merged change missing from default branch"

echo "== AC2: conflict leaves the branch + flags a human =="

REPO="$WORK/conflict"
new_repo "$REPO"
printf 'base\nfeature-line\n' > "$REPO/file.txt"   # feature edits the file...
git -C "$REPO" commit -q -am feature-edit
git -C "$REPO" checkout -q main
printf 'base\nmain-line\n' > "$REPO/file.txt"       # ...and main edits the same line → conflict
git -C "$REPO" commit -q -am main-edit
MAIN_BEFORE="$(git -C "$REPO" rev-parse main)"

if gaffer_auto_merge "$REPO" feature main; then
  fail "gaffer_auto_merge should return non-zero on a conflict"
else
  ok "gaffer_auto_merge returns non-zero on a conflict (flags a human)"
fi
[ -z "$(git -C "$REPO" status --porcelain)" ] \
  && ok "conflict aborted — working tree is clean (no half-merge left)" || fail "conflict left a dirty/merging tree"
[ ! -f "$REPO/.git/MERGE_HEAD" ] && ok "no MERGE_HEAD lingering after abort" || fail "MERGE_HEAD left behind"
[ "$(git -C "$REPO" rev-parse main)" = "$MAIN_BEFORE" ] \
  && ok "default branch unchanged after a conflicting merge" || fail "default branch was mutated by a conflict"
git -C "$REPO" rev-parse --verify feature >/dev/null 2>&1 \
  && ok "delivery branch left intact for a human" || fail "delivery branch lost after conflict"

echo "== guard: bad args attempt nothing =="
gaffer_auto_merge "" "" ""; [ "$?" = "2" ] && ok "missing args → returns 2, nothing attempted" || fail "bad args should return 2"

echo "== SAFETY: force-free / push-free merge =="
# Inspect only executable lines (drop comments) for protected-branch force ops.
if grep -vE '^[[:space:]]*#' "$RUNNER_DIR/lib/automerge.sh" \
     | grep -Eq -- '--force|reset[[:space:]]+--hard|git[^|;&]*push'; then
  fail "automerge.sh must not force / reset --hard / push"
else
  ok "automerge.sh uses a plain merge — no force, no reset --hard, no push"
fi

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
