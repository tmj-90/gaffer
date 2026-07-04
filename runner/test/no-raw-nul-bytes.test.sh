#!/usr/bin/env bash
# =====================================================================
# GUARD: no RAW NUL byte in source.
# ---------------------------------------------------------------------
# NUL is a legitimate Map-key delimiter / sentinel, but it MUST be written as the
# `\u0000` (JS/TS) or `\x00` escape — NEVER a raw 0x00 byte in the source. A raw NUL
# makes the file BINARY to git: no line diffs, invisible in review, and it trips
# tooling (grep/prettier/editors). The factory has emitted raw-NUL delimiters more than
# once (autonomyRecommendationService, claimRepository, prefetch, safety-hook); this
# test stops the recurrence. Run: bash test/no-raw-nul-bytes.test.sh   (bash 3.2 safe)
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
command -v perl >/dev/null 2>&1 || { echo "SKIP: perl required"; exit 0; }

# Production source trees (dist/, node_modules/, .git are never scanned).
FILES="$(
  find "$ROOT/packages" -path '*/src/*' \( -name '*.ts' -o -name '*.js' -o -name '*.mjs' \) 2>/dev/null
  find "$ROOT/runner" \( -name '*.mjs' -o -name '*.sh' \) 2>/dev/null
)"

# Per file, print its name if it contains a raw NUL byte (perl -0777 slurps each file;
# $ARGV is the current file). Portable across macOS BSD + Linux GNU.
BAD="$(printf '%s\n' "$FILES" | grep -v '^$' | tr '\n' '\0' \
  | xargs -0 perl -0777 -ne 'print "$ARGV\n" if /\x00/' 2>/dev/null | sort -u)"

if [ -z "$BAD" ]; then
  echo "  ok   no raw NUL bytes in packages/*/src or runner source"
  echo "no-raw-nul-bytes: PASS"
  exit 0
fi
echo "  FAIL raw NUL byte(s) — write the delimiter/sentinel as \\u0000 (JS/TS) or \\x00, not a raw byte:"
printf '%s\n' "$BAD" | sed 's/^/    /'
echo "no-raw-nul-bytes: FAIL"
exit 1
