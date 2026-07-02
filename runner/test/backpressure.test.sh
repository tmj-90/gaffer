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
#   PARKED-1  parked (blocked/refining) tickets' preserved branches do NOT count
#             toward the branch cap — 3 parked branches must not starve the repo
#   PARKED-2  a re-readied parked ticket re-claiming its OWN preserved branch is
#             not blocked by that branch (self-bypass) or by others' parked ones
#   PARKED-3  regression — branches of ACTIVE tickets still trigger the cap
#   PARKED-4  fail-safe — if the parked-status lookup fails, every branch still
#             counts (a lookup failure never opens the floodgates)
#   PARKED-5  a branch with no derivable ticket number always counts (fail-safe)
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
# The branch/PR caps default next to each other in the backpressure block.
for k in MAX_OPEN_AGENT_BRANCHES_PER_REPO:=3 MAX_OPEN_AGENT_PRS_PER_REPO:=3; do
  grep -Eq "^: \"\\\$\{$k\}\"" "$RUNNER_DIR/factory.config.sh" \
    && ok "$k default present in factory.config.sh" \
    || fail "$k default missing from factory.config.sh"
done
# The per-repo concurrency cap is the third dimension. It is defaulted ONCE (in the
# GAFFER_CONCURRENCY block, default 1) — NOT re-defaulted in the backpressure block,
# where a second `:=` would be a dead no-op (FIX-4). Assert exactly one default and
# that it is :=1.
conc_defaults="$(grep -Ec '^: "\$\{MAX_CONCURRENT_TICKETS_PER_REPO:=' "$RUNNER_DIR/factory.config.sh")"
[ "$conc_defaults" = "1" ] \
  && ok "MAX_CONCURRENT_TICKETS_PER_REPO defaulted exactly once (no dead duplicate)" \
  || fail "MAX_CONCURRENT_TICKETS_PER_REPO defaulted $conc_defaults time(s) — expected exactly 1"
grep -Eq '^: "\$\{MAX_CONCURRENT_TICKETS_PER_REPO:=1\}"' "$RUNNER_DIR/factory.config.sh" \
  && ok "MAX_CONCURRENT_TICKETS_PER_REPO default is 1" \
  || fail "MAX_CONCURRENT_TICKETS_PER_REPO default is not 1"

# PROOF: the tick wires this into the ready-selection skip.
grep -q 'gaffer_repo_in_backpressure' "$RUNNER_DIR/tick.sh" \
  && ok "tick.sh consults gaffer_repo_in_backpressure before claiming" \
  || fail "tick.sh does not gate claims on backpressure"
grep -q 'BACKPRESSURE: skipping ready' "$RUNNER_DIR/tick.sh" \
  && ok "tick.sh skips a ready ticket whose repo is in backpressure" \
  || fail "tick.sh missing the backpressure skip path"

echo "== SWEEP: abandoned-branch sweep must NEVER delete a PRESERVED branch =="
# Data-loss guard: a delivery branch is often the ONLY copy of committed work. A
# ticket parked for rework PRESERVES its branch (rework → blocked, other paths →
# refining). The sweep must delete ONLY genuinely-abandoned branches: a ticket
# that is POSITIVELY cancelled AND has no delivery record. Everything else — every
# live/preserved state, and any ambiguous status — is kept.
SREPO="$WORK/sweeprepo"
git init -q -b main "$SREPO"
git -C "$SREPO" config user.email gaffer@test; git -C "$SREPO" config user.name gaffer-test
printf 'base\n' > "$SREPO/f.txt"; git -C "$SREPO" add -A && git -C "$SREPO" commit -q -m base
# Each gaffer/ticket-N branch carries a unique unmerged commit.
for n in 10 11 12 13 14 15; do
  git -C "$SREPO" checkout -q -b "gaffer/ticket-$n" main
  printf 'work %s\n' "$n" >> "$SREPO/f.txt"
  git -C "$SREPO" commit -q -am "work $n"
done
git -C "$SREPO" checkout -q main

# Stub `ticket show`: map ticket number → status.
#   10 refining · 11 blocked · 12 cancelled · 13 cancelled · 14 in_progress · 15 draft
cat > "$WORK/wg_show_sweep.sh" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  10) s=refining ;;   11) s=blocked ;;     12) s=cancelled ;;
  13) s=cancelled ;;  14) s=in_progress ;; 15) s=draft ;;
  *) s="" ;;
esac
printf '{"ticket":{"status":"%s"}}' "$s"
EOF
# Stub `repo-delivery list`: ticket 13's branch IS a recorded delivery artifact;
# everyone else has none ([]).
cat > "$WORK/wg_deliveries_sweep.sh" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  13) printf '[{"branch_name":"gaffer/ticket-13","repo":"repo"}]' ;;
  *)  printf '[]' ;;
esac
EOF
chmod +x "$WORK/wg_show_sweep.sh" "$WORK/wg_deliveries_sweep.sh"

SWEPT="$(GAFFER_WG_SHOW_CMD="$WORK/wg_show_sweep.sh" \
         GAFFER_WG_DELIVERIES_CMD="$WORK/wg_deliveries_sweep.sh" \
         gaffer_sweep_abandoned_branches "$SREPO" main)"

branch_exists() { git -C "$SREPO" show-ref --verify --quiet "refs/heads/$1"; }

# Only the genuinely-abandoned branch (cancelled + no delivery record) is swept.
[ "$SWEPT" = "gaffer/ticket-12" ] \
  && ok "swept ONLY the cancelled, no-delivery branch (gaffer/ticket-12)" \
  || fail "sweep deleted the wrong set: '$SWEPT' (expected only gaffer/ticket-12)"
! branch_exists gaffer/ticket-12 && ok "cancelled+abandoned branch actually deleted" \
  || fail "genuinely-abandoned branch should have been deleted"
# PRESERVED states survive — the data-loss guard.
branch_exists gaffer/ticket-10 && ok "refining branch PRESERVED (rework park)" || fail "refining branch was wrongly swept — DATA LOSS"
branch_exists gaffer/ticket-11 && ok "blocked branch PRESERVED (rework park)"  || fail "blocked branch was wrongly swept — DATA LOSS"
branch_exists gaffer/ticket-14 && ok "in_progress branch PRESERVED"            || fail "in_progress branch was wrongly swept — DATA LOSS"
branch_exists gaffer/ticket-15 && ok "draft branch PRESERVED (live ticket)"    || fail "draft branch was wrongly swept"
# A cancelled ticket whose branch is a recorded delivery artifact is still kept.
branch_exists gaffer/ticket-13 && ok "cancelled branch WITH delivery record PRESERVED" || fail "delivery-artifact branch was wrongly swept — DATA LOSS"

echo "== SWEEP: an unresolvable status (transient wg error) keeps the branch =="
# No show stub → status resolves empty → not 'cancelled' → PRESERVE (fail-safe).
git -C "$SREPO" checkout -q -b gaffer/ticket-99 main
printf 'work 99\n' >> "$SREPO/f.txt"; git -C "$SREPO" commit -q -am "work 99"
git -C "$SREPO" checkout -q main
SWEPT2="$(GAFFER_WG_SHOW_CMD="/bin/false" GAFFER_WG_DELIVERIES_CMD="/bin/false" \
          gaffer_sweep_abandoned_branches "$SREPO" main)"
branch_exists gaffer/ticket-99 && ok "ambiguous-status branch PRESERVED (fail-safe)" || fail "ambiguous-status branch was wrongly swept"
printf '%s\n' "$SWEPT2" | grep -q 'ticket-99' && fail "ticket-99 must not be reported swept" || ok "no PRESERVED branch reported swept under wg failure"

echo "== PARKED-1: parked tickets' preserved branches must NOT starve the repo =="
# FINDING-4: a ticket parked for a human (rework loop → blocked, other recovery
# paths → refining) PRESERVES its gaffer/* branch. Counting those branches toward
# MAX_OPEN_AGENT_BRANCHES_PER_REPO starves the repo FOREVER: the parked tickets
# only resume via a human, the resume re-claim is gated behind the SAME check, and
# nothing else releases the pressure. The branch dimension must count only ACTIVE
# work: branches whose ticket is blocked/refining are excluded.
PREPO="$WORK/parkedrepo"
git init -q -b main "$PREPO"
git -C "$PREPO" config user.email gaffer@test; git -C "$PREPO" config user.name gaffer-test
printf 'base\n' > "$PREPO/f.txt"; git -C "$PREPO" add -A && git -C "$PREPO" commit -q -m base
# Three preserved branches, one per PARKED ticket (50 blocked, 51 refining, 52 blocked).
for n in 50 51 52; do
  git -C "$PREPO" checkout -q -b "gaffer/ticket-$n-fix-thing" main
  printf 'work %s\n' "$n" >> "$PREPO/f.txt"
  git -C "$PREPO" commit -q -am "work $n"
done
git -C "$PREPO" checkout -q main
# Batched status stub: `ticket list -s blocked|refining` names the parked tickets
# (ONE list call per parked status — never a per-branch `ticket show`).
cat > "$WORK/wg_list_parked.sh" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  blocked)  echo '[{"number":50},{"number":52}]' ;;
  refining) echo '[{"number":51}]' ;;
  *)        echo '[]' ;;
esac
EOF
chmod +x "$WORK/wg_list_parked.sh"
# 3 parked branches + a NEW ready ticket #60 (no branch yet): pressure must read
# 0 active branches and the repo must be claimable.
read -r PB PR PC <<< "$(GAFFER_WG_LIST_CMD="$WORK/wg_list_parked.sh" gaffer_repo_pressure "$PREPO" main parkedrepo 60)"
[ "$PB" = "0" ] \
  && ok "3 parked branches → active branch pressure 0" \
  || fail "parked branches still counted (branches=$PB) — repo starves forever"
if gaffer_repo_in_backpressure "${PB:-9}" "${PR:-0}" "${PC:-0}"; then
  fail "new ready ticket SKIPPED by backpressure from parked branches (permanent starvation)"
else
  ok "new ready ticket claimable — parked branches do not starve the repo"
fi

echo "== PARKED-2: a re-readied parked ticket re-claiming its OWN branch passes =="
# Ticket #50 was moved back to ready by a human (no longer parked); its preserved
# branch still exists. Two MORE branches belong to ACTIVE (claimed) tickets 61/62.
# The reclaim REUSES branch gaffer/ticket-50-* (worktree add -B) — it adds no new
# branch — so the candidate's own branch must not count against its own claim,
# and the still-parked 51/52 must not count either: pressure = 2 (61+62), under cap.
for n in 61 62; do
  git -C "$PREPO" checkout -q -b "gaffer/ticket-$n-active" main
  printf 'work %s\n' "$n" >> "$PREPO/f.txt"
  git -C "$PREPO" commit -q -am "work $n"
done
git -C "$PREPO" checkout -q main
cat > "$WORK/wg_list_parked2.sh" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  blocked)  echo '[{"number":52}]' ;;
  refining) echo '[{"number":51}]' ;;
  *)        echo '[]' ;;
esac
EOF
chmod +x "$WORK/wg_list_parked2.sh"
read -r PB PR PC <<< "$(GAFFER_WG_LIST_CMD="$WORK/wg_list_parked2.sh" gaffer_repo_pressure "$PREPO" main parkedrepo 50)"
[ "$PB" = "2" ] \
  && ok "resuming #50: own branch bypassed + parked 51/52 excluded → branches=2" \
  || fail "resuming #50 sees branches=$PB (expected 2 — blocked by its own/others' parked branches)"
if gaffer_repo_in_backpressure "${PB:-9}" "${PR:-0}" "${PC:-0}"; then
  fail "parked ticket's own resumption path is blocked by backpressure"
else
  ok "parked ticket can re-claim its preserved branch (resumption not self-starved)"
fi

echo "== PARKED-3: regression — ACTIVE tickets' branches still trigger the cap =="
# Same 5 branches, but NOTHING is parked (blocked/refining both empty): every
# branch is active in-flight work and the cap must fire exactly as before.
cat > "$WORK/wg_list_none.sh" <<'EOF'
#!/usr/bin/env bash
echo '[]'
EOF
chmod +x "$WORK/wg_list_none.sh"
read -r PB PR PC <<< "$(GAFFER_WG_LIST_CMD="$WORK/wg_list_none.sh" gaffer_repo_pressure "$PREPO" main parkedrepo)"
[ "$PB" = "5" ] \
  && ok "no parked tickets → all 5 active branches count" \
  || fail "active branch count wrong (got $PB, expected 5)"
gaffer_repo_in_backpressure "${PB:-0}" "${PR:-0}" "${PC:-0}" \
  && ok "active branches ≥ cap still fire backpressure ($GAFFER_BACKPRESSURE_REASON)" \
  || fail "cap no longer fires for active branches — exclusion opened the floodgates"

echo "== PARKED-4: fail-safe — unresolvable parked statuses keep branches counting =="
# The parked-status lookup fails (transient wg error): NOTHING can be proven
# parked, so every branch must keep counting — a lookup failure must throttle,
# never unthrottle.
read -r PB PR PC <<< "$(GAFFER_WG_LIST_CMD="/bin/false" gaffer_repo_pressure "$PREPO" main parkedrepo)"
[ "$PB" = "5" ] \
  && ok "wg list failure → all 5 branches still count (fail-safe)" \
  || fail "lookup failure dropped branches from the count (got $PB) — floodgates open"
gaffer_repo_in_backpressure "${PB:-0}" "${PR:-0}" "${PC:-0}" \
  && ok "backpressure still fires when parked status is unresolvable" \
  || fail "backpressure silenced by a failed status lookup"

echo "== PARKED-5: a branch with no derivable ticket number always counts =="
# A gaffer/* branch that does not embed a ticket number cannot be proven parked
# (or owned by the candidate) — it must count no matter what the stubs say.
git -C "$PREPO" checkout -q -b "gaffer/adhoc-experiment" main
printf 'adhoc\n' >> "$PREPO/f.txt"; git -C "$PREPO" commit -q -am adhoc
git -C "$PREPO" checkout -q main
read -r PB PR PC <<< "$(GAFFER_WG_LIST_CMD="$WORK/wg_list_parked.sh" gaffer_repo_pressure "$PREPO" main parkedrepo 60)"
# parked stub excludes 50/51/52; 61/62 active; adhoc unmappable → 2 + 1 = 3.
[ "$PB" = "3" ] \
  && ok "unmappable gaffer/* branch counts (fail-safe) → branches=3" \
  || fail "unmappable branch handling wrong (got $PB, expected 3)"

# PROOF: tick.sh passes the candidate ticket to the pressure probe (self-bypass)
# and the stale "one extra tick" claim is gone from the sweep guard comment.
grep -qF 'gaffer_repo_pressure "$_crepo" "${_cdef:-main}" "$_cname" "$_cand"' "$RUNNER_DIR/tick.sh" \
  && ok "tick.sh passes the candidate number into gaffer_repo_pressure" \
  || fail "tick.sh does not pass the candidate to the pressure probe (no self-bypass)"
grep -q 'one extra tick' "$RUNNER_DIR/lib/backpressure.sh" \
  && fail "backpressure.sh still claims a preserved branch costs 'one extra tick' (it never did)" \
  || ok "stale 'one extra tick' comment corrected"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
