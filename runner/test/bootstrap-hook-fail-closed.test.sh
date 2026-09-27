#!/usr/bin/env bash
# =====================================================================
# BOOTSTRAP AGENT NEVER LAUNCHES WITHOUT THE SAFETY HOOK (fail closed).
# ---------------------------------------------------------------------
# The bug this pins: tick.sh's greenfield (create-a-repo) path rendered the
# bootstrap agent's `.claude/settings.json` with a bare `sed` and NO verification,
# while every other spawn site (delivery, rework, reviewer, clarify) goes through
# `gaffer_install_agent_dir` (lib/agent-env.sh), which renders AND verifies the
# PreToolUse safety-hook wiring and refuses the run on any failure. A bad template
# or a full disk could therefore launch the bootstrap agent — the one agent that is
# also permitted a dependency install — with no deterministic containment boundary.
#
# Drives the REAL tick.sh (DRY_RUN=0) against a hermetic STUB dispatch CLI that
# serves one ready bootstrap ticket, with a STUB claude that proves a spawn by
# writing a marker (no model, no spend):
#   NEG  CLAUDE_SETTINGS = a template WITHOUT the PreToolUse wiring →
#          • the tick logs the SAFETY refusal and yields TICK_RESULT=error
#          • the agent is NOT spawned (no marker)
#          • no unwired settings.json survives in the new repo
#          • the runner releases its claim back to `ready` and skips the ticket
#            this run (no infinite re-claim), so a human sees it, not a hang
#   POS  CLAUDE_SETTINGS = the real template → the SAME tick reaches the agent
#        spawn (marker present) with a VERIFIED settings.json naming the hook —
#        proving the negative case is not vacuous.
#   PIN  tick.sh no longer renders any settings.json with a bare `sed`; the
#        bootstrap block calls gaffer_install_agent_dir on $B_DIR.
# Requires node + git + the built crew package (the prompt/MCP renderers the
# positive control passes through). Run: bash runner/test/bootstrap-hook-fail-closed.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
TICK="$RUNNER_DIR/tick.sh"

command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v git  >/dev/null 2>&1 || { echo "SKIP: git required";  exit 0; }
[ -f "$ROOT/packages/crew/dist/runtime/context/renderPromptCli.js" ] \
  || { echo "SKIP: crew not built ($ROOT/packages/crew/dist) — run pnpm -r build"; exit 0; }

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/bootstrap-hook.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# ── STUB dispatch CLI: one ready BOOTSTRAP ticket (#7, no linked repo), a claim
#    token, and a recorder of every call (so the release can be asserted). ───────
DISPATCH_DIR="$WORK/dispatch"; mkdir -p "$DISPATCH_DIR/dist/cli"
WG_CALLS="$WORK/wg-calls.log"; : > "$WG_CALLS"
cat > "$DISPATCH_DIR/dist/cli/index.js" <<'JS'
const fs = require("node:fs");
let a = process.argv.slice(2);
if (a[0] === "--db") a = a.slice(2); // the runner's wg wrapper prepends --db <path>
fs.appendFileSync(process.env.WG_CALLS, JSON.stringify(a) + "\n");
const has = (...t) => t.every((x) => a.includes(x));
const out = (o) => process.stdout.write(JSON.stringify(o));
if (has("agent", "register")) out({ agent: { id: "stub-agent" } });
else if (has("ticket", "resume-requested")) out([]);
else if (has("ticket", "list", "-s", "ready")) out([{ number: 7, title: "Bootstrap newapp" }]);
else if (has("ticket", "list")) out([]);
else if (has("ticket", "show", "7"))
  out({
    ticket: { number: 7, title: "Bootstrap newapp", status: "ready", bootstrap: true, source: "newapp", risk_level: "low" },
    repositories: [],
  });
else if (has("claim-ticket")) out({ claimToken: "tok-7" });
else if (has("runner-release")) out({ ok: true });
else out({});
JS

# ── STUB claude: proves a spawn by writing a marker, records whether the settings
#    it would load (cwd = the new repo) name the safety hook, then emits the
#    envelope. (tick.sh removes the runner config from the scaffold after the run,
#    so the wiring must be observed AT SPAWN TIME, as the real agent would see it.) ──
MARKER="$WORK/agent-spawned.marker"
WIRED="$WORK/hook-wired.marker"
STUB="$WORK/stub-claude.sh"
cat > "$STUB" <<STUBSH
#!/usr/bin/env bash
: > "$MARKER"
if [ -f ./.claude/settings.json ] && grep -q '"PreToolUse"' ./.claude/settings.json \\
   && grep -qF "$RUNNER_DIR/safety-hook.mjs" ./.claude/settings.json; then : > "$WIRED"; fi
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"scaffolded"}'
STUBSH
chmod +x "$STUB"

# An UNWIRED settings template: valid JSON, no PreToolUse hook at all.
UNWIRED="$WORK/unwired-settings.json"
printf '{"permissions":{"allow":["Bash"]},"hooks":{}}\n' > "$UNWIRED"

GAFFER_DATA="$WORK/data"; mkdir -p "$GAFFER_DATA"
BOOT_ROOT="$WORK/git"
B_DIR="$BOOT_ROOT/newapp"

run_tick() {  # $@ = extra NAME=value; echoes combined stdout+stderr
  rm -f "$MARKER" "$WIRED"; : > "$WG_CALLS"; rm -rf "$BOOT_ROOT" "$GAFFER_DATA/.failed-tickets"
  env WG_CALLS="$WG_CALLS" \
      RUNNER_DIR="$RUNNER_DIR" GAFFER_DATA="$GAFFER_DATA" DISPATCH_DIR="$DISPATCH_DIR" \
      GAFFER_BOOTSTRAP_ROOT="$BOOT_ROOT" CLAUDE_BIN="$STUB" CLAUDE_FLAGS="" \
      DRY_RUN=0 REVIEW_MODE=human CLARIFY_DRAFTS_WHEN_IDLE=0 GAFFER_TESTING=0 \
      STRICT_MODE=0 GAFFER_STRICT_REQUIRE=0 SANDBOX_PROVIDER=none GAFFER_TICK_TIMEOUT=120 \
      "$@" timeout 300 bash "$TICK" 2>&1
}

echo "== NEG: an unwired settings template → the bootstrap agent is NOT launched =="
OUT="$(run_tick CLAUDE_SETTINGS="$UNWIRED")"
printf '%s' "$OUT" | grep -q 'SAFETY: agent-env install failed for bootstrap #7' \
  && ok "tick logs the SAFETY refusal for the bootstrap install" \
  || fail "no SAFETY refusal logged (got: $(printf '%s' "$OUT" | grep -E 'SAFETY|BOOTSTRAP|TICK_RESULT' | tail -5 | tr '\n' ' '))"
printf '%s' "$OUT" | grep -q 'TICK_RESULT=error' \
  && ok "tick yields TICK_RESULT=error (fail closed, not a silent launch)" \
  || fail "expected TICK_RESULT=error (got: $(printf '%s' "$OUT" | grep TICK_RESULT= || echo none))"
[ ! -f "$MARKER" ] \
  && ok "the bootstrap agent was NOT spawned (no marker)" \
  || fail "the bootstrap agent RAN without a verified safety-hook wiring"
[ ! -e "$B_DIR/.claude/settings.json" ] \
  && ok "no unwired settings.json survives in the new repo" \
  || fail "an unwired settings.json was left in $B_DIR (the agent could load it)"
! printf '%s' "$OUT" | grep -q 'bootstrap delivery for #7 finished' \
  && ok "the tick never reached the bootstrap delivery step" \
  || fail "the tick continued past the refused install"
grep -q '"runner-release","7","--to","ready"' "$WG_CALLS" \
  && ok "the runner released its claim back to ready (a human sees the ticket; nothing is stranded)" \
  || fail "no runner-release → ready call recorded (calls: $(tr '\n' ' ' < "$WG_CALLS" | cut -c1-300))"
[ -f "$GAFFER_DATA/.failed-tickets" ] && grep -qx 7 "$GAFFER_DATA/.failed-tickets" \
  && ok "the ticket is skip-listed for this run (no infinite re-claim of the same refusal)" \
  || fail "ticket #7 not recorded in the per-run skip file"
[ -d "$B_DIR/.git" ] \
  && ok "the git-initialised scaffold dir is left for a resumed attempt (target_ok resumes it)" \
  || fail "expected the baselined scaffold dir to remain at $B_DIR"

echo "== POS (control): the real template → the SAME tick reaches the agent spawn =="
OUT="$(run_tick CLAUDE_SETTINGS="$RUNNER_DIR/claude/settings.json")"
[ -f "$MARKER" ] \
  && ok "with a wired template the bootstrap agent IS spawned (the negative case is not vacuous)" \
  || fail "control: the bootstrap agent did not spawn with the real template (got: $(printf '%s' "$OUT" | grep -E 'SAFETY|BOOTSTRAP|MCP-RENDER|PROMPT-RENDER|TICK_RESULT' | tail -6 | tr '\n' ' '))"
[ -f "$WIRED" ] \
  && ok "at spawn time the new repo's settings.json named PreToolUse + the resolved safety-hook path (verified wiring)" \
  || fail "the agent saw no wired settings.json in $B_DIR at spawn time"
! printf '%s' "$OUT" | grep -q 'SAFETY: agent-env install failed' \
  && ok "no SAFETY refusal on the wired template" \
  || fail "the wired template was refused"

echo "== PIN: tick.sh renders no settings.json with a bare sed; the bootstrap uses the installer =="
BARE="$(grep -cE 'sed .*"\$CLAUDE_SETTINGS" *>' "$TICK" || true)"
[ "$BARE" = "0" ] \
  && ok "tick.sh has no bare \`sed … \"\$CLAUDE_SETTINGS\" >\` render left" \
  || fail "tick.sh still renders settings.json with a bare sed ($BARE site(s))"
grep -qE 'gaffer_install_agent_dir "\$B_DIR" "\$B_SKILLS" "bootstrap-\$NUM"' "$TICK" \
  && ok "the bootstrap block installs through gaffer_install_agent_dir (verified, fail closed)" \
  || fail "the bootstrap block does not call gaffer_install_agent_dir on \$B_DIR"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "bootstrap-hook-fail-closed: ALL $PASS checks passed"
  exit 0
fi
echo "bootstrap-hook-fail-closed: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
