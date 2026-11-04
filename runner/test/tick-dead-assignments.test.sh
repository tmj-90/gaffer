#!/usr/bin/env bash
# =====================================================================
# tick.sh and its phase libs carry no dead assignments (shellcheck SC2034,
# "assigned but unused").
# ---------------------------------------------------------------------
# The delivery prompt TEXT is rendered by crew (deliveryPrompt.ts via
# renderPromptCli.js); tick.sh only gathers the raw inputs. tick.sh used to
# build six prompt fragments of its own (the quarantined title, the
# review-feedback block, the WRITE/READ lists, the lore-reflection nudge) that
# nothing read: an edit to them changed nothing for the live agent. This pins
# that no variable in tick.sh is assigned and never read. A global read by a
# sourced lib carries a targeted `# shellcheck disable=SC2034` naming its reader.
#
# The tick phases live in runner/lib/tick-*.sh (sourced by tick.sh). `-x` alone
# follows the sources but reports only tick.sh's own findings, so `-a`
# (--check-sourced) reports theirs too, analysed together with tick.sh (a global
# one phase sets and another reads is used). The report is kept to tick.sh and
# lib/tick-*.sh; check 2 pins that every tick lib is reached (sourced by tick.sh
# under a `# shellcheck source=` directive).
#
# Run: bash runner/test/tick-dead-assignments.test.sh   (SKIPs without shellcheck)
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
command -v shellcheck >/dev/null 2>&1 || { echo "SKIP: shellcheck not installed"; exit 0; }

FAILS=0
# LC_ALL=C.UTF-8: shellcheck 0.9 aborts on non-ASCII comments under a POSIX locale.
OUT="$(cd "$RUNNER_DIR" && LC_ALL=C.UTF-8 shellcheck -a -f gcc -S warning -i SC2034 -x tick.sh 2>&1 \
  | grep -E '^(\./)?(tick\.sh|lib/tick-[a-z-]+\.sh):' || true)"
if [ -z "$OUT" ]; then
  echo "  ok   tick.sh and lib/tick-*.sh assign no variable they never read (SC2034 clean)"
else
  echo "  FAIL tick.sh / lib/tick-*.sh have assigned-but-unused variables:"
  printf '%s\n' "$OUT" | sed 's/^/    /'
  FAILS=$((FAILS + 1))
fi

MISSING=""; N=0
for f in "$RUNNER_DIR"/lib/tick-*.sh; do
  [ -f "$f" ] || continue
  N=$((N + 1))
  grep -qxF "# shellcheck source=lib/${f##*/}" "$RUNNER_DIR/tick.sh" || MISSING="$MISSING lib/${f##*/}"
done
if [ "$N" -gt 0 ] && [ -z "$MISSING" ]; then
  echo "  ok   every lib/tick-*.sh ($N) is sourced by tick.sh under a shellcheck source directive"
else
  echo "  FAIL tick libs the check above does not reach (no '# shellcheck source=' line in tick.sh):${MISSING:- none found}"
  FAILS=$((FAILS + 1))
fi

if [ "$FAILS" -eq 0 ]; then echo "PASS: 2 checks"; exit 0; fi
echo "FAILED: $FAILS of 2"
exit 1
