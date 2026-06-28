#!/usr/bin/env bash
# =====================================================================
# A-1 — per-repo concurrency cap (MAX_CONCURRENT_TICKETS_PER_REPO).
# ---------------------------------------------------------------------
# The per-repo cap is enforced through the existing backpressure "claims"
# dimension: a repo with N active in-flight (claimed/in_progress) tickets at/over
# MAX_CONCURRENT_TICKETS_PER_REPO is in BACKPRESSURE, so tick.sh SKIPS new claims
# for it and a concurrent worker picks a DIFFERENT repo's candidate instead.
# Dispatch access is stubbed (GAFFER_WG_LIST_CMD / GAFFER_WG_SHOW_CMD) so the
# test is hermetic.
#
#   AC1  with cap=1 and ONE in-flight ticket for a repo, that repo is in
#        backpressure (a second candidate for it would be skipped).
#   AC2  with cap=1 and ZERO in-flight, the repo is NOT in backpressure (claimable).
#   AC3  raising cap=2 lets a second in-flight ticket through (cap is the knob).
#   AC4  the candidate-walk SKIPS a capped repo's ticket and selects the next
#        candidate whose repo is under cap (the tick.sh selection contract).
#
# Run: bash test/per-repo-cap.test.sh
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

# Other caps unlimited so ONLY the per-repo concurrency (claims) dimension is under
# test. MAX_CONCURRENT_TICKETS_PER_REPO is the A-1 per-repo cap.
export MAX_OPEN_AGENT_BRANCHES_PER_REPO=0
export MAX_OPEN_AGENT_PRS_PER_REPO=0
export MAX_CONCURRENT_TICKETS_PER_REPO=1
# shellcheck source=../lib/backpressure.sh
source "$RUNNER_DIR/lib/backpressure.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/per-repo-cap.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# Two real repos, repoA (capped) and repoB (free).
REPOA="$WORK/repoA"; REPOB="$WORK/repoB"
for R in "$REPOA" "$REPOB"; do
  git init -q -b main "$R"
  git -C "$R" config user.email t@e; git -C "$R" config user.name t
  echo base > "$R/f.txt"; git -C "$R" add -A; git -C "$R" commit -q -m base
done

# Stub dispatch. repoA has ONE in-flight ticket (#201) in the REAL steady-state
# claim status `claimed` — NOT `in_progress` (a delivery is `claimed` for almost
# its whole life and only briefly `in_progress` inside submitForReview). Driving
# the live status here is what makes this test catch a cap that only counted
# `in_progress`: against such code repoA reads as 0 claims and the cap is inert.
export GAFFER_WG_LIST_CMD="$WORK/wg_list.sh"
export GAFFER_WG_SHOW_CMD="$WORK/wg_show.sh"
cat > "$WORK/wg_list.sh" <<EOF
#!/usr/bin/env bash
case "\$1" in
  claimed) echo '[{"number":201}]' ;;
  *)       echo '[]' ;;
esac
EOF
cat > "$WORK/wg_show.sh" <<EOF
#!/usr/bin/env bash
# #201 is the in-flight ticket on repoA.
case "\$1" in
  201) echo '{"repositories":[{"local_path":"$REPOA","name":"repoA","default_branch":"main"}]}' ;;
  *)   echo '{"repositories":[]}' ;;
esac
EOF
chmod +x "$WORK/wg_list.sh" "$WORK/wg_show.sh"

bp_repo() { # echo "in-backpressure" or "free" for <repo> <name>
  local repo="$1" name="$2" b r c
  read -r b r c <<< "$(gaffer_repo_pressure "$repo" main "$name")"
  if gaffer_repo_in_backpressure "$b" "$r" "$c"; then echo "in-backpressure ($b/$r/$c: $GAFFER_BACKPRESSURE_REASON)"; else echo "free ($b/$r/$c)"; fi
}

echo "== AC1: cap=1, one in-flight ticket → repoA is in backpressure =="
res="$(bp_repo "$REPOA" repoA)"
case "$res" in in-backpressure*) ok "repoA at cap=1 with 1 in-flight → $res";; *) fail "repoA should be capped, got: $res";; esac

echo "== AC2: cap=1, zero in-flight → repoB is free =="
res="$(bp_repo "$REPOB" repoB)"
case "$res" in free*) ok "repoB with 0 in-flight → $res";; *) fail "repoB should be free, got: $res";; esac

echo "== AC3: raising cap=2 lets the second in-flight ticket through =="
( export MAX_CONCURRENT_TICKETS_PER_REPO=2
  read -r b r c <<< "$(gaffer_repo_pressure "$REPOA" main repoA)"
  if gaffer_repo_in_backpressure "$b" "$r" "$c"; then exit 1; else exit 0; fi
) && ok "repoA with 1 in-flight is FREE at cap=2 (cap is the knob)" || fail "repoA still capped at cap=2"

echo "== AC4: candidate walk SKIPS the capped repo and picks the free one =="
# Mirror tick.sh's selection loop over two candidates: #201's repo (repoA, capped)
# then a repoB candidate (free). The walk must skip repoA and select the repoB one.
CANDIDATES=$'201\n301'
# Extend the show stub so #301 targets repoB.
cat > "$WORK/wg_show.sh" <<EOF
#!/usr/bin/env bash
case "\$1" in
  201) echo '{"repositories":[{"local_path":"$REPOA","name":"repoA","default_branch":"main"}]}' ;;
  301) echo '{"repositories":[{"local_path":"$REPOB","name":"repoB","default_branch":"main"}]}' ;;
  *)   echo '{"repositories":[]}' ;;
esac
EOF
chmod +x "$WORK/wg_show.sh"
PICKED=""
while IFS= read -r cand; do
  [ -n "$cand" ] || continue
  cshow="$("$WORK/wg_show.sh" "$cand")"
  crepo="$(printf '%s' "$cshow" | python3 -c "import sys,json;d=json.load(sys.stdin);print((d['repositories'][0]['local_path'] if d['repositories'] else ''))")"
  cname="$(printf '%s' "$cshow" | python3 -c "import sys,json;d=json.load(sys.stdin);print((d['repositories'][0]['name'] if d['repositories'] else ''))")"
  read -r b r c <<< "$(gaffer_repo_pressure "$crepo" main "$cname")"
  if gaffer_repo_in_backpressure "$b" "$r" "$c"; then continue; fi
  PICKED="$cand"; break
done <<< "$CANDIDATES"
[ "$PICKED" = "301" ] && ok "walk skipped capped repoA (#201), selected free repoB (#301)" || fail "expected to pick #301, picked '${PICKED:-<none>}'"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"; exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
