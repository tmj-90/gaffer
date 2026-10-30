#!/usr/bin/env bash
# =====================================================================
# B30 — skills leftovers: the bootstrap selector's text relevance and role profile, the
# empty-selection fallback, and `gaffer skills list` telling the truth.
# ---------------------------------------------------------------------
#   1. tick.sh's BOOTSTRAP skill selection passes the ticket title/description as
#      `--text`, like the delivery path (it passed none, so an off-domain pack the
#      brief plainly called for was unreachable from a bootstrap).
#   1b. the bootstrap selection is the `--role bootstrap` profile (CI / Docker / shell
#      scaffold packs), run from tick.sh's own line.
#   2. when the selector yields nothing, tick.sh recommends the universal mechanics
#      (GAFFER_UNIVERSAL_SKILLS) — never the crew registry's `fg skills`, which lists
#      role-only skills and names the library does not carry.
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
grep -q -- '--text "\$_B_SKILL_TEXT"' <<<"$B_LINE" \
  && ok "bootstrap passes --text (title + description head) like the delivery path" \
  || fail "bootstrap select-skills should pass --text"
grep -q '_B_SKILL_TEXT="\$(printf .%s\\n%s. "\${TITLE:-}"' "$RUNNER_DIR/tick.sh" \
  && ok "the bootstrap text is the ticket title + description head" \
  || fail "_B_SKILL_TEXT should be built from TITLE + description"
D_LINE="$(grep -n 'SKILLS="\$(node "\$HERE/bin/select-skills.mjs"' "$RUNNER_DIR/tick.sh" | grep -v B_SKILLS | head -1)"
grep -q -- '--text "\$_SKILL_TEXT"' <<<"$D_LINE" \
  && ok "delivery path still passes --text (the two paths agree)" || fail "delivery select-skills lost --text"
# The selector itself: a brief that names an off-domain pack pulls it in via --text.
SEL="$(node "$RUNNER_DIR/bin/select-skills.mjs" --stack node --text "Bootstrap a new command-line tool with subcommands and flags" --skills-dir "$RUNNER_DIR/skills" 2>/dev/null)"
grep -q 'add-cli-command' <<<"$SEL" \
  && ok "--text pulls a text-relevant pack (add-cli-command) into a bootstrap selection" \
  || fail "expected add-cli-command in: $SEL"

echo "== 1b: the bootstrap mounts the BOOTSTRAP role profile (scaffold packs) =="
grep -q -- '--role bootstrap' <<<"$B_LINE" \
  && ok "bootstrap select-skills passes --role bootstrap" || fail "bootstrap select-skills should pass --role bootstrap"
# Run tick.sh's own B_SKILLS line (not a copy) with its inputs stubbed.
B_CMD="$(sed -n 's/^[[:space:]]*\(B_SKILLS="\$(node "\$HERE\/bin\/select-skills.mjs".*\)$/\1/p' "$RUNNER_DIR/tick.sh" | head -1)"
B_OUT="$(HERE="$RUNNER_DIR" STACK=go B_AREA="" _B_SKILL_TEXT="Scaffold a Go CLI for gym sessions" SKILLS_DIR="$RUNNER_DIR/skills" \
  bash -c "$B_CMD"'; printf "%s" "$B_SKILLS"' 2>/dev/null)"
for want in ci-cd-pipeline docker-development shell-scripting go-conventions run-tests; do
  grep -qw -- "$want" <<<"$B_OUT" && ok "live bootstrap selection mounts $want" || fail "live bootstrap selection lacks $want (got: ${B_OUT:0:300})"
done
grep -qw -- create-branch <<<"$B_OUT" && fail "bootstrap mounted create-branch (the runner branches)" || ok "bootstrap does not mount create-branch"

echo "== 2: an empty selection falls back to the universal mechanics, never the crew registry =="
TICK_CODE="$(grep -vE '^[[:space:]]*#' "$RUNNER_DIR/tick.sh")"
grep -q 'fg skills' <<<"$TICK_CODE" \
  && fail "tick.sh still falls back to 'fg skills' (role-only + unknown names)" \
  || ok "tick.sh no longer calls 'fg skills'"
F_CMD="$(grep -E '^[[:space:]]*\[ -n "\$SKILLS" \] \|\| SKILLS=.*GAFFER_UNIVERSAL_SKILLS' "$RUNNER_DIR/tick.sh" | head -1)"
[ -n "$F_CMD" ] && ok "the delivery fallback line names GAFFER_UNIVERSAL_SKILLS" || fail "delivery fallback line not found"
# shellcheck source=../lib/skills-mount.sh
F_OUT="$(SKILLS="" bash -c 'source "$1/lib/skills-mount.sh"; eval "$2"; printf "%s" "$SKILLS"' _ "$RUNNER_DIR" "$F_CMD" 2>/dev/null)"
[ "$F_OUT" = "run-tests, run-lint, run-coverage, minimalism, self-review, record-evidence, prepare-digest-delta, plan-change" ] \
  && ok "an empty selection recommends the universal set (incl. plan-change)" || fail "fallback gave: '$F_OUT'"

echo "== 3: gaffer skills list describes ROLE-BASED selection =="
LIST="$(GAFFER_DATA="$WORK/data" bash "$RUNNER_DIR/gaffer" skills list 2>/dev/null)"
grep -q 'auto-loads all of these' <<<"$LIST" \
  && fail "gaffer skills list still claims the factory auto-loads every skill" \
  || ok "no more 'auto-loads all of these every ticket' claim"
grep -q 'select-skills --role' <<<"$LIST" \
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
