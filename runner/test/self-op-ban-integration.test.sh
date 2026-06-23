#!/usr/bin/env bash
# =====================================================================
# SELF-OPERATION BAN end-to-end integration (tick.sh) — proves the guard
# fires against the REAL tick.sh + a REAL throwaway Dispatch DB, with NO
# `claude -p` (the guard runs in the runner, before any worktree is made).
# ---------------------------------------------------------------------
#   PROOF A  A ready ticket whose target repo IS a Gaffer component
#            (DISPATCH_DIR) is REFUSED by default: tick.sh logs SELF-OP,
#            does NOT deliver, un-readies the ticket (ready -> draft, the board's
#            existing set-aside) and records it in the per-run skip file — so it
#            is set aside for a human and NOT infinitely re-claimed.
#   PROOF B  (override) GAFFER_ALLOW_SELF_DELIVERY=1 restores today's behaviour:
#            the SAME ticket proceeds to the normal delivery plan.
#   PROOF C  (control) a NON-Gaffer target is unaffected — delivered as before.
#
# Requires the built dispatch CLI. Run: bash test/self-op-ban-integration.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
WG_CLI="$RUNNER_DIR/../packages/dispatch/dist/cli/index.js"
# The Gaffer component we will target (the real, built dispatch checkout).
GAFFER_COMPONENT="$(cd "$RUNNER_DIR/../packages/dispatch" 2>/dev/null && pwd -P || true)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
skip_all() { echo "SKIP: $1"; exit 0; }
[ -f "$WG_CLI" ] || skip_all "dispatch CLI not built at $WG_CLI"
[ -n "$GAFFER_COMPONENT" ] && git -C "$GAFFER_COMPONENT" rev-parse --git-dir >/dev/null 2>&1 \
  || skip_all "dispatch checkout not a git repo at $RUNNER_DIR/../packages/dispatch"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/self-op-int.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
DB="$WORK/wg.sqlite"
WG() { node "$WG_CLI" --db "$DB" "$@"; }

mk_repo() {
  local repo="$1"
  git init -q -b main "$repo"
  git -C "$repo" config user.email gaffer@test; git -C "$repo" config user.name gaffer-test
  mkdir -p "$repo/src"; printf 'export const x=1;\n' > "$repo/src/index.ts"
  printf 'base\n' > "$repo/README.md"
  git -C "$repo" add -A && git -C "$repo" commit -q -m base
}

WG init >/dev/null 2>&1

# Ticket 1: targets the Gaffer component (dispatch) — the self-target.
WG repo add -n dispatch --path "$GAFFER_COMPONENT" --branch main --stack typescript --test "true" >/dev/null 2>&1
SELF_NUM="$(WG ticket create -t "Self-op: tweak dispatch" -p solo_loose 2>&1 | python3 -c "import sys,json;print(json.load(sys.stdin)['ticket']['number'])")"
WG repo link "$SELF_NUM" dispatch >/dev/null 2>&1
WG ticket ready "$SELF_NUM" >/dev/null 2>&1

# Ticket 2 (control): targets a normal, non-Gaffer repo.
NORMAL="$WORK/normal-repo"; mk_repo "$NORMAL"
WG repo add -n normal-repo --path "$NORMAL" --branch main --stack typescript --test "true" >/dev/null 2>&1
NORM_NUM="$(WG ticket create -t "Normal: tweak the readme" -p solo_loose 2>&1 | python3 -c "import sys,json;print(json.load(sys.stdin)['ticket']['number'])")"
WG repo link "$NORM_NUM" normal-repo >/dev/null 2>&1

# The env every tick.sh sub-invocation needs: OUR temp DB + data dir; DRY_RUN so
# no live agent / repo mutation. DISPATCH_DIR stays the REAL built checkout so
# the wg() CLI works AND so the self-target match is meaningful.
COMMON_ENV=(
  "DISPATCH_DB=$DB"
  "GAFFER_DATA=$WORK/.gaffer"
  "DRY_RUN=1"
)
run_tick() { env "${COMMON_ENV[@]}" "$@" bash "$RUNNER_DIR/tick.sh" 2>&1; }
ticket_status() { WG ticket show "$1" 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin)['ticket']['status'])"; }

# Only the self-target ticket is ready for PROOF A/B (isolate it).
echo "== PROOF A: a self-target delivery is REFUSED by default =="
OUT_REFUSE="$(run_tick)"
if printf '%s' "$OUT_REFUSE" | grep -q 'SELF-OP: refusing to deliver'; then
  ok "tick logs SELF-OP refusal for the self-target ticket"
else
  fail "expected a SELF-OP refusal log (got: $(printf '%s' "$OUT_REFUSE" | tail -4))"
fi
if printf '%s' "$OUT_REFUSE" | grep -q "delivering #$SELF_NUM"; then
  fail "self-target ticket must NOT proceed to delivery"
else
  ok "self-target ticket does NOT proceed to delivery"
fi
if printf '%s' "$OUT_REFUSE" | grep -q 'TICK_RESULT=no_work'; then
  ok "tick yields no_work (set aside, not delivered)"
else
  fail "expected no_work (got: $(printf '%s' "$OUT_REFUSE" | grep TICK_RESULT=))"
fi
# Set aside for a human: un-readied out of `ready` AND recorded in the skip file.
ST="$(ticket_status "$SELF_NUM")"
[ "$ST" != "ready" ] && ok "self-target ticket is set aside (status=$ST, out of 'ready')" \
  || fail "expected self-target ticket out of 'ready' (status=$ST)"
SKIP_FILE="$WORK/.gaffer/.failed-tickets"
[ -f "$SKIP_FILE" ] && grep -qx "$SELF_NUM" "$SKIP_FILE" \
  && ok "self-target ticket recorded in the per-run skip file" \
  || fail "expected #$SELF_NUM in $SKIP_FILE"

echo "== PROOF A (no infinite re-claim): a second tick does not re-select it =="
# It is no longer 'ready' (un-readied), so the next tick finds no deliverable work.
OUT_AGAIN="$(run_tick)"
if printf '%s' "$OUT_AGAIN" | grep -q "delivering #$SELF_NUM"; then
  fail "set-aside self-target must not be re-claimed on a later tick"
else
  ok "later tick does NOT re-claim the set-aside self-target"
fi

echo "== PROOF B (override): GAFFER_ALLOW_SELF_DELIVERY=1 restores delivery =="
# Re-ready a fresh self-target ticket (the first is now blocked).
SELF2="$(WG ticket create -t "Self-op override: tweak dispatch" -p solo_loose 2>&1 | python3 -c "import sys,json;print(json.load(sys.stdin)['ticket']['number'])")"
WG repo link "$SELF2" dispatch >/dev/null 2>&1
WG ticket ready "$SELF2" >/dev/null 2>&1
OUT_OVERRIDE="$(run_tick GAFFER_ALLOW_SELF_DELIVERY=1)"
if printf '%s' "$OUT_OVERRIDE" | grep -q "delivering #$SELF2"; then
  ok "override → the self-target ticket proceeds to delivery (today's behaviour restored)"
else
  fail "GAFFER_ALLOW_SELF_DELIVERY=1 should let the self-target through (got: $(printf '%s' "$OUT_OVERRIDE" | grep -E 'SELF-OP|delivering|TICK_RESULT'))"
fi
if printf '%s' "$OUT_OVERRIDE" | grep -q 'SELF-OP'; then
  fail "override must not log a SELF-OP refusal"
else
  ok "override emits NO SELF-OP refusal"
fi

echo "== PROOF C (control): a NON-Gaffer target is unaffected =="
# Un-ready the override self-target so only the normal ticket is deliverable,
# then ready the normal ticket.
WG ticket move "$SELF2" draft >/dev/null 2>&1 || true
WG ticket ready "$NORM_NUM" >/dev/null 2>&1
OUT_NORMAL="$(run_tick)"
if printf '%s' "$OUT_NORMAL" | grep -q "delivering #$NORM_NUM"; then
  ok "non-Gaffer target proceeds to delivery as before"
else
  fail "non-Gaffer target should be unaffected (got: $(printf '%s' "$OUT_NORMAL" | grep -E 'SELF-OP|delivering|TICK_RESULT'))"
fi
if printf '%s' "$OUT_NORMAL" | grep -q 'SELF-OP'; then
  fail "a non-Gaffer target must NOT trigger the SELF-OP guard"
else
  ok "non-Gaffer target emits NO SELF-OP log (guard is additive)"
fi

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
