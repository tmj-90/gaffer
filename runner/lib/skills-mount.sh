#!/usr/bin/env bash
# shellcheck shell=bash
# Gaffer factory — per-agent SKILL mount + skill-selection telemetry.
#
# WHY (token win): the live agent launch used to symlink the WHOLE skill library
# into the agent's `.claude/skills` (every one of the ~66 bundled skills), so
# Claude Code auto-loaded ALL of their frontmatter blocks into system context on
# EVERY call — roughly 5k wasted tokens per call for skills the ticket will never
# touch. `bin/select-skills.mjs` ALREADY computes the relevant subset for a
# ticket's stack/area (injected as prompt text). This installs ONLY that subset PLUS
# a small universal delivery-mechanics set into the agent's `.claude/skills` (as real
# copies — see gaffer_skills_mount) — so the agent auto-loads only skills it might
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

# Root under which per-agent mount MANIFESTS live (one link per installed skill name,
# read by the telemetry; the agent reads its copies in its own worktree, never these).
# Factory state (never the target repo), so leaving one in place between ticks is
# harmless; each build rebuilds its keyed dir in place (idempotent).
_gaffer_skills_mount_root() { printf '%s/skills-mounts' "${GAFFER_DATA:-}"; }

# Sanitise a mount key to a single safe path component.
_gaffer_skills_mount_key() {
  local key
  key="$(printf '%s' "${1:-}" | tr -c 'A-Za-z0-9._-' '-')"
  printf '%s' "${key:-mount}"
}

# Markers that make Gaffer's installed skills recognisable (and removable) without
# ever touching a skill the repo owns: each installed copy carries $_GSM_COPY_MARK
# (holding its mount key), and a `.claude/skills` dir Gaffer itself created carries
# $_GSM_ROOT_MARK. Dotfiles: Claude Code reads only `<name>/SKILL.md` and its files,
# `ls` (and the telemetry's mountedNames) skip them.
_GSM_COPY_MARK=".gaffer-mount"
_GSM_ROOT_MARK=".gaffer-skills-root"

# Remove every Gaffer-installed skill copy from <skills_dir> (only dirs carrying the
# copy marker; a repo's own skill never does) and, when Gaffer created the dir, the
# dir itself once empty.
_gsm_remove_copies() {
  local skills="$1" d
  [ -d "$skills" ] && [ ! -L "$skills" ] || return 0
  for d in "$skills"/*; do
    [ -d "$d" ] && [ ! -L "$d" ] && [ -f "$d/$_GSM_COPY_MARK" ] || continue
    rm -rf "${d:?}" 2>/dev/null || true
  done
  if [ -f "$skills/$_GSM_ROOT_MARK" ]; then
    rm -f "$skills/$_GSM_ROOT_MARK" 2>/dev/null || true
    rmdir "$skills" 2>/dev/null || true             # no-op while anything else is in it
  fi
  return 0
}

# Is <link> a symlink Gaffer installed (pre-copy mounts / the whole-library link)?
_gsm_is_our_link() {
  local link="$1" target root
  [ -L "$link" ] || return 1
  target="$(readlink "$link" 2>/dev/null || true)"   # resolves even when dangling
  [ -n "$target" ] || return 1
  # Each prefix is guarded on its base var being non-empty so an unset var can never
  # degrade into a match-everything glob (e.g. an empty SKILLS_DIR must not become "/*").
  if [ -n "${GAFFER_DATA:-}" ]; then
    root="$(_gaffer_skills_mount_root)"
    case "$target" in "$root"|"$root"/*) return 0 ;; esac
  fi
  if [ -n "${SKILLS_DIR:-}" ]; then
    case "$target" in "$SKILLS_DIR"|"$SKILLS_DIR"/*) return 0 ;; esac
  fi
  return 1
}

# gaffer_skills_mount <dest_dir> <selected> <mount_key>
#   Installs (selected ∪ universal) skills that exist in the library into
#   <dest_dir>/.claude/skills/<name>/ as REAL COPIES, and records the installed names
#   in a per-agent mount manifest at $GAFFER_DATA/skills-mounts/<mount_key> (one link
#   per name, read by the skill telemetry). <selected> is a comma/space/newline-separated
#   list of skill DIRECTORY names (e.g. the output of select-skills.mjs). Rebuilt in
#   place on each call (idempotent: the previous install's copies are removed first).
#
#   WHY COPIES, not a symlink into the library: the safety hook canonicalises a Read
#   and refuses one that resolves outside the agent's roots. A `.claude/skills` symlink
#   resolved into runner/skills, so the agent's explicit Read of a skill Gaffer chose
#   for it was REFUSED (seen in review: the Java pack was mounted, the read blocked).
#   A copy resolves inside the agent's own worktree, so the hook needs no exception and
#   reads stay exactly as narrow as before. The worktree's git exclude (`.claude/`)
#   keeps the copies off every delivery branch.
#
#   FAIL-SOFT: an empty resulting set installs the WHOLE library (copies) instead, so
#   the optimisation can never leave an agent with no skills.
gaffer_skills_mount() {
  local dest="$1" selected="${2:-}" mount_key="${3:-mount}"
  local claude_dir="$dest/.claude"
  local skills="$claude_dir/skills"
  mkdir -p "$claude_dir" 2>/dev/null || true
  [ -d "${SKILLS_DIR:-}" ] || return 0

  local key mount=""
  key="$(_gaffer_skills_mount_key "$mount_key")"
  if [ -n "${GAFFER_DATA:-}" ]; then
    mount="$(_gaffer_skills_mount_root)/$key"
    rm -rf "$mount" 2>/dev/null || true
    mkdir -p "$mount" 2>/dev/null || mount=""
  fi

  # Union the selected list (comma/newline -> space) with the universal set; keep each
  # name that resolves to a real SKILL.md in the library. Duplicates are skipped.
  local names name list="" count=0
  names="$(printf '%s %s' "$(printf '%s' "$selected" | tr ',\n' '  ')" "$GAFFER_UNIVERSAL_SKILLS")"
  for name in $names; do
    [ -n "$name" ] || continue
    case " $list " in *" $name "*) continue ;; esac
    if [ -d "$SKILLS_DIR/$name" ] && [ -f "$SKILLS_DIR/$name/SKILL.md" ]; then
      list="$list $name"; count=$((count + 1))
    fi
  done
  # Never mount an empty set — fall back to the whole library instead.
  if [ "$count" -eq 0 ]; then
    for name in "$SKILLS_DIR"/*/; do
      name="$(basename "$name")"
      [ -f "$SKILLS_DIR/$name/SKILL.md" ] && list="$list $name"
    done
  fi

  # Prepare the target dir. A Gaffer-made symlink (an older mount) is replaced; a dir
  # Gaffer made earlier loses its previous copies.
  if _gsm_is_our_link "$skills"; then rm -f "$skills" 2>/dev/null || true; fi
  _gsm_remove_copies "$skills"
  if [ -d "$skills" ] && [ ! -L "$skills" ]; then
    # The repo's OWN .claude/skills dir: link the manifest inside it (legacy layout).
    [ -n "$mount" ] || return 0
    for name in $list; do ln -sfn "$SKILLS_DIR/$name" "$mount/$name" 2>/dev/null || true; done
    ln -sfn "$mount" "$skills"
    return 0
  fi
  [ -e "$skills" ] || [ -L "$skills" ] || { mkdir -p "$skills" 2>/dev/null && : > "$skills/$_GSM_ROOT_MARK"; } || return 0

  for name in $list; do
    [ -e "$skills/$name" ] || [ -L "$skills/$name" ] && continue   # never overwrite what is there
    cp -RL "$SKILLS_DIR/$name" "$skills/$name" 2>/dev/null || { rm -rf "${skills:?}/$name" 2>/dev/null; continue; }
    printf '%s\n' "$key" > "$skills/$name/$_GSM_COPY_MARK" 2>/dev/null || true
    [ -n "$mount" ] && ln -sfn "$SKILLS_DIR/$name" "$mount/$name" 2>/dev/null
  done
  return 0
}

# gaffer_skills_unmount <dest_dir> — remove what gaffer_skills_mount installed into
# <dest_dir>: the Gaffer skill copies under `.claude/skills` (or, for an older mount,
# the `.claude/skills` symlink), the factory `.claude/settings.json` written beside
# them, and `.claude/` itself once empty.
#
# WHY: a normal delivery mounts into a THROWAWAY git worktree that the runner later
# `rm -rf`s wholesale. A GREENFIELD bootstrap, however, runs the agent DIRECTLY in the
# new repo dir, which is NOT a throwaway worktree and is never `rm -rf`d, so the
# factory's residue would stay in the real repo (an older symlink mount was left
# DANGLING there, which the post-teardown hygiene gate gaffer_assert_repo_clean
# correctly flags as "broken symlink in real repo").
#
# SAFETY: only ever removes the factory's OWN artifacts — a skill dir carrying the copy
# marker, or a `.claude/skills` SYMLINK pointing into the factory skills-mount root or
# at the skill library. A skill or file the repo (or the agent) created is never
# touched; `.claude/` is `rmdir`'d ONLY if empty.
gaffer_skills_unmount() {
  local dest="${1:-}" claude link ours=0
  [ -n "$dest" ] || return 0
  claude="$dest/.claude"
  link="$claude/skills"
  if _gsm_is_our_link "$link"; then
    rm -f "$link" 2>/dev/null || true
    ours=1
  elif [ -d "$link" ] && [ ! -L "$link" ]; then
    local d
    for d in "$link"/*; do [ -f "$d/$_GSM_COPY_MARK" ] && ours=1 && break; done
    [ -f "$link/$_GSM_ROOT_MARK" ] && ours=1
    _gsm_remove_copies "$link"
  fi
  [ "$ours" = 1 ] || return 0
  rm -f "$claude/settings.json" 2>/dev/null || true
  rmdir "$claude" 2>/dev/null || true              # no-op (fails safely) if not empty
  return 0
}

# gaffer_skills_mount_cleanup <mount_key> [<dest_dir>] — remove a per-agent mount
# manifest. Guarded to the skills-mounts root so it can never rm anything outside
# factory state. When <dest_dir> is given (a PERSISTENT target, i.e. a bootstrap repo
# that is not a throwaway worktree), also remove the skills this mount installed there
# — see gaffer_skills_unmount.
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
