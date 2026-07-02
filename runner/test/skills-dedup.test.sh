#!/usr/bin/env bash
# Validates the "Capture lore" de-duplication: the identical ~230-word block that
# used to be pasted into ~20+ skills is now factored to ONE canonical place (the
# always-loaded brief), and each de-bloated skill still carries its OWN distinct
# guidance and points to the shared protocol — the shared block is referenced,
# not lost.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
SKILLS_DIR="$RUNNER_DIR/skills"
BRIEF="$RUNNER_DIR/claude/CLAUDE.md"

PASS=0; FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

# The factored skills — those whose "## Capture lore" section now points to the
# shared protocol instead of re-explaining the full suggest_lore contract.
FACTORED="$(grep -rl 'lore-capture' "$SKILLS_DIR" | sed "s#$SKILLS_DIR/##; s#/SKILL.md##" | sort)"

echo "== AC1: the canonical lore-capture protocol lives ONCE in the brief =="
grep -q 'lore-capture protocol' "$BRIEF" \
  && ok "brief defines the lore-capture protocol" || fail "brief missing the protocol"
grep -q 'suggest_lore' "$BRIEF" \
  && ok "brief documents the suggest_lore contract" || fail "brief missing suggest_lore"

echo "== AC2: at least ~20 skills were de-bloated to reference it =="
N="$(printf '%s\n' "$FACTORED" | grep -c .)"
[ "$N" -ge 20 ] && ok "$N skills reference the shared protocol" || fail "only $N skills factored (<20)"

echo "== AC3: each factored skill still carries its OWN distinct guidance =="
# The distinct guidance is a bold **...** trigger sentence unique to the skill.
# Assert it's present AND that no two factored skills share the same one.
declare -a SEEN=()
distinct_bad=0
for s in $FACTORED; do
  f="$SKILLS_DIR/$s/SKILL.md"
  # Extract the bold sentence inside the Capture lore section.
  bold="$(awk '/^## Capture lore/{f=1} f' "$f" | grep -o '\*\*[^*]\+\*\*' | head -1)"
  if [ -z "$bold" ]; then echo "    no distinct bold trigger: $s"; distinct_bad=1; continue; fi
  for prev in "${SEEN[@]:-}"; do
    if [ "$prev" = "$bold" ]; then echo "    duplicate trigger across skills: $s"; distinct_bad=1; fi
  done
  SEEN+=("$bold")
done
[ "$distinct_bad" = 0 ] && ok "every factored skill has a unique distinct trigger" \
  || fail "a factored skill lost or duplicated its distinct guidance"

echo "== AC4: the old ~230-word boilerplate is no longer pasted across skills =="
# The tell-tale duplicated sentence used to appear in every copy; it must now
# survive in AT MOST one place (ideally zero — it moved to the brief).
DUP="$(grep -rl 'This is suggested, gated knowledge' "$SKILLS_DIR" | wc -l | tr -d ' ')"
[ "$DUP" -le 1 ] && ok "duplicated boilerplate removed from skills ($DUP copies left)" \
  || fail "boilerplate still duplicated across $DUP skills"

echo "== AC5: factored skills still point agents at suggest_lore (behaviour intact) =="
behav_bad=0
for s in $FACTORED; do
  grep -q 'suggest_lore' "$SKILLS_DIR/$s/SKILL.md" || { echo "    no suggest_lore ref: $s"; behav_bad=1; }
done
[ "$behav_bad" = 0 ] && ok "all factored skills still reference suggest_lore" \
  || fail "a factored skill dropped the suggest_lore action"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS: $PASS checks"; exit 0
else echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1; fi
