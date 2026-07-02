# Gaffer delivery-hygiene assertions (sourced by factory.config.sh).
# shellcheck shell=bash
#
# HARD-FAIL guard against the leaks a large unattended factory run actually
# produced. These are the failures this module exists to catch:
#   • a copied source tree appeared in a repo root: `src.ticket9/`
#   • a crew events log leaked into a repo: `.crew/events.jsonl`
#   • a delivery branch committed self-referential symlinks (node_modules -> itself,
#     .claude/skills) that broke the test runner
#   • node_modules got deleted during a manual salvage
#
# The runner asserts a delivery is HYGIENIC on the branch diff BEFORE submitting
# it for review (gaffer_assert_clean_delivery), and asserts the REAL main checkout
# is clean of unmanaged artifacts AFTER worktree teardown (gaffer_assert_repo_clean).
# A violation is reported on stdout (one `reason` per line) and signalled by a
# non-zero return so the caller can PARK the ticket and FAIL the tick.
#
# Both functions are pure observers: they NEVER mutate a repo (no checkout, no
# clean, no rm). Detect-and-report only — remediation is the caller's policy.

# Whitespace-split the configured forbidden-path fragments into an array. Each is
# a substring/suffix tested against an added/deleted diff path. Empty config →
# the built-in defaults so the guard is never silently disabled by an unset var.
# FINDING 11: the fragment is `mcp-runtime.` (trailing dot), NOT the bare
# `mcp-runtime` substring — the artifacts this rule protects against are the
# generated `mcp-runtime.json` / `mcp-runtime.<pid>.json` runtime configs, and a
# bare-substring match hard-rejected a legit delivered source dir such as
# `src/mcp-runtime/index.ts`. Keep in sync with factory.config.sh's default.
_hygiene_forbidden_fragments() {
  local raw="${HYGIENE_FORBIDDEN_PATHS:-node_modules .crew/ *.events.jsonl .claude/ CLAUDE.factory.md .mcp.json mcp-runtime.}"
  printf '%s\n' $raw
}

# Keep factory RUNTIME config out of any delivery. tick.sh writes .claude/settings,
# .claude/skills, CLAUDE.factory.md and the mcp runtime into the worktree; none of
# them belong on a delivery branch. Add them to the worktree's git exclude so a
# `git add -A` can't even stage them (the forbidden-paths gate above is the
# hard-fail backstop). Idempotent; best-effort — never fatal.
#   gaffer_exclude_runner_config <worktree-dir>
gaffer_exclude_runner_config() {
  local dir="$1" excl entry
  ( cd "$dir" 2>/dev/null || exit 0
    excl="$(git rev-parse --git-path info/exclude 2>/dev/null)" || exit 0
    [ -n "$excl" ] || exit 0
    # Append EACH entry independently + idempotently. A previous early-exit keyed on
    # `node_modules` already being present meant a repo that excluded node_modules
    # for its own reasons never got .claude/, CLAUDE.factory.md, .mcp.json, etc. —
    # so check every entry on its own and add only the missing ones (no dupes).
    [ -f "$excl" ] || : > "$excl" 2>/dev/null || exit 0
    grep -qsxF '# gaffer non-deliverables — never commit (added by gaffer_exclude_runner_config)' "$excl" 2>/dev/null \
      || printf '%s\n' '# gaffer non-deliverables — never commit (added by gaffer_exclude_runner_config)' >> "$excl" 2>/dev/null
    for entry in '.claude/' 'CLAUDE.factory.md' '.mcp.json' 'mcp-runtime*.json' \
                 'node_modules' 'dist/' 'build/' '.next/' 'coverage/' '.turbo/'; do
      grep -qsxF "$entry" "$excl" 2>/dev/null || printf '%s\n' "$entry" >> "$excl" 2>/dev/null
    done
  ) 2>/dev/null || true
}

# Does a single diff path match a forbidden fragment? A fragment beginning with
# `*` is a suffix glob (`*.events.jsonl`); otherwise it matches as a path segment
# or substring (`node_modules`, `.crew/`).
_hygiene_path_forbidden() {
  local path="$1" frag
  while IFS= read -r frag; do
    [ -n "$frag" ] || continue
    case "$frag" in
      '*'*) case "$path" in ${frag}) return 0 ;; esac ;;          # suffix glob
      *)    case "$path" in *"$frag"*) return 0 ;; esac ;;        # substring / segment
    esac
  done < <(_hygiene_forbidden_fragments)
  return 1
}

# Detect a COPIED SOURCE TREE: a NEW top-level directory (not pre-existing on the
# base) that duplicates the repo's `src/` — i.e. a sibling whose name carries the
# `src` stem (src.ticket9, src-copy, src_backup, srcOld, copy-of-src, …). We flag
# when the diff ADDS files under such a top-level dir AND the repo already has a
# real top-level `src/` to have been copied from. Reported once per offending dir.
_hygiene_copied_src_dirs() {
  local worktree="$1" base="$2"
  # Only meaningful if the repo actually has a src/ tree to duplicate.
  git -C "$worktree" cat-file -e "$base:src" 2>/dev/null || return 0
  git -C "$worktree" diff --name-only --diff-filter=A "$base"...HEAD 2>/dev/null \
    | awk -F/ 'NF>1 {print $1}' \
    | sort -u \
    | while IFS= read -r top; do
        [ -n "$top" ] || continue
        [ "$top" = "src" ] && continue                    # the legitimate src/ itself
        # Name carries the `src` stem but is not exactly `src`.
        case "$top" in
          src.*|src-*|src_*|*-src|*_src|*src-copy*|*copy*src*|srcOld|srcold|src[0-9]*)
            # And `src/` itself was NOT renamed away (a rename is not a leaked copy).
            if git -C "$worktree" cat-file -e "HEAD:src" 2>/dev/null; then
              printf 'copied source tree added at top-level dir: %s/ (duplicates src/)\n' "$top"
            fi
            ;;
        esac
      done
}

# Detect BROKEN / DANGLING symlinks committed onto the branch, AND self-referential
# symlinks (a link that resolves into its own ancestor chain — the node_modules ->
# itself / .claude/skills class that broke the test runner). Walks the symlinks the
# diff ADDED so the check is scoped to this delivery, then inspects them in the
# worktree (where they are checked out).
_hygiene_bad_symlinks() {
  local worktree="$1" base="$2" rel abs target
  # Added paths that are symlinks in the committed tree (mode 120000).
  git -C "$worktree" diff --diff-filter=A --name-only "$base"...HEAD 2>/dev/null \
    | while IFS= read -r rel; do
        [ -n "$rel" ] || continue
        abs="$worktree/$rel"
        [ -L "$abs" ] || continue                        # only symlinks
        target="$(readlink "$abs" 2>/dev/null || true)"
        # Dangling: the link target does not resolve to an existing path.
        if [ ! -e "$abs" ]; then
          printf 'broken/dangling symlink committed: %s -> %s\n' "$rel" "${target:-?}"
          continue
        fi
        # Self-referential: the link (or its target) points at an ancestor of
        # itself, e.g. node_modules -> . or .claude/skills -> the repo root. We
        # canonicalise both and flag when one contains the other.
        local link_real tgt_real
        link_real="$(cd "$(dirname "$abs")" 2>/dev/null && pwd -P)/$(basename "$abs")"
        tgt_real="$(cd "$abs" 2>/dev/null && pwd -P || true)"
        if [ -n "$tgt_real" ]; then
          case "$link_real" in
            "$tgt_real"/*) printf 'self-referential symlink committed: %s -> %s (target is its own ancestor)\n' "$rel" "$target" ;;
          esac
          [ "$tgt_real" = "$(dirname "$link_real")" ] && \
            printf 'self-referential symlink committed: %s -> %s (links to its own parent)\n' "$rel" "$target"
        fi
      done
}

# ── Public: assert a delivery's branch diff is hygienic ──────────────────────
#   gaffer_assert_clean_delivery <worktree-path> <base-branch>
#     • Inspects the branch diff (base...HEAD) for forbidden ADDED *or* DELETED
#       paths (node_modules added OR deleted, leaked events logs, .crew/),
#       copied source trees, and broken/self-referential symlinks.
#     • Prints one human-readable reason per violation to stdout.
#     • Returns 0 when hygienic, 1 when ANY violation was found.
#   Pure observer: never mutates the worktree or the real repo.
gaffer_assert_clean_delivery() {
  local worktree="$1" base="${2:-main}"
  [ -n "$worktree" ] || { echo "hygiene: no worktree path given"; return 1; }
  git -C "$worktree" rev-parse --git-dir >/dev/null 2>&1 || { echo "hygiene: $worktree is not a git repo"; return 1; }

  local violations=""
  # Forbidden paths — match on ADD *and* DELETE (a deleted node_modules is the
  # manual-salvage leak; an added one is the copied/symlinked leak).
  local changed path
  changed="$(git -C "$worktree" diff --name-only "$base"...HEAD 2>/dev/null || true)"
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    if _hygiene_path_forbidden "$path"; then
      violations+="forbidden path in delivery diff: $path"$'\n'
    fi
  done <<< "$changed"

  # Copied source tree(s).
  local copied
  copied="$(_hygiene_copied_src_dirs "$worktree" "$base")"
  [ -n "$copied" ] && violations+="$copied"$'\n'

  # Broken / self-referential symlinks.
  local badlinks
  badlinks="$(_hygiene_bad_symlinks "$worktree" "$base")"
  [ -n "$badlinks" ] && violations+="$badlinks"$'\n'

  violations="$(printf '%s' "$violations" | sed '/^$/d')"
  if [ -n "$violations" ]; then
    printf '%s\n' "$violations"
    return 1
  fi
  return 0
}

# ── Public: assert the REAL repo checkout is clean after worktree teardown ────
#   gaffer_assert_repo_clean <real-repo-path>
#     • Asserts `git status --porcelain` is empty (teardown left no tracked or
#       untracked residue), and scans the working tree for unmanaged artifacts
#       the leaks produced: top-level copied src trees, leaked .crew/ /
#       *.events.jsonl logs, and broken symlinks anywhere in the checkout.
#     • Prints one reason per violation; returns 1 if the real repo is dirty.
#   Pure observer: never runs `git clean`, checkout, or rm.
gaffer_assert_repo_clean() {
  local repo="$1"
  [ -n "$repo" ] || { echo "hygiene: no repo path given"; return 1; }
  git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || { echo "hygiene: $repo is not a git repo"; return 1; }

  local violations="" porcelain
  porcelain="$(git -C "$repo" status --porcelain 2>/dev/null || true)"
  if [ -n "$porcelain" ]; then
    violations+="real repo not clean after teardown:"$'\n'"$porcelain"$'\n'
  fi

  # Unmanaged top-level copied-src dirs / leaked logs in the working tree.
  local entry name
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    name="$(basename "$entry")"
    case "$name" in
      src.*|src-*|src_*|srcOld|srcold)
        [ -d "$entry" ] && violations+="unmanaged copied src tree in real repo: $name/"$'\n' ;;
    esac
  done < <(find "$repo" -maxdepth 1 -mindepth 1 2>/dev/null)

  # Leaked crew dir / events logs anywhere in the checkout (excluding .git).
  local leaked
  leaked="$(find "$repo" -name .git -prune -o \
              \( -name '*.events.jsonl' -o -path '*/.crew/*' \) -print 2>/dev/null | head -20)"
  if [ -n "$leaked" ]; then
    while IFS= read -r entry; do
      [ -n "$entry" ] && violations+="leaked events log/dir in real repo: ${entry#$repo/}"$'\n'
    done <<< "$leaked"
  fi

  # Broken symlinks anywhere in the checkout (a dangling link breaks tooling).
  local broken
  broken="$(find "$repo" -name .git -prune -o -type l ! -exec test -e {} \; -print 2>/dev/null | head -20)"
  if [ -n "$broken" ]; then
    while IFS= read -r entry; do
      [ -n "$entry" ] && violations+="broken symlink in real repo: ${entry#$repo/}"$'\n'
    done <<< "$broken"
  fi

  violations="$(printf '%s' "$violations" | sed '/^$/d')"
  if [ -n "$violations" ]; then
    printf '%s\n' "$violations"
    return 1
  fi
  return 0
}
