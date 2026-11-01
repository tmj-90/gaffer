#!/usr/bin/env bash
# =====================================================================
# External review #9, finding 3: onboarding reads stay inside the repository, and a
# remote URL's credentials never leave it.
# ---------------------------------------------------------------------
# A README symlinked to a file outside the repository put that file into the model
# prompt, and a password embedded in an https origin appeared verbatim. Driven through
# the REAL `gaffer onboard` (crew + memory CLIs, onboard-run.mjs, onboard-analyze.mjs)
# with a stub `claude` that records every prompt it is given:
#   B1. the outside file's content is in no prompt, log, card, event or database
#   B2. the digest says the README was not read and why
#   B3. the embedded password is nowhere (prompts, onboard log, events, databases,
#       crew's context store); the credential-free origin still is
# Run: bash runner/test/onboard-boundary.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }
for f in packages/dispatch/dist/cli/index.js packages/memory/dist/bin/memory.js packages/crew/dist/cli/index.js; do
  [ -f "$ROOT/$f" ] || { echo "SKIP: $f not built (run pnpm -r build)"; exit 0; }
done
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(gaffer_test_tmpdir onboard-boundary)" || exit 70
[ "${KEEP:-0}" = 1 ] || trap 'gaffer_test_rm_work "$WORK"' EXIT
WORK="$(cd "$WORK" && pwd -P)"
export GAFFER_DATA="$WORK/data" HOME="$WORK/home"; mkdir -p "$GAFFER_DATA" "$HOME" "$WORK/prompts" "$WORK/bin"
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN DISPATCH_DB MEMORY_DB GAFFER_CREW_EVENTS

OUTSIDE="$WORK/outside"; mkdir -p "$OUTSIDE"
MARK="OUTSIDE_FILE_MARKER_7f3a"
printf 'operator notes: %s\n' "$MARK" > "$OUTSIDE/notes.txt"
PASSWORD="hunter2pw9Q"
REPO="$WORK/widget"; mkdir -p "$REPO/src"
( cd "$REPO" && git init -q -b main
  ln -s "$OUTSIDE/notes.txt" README.md
  printf '{ "name": "widget", "version": "0.1.0", "scripts": { "test": "node --test" } }\n' > package.json
  printf 'export function add(a, b) { return a + b; }\n' > src/add.js
  git add -A && git -c user.email=t@t -c user.name=t commit -qm init
  git remote add origin "https://bob:$PASSWORD@git.example.com/acme/widget.git" )

# The stub model: records each prompt (argv and stdin) and answers with a digest.
cat > "$WORK/bin/claude" <<STUB
#!/usr/bin/env bash
[ "\${1:-}" = "--version" ] && { echo "2.0.0 (stub)"; exit 0; }
n="\$(ls -1 "$WORK/prompts" | wc -l | tr -d ' ')"
{ printf '%s\n' "\$@"; cat 2>/dev/null; } > "$WORK/prompts/\$n.txt"
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"{\"digest\":{\"overview\":\"A widget library.\",\"structure\":\"src/\",\"conventions\":\"plain js\",\"stack\":\"node\"},\"features\":[],\"lore\":[]}","total_cost_usd":0.01,"num_turns":1}'
STUB
chmod +x "$WORK/bin/claude"
export CLAUDE_BIN="$WORK/bin/claude" PATH="$WORK/bin:$PATH"
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
wg init >/dev/null 2>&1; lg init >/dev/null 2>&1

RC=0; bash "$RUNNER_DIR/gaffer" onboard "$REPO" >"$WORK/out" 2>"$WORK/err" < /dev/null || RC=$?
[ "$RC" = 0 ] && ok "gaffer onboard ran (exit 0)" || fail "gaffer onboard exited $RC: $(tail -5 "$WORK/err" | tr '\n' '|')"
NPROMPTS="$(ls -1 "$WORK/prompts" | wc -l | tr -d ' ')"
[ "$NPROMPTS" -ge 1 ] && ok "the model was asked ($NPROMPTS prompt(s) recorded)" || fail "no prompt recorded (the analysis did not run)"

# Everything onboarding could have written: prompts, the run's stdout/stderr, every file
# under GAFFER_DATA (logs, events, crew's context store, the databases).
everywhere() { grep -rlaF -- "$1" "$WORK/prompts" "$WORK/out" "$WORK/err" "$GAFFER_DATA" 2>/dev/null; }

echo "== B1. the outside file is never read =="
HITS="$(everywhere "$MARK")"
[ -z "$HITS" ] && ok "B1: the symlinked file's content is in no prompt, log, event or database" || fail "B1: outside content found in: $(printf '%s' "$HITS" | tr '\n' ' ')"

echo "== B2. the digest says why =="
grep -qF "README.md is a symlink to a file outside the repository" "$WORK/prompts"/*.txt \
  && ok "B2: the prompt names the README that was not read, and why" || fail "B2: the prompt does not mention the refused README"
DIG="$(MEMORY_DB="$GAFFER_DATA/memory.sqlite" node "$ROOT/packages/memory/dist/bin/memory.js" digest widget 2>/dev/null || true)"
case "$DIG" in *"Not read during onboarding: README.md is a symlink to a file outside the repository"*) ok "B2: the repository digest says the README was not read and why" ;;
  *) fail "B2: digest has no boundary note: $(printf '%s' "$DIG" | head -5 | tr '\n' ' ')" ;; esac

echo "== B3. the origin's password is nowhere =="
HITS="$(everywhere "$PASSWORD")"
[ -z "$HITS" ] && ok "B3: the embedded password appears in no prompt, log, card, event or database" || fail "B3: the password was found in: $(printf '%s' "$HITS" | tr '\n' ' ')"
grep -qaF "git.example.com/acme/widget" "$WORK/prompts"/*.txt && ok "B3: the prompt still names the origin, without its userinfo" || fail "B3: the origin vanished from the prompt"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS: $PASS checks"; exit 0; fi
echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"; exit 1
