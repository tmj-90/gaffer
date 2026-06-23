---
name: run-lint
description: Use when a ticket or acceptance criterion requires the linter/formatter to pass, or after editing code to confirm it meets the repo's style gate. Invoke for "lint must be clean", "fix lint errors", or before submitting changes that touched source files.
stack: []
area: quality
---

# Run the linter

Run the repo's existing lint/format check, fix what it flags, and evidence a clean
run. Respect the project's config files — do not loosen rules to pass.

## Steps

1. **Find the lint command** from the context packet's verification commands (e.g.
   `pnpm lint`, `eslint .`, `ruff check`, `golangci-lint run`, `mvn checkstyle:check`).
   If silent, detect from config (`eslint.config.*`, `.ruff.toml`, `.golangci.yml`).
2. **Run it** and capture the exact command plus the result (clean, or the list of
   violations with file/line).
3. **Fix violations** in the files the ticket touched. Prefer the project's autofix
   (`--fix`) where it exists, then resolve the rest by hand. Do not edit unrelated files.
4. **Do not disable rules or edit config** to silence errors unless the ticket
   explicitly asks for a rule change — fix the code instead.
5. **Re-run until clean.** Evidence the exact command and its clean summary, then use
   the `record-evidence` skill to record `test_output` (or a lint log) against the AC
   and submit for review.

## Rules

- Respect existing lint/format config; never relax rules to force a pass.
- Only touch files in the ticket's scope; don't reformat the whole repo.
- Match the repo's linter; don't add a new one.
- Run on a branch (the `create-branch` skill), never a protected branch.
