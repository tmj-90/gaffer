---
name: run-lint
description: Use when a ticket or acceptance criterion requires the linter/formatter to pass, or after editing code to confirm it meets the repo's style and static-analysis rules before submitting for review. Invoke for "lint must pass", "fix the formatting", "no new warnings", or as the last check before you self-review.
stack: []
area: quality
---

# Run lint and format checks

Run the repo's configured lint and format commands, fix what they report inside the
ticket's scope, and evidence a clean run. The linter is the repo's opinion about its own
code; you conform to it, you do not argue with it or switch it off.

## Steps

1. **Find the commands.** Use the context packet's `lint_command` (and format check if
   separate) first. If absent, detect from the manifest: `package.json` scripts
   (`lint`, `format:check`, `typecheck`), `pyproject.toml` / `setup.cfg` (ruff, flake8,
   black, mypy), `go vet` / `golangci-lint`, `mvn verify` / checkstyle, `cargo clippy` /
   `cargo fmt --check`. Prefer the project's script over the raw tool so flags match CI.
2. **Run on the whole target, not just your files.** A lint that passes on one file and
   fails on the tree still fails CI. Capture the exact command and its summary (counts of
   errors and warnings, exit code).
3. **Fix inside scope.** Auto-fix formatting (`--fix`, `prettier --write`, `black`,
   `gofmt`, `cargo fmt`) and hand-fix the rest for files you touched. A pre-existing
   violation in a file you did not touch is noted, not fixed, unless the ticket says
   otherwise; do not widen the diff to satisfy the linter elsewhere.
4. **Never silence to pass.** No new `eslint-disable`, `# noqa`, `//nolint`,
   `@SuppressWarnings`, `#[allow(...)]` or rule downgrades without a one-line
   justification in the code and a mention in your evidence. Changing lint config to
   make the change pass is a scope change: raise it via `request_decision` instead.
5. **Type checks count as lint.** If the repo has a typecheck script, run it too; a
   type error is a lint failure for this skill's purposes.
6. **Re-run until clean**, then evidence: the exact command, its exit code and the
   "0 errors" summary. Record it with the `record-evidence` skill (evidence type
   `test_output` or `static_analysis`) against the AC that requires it.

## Rules

- Use the repo's configured commands and config; never introduce a second linter or a
  personal ruleset.
- Fix the cause of a warning, do not suppress it; a suppression needs a justification.
- Format only what you touched unless the ticket is a formatting ticket.
- Report the true result of a run in this session; never claim "lint passes" from memory.
- Run on a branch (the `create-branch` skill verifies you are on the ticket branch), never
  a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While making the linter pass you learn a rule the repo relies on but never states — a custom rule, a deliberate exception, a directory the linter skips.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
