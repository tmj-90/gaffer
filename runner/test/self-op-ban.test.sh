#!/usr/bin/env bash
# =====================================================================
# SELF-OPERATION BAN — unit tests for gaffer_is_self_target (factory.config.sh)
# + a wiring assertion that tick.sh refuses self-targets on BOTH paths.
# ---------------------------------------------------------------------
# Proves, against the REAL helper:
#   AC1  a path EQUAL to a component dir is a self-target
#   AC2  a path INSIDE a component dir (subdir) is a self-target
#   AC3  a trailing-slash target still matches (normalised)
#   AC4  a SYMLINKED dir resolving into a component is a self-target
#   AC5  an UNRELATED path is NOT a self-target
#   AC6  EMPTY/missing component vars are skipped (no false match, no error)
#   AC7  every component dir (dispatch/crew/memory/runner) is checked
#   AC8  the knob GAFFER_ALLOW_SELF_DELIVERY + helper are present in config
#   AC9  tick.sh wires the SELF-OP guard on the delivery AND bootstrap paths
#
# Zero deps beyond bash + coreutils. Run: bash test/self-op-ban.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR_REAL="$(cd "$HERE/.." && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/self-op-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# Build a controlled component layout (real dirs so canonicalisation works).
mkdir -p "$WORK/dispatch" "$WORK/crew" "$WORK/memory" "$WORK/runner" \
         "$WORK/elsewhere/normal-repo"

# Source the helper with the four component vars pinned at OUR temp dirs. The
# config uses `:=` defaults, so pre-setting these wins; RUNNER_DIR is pinned so
# config derivation + lib sourcing still resolve against the real checkout.
export DISPATCH_DIR="$WORK/dispatch"
export CREW_DIR="$WORK/crew"
export MEMORY_DIR="$WORK/memory"
export RUNNER_DIR="$WORK/runner"
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR_REAL/factory.config.sh"

echo "== AC1: a path EQUAL to a component dir is a self-target =="
gaffer_is_self_target "$WORK/dispatch" && ok "DISPATCH_DIR itself matches" \
  || fail "equal path to DISPATCH_DIR should match"

echo "== AC2: a path INSIDE a component dir (subdir) is a self-target =="
mkdir -p "$WORK/dispatch/src/cli"
gaffer_is_self_target "$WORK/dispatch/src/cli" && ok "subdir of DISPATCH_DIR matches" \
  || fail "subdir of DISPATCH_DIR should match"

echo "== AC3: a trailing-slash target still matches =="
gaffer_is_self_target "$WORK/dispatch/" && ok "trailing-slash path matches" \
  || fail "trailing-slash path should match"

echo "== AC4: a SYMLINKED dir resolving into a component is a self-target =="
ln -s "$WORK/crew" "$WORK/link-to-fg"
gaffer_is_self_target "$WORK/link-to-fg" && ok "symlink → CREW_DIR matches" \
  || fail "symlink resolving into CREW_DIR should match"

echo "== AC5: an UNRELATED path is NOT a self-target =="
if gaffer_is_self_target "$WORK/elsewhere/normal-repo"; then
  fail "an unrelated repo path must NOT match"
else
  ok "unrelated repo path does NOT match"
fi
# A near-miss sibling that shares a name PREFIX must not match (boundary check):
# DISPATCH_DIR is $WORK/dispatch; $WORK/dispatch-extra must NOT match it.
mkdir -p "$WORK/dispatch-extra"
if gaffer_is_self_target "$WORK/dispatch-extra"; then
  fail "sibling sharing a name prefix must NOT match (no boundary slash)"
else
  ok "sibling 'dispatch-extra' does NOT match (component boundary respected)"
fi

echo "== AC6: empty/missing component vars are skipped (no false match) =="
( unset DISPATCH_DIR CREW_DIR MEMORY_DIR RUNNER_DIR
  DISPATCH_DIR="$WORK/dispatch"
  # CREW_DIR / MEMORY_DIR / RUNNER_DIR deliberately empty.
  if gaffer_is_self_target "$WORK/elsewhere/normal-repo"; then exit 1; fi
  # The one populated component still matches.
  gaffer_is_self_target "$WORK/dispatch" || exit 1
) && ok "empty component vars skipped; populated one still matches" \
  || fail "empty component vars must be skipped without false match/error"
# An empty TARGET must not match anything.
if gaffer_is_self_target ""; then fail "empty target must not match"; else ok "empty target does NOT match"; fi

echo "== AC7: EVERY component dir is checked =="
for pair in "CREW_DIR:$WORK/crew" "MEMORY_DIR:$WORK/memory" "RUNNER_DIR:$WORK/runner"; do
  name="${pair%%:*}"; dir="${pair#*:}"
  mkdir -p "$dir/inner"
  gaffer_is_self_target "$dir/inner" && ok "$name subdir matches" \
    || fail "$name subdir should match"
done

echo "== AC8: knob + helper present in factory.config.sh =="
grep -q 'GAFFER_ALLOW_SELF_DELIVERY:=0' "$RUNNER_DIR_REAL/factory.config.sh" \
  && ok "GAFFER_ALLOW_SELF_DELIVERY knob defaults to 0" \
  || fail "missing GAFFER_ALLOW_SELF_DELIVERY:=0 knob"
grep -q 'gaffer_is_self_target()' "$RUNNER_DIR_REAL/factory.config.sh" \
  && ok "gaffer_is_self_target helper defined in config" \
  || fail "missing gaffer_is_self_target helper"

echo "== AC9: tick.sh wires the guard on BOTH paths =="
grep -q 'gaffer_is_self_target "\$PRIMARY_REPO"' "$RUNNER_DIR_REAL/tick.sh" \
  && ok "delivery path guards PRIMARY_REPO" \
  || fail "delivery path missing gaffer_is_self_target on PRIMARY_REPO"
grep -q 'gaffer_is_self_target "\$REPO_PATH"' "$RUNNER_DIR_REAL/tick.sh" \
  && ok "delivery path also guards REPO_PATH" \
  || fail "delivery path missing gaffer_is_self_target on REPO_PATH"
grep -q 'gaffer_is_self_target "\$B_DIR"' "$RUNNER_DIR_REAL/tick.sh" \
  && ok "bootstrap path guards B_DIR" \
  || fail "bootstrap path missing gaffer_is_self_target on B_DIR"
# The override must be honoured on both paths.
grep -cq 'GAFFER_ALLOW_SELF_DELIVERY' "$RUNNER_DIR_REAL/tick.sh" \
  && ok "tick.sh honours GAFFER_ALLOW_SELF_DELIVERY override" \
  || fail "tick.sh does not reference the override"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
