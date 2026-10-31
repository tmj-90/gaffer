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
//   3. the caller runs the repo's test command there through bin/dod-regate.sh (tests only),
//      and a failure HOLDS the landing exactly like a red merge gate (tester_replay_red).
// No tester PASS bound to the pinned commit → nothing extra runs and no record is due (the
// ticket was not in the testing lane, or a human waived it). A bound PASS with no test
// files on record still records the replay (the candidate passed the repo's own suite,
// which is all the tester ran). Fail CLOSED: an unreadable DB or a git error HOLDS.
//
// CLI (lib/land.sh):
//   node lib/tester-replay.mjs apply --db <dispatch.sqlite> --ticket <n> --repo <path>
//        --pin <sha> --worktree <scratch merge worktree>
//   → one JSON line { ok, run, record, files, tests_ref, tests_head, tested, reason }
//     exit 0 (decided; files applied when run) · 4 could not decide / apply (hold).
// =====================================================================
import { spawnSync } from "node:child_process";
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
  const t = testerTestsOnRecord({ repoPath, ticketNumber, testedCommit: tested });
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

function main(argv) {
  const [cmd, ...rest] = argv;
  const opt = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (cmd !== "apply" && cmd !== "plan") {
    process.stderr.write(
      "usage: tester-replay.mjs apply --db <db> --ticket <n> --repo <path> --pin <sha> --worktree <wt>\n",
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
  }
  process.stdout.write(JSON.stringify(plan) + "\n");
  process.exit(plan.ok ? 0 : 4);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main(process.argv.slice(2));
