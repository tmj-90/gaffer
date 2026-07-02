#!/usr/bin/env bash
# =====================================================================
# DELIVERY-HYGIENE validation (lib/hygiene.sh) — stabilisation pass.
# ---------------------------------------------------------------------
# Proves, against REAL git repos + the REAL hygiene functions, that the
# assertion FIRES on every leak class a large unattended run produced:
#   AC1  a copied source tree in a repo root (src.ticket9/) is rejected
#   AC2  a leaked .crew/events.jsonl is rejected
#   AC3  a self-referential symlink (node_modules -> itself) is rejected
#   AC4  a node_modules path added OR deleted is rejected
#   AC5  a broken/dangling symlink is rejected
#   AC6  a clean, minimal delivery PASSES (no false positive)
#   AC7  gaffer_assert_repo_clean fires on unmanaged artifacts in the real
#        checkout after teardown, and passes on a clean checkout
#   AC8  HYGIENE_FORBIDDEN_PATHS / caps are configurable + commented
#
# Zero deps; needs only git. Run: bash test/hygiene.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

# Default config + the functions under test.
export HYGIENE_FORBIDDEN_PATHS="node_modules .crew/ *.events.jsonl"
# shellcheck source=../lib/hygiene.sh
source "$RUNNER_DIR/lib/hygiene.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/hygiene-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# A repo on main with a real src/ tree + one committed file, plus a delivery
# branch the test mutates to plant a leak.
new_repo() {
  local repo="$1"
  git init -q -b main "$repo"
  git -C "$repo" config user.email gaffer@test
  git -C "$repo" config user.name gaffer-test
  mkdir -p "$repo/src"
  printf 'export const x = 1;\n' > "$repo/src/index.ts"
  printf 'base\n' > "$repo/README.md"
  git -C "$repo" add -A
  git -C "$repo" commit -q -m base
  git -C "$repo" checkout -q -b gaffer/ticket-9-x
}

echo "== AC1: copied source tree (src.ticket9/) is rejected =="
REPO="$WORK/copied-src"; new_repo "$REPO"
mkdir -p "$REPO/src.ticket9"
cp "$REPO/src/index.ts" "$REPO/src.ticket9/index.ts"
git -C "$REPO" add -A && git -C "$REPO" commit -q -m "leak copied src"
OUT="$(gaffer_assert_clean_delivery "$REPO" main)"; RC=$?
if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -qi 'copied source tree'; then
  ok "copied src tree (src.ticket9/) → rejected: $(printf '%s' "$OUT" | head -1)"
else
  fail "copied src tree should be rejected (rc=$RC, out=$OUT)"
fi

echo "== AC2: leaked .crew/events.jsonl is rejected =="
REPO="$WORK/leaked-events"; new_repo "$REPO"
mkdir -p "$REPO/.crew"
printf '{"e":1}\n' > "$REPO/.crew/events.jsonl"
git -C "$REPO" add -A -f && git -C "$REPO" commit -q -m "leak events"
OUT="$(gaffer_assert_clean_delivery "$REPO" main)"; RC=$?
if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -qi 'forbidden path'; then
  ok "leaked .crew/events.jsonl → rejected"
else
  fail "leaked events log should be rejected (rc=$RC, out=$OUT)"
fi

echo "== AC3: self-referential symlink (node_modules -> itself) is rejected =="
REPO="$WORK/selflink"; new_repo "$REPO"
# A node_modules symlink pointing at the repo root (its own ancestor) — the exact
# class that broke the test runner in the real run.
ln -s . "$REPO/node_modules"
git -C "$REPO" add -A && git -C "$REPO" commit -q -m "leak selflink"
OUT="$(gaffer_assert_clean_delivery "$REPO" main)"; RC=$?
if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -qiE 'self-referential|forbidden path'; then
  ok "self-referential node_modules symlink → rejected"
else
  fail "self-referential symlink should be rejected (rc=$RC, out=$OUT)"
fi

echo "== AC4: node_modules added OR deleted is rejected =="
# Added (a directory of files under node_modules).
REPO="$WORK/nm-added"; new_repo "$REPO"
mkdir -p "$REPO/node_modules/foo"
printf '{}\n' > "$REPO/node_modules/foo/package.json"
git -C "$REPO" add -A -f && git -C "$REPO" commit -q -m "add node_modules"
OUT="$(gaffer_assert_clean_delivery "$REPO" main)"; RC=$?
[ "$RC" -ne 0 ] && ok "node_modules ADDED → rejected" || fail "added node_modules should be rejected"
# Deleted: commit a node_modules file on main first, then delete it on the branch.
REPO="$WORK/nm-deleted"
git init -q -b main "$REPO"
git -C "$REPO" config user.email gaffer@test; git -C "$REPO" config user.name gaffer-test
mkdir -p "$REPO/src" "$REPO/node_modules/foo"
printf 'x\n' > "$REPO/src/index.ts"; printf '{}\n' > "$REPO/node_modules/foo/package.json"
git -C "$REPO" add -A -f && git -C "$REPO" commit -q -m base
git -C "$REPO" checkout -q -b gaffer/ticket-9-del
git -C "$REPO" rm -q -r node_modules && git -C "$REPO" commit -q -m "salvage delete node_modules"
OUT="$(gaffer_assert_clean_delivery "$REPO" main)"; RC=$?
[ "$RC" -ne 0 ] && ok "node_modules DELETED → rejected" || fail "deleted node_modules should be rejected"

echo "== AC5: broken/dangling symlink is rejected =="
REPO="$WORK/dangling"; new_repo "$REPO"
ln -s ./does-not-exist "$REPO/brokenlink"
git -C "$REPO" add -A && git -C "$REPO" commit -q -m "leak dangling"
OUT="$(gaffer_assert_clean_delivery "$REPO" main)"; RC=$?
if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -qi 'broken/dangling symlink'; then
  ok "broken/dangling symlink → rejected"
else
  fail "dangling symlink should be rejected (rc=$RC, out=$OUT)"
fi

echo "== AC6: a clean minimal delivery PASSES (no false positive) =="
REPO="$WORK/clean"; new_repo "$REPO"
printf 'export const x = 2;\n' > "$REPO/src/index.ts"   # edit an existing file only
git -C "$REPO" commit -q -am "minimal edit"
OUT="$(gaffer_assert_clean_delivery "$REPO" main)"; RC=$?
[ "$RC" -eq 0 ] && ok "clean minimal delivery passes (rc=0)" || fail "clean delivery should pass (out=$OUT)"

echo "== AC7: gaffer_assert_repo_clean catches teardown residue =="
REPO="$WORK/realrepo"
git init -q -b main "$REPO"; git -C "$REPO" config user.email gaffer@test; git -C "$REPO" config user.name gaffer-test
mkdir -p "$REPO/src"; printf 'x\n' > "$REPO/src/index.ts"
git -C "$REPO" add -A && git -C "$REPO" commit -q -m base
OUT="$(gaffer_assert_repo_clean "$REPO")"; RC=$?
[ "$RC" -eq 0 ] && ok "clean real checkout passes gaffer_assert_repo_clean" || fail "clean real repo should pass (out=$OUT)"
# Plant an unmanaged copied src tree + a leaked events log (untracked residue).
mkdir -p "$REPO/src.ticket9" "$REPO/.crew"
printf 'x\n' > "$REPO/src.ticket9/index.ts"
printf '{}\n' > "$REPO/.crew/events.jsonl"
OUT="$(gaffer_assert_repo_clean "$REPO")"; RC=$?
if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -qiE 'copied src tree|leaked events|not clean'; then
  ok "real repo with leaked artifacts → gaffer_assert_repo_clean fires"
else
  fail "dirty real repo should fail gaffer_assert_repo_clean (rc=$RC, out=$OUT)"
fi

echo "== AC8: forbidden-paths config is honoured + commented =="
# An empty override falls back to the built-in defaults (never silently disabled).
( unset HYGIENE_FORBIDDEN_PATHS
  REPO="$WORK/cfg"; new_repo "$REPO"
  mkdir -p "$REPO/node_modules"; printf '{}\n' > "$REPO/node_modules/x.json"
  git -C "$REPO" add -A -f && git -C "$REPO" commit -q -m nm
  gaffer_assert_clean_delivery "$REPO" main >/dev/null 2>&1 ) \
  && fail "unset HYGIENE_FORBIDDEN_PATHS should still reject node_modules (defaults)" \
  || ok "empty HYGIENE_FORBIDDEN_PATHS falls back to built-in defaults"
grep -Eq '^: "\$\{HYGIENE_FORBIDDEN_PATHS' "$RUNNER_DIR/factory.config.sh" \
  && ok "HYGIENE_FORBIDDEN_PATHS default present in factory.config.sh" \
  || fail "HYGIENE_FORBIDDEN_PATHS default missing from factory.config.sh"
grep -Eq '^: "\$\{HYGIENE_ENFORCE:=1\}"' "$RUNNER_DIR/factory.config.sh" \
  && ok "HYGIENE_ENFORCE default present" || fail "HYGIENE_ENFORCE default missing"

echo "== AC9: with factory.config.sh sourced (release config), .claude/ + CLAUDE.factory.md are rejected =="
# Regression for the split-brain bug: the library fallback forbade .claude/ +
# CLAUDE.factory.md but the release config's default did NOT — so a real run
# (which sources factory.config.sh) silently allowed them. Prove the CONFIG
# default (not just the lib fallback) rejects both. Unset first so the config's
# := default actually applies, then run the check against that env.
REPO="$WORK/release-config"; new_repo "$REPO"
mkdir -p "$REPO/.claude"; printf '{}\n' > "$REPO/.claude/settings.json"
printf 'agent brief\n' > "$REPO/CLAUDE.factory.md"
git -C "$REPO" add -A && git -C "$REPO" commit -q -m "leak .claude + CLAUDE.factory.md"
OUT="$( set +u; unset HYGIENE_FORBIDDEN_PATHS
        source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
        gaffer_assert_clean_delivery "$REPO" main 2>&1 )"; RC=$?
if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -qi 'forbidden path'; then
  ok "release config rejects .claude/ + CLAUDE.factory.md"
else
  fail "release config should reject .claude/ + CLAUDE.factory.md (rc=$RC, out=$(printf '%s' "$OUT" | head -1))"
fi

# --- gaffer_exclude_runner_config: append EACH entry independently -------------
# Regression: the helper used to early-exit if `node_modules` was already excluded,
# so a repo that excluded node_modules for its OWN reasons never got .claude/,
# CLAUDE.factory.md, .mcp.json, etc. added. Prove every entry lands even when one is
# pre-present, and that a second call is idempotent (no duplicate lines).
REPO="$WORK/exclude-helper"; new_repo "$REPO"
# rev-parse --git-path returns a path RELATIVE to the repo, so resolve it under $REPO.
EXCL="$REPO/$(git -C "$REPO" rev-parse --git-path info/exclude)"
mkdir -p "$(dirname "$EXCL")"
printf 'node_modules\n' > "$EXCL"   # repo already excludes node_modules for its own reasons
( cd "$REPO" && gaffer_exclude_runner_config "$REPO" )
missing=""
for e in '.claude/' 'CLAUDE.factory.md' '.mcp.json' 'mcp-runtime*.json' 'dist/' 'coverage/'; do
  grep -qxF "$e" "$EXCL" || missing="$missing $e"
done
[ -z "$missing" ] && ok "exclude helper adds every entry even when node_modules pre-present" \
  || fail "exclude helper skipped entries:$missing"
# node_modules must appear exactly once (the pre-existing line was not duplicated).
nm_count="$(grep -cxF 'node_modules' "$EXCL")"
[ "$nm_count" = "1" ] && ok "pre-existing node_modules line not duplicated" \
  || fail "node_modules duplicated ($nm_count times)"
# Idempotent: a second run adds nothing new.
before="$(wc -l < "$EXCL")"
( cd "$REPO" && gaffer_exclude_runner_config "$REPO" )
after="$(wc -l < "$EXCL")"
[ "$before" = "$after" ] && ok "second call is idempotent (no new lines: $after)" \
  || fail "second call changed line count ($before → $after)"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
