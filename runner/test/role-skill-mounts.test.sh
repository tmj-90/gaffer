#!/usr/bin/env bash
# =====================================================================
# Role skill mounts for the headless .mjs runners — what the agent can actually SEE.
# ---------------------------------------------------------------------
#   1. decompose (plan role) mounts by the brownfield target repo's registered STACK and
#      the BRIEF text. It used to pass neither, so the empty stack failed open: a Python
#      API's plan got swift-conventions, mobile-ui and the React state pack, and the plan
#      profile's text packs never fired. A stub claude lists its cwd's .claude/skills.
#   2. the run writes a skill-telemetry row (role plan) — the .mjs runners used to
#      record nothing.
#   3. merge-ticket's resolver gets the MERGE role's mount, not a symlink to the whole
#      library (marketing, slides, Terraform…).
#   4. every mount lands at .claude/skills/<name>/SKILL.md — beside a repo's OWN
#      .claude/skills, never clobbering a repo skill of the same name (the repo's wins
#      and the prompt says so) — and teardown removes only Gaffer's (shell + JS).
# No model calls: CLAUDE_BIN is a stub. Run: bash test/role-skill-mounts.test.sh
# =====================================================================
set -uo pipefail
# macOS has no coreutils `timeout`; perl's alarm is the portable bound.
bound() { if command -v timeout >/dev/null 2>&1; then timeout "$@"; else perl -e 'alarm shift; exec @ARGV' "$@"; fi; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 required"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }

PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/role-skill-mounts.XXXXXX")"; WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT
export GAFFER_DATA="$WORK/.gaffer"; mkdir -p "$GAFFER_DATA"
export GAFFER_LOG="$WORK/factory.log"
unset GAFFER_SKILL_TELEMETRY SKILLS_DIR

# Stub claude: record the skills visible from its cwd, then a minimal JSON envelope.
FAKE="$WORK/fake-claude"
cat > "$FAKE" <<EOS
#!/usr/bin/env bash
ls -1 "\$PWD/.claude/skills/" > "$WORK/mounted.txt" 2>/dev/null
printf '%s\n' '{"result":"used the plan-build skill","total_cost_usd":0.01,"num_turns":1}'
EOS
chmod +x "$FAKE"
export CLAUDE_BIN="$FAKE"

# A dispatch DB carrying just the repositories row decompose resolves.
export DISPATCH_DB="$WORK/dispatch.sqlite"
mkdir -p "$WORK/pyapi"
python3 - "$DISPATCH_DB" "$WORK/pyapi" <<'PY'
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
c.execute("CREATE TABLE repositories (name TEXT, local_path TEXT, stack TEXT)")
c.execute("INSERT INTO repositories VALUES ('pyapi', ?, 'python')", (sys.argv[2],))
c.commit()
PY

has() { grep -qx -- "$1" "$WORK/mounted.txt" 2>/dev/null; }

echo "== 1: decompose mounts by the target repo's stack + the brief text =="
rm -f "$WORK/mounted.txt"
bound 120 node "$RUNNER_DIR/bin/decompose.mjs" --repo pyapi \
  --brief 'Add an orders endpoint and write a runbook for rotating the database password' \
  >/dev/null 2>&1 </dev/null
[ -s "$WORK/mounted.txt" ] && ok "the stub agent ran in a home with a skill mount" || fail "no mount listing captured"
for want in plan-build python-conventions runbook-generator; do
  has "$want" && ok "plan mount has $want" || fail "plan mount lacks $want ($(paste -sd, "$WORK/mounted.txt" 2>/dev/null | cut -c1-300))"
done
for bad in swift-conventions mobile-ui frontend-state-management csharp-conventions; do
  has "$bad" && fail "plan mount for a python repo carries $bad" || ok "plan mount for a python repo has no $bad"
done

echo "== 2: the plan run is in the skill telemetry =="
TEL="$GAFFER_DATA/skills-telemetry.jsonl"
ROW="$(grep '"role":"plan"' "$TEL" 2>/dev/null | tail -1)"
[ -n "$ROW" ] && ok "a role=plan telemetry row was written" || fail "no plan telemetry row in $TEL"
grep -q '"python-conventions"' <<<"$ROW" && ok "…listing the mounted python-conventions" || fail "plan row lacks the mount: $ROW"
grep -q '"applied":\["plan-build"\]' <<<"$ROW" && ok "…and plan-build as applied (named in the output)" || fail "plan row applied wrong: $ROW"

echo "== 3: the merge resolver gets the merge role's mount, not the whole library =="
WT="$WORK/merge-wt"; mkdir -p "$WT"
TOTAL="$(ls -1d "$RUNNER_DIR"/skills/*/ | wc -l | tr -d ' ')"
OUT="$(cd "$WORK" && bound 60 node --input-type=module -e "
import { installProjectLocalWiring } from '$RUNNER_DIR/bin/merge-ticket.mjs';
import { lstatSync, readdirSync } from 'node:fs';
installProjectLocalWiring('$WT', 4242, 'pyapi', { stack: 'go' });
const names = readdirSync('$WT/.claude/skills').filter((n) => !n.startsWith('.'));
const real = lstatSync('$WT/.claude/skills').isDirectory() && !lstatSync('$WT/.claude/skills/go-conventions').isSymbolicLink();
console.log((real ? 'copies' : 'link') + '|' + names.join(','));
" 2>&1)"
LINK="${OUT%%|*}"; NAMES="${OUT#*|}"
[ "$LINK" = copies ] && ok "the resolver's .claude/skills holds real copies (no link into the library)" || fail "resolver mount is not copies ($OUT)"
for want in resolve-merge-conflict run-tests go-conventions; do
  grep -q "\(^\|,\)$want\(,\|$\)" <<<"$NAMES" && ok "merge mount has $want" || fail "merge mount lacks $want ($NAMES)"
done
for bad in seo-audit slides-deck terraform-patterns python-conventions; do
  grep -q "\(^\|,\)$bad\(,\|$\)" <<<"$NAMES" && fail "merge mount carries $bad" || ok "merge mount has no $bad"
done
N="$(tr ',' '\n' <<<"$NAMES" | grep -c .)"
[ "$N" -lt "$TOTAL" ] && ok "merge mount is a subset ($N of $TOTAL skills)" || fail "merge mount has $N of $TOTAL"

echo "== 4: mounts land at .claude/skills/<name>/SKILL.md, beside a repo's OWN skills =="
# The reviewer's case: a repo that ships .claude/skills/<its-own>/SKILL.md got Gaffer's
# set one directory too deep (.claude/skills/<mount-key>/<name>/), where Claude Code
# never looks. Real git, the REAL skills-mount lib (delivery / review / clarify /
# bootstrap) and the JS installer (tester / merge / planning homes).
export SKILLS_DIR="$RUNNER_DIR/skills"
# shellcheck source=../lib/skills-mount.sh
source "$RUNNER_DIR/lib/skills-mount.sh"
# shellcheck source=../lib/hygiene.sh
source "$RUNNER_DIR/lib/hygiene.sh"
OWN="$WORK/own-skills-repo"; mkdir -p "$OWN/.claude/skills/house-style" "$OWN/.claude/skills/record-evidence"
printf -- '---\nname: house-style\ndescription: the repo house style\n---\nHOUSE\n' > "$OWN/.claude/skills/house-style/SKILL.md"
printf -- '---\nname: record-evidence\ndescription: the repo own evidence rules\n---\nREPO-EVIDENCE\n' > "$OWN/.claude/skills/record-evidence/SKILL.md"
printf 'x\n' > "$OWN/README.md"
( cd "$OWN" && git init -q -b main && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init )
OWT="$WORK/own-wt"; git -C "$OWN" worktree add -q --detach "$OWT" HEAD
gaffer_exclude_runner_config "$OWT"
gaffer_skills_mount "$OWT" "java-conventions, record-evidence" "delivery-9"
SK="$OWT/.claude/skills"
[ -f "$SK/java-conventions/SKILL.md" ] && ok "4: java-conventions/SKILL.md is at .claude/skills/java-conventions/" || fail "4: java-conventions not at .claude/skills/java-conventions/SKILL.md ($(ls -A "$SK" | paste -sd, -))"
[ -f "$SK/minimalism/SKILL.md" ] && ok "4: the universal set is at .claude/skills/<name>/ too" || fail "4: minimalism missing from .claude/skills/"
[ ! -e "$SK/delivery-9" ] && ok "4: nothing is mounted one level too deep" || fail "4: a .claude/skills/delivery-9 entry exists"
[ -z "$(ls -d "$SK"/*/*/SKILL.md 2>/dev/null)" ] && ok "4: every SKILL.md is exactly .claude/skills/<name>/SKILL.md" || fail "4: a SKILL.md sits deeper than .claude/skills/<name>/"
grep -qx HOUSE "$SK/house-style/SKILL.md" && ok "4: the repo's own skill is untouched" || fail "4: the repo's house-style skill changed"
grep -qx REPO-EVIDENCE "$SK/record-evidence/SKILL.md" && ok "4: name collision: the repo's record-evidence wins (not clobbered)" || fail "4: Gaffer overwrote the repo's record-evidence"
[ ! -e "$GAFFER_DATA/skills-mounts/delivery-9/record-evidence" ] && [ -e "$GAFFER_DATA/skills-mounts/delivery-9/java-conventions" ] \
  && ok "4: the manifest (telemetry's mount) lists what Gaffer installed, not the repo's skill" || fail "4: manifest wrong: $(ls "$GAFFER_DATA/skills-mounts/delivery-9" | paste -sd, -)"
NOTE="$(gaffer_skills_note "$OWT" "java-conventions, record-evidence")"
case "$NOTE" in *"take precedence over Gaffer's pack: record-evidence"*) ok "4: the prompt note names the shadowed skill" ;; *) fail "4: prompt note: '$NOTE'" ;; esac
# record-evidence is in the universal set, so it is shadowed even when not selected;
# the repo's house-style is not a library name, so it is never called shadowed.
[ "$(gaffer_skills_shadowed "$OWT" "java-conventions")" = record-evidence ] \
  && ok "4: only a same-name repo skill is called shadowed" || fail "4: shadowed: $(gaffer_skills_shadowed "$OWT" "java-conventions")"
[ -z "$(git -C "$OWT" status --porcelain 2>/dev/null)" ] && ok "4: git sees no change (tracked skills intact, copies excluded)" || fail "4: git status: $(git -C "$OWT" status --porcelain | paste -sd'|' -)"
gaffer_skills_mount "$OWT" "python-conventions" "delivery-9"
[ -f "$SK/python-conventions/SKILL.md" ] && [ ! -e "$SK/java-conventions" ] && grep -qx HOUSE "$SK/house-style/SKILL.md" \
  && ok "4: a re-mount swaps Gaffer's copies only" || fail "4: re-mount: $(ls -A "$SK" | paste -sd, -)"
for t in tick.sh lib/review.sh; do
  grep -q 'gaffer_skills_note' "$RUNNER_DIR/$t" && ok "4: $t puts the shadow note in its prompt" || fail "4: $t does not use gaffer_skills_note"
done
grep -q 'shadowNote(shadowedSkills' "$RUNNER_DIR/bin/tester-run.mjs" && ok "4: the tester prompt carries the shadow note" || fail "4: tester-run lacks the shadow note"

# …and the RENDERED delivery prompt (the real seam tick.sh calls) carries that note on
# its recommended-skills line.
if [ -f "$RUNNER_DIR/../packages/crew/dist/runtime/context/renderPromptCli.js" ]; then
  RENDERED="$(
    export DISPATCH_DB="$WORK/d.sqlite" MEMORY_DB="$WORK/m.sqlite"
    # shellcheck source=../factory.config.sh
    source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
    NUM=9; TITLE="Round totals"; SKILLS="java-conventions, record-evidence"; LENSES="minimalism"
    FILE_CARDS_BLOCK=""; PRODUCT_CONTEXT_BLOCK=""; _RF=""; _RD=""; READ_ROOTS=""
    WORK_BRANCH="gaffer/ticket-9-round"; PRIMARY_REPO="$OWT"
    WT_ROWS="$(printf 'id\town\t%s\tmain\t%s' "$OWN" "$OWT")"
    SKILLS_NOTE="$(gaffer_skills_note "$PRIMARY_REPO" "$SKILLS, $LENSES")"
    gaffer_render_delivery_prompt fresh 2>&1
  )"
  grep -q "Recommended skills.*java-conventions, record-evidence (this repo has its own .claude/skills of the same name, which take precedence over Gaffer's pack: record-evidence" <<<"$RENDERED" \
    && ok "4: the rendered delivery prompt says the repo's record-evidence wins" || fail "4: rendered prompt lacks the note: $(grep 'Recommended skills' <<<"$RENDERED" | cut -c1-300)"
else
  ok "4: (crew not built — rendered-prompt check skipped)"
fi

echo "== 4b: teardown removes Gaffer's skills and never the repo's =="
gaffer_skills_mount_cleanup "delivery-9" "$OWT"
[ ! -e "$SK/python-conventions" ] && [ ! -e "$SK/minimalism" ] && ok "4b: Gaffer's copies are gone" || fail "4b: copies survived: $(ls -A "$SK" | paste -sd, -)"
grep -qx HOUSE "$SK/house-style/SKILL.md" && grep -qx REPO-EVIDENCE "$SK/record-evidence/SKILL.md" \
  && ok "4b: the repo's own skills are intact" || fail "4b: teardown touched the repo's skills"
[ -z "$(git -C "$OWT" status --porcelain 2>/dev/null)" ] && ok "4b: git status clean after teardown" || fail "4b: git status: $(git -C "$OWT" status --porcelain | paste -sd'|' -)"

echo "== 4c: a repo WITHOUT its own skills dir — Gaffer makes it, and removes it =="
PLAIN="$WORK/plain-repo"; mkdir -p "$PLAIN"
gaffer_skills_mount "$PLAIN" "java-conventions" "delivery-10"
[ -f "$PLAIN/.claude/skills/java-conventions/SKILL.md" ] && ok "4c: java-conventions/SKILL.md at .claude/skills/java-conventions/" || fail "4c: not mounted where Claude Code looks"
gaffer_skills_mount_cleanup "delivery-10" "$PLAIN"
[ ! -e "$PLAIN/.claude" ] && ok "4c: teardown leaves no .claude behind" || fail "4c: residue: $(find "$PLAIN/.claude" | paste -sd, -)"

echo "== 4d: a repo's .claude/skills SYMLINK is left alone (nothing copied through it) =="
LNK="$WORK/link-repo"; mkdir -p "$LNK/my-skills/own" "$LNK/.claude"; printf 'OWN\n' > "$LNK/my-skills/own/SKILL.md"
ln -s ../my-skills "$LNK/.claude/skills"
gaffer_skills_mount "$LNK" "java-conventions" "delivery-11" 2>/dev/null
[ "$(readlink "$LNK/.claude/skills")" = ../my-skills ] && [ ! -e "$LNK/my-skills/java-conventions" ] \
  && ok "4d: the repo link is intact and nothing landed outside .claude/" || fail "4d: $(ls -A "$LNK/my-skills" | paste -sd, -)"

echo "== 4e: the JS installer (tester / merge / planning homes) — same layout, same precedence =="
JWT="$WORK/own-wt-js"; git -C "$OWN" worktree add -q --detach "$JWT" HEAD
JOUT="$(cd "$WORK" && bound 60 node --input-type=module -e "
import { installSkillCopies, removeSkillCopies, shadowedSkills, shadowNote } from '$RUNNER_DIR/lib/agent-home.mjs';
import { existsSync, readFileSync } from 'node:fs';
const c = '$JWT/.claude', sk = c + '/skills';
const got = installSkillCopies(c, ['java-conventions', 'record-evidence', 'run-tests'], { skillsDir: '$RUNNER_DIR/skills', key: 'tester-9' });
const out = [];
out.push(existsSync(sk + '/java-conventions/SKILL.md') ? 'at-name' : 'missing');
out.push(readFileSync(sk + '/record-evidence/SKILL.md', 'utf8').includes('REPO-EVIDENCE') ? 'repo-wins' : 'clobbered');
out.push(readFileSync(sk + '/house-style/SKILL.md', 'utf8').includes('HOUSE') ? 'own-kept' : 'own-lost');
out.push('installed=' + got.join('+'));
out.push(shadowNote(shadowedSkills(c, ['java-conventions', 'record-evidence'])).includes('pack: record-evidence') ? 'note' : 'no-note');
removeSkillCopies(sk);
out.push(!existsSync(sk + '/java-conventions') && existsSync(sk + '/house-style/SKILL.md') && existsSync(sk + '/record-evidence/SKILL.md') ? 'teardown-ok' : 'teardown-bad');
console.log(out.join(' '));
" 2>&1)"
for w in at-name repo-wins own-kept installed=java-conventions+run-tests note teardown-ok; do
  case " $JOUT " in *" $w "*) ok "4e: $w" ;; *) fail "4e: expected $w ($JOUT)" ;; esac
done
[ -z "$(git -C "$JWT" status --porcelain --untracked-files=no 2>/dev/null)" ] && ok "4e: no tracked change in the repo" || fail "4e: git status: $(git -C "$JWT" status --porcelain | paste -sd'|' -)"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
fi
echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
