#!/usr/bin/env bash
# =====================================================================
# AUTONOMY MODE — the single GAFFER_MODE cluster selector.
# ---------------------------------------------------------------------
# One knob (GAFFER_MODE) sets a whole cluster of autonomy flags together
# so an operator can't half-configure autonomy. This proves the cluster
# resolution + the precedence rule by sourcing factory.config.sh in a
# CLEAN env (no settings.json) and reading the 6 flags back:
#   1. GAFFER_MODE unset  → the 6 flags equal today's SUPERVISED defaults
#      (human/0/0/0/0/0) — backward-compatible, byte-identical to before.
#   2. GAFFER_MODE=autonomous → the full AUTONOMOUS cluster (agent/1/1/1/1/1).
#   3. GAFFER_MODE=strict     → autonomous cluster + STRICT_MODE=1.
#   4. GAFFER_MODE=autonomous with an explicit AUTO_MERGE=0 in the env →
#      AUTO_MERGE stays 0 (a real env var beats the mode default).
# Hermetic: empty GAFFER_DATA, so the settings.json loader is a no-op and
# the only inputs are the env vars we pass. Zero deps beyond bash.
# Run: bash runner/test/autonomy-mode.test.sh   (bash 3.2 safe)
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/autonomy-mode.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/data"   # empty → no settings.json, so the loader is inert

# Source factory.config.sh in a clean env with the given extra vars, then echo
# the 6 autonomy flags. Each probe is a fresh, side-effect-free source.
#   $@  = extra `NAME=value` env assignments for the mode/override under test
probe() {
  env -i PATH="$PATH" HOME="$HOME" GAFFER_DATA="$WORK/data" "$@" \
    bash -c '
      source "'"$RUNNER_DIR"'/factory.config.sh" >/dev/null 2>&1
      printf "REVIEW_MODE=%s\n"                "${REVIEW_MODE:-}"
      printf "DISPATCH_ALLOW_AGENT_APPROVE=%s\n" "${DISPATCH_ALLOW_AGENT_APPROVE:-}"
      printf "MERGE_ON_AGENT_REVIEW=%s\n"      "${MERGE_ON_AGENT_REVIEW:-}"
      printf "AUTO_MERGE=%s\n"                 "${AUTO_MERGE:-}"
      printf "GAFFER_AUTO_PUSH=%s\n"           "${GAFFER_AUTO_PUSH:-}"
      printf "MEMORY_AUTO_APPROVE=%s\n"        "${MEMORY_AUTO_APPROVE:-}"
      printf "STRICT_MODE=%s\n"                "${STRICT_MODE:-}"
    '
}

val() { printf '%s\n' "$1" | sed -n "s/^$2=//p"; }

# Assert one flag from a probe's output blob equals the expected value.
expect() {
  local blob="$1" key="$2" want="$3" label="$4" got
  got="$(val "$blob" "$key")"
  [ "$got" = "$want" ] \
    && ok "$label ($key=$got)" \
    || fail "$label — expected $key=$want, got '$got'"
}

echo "== 1: GAFFER_MODE unset → today's supervised defaults (backward-compat) =="
OUT="$(probe)"
expect "$OUT" REVIEW_MODE                 human "supervised: human review"
expect "$OUT" DISPATCH_ALLOW_AGENT_APPROVE 0    "supervised: no agent approval"
expect "$OUT" MERGE_ON_AGENT_REVIEW        0    "supervised: no merge-on-agent-review"
expect "$OUT" AUTO_MERGE                   0    "supervised: no auto-merge"
expect "$OUT" GAFFER_AUTO_PUSH             0    "supervised: no auto-push"
expect "$OUT" MEMORY_AUTO_APPROVE          0    "supervised: no memory auto-approve"
expect "$OUT" STRICT_MODE                  0    "supervised: no strict sandbox"

echo "== 2: GAFFER_MODE=autonomous → the autonomous cluster =="
OUT="$(probe GAFFER_MODE=autonomous)"
expect "$OUT" REVIEW_MODE                 agent "autonomous: agent review"
expect "$OUT" DISPATCH_ALLOW_AGENT_APPROVE 1    "autonomous: agent approval on"
expect "$OUT" MERGE_ON_AGENT_REVIEW        1    "autonomous: merge-on-agent-review on"
expect "$OUT" AUTO_MERGE                   1    "autonomous: auto-merge on"
expect "$OUT" GAFFER_AUTO_PUSH             1    "autonomous: auto-push on"
expect "$OUT" MEMORY_AUTO_APPROVE          1    "autonomous: memory auto-approve on"
expect "$OUT" STRICT_MODE                  0    "autonomous: sandbox still off"

echo "== 2b: GAFFER_MODE=graduated → reviewer runs, but env floor stays SUPERVISED =="
# The distinguishing posture: REVIEW_MODE=agent (a verdict exists to act on) while every
# autonomy env flag stays at the supervised floor — so the per-repo/risk policy is the
# ONLY allow-path and the runner ships only what a repo has EARNED.
OUT="$(probe GAFFER_MODE=graduated)"
expect "$OUT" REVIEW_MODE                 agent "graduated: agent review runs"
expect "$OUT" DISPATCH_ALLOW_AGENT_APPROVE 0    "graduated: approve floor OFF (policy is the allow-path)"
expect "$OUT" MERGE_ON_AGENT_REVIEW        0    "graduated: merge floor held"
expect "$OUT" AUTO_MERGE                   0    "graduated: auto-merge floor held"
expect "$OUT" GAFFER_AUTO_PUSH             0    "graduated: no auto-push (earned merges land locally)"
expect "$OUT" MEMORY_AUTO_APPROVE          0    "graduated: memory auto-approve off"
expect "$OUT" STRICT_MODE                  0    "graduated: no strict sandbox"

echo "== 3: GAFFER_MODE=strict → autonomous cluster + STRICT_MODE=1 =="
OUT="$(probe GAFFER_MODE=strict)"
expect "$OUT" REVIEW_MODE                 agent "strict: agent review"
expect "$OUT" DISPATCH_ALLOW_AGENT_APPROVE 1    "strict: agent approval on"
expect "$OUT" MERGE_ON_AGENT_REVIEW        1    "strict: merge-on-agent-review on"
expect "$OUT" AUTO_MERGE                   1    "strict: auto-merge on"
expect "$OUT" GAFFER_AUTO_PUSH             1    "strict: auto-push on"
expect "$OUT" MEMORY_AUTO_APPROVE          1    "strict: memory auto-approve on"
expect "$OUT" STRICT_MODE                  1    "strict: OS sandbox containment on"

echo "== 4: explicit env override beats the mode default =="
OUT="$(probe GAFFER_MODE=autonomous AUTO_MERGE=0)"
expect "$OUT" AUTO_MERGE                   0    "override: pinned AUTO_MERGE=0 wins over mode"
expect "$OUT" MERGE_ON_AGENT_REVIEW        1    "override: rest of the cluster still applies"
expect "$OUT" GAFFER_AUTO_PUSH             1    "override: only the pinned flag is overridden"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
