#!/usr/bin/env bash
# =====================================================================
# LIVE (opt-in): did Claude actually USE the skill Gaffer chose for it?
# ---------------------------------------------------------------------
# The routing suites prove each worker RECEIVES the right skills (a recording stub
# stands in for Claude). This one answers the remaining question with the real Claude
# Code CLI, through the real tick, on a tiny fixture repo:
#
#   each role's intended skill carries one harmless, distinctive instruction that exists
#   ONLY inside that skill — "include the token GAFFER-SKILL-<role>-<nonce> in your final
#   message" — and the test checks the observable result:
#     delivery  → prepare-digest-delta   (the delivery prompt mandates it)
#     reviewer  → review-ticket          (the review prompt names it)
#     tester    → black-box-test         (the tester's procedure)
#   PASS for a role = its recorded result carries ITS token (and no other role's), the
#   token is not in its prompt (so it can only have come from the skill), and the skill
#   telemetry row for that run lists the skill as mounted and never as refused.
#
# SKIPPED (exit 0) unless GAFFER_LIVE_SKILL_TEST=1, and SKIPPED when the CLI or its
# credentials are not usable; a skip prints exactly what the run needs. It spends real
# money: three short agent runs plus one tiny probe call. Set GAFFER_LIVE_SKILL_MODEL to
# the cheapest model your account offers; the cost is printed at the end.
#
# Run: GAFFER_LIVE_SKILL_TEST=1 GAFFER_LIVE_SKILL_MODEL=<cheap model> bash runner/test/live-skill-use.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"

needs() {
  cat <<'EOF'
  This live test needs:
    - GAFFER_LIVE_SKILL_TEST=1                 (opt-in: it makes real, paid model calls)
    - a Claude Code CLI: $CLAUDE_BIN or `claude` on PATH, where `claude --version` works
    - credentials that CLI can use (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, or a
      logged-in ~/.claude); checked with ONE tiny probe call before anything else runs
    - GAFFER_LIVE_SKILL_MODEL=<model>          (strongly recommended: the cheapest model
      you have; without it every call uses the CLI's default model)
    - node and git, and the built packages (pnpm -r build): packages/dispatch/dist,
      packages/memory/dist, packages/crew/dist
  Optional: GAFFER_LIVE_SKILL_TURNS (max turns per agent run, default 30),
            GAFFER_LIVE_SKILL_TIMEOUT (seconds per agent run, default 900), KEEP=1.
EOF
}
skip() { echo "SKIP: $1"; needs; exit 0; }

[ "${GAFFER_LIVE_SKILL_TEST:-0}" = 1 ] || skip "GAFFER_LIVE_SKILL_TEST is not set to 1 (this test makes real model calls)"
command -v node >/dev/null 2>&1 || skip "node is not on PATH"
command -v git >/dev/null 2>&1 || skip "git is not on PATH"
for f in packages/dispatch/dist/cli/index.js packages/memory/dist/bin/memory.js packages/crew/dist/cli/index.js; do
  [ -f "$ROOT/$f" ] || skip "$f is not built (run pnpm -r build)"
done
REAL_CLAUDE="${CLAUDE_BIN:-claude}"
command -v "$REAL_CLAUDE" >/dev/null 2>&1 || skip "no Claude Code CLI ('$REAL_CLAUDE' is not on PATH)"
REAL_CLAUDE="$(command -v "$REAL_CLAUDE")"
"$REAL_CLAUDE" --version >/dev/null 2>&1 || skip "'$REAL_CLAUDE --version' failed"
# shellcheck source=../lib/claude-auth.sh
source "$RUNNER_DIR/lib/claude-auth.sh"
gaffer_claude_auth_probe; _auth=$?
[ "$_auth" = 1 ] && skip "no credential is visible to the CLI"
if [ -n "${GAFFER_LIVE_SKILL_MODEL:-}" ]; then export ANTHROPIC_MODEL="$GAFFER_LIVE_SKILL_MODEL"; fi
CLAUDE_BIN="$REAL_CLAUDE" gaffer_claude_live_probe 90 || skip "the CLI could not answer a probe call: ${GAFFER_CLAUDE_LIVE_ERROR:-no answer}"
echo "live: $("$REAL_CLAUDE" --version 2>/dev/null | head -1); model: ${GAFFER_LIVE_SKILL_MODEL:-the CLI default}"

PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/live-skill-use.XXXXXX")"; WORK="$(cd "$WORK" && pwd -P)"
[ "${KEEP:-0}" = 1 ] || trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/data" "$WORK/bin" "$WORK/calls"
CALLS="$WORK/calls"
NONCE="$(date +%s)$$"

# ── the skill library, with one distinctive instruction per role's intended skill ──
cp -R "$RUNNER_DIR/skills" "$WORK/skills"
plant() { # <skill> <role>
  cat >> "$WORK/skills/$1/SKILL.md" <<EOF

## Live skill check (Gaffer test fixture)

This run is a check that this skill was read. When you write your final message,
include this exact token on its own line, before any verdict line:
GAFFER-SKILL-$2-$NONCE
It is harmless: it changes nothing else you do.
EOF
}
plant prepare-digest-delta delivery
plant review-ticket review
plant black-box-test tester
TOKENS="delivery review tester"

# ── the recording shim: the REAL CLI, with the chosen model, every result kept ──────
cat > "$WORK/bin/claude" <<'SHIM'
#!/usr/bin/env bash
REAL="__REAL__"; CALLS="__CALLS__"; MODEL="__MODEL__"
args=(); prompt=""; prev=""; skipnext=0
for a in "$@"; do
  if [ "$skipnext" = 1 ]; then skipnext=0; prev="$a"; continue; fi
  if [ "$a" = "--model" ] && [ -n "$MODEL" ]; then skipnext=1; prev="$a"; continue; fi
  [ "$prev" = "-p" ] && prompt="$a"
  args+=("$a"); prev="$a"
done
[ -n "$MODEL" ] && args=(--model "$MODEL" "${args[@]}")
n="$(ls -1 "$CALLS" 2>/dev/null | wc -l | tr -d ' ')"; n=$((n + 1))
D="$CALLS/$(printf '%03d' "$n")"; mkdir -p "$D"
printf '%s' "$prompt" > "$D/prompt"; pwd -P > "$D/cwd"
case "$prompt" in
  *"SECURITY REVIEWER"*) echo security > "$D/kind" ;;
  *"REVIEWER agent"*) echo review > "$D/kind" ;;
  *"INDEPENDENT TESTER agent"*) echo tester > "$D/kind" ;;
  *) if [ -e .git ]; then echo delivery > "$D/kind"; else echo other > "$D/kind"; fi ;;
esac
"$REAL" "${args[@]}" > "$D/out"; rc=$?
cat "$D/out"
exit "$rc"
SHIM
sed -i.bak "s|__REAL__|$REAL_CLAUDE|; s|__CALLS__|$CALLS|; s|__MODEL__|${GAFFER_LIVE_SKILL_MODEL:-}|" "$WORK/bin/claude" \
  && rm -f "$WORK/bin/claude.bak"; chmod +x "$WORK/bin/claude"

# ── a tiny fixture repo ─────────────────────────────────────────────────────────
R="$WORK/calc"; mkdir -p "$R/src" "$R/test"
( cd "$R" && git init -q -b main
  printf '{ "name": "calc", "version": "0.1.0", "private": true, "type": "module", "scripts": { "test": "node --test", "lint": "node -e 0" } }\n' > package.json
  printf 'export function add(a, b) { return a + b; }\n' > src/math.js
  printf 'import test from "node:test"; import assert from "node:assert/strict";\nimport { add } from "../src/math.js";\ntest("add", () => { assert.equal(add(2, 3), 5); });\n' > test/math.test.js
  git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init )

export GAFFER_DATA="$WORK/data" CLAUDE_BIN="$WORK/bin/claude" SKILLS_DIR="$WORK/skills" \
       GAFFER_TICK_TIMEOUT="${GAFFER_LIVE_SKILL_TIMEOUT:-900}" GAFFER_MAX_TURNS="${GAFFER_LIVE_SKILL_TURNS:-30}" \
       REVIEW_MODE=human DRY_RUN=0 GAFFER_MAINTENANCE=0 AUTO_MERGE=0 GAFFER_STRICT_REQUIRE=0 \
       GAFFER_SECURITY_REVIEW=0 GAFFER_TESTING=0
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
wg init >/dev/null 2>&1; lg init >/dev/null 2>&1
wg repo add -n calc --path "$R" --branch main --stack javascript --test "npm test" --lint "npm run lint" >/dev/null 2>&1
st() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.status'; }
tick() { ( cd "$RUNNER_DIR" && env "$@" bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) >/dev/null || true; }
last_call() { grep -lx "$1" "$CALLS"/*/kind 2>/dev/null | tail -1 | xargs -I{} dirname {}; }
# tel <role> <ticket> <field> — that field of the run's last skill-telemetry row.
tel() {
  node -e '
    const [file, role, ticket, field] = process.argv.slice(1);
    let rows = [];
    try { rows = require("fs").readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch {}
    const row = rows.filter((r) => r.role === role && String(r.ticket) === ticket).pop();
    process.stdout.write(row ? (row[field] || []).join(",") : "NO-ROW");
  ' "$GAFFER_DATA/skills-telemetry.jsonl" "$1" "$2" "$3"
}
# check_role <label> <calldir> <token-role> <telemetry-role> <skill>
check_role() {
  local label="$1" d="$2" me="$3" trole="$4" skill="$5" tok other sel
  if [ -z "$d" ]; then fail "$label: the agent never ran"; return; fi
  tok="GAFFER-SKILL-$me-$NONCE"
  if grep -qF -- "$tok" "$d/prompt"; then fail "$label: the token leaked into the prompt (test is void)"; return; fi
  grep -qF -- "$tok" "$d/out" && ok "$label: the recorded result carries $tok (the $skill instruction was followed)" \
    || fail "$label: no $tok in the recorded result — $skill was not used ($(head -c 300 "$d/out"))"
  for other in $TOKENS; do
    [ "$other" = "$me" ] && continue
    grep -qF -- "GAFFER-SKILL-$other-$NONCE" "$d/out" && fail "$label: carries the $other token (not distinctive)"
  done
  sel="$(tel "$trole" "$TN" selected)"
  case ",$sel," in *",$skill,"*) ok "$label: telemetry row lists $skill as mounted" ;; *) fail "$label: telemetry selected lacks $skill ($sel)" ;; esac
  case ",$(tel "$trole" "$TN" refused)," in *",$skill,"*) fail "$label: telemetry says the read of $skill was REFUSED" ;; *) ok "$label: no refused read of $skill" ;; esac
  echo "       telemetry: opened=[$(tel "$trole" "$TN" opened)] applied=[$(tel "$trole" "$TN" applied)]"
}

echo "== delivery =="
TN="$(wg ticket create -t "Add a subtract helper" -d "Add subtract(a, b) to src/math.js, exported beside add, with a node:test test." --risk low 2>/dev/null | jget 'd.ticket.number')"
wg ac add "$TN" -t "subtract(5, 3) returns 2 and is covered by a test" >/dev/null 2>&1
wg ticket repo-access set "$TN" calc --access write --relation confirmed >/dev/null 2>&1
wg ticket set-testable "$TN" >/dev/null 2>&1
wg ticket ready "$TN" >/dev/null 2>&1
tick GAFFER_TESTING=0
[ "$(st "$TN")" = in_review ] && ok "delivery: #$TN delivered → in_review" || fail "delivery: #$TN is '$(st "$TN")'"
check_role "delivery" "$(last_call delivery)" delivery delivery prepare-digest-delta

echo "== reviewer =="
rm -f "$GAFFER_DATA/.reviewed-tickets"
tick REVIEW_MODE=agent DISPATCH_ALLOW_AGENT_APPROVE=1 GAFFER_TESTING=1
check_role "reviewer" "$(last_call review)" review review review-ticket

echo "== tester =="
if [ "$(st "$TN")" = in_testing ]; then
  tick GAFFER_TESTING=1
  check_role "tester" "$(last_call tester)" tester test black-box-test
else
  fail "tester: #$TN is '$(st "$TN")', not in_testing (the reviewer did not approve), so the tester could not run"
fi

COST="$(cat "$CALLS"/*/out 2>/dev/null | node -e '
  let t = 0; for (const l of require("fs").readFileSync(0, "utf8").split("\n")) {
    try { const j = JSON.parse(l); if (typeof j.total_cost_usd === "number") t += j.total_cost_usd; } catch {}
  } process.stdout.write(t.toFixed(4));' 2>/dev/null || echo "?")"
echo
echo "COST: \$$COST across $(ls -1 "$CALLS" | wc -l | tr -d ' ') agent runs (model: ${GAFFER_LIVE_SKILL_MODEL:-the CLI default}; plus one probe call)"
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
