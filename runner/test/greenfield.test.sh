#!/usr/bin/env bash
# =====================================================================
# GREENFIELD bootstrap "create-a-repo" helpers (lib/greenfield.sh).
# ---------------------------------------------------------------------
# Proves, against the REAL functions:
#   AC1  gaffer_bootstrap_repo_name derives a slug from name/source/title
#   AC2  gaffer_bootstrap_repo_dir computes <root>/<name> from GAFFER_BOOTSTRAP_ROOT
#   AC3  gaffer_bootstrap_repo_dir REFUSES a traversal name (slash / ..)
#   AC4  gaffer_bootstrap_target_ok ALLOWS a missing dir and an empty dir
#   AC5  gaffer_bootstrap_target_ok REFUSES a non-empty existing dir
#   AC6  gaffer_bootstrap_init mkdir + git init (idempotent), HEAD=main
#   AC7  the bootstrap config keys are present + commented in factory.config.sh
#   AC8  tick.sh wires the bootstrap branch (detects ticket.bootstrap, no branch)
#
# Zero deps; needs only git + python3. Run: bash test/greenfield.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

# shellcheck source=../lib/greenfield.sh
source "$RUNNER_DIR/lib/greenfield.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/greenfield-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

echo "== AC1: gaffer_bootstrap_repo_name derives a slug =="
# From an explicitly-linked repo name (highest priority).
N="$(gaffer_bootstrap_repo_name '{"ticket":{"title":"x","source":null},"repositories":[{"name":"Gym Tracker"}]}')"
[ "$N" = "gym-tracker" ] && ok "repo name from repositories[0].name → '$N'" || fail "name slug wrong (got '$N')"
# From source when no linked repo.
N="$(gaffer_bootstrap_repo_name '{"ticket":{"title":"x","source":"My App!!"},"repositories":[]}')"
[ "$N" = "my-app" ] && ok "repo name from ticket.source → '$N'" || fail "source slug wrong (got '$N')"
# From title as last resort.
N="$(gaffer_bootstrap_repo_name '{"ticket":{"title":"Bootstrap the Widget Co","source":null},"repositories":[]}')"
[ "$N" = "bootstrap-the-widget-co" ] && ok "repo name from title → '$N'" || fail "title slug wrong (got '$N')"

echo "== AC2: gaffer_bootstrap_repo_dir computes <root>/<name> =="
D="$(GAFFER_BOOTSTRAP_ROOT="$WORK/git" gaffer_bootstrap_repo_dir "gym-tracker")"
[ "$D" = "$WORK/git/gym-tracker" ] && ok "dir = \$GAFFER_BOOTSTRAP_ROOT/<name> → '$D'" || fail "dir wrong (got '$D')"

echo "== AC3: gaffer_bootstrap_repo_dir refuses traversal =="
if gaffer_bootstrap_repo_dir "../evil" >/dev/null 2>&1; then fail "'../evil' should be refused"; else ok "'../evil' refused"; fi
if gaffer_bootstrap_repo_dir "a/b" >/dev/null 2>&1; then fail "'a/b' should be refused"; else ok "'a/b' (slash) refused"; fi
if gaffer_bootstrap_repo_dir "" >/dev/null 2>&1; then fail "empty name should be refused"; else ok "empty name refused"; fi

echo "== AC4: gaffer_bootstrap_target_ok allows missing + empty dir =="
gaffer_bootstrap_target_ok "$WORK/does-not-exist" >/dev/null 2>&1 \
  && ok "missing dir → ok (will mkdir)" || fail "missing dir should be ok"
EMPTY="$WORK/empty"; mkdir -p "$EMPTY"
gaffer_bootstrap_target_ok "$EMPTY" >/dev/null 2>&1 \
  && ok "empty existing dir → ok" || fail "empty dir should be ok"

echo "== AC5: gaffer_bootstrap_target_ok refuses a non-empty existing dir =="
NONEMPTY="$WORK/used"; mkdir -p "$NONEMPTY"; echo hi > "$NONEMPTY/file.txt"
if R="$(gaffer_bootstrap_target_ok "$NONEMPTY")"; then
  fail "non-empty dir should be refused"
else
  ok "non-empty dir refused with reason: $R"
fi
# Also refuses a non-directory existing path.
touch "$WORK/afile"
if gaffer_bootstrap_target_ok "$WORK/afile" >/dev/null 2>&1; then fail "existing file should be refused"; else ok "existing non-dir refused"; fi

echo "== AC9: gaffer_bootstrap_target_ok RESUMES our failed-bootstrap scaffold, not real content =="
# Resumable scaffold: a git repo with NO commits and only factory-scaffold files —
# exactly what a bootstrap that died before committing leaves behind.
SCAF="$WORK/scaffold"; mkdir -p "$SCAF/.claude"; git -C "$SCAF" init -q -b main >/dev/null 2>&1
touch "$SCAF/CLAUDE.factory.md"
gaffer_bootstrap_target_ok "$SCAF" 2>/dev/null \
  && ok "scaffold (git, no commits, factory files only) → resume in place" \
  || fail "resumable scaffold should be allowed"
# A non-factory file in it → real content → must refuse (never clobber real work).
echo "console.log(1)" > "$SCAF/index.js"
if gaffer_bootstrap_target_ok "$SCAF" >/dev/null 2>&1; then fail "scaffold + real file should be refused"; else ok "scaffold + a real file refused"; fi
rm -f "$SCAF/index.js"
# Any commit → treat as real work → must refuse.
git -C "$SCAF" add -A >/dev/null 2>&1
git -C "$SCAF" -c user.email=t@t -c user.name=t commit -qm scaffold >/dev/null 2>&1
if gaffer_bootstrap_target_ok "$SCAF" >/dev/null 2>&1; then fail "committed repo should be refused"; else ok "committed repo (real work) refused"; fi

echo "== AC6: gaffer_bootstrap_init mkdir + git init (idempotent) =="
NEW="$WORK/git/gym-tracker"
gaffer_bootstrap_init "$NEW" >/dev/null 2>&1 \
  && [ -d "$NEW/.git" ] && ok "init created git repo at $NEW" || fail "init did not create a git repo"
HEADREF="$(git -C "$NEW" symbolic-ref --short HEAD 2>/dev/null || echo '')"
[ "$HEADREF" = "main" ] && ok "default branch is 'main'" || fail "default branch should be main (got '$HEADREF')"
# Idempotent: a second init on the same dir is a no-op success.
gaffer_bootstrap_init "$NEW" >/dev/null 2>&1 && ok "re-init is idempotent (no-op success)" || fail "re-init should succeed"

echo "== AC6b: bootstrap default-branch capture is clean on an UNBORN repo (E2E regression) =="
# REGRESSION: tick.sh captures B_DEFAULT_BRANCH BEFORE the agent's first commit — i.e.
# on an UNBORN repo. There `git rev-parse --abbrev-ref HEAD` prints "HEAD" to stdout AND
# exits non-zero, so `… || echo main` APPENDS, yielding the newline-joined garbage
# "HEAD\nmain". That fails 'repo add's git-ref-safe branch validation, so the whole
# greenfield onboard reports FAILED and the sibling tickets never get wired. The fix is
# `git symbolic-ref --short HEAD`, which returns a clean "main" for unborn + committed.
UNB="$WORK/git/unborn-repo"; mkdir -p "$UNB"; git -C "$UNB" init -q 2>/dev/null
_newbr="$(git -C "$UNB" symbolic-ref --short HEAD 2>/dev/null || echo main)"
[ "$_newbr" = "main" ] \
  && ok "symbolic-ref yields a clean 'main' on an unborn repo" \
  || fail "symbolic-ref should yield 'main' on unborn (got '$(printf %q "$_newbr")')"
[ "$(printf '%s' "$_newbr" | wc -l | tr -d ' ')" = "0" ] \
  && ok "captured branch has no embedded newline (the exact failure signature)" \
  || fail "captured branch must be single-line (got '$(printf %q "$_newbr")')"
grep -q 'B_DEFAULT_BRANCH="\$(git -C "\$B_DIR" symbolic-ref --short HEAD' "$RUNNER_DIR/tick.sh" \
  && ok "tick.sh captures B_DEFAULT_BRANCH via symbolic-ref (fix guarded in place)" \
  || fail "tick.sh must use symbolic-ref for B_DEFAULT_BRANCH (regression guard)"

echo "== AC7: bootstrap config keys present + commented =="
grep -Eq '^: "\$\{GAFFER_BOOTSTRAP_ROOT:=' "$RUNNER_DIR/factory.config.sh" \
  && ok "GAFFER_BOOTSTRAP_ROOT default present in factory.config.sh" \
  || fail "GAFFER_BOOTSTRAP_ROOT default missing"
grep -q 'GAFFER_BOOTSTRAP_INSTALL' "$RUNNER_DIR/factory.config.sh" \
  && ok "GAFFER_BOOTSTRAP_INSTALL documented in factory.config.sh" \
  || fail "GAFFER_BOOTSTRAP_INSTALL not documented"
grep -q 'lib/greenfield.sh' "$RUNNER_DIR/factory.config.sh" \
  && ok "lib/greenfield.sh sourced from factory.config.sh" \
  || fail "lib/greenfield.sh not sourced"

echo "== AC8: tick.sh wires the bootstrap create-a-repo branch =="
grep -q "ticket'\].get('bootstrap')" "$RUNNER_DIR/tick.sh" \
  && ok "tick.sh reads ticket.bootstrap" || fail "tick.sh does not read ticket.bootstrap"
grep -q 'gaffer_bootstrap_repo_dir' "$RUNNER_DIR/tick.sh" \
  && ok "tick.sh derives the new repo dir" || fail "tick.sh does not derive the repo dir"
grep -q 'gaffer_bootstrap_onboard' "$RUNNER_DIR/tick.sh" \
  && ok "tick.sh registers + onboards the new repo" || fail "tick.sh does not onboard the new repo"
grep -q 'GAFFER_BOOTSTRAP_INSTALL=1' "$RUNNER_DIR/tick.sh" \
  && ok "tick.sh exports the scoped install allowance for the bootstrap tick" \
  || fail "tick.sh does not export GAFFER_BOOTSTRAP_INSTALL"
grep -q 'gaffer_inherit_repo' "$RUNNER_DIR/tick.sh" \
  && ok "tick.sh wires gaffer_inherit_repo after a successful onboard" \
  || fail "tick.sh does not call gaffer_inherit_repo"

echo "== AC10: gaffer_inherit_repo applies the planner's links via the wg CLI =="
# Stub `wg`, `node` (the planner), and `claude` so the bash plumbing is exercised
# without touching a real DB or spawning a real model. The stub planner emits a
# fixed plan: one deterministic link (#62→auto-trader) + one ambiguous sibling
# (#30, candidate auto-trader). The stub `wg` records every invocation to a file.
INH_WORK="$(mktemp -d "${TMPDIR:-/tmp}/inherit-test.XXXXXX")"
BIN="$INH_WORK/bin"; mkdir -p "$BIN"
WG_LOG="$INH_WORK/wg.log"; CLAUDE_LOG="$INH_WORK/claude.log"

cat >"$BIN/wg" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$WG_LOG"
exit 0
EOF
chmod +x "$BIN/wg"

# Stub planner: ignore args, print the canned plan JSON. Selected by shadowing the
# resolved planner path is awkward, so instead we shadow `node` to emit the plan
# whenever it is asked to run inherit-repo.mjs.
cat >"$BIN/node" <<EOF
#!/usr/bin/env bash
case "\$*" in
  *inherit-repo.mjs*)
    cat <<'JSON'
{"phase":"plan","epic":{"id":"e1","name":"Auto-Trader"},"bootstrapCount":2,
 "links":[{"ticket":62,"ticketId":"t62","repo":"auto-trader","reason":"single"}],
 "ambiguous":[{"ticket":30,"ticketId":"t30","candidates":[{"repo":"auto-trader","purpose":"web"}],
   "argv":["-p","pick","--mcp-config","/tmp/m.json","--model","opus"],"model":"opus","claudeBin":"claude"}],
 "unresolved":[]}
JSON
    ;;
  *) exec /usr/bin/env node "\$@" ;;
esac
EOF
chmod +x "$BIN/node"

# Stub claude: answer with a valid candidate so the ambiguous link is applied.
cat >"$BIN/claude" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$CLAUDE_LOG"
echo "auto-trader"
EOF
chmod +x "$BIN/claude"

(
  export PATH="$BIN:$PATH"
  export DISPATCH_DB="$INH_WORK/wg.sqlite"; : > "$DISPATCH_DB"
  export CLAUDE_BIN="claude"
  # Live mode: deterministic link + the ambiguous claude decision both apply.
  gaffer_inherit_repo 61 >/dev/null 2>&1
)
if grep -q "ticket repo-access set 62 auto-trader --access write" "$WG_LOG"; then
  ok "deterministic link applied via 'wg ticket repo-access set 62 auto-trader --access write'"
else
  fail "deterministic link not applied (wg.log: $(cat "$WG_LOG" 2>/dev/null))"
fi
if grep -q "ticket repo-access set 30 auto-trader --access write" "$WG_LOG"; then
  ok "ambiguous sibling linked after a valid claude answer (#30→auto-trader)"
else
  fail "ambiguous claude-decided link not applied"
fi

# Dry-run: deterministic link still applies, but claude is NOT spawned.
: > "$WG_LOG"; : > "$CLAUDE_LOG"
(
  export PATH="$BIN:$PATH"
  export DISPATCH_DB="$INH_WORK/wg.sqlite"
  export CLAUDE_BIN="claude"
  export GAFFER_INHERIT_DRY_RUN=1
  gaffer_inherit_repo 61 >/dev/null 2>&1
)
if grep -q "ticket repo-access set 62 auto-trader" "$WG_LOG" && [ ! -s "$CLAUDE_LOG" ]; then
  ok "GAFFER_INHERIT_DRY_RUN=1 applies deterministic links but never spawns claude"
else
  fail "dry-run mishandled (wg=$(cat "$WG_LOG" 2>/dev/null); claude=$(cat "$CLAUDE_LOG" 2>/dev/null))"
fi

rm -rf "$INH_WORK"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
