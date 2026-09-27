---
name: debug-failing-ci
description: Use when a ticket is about a red pipeline — a job that fails in CI but passes locally, a build that broke on the default branch, a flaky or slow workflow — and the fix must be the real cause, not a retry or a skipped step. Invoke for "CI is red", "works on my machine", "the deploy job fails", or before touching a workflow file to make a check pass.
stack: []
area: workflow
---

# Debug a failing CI pipeline

A red pipeline is a measurement of a difference: between your machine and the runner,
between two commits, or between two runs of the same commit. Find the difference, fix
what it reveals, and never make CI green by making it look away.

## Steps

1. **Read the log before forming a theory.** Open the failing job's log and find the
   FIRST error, not the last; later failures are usually consequences. Note the exact
   command, exit code, and the step it ran in. Call `search_lore` for known CI gotchas
   in this repo.
2. **Classify the failure.** (a) A test or lint failure: the change is wrong or the test
   is flaky. (b) An environment failure: a missing tool, a version drift, a network or
   permission error, disk or time limits. (c) A workflow failure: wrong syntax, a bad
   matrix, a secret not present on forks. Each has a different fix and a different owner.
3. **Reproduce the runner's conditions.** Same OS (macOS vs Linux matters: BSD vs GNU
   tools), same Node/Python/Java version, a clean checkout (`git clean -xfd` in a
   scratch clone), the same command CI runs, not your local alias. Most "works on my
   machine" failures die here.
4. **Bisect when the cause is not obvious.** If the job passed on an earlier commit,
   `git bisect` between the last green and first red with the failing command; on a
   flake, run the failing test in a loop (`for i in $(seq 20)`) to measure the rate.
5. **Fix the cause.** A real test failure means fix the code (the `fix-bug` skill). A
   flaky test means fix the flake (the `fix-flaky-test` skill), never a retry loop or a
   `skip`. An environment failure means pin the version, install the tool in the
   workflow, or make the script portable (the `shell-scripting` skill). A workflow
   syntax error means fix the YAML and validate it.
6. **Never disable to pass.** Do not remove a step, mark a job `continue-on-error`,
   skip or delete a test, lower a coverage threshold, or add a blanket retry to make
   the badge green. If a check is genuinely wrong for the repo, raise it via
   `request_decision` with the evidence.
7. **Prove it in CI's terms.** Push to the ticket branch and confirm the previously
   failing job passes; for a flake, show three consecutive green runs or a local loop.
   Evidence the failing log excerpt, the cause in one sentence, and the passing run with
   the `record-evidence` skill (evidence type `ci_run`).
8. **Leave the pipeline better.** If the log was hard to read, add the missing
   diagnostic (print the version, upload the artifact) in the same change when it is
   small; otherwise file it as a finding.

## Rules

- First error first; consequences are not causes.
- Reproduce under the runner's conditions before changing anything.
- Fix causes: code, flake, environment, or workflow. Retries and skips are not fixes.
- Workflow edits are reviewed as code; validate the YAML and keep permissions minimal.
- The proof is a green run of the previously failing job on this change.
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While finding why the runner and your machine disagree you learn the pipeline's hidden dependencies — a version pin, a tool only one OS has, a secret a step needs.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
