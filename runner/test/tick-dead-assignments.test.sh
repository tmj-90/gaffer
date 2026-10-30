#!/usr/bin/env bash
# =====================================================================
# tick.sh carries no dead assignments (shellcheck SC2034, "assigned but unused").
# ---------------------------------------------------------------------
# The delivery prompt TEXT is rendered by crew (deliveryPrompt.ts via
# renderPromptCli.js); tick.sh only gathers the raw inputs. tick.sh used to
# build six prompt fragments of its own (the quarantined title, the
# review-feedback block, the WRITE/READ lists, the lore-reflection nudge) that
# nothing read: an edit to them changed nothing for the live agent. This pins
# that no variable in tick.sh is assigned and never read. A global read by a
# sourced lib carries a targeted `# shellcheck disable=SC2034` naming its reader.
#
# Run: bash runner/test/tick-dead-assignments.test.sh   (SKIPs without shellcheck)
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
command -v shellcheck >/dev/null 2>&1 || { echo "SKIP: shellcheck not installed"; exit 0; }

# LC_ALL=C.UTF-8: shellcheck 0.9 aborts on non-ASCII comments under a POSIX locale.
OUT="$(cd "$RUNNER_DIR" && LC_ALL=C.UTF-8 shellcheck -S warning -i SC2034 -x tick.sh 2>&1)"
if [ -z "$OUT" ]; then
  echo "  ok   tick.sh assigns no variable it never reads (SC2034 clean)"
  echo "PASS: 1 check"
  exit 0
fi
echo "  FAIL tick.sh has assigned-but-unused variables:"
printf '%s\n' "$OUT" | grep -E '^In |SC2034' | sed 's/^/    /'
echo "FAILED: 1 of 1"
exit 1
