#!/usr/bin/env bash
# =====================================================================
# LOAD-BEARING byte-identity test for the delivery-hygiene forbidden-path
# strangler port (P4). Mirrors the dod-distill / worktree-key parity tests.
# ---------------------------------------------------------------------
# gaffer_assert_clean_delivery flags any diff path matching a forbidden
# fragment (glob for `*`-leading, else literal substring). This drives the
# REAL bash predicate (_hygiene_path_forbidden over _hygiene_forbidden_fragments)
# as the ORACLE and the typed batch CLI (hygieneCli.js forbidden → isForbiddenPath)
# on the SAME path corpus + SAME HYGIENE_FORBIDDEN_PATHS policies, and asserts the
# emitted violation lines are byte-identical. This is a SAFETY gate, so drift
# (a forbidden artifact slipping the gate, or a legit path falsely rejected) is a
# real hazard — the bash oracle pins the ts glob/substring semantics exactly.
#
# LC_ALL=C pins the bash `case`-glob to byte semantics across the ubuntu+macOS
# matrix (same rationale as dod-distill-parity).
# =====================================================================
set -uo pipefail
export LC_ALL=C LC_CTYPE=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
CREW_DIR="$ROOT/packages/crew"
CLI="$CREW_DIR/dist/runtime/hygiene/hygieneCli.js"

command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
[ -f "$CLI" ] || { echo "SKIP: crew not built ($CLI) — run pnpm -C packages/crew build"; exit 0; }
# shellcheck source=../lib/hygiene.sh
source "$RUNNER_DIR/lib/hygiene.sh"

pass=0
fail=0
ok() { echo "  ok   $1"; pass=$((pass + 1)); }
no() { echo "  FAIL $1"; fail=$((fail + 1)); }

# The bash ORACLE: the real predicate loop, exactly as gaffer_assert_clean_delivery runs it.
bash_scan() {
  local paths="$1" p
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    _hygiene_path_forbidden "$p" && printf 'forbidden path in delivery diff: %s\n' "$p"
  done <<< "$paths"
}

# label, policy (HYGIENE_FORBIDDEN_PATHS or "" = default), newline-joined paths
scan_case() {
  local label="$1" policy="$2" paths="$3" a="$WORK/a" t="$WORK/t"
  if [ -n "$policy" ]; then export HYGIENE_FORBIDDEN_PATHS="$policy"; else unset HYGIENE_FORBIDDEN_PATHS; fi
  bash_scan "$paths" > "$a"
  printf '%s\n' "$paths" | node "$CLI" forbidden > "$t" 2>/dev/null
  if cmp -s "$a" "$t"; then
    ok "$label — bash oracle and ts CLI are byte-identical"
  else
    echo "----- diff (bash left, ts right) -----" >&2; diff "$a" "$t" >&2 || true
    no "$label — DIVERGED"
  fi
}

WORK="$(mktemp -d "${TMPDIR:-/tmp}/hygiene-forbidden-parity.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

CORPUS="$(printf '%s\n' \
  'src/index.ts' 'node_modules/x/y.js' 'app/.crew/state' 'logs/run.events.jsonl' \
  'src/mcp-runtime/index.ts' 'mcp-runtime.123.json' '.claude/settings.json' \
  'CLAUDE.factory.md' 'src/events.jsonlx' 'README.md' 'a/b/node_modules' \
  'deep/nested/.mcp.json' 'events.jsonl' 'x.events.jsonl' 'weird path/with space.ts')"

# 1. Default policy.
scan_case "default policy" "" "$CORPUS"
# 2. Glob-heavy custom policy: suffix + question-mark + bracket class.
scan_case "custom globs (* ? [])" '*.log dist?/ build[0-9]/ node_modules' \
  "$(printf '%s\n' 'a.log' 'dist1/x' 'dist/x' 'build3/y' 'buildX/y' 'node_modules/z' 'keep.txt')"
# 3. Substring-only policy (no globs).
scan_case "substring only" 'secret .env vendor/' \
  "$(printf '%s\n' 'app/secret/k' 'config/.env' 'vendor/lib.js' 'src/ok.ts' 'my.envfile')"
# 4. Everything clean (no matches → both empty).
scan_case "all clean" "" "$(printf '%s\n' 'src/a.ts' 'README.md' 'lib/b.js')"
# 5. Empty input.
scan_case "empty diff" "" ""
# 6. Bracket-negation glob.
scan_case "bracket negation [!0-9]" '*.[!0-9]' \
  "$(printf '%s\n' 'a.b' 'a.1' 'a.z' 'a.9')"

echo ""
echo "hygiene-forbidden-parity: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
