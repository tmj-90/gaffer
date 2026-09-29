---
name: debug-failing-ci
description: Use when a ticket is about a red pipeline — a job that fails in CI but passes locally, a build that broke on the default branch, a flaky or slow workflow — and the fix must be the real cause, not a retry or a skipped step. Invoke for "CI is red", "works on my machine", "the deploy job fails", or before touching a workflow file to make a check pass.
stack: []
area: workflow
---

# Debug a failing CI pipeline

A red pipeline measures a difference: between your machine and the runner, between two
commits, or between two runs of the same commit. Find the difference, fix what it
reveals, and never make CI green by making it look away.

**How this works in Gaffer.** You never push and cannot re-run CI yourself. The runner
pushes your branch and opens a PR only when the operator has enabled that, and only
then can its opt-in CI gate run: a red check sends the delivery back to rework with the
failing check attached as evidence. So your proof is a local reproduction under CI's
exact conditions — fails before, passes after — and any later CI run is the runner's.

## Steps

1. **Get the real failure text.** Read `get_ticket` (the description,
   `last_review_feedback` and `latest_events`) plus any review-feedback block in your
   prompt. Find the FIRST error in the log, not the
   last — later failures are usually consequences. Note the step, the exact command, and
   the exit code. Call `search_lore` for known CI gotchas in this repo. If only a check
   name and URL are available and you cannot open the log (no network or credentials),
   go on to step 3 anyway: the workflow file tells you what CI ran.
2. **Classify before fixing.** Each class has a different fix:
   - **code / test** — the change is wrong, or a test encodes stale behaviour;
   - **flake** — passes and fails on the same commit (order, time, shared state, network);
   - **environment drift** — tool or runtime version, OS (BSD vs GNU `sed`/`date`),
     locale or timezone, a file present locally but ignored or untracked in git;
   - **workflow config** — YAML syntax, matrix, `needs:`, paths filters, a secret that is
     absent on forks;
   - **infrastructure** — runner outage, registry or rate-limit error, disk full. Do not
     change code for this: report it (see "Stop and escalate when").
3. **Reproduce CI's conditions.** Open the workflow (`.github/workflows/*.yml`,
   `.gitlab-ci.yml`, …) and copy the exact commands, the runtime versions (`setup-node`,
   `.nvmrc`, `python-version`), the env vars and the working directory. Run the
   build, test and lint commands, not your local alias. Never run the workflow's install
   or setup steps (`npm ci`, `pnpm install`, `pip install`, `bundle install`, `uv sync`,
   `playwright install`, …): the worktree uses the existing install. If the failure is
   in an install step, reason from the lockfile and escalate. Compare `node --version` (or the ecosystem's
   equivalent) with the pinned version. List what your run depends on that a fresh
   checkout lacks: `git status --porcelain --ignored` shows untracked and ignored files
   (generated code, a local config, a cache). Most "works on my machine" failures die here.
4. **Bisect when the cause is not obvious.** If the job passed on an earlier commit:
   `git bisect start <first-red> <last-green>`, then `git bisect run <failing command>`,
   then `git bisect reset`. For a suspected flake, measure the rate with a loop
   (`for i in {1..20}; do <cmd> || echo FAIL; done`) and run the test alone vs with the
   suite to expose order dependence.
5. **Fix the cause.** A real test failure → fix the code (the `fix-bug` skill). A flake →
   fix the nondeterminism (the `fix-flaky-test` skill). Drift → pin the version, install
   the tool in the workflow, or make the script portable (the `shell-scripting` skill).
   A workflow error → fix the YAML and keep `permissions:` minimal.
6. **Prove it locally.** Show the CI command failing before your fix and passing after;
   for a flake, the loop at 20/20. Record it via the `record-evidence` skill as
   `test_output`: the log excerpt, the cause in one sentence, the passing command and its
   summary. Use `ci_run` only for a real CI run URL you actually observed. On a resume,
   where that call is refused, put this in your final message instead (see
   `record-evidence`).
7. **Leave the pipeline better, briefly.** If the log hid the cause, add the one missing
   diagnostic (print the tool version, upload the test report) when it is small.

## Done when

The cause is named in one sentence, the CI command reproduces the failure without your
fix and passes with it, and nothing was skipped, retried or loosened.

## Stop and escalate when

- The failure needs a secret, a runner type, or a service you cannot reach, or it is
  infrastructure: `request_decision` (`human_required`) with the evidence, and ask the
  human to re-run the job with debug logging (GitHub: "Re-run jobs → Enable debug
  logging", i.e. `ACTIONS_STEP_DEBUG`) if the log is too thin; then
  `mark_ticket_blocked` naming the decision.
- You have neither the log nor a local reproduction after step 3: `request_decision`
  asking for the log excerpt and `mark_ticket_blocked`; do not guess a fix.

## Rules

- Never disable to pass: no removed step, `continue-on-error`, skipped or deleted test,
  lowered coverage threshold, or blanket retry. A check that is genuinely wrong goes to
  `request_decision` with evidence.
- The safety hook blocks `git clean -fdx`, `rm -rf`, `env`/`printenv` and installs; use
  `git status --ignored` and the version commands above instead of fighting it.
- Workflow edits are reviewed as code: validate the YAML; never widen `permissions:` or
  switch to `pull_request_target` to get a secret.
- Work on the delivery branch (the `create-branch` skill verifies); commit, never push.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While finding why the runner and your machine disagree you learn the pipeline's hidden dependencies — a version pin, a tool only one OS has, a secret a step needs.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
