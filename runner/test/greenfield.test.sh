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

# greenfield.sh's inherit helpers bound their planner/agent calls with gaffer_timeout
# (defined in factory.config.sh at real runtime). This test sources greenfield.sh in
# isolation, so provide a passthrough stub matching gaffer_timeout's semantics for a
# positive timeout: drop the seconds arg and run the command directly.
gaffer_timeout() { shift; "$@"; }

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
# WASTE CONTROL: the factory's OWN baselined repo is resumable even when the agent left
# uncommitted scaffold files in it (the parked "no scaffold commit" case) …
OURS="$WORK/git/ours-app"; mkdir -p "$OURS/src"
( cd "$OURS" && git init -q && printf '# ours-app\n' > README.md \
  && git -c user.email=g@f -c user.name=g add README.md && git -c user.email=g@f -c user.name=g commit -q -m "chore: initialise ours-app" \
  && printf '{"name":"ours-app"}\n' > package.json && printf 'export const x = 1;\n' > src/index.ts )
gaffer_bootstrap_target_ok "$OURS" 2>/dev/null \
  && ok "our baselined repo with the agent's UNCOMMITTED scaffold → resume in place" \
  || fail "a baselined repo with uncommitted agent work must be resumable"
# … and when a prior partial bootstrap COMMITTED on top of the baseline …
( cd "$OURS" && git -c user.email=g@f -c user.name=g add -A && git -c user.email=g@f -c user.name=g commit -q -m "wip scaffold" )
gaffer_bootstrap_target_ok "$OURS" 2>/dev/null \
  && ok "our baselined repo with committed partial scaffold → resume in place" \
  || fail "a baselined repo with a committed partial scaffold must be resumable"
# … but a FOREIGN repo (no factory baseline root commit) is still refused.
FOREIGN="$WORK/git/foreign"; mkdir -p "$FOREIGN/src"
( cd "$FOREIGN" && git init -q && printf 'real\n' > src/app.js && printf '# real project\n' > README.md \
  && git -c user.email=x@y -c user.name=x add -A && git -c user.email=x@y -c user.name=x commit -q -m "initial import" )
if gaffer_bootstrap_target_ok "$FOREIGN" >/dev/null 2>&1; then fail "a foreign repo must still be refused"; else ok "a foreign repo (no factory baseline) is still refused"; fi
# A non-factory file in it → real content → must refuse (never clobber real work).
echo "console.log(1)" > "$SCAF/index.js"
if gaffer_bootstrap_target_ok "$SCAF" >/dev/null 2>&1; then fail "scaffold + real file should be refused"; else ok "scaffold + a real file refused"; fi
rm -f "$SCAF/index.js"
# Any commit → treat as real work → must refuse.
git -C "$SCAF" add -A >/dev/null 2>&1
git -C "$SCAF" -c user.email=t@t -c user.name=t commit -qm scaffold >/dev/null 2>&1
if gaffer_bootstrap_target_ok "$SCAF" >/dev/null 2>&1; then fail "committed repo should be refused"; else ok "committed repo (real work) refused"; fi

echo "== AC6: gaffer_bootstrap_init mkdir + git init + baseline commit (idempotent) =="
NEW="$WORK/git/gym-tracker"
# A clean env (empty ambient git identity) must still land the baseline commit — the
# helper supplies an explicit -c identity, so this proves the CI-safe path.
( export GIT_CONFIG_NOSYSTEM=1 HOME="$WORK/nohome"; mkdir -p "$WORK/nohome"
  gaffer_bootstrap_init "$NEW" "gym-tracker" "Track your gym sessions" >/dev/null 2>&1 ) \
  && [ -d "$NEW/.git" ] && ok "init created git repo at $NEW" || fail "init did not create a git repo"
HEADREF="$(git -C "$NEW" symbolic-ref --short HEAD 2>/dev/null || echo '')"
[ "$HEADREF" = "main" ] && ok "default branch is 'main'" || fail "default branch should be main (got '$HEADREF')"
# BASELINE: `main` is now BORN (non-empty) with a single README commit — this is what
# lets a bootstrap branch off + diff against a real base (the core of the branch-delivery fix).
git -C "$NEW" rev-parse --verify -q HEAD >/dev/null 2>&1 \
  && ok "baseline commit exists on main (HEAD is born)" || fail "init must seed a baseline commit"
[ "$(git -C "$NEW" ls-tree -r --name-only HEAD 2>/dev/null)" = "README.md" ] \
  && ok "baseline tree is exactly README.md" || fail "baseline should commit README.md alone"
grep -q '^# gym-tracker' "$NEW/README.md" 2>/dev/null \
  && ok "README carries the repo display name" || fail "README should carry the display name"
NCOMMITS_1="$(git -C "$NEW" rev-list --count HEAD 2>/dev/null || echo 0)"
# Idempotent: a second init on the same dir is a no-op success — NO second commit.
gaffer_bootstrap_init "$NEW" "gym-tracker" "Track your gym sessions" >/dev/null 2>&1 && ok "re-init is idempotent (no-op success)" || fail "re-init should succeed"
NCOMMITS_2="$(git -C "$NEW" rev-list --count HEAD 2>/dev/null || echo 0)"
[ "$NCOMMITS_1" = "1" ] && [ "$NCOMMITS_2" = "1" ] \
  && ok "re-init did not add a second baseline commit (still 1)" \
  || fail "re-init must not re-commit (got $NCOMMITS_1 then $NCOMMITS_2)"

echo "== AC6c: gaffer_bootstrap_target_ok RESUMES a baseline-only repo (branch-delivery resume) =="
# After the branch-delivery fix, a fresh bootstrap leaves a README-only baseline on main.
# A resume must recognise THAT as our own resumable scaffold (tree == README.md), not
# refuse it as "real work" — otherwise the ticket wedges on its own baseline.
BASE="$WORK/git/baseline-resume"
gaffer_bootstrap_init "$BASE" "baseline-resume" "seed" >/dev/null 2>&1
gaffer_bootstrap_target_ok "$BASE" 2>/dev/null \
  && ok "baseline-only repo (main == {README.md}) → resume in place" \
  || fail "a baseline-only repo must be resumable"
# WASTE CONTROL: a real source file committed ON TOP of OUR baseline is the agent's
# own partial bootstrap (root commit == the factory's `chore: initialise <name>`
# README-only seed) → resume in place, keeping that work, rather than refusing the
# dir as "non-empty" and starving every dependent ticket. A FOREIGN repo (no factory
# baseline root) with the same file is still refused — never clobber someone's work.
echo "console.log(1)" > "$BASE/index.js"; git -C "$BASE" add index.js >/dev/null 2>&1
git -C "$BASE" -c user.email=t@t -c user.name=t commit -qm feat >/dev/null 2>&1
gaffer_bootstrap_target_ok "$BASE" >/dev/null 2>&1 \
  && ok "our baseline + a real committed file → resumable (agent's own partial bootstrap kept)" \
  || fail "a factory-baselined repo with agent commits must be resumable"
FOREIGN="$WORK/git/foreign-with-commit"; mkdir -p "$FOREIGN"; git -C "$FOREIGN" init -q -b main 2>/dev/null || git -C "$FOREIGN" init -q 2>/dev/null
printf '# theirs\n' > "$FOREIGN/README.md"; echo "console.log(1)" > "$FOREIGN/index.js"
git -C "$FOREIGN" add -A >/dev/null 2>&1; git -C "$FOREIGN" -c user.email=t@t -c user.name=t commit -qm "initial" >/dev/null 2>&1
if gaffer_bootstrap_target_ok "$FOREIGN" >/dev/null 2>&1; then fail "a foreign repo with real commits must be refused"; else ok "foreign repo (no factory baseline root) + real commit refused"; fi

echo "== AC6e: onboard detects the scaffold's stack + lint command (a bootstrap ticket carries none) =="
SC="$WORK/git/scaffolded"; mkdir -p "$SC/src"
printf '{ "name": "scaffolded", "private": true, "scripts": { "test": "node --test", "lint": "eslint .", "build": "tsc -p tsconfig.json" } }\n' > "$SC/package.json"
printf '{ "compilerOptions": { "strict": true } }\n' > "$SC/tsconfig.json"; printf 'export const a = 1;\n' > "$SC/src/index.ts"
_st="$(gaffer_bootstrap_detect_stack "$SC")"
case "$_st" in *typescript*|*node*) ok "detected stack from the scaffold ($_st)" ;; *) fail "stack not detected from a TypeScript scaffold (got '$_st')" ;; esac
[ "$(gaffer_bootstrap_detect_lint_cmd "$SC")" = "npm run lint" ] && ok "detected the lint command (npm run lint)" || fail "lint command not detected (got '$(gaffer_bootstrap_detect_lint_cmd "$SC")')"
[ -z "$(gaffer_bootstrap_detect_lint_cmd "$WORK/git/nowhere")" ] && ok "no dir → empty (fail-soft)" || fail "missing dir should yield empty"
grep -q 'stack="$(gaffer_bootstrap_detect_stack "$dir")"' "$RUNNER_DIR/lib/greenfield.sh" && grep -q 'add_args+=(--lint "$lint_cmd")' "$RUNNER_DIR/lib/greenfield.sh" \
  && ok "gaffer_bootstrap_onboard registers the detected stack + lint command" || fail "onboard does not use the detectors"

echo "== AC6b: bootstrap default-branch capture is clean on an UNBORN repo (E2E regression) =="
# REGRESSION: tick.sh captures B_DEFAULT_BRANCH BEFORE the agent's first commit — i.e.
# on an UNBORN repo. There `git rev-parse --abbrev-ref HEAD` prints "HEAD" to stdout AND
# exits non-zero, so `… || echo main` APPENDS, yielding the newline-joined garbage
# "HEAD\nmain". That fails 'repo add's git-ref-safe branch validation, so the whole
# greenfield onboard reports FAILED and the sibling tickets never get wired. The fix is
# `git symbolic-ref --short HEAD`, which returns a clean "main" for unborn + committed.
# `-b main` mirrors what gaffer_bootstrap_init does in production (greenfield.sh) — the
# fixture must NOT inherit the operator's ambient `init.defaultBranch`, or this asserts
# "main" locally (where it's set) yet gets "master" under a clean CI $HOME.
UNB="$WORK/git/unborn-repo"; mkdir -p "$UNB"; git -C "$UNB" init -q -b main 2>/dev/null || git -C "$UNB" init -q 2>/dev/null
_newbr="$(git -C "$UNB" symbolic-ref --short HEAD 2>/dev/null || echo main)"
[ "$_newbr" = "main" ] \
  && ok "symbolic-ref yields a clean 'main' on an unborn repo" \
  || fail "symbolic-ref should yield 'main' on unborn (got '$(printf %q "$_newbr")')"
[ "$(printf '%s' "$_newbr" | wc -l | tr -d ' ')" = "0" ] \
  && ok "captured branch has no embedded newline (the exact failure signature)" \
  || fail "captured branch must be single-line (got '$(printf %q "$_newbr")')"
grep -q 'B_DEFAULT_BRANCH="\$(gaffer_bootstrap_base_branch "\$B_DIR")"' "$RUNNER_DIR/tick.sh" \
  && ok "tick.sh captures B_DEFAULT_BRANCH via gaffer_bootstrap_base_branch (fix guarded in place)" \
  || fail "tick.sh must capture B_DEFAULT_BRANCH via gaffer_bootstrap_base_branch (regression guard)"
grep -q 'symbolic-ref --short HEAD' "$RUNNER_DIR/lib/greenfield.sh" \
  && ok "gaffer_bootstrap_base_branch reads symbolic-ref (never the HEAD\\nmain garbage)" \
  || fail "gaffer_bootstrap_base_branch must read symbolic-ref --short HEAD"

echo "== AC6d: gaffer_bootstrap_base_branch is RESUME-safe (delivery branch is never the base) =="
# LIVE FINDING: on a resume HEAD is the prior attempt's gaffer/ticket-N-… branch, so a
# raw symbolic-ref made base == delivery branch and the "scaffold commit beyond the
# baseline?" check compared HEAD with itself → a complete scaffold parked as "no
# scaffold commit", twice. The base is the branch the baseline lives on: main.
RB="$WORK/git/resume-base"
gaffer_bootstrap_init "$RB" "resume-base" "seed" >/dev/null 2>&1
[ "$(gaffer_bootstrap_base_branch "$RB")" = "main" ] \
  && ok "fresh baseline (HEAD=main) → main" || fail "fresh baseline should resolve to main (got '$(gaffer_bootstrap_base_branch "$RB")')"
git -C "$RB" checkout -q -B gaffer/ticket-7-scaffold-the-app >/dev/null 2>&1
echo "x" > "$RB/index.js"; git -C "$RB" add index.js >/dev/null 2>&1
git -C "$RB" -c user.email=t@t -c user.name=t commit -qm "deliver #7: scaffold" >/dev/null 2>&1
[ "$(gaffer_bootstrap_base_branch "$RB")" = "main" ] \
  && ok "resume (HEAD=gaffer/ticket-7-…, scaffold committed on it) → main, not the delivery branch" \
  || fail "resume must resolve the base to main (got '$(gaffer_bootstrap_base_branch "$RB")')"
[ "$(git -C "$RB" rev-parse HEAD)" != "$(git -C "$RB" rev-parse "$(gaffer_bootstrap_base_branch "$RB")")" ] \
  && ok "with that base the scaffold check sees HEAD != base (the scaffold is NOT parked)" \
  || fail "HEAD must differ from the resolved base on a resumed scaffold"
# A repo whose baseline lives on a non-main branch (operator init.defaultBranch) still
# resolves via the root commit when HEAD is a delivery branch.
RT="$WORK/git/resume-trunk"; mkdir -p "$RT"; git -C "$RT" init -q -b trunk 2>/dev/null || git -C "$RT" init -q 2>/dev/null
printf '# t\n' > "$RT/README.md"; git -C "$RT" add README.md >/dev/null 2>&1
git -C "$RT" -c user.email=t@t -c user.name=t commit -qm "chore: initialise resume-trunk" >/dev/null 2>&1
_trunk="$(git -C "$RT" symbolic-ref --short HEAD)"
[ "$(gaffer_bootstrap_base_branch "$RT")" = "$_trunk" ] && ok "non-delivery HEAD ($_trunk) → itself" || fail "non-delivery HEAD should be returned as-is"
git -C "$RT" checkout -q -B gaffer/ticket-8-x >/dev/null 2>&1
[ "$(gaffer_bootstrap_base_branch "$RT")" = "$_trunk" ] \
  && ok "delivery HEAD with no main/master → the non-delivery branch carrying the root commit ($_trunk)" \
  || fail "should fall back to the branch carrying the root commit (got '$(gaffer_bootstrap_base_branch "$RT")')"

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
grep -q "d.ticket.bootstrap" "$RUNNER_DIR/tick.sh" \
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

echo "== AC8b: tick.sh delivers the bootstrap ON A BRANCH via the normal review lane =="
# The core fix: a bootstrap must NOT commit straight onto main and submit branchless
# (the reviewer refused that: "no delivery branch recorded → fail closed"). Instead it
# branches gaffer/ticket-N-<slug> off the README baseline, records THAT branch as the
# delivery branch_name, and submits via the ordinary claim-gated lane.
grep -q 'B_WORK_BRANCH="gaffer/ticket-\$NUM-\$B_SLUG"' "$RUNNER_DIR/tick.sh" \
  && ok "tick.sh mints the gaffer/ticket-N-<slug> delivery branch for the bootstrap" \
  || fail "tick.sh does not create a gaffer/ticket-N delivery branch for the bootstrap"
grep -q 'git -C "\$B_DIR" checkout -B "\$B_WORK_BRANCH"' "$RUNNER_DIR/tick.sh" \
  && ok "tick.sh checks out the delivery branch before the scaffold agent runs" \
  || fail "tick.sh does not check out the bootstrap delivery branch"
grep -q 'wg delivery-artifact "\$NUM" --branch "\$B_WORK_BRANCH"' "$RUNNER_DIR/tick.sh" \
  && ok "tick.sh records branch_name = the delivery branch (reviewer resolves it)" \
  || fail "tick.sh must record delivery-artifact --branch \$B_WORK_BRANCH (not main)"
grep -q 'gaffer_submit_delivery "bootstrapped new repo' "$RUNNER_DIR/tick.sh" \
  && ok "tick.sh submits the bootstrap via the ordinary gaffer_submit_delivery lane" \
  || fail "tick.sh does not submit the bootstrap via the normal claim-gated lane"
# The scaffold branches OFF the baseline; both slugs come from the shared helper.
grep -q 'gaffer_ticket_slug()' "$RUNNER_DIR/tick.sh" \
  && ok "tick.sh defines the shared gaffer_ticket_slug branch-name helper" \
  || fail "tick.sh must define gaffer_ticket_slug (shared by normal + bootstrap paths)"

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
REAL_NODE="$(command -v node)"
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
  *) exec "$REAL_NODE" "\$@" ;;
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

echo "== AC11: bootstrap teardown purges the mount symlink from the PERSISTENT repo =="
# A greenfield bootstrap runs the agent DIRECTLY in the new repo (no throwaway
# worktree). gaffer_skills_mount installs a `.claude/skills` symlink there; on
# teardown gaffer_skills_mount_cleanup drops the mount TARGET. Without passing the
# repo dir, that symlink is left DANGLING in the real repo — which the post-teardown
# hygiene gate correctly flags ("broken symlink in real repo: .claude/skills").
# Prove the mechanism-level fix: cleanup WITH the dest arg leaves no dangling link,
# and gaffer_assert_repo_clean passes.
# shellcheck source=../lib/skills-mount.sh
source "$RUNNER_DIR/lib/skills-mount.sh"
# shellcheck source=../lib/hygiene.sh
source "$RUNNER_DIR/lib/hygiene.sh"

SM_WORK="$(mktemp -d "${TMPDIR:-/tmp}/skills-unmount-test.XXXXXX")"
export GAFFER_DATA="$SM_WORK/data"; mkdir -p "$GAFFER_DATA"
export SKILLS_DIR="$SM_WORK/skills"; mkdir -p "$SKILLS_DIR/demo-skill"
printf '%s\n' '# demo' > "$SKILLS_DIR/demo-skill/SKILL.md"

# The persistent bootstrap repo: a real git repo with a baseline commit (B_DIR).
BREPO="$SM_WORK/newrepo"; mkdir -p "$BREPO"
git -C "$BREPO" init -q -b main >/dev/null 2>&1 || git -C "$BREPO" init -q >/dev/null 2>&1
: > "$BREPO/README.md"
git -C "$BREPO" -c user.email=t@t -c user.name=t add -A >/dev/null 2>&1
git -C "$BREPO" -c user.email=t@t -c user.name=t commit -qm baseline >/dev/null 2>&1

# Mount exactly as the bootstrap block does, then git-exclude the runner config (as
# gaffer_exclude_runner_config does in production) so `.claude/` can't surface as
# untracked porcelain — isolating the dangling-symlink signal.
gaffer_skills_mount "$BREPO" "demo-skill" "bootstrap-999"
gaffer_exclude_runner_config "$BREPO"
[ -L "$BREPO/.claude/skills" ] \
  && ok "mount installed a .claude/skills symlink into the bootstrap repo" \
  || fail "mount should install a .claude/skills symlink"

# Reproduce the LEGACY bug first: cleanup WITHOUT the dest arg drops the mount target
# but leaves the symlink dangling — the detector must fire, proving the gap was real.
gaffer_skills_mount_cleanup "bootstrap-999"
# Capture the detector output to a var BEFORE grepping: `grep -q` closes the pipe on
# first match and, under `pipefail`, the SIGPIPE'd producer would flip the pipeline
# status — capture-then-grep is the suite's deterministic idiom (afk-delivery-loop).
if [ -L "$BREPO/.claude/skills" ] && [ ! -e "$BREPO/.claude/skills" ]; then
  LEGACY_OUT="$(gaffer_assert_repo_clean "$BREPO" 2>&1 || true)"
  printf '%s\n' "$LEGACY_OUT" | grep -q "broken symlink in real repo: .claude/skills" \
    && ok "legacy path (no dest arg) leaves a dangling link the detector flags" \
    || fail "expected the detector to flag the legacy dangling link (got: $LEGACY_OUT)"
else
  fail "legacy cleanup should have left a dangling .claude/skills (setup drift)"
fi

# Now the FIX: re-mount and tear down WITH the persistent dest → drops the mount AND
# the symlink it left behind, so the real repo is clean.
gaffer_skills_mount "$BREPO" "demo-skill" "bootstrap-999"
gaffer_skills_mount_cleanup "bootstrap-999" "$BREPO"
[ ! -L "$BREPO/.claude/skills" ] && [ ! -e "$BREPO/.claude/skills" ] \
  && ok "teardown with dest left NO .claude/skills in the real repo" \
  || fail "teardown left a .claude/skills entry behind: $(ls -la "$BREPO/.claude" 2>/dev/null | tr '\n' '|')"
gaffer_assert_repo_clean "$BREPO" >/dev/null 2>&1 \
  && ok "gaffer_assert_repo_clean passes after bootstrap teardown" \
  || fail "real repo flagged unclean after teardown: $(gaffer_assert_repo_clean "$BREPO" 2>&1 | tr '\n' '|')"

echo "== AC11b: the detector STILL fires on a genuine planted dangling symlink =="
# Control: the fix must NOT weaken the detector. A hand-planted dangling .claude/skills
# (the exact leak signature) must still be caught.
mkdir -p "$BREPO/.claude"
ln -s "$SM_WORK/does-not-exist" "$BREPO/.claude/skills"   # dangling: target absent
CTRL="$(gaffer_assert_repo_clean "$BREPO" 2>&1 || true)"
printf '%s\n' "$CTRL" | grep -q "broken symlink in real repo: .claude/skills" \
  && ok "gaffer_assert_repo_clean STILL fires on a planted dangling .claude/skills" \
  || fail "detector should still catch a genuine dangling symlink (got: $CTRL)"
rm -rf "$BREPO/.claude"

echo "== AC11c: teardown preserves agent-scaffolded .claude content =="
# The unmount must remove ONLY the factory's own symlink/config — never a real
# `.claude` directory or app files the agent legitimately scaffolded.
mkdir -p "$BREPO/.claude/skills/my-app-skill"           # a REAL dir named skills
printf '%s\n' '# app-owned' > "$BREPO/.claude/skills/my-app-skill/SKILL.md"
printf '%s\n' '{}' > "$BREPO/.claude/app-config.json"   # app content beside it
gaffer_skills_mount_cleanup "bootstrap-999" "$BREPO"    # must be a no-op on real content
[ -d "$BREPO/.claude/skills/my-app-skill" ] && [ -f "$BREPO/.claude/app-config.json" ] \
  && ok "agent-scaffolded .claude content is preserved (real skills/ dir untouched)" \
  || fail "teardown wrongly deleted agent-scaffolded .claude content"

unset GAFFER_DATA SKILLS_DIR
rm -rf "$SM_WORK"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
