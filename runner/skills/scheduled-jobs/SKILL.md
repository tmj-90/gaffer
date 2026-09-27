---
name: scheduled-jobs
description: Use when a ticket adds or changes time-driven work — a cron, a nightly report, a periodic cleanup, a poll every N minutes, a retention sweep — and the job must run exactly as intended across time zones, deployments, and multiple instances without overlapping or being silently skipped. Invoke for "run X every night", "add a cron", "the cleanup didn't run", or "it ran twice".
stack: [node, python, go, java, rust, csharp, kotlin, ruby]
area: backend
---

# Add a scheduled job

Scheduled work fails quietly: the cron never fires, two instances fire at once, the job
runs in the wrong time zone, or it ran at 02:30 on the night that hour did not exist.
Make the schedule explicit and tested, the run idempotent and mutually exclusive, and
the outcome observable so a missed run is an alert, not a mystery.

## Steps

1. **Use the repo's scheduler.** A cron library, the platform scheduler, a jobs table
   with a `next_run_at`, or the queue's delayed jobs. Call `search_lore` for the
   convention. One scheduler per repo.
2. **Write the schedule in UTC and say so.** Store and evaluate schedules in UTC; if the
   business meaning is local (a "9am report"), convert deliberately with a named time
   zone and a test for the DST transition. Avoid schedules on the hour when the
   platform is busy; jitter by a few minutes where the exact minute does not matter.
3. **Make the run idempotent and catch-up-safe.** A run processes "everything due up to
   now" from a persisted watermark, not "the last interval" from wall-clock arithmetic,
   so a missed tick is recovered by the next one and a double tick does nothing extra.
   Follow the `background-jobs` skill for the handler.
4. **Prevent overlap across instances.** A database lease (`UPDATE … WHERE lease_until <
   now()` returning one row), an advisory lock, or the scheduler's built-in
   single-instance guarantee. Assume there will be more than one process running the
   schedule, because there will be.
5. **Bound the run.** A timeout, a maximum batch size per run, and a rule for what
   happens when the backlog exceeds one run's capacity (loop with a cap, then stop and
   report). A nightly job that takes 25 hours is two jobs overlapping forever.
6. **Record every run.** Start, end, items processed, outcome, next scheduled time —
   in the structured log and in a `job_runs` table or metric the dashboard can show. A
   "last successful run" gauge is the single most useful alert for scheduled work.
7. **Alert on absence.** The failure mode of a cron is not an error, it is silence:
   configure (or document for the operator) an alert when the job has not succeeded
   within its expected interval plus slack.
8. **Test with a controllable clock.** Inject the clock; assert the schedule fires when
   expected, skips correctly across DST, does not overlap under two concurrent
   triggers, and catches up after a missed window. Evidence with the `record-evidence`
   skill.

## Rules

- One scheduler; schedules stored in UTC with an explicit named zone when local.
- Runs are watermark-driven and idempotent; missed ticks are recovered, double ticks
  are harmless.
- Mutual exclusion across instances is explicit, never assumed.
- Every run is bounded and recorded; absence of a run is alertable.
- A controllable clock in tests; no `sleep`-based schedule tests.
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While scheduling you learn the scheduler in use, the lease pattern that stops overlap and any DST incident the repo has lived through.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
