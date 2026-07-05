#!/usr/bin/env bash
# Validates `gaffer skills list` + `gaffer skills install` (symlink the bundled
# skill library into a Claude Code .claude/skills dir; idempotent; --force).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
GAFFER="$RUNNER_DIR/gaffer"
SKILLS_DIR="$RUNNER_DIR/skills"

PASS=0; FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/skills-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

COUNT="$(ls -d "$SKILLS_DIR"/*/ 2>/dev/null | wc -l | tr -d ' ')"

echo "== AC1: 'skills list' enumerates the bundled library =="
OUT="$(trap - EXIT; bash "$GAFFER" skills list 2>&1)"
[ "$COUNT" -gt 0 ] && printf '%s' "$OUT" | grep -q "bundled skills ($COUNT)" \
  && ok "lists $COUNT bundled skills" || fail "skills list count wrong (out=$OUT)"

echo "== AC2: 'skills install --project' symlinks every skill into ./.claude/skills =="
( cd "$WORK"; trap - EXIT; bash "$GAFFER" skills install --project >/dev/null 2>&1 )
INSTALLED="$(ls "$WORK/.claude/skills" 2>/dev/null | wc -l | tr -d ' ')"
[ "$INSTALLED" = "$COUNT" ] && ok "installed all $COUNT skills" || fail "installed $INSTALLED of $COUNT"
# each entry is a symlink that resolves to the bundled skill
one="$(ls "$WORK/.claude/skills" 2>/dev/null | head -1)"
[ -L "$WORK/.claude/skills/$one" ] && [ -f "$WORK/.claude/skills/$one/SKILL.md" ] \
  && ok "entries are symlinks resolving to a real SKILL.md" || fail "symlink/SKILL.md missing for $one"

echo "== AC3: re-install is idempotent (skips existing) =="
OUT2="$(cd "$WORK"; trap - EXIT; bash "$GAFFER" skills install --project 2>&1)"
printf '%s' "$OUT2" | grep -q 'installed 0 skill' \
  && ok "idempotent: second run installs 0, warns already-present" || fail "not idempotent (out=$OUT2)"
[ "$(ls "$WORK/.claude/skills" | wc -l | tr -d ' ')" = "$COUNT" ] \
  && ok "no duplicates after re-run" || fail "count changed on re-run"

echo "== AC4: --force re-links =="
OUT3="$(cd "$WORK"; trap - EXIT; bash "$GAFFER" skills install --project --force 2>&1)"
printf '%s' "$OUT3" | grep -q "installed $COUNT skill" \
  && ok "--force re-installs all $COUNT" || fail "--force did not re-link (out=$OUT3)"

echo "== AC5: --user targets \$HOME/.claude/skills =="
OUT4="$(HOME="$WORK/home" bash -c "trap - EXIT; bash '$GAFFER' skills install --user" 2>&1)"
[ -d "$WORK/home/.claude/skills" ] && [ "$(ls "$WORK/home/.claude/skills" | wc -l | tr -d ' ')" = "$COUNT" ] \
  && ok "--user installs into \$HOME/.claude/skills" || fail "--user target wrong (out=$OUT4)"

echo "== AC6: always-on quality lens (engineering-craft) + frontend floor =="
grep -qiE '^area:[[:space:]]*quality' "$SKILLS_DIR/engineering-craft/SKILL.md" 2>/dev/null \
  && ok "engineering-craft is area:quality (injected as a mandatory lens)" \
  || fail "engineering-craft missing or not area:quality"
grep -qiE '^area:[[:space:]]*frontend' "$SKILLS_DIR/frontend-foundations/SKILL.md" 2>/dev/null \
  && ok "frontend-foundations is area:frontend (UI quality floor)" \
  || fail "frontend-foundations missing or not area:frontend"
# The mandatory-lens set is EVERY area:quality skill (tick.sh ~line 1399). Pin that
# engineering-craft is in it so a future change can't silently drop the craft lens.
LENS_SET="$(for _f in "$SKILLS_DIR"/*/SKILL.md; do grep -qiE '^area:[[:space:]]*quality' "$_f" 2>/dev/null && basename "$(dirname "$_f")"; done | paste -sd, -)"
printf '%s' "$LENS_SET" | grep -q "engineering-craft" \
  && ok "engineering-craft is in the mandatory-lens set" \
  || fail "engineering-craft not in the mandatory-lens set ($LENS_SET)"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS: $PASS checks"; exit 0
else echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1; fi
