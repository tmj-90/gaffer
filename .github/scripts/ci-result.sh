#!/usr/bin/env bash
# The one CI result a branch rule can require (ci.yml `ci-result`): it runs after every
# other job, whatever happened to them, and passes only when each one succeeded, or was
# skipped by the rule that is allowed to skip it: `runner-macos` when `changes` said
# the push touches nothing that behaves differently on macOS (MACOS=false). A failed,
# cancelled or unexpectedly skipped job fails it, and so does a `changes` job that
# failed (its answer is then unknown, so a skipped macOS run is not explained).
#
# Input (environment):
#   NEEDS  ${{ toJSON(needs) }}: {"<job>": {"result": "success|failure|cancelled|skipped", ...}}
#   MACOS  needs.changes.outputs.macos ("true" / "false"; empty when changes did not run)
# Prints one line per job and exits 0 or 1. Locked by runner/test/ci-matrix.test.sh (C6).
set -uo pipefail
command -v node >/dev/null 2>&1 || { echo "::error::ci-result: node is required"; exit 1; }
[ -n "${NEEDS:-}" ] || { echo "::error::ci-result: NEEDS is empty"; exit 1; }
lines="$(node -e '
  let n; try { n = JSON.parse(process.env.NEEDS); } catch { process.exit(3); }
  if (!n || typeof n !== "object" || Array.isArray(n) || !Object.keys(n).length) process.exit(3);
  for (const [job, v] of Object.entries(n)) console.log(job + " " + String((v && v.result) || "unknown"));
')" || { echo "::error::ci-result: NEEDS is not a non-empty JSON object of jobs"; exit 1; }
bad=0
while read -r job result; do
  case "$result" in
    success) echo "ok    $job" ;;
    skipped)
      if [ "$job" = runner-macos ] && [ "${MACOS:-}" = false ]; then
        echo "ok    $job (skipped: no macOS-relevant path changed; nightly.yml runs it)"
      else
        echo "::error::$job was skipped, and no rule allows that"; bad=1
      fi ;;
    *) echo "::error::$job: $result"; bad=1 ;;
  esac
done <<<"$lines"
exit "$bad"
