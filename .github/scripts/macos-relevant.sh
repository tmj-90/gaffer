#!/usr/bin/env bash
# Does this push or pull request need the macOS runner shards?
#
# The macOS runner shards (ci.yml `runner-macos`) are the costliest jobs of a CI run
# (macOS minutes bill at ten times Linux on a private repository), and almost every
# behaviour that differs on macOS lives in the runner's bash: bash 3.2, the BSD tools,
# sandbox-exec, the Keychain. So they run on a push or pull request only when it
# changes a path that can behave differently there:
#   runner/**                     the runner (lib, config, bin, sandbox) and its tests
#   scripts/**                    helpers the runner tests call (test.sh, build.mjs,
#                                 check-engines, config-reference, ui-regression stubs)
#   .github/**                    the workflows and the scripts the shards run
#   package.json, packages/*/package.json, pnpm-lock.yaml, pnpm-workspace.yaml,
#   .npmrc, .nvmrc                the manifests, the lockfile, the Node pin
# Anything else (package sources, docs, the dashboard UI) skips them on that push;
# nightly.yml runs them every night either way.
#
# Usage:
#   macos-relevant.sh --paths            changed paths on stdin, one per line: prints
#                                        "true" or "false"
#   macos-relevant.sh --event <name> --base <sha> [--head <sha>]
#                                        in a checkout: diffs base..head (head defaults
#                                        to HEAD), fetching the base if it is missing,
#                                        and prints "true" or "false"
# Anything it cannot decide (no base: a new branch, a force push whose old head is
# gone, a failed fetch or diff, an unknown event) prints "true": when in doubt the
# macOS shards run. Locked by runner/test/ci-matrix.test.sh (C6).
set -uo pipefail

relevant_path() {
  case "$1" in
    runner/* | scripts/* | .github/*) return 0 ;;
    package.json | pnpm-lock.yaml | pnpm-workspace.yaml | .npmrc | .nvmrc) return 0 ;;
    # One level only: packages/<name>/package.json, never a fixture deeper down.
    packages/*/package.json) case "${1#packages/}" in */*/*) ;; *) return 0 ;; esac ;;
  esac
  return 1
}

from_paths() {
  local p
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    if relevant_path "$p"; then echo true; return 0; fi
  done
  echo false
}

case "${1:-}" in
  --paths) from_paths; exit 0 ;;
  --event) ;;
  *) echo "usage: macos-relevant.sh --paths | --event <name> --base <sha> [--head <sha>]" >&2; exit 2 ;;
esac

EVENT="" BASE="" HEAD_REF="HEAD"
while [ $# -gt 0 ]; do
  case "$1" in
    --event) EVENT="${2:-}"; shift 2 ;;
    --base) BASE="${2:-}"; shift 2 ;;
    --head) HEAD_REF="${2:-}"; shift 2 ;;
    *) echo "macos-relevant.sh: unknown option '$1'" >&2; exit 2 ;;
  esac
done

why() { echo "macos-relevant: $*" >&2; }
case "$EVENT" in
  push | pull_request) ;;
  *) why "event '$EVENT' is not a push or pull request: run them"; echo true; exit 0 ;;
esac
# A new branch pushes with an all-zero "before"; no base at all means the same.
if ! [[ "$BASE" =~ ^[0-9a-f]{40}$ ]] || [[ "$BASE" =~ ^0+$ ]]; then
  why "no base commit ('$BASE'): run them"; echo true; exit 0
fi
if ! git cat-file -e "$BASE^{commit}" 2>/dev/null; then
  git fetch --no-tags --depth=1 origin "$BASE" >/dev/null 2>&1 || true
fi
if ! git cat-file -e "$BASE^{commit}" 2>/dev/null; then
  why "base $BASE is not reachable (force push or failed fetch): run them"; echo true; exit 0
fi
if ! changed="$(git diff --name-only "$BASE" "$HEAD_REF" 2>/dev/null)"; then
  why "git diff $BASE $HEAD_REF failed: run them"; echo true; exit 0
fi
why "$(printf '%s\n' "$changed" | grep -c .) changed path(s) since ${BASE:0:12}"
printf '%s\n' "$changed" | from_paths
