#!/usr/bin/env bash
# Hermetic test for operator-state-guard.sh: a throwaway git repo carrying this
# checkout's .gitignore, one planted state file per guarded location, and the
# guard's verdict for each. The package entries are the regression: a bare
# 'packages/*/.crew' pathspec never matches an ignored dir, so the guard used to
# print nothing with packages/crew/.crew/events.jsonl on disk.
#
# Run: bash .github/scripts/operator-state-guard.test.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
GUARD="$HERE/operator-state-guard.sh"

PASS=0
FAILS=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILS+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/state-guard-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
REPO="$WORK/repo"
mkdir -p "$REPO/packages/crew" "$REPO/packages/dispatch" "$REPO/runner/.dispatch"
cp "$ROOT/.gitignore" "$REPO/.gitignore"
echo '{}' > "$REPO/packages/crew/package.json"
echo '{}' > "$REPO/packages/dispatch/package.json"
: > "$REPO/runner/.dispatch/audit.jsonl"   # tracked in the real checkout too
git -C "$REPO" init -q
git -C "$REPO" add -A -f
git -C "$REPO" -c user.name=t -c user.email=t@t commit -q -m init

guard() { (cd "$REPO" && bash "$GUARD") >"$WORK/out" 2>&1; }

guard; rc=$?
[ "$rc" -eq 0 ] && ok "clean checkout → rc 0" || fail "clean checkout → rc $rc: $(cat "$WORK/out")"

# One planted file per location; each must turn the guard red AND be named.
for f in packages/crew/.crew/events.jsonl packages/dispatch/.crew/events.jsonl \
         packages/dispatch/.dispatch/audit.jsonl .gaffer/dispatch.sqlite \
         .crew/events.jsonl .dispatch/audit.jsonl runner/.crew/events.jsonl; do
  mkdir -p "$REPO/$(dirname "$f")"; echo x > "$REPO/$f"
  guard; rc=$?
  dir="${f%/*}"
  if [ "$rc" -eq 1 ] && grep -qF "$dir" "$WORK/out"; then ok "$f → rc 1, named"
  else fail "$f went unnoticed (rc $rc): $(tr '\n' ' ' <"$WORK/out")"; fi
  rm -rf "${REPO:?}/$dir"
done

# A test appending to the tracked runner audit log shows as modified.
echo x >> "$REPO/runner/.dispatch/audit.jsonl"
guard; rc=$?
[ "$rc" -eq 1 ] && grep -qF runner/.dispatch/audit.jsonl "$WORK/out" \
  && ok "modified tracked runner/.dispatch/audit.jsonl → rc 1" || fail "tracked audit-log append unnoticed (rc $rc)"
git -C "$REPO" checkout -q -- runner/.dispatch/audit.jsonl

guard; rc=$?
[ "$rc" -eq 0 ] && ok "clean again after cleanup → rc 0" || fail "cleanup → rc $rc"

echo
if [ "${#FAILS[@]}" -eq 0 ]; then echo "ALL $PASS checks passed"; exit 0; fi
echo "${#FAILS[@]} FAILED of $((PASS + ${#FAILS[@]}))"; exit 1
