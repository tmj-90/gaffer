#!/usr/bin/env bash
# =====================================================================
# LITE MODE — auto-approve genuinely TRIVIAL tickets without a human reviewer,
# hold everything else, and NEVER auto-merge (a human still lands the change).
# ---------------------------------------------------------------------
# Pins, hermetically (env -i, no network, no DB):
#   1. gaffer_lite_trivial_reason (PURE) classifies trivial vs non-trivial from
#      (risk, lines, files, paths): low-risk + tiny + no sensitive path = trivial;
#      any of risk≠low / oversized / sensitive-path = nontrivial:<reason>. Caps are
#      operator-tunable (GAFFER_LITE_MAX_LINES/FILES, GAFFER_LITE_SENSITIVE_RE).
#   2. The `GAFFER_MODE=lite` preset sets REVIEW_MODE=agent + the approve FLOOR on,
#      keeps AUTO_MERGE / MERGE_ON_AGENT_REVIEW off (human merges), and — because
#      auto-approve removes the human quality gate — trips GAFFER_STRICT_REQUIRE=1
#      (OS sandbox mandatory), the same containment invariant autonomy uses.
#   3. The ship-plan the runner feeds for a lite ticket: trivial → (approve=allow,
#      merge=deny) → approve_hold; non-trivial → (approve=deny) → hold.
# Containment is NOT a lite concern: DoD/hygiene stay enforced (untouched here) and
# the safety hook / worktree isolation / egress are mode-independent.
# Zero deps beyond bash + python3. bash 3.2 safe. Run: bash runner/test/lite-mode.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 required"; exit 0; }
[ -f "$RUNNER_DIR/factory.config.sh" ] || { echo "SKIP: factory.config.sh not found"; exit 0; }

PASS=0
FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
eq()   { [ "$2" = "$3" ] && ok "$1 ($2)" || fail "$1 — expected '$3', got '$2'"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/lite-mode.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/data"   # empty → the settings.json loader is inert

# Source factory.config.sh in a clean env and call the PURE classifier directly.
# LITE_ENV carries optional cap overrides (e.g. GAFFER_LITE_MAX_LINES=5) into env -i.
lite_reason() {
  env -i PATH="$PATH" HOME="$HOME" GAFFER_DATA="$WORK/data" \
    ${LITE_ENV:-} bash -c '
      source "'"$RUNNER_DIR"'/factory.config.sh" >/dev/null 2>&1
      gaffer_lite_trivial_reason "$1" "$2" "$3" "$4"' _ "$1" "$2" "$3" "$4"
}

echo "== 1: gaffer_lite_trivial_reason — the PURE trivial classifier =="
eq "low + tiny code change → trivial"          "$(lite_reason low 10 2 'src/util.ts')"                 trivial
eq "low + doc change → trivial"                "$(lite_reason low 8 1 'README.md')"                    trivial
eq "medium risk → nontrivial:risk"             "$(lite_reason medium 5 1 'src/a.ts')"                  nontrivial:risk=medium
eq "high risk → nontrivial:risk"               "$(lite_reason high 3 1 'src/a.ts')"                    nontrivial:risk=high
eq "oversized lines → nontrivial:lines"        "$(lite_reason low 200 2 'src/a.ts')"                   nontrivial:lines=200\>60
eq "too many files → nontrivial:files"         "$(lite_reason low 10 9 'a b c d e f g h i')"           nontrivial:files=9\>4
eq "migration path → nontrivial:sensitive"     "$(lite_reason low 10 1 'db/migrations/001_init.sql')"  nontrivial:sensitive-path
eq "CI workflow path → nontrivial:sensitive"   "$(lite_reason low 10 1 '.github/workflows/ci.yml')"    nontrivial:sensitive-path
eq "auth path → nontrivial:sensitive"          "$(lite_reason low 10 1 'packages/auth/login.ts')"      nontrivial:sensitive-path
eq "lockfile → nontrivial:sensitive"           "$(lite_reason low 10 1 'pnpm-lock.yaml')"              nontrivial:sensitive-path
eq ".env → nontrivial:sensitive"               "$(lite_reason low 10 1 '.env.production')"             nontrivial:sensitive-path
# one sensitive path among several safe ones still blocks
eq "mixed paths, one sensitive → nontrivial"   "$(lite_reason low 10 2 "$(printf 'src/a.ts\ndb/migrations/2.sql')")" nontrivial:sensitive-path
# empty / non-numeric size fails closed (treated as large)
eq "garbage line count → nontrivial (closed)"  "$(lite_reason low abc 1 'src/a.ts')"                   nontrivial:lines=999999\>60

echo "== 2: tunable caps (GAFFER_LITE_MAX_LINES / _FILES / _SENSITIVE_RE) =="
eq "tighter line cap flips a former-trivial" \
  "$(LITE_ENV='GAFFER_LITE_MAX_LINES=5' lite_reason low 10 1 'src/a.ts')" nontrivial:lines=10\>5
eq "tighter file cap flips a former-trivial" \
  "$(LITE_ENV='GAFFER_LITE_MAX_FILES=1' lite_reason low 5 2 'a b')" nontrivial:files=2\>1
eq "custom sensitive RE catches a new path" \
  "$(LITE_ENV='GAFFER_LITE_SENSITIVE_RE=payments/' lite_reason low 5 1 'src/payments/charge.ts')" nontrivial:sensitive-path

echo "== 3: the GAFFER_MODE=lite preset =="
preset() {
  env -i PATH="$PATH" HOME="$HOME" GAFFER_DATA="$WORK/data" GAFFER_MODE=lite bash -c '
    source "'"$RUNNER_DIR"'/factory.config.sh" >/dev/null 2>&1
    printf "%s %s %s %s %s\n" \
      "${REVIEW_MODE:-unset}" "${DISPATCH_ALLOW_AGENT_APPROVE:-unset}" \
      "${AUTO_MERGE:-unset}" "${MERGE_ON_AGENT_REVIEW:-unset}" "${GAFFER_STRICT_REQUIRE:-unset}"'
}
read -r P_REVIEW P_APPROVE P_MERGE P_MOAR P_STRICT <<<"$(preset)"
eq "lite: REVIEW_MODE=agent"                    "$P_REVIEW"  agent
eq "lite: approve FLOOR on"                     "$P_APPROVE" 1
eq "lite: AUTO_MERGE off (human merges)"        "$P_MERGE"   0
eq "lite: MERGE_ON_AGENT_REVIEW off"            "$P_MOAR"    0
eq "lite: OS sandbox REQUIRED (auto-approve ⇒ containment)" "$P_STRICT" 1

echo "== 4: ship-plan the runner feeds for a lite ticket =="
plan() { env -i PATH="$PATH" HOME="$HOME" GAFFER_DATA="$WORK/data" bash -c '
  source "'"$RUNNER_DIR"'/factory.config.sh" >/dev/null 2>&1
  gaffer_afk_ship_plan "$1" "$2" "$3"' _ "$1" "$2" "$3"; }
# lite TRIVIAL: runner sets approve=allow, merge=deny → approve_hold (human merges)
eq "trivial + APPROVE verdict → approve_hold"   "$(plan approve allow deny)" approve_hold
# lite NON-trivial: runner forces approve=deny → hold for a human
eq "non-trivial → hold (human reviews)"         "$(plan approve deny deny)"  hold
# a trivial ticket the reviewer FLAGS still reworks (agent review still gates)
eq "trivial but CHANGES verdict → rework"       "$(plan changes allow deny)" rework

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS — $PASS checks passed (lite mode)"
  exit 0
else
  echo "FAILED — ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
