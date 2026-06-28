#!/usr/bin/env bash
# =====================================================================
# A-1 — orphaned-worktree recovery (lib/orphan-recovery.sh).
# ---------------------------------------------------------------------
# A killed worker leaves its per-ticket worktree dir under
# $GAFFER_DATA/worktrees/ticket-<NUM>/ behind. gaffer_cleanup_orphaned_worktrees
# sweeps the ones whose ticket is NO LONGER actively delivered
# (status ∉ {claimed,in_progress}) and PROTECTS the ones a live worker still
# owns. Dispatch access is stubbed via GAFFER_WG_SHOW_CMD so the test is hermetic.
#
#   AC1  a stale worktree whose ticket is terminal (done/failed/cancelled/…) or
#        gone is REMOVED, and its ticket number is echoed.
#   AC2  a worktree whose ticket is 'in_progress' (a LIVE concurrent worker) is
#        NOT removed.
#   AC3  a worktree whose ticket is 'claimed' (claimed, pre-delivery) is NOT removed.
#   AC4  a real git worktree is detached cleanly (the real repo loses the linked
#        worktree, not just the directory).
#   AC5  sweeping an empty/absent worktrees root is a no-op (never fatal).
#
# Run: bash test/orphan-recovery.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

command -v git     >/dev/null 2>&1 || { echo "SKIP: git required";     exit 0; }
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 required"; exit 0; }

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/orphan-recovery.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT
export GAFFER_DATA="$WORK/data"
mkdir -p "$GAFFER_DATA/worktrees"

# shellcheck source=../lib/orphan-recovery.sh
source "$RUNNER_DIR/lib/orphan-recovery.sh"

# Stub dispatch: a per-ticket status map keyed by number. A number not in the map
# resolves to "" (treated as orphaned → sweepable).
cat > "$WORK/wg_show.sh" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  10) echo '{"ticket":{"status":"done"}}' ;;        # terminal → sweep
  20) echo '{"ticket":{"status":"in_progress"}}' ;; # LIVE worker → keep
  30) echo '{"ticket":{"status":"claimed"}}' ;;     # claimed → keep
  *)  echo '' ;;                                     # unknown → sweep
esac
EOF
chmod +x "$WORK/wg_show.sh"
export GAFFER_WG_SHOW_CMD="$WORK/wg_show.sh"

# A real repo so a real linked worktree can be created + detached (AC4).
REPO="$WORK/repo"; mkdir -p "$REPO"
git -C "$REPO" init -q
git -C "$REPO" config user.email t@e; git -C "$REPO" config user.name t
echo seed > "$REPO/s.txt"; git -C "$REPO" add -A; git -C "$REPO" commit -qm seed
BASE="$(git -C "$REPO" rev-parse --abbrev-ref HEAD)"

mk_real_wt() { # <ticket-num> : a real linked worktree leaf under ticket-<num>/repo
  local num="$1"; local base="$GAFFER_DATA/worktrees/ticket-$num"
  mkdir -p "$base"
  git -C "$REPO" worktree add -B "gaffer/ticket-$num" "$base/repo" "$BASE" >/dev/null 2>&1
}
mk_plain_wt() { # <ticket-num> : a non-git stale dir (rm -rf fallback path)
  mkdir -p "$GAFFER_DATA/worktrees/ticket-$1/repo"; echo x > "$GAFFER_DATA/worktrees/ticket-$1/repo/f"
}

# Ticket 10 (done) → real worktree, must be swept + detached.
mk_real_wt 10
# Ticket 20 (in_progress) → live worker, must be kept.
mk_plain_wt 20
# Ticket 30 (claimed) → must be kept.
mk_plain_wt 30
# Ticket 40 (unknown / no longer exists) → must be swept.
mk_plain_wt 40

echo "== sweep =="
REMOVED="$(gaffer_cleanup_orphaned_worktrees | sort | tr '\n' ' ')"
echo "  removed: ${REMOVED:-<none>}"

echo "== AC1/AC4: terminal-ticket worktree (#10) removed + detached =="
[ ! -e "$GAFFER_DATA/worktrees/ticket-10" ] && ok "#10 worktree dir removed" || fail "#10 worktree dir still present"
git -C "$REPO" worktree list --porcelain 2>/dev/null | grep -q "ticket-10/repo" \
  && fail "#10 still registered as a git worktree" || ok "#10 git worktree detached from the real repo"

echo "== AC2: in_progress worktree (#20) is PROTECTED =="
[ -e "$GAFFER_DATA/worktrees/ticket-20" ] && ok "#20 (in_progress) kept" || fail "#20 (live worker) was wrongly removed"

echo "== AC3: claimed worktree (#30) is PROTECTED =="
[ -e "$GAFFER_DATA/worktrees/ticket-30" ] && ok "#30 (claimed) kept" || fail "#30 (claimed) was wrongly removed"

echo "== AC1: unknown-ticket worktree (#40) removed =="
[ ! -e "$GAFFER_DATA/worktrees/ticket-40" ] && ok "#40 (no live ticket) removed" || fail "#40 still present"

echo "== echoed removals =="
case " $REMOVED " in *" 10 "*) ok "echoed #10";; *) fail "did not echo #10";; esac
case " $REMOVED " in *" 40 "*) ok "echoed #40";; *) fail "did not echo #40";; esac
case " $REMOVED " in *" 20 "*) fail "wrongly echoed #20";; *) ok "did not echo #20";; esac

echo "== AC5: empty/absent root is a no-op =="
rm -rf "$GAFFER_DATA/worktrees"
gaffer_cleanup_orphaned_worktrees >/dev/null 2>&1 && ok "absent worktrees root → no-op exit 0" || fail "absent root returned non-zero"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"; exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
