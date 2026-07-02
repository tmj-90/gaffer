#!/usr/bin/env bash
# Validates the per-agent SKILL mount (lib/skills-mount.sh): an agent's
# .claude/skills must contain ONLY the selected + universal subset — NOT the
# whole ~66-skill library — so Claude Code doesn't auto-load every frontmatter
# block. Also covers the fail-soft whole-library fallback and cleanup.
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
[ -L "$DEST/.claude/skills" ] && ok ".claude/skills is a symlink" || fail ".claude/skills not a symlink"
[ "$MOUNTED" -gt 0 ] && [ "$MOUNTED" -lt "$LIB_COUNT" ] \
  && ok "mounted a SUBSET ($MOUNTED of $LIB_COUNT)" || fail "mounted $MOUNTED (expected 0<n<$LIB_COUNT)"

echo "== AC2: universal delivery-mechanics skills are always present =="
umiss=0
for u in $GAFFER_UNIVERSAL_SKILLS; do
  [ -f "$DEST/.claude/skills/$u/SKILL.md" ] || { echo "    missing universal: $u"; umiss=1; }
done
[ "$umiss" = 0 ] && ok "all universal skills mounted" || fail "a universal skill was not mounted"

echo "== AC3: a selected stack skill is mounted; an unselected one is NOT =="
[ -e "$DEST/.claude/skills/typescript-conventions" ] \
  && ok "selected skill (typescript-conventions) present" || fail "selected skill missing"
# kubernetes-operator is a devops-area skill not selected for a bare typescript stack.
if printf '%s' "$SEL" | grep -q 'kubernetes-operator'; then
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

echo "== AC5: cleanup removes the per-agent mount dir =="
gaffer_skills_mount_cleanup "delivery-1"
[ ! -e "$GAFFER_DATA/skills-mounts/delivery-1" ] \
  && ok "mount dir removed by cleanup" || fail "mount dir survived cleanup"

echo "== AC6: FAIL-SOFT — with no GAFFER_DATA, fall back to the whole library =="
(
  unset GAFFER_DATA
  DEST2="$WORK/repoB"; mkdir -p "$DEST2"
  gaffer_skills_mount "$DEST2" "run-tests" "x"
  tgt="$(readlink "$DEST2/.claude/skills" 2>/dev/null)"
  [ "$tgt" = "$SKILLS_DIR" ]
) && ok "fallback symlinks the whole library when GAFFER_DATA unset" \
   || fail "fail-soft fallback did not point at the whole library"

echo "== AC7: FAIL-SOFT — an all-unknown selection still mounts the universal set =="
DEST3="$WORK/repoC"; mkdir -p "$DEST3"
gaffer_skills_mount "$DEST3" "(scaffold the stack from the ticket)" "bootstrap-9"
[ -f "$DEST3/.claude/skills/run-tests/SKILL.md" ] \
  && ok "universal set mounted even when selection matches nothing" \
  || fail "universal set missing on empty selection"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS: $PASS checks"; exit 0
else echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1; fi
