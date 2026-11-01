#!/usr/bin/env bash
# =====================================================================
# A live run checks that `claude` can authenticate BEFORE it spends an attempt
# (exploratory findings fresh-user/F-04, fresh-user/F-06).
# ---------------------------------------------------------------------
# With no credential, a live run claimed a good ticket, the agent failed with
# "Invalid API key · Please run /login", the runner logged only "no-commit failure
# 1/3", and three runs parked the ticket. Proves:
#   G1. loop.sh live, default CLAUDE_BIN=claude, no credential visible: exit 3,
#       "claude is not logged in: run `claude /login`", and no tick ran
#   G2. a visible credential (ANTHROPIC_API_KEY), a custom CLAUDE_BIN, DRY_RUN=1
#       and GAFFER_CLAUDE_AUTH_PROBE=0 each let the run start
#   G3. `gaffer run` refuses before the loop; the dashboard Poll refuses with
#       "— not polling."
#   (G4/G5, an auth failure DURING a delivery: auth-gate-delivery.test.sh)
# Run: bash runner/test/auth-gate.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }
command -v perl >/dev/null 2>&1 || { echo "SKIP: perl required (timeout primitive)"; exit 0; }
for f in packages/dispatch/dist/cli/index.js packages/memory/dist/bin/memory.js packages/crew/dist/cli/index.js; do
  [ -f "$ROOT/$f" ] || { echo "SKIP: $f not built (run pnpm -r build)"; exit 0; }
done
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX ANTHROPIC_BASE_URL GAFFER_CLAUDE_AUTH_PROBE GAFFER_CLAUDE_AUTH_CHECKED

STUB_TICK_NAME=auth-gate
# shellcheck source=lib/stub-tick.sh
source "$HERE/lib/stub-tick.sh"
has() { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }
sqlv() { node -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1], { readOnly: true }); const r = db.prepare(process.argv[2]).get(Number(process.argv[3])); process.stdout.write(String(r ? Object.values(r)[0] : ""));' "$DISPATCH_DB" "$1" "$2" 2>/dev/null; }
# A credential-free HOME (no ~/.claude/.credentials.json) and a `claude` on PATH.
mkdir -p "$WORK/home" "$WORK/pathbin"; cp "$WORK/bin/claude" "$WORK/pathbin/claude"
NOCRED=(env -u ANTHROPIC_API_KEY HOME="$WORK/home" CLAUDE_CONFIG_DIR="$WORK/home/.claude" PATH="$WORK/pathbin:$PATH" CLAUDE_BIN=claude)

# A FAKE runner dir with a stub tick.sh for the admission cases.
FAKE="$WORK/runner"; mkdir -p "$FAKE"
for f in "$RUNNER_DIR"/*; do
  case "$(basename "$f")" in tick.sh|run-summary.sh|test) ;; *) ln -s "$f" "$FAKE/$(basename "$f")" ;; esac
done
printf '#!/usr/bin/env bash\necho tick >> "%s"\necho "TICK_RESULT=no_work"\n' "$WORK/ticks" > "$FAKE/tick.sh"; chmod +x "$FAKE/tick.sh"
printf '#!/usr/bin/env bash\nprintf "{}\\n"\n' > "$WORK/noop.sh"; chmod +x "$WORK/noop.sh"
ticks() { [ -f "$WORK/ticks" ] && wc -l < "$WORK/ticks" | tr -d ' ' || echo 0; }
stub_loop() {  # stub_loop [VAR=val ...] — FAKE loop.sh, live, no credential unless given
  : > "$WORK/ticks"
  ( "${NOCRED[@]}" DRY_RUN=0 GAFFER_ALLOW_UNCAPPED=1 TICK_SLEEP=0 EMPTY_POLL_LIMIT=1 MAX_TICKS=1 \
      LOOP_STATS_CMD="$WORK/noop.sh" LOOP_HQ_CMD="$WORK/noop.sh" LOOP_NOTIFY_EMIT_CMD="$WORK/noop.sh" \
      "$@" bash "$FAKE/loop.sh" 2>&1 )
}

echo "== G1. no credential → the run refuses before any tick =="
out="$(stub_loop)"; rc=$?
[ "$rc" = 3 ] && ok "G1: loop.sh exits 3" || fail "G1: rc=$rc: $out"
has "$out" 'claude is not logged in: run `claude /login`' && ok "G1: it says 'claude is not logged in: run \`claude /login\`'" || fail "G1: $out"
[ "$(ticks)" = 0 ] && ok "G1: no tick ran" || fail "G1: $(ticks) tick(s) ran"

echo "== G2. what lets a run start =="
out="$(stub_loop ANTHROPIC_API_KEY=sk-test)"; rc=$?
[ "$rc" = 0 ] && [ "$(ticks)" = 1 ] && ok "G2: a visible credential (ANTHROPIC_API_KEY) → the run starts" || fail "G2 key: rc=$rc ticks=$(ticks): $out"
out="$(stub_loop CLAUDE_BIN="$WORK/bin/claude")"; rc=$?
[ "$rc" = 0 ] && [ "$(ticks)" = 1 ] && ok "G2: a custom CLAUDE_BIN is not probed (it may bring its own login)" || fail "G2 custom: rc=$rc ticks=$(ticks): $out"
out="$(stub_loop DRY_RUN=1)"; rc=$?
[ "$rc" = 0 ] && [ "$(ticks)" = 1 ] && ok "G2: a dry run is not probed" || fail "G2 dry: rc=$rc ticks=$(ticks): $out"
out="$(stub_loop GAFFER_CLAUDE_AUTH_PROBE=0)"; rc=$?
[ "$rc" = 0 ] && [ "$(ticks)" = 1 ] && ok "G2: GAFFER_CLAUDE_AUTH_PROBE=0 skips the check" || fail "G2 off: rc=$rc ticks=$(ticks): $out"
mkdir -p "$WORK/home/.claude"; printf '{"x":1}' > "$WORK/home/.claude/.credentials.json"
out="$(stub_loop)"; rc=$?
[ "$rc" = 0 ] && [ "$(ticks)" = 1 ] && ok "G2: a credentials file lets the run start" || fail "G2 file: rc=$rc ticks=$(ticks): $out"
rm -f "$WORK/home/.claude/.credentials.json"

echo "== G3. gaffer run and the dashboard Poll refuse too =="
printf '#!/usr/bin/env bash\necho loop >> "%s"\n' "$WORK/ticks" > "$WORK/loop-stub.sh"; chmod +x "$WORK/loop-stub.sh"
: > "$WORK/ticks"
out="$( ( "${NOCRED[@]}" GAFFER_ALLOW_UNCAPPED=1 GAFFER_LOOP_SH="$WORK/loop-stub.sh" bash "$RUNNER_DIR/gaffer" run 2>&1 ) )"; rc=$?
[ "$rc" = 3 ] && [ "$(ticks)" = 0 ] && has "$out" "claude /login" && ok "G3: gaffer run refuses (exit 3) before the loop" || fail "G3 run: rc=$rc ticks=$(ticks): $out"
: > "$WORK/ticks"
out="$( ( "${NOCRED[@]}" DRY_RUN=0 GAFFER_ALLOW_UNCAPPED=1 GAFFER_POLL_TICK_SH="$FAKE/tick.sh" bash "$RUNNER_DIR/bin/poll-once.sh" 2>&1 ) )"
has "$out" "claude is not logged in" && has "$out" "— not polling." && [ "$(ticks)" = 0 ] \
  && ok "G3: the Poll refuses with '— not polling.' and runs no tick" || fail "G3 poll: ticks=$(ticks): $out"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
