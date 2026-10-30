#!/usr/bin/env bash
# shellcheck shell=bash
# Gaffer factory — per-agent SKILL mount + skill-selection telemetry.
#
# WHY (token win): the live agent launch used to symlink the WHOLE skill library
# into the agent's `.claude/skills` (every one of the ~66 bundled skills), so
# Claude Code auto-loaded ALL of their frontmatter blocks into system context on
# EVERY call — roughly 5k wasted tokens per call for skills the ticket will never
# touch. `bin/select-skills.mjs` ALREADY computes the relevant subset for a
# ticket's stack/area (injected as prompt text). This builds a per-agent mount
# containing ONLY that subset PLUS a small universal delivery-mechanics set, and
# points `.claude/skills` at it — so the agent auto-loads only skills it might
# actually use, without changing what any skill DOES.

# Universal delivery-mechanics skills mounted on EVERY agent regardless of
# stack/area — the core delivery flow fires on every ticket (run the tests, the
# linter and coverage; minimise + self-review the diff; record evidence; record the
# digest delta the prompt mandates). Space-separated skill
# DIRECTORY names; override via env. Only names that actually exist in
# $SKILLS_DIR are linked, so a trimmed library is safe.
# prepare-digest-delta and plan-change are part of the universal set — the delivery
# prompt / brief MANDATE them, so they must survive the select-skills fallback too.
# This list IS select-skills.mjs ROLE_PROFILES.delivery.core
# (test/select-skills.test.mjs pins the two equal). create-branch is NOT here: the
# runner creates the branch (it is a user-only skill, never mounted on a factory agent).
: "${GAFFER_UNIVERSAL_SKILLS:=run-tests run-lint run-coverage minimalism self-review record-evidence prepare-digest-delta plan-change}"  # skills mounted on every delivery (= select-skills ROLE_PROFILES.delivery.core)

# Root under which per-agent mounts live. Factory state (never the target repo),
# so leaving a mount in place between ticks is harmless; each build rebuilds its
# keyed dir in place (idempotent).
_gaffer_skills_mount_root() { printf '%s/skills-mounts' "${GAFFER_DATA:-}"; }

# Sanitise a mount key to a single safe path component.
_gaffer_skills_mount_key() {
  local key
  key="$(printf '%s' "${1:-}" | tr -c 'A-Za-z0-9._-' '-')"
  printf '%s' "${key:-mount}"
}

# gaffer_skills_mount <dest_dir> <selected> <mount_key>
#   Builds a per-agent skill mount at $GAFFER_DATA/skills-mounts/<mount_key>
#   containing symlinks to (selected ∪ universal) skills that exist in the
#   library, then points <dest_dir>/.claude/skills at that mount. <selected> is a
#   comma/space/newline-separated list of skill DIRECTORY names (e.g. the output
#   of select-skills.mjs). Rebuilt in place on each call (idempotent).
#
#   FAIL-SOFT: on ANY problem (no $GAFFER_DATA, no library, mkdir/symlink failure,
#   or an empty resulting set) it falls back to symlinking the WHOLE library —
#   byte-for-byte today's behaviour — so the optimisation can never break a run.
gaffer_skills_mount() {
  local dest="$1" selected="${2:-}" mount_key="${3:-mount}"
  local claude_dir="$dest/.claude"
  mkdir -p "$claude_dir" 2>/dev/null || true

  # Whole-library fallback (today's behaviour) — used on any failure below.
  _gsm_fallback() { ln -sfn "$SKILLS_DIR" "$claude_dir/skills"; }

  [ -d "${SKILLS_DIR:-}" ] || { _gsm_fallback; return 0; }
  [ -n "${GAFFER_DATA:-}" ] || { _gsm_fallback; return 0; }

  local root key mount
  root="$(_gaffer_skills_mount_root)"
  key="$(_gaffer_skills_mount_key "$mount_key")"
  mount="$root/$key"
  mkdir -p "$root" 2>/dev/null || { _gsm_fallback; return 0; }
  rm -rf "$mount" 2>/dev/null || true
  mkdir -p "$mount" 2>/dev/null || { _gsm_fallback; return 0; }

  # Union the selected list (comma/newline -> space) with the universal set, then
  # symlink each name that resolves to a real SKILL.md. Duplicates are skipped.
  local names name count=0
  names="$(printf '%s %s' "$(printf '%s' "$selected" | tr ',\n' '  ')" "$GAFFER_UNIVERSAL_SKILLS")"
  for name in $names; do
    [ -n "$name" ] || continue
    [ -e "$mount/$name" ] && continue
    if [ -d "$SKILLS_DIR/$name" ] && [ -f "$SKILLS_DIR/$name/SKILL.md" ]; then
      ln -sfn "$SKILLS_DIR/$name" "$mount/$name" 2>/dev/null && count=$((count + 1))
    fi
  done

  # Never mount an empty dir — fall back to the whole library instead.
  if [ "$count" -eq 0 ]; then
    rm -rf "$mount" 2>/dev/null || true
    _gsm_fallback
    return 0
  fi
  ln -sfn "$mount" "$claude_dir/skills"
  return 0
}

# gaffer_skills_unmount <dest_dir> — drop the `.claude/skills` symlink (and the
# factory `.claude/settings.json` written beside it) that gaffer_skills_mount
# installed into <dest_dir>, so a PERSISTENT target dir isn't left holding a
# now-dangling link once its mount target is removed.
#
# WHY: a normal delivery mounts into a THROWAWAY git worktree that the runner later
# `rm -rf`s wholesale — the mounted `.claude/skills` symlink dies with it. A
# GREENFIELD bootstrap, however, runs the agent DIRECTLY in the new repo dir, which
# is NOT a throwaway worktree and is never `rm -rf`d. So once
# gaffer_skills_mount_cleanup drops the mount TARGET, that repo's `.claude/skills`
# is left a DANGLING symlink in the real repo — which the post-teardown hygiene
# gate (gaffer_assert_repo_clean) correctly flags as "broken symlink in real repo".
# This purges the factory's own mount residue so the detector stays firing on
# genuine leaks, not on our own teardown litter.
#
# SAFETY: only ever removes the factory's OWN artifacts. `.claude/skills` is removed
# ONLY when it is a SYMLINK whose target points into the factory skills-mount root
# or at the skill library (the whole-library fallback) — never an agent-scaffolded
# real `.claude/skills` directory/file. `.claude/settings.json` (the runner-config
# the factory writes) is removed too, then `.claude/` is `rmdir`'d ONLY if empty, so
# any genuine app content the agent created under `.claude/` is preserved intact.
gaffer_skills_unmount() {
  local dest="${1:-}" claude link target root ours=0
  [ -n "$dest" ] || return 0
  claude="$dest/.claude"
  link="$claude/skills"
  [ -L "$link" ] || return 0
  target="$(readlink "$link" 2>/dev/null || true)"   # resolves even when dangling
  [ -n "$target" ] || return 0
  # Match the target against OUR two possible link destinations. Each prefix is
  # guarded on its base var being non-empty so an unset var can never degrade into a
  # match-everything glob (e.g. an empty SKILLS_DIR must not become "/*").
  if [ -n "${GAFFER_DATA:-}" ]; then
    root="$(_gaffer_skills_mount_root)"
    case "$target" in "$root"|"$root"/*) ours=1 ;; esac
  fi
  if [ -n "${SKILLS_DIR:-}" ]; then
    case "$target" in "$SKILLS_DIR"|"$SKILLS_DIR"/*) ours=1 ;; esac
  fi
  [ "$ours" = 1 ] || return 0
  rm -f "$link" 2>/dev/null || true
  rm -f "$claude/settings.json" 2>/dev/null || true
  rmdir "$claude" 2>/dev/null || true              # no-op (fails safely) if not empty
  return 0
}

# gaffer_skills_mount_cleanup <mount_key> [<dest_dir>] — remove a per-agent mount
# dir. Guarded to the skills-mounts root so it can never rm anything outside factory
# state. When <dest_dir> is given (a PERSISTENT target, i.e. a bootstrap repo that is
# not a throwaway worktree), also drop the `.claude/skills` symlink this mount
# installed there so it is not left dangling — see gaffer_skills_unmount.
gaffer_skills_mount_cleanup() {
  local root key
  [ -n "${GAFFER_DATA:-}" ] || { gaffer_skills_unmount "${2:-}"; return 0; }
  root="$(_gaffer_skills_mount_root)"
  key="$(_gaffer_skills_mount_key "${1:-}")"
  # ${var:?} guards: an empty root or key must never turn this into `rm -rf /` or
  # `rm -rf <root>/` — abort the function instead (the `|| true` keeps the caller alive).
  rm -rf "${root:?}/${key:?}" 2>/dev/null || true
  gaffer_skills_unmount "${2:-}"
}

# gaffer_record_skill_usage <ticket> <role> <stack> <selected> [<scan_file>] [<mount_key>] [<agent_dir>] [<since>]
#   Append one skill-selection telemetry record (JSONL) for this agent run so a
#   LATER, data-driven prune of the generic skills isn't blind. Records which
#   skills were SELECTED — with <mount_key>, the names actually in that per-agent
#   mount (the selection ∪ the universal set) — and, best-effort, which were APPLIED:
#   named in the agent's output JSON (<scan_file>), or OPENED (a Read / Bash target
#   under the skill's dir in $GAFFER_DATA/tool-metrics.jsonl at or after <since>,
#   scoped to this <ticket> or to <agent_dir> / the mount). Called by the delivery,
#   bootstrap, review, security-review and clarify sites. FAIL-SOFT: a telemetry
#   failure must never fail a run.
gaffer_record_skill_usage() {
  local ticket="${1:-}" role="${2:-}" stack="${3:-}" selected="${4:-}" scan="${5:-}"
  local mount_key="${6:-}" agent_dir="${7:-}" since="${8:-}" mount=""
  [ -n "${GAFFER_DATA:-}" ] || return 0
  command -v node >/dev/null 2>&1 || return 0
  local bin="${RUNNER_DIR:-.}/bin/record-skill-usage.mjs"
  [ -f "$bin" ] || return 0
  [ -n "$mount_key" ] && mount="$(_gaffer_skills_mount_root)/$(_gaffer_skills_mount_key "$mount_key")"
  node "$bin" \
    --ticket "$ticket" --role "$role" --stack "$stack" --selected "$selected" \
    ${scan:+--scan "$scan"} \
    ${mount:+--mount "$mount"} \
    --tool-ledger "$GAFFER_DATA/tool-metrics.jsonl" \
    ${since:+--since "$since"} \
    ${agent_dir:+--root "$agent_dir"} \
    --out "${GAFFER_SKILL_TELEMETRY:-$GAFFER_DATA/skills-telemetry.jsonl}" \
    >/dev/null 2>&1 || true
}
