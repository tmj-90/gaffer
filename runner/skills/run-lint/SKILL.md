---
name: run-lint
description: Use when a ticket or acceptance criterion requires the linter/formatter to pass, or after editing code to confirm it meets the repo's style and static-analysis rules before submitting for review. Invoke for "lint must pass", "fix the formatting", "no new warnings", or as the last check before you self-review.
stack: []
area: quality
---

# Run lint and format checks

Run the repo's configured lint, format and type checks, fix what they report inside the
ticket's scope, and evidence a clean run. The linter is the repo's opinion about its own
code: conform to it; do not argue with it or switch it off.

**Why it matters here.** After you stop, the runner runs the repository's
`lint_command` (and a typecheck, when configured) as a Definition-of-Done gate. A red
gate auto-rejects the delivery back to rework, so run the same command yourself first.

## Steps

1. **Find the exact command.** In order: the repository's `lint_command` in the
   `get_ticket` response (this is what the gate runs); the CI workflow's lint step; the
   manifest scripts (`package.json` `lint` / `format:check` / `typecheck`,
   `pyproject.toml` ruff/black/mypy config, `Makefile`); then the ecosystem default
   (`golangci-lint run` / `go vet`, `cargo clippy -- -D warnings` and `cargo fmt --check`,
   `mvn -q verify` with checkstyle/spotless). Prefer the project script over the raw tool
   so flags and config match CI.
2. **Run it once, when the change is complete** — on the whole target the gate runs, not
   only your files. Capture the command, the exit code and the error/warning counts. Do
   not lint after every edit; one run, then one after fixes.
3. **Auto-fix formatting, then hand-fix the rest.** Use the repo's fixer
   (`eslint --fix`, `prettier --write <files>`, `ruff check --fix`, `black`, `gofmt -w`,
   `cargo fmt`) on the files you changed only. Hand-fix what remains in those files.
4. **Separate your violations from pre-existing ones.** Compare the reported files with
   `git diff --name-only <default-branch>...HEAD` plus your uncommitted changes. A
   violation in a file you did not touch is noted, not fixed, unless the ticket says so.
5. **Never silence to pass.** No new `eslint-disable`, `# noqa`, `# type: ignore`,
   `//nolint`, `@SuppressWarnings` or `#[allow(...)]` unless the rule is genuinely wrong
   for that line — then scope it to the single line and rule, add a one-line reason, and
   mention it in your evidence. Editing the lint config, raising a warning threshold or
   adding an ignore path is a scope change: `request_decision`.
6. **Type checks count as lint.** If the repo has a typecheck script, run it too; a type
   error is a lint failure for this skill. Do not "fix" one with `any`, a cast, or a
   non-null assertion that hides a real mismatch.
7. **Re-run until clean**, then evidence via the `record-evidence` skill
   (`static_analysis`, or `test_output`): the exact command, exit code, and the
   "0 errors" summary, against the AC that requires it. On a resume that call is
   refused: do not retry; put this, the AC → test map and the smallest-change note in
   your final message.

## Done when

The same command the gate runs exits 0 in your worktree after your last edit, with no new
suppressions (or each one justified in code and evidence), and only files in your diff
were reformatted.

## Stop and escalate when

- The lint command fails on the default branch too (pre-existing violations in files you
  did not touch): do not widen the diff to fix them. Record the evidence (the command,
  the failing files, none of them yours), `request_decision` (`human_required`) so a
  human can fix the baseline or adjust the gate, and `mark_ticket_blocked`: the gate
  runs the same command and would reject every delivery until the baseline is fixed.
- The lint tool is missing and cannot run without an install: installs are hook-blocked;
  `mark_ticket_blocked` with the command that failed.

## Rules

- Use the repo's configured commands and config; never introduce a second linter or a
  personal ruleset.
- Fix the cause of a warning; a suppression needs a line-scoped justification.
- Format only what you touched unless the ticket is a formatting ticket.
- Report the true result of a run in this session; never claim "lint passes" from memory.
- Work on the delivery branch (the `create-branch` skill verifies); commit, never push.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While making the linter pass you learn a rule the repo relies on but never states — a custom rule, a deliberate exception, a directory the linter skips.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
