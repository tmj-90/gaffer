---
name: add-integration-test
description: Use when a ticket asks for integration or end-to-end coverage across components — an API route hitting a database, a service-to-service call, a multi-step flow, file or database persistence, concurrent writers, crash recovery — rather than a single unit. Invoke for "test the endpoint end to end", "cover the checkout flow", "verify the migration + query together", or any acceptance criterion about persistence, concurrency or failure handling.
stack: []
area: testing
---

# Add an integration test

Integration tests exercise the real wiring a unit test mocks away: the route, the store,
the file system, the second process. In live runs, two builds shipped the same class of
defect past every review — concurrent writers colliding on temp-file names (HTTP 500),
unsynchronised read-modify-write losing updates, and a time-only stale-lock lease that lost
an acknowledged write when the holder was paused. Every one passed a happy-path test. For
any criterion about persistence, concurrency or failure, **the schedule is the test**.

## Procedure

1. **Read the lore and copy the harness.** Call `search_lore` for integration-test
   conventions (how the test DB, containers or temp dirs are provisioned, where these tests
   live, the integration command). Find an existing integration test and reuse its
   bootstrap: test client, setup/teardown, seeding. Do not stand up a new harness.
2. **Map each AC to an observable outcome at the boundary:** HTTP status + body, a row
   read back, a file's contents, an emitted event, an exit code. Name each test after the
   AC it proves. A test that only shows "the endpoint returns 200" does not prove "saves the
   note" — read the note back.
3. **Use real collaborators inside the boundary** (database, file system, queue, your own
   services); fake only true externals you do not own (third-party APIs) at their network
   edge. A narrow integration test covers one integration point; prefer several narrow ones
   to one sprawling journey.
4. **Cover the happy path, then the failure paths the AC implies:** invalid input,
   conflict, not-found, dependency unavailable.
5. **When an AC concerns persistence, concurrency or failure, run the real schedule** —
   real processes, real files in a temp dir, injected faults:
   - _Concurrent writers:_ fire 10–20 real operations at the same resource at once
     (`Promise.all` over real HTTP requests, or N spawned CLI processes) and repeat the
     burst several times — races are probabilistic. Assert: no 5xx or crash; the number of
     acknowledged writes equals what reads back (N increments → N); the store still
     parses; no stray temp or lock files.
   - _Durability:_ write, stop the process (clean, then `SIGKILL`), start a new one on the
     same data, read back. Every acknowledged write survives.
   - _Crash mid-operation:_ kill the process during a write loop; after restart the state
     is the old or new value, never partial.
   - _Paused holder:_ for locks, leases or leader election, `SIGSTOP` the holder past the
     timeout, let another writer take over, `SIGCONT` the first; its late write must be
     rejected (fencing token or version check) and no acknowledged write lost.
   - _Injected faults:_ read-only directory, corrupt or missing data file, closed port for
     a dependency, a transaction that throws halfway. Assert the documented error and an
     uncorrupted store.
6. **Isolate every run.** Fresh database or temp directory per test, free ports (bind to
   port 0), explicit teardown that also kills spawned processes. Poll for readiness with a
   deadline; never a fixed sleep.
7. **Prove the test bites.** Temporarily break the behaviour (skip the lock, write in place
   instead of temp-file-and-rename, drop the fsync or transaction), confirm the test fails,
   restore it and check `git diff`. A concurrency test that passes against the unguarded
   code is not testing concurrency — raise the parallelism or tighten the schedule.
   (An independent tester never edits implementation files and skips this step.)
8. **Run the repo's integration command** (the context packet's; it may differ from the
   unit `test` script) once when the tests are complete and once more after a fix — a race
   test repeats its burst inside the test, not by re-running the command. Then use the `record-evidence` skill: one
   `test_output` row per AC with the command, the summary, and the schedule exercised. The
   runner submits for review, not you. (An independent tester keeps the `black-box-test`
   budget — one run, one more after fixing its own test — and records `manual_note`s.)

## SQLite and file-backed stores

- **Fresh DB per test.** In-memory (`new Database(":memory:")`), foreign keys on, run the
  real migrations — through the repo's own test-DB helper if it has one. Never a
  module-level singleton shared across tests.
- **On-disk when the AC is about disk** (WAL, paths, durability, multi-process access):
  create it under `mkdtempSync(join(tmpdir(), "<area>-"))` in `beforeEach`, remove it in
  `afterEach`. Use the app's own open function so pragmas and migrations match production.
- Two connections or processes on one file is the only way to test `SQLITE_BUSY`,
  busy timeouts and lost updates; one connection serialises everything and proves nothing.

## Done when

- Each AC in scope has a named test asserting its own observable outcome.
- Every persistence/concurrency/failure AC has a test running the real schedule, and that
  test failed against a deliberately broken version.
- The repo's integration command passed in this session, with each concurrency test
  repeating its burst internally.

## Rules

- Mock only genuine externals; never the component under test.
- Match the repo's harness; do not install or stand up a new one.
- No retries, skips or longer sleeps to get green (the `fix-flaky-test` skill).
- Work on the delivery branch the runner prepared (the `create-branch` skill); never a
  protected branch.
