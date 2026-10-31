#!/usr/bin/env bash
# =====================================================================
# Run DIRECTLY (as CONTRIBUTING documents: `bash runner/test/X.test.sh`), with no
# run.sh to hand it a private GAFFER_DATA, a test must still neither APPLY the
# checkout's .gaffer/settings.json nor write the checkout's operator state. On a
# contributor's machine that checkout is their LIVE factory: its settings change
# the test's result, and its dispatch / memory DBs get created or opened read-write.
#
# Each listed test runs from a scratch copy of runner/ (packages/ and node_modules
# symlinked back), so the "checkout" it would fall back to is a planted one:
#   * .gaffer/settings.json sets a BASH_ENV tripwire — applied (factory.config.sh
#     exports every key it finds unset), the next bash child marks it;
#   * .gaffer/dispatch.sqlite and memory.sqlite are planted EMPTY, so a CLI that
#     opens them migrates (writes) them, and any file created or modified under the
#     planted .gaffer / .dispatch / .crew dirs during the run is a leak.
# NODE_OPTIONS is left alone: proxied setups need it (--use-openssl-ca) to reach a
# registry, and a test is free to set it.
# The test's own pass/fail is its own suite's business; only isolation is judged.
# Run: bash runner/test/direct-run-isolation.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
# shellcheck source=lib/skip.sh
. "$HERE/lib/skip.sh"
command -v node >/dev/null 2>&1 || gaffer_skip "node required"
command -v perl >/dev/null 2>&1 || gaffer_skip "perl required (bounds each run)"

PASS=0; FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/direct-run-isolation.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
trap 'gaffer_test_rm_work "$WORK"' EXIT
CO="$WORK/checkout"
mkdir -p "$CO"
cp -R "$RUNNER_DIR" "$CO/runner"
rm -rf "$CO/runner/.crew" "$CO/runner/.dispatch"
for x in packages node_modules package.json pnpm-workspace.yaml; do
  [ -e "$ROOT/$x" ] && ln -s "$ROOT/$x" "$CO/$x"
done
TRIPPED="$WORK/tripped"
printf ': >> "%s"\n' "$TRIPPED" > "$WORK/trip.sh"

STATE_DIRS=(.gaffer .dispatch .crew runner/.crew runner/.dispatch)
check() { # <test file under runner/test>
  local t="$1" rc leaked=() d f
  rm -rf "$CO/.gaffer" "$CO/.dispatch" "$CO/.crew" "$CO/runner/.crew" "$CO/runner/.dispatch" "$TRIPPED"
  mkdir -p "$CO/.gaffer"
  node -e 'process.stdout.write(JSON.stringify({BASH_ENV:process.argv[1]}))' "$WORK/trip.sh" > "$CO/.gaffer/settings.json"
  : > "$CO/.gaffer/dispatch.sqlite"; : > "$CO/.gaffer/memory.sqlite"
  touch -t 200001010000 "$CO/.gaffer/settings.json" "$CO/.gaffer/dispatch.sqlite" "$CO/.gaffer/memory.sqlite"
  : > "$WORK/stamp"
  local cmd=(bash); case "$t" in *.mjs) cmd=(node) ;; esac
  (cd "$CO" && env -u GAFFER_DATA -u DISPATCH_DB -u DISPATCH_AUDIT -u MEMORY_DB -u GAFFER_CREW_EVENTS \
      -u CLAUDE_FLAGS -u MCP_CONFIG -u BASH_ENV -u GAFFER_TEST_NAME \
      perl -e 'alarm shift; exec @ARGV' 300 "${cmd[@]}" "runner/test/$t" >"$WORK/out" 2>&1 </dev/null); rc=$?
  for d in "${STATE_DIRS[@]}"; do
    [ -d "$CO/$d" ] || continue
    while IFS= read -r f; do leaked+=("${f#"$CO"/}"); done < <(find "$CO/$d" -newer "$WORK/stamp" ! -type d 2>/dev/null)
  done
  # 142 = SIGALRM from the bound: a hung run proves nothing either way.
  if [ "$rc" -eq 142 ]; then fail "$t timed out (300s) — last lines: $(tail -3 "$WORK/out" | tr '\n' ' ')"; return; fi
  if [ -e "$TRIPPED" ]; then fail "$t applied the checkout's .gaffer/settings.json (rc $rc)"
  else ok "$t did not apply the checkout's settings.json"; fi
  if [ "${#leaked[@]}" -gt 0 ]; then fail "$t wrote the checkout's operator state (rc $rc): ${leaked[*]}"
  else ok "$t wrote no checkout operator state"; fi
}

# Sanity: the planted tripwires fire when a test does fall back to the checkout
# (else every check below is vacuous).
mkdir -p "$CO/runner/test"
cat > "$CO/runner/test/zz-leaky-probe.test.sh" <<'SH'
#!/usr/bin/env bash
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/../factory.config.sh" >/dev/null 2>&1
bash -c ':'; mkdir -p "$GAFFER_DATA"; : > "$DISPATCH_DB"
SH
saved_pass=$PASS
check zz-leaky-probe.test.sh >/dev/null
tripped=${#FAILURES[@]}; PASS=$saved_pass; FAILURES=()
[ "$tripped" -eq 2 ] && ok "sanity: a test that falls back to the checkout trips both checks" \
  || fail "sanity: the planted checkout did not catch a leaky probe ($tripped of 2 tripped)"
rm -f "$CO/runner/test/zz-leaky-probe.test.sh"

# The tests the operator-state audits caught falling back to the checkout.
for t in registry-probe.test.sh status.test.sh status-human-queue.test.sh skills-install.test.sh \
         product-owner-run.test.mjs product-owner-repo-clean.test.sh merge-ticket.test.mjs \
         agent-self-submit.test.sh decompose.test.mjs e2e-memory-routing.test.sh model-tiering.test.sh \
         agent-env-scrub.test.sh agent-env-shell.test.sh db-vars-guard.test.sh hygiene.test.sh \
         self-op-ban.test.sh; do
  check "$t"
done

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "direct-run-isolation: ALL $PASS checks passed"; exit 0; fi
echo "direct-run-isolation: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
