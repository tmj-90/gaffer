#!/usr/bin/env bash
# =====================================================================
# WORKTREE TRUST → MAIN REPO ROOT — gaffer_git_main_worktree + gaffer_trust_workspace,
# extracted verbatim from tick.sh.
# ---------------------------------------------------------------------
# Claude Code keys a git WORKTREE's trust on its MAIN repo working tree (the git-
# common-dir's parent), NOT the worktree path. The factory delivers in throwaway
# linked worktrees, so trusting only the worktree was IGNORED: the agent ran
# untrusted, the settings allowlist was dropped, and its dispatch/memory MCP tools
# were never permitted (no evidence/digest/lore writes during a live delivery). The
# fix also trusts the main repo root. This proves the REAL functions:
#   AC1  gaffer_git_main_worktree(worktree) → the MAIN repo root (parent of shared .git)
#   AC2  gaffer_git_main_worktree(repo root) → the repo root itself (relative .git)
#   AC3  gaffer_git_main_worktree(non-git) → empty
#   AC4  gaffer_trust_workspace(worktree) invokes trust for BOTH the worktree AND the
#        main root, and the main-root call carries GAFFER_TRUST_KEY_ONLY=1
#   AC5  gaffer_trust_workspace(plain repo root) invokes trust ONCE (main == dir)
# Hermetic: real git repo + worktree; `node` is stubbed to record its argv+env, so
# no ~/.claude.json is touched. Run: bash test/trust-main-worktree.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
TICK="$RUNNER_DIR/tick.sh"
command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }
[ -f "$TICK" ] || { echo "SKIP: tick.sh not found"; exit 0; }

PASS=0
FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

# Extract the REAL functions from tick.sh and source them.
FN="$(mktemp "${TMPDIR:-/tmp}/trust-fn.XXXXXX")"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/trust-wt.XXXXXX")"
trap 'rm -f "$FN"; rm -rf "$WORK"' EXIT
awk '/^gaffer_git_main_worktree\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "$TICK" > "$FN"
awk '/^gaffer_trust_workspace\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "$TICK" >> "$FN"
grep -q 'gaffer_git_main_worktree()' "$FN" \
  && ok "extracted the real gaffer_git_main_worktree from tick.sh" \
  || { echo "FAIL: could not extract gaffer_git_main_worktree"; exit 1; }
grep -q 'gaffer_trust_workspace()' "$FN" \
  && ok "extracted the real gaffer_trust_workspace from tick.sh" \
  || { echo "FAIL: could not extract gaffer_trust_workspace"; exit 1; }
# shellcheck disable=SC1090
source "$FN"

# Deps the functions close over (mirror tick.sh's runtime).
log() { :; }
GAFFER_LOG="$WORK/gaffer.log"; : >"$GAFFER_LOG"
# Stub `node` on PATH so the trust-workspace.mjs invocation records argv+env instead
# of mutating ~/.claude.json. RUNNER_DIR points the fn's node call at a real path,
# but our stub shadows the binary — so nothing real runs.
BIN="$WORK/bin"; mkdir -p "$BIN"
CALLS="$WORK/node-calls.log"; : >"$CALLS"
cat >"$BIN/node" <<EOF
#!/usr/bin/env bash
# Record: last path arg + whether KEY_ONLY was set in the env, one line per call.
printf '%s KEY_ONLY=%s\n' "\${!#}" "\${GAFFER_TRUST_KEY_ONLY:-}" >> "$CALLS"
exit 0
EOF
chmod +x "$BIN/node"
PATH="$BIN:$PATH"

# Build a real repo + a real linked worktree under it.
REPO="$WORK/widget"
mkdir -p "$REPO"
( cd "$REPO" && git init -q -b main && git -c user.email=t@e -c user.name=t commit -q --allow-empty -m init )
WT="$WORK/wt"
( cd "$REPO" && git worktree add -q "$WT" HEAD )

echo "== AC1: gaffer_git_main_worktree(worktree) → main repo root =="
GOT="$(gaffer_git_main_worktree "$WT")"
# Compare canonicalized paths (git may report the realpath of the common dir).
CANON_REPO="$(cd "$REPO" && pwd -P)"; CANON_GOT="$(cd "$GOT" 2>/dev/null && pwd -P)"
[ "$CANON_GOT" = "$CANON_REPO" ] \
  && ok "worktree resolves to the main repo root ($GOT)" \
  || fail "worktree resolved to '$GOT', expected '$REPO'"

echo "== AC2: gaffer_git_main_worktree(repo root) → itself =="
GOT="$(gaffer_git_main_worktree "$REPO")"
[ "$GOT" = "$REPO" ] \
  && ok "a plain repo root resolves to itself" \
  || fail "repo root resolved to '$GOT', expected '$REPO'"

echo "== AC3: gaffer_git_main_worktree(non-git) → empty =="
NOGIT="$WORK/plain"; mkdir -p "$NOGIT"
GOT="$(gaffer_git_main_worktree "$NOGIT")"
[ -z "$GOT" ] && ok "a non-git dir yields empty" || fail "non-git yielded '$GOT'"

echo "== AC4: trust(worktree) trusts BOTH paths; main-root call is KEY_ONLY =="
: >"$CALLS"
gaffer_trust_workspace "$WT"
N="$(wc -l <"$CALLS" | tr -d ' ')"
[ "$N" = "2" ] && ok "two trust invocations (worktree + main root)" || fail "expected 2 node calls, got $N"
grep -q "^$WT KEY_ONLY=$" "$CALLS" \
  && ok "the worktree is trusted WITHOUT KEY_ONLY (neutralizes its own local settings)" \
  || fail "worktree trust call missing or wrongly KEY_ONLY"
grep -qE "KEY_ONLY=1$" "$CALLS" && grep -q " KEY_ONLY=1$" "$CALLS" \
  && ok "the main-root trust call carries GAFFER_TRUST_KEY_ONLY=1" \
  || fail "main-root call not marked KEY_ONLY"
# The KEY_ONLY line must be the MAIN root, not the worktree.
if grep -q "KEY_ONLY=1$" "$CALLS"; then
  KL="$(grep "KEY_ONLY=1$" "$CALLS" | awk '{print $1}')"
  KLC="$(cd "$KL" 2>/dev/null && pwd -P)"
  [ "$KLC" = "$CANON_REPO" ] \
    && ok "the KEY_ONLY trust targets the main repo root" \
    || fail "KEY_ONLY target was '$KL', expected the main repo root"
fi

echo "== AC5: trust(plain repo root) trusts ONCE (main == dir) =="
: >"$CALLS"
gaffer_trust_workspace "$REPO"
N="$(wc -l <"$CALLS" | tr -d ' ')"
[ "$N" = "1" ] && ok "a plain repo root is trusted exactly once" || fail "expected 1 node call, got $N"
grep -q "KEY_ONLY=1$" "$CALLS" && fail "a plain repo root must NOT use KEY_ONLY" || ok "no gratuitous KEY_ONLY for a plain repo root"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS — $PASS checks passed (worktree trust → main repo root)"
  exit 0
else
  echo "FAILED — ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
