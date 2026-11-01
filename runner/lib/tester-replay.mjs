#!/usr/bin/env node
// =====================================================================
// lib/tester-replay.mjs — replay the independent tester's tests on the LANDING CANDIDATE.
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
//      explicitly with the stack's runner where a file-scoped invocation is well defined,
//      else the registered command (replayInvocation); a failure HOLDS the landing exactly
//      like a red merge gate (tester_replay_red);
//   4. replayProof reads the runner's own evidence that EACH file ran (external review #7):
//      a file with none is not a pass — the landing is held (tester_replay_unverified,
//      naming the files) and the record lists only files proven to have run and passed.
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
//   → one JSON line { ok, run, record, files, tests_ref, tests_head, tested, reason,
//     invocation? } — exit 0 (decided; files applied and, with --test-cmd, the invocation
//     and its proof directory prepared when run) · 4 could not decide / apply (hold).
//   node lib/tester-replay.mjs proof --worktree <wt> --invocation <json | - (stdin)> --files-json <json>
//   → { ran, unproven, reason } (exit 0; 4 when there is no invocation to read).
// =====================================================================
import { spawnSync } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { readTesterEvidence } from "./tester-binding.mjs";

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
 *   → { ok, run, record, files, tests_ref, tests_head, tested, reason }
 * `record` — a bound (agent/system) tester PASS of exactly `pin` is why this lands: the
 * landing records which of its assertions passed on the landed revision. `run` — there are
 * test files to replay. ok:false — the DB or git could not answer (the caller HOLDS).
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
  return {
    ok: true,
    run: t.files.length > 0,
    record: true,
    files: t.files,
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
// runs the tester's files EXPLICITLY with the stack's runner where a file-scoped
// invocation is well defined, and in every case reads POSITIVE evidence per file from the
// runner itself (a node:test reporter's events, a vitest/jest JSON report, pytest's
// per-test node ids, `go list`'s test files, cargo's "Running tests/<name>.rs" line).
// Where no file-scoped invocation is known the registered command runs as before, with the
// signed node:test reporter added through NODE_OPTIONS (its events are the only proof read).
// A tester file with no proof is NOT a pass: the caller holds the landing
// (tester_replay_unverified, naming the files) and records nothing.
//
// FORGERY (external review #7, the reviewer's follow-up). The code under test runs in the
// same process tree as the runner, so anything it can print or write is no proof: a
// delivery whose module exits before the tester's tests register, then prints "✔ …" lines
// or appends reporter-shaped events to a proof file in the worktree, used to be counted as
// "ran". So:
//   • node:test events are SIGNED: the reporter (loaded by the runner's parent process
//     before any test file starts) reads a per-replay key from GAFFER_REPLAY_PROOF_KEY and
//     DELETES it from its environment, so the test files (child processes spawned after)
//     never see it; each event line carries an HMAC of its JSON, a per-process sequence
//     number and a closing count. A line with a bad MAC, a gap, a duplicate or a missing
//     end makes the whole replay unverified. The key is never written to a file and is
//     handed to the proof step on stdin, never on a command line.
//   • the set of files the runner reports must match the files passed on the command line:
//     a by-path run that reports any other file is unverified as a whole (vitest / jest
//     JSON reports are shape-checked the same way: exactly the files requested, a
//     consistent test count).
//   • plain stdout text is never proof for the registered command: only the signed node:test
//     events count there (a vitest / pytest suite behind an unrecognised command holds as
//     unverified; register the runner's own command to replay it by path).
// What this does NOT stop: code that reads another process's environment (/proc/<pid>/
// environ, `ps -E`) as the same user, a node loader module the registered command imports
// into the runner's parent process (--import / --require are kept so TypeScript suites
// run), or code that rewrites a vitest / jest report or a pytest / cargo output line in
// process. Those take a deliberate attack on the replay itself, not a mis-scoped command.

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

/**
 * The command the registered test command runs. A package manager's `test` script
 * (`npm test`, `pnpm test`, `yarn test`, `npm run test`) is read from package.json at the
 * GATED TARGET (`base`, never the branch: a delivery that rewrote `scripts.test` cannot
 * choose how the tester's files run), then the merge's own; anything else is itself.
 */
export function effectiveTestCommand({ worktree, base = "", testCommand }) {
  const cmd = String(testCommand || "").trim();
  const m =
    /^(?:npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?(?:test|t)(?:\s+(?:--\s+)?(.*))?$/.exec(cmd);
  if (!m) return cmd;
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
    try {
      pkg = parse(readFileSync(join(worktree, "package.json"), "utf8"));
    } catch {
      pkg = null;
    }
  }
  const script = pkg && pkg.scripts && typeof pkg.scripts.test === "string" ? pkg.scripts.test : "";
  if (!script.trim()) return cmd;
  return m[1] ? `${script} ${m[1]}` : script;
}

const RUNNER_PATTERNS = {
  "node-test": /(^|[\s;&|(/])node(\.exe)?\s(?:[^;&|]*\s)?--test(?=[\s=]|$)/,
  vitest: /(^|[\s;&|(/])vitest(\s|$)/,
  jest: /(^|[\s;&|(/])jest(\s|$)/,
  pytest: /(^|[\s;&|(/])pytest(\s|$)|(^|[\s;&|(/])python3?\s+-m\s+pytest(\s|$)/,
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

/** The node flags of the registered `node … --test` invocation the replay keeps (loaders). */
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

/** The prefix of a signed proof line, and the env var the reporter reads its key from. */
export const PROOF_TAG = "gaffer-replay-proof";
export const PROOF_KEY_ENV = "GAFFER_REPLAY_PROOF_KEY";

/**
 * The node:test reporter the replay adds: one SIGNED line per test that ran, with its file,
 * then a closing count — `gaffer-replay-proof <hmac-sha256 hex> <json>`. The key comes from
 * the environment and is deleted from it at load (before the runner spawns a test file),
 * so no test process can sign a line. Without a key it signs nothing (no proof).
 */
const NODE_REPORTER = `// gaffer tester replay: which test files ran (written by lib/tester-replay.mjs)
import { createHmac } from "node:crypto";
const KEY = process.env.${PROOF_KEY_ENV} || "";
delete process.env.${PROOF_KEY_ENV};
const line = (o) => {
  const j = JSON.stringify(o);
  return "${PROOF_TAG} " + createHmac("sha256", KEY).update(j).digest("hex") + " " + j + "\\n";
};
export default async function* gafferReplayReporter(source) {
  let seq = 0;
  for await (const ev of source) {
    if (!KEY) continue;
    if ((ev.type === "test:pass" || ev.type === "test:fail") && ev.data && ev.data.file) {
      const d = ev.data;
      yield line({ pid: process.pid, seq: ++seq, type: ev.type, file: String(d.file),
        name: String(d.name ?? ""), skip: Boolean(d.skip), todo: Boolean(d.todo),
        suite: Boolean(d.details && d.details.type === "suite") });
    }
  }
  if (KEY) yield line({ pid: process.pid, type: "end", count: seq });
}
`;

/**
 * HOW the replay runs the tester's `files` in the scratch merge worktree, and where the
 * proof will be: { runner, mode: "files" | "registered", command, env, proof, reason }.
 * `command` runs through bin/dod-regate.sh (the gates' wrap and timeout); `env` is added
 * to its environment; `proof.dir` is a fresh directory inside the worktree.
 */
export function replayInvocation({
  worktree,
  base = "",
  testCommand,
  files,
  nonce = "",
  key = "",
}) {
  const n = nonce || randomBytes(6).toString("hex");
  const dir = join(worktree, `.gaffer-replay-${n}`);
  // The node:test events are signed with this key (NODE_REPORTER); the caller passes it to
  // the run in the environment only (inv.env) and to replayProof on stdin.
  const proofKey = key || randomBytes(32).toString("hex");
  const proof = {
    dir,
    reporter: join(dir, "reporter.mjs"),
    report: join(dir, "report.json"),
    golist: join(dir, "golist.txt"),
    output: join(dir, "output.txt"),
    key: proofKey,
  };
  const effective = effectiveTestCommand({ worktree, base, testCommand });
  const runner = detectRunner(effective);
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
  const registered = (why) => ({
    runner: "registered",
    mode: "registered",
    command: String(testCommand || ""),
    env: {
      NODE_OPTIONS: [process.env.NODE_OPTIONS || "", reporters(nodeOptWord)]
        .filter(Boolean)
        .join(" "),
      [PROOF_KEY_ENV]: proofKey,
    },
    proof,
    effective,
    reason: why,
  });
  const files_ = (command, why) => ({
    runner,
    mode: "files",
    command,
    env: runner === "node-test" ? { [PROOF_KEY_ENV]: proofKey } : {},
    proof,
    effective,
    reason: why,
  });
  switch (runner) {
    case "node-test":
      return files_(
        ["node", ...nodeLoaderFlags(effective), "--test", reporters(shq), list].join(" "),
        "node:test runs the tester's files by path",
      );
    case "vitest":
      return files_(
        `npx --no-install vitest run --reporter=default --reporter=json --outputFile.json=${shq(proof.report)} ${list}`,
        "vitest runs the tester's files by path (a JSON report names each file that ran)",
      );
    case "jest":
      return files_(
        `npx --no-install jest --ci --runTestsByPath --json --outputFile=${shq(proof.report)} ${list}`,
        "jest runs the tester's files by path (a JSON report names each file that ran)",
      );
    case "pytest": {
      const c = ` ${effective} `;
      const prefix = /\spython3\s+-m\s+pytest\s/.test(c)
        ? "python3 -m pytest"
        : /\spython\s+-m\s+pytest\s/.test(c)
          ? "python -m pytest"
          : "pytest";
      return files_(`${prefix} -vv ${list}`, "pytest runs the tester's files by path");
    }
    case "go": {
      const dirs = [...new Set((files || []).map((f) => `./${dirname(f)}`))].map(shq).join(" ");
      const fmt = "{{.Dir}}{{range .TestGoFiles}} {{.}}{{end}}{{range .XTestGoFiles}} {{.}}{{end}}";
      return files_(
        `go list -f ${shq(fmt)} ${dirs} > ${shq(proof.golist)} && go test ${dirs}`,
        "go test runs the packages holding the tester's files (go list names their test files)",
      );
    }
    case "cargo": {
      const names = (files || [])
        .map((f) => /^tests\/([^/]+)\.rs$/.exec(f))
        .filter(Boolean)
        .map((m) => m[1]);
      if (names.length === 0)
        return registered(
          "cargo has no file-scoped invocation for these files (only tests/<name>.rs)",
        );
      return files_(
        `cargo test ${names.map((x) => `--test ${shq(x)}`).join(" ")}`,
        "cargo runs the tester's integration-test targets by name",
      );
    }
    default:
      return registered(
        "no file-scoped invocation is known for this test command: it runs as registered and each tester file needs the runner's own evidence that it ran",
      );
  }
}

/** Create the proof directory (and the node:test reporter) before the replay runs. */
export function prepareReplayProof(inv) {
  rmSync(inv.proof.dir, { recursive: true, force: true });
  mkdirSync(inv.proof.dir, { recursive: true });
  writeFileSync(inv.proof.reporter, NODE_REPORTER);
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
const PYTEST_NODE_ID = /^(\S+?)::\S.*?\s(?:PASSED|FAILED|ERROR|XFAIL|XPASS)\b/;

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

/**
 * Which tester files the replay PROVES ran: { ran, unproven, reason }. Reads only what
 * the runner wrote (see replayInvocation); a file without positive evidence is unproven.
 * An integrity failure — a forged or out-of-sequence node:test line, a by-path run that
 * reports a file it was not given, a malformed report — leaves EVERY file unproven.
 */
export function replayProof({ inv, files, worktree, key }) {
  const want = [...new Set((files || []).map(String))];
  const proven = new Set();
  let bad = "";
  const rels = (p) => [...relSpellings(worktree, p)];
  const requested = (p) => rels(p).some((r) => want.includes(r));
  const mark = (p) => {
    for (const r of rels(p)) if (want.includes(r)) proven.add(r);
  };
  const byPath = inv.mode === "files";
  const runner = inv.runner;
  const output = readText(inv.proof.output);
  const proofKey = key || (inv.proof && inv.proof.key) || "";
  // node:test events (files mode for node, and every registered run through NODE_OPTIONS).
  if (runner === "node-test" || runner === "registered") {
    const sig = signedNodeEvents(output, proofKey);
    bad ||= sig.bad;
    for (const ev of sig.events) {
      // A by-path run is given exactly the tester's files: any other file is a mismatch.
      if (byPath && !requested(ev.file)) {
        bad ||= `the runner reported a file it was not given (${rels(ev.file)[0] || ev.file})`;
        continue;
      }
      if (ev.skip || ev.todo || ev.suite) continue;
      // node reports a file that defines no test as one synthetic test named after it:
      // nothing in it ran.
      if (rels(ev.file).includes(String(ev.name))) continue;
      if (ev.name === ev.file) continue;
      mark(ev.file);
    }
  }
  if (runner === "vitest" || runner === "jest") {
    const rep = jsonReportResults(readText(inv.proof.report));
    bad ||= rep.bad;
    for (const r of rep.results) {
      if (!requested(r.name)) {
        bad ||= `the JSON report names a file that was not requested (${rels(r.name)[0] || r.name})`;
        continue;
      }
      const ran = r.assertionResults.some(
        (a) => a && (a.status === "passed" || a.status === "failed"),
      );
      if (ran) mark(r.name);
    }
  }
  if (runner === "pytest") {
    for (const line of output.split("\n")) {
      const m = PYTEST_NODE_ID.exec(stripAnsi(line));
      if (!m) continue;
      if (!requested(m[1])) {
        bad ||= `pytest reported a file it was not given (${m[1]})`;
        continue;
      }
      mark(m[1]);
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
    for (const f of want) {
      if (!f.endsWith("_test.go")) continue;
      const dir = real(join(worktree, dirname(f)));
      const base = f.slice(f.lastIndexOf("/") + 1);
      if (listed.some(([d, ...names]) => names.includes(base) && real(d) === dir)) proven.add(f);
    }
  }
  if (runner === "cargo") {
    for (const line of output.split("\n")) {
      const m = /^\s*Running\s+(tests\/[^\s]+\.rs)\b/.exec(line);
      if (!m) continue;
      if (!requested(m[1])) {
        bad ||= `cargo ran a test target it was not given (${m[1]})`;
        continue;
      }
      mark(m[1]);
    }
  }
  const how = byPath ? `${runner}, by path` : "the registered test command";
  if (bad)
    return {
      ran: [],
      unproven: want,
      reason: `the replay's proof of execution does not check out (${how}): ${bad} — none of the ${want.length} tester test file(s) counts as run: ${want.join(", ")}`,
    };
  const ran = want.filter((f) => proven.has(f));
  const unproven = want.filter((f) => !proven.has(f));
  return {
    ran,
    unproven,
    reason: unproven.length
      ? `${unproven.length} of ${want.length} tester test file(s) show no evidence they ran (${how}): ${unproven.join(", ")}`
      : `every tester test file ran (${how})`,
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
        JSON.stringify({ ran: [], unproven: files || [], reason: "no replay invocation to read" }) +
          "\n",
      );
      process.exit(4);
    }
    process.stdout.write(
      JSON.stringify(replayProof({ inv, files, worktree: opt("worktree") })) + "\n",
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
      process.stdout.write(JSON.stringify({ ...plan, invocation: inv }) + "\n");
      process.exit(0);
    }
  }
  process.stdout.write(JSON.stringify(plan) + "\n");
  process.exit(plan.ok ? 0 : 4);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main(process.argv.slice(2));
