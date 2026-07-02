#!/usr/bin/env bash
# =====================================================================
# MODEL ROUTING (audit item I1) — the config helper + tick.sh wiring + a real
# DRY_RUN tick that emits the routing audit line.
#
# Complements model-routing.test.mjs (the pure router). Proves, against the REAL
# factory.config.sh, route-model.mjs, and tick.sh:
#   AC1  gaffer_route_model echoes the routed model id + logs a "ROUTE …" line
#   AC2  a normal ticket routes implement→sonnet (REGRESSION: today's model)
#   AC3  a trivial ticket routes implement→haiku (cheapest-correct)
#   AC4  a high-risk ticket routes implement→opus
#   AC5  attempt>1 escalates the routed model up a tier
#   AC6  an explicit GAFFER_IMPL_MODEL override WINS (backward-compat)
#   AC7  a missing/unreadable registry never crashes the helper (fail-safe)
#   AC8  REGISTRY-AS-CONFIG: a tier change in a custom registry is picked up with
#        NO code change (GAFFER_MODEL_REGISTRY points at an edited file)
#   AC9  tick.sh wires the routed flag ($ROUTE_IMPL_FLAG) into the delivery call
#   AC10 a real DRY_RUN tick logs a "ROUTE #N …" decision line for the ticket
#
# Zero deps; needs bash + node (+ the built dispatch CLI for AC10, else AC10 skips).
# Run: bash test/model-routing.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

# Isolated data dir so the helper's log() writes don't touch a real factory log.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/model-routing.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# Source the real config in a subshell-free way: it defines gaffer_route_model +
# log(). Point GAFFER_DATA at our temp dir so the log goes there.
# shellcheck disable=SC1091
( :; ) # no-op to keep shellcheck calm about the source below
export GAFFER_DATA="$WORK/.gaffer"
mkdir -p "$GAFFER_DATA"
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
# tick.sh defines log(); factory.config.sh references it. Provide a minimal log()
# that appends to GAFFER_LOG so the ROUTE line is capturable (matches tick's shape).
log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" >> "$GAFFER_LOG"; }

route() { gaffer_route_model "$@"; }   # echoes the model id; logs a ROUTE line

echo "== AC1: gaffer_route_model echoes a model id + logs a ROUTE line =="
: > "$GAFFER_LOG"
M="$(route implement medium 3 typescript 1 101)"
if [ "$M" = "sonnet" ] && grep -q 'ROUTE #101 .* model=sonnet' "$GAFFER_LOG"; then
  ok "echoes 'sonnet' + logs ROUTE #101 with the chosen model"
else
  fail "expected model=sonnet + a ROUTE #101 log line (got model='$M', log='$(tail -1 "$GAFFER_LOG")')"
fi

echo "== AC2: REGRESSION — normal ticket routes implement→sonnet (today's model) =="
[ "$(route implement medium 3 typescript 1)" = sonnet ] \
  && ok "normal (medium, 3 AC, attempt 1) → sonnet" || fail "normal ticket must route to sonnet"

echo "== AC3: trivial ticket → haiku (cheapest-correct) =="
[ "$(route implement low 1 typescript 1)" = haiku ] \
  && ok "trivial (low, 1 AC) → haiku" || fail "trivial ticket must route to haiku"

echo "== AC4: high-risk ticket → opus =="
[ "$(route implement high 2 typescript 1)" = opus ] \
  && ok "high-risk → opus" || fail "high-risk ticket must route to opus"

echo "== AC5: attempt>1 escalates a tier =="
[ "$(route implement medium 2 typescript 2)" = opus ] \
  && ok "attempt 2 (mid → strong) → opus" || fail "attempt 2 must escalate mid→opus"

echo "== AC6: explicit GAFFER_IMPL_MODEL override WINS (backward-compat) =="
# An override is honoured only when GAFFER_IMPL_MODEL_EXPLICIT=1 (operator-set) —
# the config captures that flag before applying its opus/sonnet default, so the
# default tiers do NOT suppress routing. Here we simulate the operator-set case.
OUT_OVR="$(GAFFER_IMPL_MODEL=my-pinned-model GAFFER_IMPL_MODEL_EXPLICIT=1 route implement low 1 typescript 1)"
[ "$OUT_OVR" = "my-pinned-model" ] \
  && ok "an operator-set GAFFER_IMPL_MODEL pins the implement model regardless of routing" \
  || fail "explicit override should win (got '$OUT_OVR')"
# And the DEFAULT (non-explicit) sonnet does NOT suppress routing: a trivial ticket
# still routes to haiku even though GAFFER_IMPL_MODEL holds its sonnet default.
OUT_NOOVR="$(route implement low 1 typescript 1)"
[ "$OUT_NOOVR" = haiku ] \
  && ok "the config's default GAFFER_IMPL_MODEL=sonnet does NOT suppress routing" \
  || fail "default GAFFER_IMPL_MODEL must not act as an override (got '$OUT_NOOVR')"

echo "== AC7: missing registry → fail-safe, never crashes =="
OUT_MISS="$(GAFFER_MODEL_REGISTRY=/no/such/file.json route implement medium 2 typescript 1)"
# The router's FALLBACK_REGISTRY mirrors the shipped defaults → still sonnet.
[ "$OUT_MISS" = sonnet ] \
  && ok "missing registry falls back to the built-in default (sonnet), no crash" \
  || fail "missing registry should fail safe to sonnet (got '$OUT_MISS')"

echo "== AC8: REGISTRY-AS-CONFIG — a tier change is picked up, no code change =="
CUSTOM="$WORK/custom-registry.json"
cat > "$CUSTOM" <<'JSON'
{
  "tiers": { "cheap": "haiku", "mid": "sonnet-vNEXT", "strong": "opus" },
  "escalationOrder": ["cheap", "mid", "strong"],
  "phaseDefaults": { "implement": "mid", "plan": "strong" }
}
JSON
OUT_CUSTOM="$(GAFFER_MODEL_REGISTRY="$CUSTOM" route implement medium 3 typescript 1)"
[ "$OUT_CUSTOM" = "sonnet-vNEXT" ] \
  && ok "editing the registry's mid tier reroutes implement (config-only)" \
  || fail "custom registry mid tier should be used (got '$OUT_CUSTOM')"

echo "== AC9: tick.sh wires the routed flag into the delivery call =="
grep -q 'ROUTE_IMPL_FLAG="--model \$DELIVERY_MODEL"' "$RUNNER_DIR/tick.sh" \
  && ok "tick.sh builds ROUTE_IMPL_FLAG from the routed model" \
  || fail "tick.sh should build ROUTE_IMPL_FLAG from \$DELIVERY_MODEL"
# The delivery routes through the worker seam (Spec 3 / Phase 1) with the PER-ATTEMPT
# implement flag ($_ATTEMPT_IMPL_FLAG) as the model argument — the escalation ladder
# initialises it to the routed $ROUTE_IMPL_FLAG on attempt 1 and escalates to the
# stronger model on the final rework attempt. worker_deliver then splices that model
# flag between $CLAUDE_FLAGS and $GAFFER_MAX_TURNS_FLAG on the invocation.
grep -qE 'worker_deliver "\$PRIMARY_REPO" "\$PROMPT\$_REWORK_BLOCK" "\$_ATTEMPT_IMPL_FLAG"' "$RUNNER_DIR/tick.sh" \
  && ok "the delivery call passes \$_ATTEMPT_IMPL_FLAG as the worker model flag (routed by default, escalates on the final attempt)" \
  || fail "the delivery worker_deliver call should pass \$_ATTEMPT_IMPL_FLAG as the model argument"
grep -q 'CLAUDE_FLAGS \$model_flag \$GAFFER_MAX_TURNS_FLAG' "$RUNNER_DIR/lib/worker.sh" \
  && ok "worker_deliver splices the model flag between \$CLAUDE_FLAGS and \$GAFFER_MAX_TURNS_FLAG" \
  || fail "worker_deliver should splice \$model_flag between \$CLAUDE_FLAGS and \$GAFFER_MAX_TURNS_FLAG"
grep -q '_ATTEMPT_IMPL_FLAG="\$ROUTE_IMPL_FLAG"' "$RUNNER_DIR/tick.sh" \
  && ok "the per-attempt flag defaults to the routed \$ROUTE_IMPL_FLAG (attempt 1)" \
  || fail "the per-attempt flag should default to \$ROUTE_IMPL_FLAG"
grep -q 'gaffer_route_model implement' "$RUNNER_DIR/tick.sh" \
  && ok "tick.sh calls gaffer_route_model for the implement phase" \
  || fail "tick.sh should call gaffer_route_model implement"

echo "== AC10: a real DRY_RUN tick logs a ROUTE #N decision line =="
WG_CLI="$RUNNER_DIR/../packages/dispatch/dist/cli/index.js"
if [ ! -f "$WG_CLI" ] || ! node "$WG_CLI" --help >/dev/null 2>&1; then
  ok "SKIP AC10 — dispatch CLI not built (router unit + wiring already proven)"
else
  DB="$WORK/wg.sqlite"
  WG() { node "$WG_CLI" --db "$DB" "$@"; }
  REPO="$WORK/repo"; git init -q -b main "$REPO"
  git -C "$REPO" config user.email gaffer@test; git -C "$REPO" config user.name gaffer-test
  printf 'base\n' > "$REPO/README.md"; git -C "$REPO" add -A && git -C "$REPO" commit -q -m base
  WG init >/dev/null 2>&1
  WG repo add -n repo --path "$REPO" --branch main --stack typescript --test "true" >/dev/null 2>&1
  NUM="$(WG ticket create -t "Routing smoke" -p solo_loose 2>&1 | python3 -c "import sys,json;print(json.load(sys.stdin)['ticket']['number'])" 2>/dev/null || echo '')"
  if [ -z "$NUM" ]; then
    fail "could not create a ticket for the DRY_RUN smoke"
  else
    WG repo link "$NUM" repo >/dev/null 2>&1
    # GUARD A: a delivery-bound ticket needs ≥1 acceptance criterion to ready.
    WG ac add "$NUM" -t "Routing smoke AC" >/dev/null 2>&1
    WG ticket ready "$NUM" >/dev/null 2>&1
    SMOKE_DATA="$WORK/.gaffer-tick"
    OUT="$(env DISPATCH_DB="$DB" GAFFER_DATA="$SMOKE_DATA" DRY_RUN=1 \
            bash "$RUNNER_DIR/tick.sh" 2>&1)"
    if printf '%s' "$OUT" | grep -q "ROUTE #$NUM .*phase=implement"; then
      ok "DRY_RUN tick logs 'ROUTE #$NUM phase=implement …' for the delivered ticket"
    else
      fail "expected a ROUTE #$NUM line (got: $(printf '%s' "$OUT" | grep -iE 'ROUTE|delivering|TICK_RESULT' | tail -4))"
    fi
    if printf '%s' "$OUT" | grep -q "routed implement model ="; then
      ok "DRY_RUN tick logs the routed implement model"
    else
      fail "expected a 'routed implement model =' DRY_RUN line"
    fi
  fi
fi

echo "== AC11: diff SIZE is measured from the real patch, not a --stat summary =="
# A delivery worktree with a LARGE uncommitted diff must route STRONGER (diffBytes
# high → difficulty high → +1 tier); a tiny diff must NOT escalate. This proves the
# #4 fix: the old `git diff --stat=10000 | wc -c` measured the STAT SUMMARY (~60 B for
# any change), so a 40 KB diff never crossed HIGH_DIFF_BYTES and "big diff → stronger"
# never fired. gaffer_route_model takes the worktree as its 7th positional arg.
if command -v git >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  DIFF_WT="$WORK/diff-wt"
  git init -q -b main "$DIFF_WT"
  git -C "$DIFF_WT" config user.email gaffer@test; git -C "$DIFF_WT" config user.name gaffer-test
  printf 'base\n' > "$DIFF_WT/f.txt"
  git -C "$DIFF_WT" add -A && git -C "$DIFF_WT" commit -q -m base
  # >40 KB working-tree change vs HEAD (crosses HIGH_DIFF_BYTES=40000).
  node -e 'process.stdout.write("a large line of accumulated change\n".repeat(2000))' > "$DIFF_WT/f.txt"
  BIG_BYTES="$(git -C "$DIFF_WT" diff HEAD | wc -c | tr -d ' ')"
  BIG="$(route implement medium 3 typescript 1 900 "$DIFF_WT")"
  if [ "${BIG_BYTES:-0}" -gt 40000 ] && [ "$BIG" = opus ]; then
    ok "large diff (${BIG_BYTES} B) → diffBytes high → routes stronger (opus)"
  else
    fail "large diff must route stronger (bytes=$BIG_BYTES model=$BIG; a --stat summary measures ~60 B)"
  fi
  # A tiny change carries no high signal → it must NOT escalate to the strong tier.
  printf 'base2\n' > "$DIFF_WT/f.txt"
  SMALL="$(route implement medium 3 typescript 1 900 "$DIFF_WT")"
  [ "$SMALL" != opus ] \
    && ok "small diff stays cheap — does NOT escalate to opus (got $SMALL)" \
    || fail "small diff must not route stronger (got $SMALL)"
else
  ok "SKIP AC11 — git/node unavailable"
fi

echo "== AC12: FINDING-9 — worktree ABSENT + COMMITTED rework on a preserved branch feeds the router =="
# The REAL call path: tick.sh routes BEFORE any worktree exists, and a rework
# attempt's accumulated work is COMMITTED on the preserved gaffer/ branch — so a
# worktree `git diff HEAD` can never see it (AC11's hand-built worktree with an
# UNCOMMITTED diff masked exactly this). gaffer_route_model's args 8-10
# (<repo> <branch> <base>) let it measure the ACCUMULATED rework diff from the
# repo itself (git diff base...branch) when the worktree gives no signal.
if command -v git >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  RW_REPO="$WORK/rework-repo"
  git init -q -b main "$RW_REPO"
  git -C "$RW_REPO" config user.email gaffer@test; git -C "$RW_REPO" config user.name gaffer-test
  printf 'base\n' > "$RW_REPO/f.txt"
  git -C "$RW_REPO" add -A && git -C "$RW_REPO" commit -q -m base
  # Preserved rework branch with a >40 KB COMMITTED diff vs main (crosses
  # HIGH_DIFF_BYTES=40000); the repo checkout returns to main, exactly like a
  # real repo between rework attempts (branch preserved, worktree torn down).
  git -C "$RW_REPO" checkout -q -b gaffer/ticket-901-rework
  node -e 'process.stdout.write("a large line of accumulated rework\n".repeat(2000))' > "$RW_REPO/f.txt"
  git -C "$RW_REPO" add -A && git -C "$RW_REPO" commit -q -m "rework attempt 1"
  git -C "$RW_REPO" checkout -q main
  ACC_BYTES="$(git -C "$RW_REPO" diff main...gaffer/ticket-901-rework | wc -c | tr -d ' ')"
  MISSING_WT="$WORK/worktrees/ticket-901/primary"   # deliberately NOT created
  : > "$GAFFER_LOG"
  RW="$(route implement medium 3 typescript 1 901 "$MISSING_WT" "$RW_REPO" gaffer/ticket-901-rework main)"
  if [ "${ACC_BYTES:-0}" -gt 40000 ] && [ "$RW" = opus ] && grep -q "ROUTE #901 .*difficulty 'high'" "$GAFFER_LOG"; then
    ok "committed rework (${ACC_BYTES} B, worktree absent) → accumulated-diff signal → routes stronger (opus)"
  else
    fail "committed rework on a preserved branch must reach the router (bytes=$ACC_BYTES model=$RW log='$(tail -1 "$GAFFER_LOG")')"
  fi
  # A SMALL committed rework must not escalate — no false high signal from the
  # repo-side measurement.
  git -C "$RW_REPO" checkout -q -b gaffer/ticket-902-small main
  printf 'tiny\n' >> "$RW_REPO/f.txt"
  git -C "$RW_REPO" add -A && git -C "$RW_REPO" commit -q -m small
  git -C "$RW_REPO" checkout -q main
  SMALL_RW="$(route implement medium 3 typescript 1 902 "$MISSING_WT" "$RW_REPO" gaffer/ticket-902-small main)"
  [ "$SMALL_RW" != opus ] \
    && ok "small committed rework does NOT escalate (got $SMALL_RW)" \
    || fail "small committed rework must not route stronger (got $SMALL_RW)"
  # A missing branch (first attempt — nothing preserved) yields no signal, no crash.
  NOBR="$(route implement medium 3 typescript 1 903 "$MISSING_WT" "$RW_REPO" gaffer/ticket-903-none main)"
  [ "$NOBR" = sonnet ] \
    && ok "missing preserved branch → no signal, normal route (sonnet), no crash" \
    || fail "missing branch should route normally (got $NOBR)"
else
  ok "SKIP AC12 — git/node unavailable"
fi

echo "== AC13: tick.sh wires the repo/branch/base rework-diff args into the route call =="
grep -q 'gaffer_route_model implement .*"\$ROUTE_REPO" "\$WORK_BRANCH" "\$ROUTE_BASE"' "$RUNNER_DIR/tick.sh" \
  && ok "tick.sh passes the real repo + preserved branch + base to gaffer_route_model" \
  || fail "tick.sh should pass \$ROUTE_REPO \$WORK_BRANCH \$ROUTE_BASE to gaffer_route_model"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"; exit 0
else
  printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
fi
