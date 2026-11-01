#!/usr/bin/env bash
# =====================================================================
# External review #9, finding 1: the docker provider must not let the container write
# the host repository's git metadata.
# ---------------------------------------------------------------------
# The wrapper used to mount the host's `.git/refs`, `.git/logs` and `.git/objects`
# read-write so a commit inside could land on the ticket branch. Anything running
# inside (a test, a build script) could then `git update-ref refs/heads/main …` and move
# the operator's branch before review. The container now gets a PRIVATE git dir mounted
# at the worktree's gitdir path (refs a snapshot, objects through a read-only alternate),
# and the trusted wrapper imports only the worktree's own branch after the container
# exits.
#
# Two halves, no docker daemon needed:
#   (1) RENDERED MOUNTS (GAFFER_SANDBOX_DRY_RUN=1) in every data-plane mode: no `-v`
#       mount is writable at, or sourced from, any host path under the repo's `.git`;
#       the only writable git mount is the private dir, which lives outside `.git`.
#   (2) A STUB `docker` that runs the payload on the host with git pointed at the mount
#       the wrapper gave for the gitdir path (the closest a test can get to a bind
#       mount): a commit inside reaches the host ticket branch; `update-ref main`, a
#       forced `branch -f main` and a new tag inside do NOT reach the host; the
#       validation profile imports nothing. The real thing runs in the containment CI
#       job (sandbox-docker-containment.test.sh).
# Run: bash test/sandbox-docker-git-isolation.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
export RUNNER_DIR
command -v git  >/dev/null 2>&1 || { echo "SKIP: git required";  exit 0; }
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }

PASS=0; FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(gaffer_test_tmpdir sbx-git-iso)" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT
WORK="$(cd "$WORK" && pwd -P)"
export GAFFER_DATA="$WORK/data"; mkdir -p "$GAFFER_DATA/worktrees"
REPO="$WORK/repo"; mkdir -p "$REPO"
git -C "$REPO" init -q -b main
git -C "$REPO" config user.email t@e; git -C "$REPO" config user.name t
echo seed > "$REPO/seed.txt"; git -C "$REPO" add -A; git -C "$REPO" commit -qm seed
WT="$GAFFER_DATA/worktrees/ticket-1"
git -C "$REPO" worktree add -q -b gaffer/ticket-1 "$WT" main
COMMON="$(cd "$REPO/.git" && pwd -P)"
GITDIR="$(cd "$COMMON/worktrees/ticket-1" && pwd -P)"
MAIN0="$(git -C "$REPO" rev-parse main)"
WRF="$WORK/wroots"; printf '%s\n' "$WT" > "$WRF"
RRF="$WORK/rroots"; : > "$RRF"
unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN GAFFER_MCP_BRIDGE_SOCKET

# _writable_git_mounts <argv>: every rw `-v` whose host source or container target is
# under the repo's .git, other than the private dir's own target (whose source must be
# outside .git). Prints offenders; empty == contained.
_writable_git_mounts() {
  local prev="" a src dst mode
  while IFS= read -r a; do
    if [ "$prev" = "-v" ]; then
      mode="${a##*:}"; src="${a%%:*}"; dst="${a#*:}"; dst="${dst%:*}"
      if [ "$mode" = "rw" ]; then
        case "$src" in "$COMMON"|"$COMMON"/*) printf '%s\n' "$a" ;; esac
        case "$dst" in
          "$GITDIR") ;;
          "$COMMON"|"$COMMON"/*) printf '%s\n' "$a" ;;
        esac
      fi
    fi
    prev="$a"
  done <<<"$1"
}

echo "== (1) rendered mounts: no host path under .git is writable from the container =="
for mode in none legacy validation; do
  case "$mode" in
    none)       ARGV="$(GAFFER_SANDBOX_DRY_RUN=1 bash "$RUNNER_DIR/lib/sandbox-docker.sh" "$WRF" "$RRF" -- sh -c true 2>/dev/null)" ;;
    legacy)     ARGV="$(GAFFER_SANDBOX_DRY_RUN=1 GAFFER_MCP_BRIDGE=0 bash "$RUNNER_DIR/lib/sandbox-docker.sh" "$WRF" "$RRF" -- claude -p hi --mcp-config "$GAFFER_DATA/x.json" 2>/dev/null)" ;;
    validation) ARGV="$(GAFFER_SANDBOX_DRY_RUN=1 GAFFER_SANDBOX_PROFILE=validation bash "$RUNNER_DIR/lib/sandbox-docker.sh" "$WRF" "$RRF" -- sh -c 'pnpm test' 2>/dev/null)" ;;
  esac
  [ -n "$ARGV" ] || { fail "$mode: the wrapper rendered no argv"; continue; }
  BAD="$(_writable_git_mounts "$ARGV")"
  [ -z "$BAD" ] && ok "$mode: no writable mount under $COMMON" || fail "$mode: writable host git paths: $(printf '%s' "$BAD" | tr '\n' ' ')"
  grep -qxF -- "$COMMON/objects:$COMMON/objects:ro" <<<"$ARGV" && ok "$mode: host objects are read-only" || fail "$mode: host objects ro mount missing"
  PRIV="$(grep -E -- "^[^:]+:$GITDIR:rw\$" <<<"$ARGV" | head -1)"; PRIV="${PRIV%%:*}"
  if [ -n "$PRIV" ] && [ -d "$PRIV" ]; then
    case "$PRIV" in "$COMMON"/*|"$WT"/*) fail "$mode: the private git dir lives inside .git or the worktree ($PRIV)" ;; *) ok "$mode: private git dir mounted at the gitdir path, sourced outside .git and the worktree" ;; esac
    [ "$(cat "$PRIV/HEAD")" = "ref: refs/heads/gaffer/ticket-1" ] && ok "$mode: private HEAD is the ticket branch" || fail "$mode: private HEAD is '$(cat "$PRIV/HEAD")'"
    grep -qxF "$COMMON/objects" "$PRIV/objects/info/alternates" && ok "$mode: history reached through a read-only alternate" || fail "$mode: alternates missing"
    grep -qF "$MAIN0 refs/heads/main" "$PRIV/packed-refs" && ok "$mode: refs are a snapshot (main visible for diffs)" || fail "$mode: no ref snapshot"
    [ ! -e "$PRIV/commondir" ] && ok "$mode: no commondir (a standalone repository)" || fail "$mode: commondir present"
    [ "$(git config -f "$PRIV/config" core.hooksPath)" = /dev/null ] && ok "$mode: private config disables hooks" || fail "$mode: private config does not disable hooks"
    case "$PRIV" in "$COMMON"/*) ;; *) rm -rf "$PRIV" ;; esac   # never the host's own git dir
  else
    fail "$mode: no private git dir mounted at $GITDIR"
  fi
done

echo "== (2) a stubbed container run: only the ticket branch comes back =="
BIN="$WORK/bin"; mkdir -p "$BIN"
cat > "$BIN/docker" <<'STUB'
#!/usr/bin/env bash
# A docker stand-in: every management call succeeds; `run --rm` runs the payload on the
# host with git pointed at the mount the wrapper gave for the worktree's gitdir path.
[ "${1:-}" = "run" ] || exit 0
shift
for a in "$@"; do [ "$a" = "-d" ] && exit 0; done
mounts=(); wd="$PWD"
while [ "$#" -gt 0 ]; do
  case "$1" in
    -v) mounts+=( "$2" ); shift 2 ;;
    -e|--network|--pids-limit|--memory|--cpus|--tmpfs) shift 2 ;;
    -w) wd="$2"; shift 2 ;;
    --*|-*) shift ;;
    *) break ;;
  esac
done
shift   # the image
gd=""
for wt in $(cat "$STUB_WRITE_ROOTS"); do gd="$(sed -n 's/^gitdir: //p' "$wt/.git")"; done
src=""
for m in ${mounts[@]+"${mounts[@]}"}; do
  s="${m%%:*}"; rest="${m#*:}"; d="${rest%:*}"
  [ "$d" = "$gd" ] && [ "$s" != "$d" ] && src="$s"
done
cd "$wd" || exit 1
if [ -n "$src" ]; then GIT_DIR="$src" GIT_WORK_TREE="$wd" exec "$@"; else exec "$@"; fi
STUB
chmod +x "$BIN/docker"
export STUB_WRITE_ROOTS="$WRF"
PAYLOAD='set -e
echo inside > inside.txt
git add inside.txt
git -c user.email=s@x -c user.name=s commit -qm sandbox-commit
git update-ref refs/heads/main HEAD
git branch -f main HEAD 2>/dev/null || true
git tag evil-tag HEAD
echo PAYLOAD_DONE'
OUT="$(cd "$WT" && PATH="$BIN:$PATH" GAFFER_MCP_BRIDGE=0 bash "$RUNNER_DIR/lib/sandbox-docker.sh" "$WRF" "$RRF" -- sh -c "$PAYLOAD" 2>&1)"; RC=$?
grep -q PAYLOAD_DONE <<<"$OUT" && ok "the payload ran (commit, update-ref main, tag)" || fail "payload did not run: $OUT"
[ "$RC" = 0 ] && ok "wrapper exit 0" || fail "wrapper exited $RC: $OUT"
[ "$(git -C "$REPO" rev-parse main)" = "$MAIN0" ] && ok "host main did NOT move (update-ref / branch -f inside stayed private)" || fail "host main moved to $(git -C "$REPO" rev-parse main)"
[ "$(git -C "$REPO" log --format=%s -1 gaffer/ticket-1)" = sandbox-commit ] && ok "the in-container commit was imported onto the host ticket branch" || fail "ticket branch tip is '$(git -C "$REPO" log --format=%s -1 gaffer/ticket-1)'"
git -C "$REPO" rev-parse -q --verify refs/tags/evil-tag >/dev/null && fail "a tag made inside reached the host" || ok "a tag made inside did not reach the host"
[ -z "$(git -C "$REPO" for-each-ref refs/gaffer-sandbox)" ] && ok "no import scratch ref left behind" || fail "import ref left: $(git -C "$REPO" for-each-ref refs/gaffer-sandbox)"
[ -z "$(git -C "$WT" status --porcelain)" ] && ok "host worktree index matches the imported commit" || fail "host worktree not clean after import: $(git -C "$WT" status --porcelain)"
ls -d "$GAFFER_DATA"/sandbox-git.* >/dev/null 2>&1 && fail "private git dir not removed after the run" || ok "private git dir removed after the run"

echo "== (2b) the validation profile imports nothing =="
TIP1="$(git -C "$REPO" rev-parse gaffer/ticket-1)"
OUT="$(cd "$WT" && PATH="$BIN:$PATH" GAFFER_SANDBOX_PROFILE=validation bash "$RUNNER_DIR/lib/sandbox-docker.sh" "$WRF" "$RRF" -- sh -c 'echo v > v.txt && git add v.txt && git -c user.email=s@x -c user.name=s commit -qm from-a-test && echo VAL_DONE' 2>&1)"
grep -q VAL_DONE <<<"$OUT" && ok "validation payload committed inside" || fail "validation payload failed: $OUT"
[ "$(git -C "$REPO" rev-parse gaffer/ticket-1)" = "$TIP1" ] && ok "a commit made by a gate is not imported (the validated branch never moves)" || fail "validation run moved the ticket branch"
rm -f "$WT/v.txt"

echo "== (2c) a host ref that moved during the run is never overwritten =="
OUT="$(cd "$WT" && PATH="$BIN:$PATH" bash "$RUNNER_DIR/lib/sandbox-docker.sh" "$WRF" "$RRF" -- sh -c "echo r > r.txt && git add r.txt && git -c user.email=s@x -c user.name=s commit -qm racing && git -C '$REPO' --git-dir='$COMMON' update-ref refs/heads/gaffer/ticket-1 $MAIN0" 2>&1)"; RC=$?
[ "$RC" != 0 ] && ok "wrapper reports the failed import (exit $RC)" || fail "a lost compare-and-swap still exited 0"
[ "$(git -C "$REPO" rev-parse gaffer/ticket-1)" = "$MAIN0" ] && ok "the host's newer ref value was kept" || fail "the import overwrote a ref that moved on the host"
grep -q 'moved on the host' <<<"$OUT" && ok "the refusal names the reason" || fail "no reason given: $OUT"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS: $PASS checks"; exit 0; fi
echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"; exit 1
