#!/usr/bin/env node
// =====================================================================
// lib/tester-replay.mjs: replay the independent tester's tests on the LANDING CANDIDATE.
//
// ACCEPTANCE GATE (external review #4). The tester's PASS is evidence about the commit it
// tested (`tested_commit`), and bin/tester-run.mjs replays it on a clean checkout of THAT
// commit. Its assertions lived only on `gaffer-tests/ticket-<n>`, so nothing ever ran them
// against what actually lands: after the default branch moved, the merge of the tested
// commit onto it passed the repository's own suite (the merge gate) yet failed the
// tester's saved assertion, the ticket landed, and the epic counted as accepted.
//
// Both landing paths (lib/land.sh _gaffer_merge_gate, PR mode's gate on the fetched remote
// default included, and bin/merge-ticket.mjs gateProposedMerge) call this after the repo's
// own DoD gates passed on the scratch merge worktree:
//   1. replayPlan: is a bound tester PASS the reason this ticket lands, and which test
//      files did the tester add or change on gaffer-tests/ticket-<n> relative to the commit
//      its PASS names? (only files the tester ADDED or MODIFIED that are test paths — never
//      its agent wiring, never node_modules: the same rule as tester-run's inspection);
//   2. applyTesterTests: check exactly those files out of the tests branch into the scratch
//      merge worktree (the working tree only: the gated merge COMMIT is what lands, so the
//      tester's files are run, never landed);
//   3. the caller runs the tester's files there through bin/dod-regate.sh (tests only):
//      the EFFECTIVE registered test command, with only the runner's own file selection
//      and proof reporter appended (replayInvocation: the registered command is an
//      execution contract, external review 10), or, where it cannot be extended safely,
//      the registered command as it is; a failure HOLDS the landing exactly like a red
//      merge gate (tester_replay_red);
//   4. replayProof reads the runner's own evidence (external review #7). A PASS that
//      recorded TEST IDENTITIES (external review 10) needs every one of them to execute
//      and pass: a failed one is red, a skipped, todo or missing one holds
//      (tester_replay_unverified, the identities named). An older PASS without
//      identities keeps the file-level rule (a file with no evidence holds), and its
//      record says "files" (file-level evidence only). The record lists only files and
//      identities proven to have run and passed.
// No tester PASS bound to the pinned commit → nothing extra runs and no record is due (the
// ticket was not in the testing lane, or a human waived it). WHICH tests: the commit the
// PASS names (`tests_commit`, recorded by bin/tester-run.mjs: the tester's own commit on the
// tests branch, or "none") — never the branch as it stands at landing time, which any
// process with the repository can rewrite. A bound PASS with no test files still records
// the landing (files: []), and a record with no files never counts an epic as accepted
// (zero tester assertions ran on what landed). Fail CLOSED: an unreadable DB, a git error
// or a bound tests commit git cannot find HOLDS.
//
// CLI (lib/land.sh):
//   node lib/tester-replay.mjs apply --db <dispatch.sqlite> --ticket <n> --repo <path>
//        --pin <sha> --worktree <scratch merge worktree> [--test-cmd <cmd> --base <target>]
//   → one JSON line { ok, run, record, files, tests, evidence, tests_ref, tests_head,
//     tested, reason, invocation? }: exit 0 (decided; files applied and, with --test-cmd,
//     the invocation (carrying the bound identities as `required`) and its proof
//     directory prepared when run) · 4 could not decide / apply (hold).
//   node lib/tester-replay.mjs proof --worktree <wt> --invocation <json | - (stdin)> --files-json <json>
//   → { ran, unproven, tests, failed, skipped, missing, evidence, reason } (exit 0; 4 when
//     there is no invocation to read).
// =====================================================================
import { spawnSync } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { readTesterEvidence } from "./tester-binding.mjs";
import { safeReadFile } from "./safe-write.mjs";

export const TESTS_BRANCH_PREFIX = "gaffer-tests/ticket-";

/** The branch tester-run keeps a ticket's black-box tests on. */
export function testsBranchName(ticketNumber) {
  return `${TESTS_BRANCH_PREFIX}${parseInt(String(ticketNumber).replace(/^#/, ""), 10)}`;
}

/** The tester's own agent wiring (installed by the runner), never its tests. */
export function isAgentWiring(p) {
  return /^(\.claude\/|CLAUDE\.factory\.md$|\.mcp\.json$)/.test(String(p));
}

/** Paths a tester may legitimately create or change: tests and its own installed wiring. */
export function isTestPath(p) {
  const n = String(p).replace(/\\/g, "/").replace(/^\.\//, "");
  if (/^(\.claude\/|CLAUDE\.factory\.md$|\.mcp\.json$)/.test(n)) return true;
  if (/(^|\/)(test|tests|__tests__|spec|specs|e2e|fixtures?)(\/|$)/i.test(n)) return true;
  return /\.(test|spec)\.[cm]?[jt]sx?$/i.test(n) || /(^|\/)test[-_.][^/]*$/i.test(n);
}

/** The tester's TEST files among `paths`: test paths, minus its wiring and node_modules. */
export function testerTestFiles(paths) {
  return [
    ...new Set(
      (paths || [])
        .map((p) => String(p).trim())
        .filter(Boolean)
        .filter((p) => !/(^|\/)node_modules(\/|$)/.test(p))
        .filter((p) => isTestPath(p) && !isAgentWiring(p)),
    ),
  ].sort();
}

function git(cwd, ...args) {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

export function replayEnabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.GAFFER_TESTER_REPLAY ?? "1"));
}

/**
 * The tester's tests on record for `testedCommit`: the files it added or modified on
 * gaffer-tests/ticket-<n> relative to the commit its PASS names. A tests branch that does
 * not descend from that commit describes an EARLIER tester run (the PASS on record made no
 * changes of its own), so it is not this PASS's tests.
 *   → { ok: true, files, ref, head, reason } | { ok: false, reason }
 */
export function testerTestsOnRecord({ repoPath, ticketNumber, testedCommit }) {
  const ref = `refs/heads/${testsBranchName(ticketNumber)}`;
  const h = git(repoPath, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
  const head = (h.stdout || "").trim();
  if (h.error) return { ok: false, reason: `git could not read ${ref} (${h.error.message})` };
  if (h.status !== 0 || !head)
    return { ok: true, files: [], ref, head: "", reason: `no tester tests on record (${ref})` };
  const anc = git(repoPath, "merge-base", "--is-ancestor", testedCommit, head);
  if (anc.status === 1)
    return {
      ok: true,
      files: [],
      ref,
      head,
      reason: `${ref} does not descend from the tested commit ${testedCommit.slice(0, 12)} (an earlier tester run's tests)`,
    };
  if (anc.status !== 0)
    return { ok: false, reason: `git could not relate ${ref} to ${testedCommit.slice(0, 12)}` };
  const d = git(
    repoPath,
    "diff",
    "--name-only",
    "--no-renames",
    "--diff-filter=AM",
    testedCommit,
    head,
  );
  if (d.status !== 0 || d.error)
    return { ok: false, reason: `git could not list the tester's changes on ${ref}` };
  const files = testerTestFiles((d.stdout || "").split("\n"));
  return {
    ok: true,
    files,
    ref,
    head,
    reason: files.length
      ? `${files.length} tester test file(s) on ${ref}`
      : `${ref} adds or changes no test file`,
  };
}

/**
 * The tests a PASS BOUND (its `tests_commit`, recorded by bin/tester-run.mjs): the files the
 * tester added or modified in that exact commit relative to the tested commit. The branch
 * ref is not read, so a later rewrite or deletion of gaffer-tests/ticket-<n> cannot change
 * what is replayed. A bound commit git cannot find, or one that does not descend from the
 * tested commit, cannot be replayed: ok:false (the caller HOLDS).
 *   → { ok: true, files, ref, head, reason } | { ok: false, reason }
 */
export function testerTestsOfCommit({ repoPath, ticketNumber, testedCommit, testsCommit }) {
  const ref = `refs/heads/${testsBranchName(ticketNumber)}`;
  const c = git(repoPath, "cat-file", "-e", `${testsCommit}^{commit}`);
  if (c.error || c.status !== 0)
    return {
      ok: false,
      reason: `the tester's tests commit ${testsCommit.slice(0, 12)} (bound to its PASS) is not in the repository`,
    };
  const anc = git(repoPath, "merge-base", "--is-ancestor", testedCommit, testsCommit);
  if (anc.status !== 0)
    return {
      ok: false,
      reason: `the tester's tests commit ${testsCommit.slice(0, 12)} does not descend from the tested commit ${testedCommit.slice(0, 12)}`,
    };
  const d = git(
    repoPath,
    "diff",
    "--name-only",
    "--no-renames",
    "--diff-filter=AM",
    testedCommit,
    testsCommit,
  );
  if (d.status !== 0 || d.error)
    return {
      ok: false,
      reason: `git could not list the tester's changes in ${testsCommit.slice(0, 12)}`,
    };
  const files = testerTestFiles((d.stdout || "").split("\n"));
  return {
    ok: true,
    files,
    ref,
    head: testsCommit,
    reason: files.length
      ? `${files.length} tester test file(s) in ${testsCommit.slice(0, 12)} (bound to the PASS)`
      : `the tester's tests commit ${testsCommit.slice(0, 12)} adds or changes no test file`,
  };
}

/**
 * Should the landing of `pin` replay the tester's tests, and record that it did?
 *   → { ok, run, record, files, tests, evidence, tests_ref, tests_head, tested, reason }
 * `record` — a bound (agent/system) tester PASS of exactly `pin` is why this lands: the
 * landing records which of its assertions passed on the landed revision. `run` — there are
 * test files to replay. `tests`: the test identities the PASS bound (every one must pass
 * on the candidate), or null for an older PASS without them (`evidence` "files": the
 * file-level rule). ok:false: the DB or git could not answer (the caller HOLDS).
 */
export function replayPlan({ dbPath, ticketNumber, repoPath, pin, env = process.env }) {
  const none = (reason, extra = {}) => ({
    ok: true,
    run: false,
    record: false,
    files: [],
    tests_ref: "",
    tests_head: "",
    tested: "",
    reason,
    ...extra,
  });
  const ev = readTesterEvidence(dbPath, ticketNumber);
  if (ev.error) return { ...none(ev.error), ok: false };
  const pass = ev.pass;
  if (!pass) return none("no tester PASS on record (the ticket was not in the testing lane)");
  if (pass.provenance === "human")
    return none("a HUMAN tester waiver: no tester assertions to replay");
  const tested = typeof pass.tested_commit === "string" ? pass.tested_commit.toLowerCase() : "";
  if (!/^[0-9a-f]{40,64}$/.test(tested))
    return none("the tester PASS is not bound to a tested commit");
  const want = String(pin || "").toLowerCase();
  if (want !== tested)
    return none(
      `the landing pins ${want.slice(0, 12)}, not the tested commit ${tested.slice(0, 12)}`,
    );
  if (!replayEnabled(env))
    return none("GAFFER_TESTER_REPLAY=0: the tester's tests are not replayed (no replay record)", {
      tested,
    });
  // The PASS names the commit holding its tests (tester-run records it): replay exactly
  // those, or nothing when it saved none. An older PASS without the binding falls back to
  // the branch (an earlier run's branch is then not replayed — and a record with no files
  // never counts an epic as accepted: see dispatch's computeAcceptance).
  const bound = typeof pass.tests_commit === "string" ? pass.tests_commit.toLowerCase() : "";
  const t =
    bound === "none"
      ? {
          ok: true,
          files: [],
          ref: `refs/heads/${testsBranchName(ticketNumber)}`,
          head: "",
          reason: "the tester's PASS saved no test files of its own",
        }
      : /^[0-9a-f]{40,64}$/.test(bound)
        ? testerTestsOfCommit({ repoPath, ticketNumber, testedCommit: tested, testsCommit: bound })
        : testerTestsOnRecord({ repoPath, ticketNumber, testedCommit: tested });
  if (!t.ok) return { ...none(t.reason, { tested }), ok: false };
  // TEST IDENTITIES (external review 10): the tests the tester lane's clean replay saw
  // PASS in these files, recorded on the PASS by the runner (system). Every one must run
  // and pass on the candidate. An older PASS without them: null (the file-level rule).
  // A binding that is present but not a list of identities proves nothing: HOLD.
  let tests = null;
  if (pass.tests !== undefined && pass.tests !== null) {
    const list = Array.isArray(pass.tests) ? pass.tests.map(normaliseIdentity) : [null];
    if (list.some((x) => x === null))
      return {
        ...none("the tester's PASS carries test identities that are not a list of tests", {
          tested,
        }),
        ok: false,
      };
    tests = list;
  }
  return {
    ok: true,
    run: t.files.length > 0,
    record: true,
    files: t.files,
    tests,
    evidence: tests ? "identities" : "files",
    tests_ref: t.ref,
    tests_head: t.head,
    tested,
    reason: t.reason,
  };
}

/**
 * Check the tester's test files out of the tests branch into the scratch merge worktree
 * (working tree only — the gated merge commit stays exactly what it was).
 *   → { ok, reason }
 */
export function applyTesterTests({ worktree, testsHead, files }) {
  if (!files.length) return { ok: true, reason: "nothing to apply" };
  const r = git(worktree, "checkout", testsHead, "--", ...files);
  if (r.status !== 0 || r.error)
    return {
      ok: false,
      reason: `could not check the tester's tests out of ${testsHead.slice(0, 12)} (${(r.stderr || r.error?.message || "").trim().slice(0, 200)})`,
    };
  // Unstage: the merge worktree's index must keep describing the gated merge commit.
  git(worktree, "reset", "--quiet", "--", ...files);
  return { ok: true, reason: `applied ${files.length} tester test file(s)` };
}

// ── PROOF OF EXECUTION (external review #7) ──────────────────────────────────────────
// Running the repo's registered test command proved nothing about the tester's files: a
// file-scoped command (`node --test test/label.test.mjs`) never executed the tester's
// test/acceptance.test.mjs, the run passed, the landing recorded that file as passed and
// the epic counted as accepted while the assertion failed on what landed. So the replay
// passes the tester's files to the stack's runner EXPLICITLY, and in every case reads
// POSITIVE evidence from the runner itself (a node:test reporter's events, a vitest/jest
// JSON report, pytest's per-test node ids, `go test -json` events and `go list`'s test
// files, cargo's "Running tests/<name>.rs" and `test <path> ... ok` lines).
//
// THE REGISTERED COMMAND IS AN EXECUTION CONTRACT (external review 10). The replay used to
// rebuild a generic command from the detected runner (`npx vitest run <files>`, `pytest -vv
// <files>`, `go test <dirs>`, `cargo test --test <name>`, `node --test <files>`), and so
// dropped what the registered command says about HOW the suite runs: leading env
// assignments (`PROFILE_API_V2=1 node --test`), config files (`vitest -c ci.mjs`, `jest
// --config`, `pytest -c`), markers (`pytest -m`), build tags (`go test -tags`), features and
// toolchains (`cargo +nightly test --features x`). A tester assertion those enable then
// SKIPPED in the replay, a smoke test in the same file passed, and the file counted as run.
// Now replayInvocation runs the EFFECTIVE registered command (a package `test` script as
// the gated base has it, with the worktree's node_modules/.bin on PATH as the package
// manager would put it) and only APPENDS the runner's own file selection and the proof
// reporter (go: the package arguments are replaced by the tester's packages; cargo: the
// `--test <name>` targets go before a bare `--`). The string still runs through `bash -c`
// in bin/dod-regate.sh, so every assignment, flag and option is untouched. Where the
// command cannot be extended safely (a pipeline, `||`, `&`, a runner that is not the LAST
// command of an `&&`/`;` chain, two runners, a subshell or substitution, a runner hidden
// in a word the scanner cannot see into such as `bash -c "vitest run"`) it runs as
// registered with the signed node:test reporter in NODE_OPTIONS; where that gives no
// evidence the tester's tests are unproven and the landing HOLDS (never a green).
//
// TEST IDENTITIES (external review 10). A file used to count as run when any one ordinary
// assertion in it passed or failed, so a required assertion that was skipped, todo, pending
// or gone left its file "proven". The tester lane's clean replay (bin/tester-run.mjs) now
// records the identities that PASSED in the tester's files on the PASS itself (dispatch's
// tester_pass `tests`, system only): node:test file + full name (suites joined by " > ") +
// line:column, vitest / jest file + ancestor titles + title, pytest file + node id, go file
// + Test name (from `go test -json`, attributed to the tester file that declares the
// top-level test), cargo integration target + test path. The landing replay requires EVERY
// recorded identity to execute and PASS on the merge candidate: one that failed is red,
// one skipped, todo, pending, xfail, ignored or missing holds (tester_replay_unverified,
// the identities named); an extra test never stands in for a missing one. An older PASS
// without identities keeps the file-level rule, and its record says "files" (file-level
// evidence only), never an identity-level green.
// CONTAINMENT (external review 11): the tester lane's clean replay (bin/tester-run.mjs)
// runs the tester's files through the gate sandbox seam (the `replay` profile: the
// validation profile plus read denials for $GAFFER_DATA outside the checkout and for
// HOME's secret folders under sandbox-exec, the validation layout under docker), in the
// stripped profile environment (no model credential, no GAFFER_DATA or DISPATCH_DB, `wg`
// and `gaffer` shadowed on PATH, a scratch HOME and TMPDIR); a sandbox that strict mode
// asks for and the host cannot supply HOLDS the replay, it never runs unsandboxed.
//
// FORGERY (external review #7, the reviewer's follow-up). The code under test runs in the
// same process tree as the runner, so anything it can print or write is no proof: a
// delivery whose module exits before the tester's tests register, then prints "✔ …" lines
// or appends reporter-shaped events to a proof file in the worktree, used to be counted as
// "ran". So:
//   • node:test events are SIGNED with a per-replay key that never sits in any process's
//     environment (external review 11). prepareReplayProof writes it to a mode 0600 file
//     with a random name inside a mode 0300 directory (no listing) in the proof directory;
//     only the file's PATH travels, in GAFFER_REPLAY_PROOF_KEY_FILE. The reporter (loaded
//     by the runner's parent process before any test file starts) deletes that variable,
//     reads the file and UNLINKS it at load; when the unlink fails it signs nothing. So by
//     the time a test file runs the key is in no environment (/proc/<pid>/environ of every
//     ancestor shows the path only), on no command line and in no file. replayProof
//     removes a file a reporter never consumed. Each event line carries an HMAC of its
//     JSON, a per-process sequence number and a closing count. A line with a bad MAC, a
//     gap, a duplicate or a missing end makes the whole replay unverified. The proof step
//     gets the key on stdin, never on a command line. One run consumes the key: a second
//     node:test run in the same registered command signs nothing, so its files stay
//     unproven (held, the reason says why). A pooled flaky rerun of the landing's tests
//     gate gets a FRESH key file: land.sh and merge-ticket.mjs hand the key to
//     bin/dod-regate.sh on stdin and lib/dod.sh _gaffer_dod_replay_key_file writes it just
//     before the rerun. The file modes keep other users out; they do not stop code running
//     as the runner's user (it can chmod the directory), so what protects the key is that
//     the file is gone before any test runs.
//     REGISTERED MODE still issues a key for a runner it cannot identify (`sh
//     scripts/test.sh` running node --test): that wrapper comes from the TESTED COMMIT,
//     never from the tester's files, and a delivery agent's change to a script is already
//     a flagged vector the reviewer sees; code it runs before node loads the reporter can
//     read the key file, as it could read the variable before, and if the wrapper runs a
//     runner that is not node:test, no reporter consumes the key and that runner's tests
//     can read it for the whole run (SECURITY.md says so). A go or cargo command the
//     replay cannot scope gets no key (`registered(..., { key: false })`).
//   • where the run is still BY PATH (the registered runner command names no test path of
//     its own, `strict`), the files the runner reports must be the files passed to it: one
//     it was not given makes the whole replay unverified. A registered command that names
//     its own paths (`node --test test/unit`) legitimately runs other files too, so there
//     the identities are what must check out. vitest / jest JSON reports are shape-checked
//     in every mode (a test count consistent with the results).
//   • plain stdout text is never proof for the registered command: only the signed node:test
//     events count there (a vitest / pytest suite behind an unrecognised command holds as
//     unverified; register the runner's own command to replay it by path). `go test -json`
//     wraps whatever a test prints in an output event, so a printed event proves nothing.
// What this does NOT stop: a node loader module the registered command imports into the
// runner's parent process (--import / --require are kept so TypeScript suites run) runs
// BEFORE the reporter and can read the key file; code the registered command runs before
// node starts can too; and code that rewrites a vitest / jest report or a pytest / cargo
// output line in process. Those take a deliberate attack on the replay itself (and, for
// the loader and the command, a change to the tested commit), not a mis-scoped command.

/** The runners the replay knows a file-scoped invocation for. */
export const REPLAY_RUNNERS = ["node-test", "vitest", "jest", "pytest", "go", "cargo"];

/** POSIX single-quote a shell word. */
function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** A NODE_OPTIONS value: double-quoted only when it holds whitespace (node's own rule). */
function nodeOptWord(s) {
  return /\s/.test(s) ? `"${String(s).replace(/(["\\])/g, "\\$1")}"` : s;
}

function readPackageJson({ worktree, base }) {
  const parse = (text) => {
    try {
      const p = JSON.parse(text);
      return p && typeof p === "object" ? p : null;
    } catch {
      return null;
    }
  };
  let pkg = null;
  if (base && worktree) {
    const r = git(worktree, "show", `${base}:package.json`);
    if (r.status === 0) pkg = parse(r.stdout || "");
  }
  if (!pkg && worktree) {
    // Never through a link (lib/safe-write.mjs): a package.json linked to a file outside
    // the checkout would put that file's scripts into the command and its evidence.
    try {
      const buf = safeReadFile(worktree, "package.json");
      pkg = buf === null ? null : parse(buf.toString("utf8"));
    } catch {
      pkg = null;
    }
  }
  return pkg;
}

const PM_TEST_RE =
  /^(?:npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?(?:test|t)(?:\s+(?:--\s+)?(.*))?$/;

/**
 * The registered test command resolved: a package manager's `test` script (`npm test`,
 * `pnpm test`, `yarn test`, `npm run test`) is read from package.json at the GATED TARGET
 * (`base`, never the branch: a delivery that rewrote `scripts.test` cannot choose how the
 * tester's files run), then the merge's own; anything else is itself.
 *   → { command, script: boolean, pretest: string }
 */
export function resolveTestCommand({ worktree, base = "", testCommand }) {
  const cmd = String(testCommand || "").trim();
  const m = PM_TEST_RE.exec(cmd);
  if (!m) return { command: cmd, script: false, pretest: "" };
  const pkg = readPackageJson({ worktree, base });
  const scripts = pkg && pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  const script = typeof scripts.test === "string" ? scripts.test : "";
  if (!script.trim()) return { command: cmd, script: false, pretest: "" };
  return {
    command: m[1] ? `${script} ${m[1]}` : script,
    script: true,
    pretest: typeof scripts.pretest === "string" ? scripts.pretest.trim() : "",
  };
}

/** The command the registered test command runs (see resolveTestCommand). */
export function effectiveTestCommand({ worktree, base = "", testCommand }) {
  return resolveTestCommand({ worktree, base, testCommand }).command;
}

const RUNNER_PATTERNS = {
  "node-test": /(^|[\s;&|(/])node(\.exe)?\s(?:[^;&|]*\s)?--test(?=[\s=]|$)/,
  vitest: /(^|[\s;&|(/])vitest(\s|$)/,
  jest: /(^|[\s;&|(/])jest(\s|$)/,
  pytest: /(^|[\s;&|(/])py\.?test(\s|$)|(^|[\s;&|(/])python[0-9.]*\s+-m\s+pytest(\s|$)/,
  go: /(^|[\s;&|(])go\s+test(\s|$)/,
  cargo: /(^|[\s;&|(])cargo\s+(\+\S+\s+)?test(\s|$)/,
};

/**
 * Which test runner an (effective) command runs: one of REPLAY_RUNNERS, or "registered"
 * when none is recognised or more than one is (then no single file-scoped invocation is
 * right for every tester file).
 */
export function detectRunner(effective) {
  const c = ` ${String(effective || "")} `;
  const hits = Object.keys(RUNNER_PATTERNS).filter((k) => RUNNER_PATTERNS[k].test(c));
  return hits.length === 1 ? hits[0] : "registered";
}

/** The node flags of the registered `node … --test` invocation (loaders). */
export function nodeLoaderFlags(effective) {
  const segs = String(effective || "").split(/&&|\|\||;|\|/);
  const seg =
    segs.find(
      (s) => /(^|[\s/])node(\.exe)?\s/.test(` ${s}`) && /\s--test(?=[\s=]|$)/.test(` ${s} `),
    ) || "";
  const toks = seg.trim().split(/\s+/).filter(Boolean);
  const at = toks.findIndex((t) => /(^|\/)node(\.exe)?$/.test(t));
  const out = [];
  if (at < 0) return out;
  const withValue =
    /^(--import|--require|-r|--loader|--experimental-loader|--conditions|-C|--env-file)$/;
  const inline =
    /^(--import|--require|--loader|--experimental-loader|--conditions|--env-file)=\S+$|^--experimental-[a-z-]+$|^--no-(warnings|deprecation|experimental-[a-z-]+)$|^--enable-source-maps$|^--test-(timeout|concurrency)=\d+$/;
  for (let k = at + 1; k < toks.length; k++) {
    const t = toks[k];
    if (withValue.test(t)) {
      if (k + 1 < toks.length) out.push(t, toks[++k]);
    } else if (inline.test(t)) out.push(t);
  }
  return out;
}

// ── The command scanner ───────────────────────────────────────────────────────────────
/**
 * Split a shell command into its top-level simple commands, enough to tell which word is
 * the test runner and where its arguments end (bash's own quoting rules for '…', "…" and
 * \x; `$VAR` / `${VAR}` stay inside their word). → { ok: true, segments } with each
 * segment `{ words: [{ text, start, end, redir }], op }` (op: the operator AFTER it,
 * one of "&&", ";", "||", "|", "&", or null), or { ok: false, reason } naming what the scanner does
 * not see through (a substitution, a subshell, a here-document, a group, an unterminated
 * quote). It never runs anything.
 */
export function scanShellCommand(command) {
  const s = String(command ?? "");
  const segments = [];
  let words = [];
  let cur = null;
  const no = (reason) => ({ ok: false, reason });
  const endWord = (at) => {
    if (cur) words.push({ text: cur.text, start: cur.start, end: at, raw: s.slice(cur.start, at) });
    cur = null;
  };
  const word = (at) => (cur ??= { text: "", start: at });
  const close = (op) => {
    segments.push({ words, op });
    words = [];
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t") {
      endWord(i);
      i++;
    } else if (c === "\n") {
      endWord(i);
      close(";");
      i++;
    } else if (c === "#" && !cur) {
      while (i < s.length && s[i] !== "\n") i++;
    } else if (c === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) return no("an unterminated quote");
      word(i).text += s.slice(i + 1, j);
      i = j + 1;
    } else if (c === '"') {
      const w = word(i);
      let j = i + 1;
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === "\\" && j + 1 < s.length && /["\\$`\n]/.test(s[j + 1])) {
          w.text += s[++j];
          continue;
        }
        if (s[j] === "`" || (s[j] === "$" && s[j + 1] === "(")) return no("a command substitution");
        w.text += s[j];
      }
      if (j >= s.length) return no("an unterminated quote");
      i = j + 1;
    } else if (c === "\\") {
      if (s[i + 1] === "\n") {
        endWord(i);
        i += 2;
      } else {
        word(i).text += s[i + 1] ?? "";
        i += 2;
      }
    } else if (c === "`" || (c === "$" && s[i + 1] === "(")) {
      return no("a command substitution");
    } else if (c === "$" && s[i + 1] === "{") {
      const j = s.indexOf("}", i + 2);
      if (j < 0) return no("an unterminated ${…}");
      // `${X:-$(cmd)}` / `${X:-\`cmd\`}` hide a command inside the expansion.
      if (/\$\(|`/.test(s.slice(i + 2, j))) return no("a command substitution");
      word(i).text += s.slice(i, j + 1);
      i = j + 1;
    } else if ((c === "<" || c === ">") && s[i + 1] === "(") {
      return no("a process substitution");
    } else if (c === "(" || c === ")") {
      return no("a subshell");
    } else if (c === "<" && s[i + 1] === "<") {
      return no("a here-document");
    } else if (c === "&" && s[i + 1] === "&") {
      endWord(i);
      close("&&");
      i += 2;
    } else if (c === "&" && s[i + 1] === ">") {
      word(i).text += s[i + 2] === ">" ? "&>>" : "&>";
      i += s[i + 2] === ">" ? 3 : 2;
    } else if (c === "&" && cur && /[<>]$/.test(cur.text)) {
      cur.text += "&"; // 2>&1
      i++;
    } else if (c === "&") {
      endWord(i);
      close("&");
      i++;
    } else if (c === "|" && s[i + 1] === "|") {
      endWord(i);
      close("||");
      i += 2;
    } else if (c === "|" && cur && /[>]$/.test(cur.text)) {
      cur.text += "|"; // >|
      i++;
    } else if (c === "|") {
      endWord(i);
      close("|");
      i++;
    } else if (c === ";") {
      endWord(i);
      close(";");
      i++;
    } else {
      word(i).text += c;
      i++;
    }
  }
  endWord(s.length);
  close(null);
  // Redirections: an operator word (`>`, `2>&1`, `<`, `>>`) and, when the operator carries
  // no target of its own, the word after it.
  const REDIR = /^(?:\d*|&)(?:>>|>&|>\||<&|<>|>|<)(.*)$/;
  for (const seg of segments) {
    for (let k = 0; k < seg.words.length; k++) {
      const m = REDIR.exec(seg.words[k].raw);
      if (!m) continue;
      seg.words[k].redir = true;
      if (m[1] === "" && k + 1 < seg.words.length) seg.words[++k].redir = true;
    }
  }
  if (segments.some((g) => g.words.some((w) => !w.redir && /^[{}!]$|^\[\[$/.test(w.raw))))
    return no("a command group or test expression");
  return { ok: true, segments };
}

const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Words that only launch the next one (their own options skipped). */
const LAUNCHER_VALUE_OPTS = {
  env: new Set(["-u", "--unset", "-C", "--chdir"]),
  npx: new Set(["-p", "--package", "-c", "--call"]),
  bunx: new Set(["-p", "--package"]),
  "cross-env": new Set(),
  dotenv: new Set(["-e", "-c", "-v"]),
  time: new Set(["-f", "-o"]),
  nice: new Set(["-n"]),
  nohup: new Set(),
};
const PM_LAUNCHERS = new Set(["pnpm", "yarn", "bun", "npm"]);
const RUNNER_NAMES = /^(?:node|nodejs|vitest|jest|py\.?test|python[0-9.]*|go|cargo)$/;
/** node options that take the next word as their value. */
const NODE_VALUE = new Set([
  "--import",
  "--require",
  "-r",
  "--loader",
  "--experimental-loader",
  "--conditions",
  "-C",
  "--env-file",
  "--input-type",
  "--test-reporter",
  "--test-reporter-destination",
  "--test-name-pattern",
  "--test-skip-pattern",
]);

function base(word) {
  return String(word)
    .replace(/^.*\//, "")
    .replace(/\.(exe|cmd)$/i, "");
}

/**
 * Where in one simple command the test runner is: { runner, at, args } (the index of the
 * runner's command word and of its first argument; go/cargo: after `test`), or null.
 * Leading assignments and a known launcher (env, npx, pnpm exec, yarn, cross-env, dotenv,
 * time, nice, nohup, `uv run`, `poetry run`, `pipenv run`, `pdm run`) are stepped over.
 */
function runnerOf(words) {
  const w = words.filter((x) => !x.redir);
  let k = 0;
  const at = () => (k < w.length ? w[k].text : "");
  for (let guard = 0; guard < 16 && k < w.length; guard++) {
    if (ASSIGN_RE.test(at())) {
      k++;
      continue;
    }
    const b = base(at());
    if (b in LAUNCHER_VALUE_OPTS) {
      const vals = LAUNCHER_VALUE_OPTS[b];
      k++;
      while (k < w.length && (at().startsWith("-") || (b !== "dotenv" && ASSIGN_RE.test(at())))) {
        if (at() === "--") {
          k++;
          break;
        }
        if (vals.has(at())) k++;
        k++;
      }
      continue;
    }
    if (PM_LAUNCHERS.has(b)) {
      const next = k + 1 < w.length ? w[k + 1].text : "";
      if (/^(exec|x|dlx)$/.test(next)) {
        k += 2;
        while (k < w.length && at().startsWith("-")) {
          const stop = at() === "--";
          k++;
          if (stop) break;
        }
        continue;
      }
      if (b !== "npm" && RUNNER_NAMES.test(base(next))) {
        k++;
        continue;
      }
      return null;
    }
    if (
      /^(uv|poetry|pipenv|pdm|hatch|rye)$/.test(b) &&
      k + 1 < w.length &&
      w[k + 1].text === "run"
    ) {
      k += 2;
      continue;
    }
    break;
  }
  if (k >= w.length) return null;
  const b = base(at());
  const rest = w.slice(k + 1).map((x) => x.text);
  // { runner, at: the runner's word, sub: its last command word (`test` for go / cargo,
  // `pytest` after `python -m`, `--test` for node), args: the first word after it } as
  // indices into `words`.
  const hit = (runner, n = 0) => {
    const sub = words.indexOf(w[k + n]);
    return { runner, at: words.indexOf(w[k]), sub, args: sub + 1 };
  };
  if (b === "vitest") return hit("vitest");
  if (b === "jest") return hit("jest");
  if (/^py\.?test$/.test(b)) return hit("pytest");
  if (/^python[0-9.]*$/.test(b) && rest[0] === "-m" && rest[1] === "pytest")
    return hit("pytest", 2);
  if (b === "go" && rest[0] === "test") return hit("go", 1);
  if (b === "cargo") {
    const t = /^\+/.test(rest[0] || "") ? 1 : 0;
    return rest[t] === "test" ? hit("cargo", t + 1) : null;
  }
  if (b === "node" || b === "nodejs") {
    for (let j = 0; j < rest.length; j++) {
      if (rest[j] === "--test") return hit("node-test", j + 1);
      if (!rest[j].startsWith("-")) return null; // a script: not the test runner
      if (NODE_VALUE.has(rest[j])) j++;
    }
  }
  return null;
}

/** Options of each runner that take the NEXT word as their value (positional detection). */
const VALUE_OPTS = {
  "node-test": new Set([
    "--import",
    "--require",
    "-r",
    "--loader",
    "--experimental-loader",
    "--conditions",
    "-C",
    "--env-file",
    "--test-reporter",
    "--test-reporter-destination",
    "--test-name-pattern",
    "--test-skip-pattern",
    "--test-shard",
    "--test-concurrency",
    "--test-timeout",
  ]),
  vitest: new Set([
    "-c",
    "--config",
    "-r",
    "--root",
    "--dir",
    "--project",
    "--environment",
    "--reporter",
    "--outputFile",
    "-t",
    "--testNamePattern",
    "--pool",
    "--mode",
    "--shard",
    "--exclude",
    "--maxWorkers",
    "--minWorkers",
    "--testTimeout",
    "--retry",
    "--sequence.seed",
    "--coverage.reporter",
    "--workspace",
    "--globalSetup",
    "--setupFiles",
    "--typecheck.tsconfig",
  ]),
  jest: new Set([
    "-c",
    "--config",
    "--selectProjects",
    "--projects",
    "--rootDir",
    "--roots",
    "-t",
    "--testNamePattern",
    "--testPathIgnorePatterns",
    "--testPathPattern",
    "--maxWorkers",
    "-w",
    "--reporters",
    "--setupFiles",
    "--testEnvironment",
    "--env",
    "--shard",
    "--testTimeout",
    "--outputFile",
    "--coverageDirectory",
    "--cacheDirectory",
    "--seed",
  ]),
  pytest: new Set([
    "-m",
    "-k",
    "-p",
    "-o",
    "-c",
    "--rootdir",
    "--confcutdir",
    "--basetemp",
    "--junitxml",
    "--junit-xml",
    "-W",
    "--maxfail",
    "--tb",
    "--durations",
    "--deselect",
    "--ignore",
    "--ignore-glob",
    "--log-level",
    "-n",
    "--dist",
    "--cov",
    "--cov-report",
    "--import-mode",
    "--capture",
    "--override-ini",
    "-r",
  ]),
};
/** go test's own flags that take a value (`-run X` / `-run=X`). */
const GO_VALUE = new Set([
  "run",
  "skip",
  "bench",
  "benchtime",
  "count",
  "cpu",
  "parallel",
  "timeout",
  "tags",
  "p",
  "o",
  "exec",
  "ldflags",
  "gcflags",
  "asmflags",
  "gccgoflags",
  "mod",
  "modfile",
  "C",
  "coverprofile",
  "covermode",
  "coverpkg",
  "cpuprofile",
  "memprofile",
  "memprofilerate",
  "blockprofile",
  "blockprofilerate",
  "mutexprofile",
  "mutexprofilefraction",
  "trace",
  "outputdir",
  "fuzz",
  "fuzztime",
  "fuzzminimizetime",
  "shuffle",
  "vet",
  "toolexec",
  "overlay",
  "pgo",
  "pkgdir",
  "installsuffix",
  "buildmode",
  "compiler",
  "json-out",
]);
const GO_BOOL = new Set([
  "v",
  "race",
  "cover",
  "short",
  "json",
  "a",
  "n",
  "x",
  "work",
  "benchmem",
  "trimpath",
  "msan",
  "asan",
  "linkshared",
  "failfast",
  "fullpath",
  "i",
  "buildvcs",
  "modcacherw",
  "fuzzcachedir",
]);

/** The tester's go packages (`./<dir>`) and test target names of `files`. */
function goDirs(files) {
  return [...new Set((files || []).map((f) => `./${dirname(f)}`))];
}
function cargoTargets(files) {
  return (files || [])
    .map((f) => /^tests\/([^/]+)\.rs$/.exec(f))
    .filter(Boolean)
    .map((m) => m[1]);
}

/**
 * Where the registered command's runner is, and whether it can be extended: the runner is
 * the command word of the LAST simple command, every earlier one is joined by `&&` or `;`,
 * no other command mentions a runner, and no word hides one (`bash -c "vitest run"`).
 *   → { ok: true, runner, segment, words, at, args, insertAt, positional } | { ok: false, reason }
 */
export function locateRunner(effective) {
  const sc = scanShellCommand(effective);
  if (!sc.ok) return { ok: false, reason: `the test command has ${sc.reason}` };
  const segs = sc.segments.filter((g, k) => g.words.length > 0 || k < sc.segments.length - 1);
  const hits = [];
  for (let k = 0; k < segs.length; k++) {
    const g = segs[k];
    const r = runnerOf(g.words);
    const text = g.words.map((x) => x.text).join(" ");
    if (r) hits.push({ k, r });
    else if (
      detectRunner(text) !== "registered" ||
      /(^|[\s/])(vitest|jest|pytest|py\.test)(\s|$)/.test(text)
    )
      return {
        ok: false,
        reason: "a test runner is behind a launcher or inside a word the replay cannot see through",
      };
  }
  if (hits.length === 0) return { ok: false, reason: "no test runner the replay can extend" };
  if (hits.length > 1)
    return { ok: false, reason: "the test command runs more than one test runner" };
  const { k, r } = hits[0];
  // The runner's command must be the last one; a final `;` or newline only ends it.
  let end = segs.length - 1;
  while (end > 0 && segs[end].words.length === 0) end--;
  if (end !== k)
    return { ok: false, reason: "the test runner is not the last command of the test command" };
  for (let j = 0; j < segs.length; j++) {
    const op = segs[j].op;
    const okOp = j < end ? op === "&&" || op === ";" : op === null || op === ";";
    if (!okOp)
      return {
        ok: false,
        reason: `the test command uses \`${op}\` (its exit status is not the runner's)`,
      };
  }
  const g = segs[k];
  const words = g.words;
  const dash = words.findIndex((x, j) => j >= r.args && !x.redir && x.raw === "--");
  const lastWord = words[words.length - 1];
  const insertAt = dash >= 0 ? words[dash].start : lastWord.end;
  // Positional arguments of the runner itself (a path it runs on its own).
  const args = words.slice(r.args, dash >= 0 ? dash : words.length).filter((x) => !x.redir);
  let positional = false;
  if (r.runner !== "go" && r.runner !== "cargo") {
    const vals = VALUE_OPTS[r.runner] || new Set();
    for (let j = 0; j < args.length; j++) {
      const t = args[j].text;
      if (t.startsWith("-")) {
        if (!t.includes("=") && vals.has(t)) j++;
        continue;
      }
      if (r.runner === "vitest" && j === 0 && /^(run|related|watch|dev)$/.test(t)) continue;
      positional = true;
    }
  } else if (r.runner === "cargo") {
    positional = args.some((x) =>
      /^(--tests|--all-targets|--test|--workspace|--all|--benches|--examples)$/.test(x.text),
    );
  }
  return {
    ok: true,
    runner: r.runner,
    words,
    at: r.at,
    sub: r.sub,
    args: r.args,
    insertAt,
    positional,
    dash,
  };
}

/** Insert `text` into `s` at `at`, separated by single spaces. */
function splice(s, at, text) {
  if (!text) return s;
  const left = s.slice(0, at).replace(/\s+$/, "");
  const right = s.slice(at).replace(/^\s+/, "");
  return right ? `${left} ${text} ${right}` : `${left} ${text}`;
}

/**
 * go: the registered `go test` with `-json` after `test`, and (by path) its package
 * arguments replaced by `dirs`. → { command, tags } or null when the package arguments
 * cannot be located unambiguously (an unknown flag before a bare word).
 */
function goCommand(effective, loc, dirs, select) {
  const words = loc.words;
  const stop = loc.dash >= 0 ? loc.dash : words.length;
  const pkgs = [];
  const tags = [];
  let hasJson = false;
  for (let j = loc.args; j < stop; j++) {
    const x = words[j];
    if (x.redir) continue;
    const t = x.text;
    if (t === "-args" || t === "--args") break;
    if (t.startsWith("-")) {
      const name = t.replace(/^--?/, "").replace(/=.*$/, "");
      if (name === "json") hasJson = true;
      if (name === "tags") {
        if (t.includes("=")) tags.push(x.raw.replace(/^--?/, "-"));
        else if (j + 1 < stop) tags.push("-tags", words[j + 1].raw);
      }
      if (t.includes("=")) continue;
      if (GO_VALUE.has(name)) {
        j++;
        continue;
      }
      if (GO_BOOL.has(name)) continue;
      // An unknown flag followed by a bare word: is it its value or a package?
      if (j + 1 < stop && !words[j + 1].text.startsWith("-")) return null;
      continue;
    }
    pkgs.push(x);
  }
  let out = effective;
  if (select) {
    // Remove the package words (right to left, so the earlier offsets hold) and put the
    // tester's packages where the first one was, or append them.
    const list = dirs.map(shq).join(" ");
    if (pkgs.length) {
      for (let j = pkgs.length - 1; j >= 1; j--)
        out = out.slice(0, pkgs[j].start).replace(/\s+$/, "") + out.slice(pkgs[j].end);
      out = out.slice(0, pkgs[0].start) + list + out.slice(pkgs[0].end);
    } else out = splice(out, loc.insertAt, list);
  }
  if (!hasJson) out = splice(out, words[loc.sub].end, "-json");
  return { command: out, tags };
}

/**
 * The prefix of a signed proof line; the env var that carries the PATH of the key file the
 * reporter reads and unlinks; and the variable an older runner put the key itself in (the
 * reporter still deletes it, nothing sets it).
 */
export const PROOF_TAG = "gaffer-replay-proof";
export const PROOF_KEY_FILE_ENV = "GAFFER_REPLAY_PROOF_KEY_FILE";
export const PROOF_KEY_ENV = "GAFFER_REPLAY_PROOF_KEY";

/**
 * The node:test reporter the replay adds: one SIGNED line per test that ran, with its file,
 * its full name (the suites it is nested in, from test:start) and its call site, then a
 * closing count: `gaffer-replay-proof <hmac-sha256 hex> <json>`. The key comes from the
 * file the environment names; at load (before the runner spawns a test file) the reporter
 * deletes the variable, reads the file and unlinks it, so no test process can find the key
 * anywhere. Without a key, or when the unlink fails, it signs nothing (no proof).
 */
const NODE_REPORTER = `// gaffer tester replay: which tests ran (written by lib/tester-replay.mjs)
import { createHmac } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
const KEY_FILE = process.env.${PROOF_KEY_FILE_ENV} || "";
delete process.env.${PROOF_KEY_FILE_ENV};
delete process.env.${PROOF_KEY_ENV};
let KEY = "";
if (KEY_FILE) {
  try {
    const k = readFileSync(KEY_FILE, "utf8").trim();
    unlinkSync(KEY_FILE);
    KEY = k;
  } catch {
    KEY = "";
  }
}
const line = (o) => {
  const j = JSON.stringify(o);
  return "${PROOF_TAG} " + createHmac("sha256", KEY).update(j).digest("hex") + " " + j + "\\n";
};
export default async function* gafferReplayReporter(source) {
  let seq = 0;
  const stacks = new Map();
  for await (const ev of source) {
    if (!KEY) continue;
    const d = ev.data;
    if (ev.type === "test:start" && d && d.file) {
      const st = stacks.get(d.file) || [];
      st.length = Math.max(0, Number(d.nesting) || 0);
      st.push(String(d.name ?? ""));
      stacks.set(d.file, st);
    }
    if ((ev.type === "test:pass" || ev.type === "test:fail") && d && d.file) {
      const st = (stacks.get(d.file) || []).slice(0, Math.max(0, Number(d.nesting) || 0));
      yield line({ pid: process.pid, seq: ++seq, type: ev.type, file: String(d.file),
        name: String(d.name ?? ""), path: [...st, String(d.name ?? "")],
        line: Number.isInteger(d.line) ? d.line : null, column: Number.isInteger(d.column) ? d.column : null,
        skip: Boolean(d.skip), todo: Boolean(d.todo),
        suite: Boolean(d.details && d.details.type === "suite") });
    }
  }
  if (KEY) yield line({ pid: process.pid, type: "end", count: seq });
}
`;

/**
 * HOW the replay runs the tester's `files` in the scratch merge worktree, and where the
 * proof will be: { runner, mode: "files" | "registered", command, env, proof, strict,
 * effective, reason }. `command` runs through bin/dod-regate.sh (the gates' wrap and
 * timeout) or, in the tester lane, the sandboxed `bash -c`; `env` is added to its
 * environment (every entry: the caller passes them all; it names the key FILE, never the
 * key); `proof.dir` is a fresh directory inside the worktree, `proof.keyFile` the key's
 * file inside it (written by prepareReplayProof, unlinked by the reporter).
 * `select: false` (the tester lane's clean replay, which runs the whole suite as
 * registered) adds only the proof reporter, never a file selection. `strict`: the run is
 * by path (the runner names no test path of its own): a reported file that was not given
 * makes the proof fail.
 */
export function replayInvocation({
  worktree,
  base = "",
  testCommand,
  files,
  nonce = "",
  key = "",
  select = true,
}) {
  const n = nonce || randomBytes(6).toString("hex");
  const dir = join(worktree, `.gaffer-replay-${n}`);
  // The node:test events are signed with this key (NODE_REPORTER). It reaches the run only
  // as a file (prepareReplayProof) whose path is in inv.env, and replayProof on stdin.
  const proofKey = key || randomBytes(32).toString("hex");
  const keyDir = join(dir, `k-${randomBytes(12).toString("hex")}`);
  const proof = {
    dir,
    reporter: join(dir, "reporter.mjs"),
    report: join(dir, "report.json"),
    golist: join(dir, "golist.txt"),
    output: join(dir, "output.txt"),
    key: proofKey,
    keyDir,
    keyFile: join(keyDir, randomBytes(16).toString("hex")),
  };
  const resolved = resolveTestCommand({ worktree, base, testCommand });
  const effective = resolved.command;
  const list = (files || []).map(shq).join(" ");
  // Both reporters write to the run's stdout (the tests gate's output, kept through
  // GAFFER_DOD_TESTS_OUTPUT): the signed lines need no file a test process could write.
  const reporters = (q) =>
    [
      "--test-reporter=spec",
      "--test-reporter-destination=stdout",
      `--test-reporter=${q(proof.reporter)}`,
      "--test-reporter-destination=stdout",
    ].join(" ");
  // `key: false` (review 11 follow-up): a registered run whose runner is known NOT to be
  // node:test (a go or cargo command gaffer cannot scope) gets no key file. No reporter
  // would ever consume it, so it would sit readable for the whole run and the code under
  // test could sign node:test events with it.
  const registered = (why, { key: withKey = true } = {}) => ({
    runner: "registered",
    mode: "registered",
    command: String(testCommand || ""),
    env: {
      NODE_OPTIONS: [process.env.NODE_OPTIONS || "", reporters(nodeOptWord)]
        .filter(Boolean)
        .join(" "),
      ...(withKey ? { [PROOF_KEY_FILE_ENV]: proof.keyFile } : {}),
    },
    proof,
    strict: false,
    effective,
    reason: `${why}: it runs as registered and the tester's tests need the runner's own evidence that they ran`,
  });
  const loc = locateRunner(effective);
  if (!loc.ok) return registered(loc.reason);
  const runner = loc.runner;
  // The clean replay of a package script that runs node:test needs no change to the
  // command at all: the registered command itself (`npm test`, its hooks and environment
  // included) with the signed reporter in NODE_OPTIONS.
  if (!select && resolved.script && runner === "node-test")
    return {
      ...registered("the package script runs node:test"),
      reason:
        "the registered command runs as it is, with the signed node:test reporter in NODE_OPTIONS",
    };
  // A package script runs as the base has it, where the package manager would run it:
  // node_modules/.bin on PATH (dispatch's base-pinned gate command uses the same prefix),
  // after its `pretest` hook.
  const wrap = (command) =>
    resolved.script
      ? `PATH="$PWD/node_modules/.bin:$PATH"; ${resolved.pretest ? `( ${resolved.pretest} ) && ` : ""}${command}`
      : command;
  const files_ = (command, why, strict = select && !loc.positional) => ({
    runner,
    mode: "files",
    command: wrap(command),
    env: runner === "node-test" ? { [PROOF_KEY_FILE_ENV]: proof.keyFile } : {},
    proof,
    strict,
    effective,
    reason: why,
  });
  const at = loc.insertAt;
  switch (runner) {
    case "node-test":
      // node reads its options only before the first test path: the reporters go right
      // after `--test`, the tester's files at the end.
      return files_(
        splice(splice(effective, at, select ? list : ""), loc.words[loc.sub].end, reporters(shq)),
        "the registered node:test command runs with the tester's files and the replay's signed reporter",
      );
    case "vitest":
      return files_(
        splice(
          effective,
          at,
          [
            `--reporter=default --reporter=json --outputFile.json=${shq(proof.report)}`,
            select ? list : "",
          ]
            .filter(Boolean)
            .join(" "),
        ),
        "the registered vitest command runs with the tester's files (a JSON report names each test)",
      );
    case "jest":
      return files_(
        splice(
          effective,
          at,
          [`--json --outputFile=${shq(proof.report)}`, select ? `--runTestsByPath ${list}` : ""]
            .filter(Boolean)
            .join(" "),
        ),
        "the registered jest command runs with the tester's files (a JSON report names each test)",
      );
    case "pytest":
      return files_(
        splice(effective, at, ["-vv", select ? list : ""].filter(Boolean).join(" ")),
        "the registered pytest command runs with the tester's files (verbose node ids)",
      );
    case "go": {
      const dirs = goDirs(files);
      const g = goCommand(effective, loc, dirs, select);
      if (!g)
        return registered(
          "the go test command's package arguments cannot be located unambiguously",
          { key: false },
        );
      const fmt =
        "{{.ImportPath}} {{.Dir}}{{range .TestGoFiles}} {{.}}{{end}}{{range .XTestGoFiles}} {{.}}{{end}}";
      const golist = ["go list", ...g.tags, "-f", shq(fmt), dirs.map(shq).join(" ")].join(" ");
      return files_(
        dirs.length ? `${golist} > ${shq(proof.golist)} && ${g.command}` : g.command,
        "the registered go test command runs on the tester's packages (go test -json names each test, go list their test files)",
        select,
      );
    }
    case "cargo": {
      const names = cargoTargets(files);
      if (select && names.length === 0)
        return registered(
          "cargo has no file-scoped invocation for these files (only tests/<name>.rs)",
          { key: false },
        );
      return files_(
        select ? splice(effective, at, names.map((x) => `--test ${shq(x)}`).join(" ")) : effective,
        "the registered cargo test command runs the tester's integration-test targets by name",
        select && !loc.positional,
      );
    }
    default:
      return registered("no file-scoped invocation is known for this test command");
  }
}

/**
 * Create the proof directory, the node:test reporter and, when the run is handed a key
 * (inv.env names the key file), the key file: mode 0600, a random name, inside a mode 0300
 * directory (other users cannot reach it; the runner's own user could chmod it, so the
 * protection is that the reporter unlinks it before any test runs). The ONE helper the clean replay (bin/tester-run.mjs) and both
 * landing paths (lib/land.sh through `apply`, bin/merge-ticket.mjs) use. Throws when the
 * directory or the file cannot be created (the caller holds).
 */
export function prepareReplayProof(inv) {
  discardReplayKey(inv);
  rmSync(inv.proof.dir, { recursive: true, force: true });
  mkdirSync(inv.proof.dir, { recursive: true });
  writeFileSync(inv.proof.reporter, NODE_REPORTER);
  const p = inv.proof;
  if (p.keyFile && p.keyDir && p.key && inv.env && inv.env[PROOF_KEY_FILE_ENV] === p.keyFile) {
    mkdirSync(p.keyDir, { mode: 0o700 });
    writeFileSync(p.keyFile, p.key, { mode: 0o600, flag: "wx" });
    chmodSync(p.keyFile, 0o600);
    chmodSync(p.keyDir, 0o300);
  }
}

/**
 * Remove the key file a reporter never consumed (it did not load, or the run never
 * started) and its directory. Never throws; true when nothing is left.
 */
export function discardReplayKey(inv) {
  const p = (inv && inv.proof) || {};
  if (!p.keyDir) return true;
  try {
    chmodSync(p.keyDir, 0o700);
  } catch {
    return true; // no directory: nothing was written, or it is already gone
  }
  try {
    if (p.keyFile) rmSync(p.keyFile, { force: true });
    rmdirSync(p.keyDir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove a replay checkout (or any tree holding a proof directory). A run killed before
 * its reporter loaded, or the runner itself killed mid-run, leaves a key file inside a
 * mode 0300 directory, and a recursive remove cannot list that directory (EACCES for any
 * user but root): the next replay at the same fixed path (tester-replay-<n>,
 * replay-recovery-<n>) would throw at its first cleanup, every time. On a failed remove
 * this gives the owner back every directory in the tree (symlinks are not followed) and
 * removes it again. Throws only when that second remove fails too.
 */
export function removeTree(p) {
  try {
    rmSync(p, { recursive: true, force: true });
    return;
  } catch {
    /* an unlistable directory inside: open the tree up and retry */
  }
  const open = (d) => {
    try {
      chmodSync(d, 0o700);
    } catch {
      return;
    }
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) if (e.isDirectory()) open(join(d, e.name));
  };
  open(p);
  rmSync(p, { recursive: true, force: true });
}

function readText(p) {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/** A path's spellings relative to the worktree (as given, and through realpath). */
function relSpellings(worktree, p) {
  const out = new Set();
  const norm = (x) => x.split(sep).join("/");
  const add = (wt, x) => {
    const r = relative(wt, x);
    if (r && !r.startsWith("..")) out.add(norm(r));
  };
  const abs = String(p);
  if (!abs.startsWith("/")) {
    out.add(norm(abs).replace(/^\.\//, ""));
    return out;
  }
  add(worktree, abs);
  const real = (x) => {
    try {
      return realpathSync(x);
    } catch {
      return x;
    }
  };
  const rw = real(worktree);
  add(rw, real(abs));
  add(rw, abs);
  return out;
}

/** A runner output line without its terminal colour codes. */
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");
function stripAnsi(line) {
  return String(line).replace(ANSI_RE, "");
}

// pytest node ids (-vv): "test/test_a.py::test_x PASSED". (vitest / jest per-file text
// lines are not read: anything the tests print can look like them.)
const PYTEST_NODE_ID = /^(\S+?)::(\S.*?)\s(PASSED|FAILED|ERROR|XFAIL|XPASS|SKIPPED)\b/;

/** A signed node:test proof line's MAC check (constant time). */
function macOk(key, json, mac) {
  if (!key || !/^[0-9a-f]{64}$/.test(mac)) return false;
  const want = createHmac("sha256", key).update(json).digest();
  return timingSafeEqual(want, Buffer.from(mac, "hex"));
}

/**
 * The node:test reporter's SIGNED events in a run's output → { events, bad } where `bad`
 * names the first integrity failure (a line with a bad MAC or shape, a sequence gap or
 * duplicate, a process with no closing count). Unsigned look-alikes are ignored.
 */
function signedNodeEvents(output, key) {
  const events = [];
  const byPid = new Map();
  let bad = "";
  const tag = `${PROOF_TAG} `;
  for (const raw of output.split("\n")) {
    const at = raw.indexOf(tag);
    if (at < 0) continue;
    const rest = raw.slice(at + tag.length).replace(/\r$/, "");
    const sp = rest.indexOf(" ");
    const mac = sp > 0 ? rest.slice(0, sp) : "";
    const json = sp > 0 ? rest.slice(sp + 1) : "";
    if (!macOk(key, json, mac)) {
      bad ||= "a proof line is not signed by this replay's reporter";
      continue;
    }
    let ev;
    try {
      ev = JSON.parse(json);
    } catch {
      bad ||= "a signed proof line is not JSON";
      continue;
    }
    if (!ev || !Number.isInteger(ev.pid)) {
      bad ||= "a signed proof line names no process";
      continue;
    }
    const g = byPid.get(ev.pid) || { seq: 0, end: false };
    byPid.set(ev.pid, g);
    if (g.end) {
      bad ||= "a proof line follows its process's closing count";
      continue;
    }
    if (ev.type === "end") {
      if (ev.count !== g.seq) bad ||= "a process's closing count does not match its events";
      g.end = true;
      continue;
    }
    if (ev.seq !== g.seq + 1 || typeof ev.file !== "string") {
      bad ||= "the proof lines are out of sequence (a gap, a duplicate or a replayed line)";
      continue;
    }
    g.seq = ev.seq;
    events.push(ev);
  }
  for (const g of byPid.values())
    if (!g.end) bad ||= "a runner process's proof has no closing count";
  return { events, bad };
}

/** A vitest / jest JSON report's per-file results, or "" when its shape is not one. */
function jsonReportResults(text) {
  let rep;
  try {
    rep = JSON.parse(text || "null");
  } catch {
    return { results: [], bad: "the JSON report is unreadable" };
  }
  if (!rep || typeof rep !== "object" || !Array.isArray(rep.testResults))
    return { results: [], bad: "the JSON report has no testResults" };
  if (typeof rep.numTotalTests !== "number")
    return { results: [], bad: "the JSON report has no test count" };
  let total = 0;
  for (const r of rep.testResults) {
    if (!r || typeof r.name !== "string" || !Array.isArray(r.assertionResults))
      return { results: [], bad: "a JSON report entry is not a test file result" };
    total += r.assertionResults.length;
  }
  if (total !== rep.numTotalTests)
    return { results: [], bad: "the JSON report's test count does not match its results" };
  return { results: rep.testResults, bad: "" };
}

/** The top-level `func TestX(t *testing.T)` names a go test file declares. */
function goTestsDeclared(path) {
  const out = new Set();
  const re = /^func\s+(Test[A-Za-z0-9_]*)\s*\(\s*\w+\s+\*testing\.T\s*\)/gm;
  for (const m of readText(path).matchAll(re)) out.add(m[1]);
  return out;
}

/**
 * A recorded test identity, normalised: { file, name, line?, column? }, or null when the
 * value is not one. The key ignores line/column unless both sides carry them (see
 * sameIdentity): node:test records them, the other runners do not.
 */
export function normaliseIdentity(t) {
  if (!t || typeof t !== "object") return null;
  const file = typeof t.file === "string" ? t.file.trim() : "";
  const name = typeof t.name === "string" ? t.name : "";
  if (!file || !name || file.length > 1000 || name.length > 2000 || /\0/.test(file + name))
    return null;
  const out = { file, name };
  if (Number.isInteger(t.line) && t.line > 0) out.line = t.line;
  if (Number.isInteger(t.column) && t.column > 0) out.column = t.column;
  return out;
}

/** Do an observed test and a recorded identity name the same test? */
export function sameIdentity(a, b) {
  if (a.file !== b.file || a.name !== b.name) return false;
  if (a.line && b.line && a.line !== b.line) return false;
  if (a.column && b.column && a.column !== b.column) return false;
  return true;
}

const fmtId = (t) => `${t.file} :: ${t.name}`;
const fmtIds = (list, what) =>
  list.length
    ? `${list.slice(0, 8).map(fmtId).join("; ")}${list.length > 8 ? `; and ${list.length - 8} more` : ""} (${what})`
    : "";

/**
 * Which tester tests the replay PROVES ran and passed: { ran, unproven, tests, failed,
 * skipped, missing, evidence, reason }. Reads only what the runner wrote (see
 * replayInvocation).
 *   required: the identities the bound PASS recorded ([{ file, name, line?, column? }]):
 *     EVERY one must execute and pass; `failed` / `skipped` / `missing` name the rest, the
 *     files holding them are unproven, `ran` lists the files whose bound identities all
 *     passed, `tests` the identities proven, evidence "identities". A PASS that bound no
 *     identity in its files proves nothing (every file unproven).
 *   required null (an older PASS without identities): the file-level rule: a file with
 *     the runner's evidence that it ran is proven; `tests` lists the identities seen
 *     passing in the tester's files; evidence "files".
 * An integrity failure (a forged or out-of-sequence node:test line, a by-path run that
 * reports a file it was not given, a malformed report) leaves EVERY file unproven.
 */
export function replayProof({ inv, files, worktree, key, required = null }) {
  const want = [...new Set((files || []).map(String))];
  const fileRan = new Set();
  const seen = []; // { file, name, status: pass | fail | skip, line?, column? }
  let bad = "";
  const rels = (p) => [...relSpellings(worktree, p)];
  const wanted = (p) => rels(p).find((r) => want.includes(r)) || "";
  const strict = inv.mode === "files" && inv.strict !== false;
  const notGiven = (what, p) => {
    if (strict) bad ||= `${what} (${rels(p)[0] || p})`;
  };
  const runner = inv.runner;
  // A key file the reporter never consumed goes now: the run is over.
  discardReplayKey(inv);
  // ONE KEY, ONE RUN: the key file is consumed by the first node:test reporter that loads,
  // so in a registered command only that run can prove anything. Said in a hold's reason.
  const oneRunHint =
    runner === "registered" && inv.env && inv.env[PROOF_KEY_FILE_ENV]
      ? " (the replay's signing key is good for one node:test run: a registered command that starts `node --test` more than once proves only the files of the first one; register a single `node --test` run, or a command gaffer can run by path)"
      : "";
  const output = readText(inv.proof.output);
  const proofKey = key || (inv.proof && inv.proof.key) || "";
  const observe = (file, name, status, extra = {}) => seen.push({ file, name, status, ...extra });
  // node:test events (node:test runs, and every registered run through NODE_OPTIONS).
  if (runner === "node-test" || runner === "registered") {
    const sig = signedNodeEvents(output, proofKey);
    bad ||= sig.bad;
    for (const ev of sig.events) {
      const f = wanted(ev.file);
      if (!f) {
        notGiven("the runner reported a file it was not given", ev.file);
        continue;
      }
      if (ev.suite) continue;
      // node reports a file that defines no test as one synthetic test named after it:
      // nothing in it ran.
      if (rels(ev.file).includes(String(ev.name)) || ev.name === ev.file) continue;
      const path =
        Array.isArray(ev.path) && ev.path.length ? ev.path.map(String) : [String(ev.name)];
      const extra = {};
      if (Number.isInteger(ev.line)) extra.line = ev.line;
      if (Number.isInteger(ev.column)) extra.column = ev.column;
      if (ev.skip || ev.todo) {
        observe(f, path.join(" > "), "skip", extra);
        continue;
      }
      fileRan.add(f);
      observe(f, path.join(" > "), ev.type === "test:pass" ? "pass" : "fail", extra);
    }
  }
  if (runner === "vitest" || runner === "jest") {
    const rep = jsonReportResults(readText(inv.proof.report));
    bad ||= rep.bad;
    for (const r of rep.results) {
      const f = wanted(r.name);
      if (!f) {
        notGiven("the JSON report names a file that was not requested", r.name);
        continue;
      }
      for (const a of r.assertionResults) {
        if (!a) continue;
        const name = [
          ...(Array.isArray(a.ancestorTitles) ? a.ancestorTitles.map(String) : []),
          String(a.title ?? a.fullName ?? ""),
        ].join(" > ");
        const status = a.status === "passed" ? "pass" : a.status === "failed" ? "fail" : "skip";
        if (status !== "skip") fileRan.add(f);
        observe(f, name, status);
      }
    }
  }
  if (runner === "pytest") {
    for (const line of output.split("\n")) {
      const m = PYTEST_NODE_ID.exec(stripAnsi(line));
      if (!m) continue;
      const f = wanted(m[1]);
      if (!f) {
        notGiven("pytest reported a file it was not given", m[1]);
        continue;
      }
      const st = m[3];
      if (st !== "SKIPPED") fileRan.add(f);
      observe(
        f,
        m[2],
        st === "PASSED" ? "pass" : st === "FAILED" || st === "ERROR" ? "fail" : "skip",
      );
    }
  }
  if (runner === "go") {
    const real = (x) => {
      try {
        return realpathSync(x);
      } catch {
        return x;
      }
    };
    const listed = readText(inv.proof.golist)
      .split("\n")
      .map((l) => l.trim().split(/\s+/))
      .filter((t) => t.length > 1);
    // `go list` lines: <import path> <dir> <test files…> (an older line has no import path).
    const pkgDir = new Map();
    for (const f of want) {
      if (!f.endsWith("_test.go")) continue;
      const dir = real(join(worktree, dirname(f)));
      const b = f.slice(f.lastIndexOf("/") + 1);
      for (const t of listed) {
        const [ip, d, ...names] = t[0].startsWith("/") ? ["", ...t] : t;
        if (real(d) !== dir) continue;
        if (ip) pkgDir.set(ip, dir);
        if (names.includes(b)) fileRan.add(f);
      }
    }
    const declared = new Map(
      want
        .filter((f) => f.endsWith("_test.go"))
        .map((f) => [f, goTestsDeclared(join(worktree, f))]),
    );
    for (const line of output.split("\n")) {
      if (!line.startsWith("{")) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (!ev || typeof ev.Test !== "string" || typeof ev.Package !== "string") continue;
      if (!/^(pass|fail|skip)$/.test(ev.Action)) continue;
      const dir = pkgDir.get(ev.Package);
      if (!dir) continue;
      const root = ev.Test.split("/")[0];
      for (const [f, names] of declared) {
        if (real(join(worktree, dirname(f))) !== dir || !names.has(root)) continue;
        observe(f, ev.Test, ev.Action);
      }
    }
  }
  if (runner === "cargo") {
    let target = "";
    for (const raw of output.split("\n")) {
      const line = stripAnsi(raw);
      const r = /^\s*Running\s+(\S+)/.exec(line);
      if (r) {
        target = "";
        const m = /^(tests\/[^\s]+\.rs)$/.exec(r[1]);
        if (!m) continue;
        const f = wanted(m[1]);
        if (!f) {
          notGiven("cargo ran a test target it was not given", m[1]);
          continue;
        }
        fileRan.add(f);
        target = f;
        continue;
      }
      if (/^\s*Doc-tests\s/.test(line)) target = "";
      const t = /^test (\S+) \.\.\. (ok|FAILED|ignored)\b/.exec(line);
      if (t && target)
        observe(target, t[1], t[2] === "ok" ? "pass" : t[2] === "FAILED" ? "fail" : "skip");
    }
  }
  const how = inv.mode === "files" ? `${runner}, by path` : "the registered test command";
  const evidence = Array.isArray(required) ? "identities" : "files";
  if (bad)
    return {
      ran: [],
      unproven: want,
      tests: [],
      failed: [],
      skipped: [],
      missing: [],
      evidence,
      reason: `the replay's proof of execution does not check out (${how}): ${bad}; none of the ${want.length} tester test file(s) counts as run: ${want.join(", ")}`,
    };
  // An identity is credited only when EVERY test observed under it passed: one that also
  // failed or skipped (a retry, or two tests sharing a name: describe "a > b" vs describe
  // "a" > describe "b", a repeated test.each title) is ambiguous, and the passing twin must
  // never stand in for the one that did not run (review 10 follow-up).
  const notPassing = seen.filter((o) => o.status !== "pass");
  const passing = seen.filter(
    (o) => o.status === "pass" && !notPassing.some((x) => sameIdentity(x, o)),
  );
  if (!Array.isArray(required)) {
    const ran = want.filter((f) => fileRan.has(f));
    const unproven = want.filter((f) => !fileRan.has(f));
    // File-level rule: a tester test the runner reports FAILED is red whatever the run's
    // exit status (a registered command that masks it, e.g. a trap or `set +e`).
    const failedSeen = [];
    for (const o of seen.filter((x) => x.status === "fail")) {
      const { status: _s, ...id } = o;
      if (!failedSeen.some((t) => sameIdentity(t, id))) failedSeen.push(id);
    }
    const tests = [];
    for (const o of passing) {
      const { status: _s, ...id } = o;
      if (!tests.some((t) => sameIdentity(t, id))) tests.push(id);
    }
    if (failedSeen.length)
      return {
        ran,
        unproven,
        tests: [],
        failed: failedSeen,
        skipped: [],
        missing: [],
        evidence,
        reason: `${failedSeen.length} tester test(s) failed (${how}): ${fmtIds(failedSeen, "failed")}`,
      };
    return {
      ran,
      unproven,
      tests,
      failed: [],
      skipped: [],
      missing: [],
      evidence,
      reason: unproven.length
        ? `${unproven.length} of ${want.length} tester test file(s) show no evidence they ran (${how}): ${unproven.join(", ")}${oneRunHint}`
        : `every tester test file ran (${how}; file-level evidence only: the tester's PASS recorded no test identities)`,
    };
  }
  const reqs = required.map(normaliseIdentity);
  if (reqs.some((r) => r === null))
    return {
      ran: [],
      unproven: want,
      tests: [],
      failed: [],
      skipped: [],
      missing: [],
      evidence,
      reason:
        "the tester's PASS carries a test identity that is not one; none of its files counts as run",
    };
  if (reqs.length === 0)
    return {
      ran: [],
      unproven: want,
      tests: [],
      failed: [],
      skipped: [],
      missing: [],
      evidence,
      reason: want.length
        ? `the tester's PASS bound no passing test in its ${want.length} test file(s) (${want.join(", ")}): nothing it recorded can be required to pass`
        : "the tester's PASS bound no test",
    };
  const tests = [];
  const failed = [];
  const skipped = [];
  const missing = [];
  for (const r of reqs) {
    const m = seen.filter((o) => sameIdentity(o, r));
    if (m.some((o) => o.status === "fail")) failed.push(r);
    else if (m.length && m.every((o) => o.status === "pass")) {
      const o = m.find((x) => x.status === "pass");
      tests.push({
        ...r,
        ...(o.line ? { line: o.line } : {}),
        ...(o.column ? { column: o.column } : {}),
      });
    } else if (m.length) skipped.push(r);
    else missing.push(r);
  }
  const held = new Set([...failed, ...skipped, ...missing].map((r) => r.file));
  const provenFiles = new Set(tests.map((t) => t.file));
  const ran = want.filter((f) => provenFiles.has(f) && !held.has(f));
  const unproven = want.filter((f) => held.has(f));
  for (const r of [...failed, ...skipped, ...missing])
    if (!want.includes(r.file) && !unproven.includes(r.file)) unproven.push(r.file);
  const parts = [
    fmtIds(failed, "failed"),
    fmtIds(skipped, "skipped, todo or pending: did not run"),
    fmtIds(missing, "missing: no such test ran"),
  ].filter(Boolean);
  return {
    ran,
    unproven,
    tests,
    failed,
    skipped,
    missing,
    evidence,
    reason: parts.length
      ? `${failed.length + skipped.length + missing.length} of the ${reqs.length} test(s) the tester's PASS bound did not pass on the candidate (${how}): ${parts.join("; ")}${missing.length ? oneRunHint : ""}`
      : `every one of the ${reqs.length} test(s) the tester's PASS bound ran and passed (${how})`,
  };
}

function readStdinText() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const opt = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (cmd === "proof") {
    // Which tester files the replay proved ran (see replayProof) → { ran, unproven, reason }.
    const parse = (v) => {
      try {
        return JSON.parse(v || "null");
      } catch {
        return null;
      }
    };
    // `--invocation -` reads it from stdin: it carries the proof key, which must never be
    // on a command line (any process can read those).
    const inv = parse(opt("invocation") === "-" ? readStdinText() : opt("invocation"));
    const files = parse(opt("files-json"));
    if (!inv || !inv.proof || !Array.isArray(files) || !opt("worktree")) {
      process.stdout.write(
        JSON.stringify({
          ran: [],
          unproven: files || [],
          tests: [],
          failed: [],
          reason: "no replay invocation to read",
        }) + "\n",
      );
      process.exit(4);
    }
    // The identities the bound PASS recorded ride on the invocation `apply` printed
    // (`required`, null for an older PASS): every one must execute and pass.
    const required = Array.isArray(inv.required) ? inv.required : null;
    process.stdout.write(
      JSON.stringify(replayProof({ inv, files, worktree: opt("worktree"), required })) + "\n",
    );
    process.exit(0);
  }
  if (cmd !== "apply" && cmd !== "plan") {
    process.stderr.write(
      "usage: tester-replay.mjs apply --db <db> --ticket <n> --repo <path> --pin <sha> --worktree <wt> [--test-cmd <cmd> --base <sha>]\n" +
        "       tester-replay.mjs proof --worktree <wt> --invocation <json | -> --files-json <json>\n",
    );
    process.exit(2);
  }
  const plan = replayPlan({
    dbPath: opt("db") || process.env.DISPATCH_DB,
    ticketNumber: opt("ticket"),
    repoPath: opt("repo"),
    pin: opt("pin"),
  });
  if (plan.ok && plan.run && cmd === "apply") {
    const a = applyTesterTests({
      worktree: opt("worktree"),
      testsHead: plan.tests_head,
      files: plan.files,
    });
    if (!a.ok) {
      process.stdout.write(JSON.stringify({ ...plan, ok: false, reason: a.reason }) + "\n");
      process.exit(4);
    }
    // HOW the replay runs the files, and where its proof of execution will be.
    const tcmd = String(opt("test-cmd") || "").trim();
    if (tcmd && tcmd !== "-") {
      const inv = replayInvocation({
        worktree: opt("worktree"),
        base: opt("base") || "",
        testCommand: tcmd,
        files: plan.files,
      });
      try {
        prepareReplayProof(inv);
      } catch (e) {
        process.stdout.write(
          JSON.stringify({
            ...plan,
            ok: false,
            reason: `the replay's proof directory could not be created (${e.message})`,
          }) + "\n",
        );
        process.exit(4);
      }
      process.stdout.write(
        JSON.stringify({ ...plan, invocation: { ...inv, required: plan.tests } }) + "\n",
      );
      process.exit(0);
    }
  }
  process.stdout.write(JSON.stringify(plan) + "\n");
  process.exit(plan.ok ? 0 : 4);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main(process.argv.slice(2));
