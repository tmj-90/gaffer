# Gaffer greenfield "create-a-repo" delivery mode (sourced by factory.config.sh).
# shellcheck shell=bash
#
# A `bootstrap` ticket (dispatch `ticket.bootstrap == 1`) has NO existing repo to
# branch — it CREATES one. Today's normal flow branches an onboarded repo and
# delivers in a throwaway worktree; that cannot work when the repo does not exist
# yet. This module supplies the pure, testable helpers the bootstrap path in
# tick.sh uses:
#
#   gaffer_bootstrap_repo_name   <ticket-show-json>   → echoes the target repo name
#   gaffer_bootstrap_repo_dir    <name>               → echoes <root>/<name> (the new path)
#   gaffer_bootstrap_target_ok   <dir>                → 0 if usable, else 1 + a reason
#   gaffer_bootstrap_init        <dir>                → mkdir + git init (idempotent)
#   gaffer_bootstrap_onboard     <num> <name> <dir> <stack> → register+onboard the new repo
#
# The functions are deliberately small and side-effect-explicit so the tick can
# wire them together and the tests can exercise each in isolation. `_init` and
# `_onboard` are the only ones that touch the filesystem / the factory; the rest
# are pure string/path computations.

# Derive the target repo NAME for a bootstrap ticket from its `ticket show` JSON.
# Priority (first non-empty wins), so a plan can be explicit but a bare ticket
# still works:
#   1. an explicitly-linked repo's name        (repositories[0].name)
#   2. the ticket's `source` field             (the decomposer can put the name there)
#   3. a slug of the ticket title              (last resort)
# Echoes the chosen name (slugged to a filesystem-safe leaf) or empty on failure.
gaffer_bootstrap_repo_name() {
  local show_json="$1"
  printf '%s' "$show_json" | python3 -c '
import sys, json, re
try:
    d = json.load(sys.stdin)
except Exception:
    print(""); sys.exit(0)
t = d.get("ticket", {}) or {}
repos = d.get("repositories", []) or []
name = ""
if repos and (repos[0].get("name") or "").strip():
    name = repos[0]["name"].strip()
elif (t.get("source") or "").strip():
    name = t["source"].strip()
else:
    name = (t.get("title") or "").strip()
# Slug to a filesystem-safe leaf: lowercase, non-alnum → "-", collapse, trim.
slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
slug = re.sub(r"-+", "-", slug)[:64].strip("-")
print(slug)
' 2>/dev/null
}

# Compute the absolute target directory for a new bootstrap repo: <root>/<name>.
# Root is GAFFER_BOOTSTRAP_ROOT (default $HOME/git). A name containing a path
# separator or ".." is rejected (returns 1, echoes nothing) so a malicious or
# malformed name can never escape the configured root.
#   gaffer_bootstrap_repo_dir <name>
gaffer_bootstrap_repo_dir() {
  local name="$1"
  local root="${GAFFER_BOOTSTRAP_ROOT:-$HOME/git}"
  [ -n "$name" ] || return 1
  case "$name" in
    */*|*..*) return 1 ;;   # never allow traversal out of the root
  esac
  printf '%s/%s\n' "$root" "$name"
}

# True (0) when a non-empty target dir is a RESUMABLE prior-bootstrap scaffold —
# our own earlier attempt that git-init'd the dir but died before committing any
# real work — versus a real repo / real files we must never clobber. Resumable iff:
# it IS a git repo, has NO commits (unborn HEAD), and every top-level entry is a
# known factory-scaffold file. Any commit or any non-scaffold file → not resumable.
_gaffer_bootstrap_is_resumable_scaffold() {
  local dir="$1"
  git -C "$dir" rev-parse --git-dir >/dev/null 2>&1 || return 1            # not git → real content
  git -C "$dir" rev-parse --verify -q HEAD >/dev/null 2>&1 && return 1     # has commits → real work, leave it
  local allow=" .git .claude CLAUDE.factory.md .mcp.json mcp-runtime.json .gitignore "
  local e
  while IFS= read -r e; do
    [ -n "$e" ] || continue
    case "$allow" in *" $e "*) ;; *) return 1 ;; esac                      # a non-scaffold entry → real content
  done < <(ls -A "$dir" 2>/dev/null)
  return 0
}

# Assert the target dir is usable for the bootstrap. Usable means: it does not
# exist, OR it is EMPTY, OR it is a RESUMABLE prior-bootstrap scaffold (a failed
# attempt of ours) — in which case we carry on IN PLACE rather than wedging the
# ticket forever on its own leftover. A non-empty dir with REAL content is still
# REFUSED — we must never clobber existing work.
#   gaffer_bootstrap_target_ok <dir>
# Echoes a human-readable reason on refusal; returns 0 (ok) or 1 (refused).
gaffer_bootstrap_target_ok() {
  local dir="$1"
  [ -n "$dir" ] || { echo "bootstrap: no target dir given"; return 1; }
  if [ ! -e "$dir" ]; then
    return 0   # does not exist → we will mkdir it
  fi
  if [ ! -d "$dir" ]; then
    echo "bootstrap: target exists and is not a directory: $dir"; return 1
  fi
  if [ -z "$(ls -A "$dir" 2>/dev/null)" ]; then
    return 0   # empty → fine to init into
  fi
  # Non-empty: carry on only if it's our own resumable failed-bootstrap scaffold.
  if _gaffer_bootstrap_is_resumable_scaffold "$dir"; then
    echo "bootstrap: resuming a prior failed-bootstrap scaffold in $dir" >&2
    return 0
  fi
  echo "bootstrap: target dir already exists and is non-empty: $dir"; return 1
}

# Create the new repo dir and `git init` it (idempotent: a re-run on an already
# git-init'd empty dir is a no-op). Sets a deterministic default branch (main) so
# the dependent feature tickets branch off a known base. Returns non-zero on any
# failure so the caller can fail the bootstrap cleanly.
#   gaffer_bootstrap_init <dir>
gaffer_bootstrap_init() {
  local dir="$1"
  [ -n "$dir" ] || return 1
  mkdir -p "$dir" || return 1
  if ! git -C "$dir" rev-parse --git-dir >/dev/null 2>&1; then
    git -C "$dir" init -q -b main >/dev/null 2>&1 || git -C "$dir" init -q >/dev/null 2>&1 || return 1
  fi
  return 0
}

# Detect the test command for a freshly-created scaffold from its manifest, so the
# onboarded repo is DELIVERABLE (the Definition-of-Done gate has a gate to run). Quiet
# + best-effort: an undetectable stack echoes nothing and the caller leaves the repo's
# test_command unset. Mirrors the stacks the factory bootstraps.
#   node (pnpm/yarn/npm) → "<pm> test"   when package.json declares a "test" script
#   python               → "pytest"      when pytest config / a tests/ dir is present
#   go                   → "go test ./..."
gaffer_bootstrap_detect_test_cmd() {
  local dir="$1"
  [ -d "$dir" ] || return 0
  if [ -f "$dir/package.json" ] \
     && node -e "process.exit(((require('$dir/package.json').scripts)||{}).test?0:1)" 2>/dev/null; then
    if   [ -f "$dir/pnpm-lock.yaml" ] || [ -f "$dir/pnpm-workspace.yaml" ]; then echo "pnpm test"
    elif [ -f "$dir/yarn.lock" ]; then echo "yarn test"
    else echo "npm test"; fi
    return 0
  fi
  if [ -f "$dir/pyproject.toml" ] || [ -f "$dir/pytest.ini" ] || [ -d "$dir/tests" ]; then
    echo "pytest"; return 0
  fi
  [ -f "$dir/go.mod" ] && echo "go test ./..."
  return 0
}

# Register + onboard the freshly-scaffolded repo into the factory so the now-done
# bootstrap unblocks its dependent feature tickets (which target this repo via the
# normal worktree flow). Two registrations, mirroring how a human onboards a repo:
#   1. dispatch `repo add`  — so tickets can link/target the repo + carry a stack.
#   2. crew `repo onboard <path> --standalone` — into the Factory Map.
# Both are best-effort/non-fatal individually but the function returns non-zero if
# the dispatch registration (the one the dependent tickets NEED) fails, so the
# tick can surface a partial onboard. Relies on the `wg` / `fg` wrappers from
# factory.config.sh being in scope.
#   gaffer_bootstrap_onboard <ticket-num> <name> <dir> <stack> [remote] [default-branch]
gaffer_bootstrap_onboard() {
  local num="$1" name="$2" dir="$3" stack="${4:-}" remote="${5:-}" branch="${6:-main}"
  [ -n "$name" ] && [ -n "$dir" ] || return 1
  local wg_ok=1

  # 1) Register in dispatch (the link target for the dependent feature tickets).
  if command -v wg >/dev/null 2>&1 || type wg >/dev/null 2>&1; then
    local add_args=(repo add -n "$name" --path "$dir" --branch "$branch")
    [ -n "$stack" ]  && add_args+=(--stack "$stack")
    [ -n "$remote" ] && add_args+=(--remote "$remote")
    # DELIVERABILITY: register a test command so the repo the factory JUST CREATED is
    # actually deliverable. Without one, EVERY dependent feature ticket hard-fails the
    # Definition-of-Done gate ("zero gates executed — no test_command configured") — the
    # factory would build an epic it structurally cannot land. Detect the scaffold's own
    # test runner from its manifest (best-effort; a stack with no detectable runner is
    # left unset and relies on the DoD's no-gate handling).
    local test_cmd; test_cmd="$(gaffer_bootstrap_detect_test_cmd "$dir")"
    [ -n "$test_cmd" ] && add_args+=(--test "$test_cmd")
    local add_out add_rc
    add_out="$(wg "${add_args[@]}" 2>&1)"; add_rc=$?
    if [ "$add_rc" -eq 0 ]; then
      wg_ok=0
    elif printf '%s' "$add_out" | grep -q '"code":"DUPLICATE"'; then
      # Idempotent retry: a PRIOR (partial) bootstrap already registered this repo.
      # The link target the dependent feature tickets need EXISTS — so this is a
      # success, not a failure. Without this, a re-attempt (e.g. after an unrelated
      # gate blocked the first run) would wrongly report FAILED and leave the whole
      # epic stuck: repo registered, but dependents never linked/unblocked.
      wg_ok=0
    else
      # A genuine registration failure (NOT already-registered). Surface WHY — the
      # caller suppresses this with >/dev/null 2>&1, so without this the whole
      # greenfield epic sinks with only a generic "FAILED" and no cause (e.g. a
      # malformed --branch value failing git-ref validation).
      type log >/dev/null 2>&1 \
        && log "onboard: 'repo add $name' failed (rc=$add_rc): $(printf '%s' "$add_out" | head -c 200 | tr '\n' ' ')"
      wg_ok=1
    fi
  fi

  # 2) Onboard into the Factory Map (crew). Standalone single-repo scope.
  # Non-fatal: a missing/unbuilt crew must not fail the bootstrap delivery.
  if type fg >/dev/null 2>&1; then
    fg repo onboard "$dir" --name "$name" --standalone >/dev/null 2>&1 || true
  fi

  return "$wg_ok"
}

# Locate the inherit-repo planner .mjs next to this lib (works whether sourced or
# invoked from another dir). Echoes the path or empty.
_gaffer_inherit_planner() {
  local here; here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local p="$here/../bin/inherit-repo.mjs"
  [ -f "$p" ] && printf '%s\n' "$p"
}

# After a bootstrap ticket onboards its new repo, link that repo (as a WRITE repo)
# to the epic's sibling tickets that need it so they become deliverable. Pure
# graph resolution lives in bin/inherit-repo.mjs (read-only over the dispatch
# sqlite); THIS function executes the resulting plan via the `wg` CLI:
#
#   * deterministic links (single-bootstrap epic, or a sibling whose dependency
#     graph names exactly one bootstrap) → `wg ticket repo-access set ... --access write`
#   * ambiguous siblings (multi-app epic, 0/>1 bootstraps in the dep closure) →
#     a headless `claude -p` decision (GAFFER_PLAN_MODEL) that MUST return one of the
#     candidate repo names; an invalid/NONE answer leaves the ticket unlinked + logged.
#
# Idempotent: the wg link upserts (re-running never double-links); already-linked
# siblings are skipped by the planner. Best-effort/non-fatal: a missing planner or
# wg simply links nothing. Honours GAFFER_INHERIT_DRY_RUN=1 (skip claude spawns;
# only apply deterministic links) for tests / cautious runs.
#   gaffer_inherit_repo <bootstrap-ticket-num>
gaffer_inherit_repo() {
  local boot_num="$1"
  [ -n "$boot_num" ] || return 0
  command -v wg >/dev/null 2>&1 || type wg >/dev/null 2>&1 || return 0
  local planner; planner="$(_gaffer_inherit_planner)"
  [ -n "$planner" ] || { log "inherit: planner not found, skipping"; return 0; }

  local plan
  if ! plan="$(node "$planner" --bootstrap "$boot_num" --db "$DISPATCH_DB" 2>/dev/null)"; then
    log "inherit: planner failed for bootstrap #$boot_num, skipping"
    return 0
  fi

  # 1) Apply the deterministic links. python3 emits "ticket\trepo\treason" lines.
  local applied=0
  while IFS=$'\t' read -r tnum repo reason; do
    [ -n "$tnum" ] && [ -n "$repo" ] || continue
    if wg ticket repo-access set "$tnum" "$repo" --access write --relation confirmed >/dev/null 2>&1; then
      log "inherited repo $repo → #$tnum ($reason)"
      applied=$((applied+1))
    else
      log "inherit: failed to link $repo → #$tnum"
    fi
  done < <(printf '%s' "$plan" | _gaffer_inherit_links)

  # 2) Resolve the ambiguous (multi-app) siblings via a headless claude decision,
  #    unless dry-run. Each candidate carries an argv; we spawn it, validate the
  #    answer is one of the candidates, and only then link. No/invalid → leave it.
  if [ "${GAFFER_INHERIT_DRY_RUN:-0}" != "1" ] && command -v "${CLAUDE_BIN:-claude}" >/dev/null 2>&1; then
    local idx=0 amb_count
    amb_count="$(printf '%s' "$plan" | _gaffer_inherit_ambiguous_count)"
    while [ "$idx" -lt "${amb_count:-0}" ]; do
      local tnum cands ans
      tnum="$(printf '%s' "$plan" | _gaffer_inherit_amb_field "$idx" ticket)"
      cands="$(printf '%s' "$plan" | _gaffer_inherit_amb_field "$idx" candidates)"  # newline-separated repo names
      # Spawn the planned claude call for this sibling.
      ans="$(printf '%s' "$plan" | _gaffer_inherit_amb_spawn "$idx")"
      ans="$(printf '%s' "$ans" | tr -d '[:space:]')"
      if [ -n "$ans" ] && [ "$ans" != "NONE" ] && printf '%s\n' "$cands" | grep -qxF "$ans"; then
        if wg ticket repo-access set "$tnum" "$ans" --access write --relation confirmed >/dev/null 2>&1; then
          log "inherited repo $ans → #$tnum (claude)"
          applied=$((applied+1))
        else
          log "inherit: failed to link $ans → #$tnum (claude)"
        fi
      else
        log "needs_human_review: #$tnum ambiguous repo choice (claude answer '${ans:-<empty>}' not a candidate) — left unlinked"
      fi
      idx=$((idx+1))
    done
  fi

  log "inherit: linked $applied sibling(s) for bootstrap #$boot_num"
  return 0
}

# --- plan JSON readers (python3 over the planner's single-line JSON) -----------
# Kept tiny + isolated so the spawn/parse logic stays out of gaffer_inherit_repo.

_gaffer_inherit_links() {  # stdin: plan JSON → "ticket<TAB>repo<TAB>reason" per link
  python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for l in d.get("links", []) or []:
    t = l.get("ticket"); r = l.get("repo")
    if t and r:
        print("\t".join([str(t), str(r), str(l.get("reason", ""))]))' 2>/dev/null
}

_gaffer_inherit_ambiguous_count() {  # stdin: plan JSON → count of ambiguous siblings
  python3 -c '
import sys, json
try: d = json.load(sys.stdin)
except Exception: print(0); sys.exit(0)
print(len(d.get("ambiguous", []) or []))' 2>/dev/null
}

_gaffer_inherit_amb_field() {  # stdin: plan JSON; args: <idx> <ticket|candidates>
  python3 -c '
import sys, json
i = int(sys.argv[1]); field = sys.argv[2]
try: d = json.load(sys.stdin)
except Exception: sys.exit(0)
amb = (d.get("ambiguous", []) or [])
if i >= len(amb): sys.exit(0)
a = amb[i]
if field == "ticket": print(a.get("ticket",""))
elif field == "candidates":
    for c in a.get("candidates", []) or []:
        if c.get("repo"): print(c["repo"])' "$1" "$2" 2>/dev/null
}

# Spawn the planned claude argv for ambiguous sibling <idx> and echo its stdout.
# The argv (binary + args) is carried in the plan so model/flags/mcp stay identical
# to the rest of the factory's claude calls.
_gaffer_inherit_amb_spawn() {  # stdin: plan JSON; arg: <idx> → claude stdout
  local idx="$1" payload
  payload="$(cat)"
  # Pull the binary + argv as NUL-separated tokens to survive spaces in the prompt.
  local bin
  bin="$(printf '%s' "$payload" | python3 -c '
import sys, json
i = int(sys.argv[1])
d = json.load(sys.stdin)
print((d.get("ambiguous",[]) or [])[i].get("claudeBin","claude"))' "$idx" 2>/dev/null)"
  [ -n "$bin" ] || bin="${CLAUDE_BIN:-claude}"
  # Build the argv array from the JSON and exec it.
  local -a argv=()
  while IFS= read -r -d '' tok; do argv+=("$tok"); done < <(printf '%s' "$payload" | python3 -c '
import sys, json
i = int(sys.argv[1])
d = json.load(sys.stdin)
for tok in (d.get("ambiguous",[]) or [])[i].get("argv", []) or []:
    sys.stdout.write(tok); sys.stdout.write("\0")' "$idx" 2>/dev/null)
  [ "${#argv[@]}" -gt 0 ] || return 0
  "$bin" "${argv[@]}" 2>/dev/null || true
}
