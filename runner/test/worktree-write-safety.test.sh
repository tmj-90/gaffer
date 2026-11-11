#!/usr/bin/env bash
# =====================================================================
# Host-side writes into an agent's worktree never follow a link (shell side).
# ---------------------------------------------------------------------
# The runner writes .claude/settings.json, CLAUDE.factory.md, the .claude/skills copies
# and node_modules links into a worktree on the HOST, before the worker is sandboxed. A
# repository can commit a symlink at any of those paths (or make `.claude`, or a parent
# of a node_modules link, a symlink). External review 17 reproduced an outside file being
# overwritten through a committed `.claude/settings.json` link. This pins, for each shell
# writer (lib/agent-env.sh, lib/skills-mount.sh) and each shape (a link at the
# destination, a link as a parent, a dangling link, a link to a directory, a destination
# that is a directory):
#   * the outside file is byte-identical and nothing is created outside the worktree;
#   * the writer returns non-zero (fail closed) and _GAFFER_UNSAFE_PATH_ERROR names the
#     path and says what to do; the cleanup `rm` never deletes through a link either;
#   * the node_modules linker creates nothing outside and says why.
# Run: bash runner/test/worktree-write-safety.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok   $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/wt-write-safety.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
trap 'gaffer_test_rm_work "$WORK"' EXIT

_gaffer_sed_repl() { printf '%s' "$1" | sed -e 's/[\\&#]/\\&/g'; }
LOGGED=""; log() { LOGGED="$LOGGED$*"$'\n'; }
# shellcheck source=../lib/agent-env.sh
source "$RUNNER_DIR/lib/agent-env.sh"
# shellcheck source=../lib/skills-mount.sh
source "$RUNNER_DIR/lib/skills-mount.sh"
# shellcheck disable=SC2034  # read by the sourced writers
CLAUDE_SETTINGS="$RUNNER_DIR/claude/settings.json"
# shellcheck disable=SC2034  # read by gaffer_skills_mount
SKILLS_DIR="$RUNNER_DIR/skills"
GAFFER_DATA="$WORK/data"; mkdir -p "$GAFFER_DATA"
OUT="$WORK/outside"; mkdir -p "$OUT"
sentinel() { printf 'OPERATOR FILE %s\n' "$1" > "$OUT/$1"; cp "$OUT/$1" "$OUT/$1.orig"; }
same() { cmp -s "$OUT/$1" "$OUT/$1.orig"; }
reset() { LOGGED=""; _GAFFER_UNSAFE_PATH_ERROR=""; }
names_path() { case "${_GAFFER_UNSAFE_PATH_ERROR:-}" in *unsafe_worktree_path:*"$1"*"Replace the link"*) return 0 ;; esac; return 1; }

echo "== 1: gaffer_write_agent_settings: a committed settings.json link to an outside file =="
reset; sentinel settings1
W1="$WORK/w1"; mkdir -p "$W1/.claude"; ln -s "$OUT/settings1" "$W1/.claude/settings.json"
if gaffer_write_agent_settings "$W1" 2>/dev/null; then fail "1: returned 0 through a link"; else ok "1: returns 1 (fail closed)"; fi
same settings1 && ok "1: the outside file is byte-identical" || fail "1: the outside file was overwritten: $(head -c 60 "$OUT/settings1")"
[ -L "$W1/.claude/settings.json" ] && ok "1: the repo's link is left as it is" || fail "1: the link was removed or replaced"
names_path ".claude/settings.json" && ok "1: the reason names the path and says what to do" || fail "1: reason: '${_GAFFER_UNSAFE_PATH_ERROR:-}'"
case "$LOGGED" in *unsafe_worktree_path*) ok "1: the refusal is in the factory log" ;; *) fail "1: log: $LOGGED" ;; esac

echo "== 2: a committed .claude that is a link to an outside directory =="
reset; mkdir -p "$OUT/claude2"; printf 'OUTSIDE SETTINGS\n' > "$OUT/claude2/settings.json"; cp "$OUT/claude2/settings.json" "$WORK/claude2.orig"
W2="$WORK/w2"; mkdir -p "$W2"; ln -s "$OUT/claude2" "$W2/.claude"
if gaffer_write_agent_settings "$W2" 2>/dev/null; then fail "2: returned 0 through a linked .claude"; else ok "2: returns 1"; fi
cmp -s "$OUT/claude2/settings.json" "$WORK/claude2.orig" && ok "2: the outside settings.json is byte-identical (not rewritten, not removed)" || fail "2: outside settings.json changed or removed"
[ "$(ls -A "$OUT/claude2")" = "settings.json" ] && ok "2: nothing else created in the outside directory" || fail "2: outside dir now holds: $(ls -A "$OUT/claude2" | paste -sd, -)"
names_path ".claude" && ok "2: the reason names .claude" || fail "2: reason: '${_GAFFER_UNSAFE_PATH_ERROR:-}'"

echo "== 3: a DANGLING settings.json link (the write would create the target) =="
reset; W3="$WORK/w3"; mkdir -p "$W3/.claude"; ln -s "$OUT/created-by-runner" "$W3/.claude/settings.json"
if gaffer_write_agent_settings "$W3" 2>/dev/null; then fail "3: returned 0 through a dangling link"; else ok "3: returns 1"; fi
[ ! -e "$OUT/created-by-runner" ] && ok "3: no file created at the link's target" || fail "3: the runner created $OUT/created-by-runner"

echo "== 4: the destination is a DIRECTORY / .claude is a regular file =="
reset; W4="$WORK/w4"; mkdir -p "$W4/.claude/settings.json"
if gaffer_write_agent_settings "$W4" 2>/dev/null; then fail "4: returned 0 with a directory at the destination"; else ok "4: a directory at settings.json → returns 1"; fi
[ -d "$W4/.claude/settings.json" ] && ok "4: the directory is left as it is" || fail "4: the directory was replaced"
reset; W4B="$WORK/w4b"; mkdir -p "$W4B"; printf 'not a dir\n' > "$W4B/.claude"
if gaffer_write_agent_settings "$W4B" 2>/dev/null; then fail "4: returned 0 with .claude a regular file"; else ok "4: .claude a regular file → returns 1"; fi
[ -n "${_GAFFER_UNSAFE_PATH_ERROR:-}" ] && ok "4: the refusal is an unsafe-path refusal" || fail "4: no _GAFFER_UNSAFE_PATH_ERROR"

echo "== 5: the cleanup rm on a refused template never deletes through a linked .claude =="
reset; mkdir -p "$OUT/claude5"; printf 'KEEP ME\n' > "$OUT/claude5/settings.json"
W5="$WORK/w5"; mkdir -p "$W5"; ln -s "$OUT/claude5" "$W5/.claude"
printf '{"hooks":{}}\n' > "$WORK/unwired.json"
CLAUDE_SETTINGS="$WORK/unwired.json" gaffer_write_agent_settings "$W5" 2>/dev/null
[ -f "$OUT/claude5/settings.json" ] && grep -qx 'KEEP ME' "$OUT/claude5/settings.json" \
  && ok "5: the outside settings.json survives the refusal's cleanup" || fail "5: the cleanup deleted or changed $OUT/claude5/settings.json"

echo "== 6: control: a plain worktree still gets verified settings =="
reset; W6="$WORK/w6"; mkdir -p "$W6"
gaffer_write_agent_settings "$W6" && [ -f "$W6/.claude/settings.json" ] && [ ! -L "$W6/.claude/settings.json" ] \
  && grep -qF "$RUNNER_DIR/safety-hook.mjs" "$W6/.claude/settings.json" && ok "6: written, a regular file, hook path resolved" || fail "6: control write failed: $LOGGED"
[ -z "$(find "$W6/.claude" -name '.*gaffer-tmp*')" ] && ok "6: no temp file left behind" || fail "6: temp file left"
gaffer_write_agent_settings "$W6" && ok "6: a second write over the runner's own regular file succeeds" || fail "6: rewrite refused"

echo "== 7: gaffer_install_agent_dir: a committed CLAUDE.factory.md link =="
gaffer_trust_workspace() { return 0; }
HERE_SAVE="${HERE}"; HERE="$RUNNER_DIR"
reset; sentinel brief7; W7="$WORK/w7"; mkdir -p "$W7"; ln -s "$OUT/brief7" "$W7/CLAUDE.factory.md"
if gaffer_install_agent_dir "$W7" "run-tests" "delivery-7" 2>/dev/null; then fail "7: installer returned 0 through a brief link"; else ok "7: installer returns 1"; fi
same brief7 && ok "7: the outside file is byte-identical" || fail "7: the brief was copied over the outside file"
[ -L "$W7/CLAUDE.factory.md" ] && ok "7: the link is not removed by the cleanup" || fail "7: the link was removed"
names_path "CLAUDE.factory.md" && ok "7: the reason names CLAUDE.factory.md" || fail "7: reason: '${_GAFFER_UNSAFE_PATH_ERROR:-}'"
reset; W7B="$WORK/w7b"; mkdir -p "$W7B"; ln -s "$OUT/brief-dangling" "$W7B/CLAUDE.factory.md"
gaffer_install_agent_dir "$W7B" "run-tests" "delivery-7b" 2>/dev/null
[ ! -e "$OUT/brief-dangling" ] && ok "7: a dangling brief link creates nothing outside" || fail "7: created $OUT/brief-dangling"

echo "== 8: gaffer_install_agent_dir: a committed .claude/skills link refuses the launch =="
reset; mkdir -p "$WORK/w8/shared-skills/own"; printf 'OWN\n' > "$WORK/w8/shared-skills/own/SKILL.md"
W8="$WORK/w8"; mkdir -p "$W8/.claude"; ln -s ../shared-skills "$W8/.claude/skills"
if gaffer_install_agent_dir "$W8" "run-tests" "delivery-8" 2>/dev/null; then fail "8: installer returned 0 with a skills link"; else ok "8: installer returns 1 (fail closed)"; fi
[ "$(ls -A "$W8/shared-skills")" = "own" ] && ok "8: nothing copied through the link" || fail "8: link target now: $(ls -A "$W8/shared-skills" | paste -sd, -)"
names_path ".claude/skills" && ok "8: the reason names .claude/skills" || fail "8: reason: '${_GAFFER_UNSAFE_PATH_ERROR:-}'"
[ ! -e "$W8/.claude/settings.json" ] && ok "8: no settings written after the refusal" || fail "8: settings written"

echo "== 9: gaffer_skills_mount with .claude a link to an outside directory =="
reset; mkdir -p "$OUT/claude9"
W9="$WORK/w9"; mkdir -p "$W9"; ln -s "$OUT/claude9" "$W9/.claude"
if gaffer_skills_mount "$W9" "run-tests" "delivery-9" 2>/dev/null; then fail "9: mount returned 0 through a linked .claude"; else ok "9: mount returns 1"; fi
[ -z "$(ls -A "$OUT/claude9")" ] && ok "9: nothing created in the outside directory" || fail "9: outside dir now holds: $(ls -A "$OUT/claude9" | paste -sd, -)"
HERE="$HERE_SAVE"

echo "== 10: gaffer_skills_unmount never deletes through a linked .claude =="
mkdir -p "$OUT/claude10/skills"; : > "$OUT/claude10/skills/.gaffer-skills-root"; printf 'KEEP\n' > "$OUT/claude10/settings.json"
W10="$WORK/w10"; mkdir -p "$W10"; ln -s "$OUT/claude10" "$W10/.claude"
gaffer_skills_unmount "$W10"
[ -f "$OUT/claude10/settings.json" ] && ok "10: the outside settings.json survives the unmount" || fail "10: unmount deleted $OUT/claude10/settings.json"
[ -f "$OUT/claude10/skills/.gaffer-skills-root" ] && ok "10: the outside marker survives the unmount" || fail "10: unmount removed files through the link"

echo "== 11: gaffer_link_node_modules never links through a symlinked parent =="
reset; REPO="$WORK/repo11"; mkdir -p "$REPO/packages/a/node_modules/x" "$REPO/node_modules/y"
mkdir -p "$OUT/pk11"; W11="$WORK/w11"; mkdir -p "$W11"; ln -s "$OUT/pk11" "$W11/packages"
gaffer_link_node_modules "$REPO" "$W11"; rc=$?
[ "$rc" -eq 0 ] && ok "11: the linker stays fail-soft (rc 0)" || fail "11: rc=$rc"
[ -z "$(ls -A "$OUT/pk11")" ] && ok "11: nothing created through the linked parent" || fail "11: outside now holds: $(find "$OUT/pk11" | paste -sd, -)"
[ -L "$W11/node_modules" ] && ok "11: the root node_modules link is still made" || fail "11: root link missing"
case "$LOGGED" in *unsafe_worktree_path*packages*) ok "11: the skipped link is logged with the path" ;; *) fail "11: log: $LOGGED" ;; esac
reset; W11B="$WORK/w11b"; mkdir -p "$W11B/packages"; ln -s "$OUT/nm-dangling" "$W11B/packages/a"
gaffer_link_node_modules "$REPO" "$W11B"
[ ! -e "$OUT/nm-dangling" ] && ok "11: a dangling parent link creates nothing outside" || fail "11: created $OUT/nm-dangling"

echo "== 12: a path the TRUST step refuses (unsafe_worktree_path) is the same refusal as the installer's =="
# The real gaffer_git_main_worktree + gaffer_trust_workspace (lib/tick-launch.sh), the real
# trust-workspace.mjs, a scratch HOME. A committed .claude/settings.local.json that is a
# directory cannot be neutralised: trust refuses with unsafe_worktree_path. The launch sites
# park on _GAFFER_UNSAFE_PATH_ERROR (blocked, no retry); without it the delivery fell back
# to a TRUST setup error, released to ready and refused again on every run.
FN12="$WORK/trust-fns.sh"
awk '/^gaffer_git_main_worktree\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "$RUNNER_DIR/lib/tick-launch.sh" > "$FN12"
awk '/^gaffer_trust_workspace\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "$RUNNER_DIR/lib/tick-launch.sh" >> "$FN12"
# shellcheck disable=SC1090
source "$FN12"
GAFFER_LOG="$WORK/gaffer12.log"; : > "$GAFFER_LOG"
HERE_SAVE="${HERE}"; HERE="$RUNNER_DIR"
reset; W12="$WORK/w12"; mkdir -p "$W12/.claude/settings.local.json"; git init -q "$W12"
( export HOME="$WORK/home12"; mkdir -p "$HOME"
  gaffer_install_agent_dir "$W12" "run-tests" "delivery-12" >/dev/null 2>&1; rc=$?
  printf '%s\n%s\n' "$rc" "${_GAFFER_UNSAFE_PATH_ERROR:-}" > "$WORK/r12" )
HERE="$HERE_SAVE"
[ "$(sed -n 1p "$WORK/r12")" != 0 ] && ok "12: the install refuses (fail closed)" || fail "12: the install returned 0"
case "$(sed -n 2p "$WORK/r12")" in *unsafe_worktree_path:*settings.local.json*) ok "12: _GAFFER_UNSAFE_PATH_ERROR names .claude/settings.local.json (the launch sites park)" ;; *) fail "12: no unsafe-path reason: '$(sed -n 2p "$WORK/r12")'" ;; esac

echo; [ "$FAIL" -eq 0 ] && echo "worktree-write-safety: ALL $PASS checks passed" || { echo "worktree-write-safety: $FAIL FAILED ($PASS passed)"; exit 1; }
