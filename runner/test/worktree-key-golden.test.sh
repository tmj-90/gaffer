#!/usr/bin/env bash
# =====================================================================
# WORKTREE KEY — the filesystem-safe leaf tick.sh derives per write repo via the
# typed CLI (packages/crew worktreeKeyCli.js), pinned to
# fixtures/typed-seams/worktree-key/<case>.txt — captured from the bash tr|sed the
# CLI replaced (proven byte-identical by the former parity test). LC_ALL=C pins
# byte semantics across the ubuntu + macOS matrix.
# Run: bash runner/test/worktree-key-golden.test.sh   (SEAM_GOLDEN_CAPTURE=1 to re-pin)
# =====================================================================
set -uo pipefail
export LC_ALL=C LC_CTYPE=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
CREW_DIR="$ROOT/packages/crew"
CLI="$CREW_DIR/dist/runtime/worktree/worktreeKeyCli.js"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
[ -f "$CLI" ] || { echo "SKIP: crew not built ($CLI) — run pnpm -C packages/crew build"; exit 0; }
# shellcheck source=lib/seam-golden.sh
source "$HERE/lib/seam-golden.sh"
pass=0; fail=0
ok() { echo "  ok   $1"; pass=$((pass + 1)); }
no() { echo "  FAIL $1"; fail=$((fail + 1)); }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/worktree-key-golden.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT

# The seam as tick.sh invokes it (CLI + the same backstop).
key_case() {
  local name="$1" label="$2" rid="$3" rname="$4" idx="$5" k
  k="$(node "$CLI" --id "$rid" --name "$rname" --index "$idx" 2>/dev/null)"
  [ -n "$k" ] || k="repo$idx"
  printf '%s' "$k" > "$WORK/out"
  seam_golden worktree-key "$name" "$WORK/out" "$label ([$k])"
}
key_case plain-id      "plain id"                    "fixture-repo-id"             "fixture-app"   0
key_case id-empty      "id empty → name"             ""                            "My Repo Name!" 1
key_case sed-special   "sed-special chars"           "weird/id:with*chars"         "x"             2
key_case dashes        "leading/trailing dashes"     "---leading-and-trailing---"  "y"             3
key_case multibyte     "multibyte (byte collapse)"   "café-ünïcode"                "z"             4
key_case both-empty    "both empty → repo<index>"    ""                            ""              5
key_case all-dots      "all dots (dots allowed)"     "...."                        "only-dots"     6
key_case spaces-tabs   "spaces + tabs"               "a b	c"                       "n"             7
key_case only-specials "only-specials → repo<index>" "@@@###"                      ""              8
key_case name-slash    "name with slash"             ""                            "org/app"       9

# tick.sh wires the CLI (no bash tr|sed twin remains).
grep -q 'worktreeKeyCli.js' "$RUNNER_DIR/tick.sh" && ok "tick.sh derives the leaf through worktreeKeyCli.js" || no "tick.sh does not call worktreeKeyCli.js"
! grep -q "tr -c 'A-Za-z0-9._-' '-'" "$RUNNER_DIR/tick.sh" && ok "tick.sh carries no bash twin of the derivation" || no "bash twin still present in tick.sh"

echo ""; echo "worktree-key-golden: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
