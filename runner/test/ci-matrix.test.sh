#!/usr/bin/env bash
# =====================================================================
# The CI shape: which runner cells run on every push, which run nightly, and that
# every scenario suite is in a CI group. Static reads of .github/workflows/*.yml
# (no YAML parser on a bare macOS bash, so each check reads the lines it names).
#   C1  ci.yml (every push / PR): ubuntu node 22 and node 24 in 3 shards each, macOS
#       node 22 in 4 shards, and NO macOS node 24 row: that cell queued 755 s behind
#       GitHub's 5-concurrent-macOS limit on run 41338925244 (26.4 min wall); in
#       ci.yml and nightly.yml every cell's rows are shards 1..N once each (a doubled
#       or missing K would run some files twice and others never), and macOS node 22
#       shard 1 runs the package tests and the macOS e2e (packages: true, e2e: true)
#   C2  nightly.yml runs the macOS node 24 cell (3 shards, the package tests on
#       shard 1) on a schedule and on workflow_dispatch, with GAFFER_TEST_EXHAUSTIVE
#   C3  both callers run their shards through runner-shard.yml, which runs run.sh
#       with GAFFER_TEST_STRICT=1 and fixed caps, and a cell's shards share one head start (the
#       shard split must be identical for every shard of a cell); the callers pass a
#       row's packages / e2e through and runner-shard.yml runs `pnpm -r test` and the
#       e2e steps on them
#   C4  every `uses:` is a local workflow or an action pinned by a full commit sha
#   C5  every scenario suite (scripts/ui-regression/suites/*.mjs) is in exactly one
#       ui-scenarios group (s18-read-only and s19-layout were in none)
# Run: bash runner/test/ci-matrix.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
WF="$ROOT/.github/workflows"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

# The runner matrix rows of a workflow: "os node shard shards head_start" per row.
rows() {
  sed -n -E 's/^ *- \{ os: ([a-z-]+), node: "?([0-9]+)"?, shard: ([0-9]+), shards: ([0-9]+), head_start: ([0-9]+).*/\1 \2 \3 \4 \5/p' "$1"
}
count_cell() { # <rows> <os> <node> <shards> -> rows of that cell with that shard count
  local n=0 os node k shards _hs
  while read -r os node k shards _hs; do
    [ "$os" = "$2" ] && [ "$node" = "$3" ] && [ "$shards" = "$4" ] && n=$((n + 1))
  done <<<"$1"
  echo "$n"
}

echo "== C1: the per-push cells =="
CI_ROWS="$(rows "$WF/ci.yml")"
[ "$(count_cell "$CI_ROWS" ubuntu-latest 22 3)" = 3 ] && ok "C1 ubuntu node 22: 3 shards" || fail "C1 ubuntu node 22 is not 3 shards of 3: $(tr '\n' ';' <<<"$CI_ROWS")"
[ "$(count_cell "$CI_ROWS" ubuntu-latest 24 3)" = 3 ] && ok "C1 ubuntu node 24: 3 shards" || fail "C1 ubuntu node 24 is not 3 shards of 3"
[ "$(count_cell "$CI_ROWS" macos-latest 22 4)" = 4 ] && ok "C1 macOS node 22: 4 shards" || fail "C1 macOS node 22 is not 4 shards of 4"
if grep -qE 'os: macos-latest, node: "?24"?' "$WF/ci.yml"; then fail "C1 ci.yml still runs macOS node 24 on every push"
else ok "C1 ci.yml runs no macOS node 24 shard on a push (4 macOS jobs, under the limit of 5)"; fi

# Every cell of a caller: its rows are shards 1..N, each exactly once.
shards_exact() { # <workflow file> -> the cells whose shard numbers are not 1..N once each
  local r cell got want k
  r="$(rows "$1")"
  for cell in $(awk '{print $1 "/" $2 "/" $4}' <<<"$r" | sort -u); do
    got="$(awk -v c="$cell" '$1 "/" $2 "/" $4 == c {print $3}' <<<"$r" | sort -n | tr '\n' ' ')"
    want=""; k=1; while [ "$k" -le "${cell##*/}" ]; do want="$want$k "; k=$((k + 1)); done
    [ "$got" = "$want" ] || printf ' %s(%s)' "$cell" "$got"
  done
  # Two shard counts for one os/node is two partitions of one cell.
  [ "$(awk '{print $1 "/" $2}' <<<"$r" | sort -u | wc -l)" = "$(awk '{print $1 "/" $2 "/" $4}' <<<"$r" | sort -u | wc -l)" ] || printf ' (a cell with two shard counts)'
}
for caller in ci.yml nightly.yml; do
  [ -f "$WF/$caller" ] || continue
  bad="$(shards_exact "$WF/$caller")"
  [ -z "$bad" ] && ok "C1 $caller: every cell's rows are shards 1..N, each once" || fail "C1 $caller: cells whose shards are not 1..N once each:$bad"
done
grep -qE '^ *- \{ os: macos-latest, node: "?22"?, shard: 1, shards: 4, head_start: [0-9]+, packages: true, e2e: true \}' "$WF/ci.yml" \
  && ok "C1 macOS node 22 shard 1 runs the package tests and the macOS e2e (packages, e2e)" \
  || fail "C1 ci.yml macOS node 22 shard 1 lost packages: true / e2e: true (no macOS vitest or e2e on a push)"

echo "== C2: the nightly cell =="
if [ -f "$WF/nightly.yml" ]; then
  NR="$(rows "$WF/nightly.yml")"
  [ "$(count_cell "$NR" macos-latest 24 3)" = 3 ] && ok "C2 nightly.yml runs macOS node 24 in 3 shards" || fail "C2 nightly rows: $(tr '\n' ';' <<<"$NR")"
  grep -qE '^ *- cron: "[0-9*/, -]+"' "$WF/nightly.yml" && grep -qE '^  workflow_dispatch:' "$WF/nightly.yml" \
    && ok "C2 it runs on a schedule and by hand (workflow_dispatch)" || fail "C2 nightly.yml lacks schedule.cron or workflow_dispatch"
  grep -qE 'shard: 1, shards: 3, head_start: [0-9]+, packages: true' "$WF/nightly.yml" && ok "C2 shard 1 runs the macOS node 24 package tests" || fail "C2 the macOS node 24 package tests are not folded into a nightly shard"
  grep -qE '^ *exhaustive: true' "$WF/nightly.yml" && ok "C2 the nightly run is exhaustive (GAFFER_TEST_EXHAUSTIVE)" || fail "C2 nightly.yml does not pass exhaustive: true"
  if grep -qE '^ *exhaustive:' "$WF/ci.yml"; then fail "C2 ci.yml sets exhaustive (it is the nightly run's)"; else ok "C2 a push run keeps the cheap default forms"; fi
else
  fail "C2 no .github/workflows/nightly.yml"
fi

echo "== C3: one set of steps =="
for caller in ci.yml nightly.yml; do
  [ -f "$WF/$caller" ] || continue
  grep -qE '^    uses: \./\.github/workflows/runner-shard\.yml$' "$WF/$caller" && ok "C3 $caller calls runner-shard.yml" || fail "C3 $caller does not call runner-shard.yml"
  bad=""
  for cell in $(rows "$WF/$caller" | awk '{print $1 "/" $2}' | sort -u); do
    n="$(rows "$WF/$caller" | awk -v c="$cell" '$1 "/" $2 == c {print $5}' | sort -u | wc -l | tr -d ' ')"
    [ "$n" = 1 ] || bad="$bad $cell"
  done
  [ -z "$bad" ] && ok "C3 $caller: every cell's shards share one head_start" || fail "C3 $caller: cells with differing head_start:$bad"
done
for caller in ci.yml nightly.yml; do
  [ -f "$WF/$caller" ] || continue
  grep -qE '^      packages: \$\{\{ matrix\.packages == true \}\}$' "$WF/$caller" \
    && ok "C3 $caller passes a row's packages flag to runner-shard.yml" || fail "C3 $caller does not pass packages: \${{ matrix.packages == true }}"
done
grep -qE '^      e2e: \$\{\{ matrix\.e2e == true \}\}$' "$WF/ci.yml" \
  && ok "C3 ci.yml passes a row's e2e flag to runner-shard.yml" || fail "C3 ci.yml does not pass e2e: \${{ matrix.e2e == true }}"
RS="$WF/runner-shard.yml"
if [ -f "$RS" ]; then
  # The step that runs the package tests: `if: inputs.packages` right before `run: pnpm -r test`.
  awk '/^      - name: Test \(packages\)$/ { getline a; getline b; if (a ~ /^        if: inputs\.packages$/ && b ~ /^        run: pnpm -r test$/) f = 1 } END { exit !f }' "$RS" \
    && ok "C3 runner-shard.yml runs pnpm -r test when packages is set" || fail "C3 runner-shard.yml has no 'Test (packages)' step on inputs.packages"
  [ "$(grep -cE '^        if: inputs\.e2e$' "$RS")" = 2 ] && grep -q 'bash runner/test/maintenance-e2e.sh' "$RS" && grep -q 'bash runner/eval/replay.sh' "$RS" \
    && ok "C3 runner-shard.yml runs the maintenance-lane e2e and the gate replay when e2e is set" || fail "C3 runner-shard.yml lost the e2e steps"
  grep -qE '^ *GAFFER_TEST_STRICT: "1"' "$RS" && grep -qE '^ *run: bash runner/test/run.sh$' "$RS" \
    && ok "C3 runner-shard.yml runs run.sh strict" || fail "C3 runner-shard.yml does not run run.sh with GAFFER_TEST_STRICT=1"
  grep -qE 'GAFFER_RUN_SHARD1_HEAD_START: \$\{\{ inputs\.head_start \}\}' "$RS" && ok "C3 the head start reaches shard.mjs" || fail "C3 head_start is not passed as GAFFER_RUN_SHARD1_HEAD_START"
  grep -qE '^ *GAFFER_RUN_CAP_SCALE: "1"' "$RS" && ok "C3 CI keeps the caps fixed (GAFFER_RUN_CAP_SCALE=1)" || fail "C3 runner-shard.yml does not fix GAFFER_RUN_CAP_SCALE=1"
else
  fail "C3 no .github/workflows/runner-shard.yml"
fi

echo "== C4: every action is pinned =="
unpinned=""
for f in "$WF"/*.yml; do
  while IFS= read -r u; do
    case "$u" in ./*) continue ;; esac
    [[ "$u" =~ @[0-9a-f]{40}$ ]] || unpinned="$unpinned $(basename "$f"):$u"
  done < <(sed -n -E 's/^ *(- )?uses: ([^ #]+).*/\2/p' "$f")
done
[ -z "$unpinned" ] && ok "C4 every uses: is local or pinned by commit sha" || fail "C4 not pinned:$unpinned"

echo "== C5: every scenario suite runs in CI =="
GROUPS_TXT="$(sed -n -E 's/^ *suites: (.*)$/\1/p' "$WF/ci.yml")"
missing="" twice=""
for s in "$ROOT"/scripts/ui-regression/suites/*.mjs; do
  name="$(basename "$s" .mjs)"
  n=0
  for w in $GROUPS_TXT; do [ "$w" = "$name" ] && n=$((n + 1)); done
  [ "$n" -eq 0 ] && missing="$missing $name"
  [ "$n" -gt 1 ] && twice="$twice $name"
done
[ -z "$missing" ] && ok "C5 every suite is in a ui-scenarios group" || fail "C5 suites in no CI group:$missing"
[ -z "$twice" ] && ok "C5 no suite is in two groups" || fail "C5 suites in more than one group:$twice"
unknown=""
for w in $GROUPS_TXT; do [ -f "$ROOT/scripts/ui-regression/suites/$w.mjs" ] || unknown="$unknown $w"; done
[ -z "$unknown" ] && ok "C5 every grouped name is a real suite" || fail "C5 unknown suites in ci.yml:$unknown"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "ci-matrix: ALL $PASS checks passed"; exit 0; fi
echo "ci-matrix: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
