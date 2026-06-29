#!/bin/bash
# =====================================================================
# FIX 1 regression guard — product-owner run must NOT dirty the
# registered repo checkout.
# ---------------------------------------------------------------------
# Before the fix, installProjectLocalWiring() wrote .claude/ directly
# INTO the registered repo (the operator's real checkout), exposing it
# as the agent's write-root.  After the fix the wiring lives in a
# throwaway dir under GAFFER_DATA and the repo is read-only.
#
# This test drives the LIVE path (not --dry-run) with a fake `claude`
# binary that exits 0 immediately, then asserts:
#   1. git status --porcelain is EMPTY for the registered repo BEFORE
#      the run (baseline).
#   2. git status --porcelain is EMPTY for the registered repo AFTER
#      the run (.claude/ was never written there).
#   3. No .claude/ directory was left behind in the registered repo.
#
# Requirements: bash, node >= 22.5 (node:sqlite built-in), git.
# Run: bash runner/test/product-owner-repo-clean.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
HELPER="$RUNNER_DIR/bin/product-owner-run.mjs"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v git  >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }
# node:sqlite requires Node 22.5+
node --input-type=commonjs -e "require('node:sqlite')" 2>/dev/null \
  || { echo "SKIP: node:sqlite requires Node >= 22.5"; exit 0; }
[ -f "$HELPER" ] || { echo "SKIP: helper not found: $HELPER"; exit 0; }
[ -f "$RUNNER_DIR/safety-hook.mjs" ] || { echo "SKIP: safety-hook.mjs missing"; exit 0; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/po-repo-clean.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT

# ---------------------------------------------------------------------------
# 1.  The "registered repo" — a real git repo the operator owns.
#     This is the checkout that must remain untouched.
# ---------------------------------------------------------------------------
REPO="$WORK/registered-repo"
mkdir -p "$REPO"
git -C "$REPO" init -q
git -C "$REPO" config user.email "t@e"
git -C "$REPO" config user.name "t"
echo "seed" > "$REPO/seed.txt"
git -C "$REPO" add seed.txt
git -C "$REPO" commit -qm "initial"

# ---------------------------------------------------------------------------
# 2.  Minimal dispatch.sqlite — just the repositories table, no tickets /
#     ticket_repos.  countDraftTickets will catch the "no such table" error
#     and return null, which skips the draft-count guard (filed=null path).
# ---------------------------------------------------------------------------
export GAFFER_DATA="$WORK/data"
mkdir -p "$GAFFER_DATA"
DB_PATH="$GAFFER_DATA/dispatch.sqlite"
REPO_PATH="$REPO"
DB_PATH="$DB_PATH" REPO_PATH="$REPO_PATH" node --input-type=commonjs << 'JS'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.DB_PATH);
db.exec(
  "CREATE TABLE repositories " +
  "(id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, " +
  " local_path TEXT, default_branch TEXT NOT NULL DEFAULT 'main')"
);
db.prepare(
  "INSERT INTO repositories (id, name, local_path, default_branch) VALUES (?, ?, ?, ?)"
).run('r1', 'test-repo', process.env.REPO_PATH, 'main');
db.close();
JS
export DISPATCH_DB="$DB_PATH"

# ---------------------------------------------------------------------------
# 3.  Fake claude binary — exits 0, writes nothing, outputs nothing.
#     The runner handles empty stdout gracefully (logged as "unknown usage").
# ---------------------------------------------------------------------------
FAKE_BIN="$WORK/bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/claude" << 'SH'
#!/bin/sh
exit 0
SH
chmod +x "$FAKE_BIN/claude"

# ---------------------------------------------------------------------------
# 4.  Assert the registered repo is CLEAN before the run.
# ---------------------------------------------------------------------------
echo "== before: registered repo must be clean =="
STATUS_BEFORE="$(git -C "$REPO" status --porcelain)"
if [ -z "$STATUS_BEFORE" ]; then
  ok "repo is clean BEFORE the run"
else
  fail "repo is dirty BEFORE the run: $STATUS_BEFORE"
fi

# ---------------------------------------------------------------------------
# 5.  Run the helper on the LIVE path (no --dry-run).
#     filed=null (guard skipped) → exits 0.
#     Redirect stderr to /dev/null to suppress log lines in test output.
# ---------------------------------------------------------------------------
echo "== live run with fake claude =="
DISPATCH_PRODUCT_OWNER_REPO="test-repo" \
  DISPATCH_DB="$DB_PATH" \
  GAFFER_DATA="$GAFFER_DATA" \
  CLAUDE_BIN="$FAKE_BIN/claude" \
  CLAUDE_FLAGS="--permission-mode acceptEdits" \
  node "$HELPER" 2>/dev/null
RUN_EXIT=$?
if [ "$RUN_EXIT" -eq 0 ]; then
  ok "helper exited 0 (filed=null path, guard skipped)"
else
  fail "helper exited $RUN_EXIT (expected 0 on the filed=null path)"
fi

# ---------------------------------------------------------------------------
# 6.  Assert the registered repo is STILL CLEAN after the run.
# ---------------------------------------------------------------------------
echo "== after: registered repo must still be clean =="
STATUS_AFTER="$(git -C "$REPO" status --porcelain)"
if [ -z "$STATUS_AFTER" ]; then
  ok "repo is clean AFTER the run"
else
  fail "repo is dirty AFTER the run: $STATUS_AFTER"
fi

if [ ! -d "$REPO/.claude" ]; then
  ok "no .claude/ directory left behind in the registered repo"
else
  fail ".claude/ was created inside the registered repo checkout"
fi

# ---------------------------------------------------------------------------
echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS — $PASS checks passed (helper: $HELPER)"
  exit 0
else
  echo "FAILED — ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]})) failed"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
