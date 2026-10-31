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
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
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
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
trap 'gaffer_test_rm_work "$WORK"' EXIT

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
# GAFFER_MCP_BRIDGE=0: the LEGACY layout must be asked for explicitly — with the bridge on
# (the default on Linux) a config-carrying spawn with no socket is REFUSED (section f).
ARGV="$(GAFFER_SANDBOX_DRY_RUN=1 GAFFER_MCP_BRIDGE=0 bash "$RUNNER_DIR/lib/sandbox-docker.sh" "$WRF" "$RRF" -- \
  claude -p hi --mcp-config "$GAFFER_DATA/mcp-runtime.1111.json" 2>"$WORK/stderr")"
has_arg() { grep -qxF -- "$1" <<<"$ARGV"; }
# A mount line is `-v` followed by `src:dst:mode` on the NEXT line (one arg per line).
has_mount() { grep -qxF -- "$1" <<<"$ARGV"; }

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
grep -qxF -- "$COMMON/config:$COMMON/config:rw" <<<"$ARGV" && fail ".git/config must not be rw" || ok ".git/config is not writable"
has_arg "GIT_CONFIG_KEY_0=safe.directory" && ok "git safe.directory set for the uid-mismatched mounts" || fail "safe.directory env missing"

echo "== (c) \$GAFFER_DATA: the DB dir is mounted, every secret sibling is MASKED =="
has_mount "$GAFFER_DATA:$GAFFER_DATA:rw" && ok "GAFFER_DATA (the SQLite directory) mounted rw" || fail "GAFFER_DATA mount missing"
masked_file() { has_mount "/dev/null:$GAFFER_DATA/$1:ro"; }
masked_dir()  { grep -qF -- "$GAFFER_DATA/$1:rw,noexec,nosuid" <<<"$ARGV"; }
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
ARGV2="$(GAFFER_SANDBOX_DRY_RUN=1 GAFFER_MCP_BRIDGE=0 bash "$RUNNER_DIR/lib/sandbox-docker.sh" "$WRF" "$RRF" -- sh -c true 2>/dev/null)"
grep -qxF -- "$FULL:$FULL:rw" <<<"$ARGV2" && ok "full repo mounted rw" || fail "full repo rw mount missing"
grep -qF -- "$FULL/.git/objects" <<<"$ARGV2" && fail "a full repo got redundant .git sub-mounts" || ok "no redundant .git sub-mounts for a full repo"

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
grep -q 'dispatch.sqlite\|memory.sqlite' <<<"$ARGV" && fail "a database path appears in the docker argv" || ok "no database path anywhere in the argv (DBs unreachable)"
has_mount "$SOCK:$SOCK:rw"        && ok "the bridge socket is mounted rw (the only data-plane path)" || fail "bridge socket mount missing"
has_mount "$BRIDGED:$BRIDGED:ro"  && ok "this call's BRIDGED --mcp-config is mounted ro" || fail "bridged mcp-config mount missing"
has_mount "$WT:$WT:rw"            && ok "delivery worktree still mounted rw" || fail "worktree rw mount missing in bridge mode"
has_mount "$GAFFER_DATA/safety-blocks.jsonl:$GAFFER_DATA/safety-blocks.jsonl:rw" && ok "safety hook ledger mounted rw (telemetry only)" || fail "safety-blocks.jsonl mount missing"
has_mount "$GAFFER_DATA/events.jsonl:$GAFFER_DATA/events.jsonl:rw" && ok "crew events log mounted rw" || fail "crew events mount missing"
has_mount "$GAFFER_DATA/skills-mounts/delivery-7:$GAFFER_DATA/skills-mounts/delivery-7:ro" && ok "skills mount target mounted ro" || fail "skills target mount missing"
for f in settings.json dashboard-token usage-ledger.jsonl mcp-runtime.2222.json mcp-runtime.1111.json; do
  grep -qF -- "$GAFFER_DATA/$f" <<<"$ARGV" && fail "$f is referenced in bridge mode (should be absent, not masked)" || ok "$f absent from the container (not mounted, not masked)"
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

echo "== (e) VALIDATION PROFILE: no data plane, no credential — independent of the agent bridge =="
export ANTHROPIC_API_KEY="sk-ant-TEST-not-a-real-key" GAFFER_SANDBOX_CLAUDE_CREDENTIALS="$WORK/creds.json"; printf '{}' > "$WORK/creds.json"
ARGV="$(GAFFER_SANDBOX_DRY_RUN=1 GAFFER_SANDBOX_PROFILE=validation GAFFER_MCP_BRIDGE_SOCKET= GAFFER_SANDBOX_DATA_PLANE=none \
  bash "$RUNNER_DIR/lib/sandbox-docker.sh" "$WRF" "$RRF" -- bash -c 'pnpm test' 2>"$WORK/stderr.val")"
# The worktree itself lives under $GAFFER_DATA/worktrees — that rw mount is the point;
# NOTHING ELSE under $GAFFER_DATA may be referenced.
[ -n "$(grep -F -- "$GAFFER_DATA" <<<"$ARGV" | grep -vF -- "$WT")" ] && fail "validation profile references GAFFER_DATA beyond the worktree: $(printf '%s\n' "$ARGV" | grep -F -- "$GAFFER_DATA" | grep -vF -- "$WT" | head -3 | tr '\n' ' ')" || ok "validation: NOTHING under GAFFER_DATA but the worktree is mounted (no DBs, no ledgers, no socket)"
has_mount "$WT:$WT:rw" && ok "validation: the worktree (the tests) is mounted rw" || fail "validation: worktree mount missing"
has_arg ANTHROPIC_API_KEY && fail "validation profile forwards the model credential" || ok "validation: ANTHROPIC_API_KEY NOT forwarded (a test suite needs no model)"
grep -q 'credentials.json' <<<"$ARGV" && fail "validation profile mounts the credentials file" || ok "validation: no credentials file mounted"
has_arg DISPATCH_DB && fail "validation forwards DISPATCH_DB" || ok "validation: no DB env"
grep -q 'no model credential' "$WORK/stderr.val" && fail "validation profile nagged about a missing credential" || ok "validation: no credential warning (none is wanted)"

echo "== (f) bridge ON + MCP config + NO socket ⇒ REFUSED (never an implicit legacy layout) =="
if GAFFER_SANDBOX_DRY_RUN=1 GAFFER_MCP_BRIDGE=1 bash "$RUNNER_DIR/lib/sandbox-docker.sh" "$WRF" "$RRF" -- claude -p hi --mcp-config "$GAFFER_DATA/mcp-runtime.1111.json" >/dev/null 2>"$WORK/stderr.refuse"; then
  fail "bridge on + config + no socket should REFUSE"; else ok "refused (non-zero) — the wrapper does not infer legacy from an absent socket"; fi
grep -q 'refusing to run with the databases mounted' "$WORK/stderr.refuse" && ok "the refusal names the reason and the opt-out" || fail "refusal message missing: $(cat "$WORK/stderr.refuse")"

echo "== (g) NO MCP config (or an empty data plane) ⇒ 'none': no databases, credentials kept =="
ARGV="$(GAFFER_SANDBOX_DRY_RUN=1 GAFFER_MCP_BRIDGE=1 bash "$RUNNER_DIR/lib/sandbox-docker.sh" "$WRF" "$RRF" -- claude -p hi 2>"$WORK/stderr.none")"
has_mount "$GAFFER_DATA:$GAFFER_DATA:rw" && fail "'none' mode mounted GAFFER_DATA rw" || ok "none: GAFFER_DATA not mounted"
grep -q 'dispatch.sqlite\|memory.sqlite' <<<"$ARGV" && fail "none: a database path appears" || ok "none: no database path in the argv"
has_mount "$GAFFER_DATA/safety-blocks.jsonl:$GAFFER_DATA/safety-blocks.jsonl:rw" && ok "none: the hook's telemetry ledger is mounted" || fail "none: ledger mount missing"
has_arg ANTHROPIC_API_KEY && ok "none: the model credential IS forwarded (an agent without MCP still needs it)" || fail "none: credential missing"
ARGV="$(GAFFER_SANDBOX_DRY_RUN=1 GAFFER_MCP_BRIDGE=1 GAFFER_SANDBOX_DATA_PLANE=none bash "$RUNNER_DIR/lib/sandbox-docker.sh" "$WRF" "$RRF" -- claude -p hi --mcp-config "$GAFFER_DATA/mcp-runtime.1111.json" 2>/dev/null)"
has_mount "$GAFFER_DATA:$GAFFER_DATA:rw" && fail "empty data plane (GAFFER_SANDBOX_DATA_PLANE=none) mounted GAFFER_DATA rw" || ok "an EMPTY MCP config declared by the launcher ⇒ no databases either"
unset ANTHROPIC_API_KEY GAFFER_SANDBOX_CLAUDE_CREDENTIALS

echo "== (h) a repository cannot add a host directory to the mounts (external review #6) =="
# The node_modules links the RUNNER creates (gaffer_link_node_modules) point at the
# primary checkout's own node_modules at the same relative path; that is the whole
# allow-list. Every other symlink in the worktree is repo- or agent-controlled and must
# never become a bind mount, however it is spelled.
# shellcheck source=../lib/agent-env.sh
source "$RUNNER_DIR/lib/agent-env.sh"
HOSTDIR="$WORK/host-home"; mkdir -p "$HOSTDIR/.ssh"; echo secret > "$HOSTDIR/.ssh/id_rsa"
P2="$WORK/primary"; mkdir -p "$P2/node_modules/dep" "$P2/packages/a/node_modules/dep"
git -C "$P2" init -q -b main
git -C "$P2" config user.email t@e; git -C "$P2" config user.name t
printf 'node_modules\n' > "$P2/.gitignore"; mkdir -p "$P2/packages/a" "$P2/packages/b" "$P2/packages/c" "$P2/packages/d"
for d in a b c d; do echo "$d" > "$P2/packages/$d/index.js"; done
git -C "$P2" add -A; git -C "$P2" commit -qm seed
WT2="$WORK/wt2"; git -C "$P2" worktree add -q -b gaffer/ticket-9 "$WT2" main
gaffer_link_node_modules "$P2" "$WT2"
[ -L "$WT2/node_modules" ] && [ -L "$WT2/packages/a/node_modules" ] && ok "fixture: the runner linked the root + workspace node_modules" || fail "fixture: gaffer_link_node_modules did not link"
# The repository's own links (what a hostile commit or an earlier container step leaves):
ln -s "$HOSTDIR" "$WT2/packages/b/node_modules"                          # absolute, outside
ln -s "$WORK/hop1" "$WT2/packages/c/node_modules"; ln -s "$WORK/hop2" "$WORK/hop1"; ln -s /etc "$WORK/hop2"  # a chain
ln -s ../../../host-home "$WT2/packages/d/node_modules"                  # relative, escapes via ..
mkdir -p "$WT2/tools/node_modules/x"                                     # a real directory, not a link
printf '%s\n' "$WT2" > "$WRF"
dry() { GAFFER_SANDBOX_DRY_RUN=1 GAFFER_SANDBOX_PROFILE=validation GAFFER_MCP_BRIDGE_SOCKET= GAFFER_SANDBOX_DATA_PLANE=none \
          bash "$RUNNER_DIR/lib/sandbox-docker.sh" "$WRF" "$RRF" -- bash -c 'pnpm test' 2>"$WORK/stderr.h"; }
ARGV="$(dry)"; rc=$?
[ "$rc" -eq 0 ] && ok "the wrapper still runs (rc 0) with hostile links present" || fail "wrapper rc $rc: $(cat "$WORK/stderr.h")"
P2C="$(cd "$P2" && pwd -P)"
has_mount "$P2C/node_modules:$P2/node_modules:ro" && ok "the runner's root link → primary node_modules mounted ro (as before)" || fail "legit root node_modules mount missing (argv: $(grep -F node_modules <<<"$ARGV" | tr '\n' ' '))"
has_mount "$P2C/packages/a/node_modules:$P2/packages/a/node_modules:ro" && ok "the runner's workspace-package link mounted ro (as before)" || fail "legit workspace node_modules mount missing"
grep -qF -- "$HOSTDIR" <<<"$ARGV" && fail "an absolute link OUTSIDE the worktree became a mount: $(grep -F -- "$HOSTDIR" <<<"$ARGV" | head -1)" || ok "absolute link to a host directory: NOT mounted"
grep -qE -- '^/etc:' <<<"$ARGV" && fail "a symlink CHAIN ending at /etc became a mount" || ok "symlink chain to /etc: NOT mounted"
grep -qF -- "hop" <<<"$ARGV" && fail "a hop of the chain became a mount" || ok "no hop of the chain is mounted"
grep -qF -- "$WT2/packages/b/node_modules" "$WORK/stderr.h" && ok "WARNING names the absolute external link" || fail "no warning naming $WT2/packages/b/node_modules: $(cat "$WORK/stderr.h")"
grep -qF -- "$WT2/packages/c/node_modules" "$WORK/stderr.h" && ok "WARNING names the chained link" || fail "no warning naming the chained link"
grep -qF -- "$WT2/packages/d/node_modules" "$WORK/stderr.h" && ok "WARNING names the relative ..-escaping link" || fail "no warning naming the relative escaping link"
grep -qF -- "$WT2/node_modules:" "$WORK/stderr.h" || grep -qF -- "$WT2/packages/a/node_modules:" "$WORK/stderr.h" && fail "the runner's own link was warned about: $(cat "$WORK/stderr.h")" || ok "no warning for the runner's own links"
grep -qF -- "$WT2/tools/node_modules" <<<"$ARGV" && fail "a real node_modules DIRECTORY got its own mount" || ok "a real node_modules directory: no extra mount (inside the rw worktree, unchanged)"
has_mount "$WT2:$WT2:rw" && ok "the worktree itself is still mounted rw" || fail "worktree rw mount missing"

# A primary-side node_modules that is itself a symlink (a repository COMMITTING a
# node_modules link) resolves outside the primary: refused even though it is the
# runner-shaped path.
P3="$WORK/primary3"; mkdir -p "$P3"; git -C "$P3" init -q -b main
git -C "$P3" config user.email t@e; git -C "$P3" config user.name t
ln -s "$HOSTDIR" "$P3/node_modules"; git -C "$P3" add -A; git -C "$P3" commit -qm 'commit a node_modules link'
WT3="$WORK/wt3"; git -C "$P3" worktree add -q -b gaffer/ticket-10 "$WT3" main
[ -L "$WT3/node_modules" ] && ok "fixture: the worktree checked out the committed node_modules link" || fail "fixture: committed link missing"
printf '%s\n' "$WT3" > "$WRF"
ARGV="$(dry)"
grep -qF -- "$HOSTDIR" <<<"$ARGV" && fail "a COMMITTED node_modules link (primary-side symlink) became a mount" || ok "committed node_modules link: NOT mounted"
grep -qF -- "$WT3/node_modules" "$WORK/stderr.h" && ok "WARNING names the committed link" || fail "no warning for the committed link"

# A forged `.git` file: the worktree is writable, so its `.git` may name ANOTHER repo.
# Neither its git metadata nor dependency links are honoured.
OTHER="$WORK/other-repo"; mkdir -p "$OTHER/node_modules/dep"; git -C "$OTHER" init -q -b main
git -C "$OTHER" config user.email t@e; git -C "$OTHER" config user.name t
git -C "$OTHER" commit -q --allow-empty -m seed
git -C "$OTHER" worktree add -q -b side "$WORK/other-wt" main
WT4="$WORK/wt4"; git -C "$P2" worktree add -q -b gaffer/ticket-11 "$WT4" main
OTHERC="$(cd "$OTHER" && pwd -P)"
printf 'gitdir: %s/.git/worktrees/other-wt\n' "$OTHERC" > "$WT4/.git"
ln -s "$OTHER/node_modules" "$WT4/node_modules"
printf '%s\n' "$WT4" > "$WRF"
ARGV="$(dry)"
grep -qF -- "$OTHERC/.git" <<<"$ARGV" && fail "a forged .git file mounted ANOTHER repo's git metadata: $(grep -F -- "$OTHERC/.git" <<<"$ARGV" | head -1)" || ok "forged .git file: the other repo's git metadata is NOT mounted"
grep -qF -- "$OTHERC/node_modules" <<<"$ARGV" && fail "a forged .git file let the other repo's node_modules be mounted" || ok "forged .git file: no dependency link honoured"
grep -q 'not mounting any git metadata' "$WORK/stderr.h" && ok "WARNING explains the refused .git file" || fail "no warning for the forged .git file: $(cat "$WORK/stderr.h")"
# And the legitimate linked worktree keeps its git mounts (regression guard).
printf '%s\n' "$WT2" > "$WRF"
ARGV="$(dry)"
has_mount "$P2C/.git:$P2C/.git:ro" && ok "a genuine linked worktree still gets its repo's .git ro" || fail "genuine .git mount missing"

# The agent's `.claude/skills` link (bridge / none mode) follows the same rule: only a
# runner skill mount under $GAFFER_DATA/skills-mounts/ is ever mounted.
rm -f "$WT/.claude/skills"; ln -s "$HOSTDIR" "$WT/.claude/skills"
printf '%s\n' "$WT" > "$WRF"
ARGV="$(GAFFER_SANDBOX_DRY_RUN=1 GAFFER_MCP_BRIDGE=1 bash "$RUNNER_DIR/lib/sandbox-docker.sh" "$WRF" "$RRF" -- claude -p hi 2>"$WORK/stderr.sk")"
grep -qF -- "$HOSTDIR" <<<"$ARGV" && fail "a .claude/skills link to a host directory became a mount" || ok ".claude/skills link outside the skill mounts: NOT mounted"
grep -qF -- "$WT/.claude/skills" "$WORK/stderr.sk" && ok "WARNING names the .claude/skills link" || fail "no warning for the .claude/skills link"
rm -f "$WT/.claude/skills"; ln -s "$GAFFER_DATA/skills-mounts/delivery-7" "$WT/.claude/skills"
ARGV="$(GAFFER_SANDBOX_DRY_RUN=1 GAFFER_MCP_BRIDGE=1 bash "$RUNNER_DIR/lib/sandbox-docker.sh" "$WRF" "$RRF" -- claude -p hi 2>/dev/null)"
grep -qF -- "$GAFFER_DATA/skills-mounts/delivery-7:$GAFFER_DATA/skills-mounts/delivery-7:ro" <<<"$ARGV" && ok "the runner's own skills mount is still mounted ro" || fail "runner skills mount missing"

echo "== (i) a .git SYMLINK cannot borrow another worktree's registration (independent review) =="
# The worktree is writable, so its `.git` can be replaced by a SYMLINK to a real, registered
# worktree's `.git` file — of another repo (OTHER above) or a sibling delivery of the same
# repo. Following that link, git's two-way registration agrees with itself, but it is not
# THIS write root's: nothing of the other worktree may be mounted, least of all rw.
WT5="$WORK/wt5"; git -C "$P2" worktree add -q -b gaffer/ticket-12 "$WT5" main
WT6="$WORK/wt6"; git -C "$P2" worktree add -q -b gaffer/ticket-13 "$WT6" main
OTHERWTC="$(cd "$WORK/other-wt" && pwd -P)"
rm -f "$WT5/.git"; ln -s "$WORK/other-wt/.git" "$WT5/.git"
ln -s "$OTHER/node_modules" "$WT5/node_modules"
printf '%s\n' "$WT5" > "$WRF"
ARGV="$(dry)"
grep -qF -- "$OTHERC/.git" <<<"$ARGV" && fail "a .git symlink to ANOTHER repo's worktree mounted that repo's git metadata: $(grep -F -- "$OTHERC/.git" <<<"$ARGV" | tr '\n' ' ')" || ok ".git symlink to another repo's worktree: none of its git metadata is mounted"
grep -qF -- "$OTHERC/node_modules" <<<"$ARGV" && fail "a .git symlink let another repo's node_modules be mounted" || ok ".git symlink to another repo's worktree: its node_modules is not mounted"
grep -qF -- "$OTHERWTC" <<<"$ARGV" && fail "the other repo's worktree became a mount" || ok ".git symlink: the other worktree itself is not mounted"
grep -qF -- "not mounting any git metadata for $WT5" "$WORK/stderr.h" && ok "WARNING names the write root whose .git is a symlink" || fail "no warning for the .git symlink: $(cat "$WORK/stderr.h")"
rm -f "$WT6/.git"; ln -s "$WT2/.git" "$WT6/.git"
printf '%s\n' "$WT6" > "$WRF"
ARGV="$(dry)"
WT2GD="$(cd "$(git -C "$WT2" rev-parse --git-dir)" && pwd -P)"
grep -qF -- "$WT2GD" <<<"$ARGV" && fail "a .git symlink to a SIBLING delivery mounted its private git dir: $(grep -F -- "$WT2GD" <<<"$ARGV" | head -1)" || ok ".git symlink to a sibling delivery: its private git dir is not mounted"

# Path shapes that could mis-split docker's `-v src:dst:mode`: a `:` or a newline in the
# link's path is skipped with a WARNING (never mounted, never fails the run); a primary
# whose path has a SPACE still gets its dependencies (one argv element, no splitting).
mkdir -p "$WT2/c:x" "$WT2/n
l"
ln -s "$HOSTDIR" "$WT2/c:x/node_modules"; ln -s "$HOSTDIR" "$WT2/n
l/node_modules"
printf '%s\n' "$WT2" > "$WRF"
ARGV="$(dry)"; rc=$?
[ "$rc" -eq 0 ] && ok "a ':' / newline in a link path does not fail the run" || fail "wrapper rc $rc with ':' / newline paths"
grep -qF -- "$HOSTDIR" <<<"$ARGV" && fail "a ':' / newline link became a mount" || ok "':' and newline link paths: NOT mounted"
grep -qF -- "$WT2/c:x/node_modules: its path contains ':'" "$WORK/stderr.h" && ok "WARNING names the ':' link" || fail "no warning for the ':' link: $(cat "$WORK/stderr.h")"
rm -rf "$WT2/c:x" "$WT2/n
l"
SP="$WORK/with space/primary"; mkdir -p "$SP/node_modules/dep"; git -C "$SP" init -q -b main
git -C "$SP" config user.email t@e; git -C "$SP" config user.name t
printf 'node_modules\n' > "$SP/.gitignore"; git -C "$SP" add -A; git -C "$SP" commit -qm s
SWT="$WORK/with space/wt"; git -C "$SP" worktree add -q -b t "$SWT" main
gaffer_link_node_modules "$SP" "$SWT"
printf '%s\n' "$SWT" > "$WRF"
ARGV="$(dry)"
has_mount "$SP/node_modules:$SP/node_modules:ro" && ok "a primary path with a space: its node_modules is mounted as one argument" || fail "space-path node_modules mount missing: $(grep -F node_modules <<<"$ARGV" | tr '\n' ' ')"
has_mount "$SP/.git:$SP/.git:ro" && ok "a primary path with a space: its .git is verified and mounted" || fail "space-path .git mount missing"

echo "== (j) legacy layout: the .claude/skills link cannot unmask a \$GAFFER_DATA entry (independent review) =="
# In the legacy layout (the default on macOS) every top-level entry of the rw-mounted
# GAFFER_DATA is masked except an allow-list, and the agent's skills link used to be
# copied into that allow-list verbatim — so a link at the dashboard token, settings.json
# or worktrees/ left that entry readable inside the container.
printf '%s\n' "$WT" > "$WRF"
legacy() { GAFFER_SANDBOX_DRY_RUN=1 GAFFER_MCP_BRIDGE=0 bash "$RUNNER_DIR/lib/sandbox-docker.sh" "$WRF" "$RRF" -- \
  claude -p hi --mcp-config "$GAFFER_DATA/mcp-runtime.1111.json" 2>"$WORK/stderr.j"; }
for _t in dashboard-token settings.json worktrees .workers "skills-mounts/../dashboard-token"; do
  rm -f "$WT/.claude/skills"; ln -s "$GAFFER_DATA/$_t" "$WT/.claude/skills"
  ARGV="$(legacy)"
  _top="${_t%%/*}"; [ "$_top" = skills-mounts ] && _top=dashboard-token
  if [ -d "$GAFFER_DATA/$_top" ]; then masked_dir "$_top"; else masked_file "$_top"; fi \
    && ok "legacy: a .claude/skills link at \$GAFFER_DATA/$_t leaves $_top masked" \
    || fail "legacy: a .claude/skills link at \$GAFFER_DATA/$_t UNMASKED $_top"
done
rm -f "$WT/.claude/skills"; ln -s "$GAFFER_DATA/skills-mounts/delivery-7" "$WT/.claude/skills"
ARGV="$(legacy)"
masked_dir skills-mounts && fail "legacy: the runner's own skills mount got masked" || ok "legacy: the runner's own skills mount stays visible"
masked_file dashboard-token && ok "legacy: with the runner's own link, dashboard-token is still masked" || fail "legacy: dashboard-token not masked"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
