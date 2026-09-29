---
name: changelog-generator
description: Use when producing release notes from Conventional Commits, computing the next semantic version from a commit stream, generating CHANGELOG.md, or automating release notes in CI. Triggers on "generate the changelog", "what version bump do these commits require", "release notes", "CHANGELOG", or "semantic version".
stack: []
area: docs
---

# Generate consistent, auditable release notes

A changelog is for humans deciding whether and how to upgrade — "don't let your friends
dump git logs into changelogs" (Keep a Changelog 1.1.0). Commits are the input; the output
is a curated list of user-visible changes plus a version number that follows Semantic
Versioning 2.0.0.

## Rules of the formats

**Conventional Commits 1.0.0 → SemVer bump** (take the highest in the range):

| Signal | Bump |
|---|---|
| `!` before the colon (`feat(api)!:`) or a `BREAKING CHANGE:` / `BREAKING-CHANGE:` footer (uppercase) | MAJOR |
| `feat:` | MINOR |
| `fix:` | PATCH |
| any other type (`docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, …) | none by the spec; many tools treat `perf` as PATCH — follow the repo's config |

Types are case-insensitive except `BREAKING CHANGE`. While the version is `0.y.z`,
SemVer allows anything to change; most repos bump MINOR for breaking changes in 0.x —
follow the repo's history or release config.

**Keep a Changelog 1.1.0:** newest version first; an `## [Unreleased]` section at the
top; each release `## [1.4.0] - 2026-06-28` (ISO 8601 date); only the sections that have
entries, from `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`; comparison
links at the bottom (`[1.4.0]: https://.../compare/v1.3.0...v1.4.0`); a pulled release is
marked `## [1.3.1] - 2026-05-02 [YANKED]`.

## Procedure

1. **Find the convention.** Read the existing `CHANGELOG.md`, release config
   (`.releaserc`, `release-please-config.json`, `cliff.toml`, `.changeset/`) and
   `docs/RELEASING.md` or equivalent; `search_lore` for release conventions. Match the
   existing heading, date and link style exactly. If a release tool owns the file, change
   its input (config, changeset) rather than hand-editing its output.
2. **Get the range.** Last release tag to `HEAD`:
   `git describe --tags --abbrev=0` then
   `git log --no-merges --format='%H%x1f%s%x1f%b%x1e' <tag>..HEAD`. Include bodies —
   breaking-change footers live there.
3. **Classify each commit.** Parse type, scope, `!` and footers. If commits are not
   Conventional (Gaffer's own are `deliver #N: …`), classify from the diff and the linked
   ticket instead of rejecting them — never rewrite history to fix messages. Drop a commit
   and its `revert:` when both are in the range. Drop pure internal changes (tests, CI,
   refactors with no behaviour change) from the notes.
4. **Write entries for users.** One line per user-visible change, in the imperative or
   past tense consistently, naming the feature/endpoint/flag, with the PR or issue
   reference the repo uses. Map: new capability → Added; changed behaviour → Changed;
   scheduled removal → Deprecated; removed → Removed; bug fix → Fixed; vulnerability fix →
   Security. Prefix breaking entries with **BREAKING:** and include the migration step.
5. **Place the entry.** Unreleased work goes under `## [Unreleased]`. Only when the ticket
   asks to cut a release: move those entries under the new version heading with today's
   date, add the compare link, and state the computed version. You never create or push
   tags — the release pipeline does.
6. **Verify** (below) and evidence the acceptance criteria with the `record-evidence`
   skill (`diff_summary` for the changelog diff, plus the classification table as proof of
   the bump), then stop.

## Verification

- Recount: every user-visible commit in the range appears exactly once; no internal-only
  commit leaked in. Show the commit → section table in evidence.
- The computed bump matches the highest signal; a single breaking footer forces MAJOR
  (or the repo's 0.x rule).
- Headings, date format and link references match the existing file; every
  `[x.y.z]` heading has a link definition. Run `npx --no -- prettier --check CHANGELOG.md` or the
  repo's markdown lint if configured.

## Review checklist (concrete defects only)

- A breaking change (by `!`, footer, or removed/renamed public API in the diff) without a
  MAJOR bump or without a migration note.
- An entry that does not correspond to any change in the range, or a user-visible change
  missing.
- Released entries edited retroactively instead of added under Unreleased.
- Raw commit subjects pasted as entries (hashes, `chore:` noise, ticket-internal wording).
- Wrong date format, missing compare link, or empty sections left in.

## Capture lore

The repo's release tool, tag format and 0.x bump rule are reusable facts: call
`suggest_lore` with `tags: [release, changelog, versioning]` when you learn them.
