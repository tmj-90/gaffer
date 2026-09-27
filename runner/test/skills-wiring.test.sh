#!/usr/bin/env bash
# =====================================================================
# B30 — skills leftovers: the bootstrap selector's text relevance, the `fg skills`
# fallback returning REAL library skills, and `gaffer skills list` telling the truth.
# ---------------------------------------------------------------------
#   1. tick.sh's BOOTSTRAP skill selection passes the ticket title/description as
#      `--text`, like the delivery path (it passed none, so an off-domain pack the
#      brief plainly called for was unreachable from a bootstrap).
#   2. `fg skills --stack <label>` (the tick.sh fallback when the selector yields
#      nothing) returns skills from the SKILL.md library — needs the crew dist.
#   3. `gaffer skills list` describes role-based selection, not "auto-loads all".
# Run: bash test/skills-wiring.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/skills-wiring.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

echo "== 1: the bootstrap selector receives the ticket text =="
B_LINE="$(grep -n 'B_SKILLS="\$(node "\$HERE/bin/select-skills.mjs"' "$RUNNER_DIR/tick.sh" | head -1)"
[ -n "$B_LINE" ] && ok "bootstrap select-skills line found" || fail "bootstrap B_SKILLS line not found"
printf '%s' "$B_LINE" | grep -q -- '--text "\$_B_SKILL_TEXT"' \
  && ok "bootstrap passes --text (title + description head) like the delivery path" \
  || fail "bootstrap select-skills should pass --text"
grep -q '_B_SKILL_TEXT="\$(printf .%s\\n%s. "\${TITLE:-}"' "$RUNNER_DIR/tick.sh" \
  && ok "the bootstrap text is the ticket title + description head" \
  || fail "_B_SKILL_TEXT should be built from TITLE + description"
D_LINE="$(grep -n 'SKILLS="\$(node "\$HERE/bin/select-skills.mjs"' "$RUNNER_DIR/tick.sh" | grep -v B_SKILLS | head -1)"
printf '%s' "$D_LINE" | grep -q -- '--text "\$_SKILL_TEXT"' \
  && ok "delivery path still passes --text (the two paths agree)" || fail "delivery select-skills lost --text"
# The selector itself: a brief that names an off-domain pack pulls it in via --text.
SEL="$(node "$RUNNER_DIR/bin/select-skills.mjs" --stack node --text "Bootstrap a new command-line tool with subcommands and flags" --skills-dir "$RUNNER_DIR/skills" 2>/dev/null)"
printf '%s' "$SEL" | grep -q 'add-cli-command' \
  && ok "--text pulls a text-relevant pack (add-cli-command) into a bootstrap selection" \
  || fail "expected add-cli-command in: $SEL"

echo "== 2: fg skills --stack returns REAL library skills (the tick.sh fallback) =="
CREW_CLI="$ROOT/packages/crew/dist/cli/index.js"
if [ -f "$CREW_CLI" ]; then
  mkdir -p "$WORK/factory"
  node "$CREW_CLI" init --dir "$WORK/factory" -n skills-wiring >/dev/null 2>&1 || true
  if [ -f "$WORK/factory/crew.yaml" ]; then
    OUT="$(node "$CREW_CLI" -c "$WORK/factory/crew.yaml" skills --stack typescript-react 2>/dev/null)"
    IDS="$(printf '%s' "$OUT" | node "$RUNNER_DIR/lib/json-tool.mjs" expr '(Array.isArray(d) ? d : d.skills || []).map((s) => s.id ?? s.name ?? "").join(", ")' 2>/dev/null || true)"
    printf '%s' "$IDS" | grep -q 'typescript-conventions' \
      && ok "fg skills --stack typescript-react lists typescript-conventions (library, stack expanded)" \
      || fail "fg skills should list typescript-conventions (got: ${IDS:0:200})"
    printf '%s' "$IDS" | grep -q 'react-patterns' \
      && ok "…and react-patterns (the compound label's second token)" || fail "fg skills should list react-patterns"
    printf '%s' "$IDS" | grep -q 'fix-bug' \
      && ok "…and a stack-agnostic library skill (fix-bug)" || fail "fg skills should list fix-bug"
    # The exact jget expression tick.sh uses yields a non-empty comma list.
    [ -n "$IDS" ] && ok "tick.sh's fallback expression yields a non-empty skill list" || fail "fallback expression yielded nothing"
  else
    echo "  SKIP: could not initialise a crew.yaml for the CLI probe"
  fi
else
  echo "  SKIP: crew not built ($CREW_CLI) — run: pnpm -C $ROOT/packages/crew build"
fi

echo "== 3: gaffer skills list describes ROLE-BASED selection =="
LIST="$(GAFFER_DATA="$WORK/data" bash "$RUNNER_DIR/gaffer" skills list 2>/dev/null)"
printf '%s' "$LIST" | grep -q 'auto-loads all of these' \
  && fail "gaffer skills list still claims the factory auto-loads every skill" \
  || ok "no more 'auto-loads all of these every ticket' claim"
printf '%s' "$LIST" | grep -q 'select-skills --role' \
  && ok "gaffer skills list names the role-based selector (select-skills --role)" \
  || fail "gaffer skills list should describe role-based selection (got: ${LIST:0:300})"
grep -q 'auto-loads' "$RUNNER_DIR/gaffer" \
  && fail "runner/gaffer still contains an 'auto-loads' claim" || ok "runner/gaffer has no 'auto-loads' wording left"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
