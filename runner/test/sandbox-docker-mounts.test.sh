#!/usr/bin/env bash
# =====================================================================
# B25 — the `docker` sandbox provider's MOUNT + ROOTS assembly.
# ---------------------------------------------------------------------
# Drives the REAL wrapper (lib/sandbox-docker.sh) in GAFFER_SANDBOX_DRY_RUN=1 mode,
# which assembles the `docker run` argv and PRINTS it (one arg per line) instead of
# executing — no daemon, no image, no network. Live-audit defects it pins:
#   (a) sandbox_wrap_cmd wrote the write/read roots to FIXED shared files under
#       $GAFFER_DATA, so under GAFFER_CONCURRENCY>1 one worker could mount another's
#       worktree read-write → the files are now per-call (distinct paths, own content).
#   (c) $GAFFER_DATA was mounted rw wholesale (settings.json, dashboard-token, the
#       ledgers, other workers' mcp-runtime files with their claim tokens, every
#       sibling delivery worktree) and the worktree's `.git` pointed into the
#       UNMOUNTED real repo so git failed inside → the DB dir is mounted, everything
#       else in it is masked; the repo's `.git` is mounted read-only with only the
#       commit-path sub-dirs read-write.
# Needs git + node. Run: bash test/sandbox-docker-mounts.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
export RUNNER_DIR

command -v git  >/dev/null 2>&1 || { echo "SKIP: git required";  exit 0; }
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/sbx-mounts.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT

# ── Fixture: a real repo + a LINKED delivery worktree under the default
#    $GAFFER_DATA/worktrees/ticket-N layout, and a GAFFER_DATA full of things the
#    container must not see.
export GAFFER_DATA="$WORK/data"; mkdir -p "$GAFFER_DATA/worktrees" "$GAFFER_DATA/.workers" "$GAFFER_DATA/skills-mounts/delivery-7"
REPO="$WORK/repo"; mkdir -p "$REPO"
git -C "$REPO" init -q -b main
git -C "$REPO" config user.email t@e; git -C "$REPO" config user.name t
echo seed > "$REPO/seed.txt"; git -C "$REPO" add -A; git -C "$REPO" commit -qm seed
WT="$GAFFER_DATA/worktrees/ticket-7"
git -C "$REPO" worktree add -q -b gaffer/ticket-7 "$WT" main
SIB="$GAFFER_DATA/worktrees/ticket-8"; mkdir -p "$SIB"; echo "other worker's tree" > "$SIB/README"
printf '{"GAFFER_MODE":"autonomous"}\n' > "$GAFFER_DATA/settings.json"
printf 'dashboard-secret\n' > "$GAFFER_DATA/dashboard-token"
printf '{}\n' > "$GAFFER_DATA/usage-ledger.jsonl"
printf '{"claim":"MINE"}\n'  > "$GAFFER_DATA/mcp-runtime.1111.json"
printf '{"claim":"THEIRS"}\n' > "$GAFFER_DATA/mcp-runtime.2222.json"
: > "$GAFFER_DATA/dispatch.sqlite"; : > "$GAFFER_DATA/dispatch.sqlite-wal"; : > "$GAFFER_DATA/memory.sqlite"
: > "$GAFFER_DATA/events.jsonl"
mkdir -p "$WT/.claude"; ln -s "$GAFFER_DATA/skills-mounts/delivery-7" "$WT/.claude/skills"
export GAFFER_CREW_EVENTS="$GAFFER_DATA/events.jsonl"
export DISPATCH_DB="$GAFFER_DATA/dispatch.sqlite" MEMORY_DB="$GAFFER_DATA/memory.sqlite"

WRF="$WORK/wroots"; printf '%s\n' "$WT" > "$WRF"
RRF="$WORK/rroots"; : > "$RRF"
ARGV="$(GAFFER_SANDBOX_DRY_RUN=1 bash "$RUNNER_DIR/lib/sandbox-docker.sh" "$WRF" "$RRF" -- \
  claude -p hi --mcp-config "$GAFFER_DATA/mcp-runtime.1111.json" 2>"$WORK/stderr")"
has_arg() { printf '%s\n' "$ARGV" | grep -qxF -- "$1"; }
# A mount line is `-v` followed by `src:dst:mode` on the NEXT line (one arg per line).
has_mount() { printf '%s\n' "$ARGV" | grep -qxF -- "$1"; }

echo "== (c) the worktree is rw; its repo's .git is ro with only the commit path rw =="
COMMON="$(git -C "$WT" rev-parse --git-common-dir)"; case "$COMMON" in /*) ;; *) COMMON="$WT/$COMMON";; esac
# Canonical absolute dirs via `cd && pwd -P` (portable — `readlink -f` is GNU-only on older macOS).
_abs_dir() { (cd "$1" 2>/dev/null && pwd -P); }
COMMON="$(cd "$WT" && _abs_dir "$COMMON")"
GITDIR="$(cd "$WT" && _abs_dir "$(git rev-parse --git-dir)")"
has_mount "$WT:$WT:rw"                      && ok "delivery worktree mounted rw"                 || fail "worktree rw mount missing"
has_mount "$COMMON:$COMMON:ro"              && ok "repo .git (common dir) mounted READ-ONLY"      || fail ".git common dir should be mounted ro (argv: $ARGV)"
has_mount "$COMMON/objects:$COMMON/objects:rw" && ok ".git/objects rw (new commits)"             || fail ".git/objects should be rw"
has_mount "$COMMON/refs:$COMMON/refs:rw"    && ok ".git/refs rw (branch tip)"                    || fail ".git/refs should be rw"
has_mount "$COMMON/logs:$COMMON/logs:rw"    && ok ".git/logs rw (reflog)"                        || fail ".git/logs should be rw"
has_mount "$GITDIR:$GITDIR:rw"              && ok ".git/worktrees/<this> rw (index, HEAD)"       || fail "worktree private git dir should be rw"
printf '%s\n' "$ARGV" | grep -qxF -- "$COMMON/config:$COMMON/config:rw" && fail ".git/config must not be rw" || ok ".git/config is not writable"
has_arg "GIT_CONFIG_KEY_0=safe.directory" && ok "git safe.directory set for the uid-mismatched mounts" || fail "safe.directory env missing"

echo "== (c) \$GAFFER_DATA: the DB dir is mounted, every secret sibling is MASKED =="
has_mount "$GAFFER_DATA:$GAFFER_DATA:rw" && ok "GAFFER_DATA (the SQLite directory) mounted rw" || fail "GAFFER_DATA mount missing"
masked_file() { has_mount "/dev/null:$GAFFER_DATA/$1:ro"; }
masked_dir()  { printf '%s\n' "$ARGV" | grep -qF -- "$GAFFER_DATA/$1:rw,noexec,nosuid"; }
masked_file settings.json          && ok "settings.json masked"                        || fail "settings.json NOT masked"
masked_file dashboard-token        && ok "dashboard-token masked"                      || fail "dashboard-token NOT masked"
masked_file usage-ledger.jsonl     && ok "usage-ledger.jsonl masked"                   || fail "usage ledger NOT masked"
masked_file mcp-runtime.2222.json  && ok "ANOTHER worker's mcp-runtime (claim token) masked" || fail "other worker's mcp-runtime NOT masked"
masked_dir  worktrees              && ok "worktrees/ (sibling deliveries) masked by a tmpfs" || fail "worktrees/ NOT masked"
masked_dir  .workers               && ok ".workers/ masked"                            || fail ".workers/ NOT masked"
masked_file mcp-runtime.1111.json  && fail "THIS call's own --mcp-config was masked (agent has no MCP config)" || ok "this call's own mcp-runtime stays visible"
masked_file dispatch.sqlite        && fail "dispatch.sqlite masked (MCP data plane dead)" || ok "dispatch.sqlite stays visible"
masked_file dispatch.sqlite-wal    && fail "dispatch.sqlite-wal masked (SQLite sibling)" || ok "dispatch.sqlite-wal (SQLite sibling) stays visible"
masked_file memory.sqlite          && fail "memory.sqlite masked" || ok "memory.sqlite stays visible"
masked_file events.jsonl           && fail "crew events log masked" || ok "crew events log (GAFFER_CREW_EVENTS) stays visible"
masked_dir  skills-mounts          && fail "the agent's skills mount was masked" || ok "the agent's skills-mounts/ stays visible"
# The worktree's own rw bind lands AFTER the worktrees/ tmpfs (docker sorts by depth),
# so both must be present — the tmpfs hides the siblings, the bind restores this one.
masked_dir worktrees && has_mount "$WT:$WT:rw" && ok "sibling worktrees hidden while this worktree is restored on top" || fail "worktree/tmpfs layering wrong"

echo "== (c) a full-repo write root (.git is a directory) needs no extra git mounts =="
FULL="$WORK/fullrepo"; mkdir -p "$FULL"; git -C "$FULL" init -q -b main
printf '%s\n' "$FULL" > "$WRF"
ARGV2="$(GAFFER_SANDBOX_DRY_RUN=1 bash "$RUNNER_DIR/lib/sandbox-docker.sh" "$WRF" "$RRF" -- sh -c true 2>/dev/null)"
printf '%s\n' "$ARGV2" | grep -qxF -- "$FULL:$FULL:rw" && ok "full repo mounted rw" || fail "full repo rw mount missing"
printf '%s\n' "$ARGV2" | grep -qF -- "$FULL/.git/objects" && fail "a full repo got redundant .git sub-mounts" || ok "no redundant .git sub-mounts for a full repo"

echo "== (a) sandbox_wrap_cmd writes PER-CALL root files, never a fixed shared path =="
# A fake `docker` on PATH so the provider branch believes a daemon is up (the wrapper
# itself is never run here — only the prefix + the files it names are inspected).
FAKEBIN="$WORK/bin"; mkdir -p "$FAKEBIN"
printf '#!/usr/bin/env bash\nexit 0\n' > "$FAKEBIN/docker"; chmod +x "$FAKEBIN/docker"
# shellcheck source=../lib/sandbox.sh
source "$RUNNER_DIR/lib/sandbox.sh"
export SANDBOX_PROVIDER=docker
W1="$(PATH="$FAKEBIN:$PATH" sandbox_wrap_cmd "$WORK/wt-A" "$WORK/ro-A")"
W2="$(PATH="$FAKEBIN:$PATH" sandbox_wrap_cmd "$WORK/wt-B" "$WORK/ro-B")"
F1="$(printf '%s' "$W1" | awk '{print $3}')"; F2="$(printf '%s' "$W2" | awk '{print $3}')"
R1="$(printf '%s' "$W1" | awk '{print $4}')"; R2="$(printf '%s' "$W2" | awk '{print $4}')"
[ -n "$F1" ] && [ -n "$F2" ] && [ "$F1" != "$F2" ] && ok "two calls → two DIFFERENT write-roots files" || fail "write-roots files should differ per call ($F1 vs $F2)"
[ "$R1" != "$R2" ] && ok "two calls → two DIFFERENT read-roots files" || fail "read-roots files should differ per call"
[ "$(cat "$F1")" = "$WORK/wt-A" ] && [ "$(cat "$F2")" = "$WORK/wt-B" ] \
  && ok "each call's file still holds ITS OWN write root (no clobber)" || fail "roots content clobbered: '$(cat "$F1")' / '$(cat "$F2")'"
case "$F1" in "$GAFFER_DATA/sandbox-write-roots.$$."*) ok "per-call file is PID-prefixed (tick.sh can sweep its own on exit)" ;; *) fail "expected \$GAFFER_DATA/sandbox-write-roots.<pid>.XXXXXX (got $F1)" ;; esac
[ ! -e "$GAFFER_DATA/sandbox-write-roots" ] && ok "the old FIXED shared path is no longer written" || fail "fixed shared roots file still written"
grep -q 'sandbox-write-roots.\$\$\.\*' "$RUNNER_DIR/tick.sh" && ok "tick.sh's exit cleanup sweeps this tick's roots files" || fail "tick.sh should sweep sandbox-*-roots.\$\$.* on exit"

echo "== (d) BRIDGE MODE: the MCP data plane is on the host — nothing of \$GAFFER_DATA is mounted =="
printf '%s\n' "$WT" > "$WRF"                            # back to the linked worktree (section (c) above swapped in the full repo)
SOCK="$GAFFER_DATA/mcp-bridge.1111.sock"; : > "$SOCK"     # stands in for the bridge's socket
BRIDGED="$GAFFER_DATA/mcp-runtime.1111.bridge.json"; printf '{"mcpServers":{}}\n' > "$BRIDGED"
ARGV="$(GAFFER_SANDBOX_DRY_RUN=1 GAFFER_MCP_BRIDGE_SOCKET="$SOCK" bash "$RUNNER_DIR/lib/sandbox-docker.sh" "$WRF" "$RRF" -- \
  claude -p hi --mcp-config "$BRIDGED" 2>"$WORK/stderr.bridge")"
has_mount "$GAFFER_DATA:$GAFFER_DATA:rw" && fail "bridge mode still mounts GAFFER_DATA rw" || ok "GAFFER_DATA is NOT mounted"
printf '%s\n' "$ARGV" | grep -q 'dispatch.sqlite\|memory.sqlite' && fail "a database path appears in the docker argv" || ok "no database path anywhere in the argv (DBs unreachable)"
has_mount "$SOCK:$SOCK:rw"        && ok "the bridge socket is mounted rw (the only data-plane path)" || fail "bridge socket mount missing"
has_mount "$BRIDGED:$BRIDGED:ro"  && ok "this call's BRIDGED --mcp-config is mounted ro" || fail "bridged mcp-config mount missing"
has_mount "$WT:$WT:rw"            && ok "delivery worktree still mounted rw" || fail "worktree rw mount missing in bridge mode"
has_mount "$GAFFER_DATA/safety-blocks.jsonl:$GAFFER_DATA/safety-blocks.jsonl:rw" && ok "safety hook ledger mounted rw (telemetry only)" || fail "safety-blocks.jsonl mount missing"
has_mount "$GAFFER_DATA/events.jsonl:$GAFFER_DATA/events.jsonl:rw" && ok "crew events log mounted rw" || fail "crew events mount missing"
has_mount "$GAFFER_DATA/skills-mounts/delivery-7:$GAFFER_DATA/skills-mounts/delivery-7:ro" && ok "skills mount target mounted ro" || fail "skills target mount missing"
for f in settings.json dashboard-token usage-ledger.jsonl mcp-runtime.2222.json mcp-runtime.1111.json; do
  printf '%s\n' "$ARGV" | grep -qF -- "$GAFFER_DATA/$f" && fail "$f is referenced in bridge mode (should be absent, not masked)" || ok "$f absent from the container (not mounted, not masked)"
done
has_arg DISPATCH_DB && fail "DISPATCH_DB forwarded into the container in bridge mode" || ok "DISPATCH_DB not forwarded"
has_arg MEMORY_DB   && fail "MEMORY_DB forwarded in bridge mode" || ok "MEMORY_DB not forwarded"
has_arg DISPATCH_MCP_BIN && fail "DISPATCH_MCP_BIN forwarded in bridge mode" || ok "MCP server bins not forwarded"
has_arg GAFFER_DATA && ok "GAFFER_DATA env still forwarded (the hook's ledger paths)" || fail "GAFFER_DATA env missing"
grep -q 'MCP data plane runs INSIDE' "$WORK/stderr.bridge" && fail "bridge round warned about the data plane inside" || ok "no data-plane-inside warning in bridge mode"
grep -q 'MCP data plane runs INSIDE' "$WORK/stderr" && ok "legacy round (no bridge) WARNS that the DBs are reachable" || fail "legacy round should warn"
# A missing socket is a hard refusal (the host bridge is not up ⇒ never launch uncontained).
if GAFFER_SANDBOX_DRY_RUN=1 GAFFER_MCP_BRIDGE_SOCKET="$GAFFER_DATA/no-such.sock" bash "$RUNNER_DIR/lib/sandbox-docker.sh" "$WRF" "$RRF" -- claude -p hi >/dev/null 2>&1; then
  fail "a missing bridge socket should refuse to run"; else ok "missing bridge socket ⇒ refused (fail closed)"; fi

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
