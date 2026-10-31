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

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
fi
echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
