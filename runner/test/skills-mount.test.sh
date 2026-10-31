#!/usr/bin/env bash
# Validates the per-agent SKILL mount (lib/skills-mount.sh): an agent's
# .claude/skills must contain ONLY the selected + universal subset — NOT the
# whole ~66-skill library — so Claude Code doesn't auto-load every frontmatter
# block. The skills are REAL COPIES (a symlink into the library resolved outside the
# worktree, so the safety hook refused the agent's Read of them). Also covers the
# fail-soft whole-library fallback and cleanup.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
SKILLS_DIR="$RUNNER_DIR/skills"

# shellcheck source=../lib/skills-mount.sh
source "$RUNNER_DIR/lib/skills-mount.sh"

PASS=0; FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/skills-mount.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
export GAFFER_DATA="$WORK/data"; mkdir -p "$GAFFER_DATA"

LIB_COUNT="$(ls -d "$SKILLS_DIR"/*/ 2>/dev/null | wc -l | tr -d ' ')"

echo "== AC1: mount contains ONLY the selected + universal subset, not all $LIB_COUNT =="
SEL="$(node "$RUNNER_DIR/bin/select-skills.mjs" --stack typescript --skills-dir "$SKILLS_DIR")"
DEST="$WORK/repoA"; mkdir -p "$DEST"
gaffer_skills_mount "$DEST" "$SEL" "delivery-1"
MOUNTED="$(ls "$DEST/.claude/skills" 2>/dev/null | wc -l | tr -d ' ')"
[ -d "$DEST/.claude/skills" ] && [ ! -L "$DEST/.claude/skills" ] && ok ".claude/skills is a real directory" || fail ".claude/skills is not a real directory"
[ -f "$DEST/.claude/skills/run-tests/SKILL.md" ] && [ ! -L "$DEST/.claude/skills/run-tests" ] && [ ! -L "$DEST/.claude/skills/run-tests/SKILL.md" ] \
  && ok "a mounted skill is a real copy, not a link into the library" || fail "run-tests is not a real copy"
cmp -s "$DEST/.claude/skills/run-tests/SKILL.md" "$SKILLS_DIR/run-tests/SKILL.md" && ok "the copy is byte-identical to the library" || fail "the copy differs from the library"
[ "$MOUNTED" -gt 0 ] && [ "$MOUNTED" -lt "$LIB_COUNT" ] \
  && ok "mounted a SUBSET ($MOUNTED of $LIB_COUNT)" || fail "mounted $MOUNTED (expected 0<n<$LIB_COUNT)"

echo "== AC2: universal delivery-mechanics skills are always present =="
umiss=0
for u in $GAFFER_UNIVERSAL_SKILLS; do
  [ -f "$DEST/.claude/skills/$u/SKILL.md" ] || { echo "    missing universal: $u"; umiss=1; }
done
[ "$umiss" = 0 ] && ok "all universal skills mounted" || fail "a universal skill was not mounted"
# FINDING 16: the prompt MANDATES prepare-digest-delta, so it must be in the
# universal DEFAULT set (it was dropped on the select-skills fallback before) —
# assert both the default list and the actual mount carry it.
case " $GAFFER_UNIVERSAL_SKILLS " in
  *" prepare-digest-delta "*) ok "prepare-digest-delta is in the universal default set" ;;
  *) fail "prepare-digest-delta missing from GAFFER_UNIVERSAL_SKILLS" ;;
esac
[ -f "$DEST/.claude/skills/prepare-digest-delta/SKILL.md" ] \
  && ok "prepare-digest-delta is mounted for the agent" \
  || fail "prepare-digest-delta not mounted"

echo "== AC3: a selected stack skill is mounted; an unselected one is NOT =="
[ -e "$DEST/.claude/skills/typescript-conventions" ] \
  && ok "selected skill (typescript-conventions) present" || fail "selected skill missing"
# kubernetes-operator is a devops-area skill not selected for a bare typescript stack.
if grep -q 'kubernetes-operator' <<<"$SEL"; then
  ok "n/a: kubernetes-operator was selected for this stack"
else
  [ ! -e "$DEST/.claude/skills/kubernetes-operator" ] \
    && ok "unselected skill (kubernetes-operator) absent" || fail "unselected skill leaked into mount"
fi

echo "== AC4: every mounted entry resolves to a real SKILL.md =="
bad=0
for d in "$DEST/.claude/skills"/*; do
  [ -f "$d/SKILL.md" ] || { echo "    broken: $d"; bad=1; }
done
[ "$bad" = 0 ] && ok "all mounted entries resolve to a SKILL.md" || fail "a mounted entry is broken"

echo "== AC5: a re-mount is idempotent; cleanup removes the manifest and (with a dest) the copies =="
gaffer_skills_mount "$DEST" "python-conventions" "delivery-1"
[ -d "$DEST/.claude/skills/python-conventions" ] && [ ! -e "$DEST/.claude/skills/typescript-conventions" ] \
  && ok "a re-mount replaces the previous install" || fail "re-mount kept the old selection"
mkdir -p "$DEST/.claude/agent-notes"
gaffer_skills_mount_cleanup "delivery-1" "$DEST"
[ ! -e "$GAFFER_DATA/skills-mounts/delivery-1" ] \
  && ok "mount manifest removed by cleanup" || fail "mount manifest survived cleanup"
[ ! -e "$DEST/.claude/skills" ] && ok "the installed copies (and the dir Gaffer made) are gone" || fail "copies survived: $(ls -A "$DEST/.claude/skills" 2>/dev/null | tr '\n' ' ')"
[ -d "$DEST/.claude/agent-notes" ] && ok "other .claude content is left alone" || fail "cleanup removed non-Gaffer .claude content"

echo "== AC6: with no GAFFER_DATA the subset is still installed (copies need no factory state) =="
(
  unset GAFFER_DATA
  DEST2="$WORK/repoB"; mkdir -p "$DEST2"
  gaffer_skills_mount "$DEST2" "run-tests" "x"
  [ -f "$DEST2/.claude/skills/run-tests/SKILL.md" ] && [ ! -L "$DEST2/.claude/skills" ]
) && ok "no GAFFER_DATA: copies installed, no link into the library" \
   || fail "no GAFFER_DATA: the subset was not installed"

echo "== AC6b: an OLDER symlink mount is replaced by copies =="
DEST5="$WORK/repoE"; mkdir -p "$DEST5/.claude"; ln -sfn "$SKILLS_DIR" "$DEST5/.claude/skills"
gaffer_skills_mount "$DEST5" "run-tests" "delivery-5"
[ -d "$DEST5/.claude/skills" ] && [ ! -L "$DEST5/.claude/skills" ] && [ -f "$DEST5/.claude/skills/run-tests/SKILL.md" ] \
  && ok "the legacy library link became a dir of copies" || fail "legacy link not replaced"
[ -d "$SKILLS_DIR/run-tests" ] && ok "the library itself is untouched" || fail "the library lost run-tests"

echo "== AC7: FAIL-SOFT — an all-unknown selection still mounts the universal set =="
DEST3="$WORK/repoC"; mkdir -p "$DEST3"
gaffer_skills_mount "$DEST3" "(scaffold the stack from the ticket)" "bootstrap-9"
[ -f "$DEST3/.claude/skills/run-tests/SKILL.md" ] \
  && ok "universal set mounted even when selection matches nothing" \
  || fail "universal set missing on empty selection"

echo "== AC8: telemetry records the MOUNT (universal set too) and the skills the agent OPENED =="
DEST4="$WORK/repoD"; mkdir -p "$DEST4"
gaffer_skills_mount "$DEST4" "add-api-endpoint" "review-77"
SINCE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# The safety hook's tool ledger: this agent (no ticket) Read one mounted skill in ITS
# worktree; another agent's worktree read must not count.
# Rows are stamped with the hook's decision: the allowed read is an open, the refused
# one (plan-change) is recorded as refused and is NOT an open or an application.
printf '%s\n' \
  "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%S.500Z)\",\"ticket\":null,\"tool\":\"Read\",\"target\":\"$DEST4/.claude/skills/add-api-endpoint/SKILL.md\",\"decision\":\"allow\"}" \
  "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%S.550Z)\",\"ticket\":null,\"tool\":\"Read\",\"target\":\"$DEST4/.claude/skills/plan-change/SKILL.md\",\"decision\":\"block\"}" \
  "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%S.600Z)\",\"ticket\":null,\"tool\":\"Read\",\"target\":\"$WORK/other/.claude/skills/run-tests/SKILL.md\",\"decision\":\"allow\"}" \
  >> "$GAFFER_DATA/tool-metrics.jsonl"
gaffer_record_skill_usage 77 review python "add-api-endpoint" "" "review-77" "$DEST4" "$SINCE"
ROW="$(tail -1 "$GAFFER_DATA/skills-telemetry.jsonl" 2>/dev/null)"
grep -q '"role":"review"' <<<"$ROW" && ok "a review row was written" || fail "no review row: $ROW"
grep -q '"plan-change"' <<<"$ROW" && ok "selected lists the mounted universal set (plan-change)" || fail "universal set missing from selected: $ROW"
grep -q '"opened":\["add-api-endpoint"\]' <<<"$ROW" && ok "opened = the skill read in this agent's worktree only" || fail "opened wrong: $ROW"
grep -q '"refused":\["plan-change"\]' <<<"$ROW" && ok "refused = the read the hook blocked" || fail "refused wrong: $ROW"
grep -q '"applied":\[\]' <<<"$ROW" && ok "applied is not inferred from an open" || fail "applied wrong: $ROW"
# Every agent site records its run.
for site in "tick.sh:delivery" "tick.sh:bootstrap" "lib/review.sh:review" "lib/review.sh:security-review" "lib/clarify.sh:clarify"; do
  f="${site%%:*}"; role="${site#*:}"
  grep -qE "gaffer_record_skill_usage \"\\\$[A-Z]*NUM\" $role " "$RUNNER_DIR/$f" \
    && ok "$f records $role skill telemetry" || fail "$f does not record $role skill telemetry"
done

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS: $PASS checks"; exit 0
else echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1; fi
