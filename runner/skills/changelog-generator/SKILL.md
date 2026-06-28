---
name: changelog-generator
description: Use when producing release notes from Conventional Commits, computing the next semantic version from a commit stream, generating CHANGELOG.md, or automating release notes in CI. Triggers on "generate the changelog", "what version bump do these commits require", "release notes", "CHANGELOG", or "semantic version".
stack: []
area: docs
---

# Generate consistent, auditable release notes

Conventional Commits → semantic bump → Keep a Changelog. Three steps, always in order.

## Conventional Commit → Semantic Bump

| Commit type | Bump |
|-------------|------|
| `feat:` | MINOR |
| `fix:`, `perf:`, `refactor:` | PATCH |
| `BREAKING CHANGE:` footer or `!` suffix | MAJOR |
| `docs:`, `chore:`, `ci:`, `test:` | No version bump |

Multiple commits in a release: take the highest-ranking bump. One `feat:` in a release of ten `fix:` commits → MINOR bump.

## Keep a Changelog sections

```markdown
## [1.4.0] — 2026-06-28

### Added
- feat commits

### Changed
- refactor commits; BREAKING CHANGE goes here with migration note

### Deprecated
### Removed
### Fixed
- fix commits
### Security
- security commits
```

Use ISO 8601 dates (`YYYY-MM-DD`). Link version headers to the git tag diff URL.

## Git range commands

```bash
# Commits between two tags
git log v1.3.0..v1.4.0 --pretty=format:'%s'

# Commits since last tag to HEAD
git log $(git describe --tags --abbrev=0)..HEAD --pretty=format:'%s'

# With author and hash (for detailed notes)
git log v1.3.0..v1.4.0 --pretty=format:'%h %an %s'
```

## CI integration pattern

```yaml
# .github/workflows/release.yml (excerpt)
- name: Generate changelog
  run: |
    git log ${{ env.PREV_TAG }}..HEAD --pretty=format:'%s' \
      | python scripts/generate_changelog.py \
          --next-version ${{ env.NEXT_VERSION }} \
          --format markdown >> CHANGELOG.md
```

Block the pipeline if commit messages don't follow Conventional Commits format — a linting step before changelog generation prevents garbage output.

## Commit message linting rules

A valid Conventional Commit: `<type>(<optional scope>): <description>`

Valid types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.

**Reject:** commits with no type prefix; commits with `WIP:` prefix; commits longer than 72 characters in the subject line.

## Steps

1. **Get the commit range.** Tag-to-tag or last-tag-to-HEAD.
2. **Parse commit messages.** Classify each as feat / fix / breaking / no-bump.
3. **Compute semantic bump.** Take the maximum across all commits in the range.
4. **Group into Keep a Changelog sections.** Added / Changed / Fixed / Security.
5. **Write the changelog entry.** Date, version, sections. Link version to git tag diff.
6. **Lint commit messages** before finalising — reject any that don't conform.
7. **Verify.** Check that the computed version matches the expected bump; confirm the changelog entry renders correctly in Markdown preview.

## Review checklist

- **Version bump correct** — MAJOR for breaking; MINOR for feat; PATCH for fix.
- **Breaking changes called out** — with migration note in `Changed` section.
- **Dates in ISO 8601** — `YYYY-MM-DD`.
- **Version header links** — to the git tag diff URL.
- **Commit lint clean** — no malformed commits included in the changelog.
- **No noise sections** — empty sections omitted.

## Rules

- Never version-bump for `docs:`, `chore:`, `ci:`, `test:` commits — these are maintenance, not user-facing changes.
- `BREAKING CHANGE:` in the commit footer is a MAJOR bump regardless of the commit type prefix.
- A changelog entry for an unreleased version should be marked `## [Unreleased]` until the tag is cut.
