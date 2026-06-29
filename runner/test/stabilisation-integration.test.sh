#!/usr/bin/env bash
# =====================================================================
# STABILISATION end-to-end integration (tick.sh) — proves the gates fire
# against the REAL tick.sh + a REAL throwaway Dispatch DB + REAL git repos,
# with NO `claude -p` (the gates run in the runner, not the agent).
# ---------------------------------------------------------------------
#   PROOF A  BACKPRESSURE: a repo over the branch cap is SKIPPED — tick.sh
#            does not claim a ready ticket for it; it logs the skip and the
#            run-summary's backpressure file records the over-cap repo.
#   PROOF B  HYGIENE: gaffer_assert_clean_delivery (the exact function tick.sh
#            calls before submitting) REJECTS a branch carrying a planted bad
#            artifact (a self-referential node_modules symlink + a copied src
#            tree), proving the delivery would be parked, not submitted.
#
# Requires the built dispatch CLI. Run: bash test/stabilisation-integration.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
WG_CLI="$RUNNER_DIR/../packages/dispatch/dist/cli/index.js"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
skip_all() { echo "SKIP: dispatch CLI not built at $WG_CLI — cannot run integration test"; exit 0; }
[ -f "$WG_CLI" ] || skip_all

WORK="$(mktemp -d "${TMPDIR:-/tmp}/stab-int.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
DB="$WORK/wg.sqlite"
WG() { node "$WG_CLI" --db "$DB" "$@"; }

# A real git repo with a src/ tree (so a copied-src leak is detectable).
mk_repo() {
  local repo="$1"
  git init -q -b main "$repo"
  git -C "$repo" config user.email gaffer@test; git -C "$repo" config user.name gaffer-test
  mkdir -p "$repo/src"; printf 'export const x=1;\n' > "$repo/src/index.ts"
  printf 'base\n' > "$repo/README.md"
  git -C "$repo" add -A && git -C "$repo" commit -q -m base
}

REPO="$WORK/repo"; mk_repo "$REPO"
WG init >/dev/null 2>&1
WG repo add -n repo --path "$REPO" --branch main --stack typescript --test "true" >/dev/null 2>&1
TNUM="$(WG ticket create -t "Stabilisation integration ticket" -p solo_loose 2>&1 | python3 -c "import sys,json;print(json.load(sys.stdin)['ticket']['number'])")"
WG repo link "$TNUM" repo >/dev/null 2>&1
# GUARD A: every delivery-bound ticket needs ≥1 acceptance criterion to ready.
WG ac add "$TNUM" -t "Stabilisation integration AC" >/dev/null 2>&1
WG ticket ready "$TNUM" >/dev/null 2>&1
[ "$(WG ticket list -s ready 2>&1 | python3 -c "import sys,json;print(len(json.load(sys.stdin)))")" = "1" ] \
  && ok "fixture: 1 ready ticket targeting repo" || fail "fixture setup failed (no ready ticket)"

# The env every tick.sh sub-invocation needs (point the factory at OUR temp DB +
# data dir; DRY_RUN so no live agent / repo mutation).
COMMON_ENV=(
  "DISPATCH_DB=$DB"
  "GAFFER_DATA=$WORK/.gaffer"
  "DRY_RUN=1"
)
run_tick() { env "${COMMON_ENV[@]}" "$@" bash "$RUNNER_DIR/tick.sh" 2>&1; }

echo "== PROOF A: backpressure skips an over-cap repo =="
# Construct the over-cap condition: 3 UNMERGED gaffer/* branches in the real repo
# (== MAX_OPEN_AGENT_BRANCHES_PER_REPO default of 3) → repo in backpressure.
for i in 1 2 3; do
  git -C "$REPO" checkout -q -b "gaffer/ticket-pre-$i" main
  printf 'pre %s\n' "$i" >> "$REPO/README.md"
  git -C "$REPO" commit -q -am "pre $i"
done
git -C "$REPO" checkout -q main

OUT_BP="$(run_tick MAX_OPEN_AGENT_BRANCHES_PER_REPO=3)"
if printf '%s' "$OUT_BP" | grep -q 'BACKPRESSURE: skipping ready'; then
  ok "tick SKIPS the ready ticket — repo is over the branch cap"
else
  fail "expected a BACKPRESSURE skip log (got: $(printf '%s' "$OUT_BP" | tail -3))"
fi
if printf '%s' "$OUT_BP" | grep -q 'TICK_RESULT=no_work'; then
  ok "with the only repo backpressured, the tick yields no_work (no new claim)"
else
  fail "expected no_work when all ready repos are backpressured (got: $(printf '%s' "$OUT_BP" | grep TICK_RESULT=))"
fi
BP_FILE="$WORK/.gaffer/.backpressure-repos"
[ -s "$BP_FILE" ] && grep -q 'repo' "$BP_FILE" \
  && ok "backpressure-repos file records the over-cap repo (for run-summary)" \
  || fail "expected the over-cap repo recorded in $BP_FILE"

echo "== PROOF A (control): raising the cap lets the SAME ticket through =="
# With the cap raised above the 3 outstanding branches, the repo is no longer
# backpressured and the tick proceeds to plan delivery for the ticket.
OUT_OK="$(run_tick MAX_OPEN_AGENT_BRANCHES_PER_REPO=99)"
if printf '%s' "$OUT_OK" | grep -q "delivering #$TNUM"; then
  ok "cap raised to 99 → tick proceeds to deliver #$TNUM (backpressure lifted)"
else
  fail "raising the cap should let the ticket through (got: $(printf '%s' "$OUT_OK" | grep -E 'delivering|TICK_RESULT'))"
fi

echo "== PROOF B: hygiene rejects a planted bad delivery branch =="
# Plant the exact leaks the real run produced onto a delivery branch, then call
# the SAME function tick.sh calls before submitting.
# shellcheck source=../lib/hygiene.sh
source "$RUNNER_DIR/lib/hygiene.sh"
git -C "$REPO" checkout -q -b gaffer/ticket-bad main
ln -s . "$REPO/node_modules"                 # self-referential node_modules -> itself
mkdir -p "$REPO/src.ticket9"                  # copied source tree in the repo root
cp "$REPO/src/index.ts" "$REPO/src.ticket9/index.ts"
git -C "$REPO" add -A && git -C "$REPO" commit -q -m "bad: leaks"
HY_OUT="$(gaffer_assert_clean_delivery "$REPO" main)"; HY_RC=$?
git -C "$REPO" checkout -q main
if [ "$HY_RC" -ne 0 ]; then
  ok "planted bad branch → gaffer_assert_clean_delivery rejects it (return $HY_RC)"
else
  fail "planted bad branch should be rejected"
fi
printf '%s' "$HY_OUT" | grep -qiE 'self-referential|forbidden path' \
  && ok "rejection cites the node_modules leak" || fail "expected node_modules leak in reasons ($HY_OUT)"
printf '%s' "$HY_OUT" | grep -qi 'copied source tree' \
  && ok "rejection cites the copied src tree (src.ticket9/)" || fail "expected copied-src leak in reasons ($HY_OUT)"
# And tick.sh's enforcement path is present (parks, never submits).
grep -q 'HYGIENE: delivery for #\$NUM is NOT hygienic' "$RUNNER_DIR/tick.sh" \
  && ok "tick.sh parks (does not submit) a non-hygienic delivery" \
  || fail "tick.sh missing the hygiene park path"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
