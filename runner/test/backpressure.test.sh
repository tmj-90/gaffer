#!/usr/bin/env bash
# =====================================================================
# Per-repo BACKPRESSURE validation (lib/backpressure.sh).
# ---------------------------------------------------------------------
# Proves, against REAL git repos + the REAL functions, with Dispatch
# access STUBBED (GAFFER_WG_LIST_CMD / GAFFER_WG_SHOW_CMD) so the test is
# hermetic:
#   AC1  gaffer_repo_unmerged_branches counts only UNMERGED gaffer/* branches
#   AC2  gaffer_repo_tickets_in_status counts tickets for the target repo
#   AC3  gaffer_repo_pressure returns the "<branches> <in_review> <claims>" triple
#   AC4  gaffer_repo_in_backpressure is FALSE under all caps
#   AC5  gaffer_repo_in_backpressure FIRES at/over the branch cap (the skip)
#   AC6  in_review cap and claims cap each independently trigger backpressure
#   AC7  a cap of 0 disables that dimension
#   AC8  the cap config keys are present + commented in factory.config.sh
#
# Zero deps beyond git + python3. Run: bash test/backpressure.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

export MAX_OPEN_AGENT_BRANCHES_PER_REPO=3
export MAX_OPEN_AGENT_PRS_PER_REPO=3
export MAX_CONCURRENT_TICKETS_PER_REPO=2
# shellcheck source=../lib/backpressure.sh
source "$RUNNER_DIR/lib/backpressure.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/backpressure-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

REPO="$WORK/repo"
git init -q -b main "$REPO"
git -C "$REPO" config user.email gaffer@test; git -C "$REPO" config user.name gaffer-test
printf 'base\n' > "$REPO/f.txt"; git -C "$REPO" add -A && git -C "$REPO" commit -q -m base

echo "== AC1: unmerged gaffer/* branch counting =="
[ "$(gaffer_repo_unmerged_branches "$REPO" main)" = "0" ] && ok "no gaffer branches → 0" || fail "expected 0 gaffer branches"
# Three UNMERGED gaffer/* branches (each carries a unique commit not on main).
for i in 1 2 3; do
  git -C "$REPO" checkout -q -b "gaffer/ticket-$i" main
  printf 'change %s\n' "$i" >> "$REPO/f.txt"
  git -C "$REPO" commit -q -am "work $i"
done
git -C "$REPO" checkout -q main
# A MERGED gaffer/* branch must NOT count toward pressure.
git -C "$REPO" checkout -q -b gaffer/ticket-merged main
printf 'merged\n' >> "$REPO/f.txt"; git -C "$REPO" commit -q -am "merged work"
git -C "$REPO" checkout -q main && git -C "$REPO" merge -q --no-edit gaffer/ticket-merged
N="$(gaffer_repo_unmerged_branches "$REPO" main)"
[ "$N" = "3" ] && ok "3 unmerged gaffer branches (merged one excluded) → $N" || fail "expected 3 unmerged (got $N)"

# Stub Dispatch: two in_review tickets + one in_progress (claim) all target REPO.
LISTJSON_in_review='[{"number":101},{"number":102}]'
LISTJSON_in_progress='[{"number":201}]'
export GAFFER_WG_LIST_CMD="$WORK/wg_list.sh"
export GAFFER_WG_SHOW_CMD="$WORK/wg_show.sh"
cat > "$WORK/wg_list.sh" <<EOF
#!/usr/bin/env bash
case "\$1" in
  in_review)  echo '$LISTJSON_in_review' ;;
  in_progress) echo '$LISTJSON_in_progress' ;;
  *) echo '[]' ;;
esac
EOF
cat > "$WORK/wg_show.sh" <<EOF
#!/usr/bin/env bash
# Every stub ticket targets REPO by local_path.
printf '{"repositories":[{"local_path":"%s","name":"repo"}]}' "$REPO"
EOF
chmod +x "$WORK/wg_list.sh" "$WORK/wg_show.sh"

echo "== AC2: ticket-in-status counting for the repo =="
[ "$(gaffer_repo_tickets_in_status in_review "$REPO")" = "2" ] && ok "2 in_review tickets for repo" || fail "expected 2 in_review"
[ "$(gaffer_repo_tickets_in_status in_progress "$REPO")" = "1" ] && ok "1 in_progress (claim) for repo" || fail "expected 1 in_progress"

echo "== AC3: pressure triple =="
read -r PB PR PC <<< "$(gaffer_repo_pressure "$REPO" main repo)"
[ "$PB" = "3" ] && [ "$PR" = "2" ] && [ "$PC" = "1" ] \
  && ok "pressure = $PB branches / $PR in_review / $PC claims" \
  || fail "pressure triple wrong (got $PB/$PR/$PC)"

echo "== AC5: branch cap FIRES backpressure (the skip) =="
# 3 branches == MAX_OPEN_AGENT_BRANCHES_PER_REPO=3 → at cap → backpressure.
if gaffer_repo_in_backpressure "$PB" "$PR" "$PC"; then
  ok "repo at branch cap (3/3) → in BACKPRESSURE: $GAFFER_BACKPRESSURE_REASON"
else
  fail "repo at branch cap should be in backpressure"
fi

echo "== AC4: under all caps → NOT in backpressure =="
if gaffer_repo_in_backpressure 1 1 1; then
  fail "1/1/1 should be under all caps"
else
  ok "1 branch / 1 in_review / 1 claim → NOT in backpressure"
fi

echo "== AC6: in_review cap + claims cap each trigger independently =="
gaffer_repo_in_backpressure 0 3 0 && ok "in_review 3/3 alone → backpressure ($GAFFER_BACKPRESSURE_REASON)" || fail "in_review cap should trigger"
gaffer_repo_in_backpressure 0 0 2 && ok "claims 2/2 alone → backpressure ($GAFFER_BACKPRESSURE_REASON)" || fail "claims cap should trigger"

echo "== AC7: a cap of 0 disables that dimension =="
( export MAX_OPEN_AGENT_BRANCHES_PER_REPO=0
  gaffer_repo_in_backpressure 99 0 0 ) \
  && fail "branch cap of 0 should disable the branch dimension" \
  || ok "MAX_OPEN_AGENT_BRANCHES_PER_REPO=0 → 99 branches no longer triggers"

echo "== AC8: cap config keys present + commented =="
for k in MAX_OPEN_AGENT_BRANCHES_PER_REPO:=3 MAX_OPEN_AGENT_PRS_PER_REPO:=3 MAX_CONCURRENT_TICKETS_PER_REPO:=2; do
  grep -Eq "^: \"\\\$\{$k\}\"" "$RUNNER_DIR/factory.config.sh" \
    && ok "$k default present in factory.config.sh" \
    || fail "$k default missing from factory.config.sh"
done

# PROOF: the tick wires this into the ready-selection skip.
grep -q 'gaffer_repo_in_backpressure' "$RUNNER_DIR/tick.sh" \
  && ok "tick.sh consults gaffer_repo_in_backpressure before claiming" \
  || fail "tick.sh does not gate claims on backpressure"
grep -q 'BACKPRESSURE: skipping ready' "$RUNNER_DIR/tick.sh" \
  && ok "tick.sh skips a ready ticket whose repo is in backpressure" \
  || fail "tick.sh missing the backpressure skip path"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
