---
name: dependency-upgrade
description: Use when a ticket bumps, adds, or removes a dependency — a security advisory, a major-version upgrade, a lockfile refresh, a Dependabot follow-up — and the change must be proven safe with the repo's tests and the upstream changelog, not assumed. Invoke for "upgrade X to v4", "fix the audit finding", "remove the unused package", or any change to a manifest or lockfile.
stack: []
area: workflow
---

# Upgrade a dependency safely

A dependency change imports someone else's decisions into your build. Treat it like a
code change from a stranger: read what changed, run everything that could be affected,
keep the lockfile honest, and never "bump and hope".

**Gaffer constraints — read first.**

- Your delivery prompt forbids installing, updating or removing dependencies in any
  ecosystem; that needs human approval. The safety hook enforces it for
  `npm|pnpm|yarn install|i|add|ci|update|up|upgrade|remove|rm|uninstall` and
  `pip install`. Do not look for a command that dodges the hook (bare `yarn`,
  `bun install`, `uv sync`, `poetry add`, `bundle install`, `go get`, `cargo update`
  are equally off-limits), and never hand-edit a lockfile to fake one.
- In a delivery worktree `node_modules` is a symlink to the main checkout's install.
  Never run `npm ci`, `pnpm install`, `update` or `prune` there: it rewrites or empties
  the shared install and breaks every other worktree.
- Consequence: your tests run against the version that is ALREADY installed, not the
  one in your edited manifest. Check which version actually ran
  (`node -p "require('<pkg>/package.json').version"`, `pip show <pkg>`, `go list -m <mod>`)
  before claiming the new version is tested.

## Steps

1. **Pin down the reason.** A security advisory (which CVE/GHSA, which versions are
   fixed), a feature you need, or hygiene. The reason sets the minimum target and does not
   license unrelated bumps. For an advisory, prefer the smallest version that fixes it.
   Call `search_lore` for pinned versions and known incompatibilities in this repo.
2. **Classify the jump with semver.** Patch and minor promise compatibility; major does
   not; any bump inside `0.y.z` may break. Treat a transitive major change, a raised
   `engines`/runtime floor, or a changed peer-dependency range as a major.
3. **Read the upstream changelog, release notes and migration guide** between the
   current and target versions. List every breaking change, deprecation and behaviour
   change, then `grep` the repo for the imports and APIs each one names. An empty grep
   is evidence too; record it. A major bump with no notes read is a guess.
4. **For a NEW package, vet it before adding it:** exact name (typosquats differ by one
   character), maintainer and release activity, licence against the repo's policy,
   whether it runs install scripts, and whether the standard library or an existing
   dependency already covers the need (the `minimalism` skill). New dependencies need a
   human decision in this factory: `request_decision` with the justification.
5. **Do not run the package manager yourself.** The manifest and lockfile must be
   produced by the owning tool (e.g. `pnpm up <pkg>@<ver> --ignore-scripts`,
   `go get <mod>@<ver>`, `cargo update -p <crate> --precise <ver>`), and that is a
   human's step here. Unless the target version is already installed and locked on the
   branch, stop (see "Stop and escalate") with the exact command a human should run.
   Scope stays at one package plus the transitive changes it forces; a lockfile diff of
   thousands of lines hides the one that matters.
6. **Adapt the code minimally** to the breaking changes you listed. If the upgrade
   forces a refactor larger than the ticket implies, stop and `request_decision` with the
   size and the option of an interim minor/patch bump.
7. **Verify at the edges.** With the target version actually installed, run build,
   typecheck, lint, the full test suite and any integration or browser suite the repo
   has — dependency changes break at the boundaries. Then run the ecosystem audit
   (`pnpm audit`, `npm audit`, `pip-audit`, `cargo audit`, `govulncheck`) and confirm the
   advisory is gone and no new high-severity finding appeared.
8. **Evidence** via the `record-evidence` skill: the version pair, the changelog items
   you handled (and the empty greps), the verification output with the installed version
   shown, the audit result, and any transitive major change. On a resume that call is
   refused: do not retry; put this, the AC → test map and the smallest-change note in
   your final message.

## Done when

The manifest and lockfile were produced by the package manager, the version under test
is the target version, the full verification and audit pass, and every breaking change
in the notes is either handled or shown not to apply. Otherwise you are not done: the
ticket is blocked with the exact command and your changelog analysis.

## Stop and escalate when

- The lockfile cannot be regenerated because installs are off-limits to you:
  `mark_ticket_blocked` with the exact command (e.g.
  `pnpm up <pkg>@<ver> --ignore-scripts`) and the changelog analysis you already did, so
  the human run is one step.
- The tests could only run against the old installed version: say so plainly; never
  report them as proof of the upgrade.
- The upgrade needs a fork, a patch-package, or a vendored copy: that is a decision.

## Rules

- Lockfiles are generated, never hand-edited; one package manager, at CI's version.
- One package per ticket unless the ticket is a refresh; no drive-by bumps.
- `.npmrc` and other credential files are blocked by the hook; registry and auth
  changes are a human's job.
- Work on the delivery branch (the `create-branch` skill verifies); commit, never push.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While bumping a package you learn which pins must not move, which packages break each other, and which manager version CI insists on.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
