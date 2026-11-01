#!/usr/bin/env node
// =====================================================================
// TESTER REPLAY PROOF OF EXECUTION (lib/tester-replay.mjs replayInvocation / replayProof)
// ---------------------------------------------------------------------
// External review #7: the replay ran the repo's REGISTERED test command and read only its
// exit code. With a file-scoped command (`node --test test/label.test.mjs`) the tester's
// test/acceptance.test.mjs never executed, the run passed, and the landing recorded that
// file as passed. The replay now runs the tester's files explicitly where the stack's
// runner has a file-scoped invocation, and proves EACH file ran from the runner's own
// evidence; a file with no proof is unproven (the landing holds on it).
//   P1 the effective command: a package-manager `test` script is read from the gated
//      target's package.json (never the branch's), extra args kept;
//   P2 runner detection (node:test, vitest, jest, pytest, go, cargo; two runners or none
//      → the registered command); node's loader flags are kept, filters are not;
//   P3 the invocations: each runner's file-scoped command, the proof directory inside the
//      worktree, NODE_OPTIONS reporters for the registered command;
//   P4 REAL node:test, by path: the tester's file runs even though the registered command
//      names another file, and its events prove it; a file that defines no test is
//      unproven;
//   P5 REAL registered command (a wrapper script running one file): the tester's file did
//      not run and is unproven; a wrapper running every file proves it;
//   P6 vitest / jest JSON reports, pytest node ids, `go list` test files and cargo's
//      "Running tests/<name>.rs" lines prove exactly the files they name.
// Run: node runner/test/tester-replay-proof.test.mjs
// =====================================================================
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gafferMkdtemp } from "./lib/tmpdir.mjs";
import {
  detectRunner,
  effectiveTestCommand,
  nodeLoaderFlags,
  prepareReplayProof,
  replayInvocation,
  replayProof,
} from "../lib/tester-replay.mjs";

let pass = 0;
const fails = [];
function assert(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fails.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const WORK = gafferMkdtemp(join(tmpdir(), "tester-replay-proof-"));
process.on("exit", () => rmSync(WORK, { recursive: true, force: true }));
const git = (cwd, ...a) =>
  spawnSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...a], {
    encoding: "utf8",
  });
const write = (dir, rel, text) => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
const run = (cwd, inv) =>
  spawnSync("bash", ["-c", `${inv.command} > ${JSON.stringify(inv.proof.output)} 2>&1`], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...inv.env },
    timeout: 60_000,
  });

console.log("== P1: the effective test command ==");
const R = join(WORK, "repo");
mkdirSync(R, { recursive: true });
git(R, "init", "-q", "-b", "main");
write(
  R,
  "package.json",
  JSON.stringify({ type: "module", scripts: { test: "node --test test/label.test.mjs" } }),
);
git(R, "add", "-A");
git(R, "commit", "-qm", "init");
const BASE = git(R, "rev-parse", "HEAD").stdout.trim();
// The branch rewrites scripts.test in the worktree: the base's script still decides.
write(R, "package.json", JSON.stringify({ type: "module", scripts: { test: "echo vacuous" } }));
assert(
  "P1: `npm test` reads scripts.test from the gated target, not the worktree",
  effectiveTestCommand({ worktree: R, base: BASE, testCommand: "npm test" }) ===
    "node --test test/label.test.mjs",
);
assert(
  "P1: …and keeps the extra arguments",
  effectiveTestCommand({ worktree: R, base: BASE, testCommand: "pnpm run test -- --x" }) ===
    "node --test test/label.test.mjs --x",
);
assert(
  "P1: without a readable base the merge's own package.json answers",
  effectiveTestCommand({ worktree: R, base: "", testCommand: "npm test" }) === "echo vacuous",
);
assert(
  "P1: any other command is itself",
  effectiveTestCommand({ worktree: R, base: BASE, testCommand: "make check" }) === "make check",
);

console.log("== P2: runner detection ==");
const cases = [
  ["node --test", "node-test"],
  ["node --import tsx --test test/a.test.ts", "node-test"],
  ["NODE_ENV=test node --test-reporter=dot --test", "node-test"],
  ["vitest run", "vitest"],
  ["npx vitest --run", "vitest"],
  ["jest --ci", "jest"],
  ["python -m pytest -q", "pytest"],
  ["pytest tests", "pytest"],
  ["go test ./...", "go"],
  ["cargo test --all", "cargo"],
  ["make test", "registered"],
  ["sh scripts/test.sh", "registered"],
  ["vitest run && node --test", "registered"],
  ["node --test-reporter=dot scripts/x.js", "registered"],
];
for (const [c, want] of cases)
  assert(`P2: ${JSON.stringify(c)} → ${want}`, detectRunner(c) === want, detectRunner(c));
const flags = nodeLoaderFlags(
  "node --import tsx --experimental-strip-types --test-name-pattern=x --test-only --test test/a.test.ts",
);
assert(
  "P2: node's loader flags are kept, test filters and positional files are not",
  JSON.stringify(flags) === JSON.stringify(["--import", "tsx", "--experimental-strip-types"]),
  JSON.stringify(flags),
);

console.log("== P3: the invocations ==");
const files = ["test/acceptance.test.mjs"];
const inv = (testCommand) =>
  replayInvocation({ worktree: R, base: BASE, testCommand, files, nonce: "n1" });
const iNode = inv("npm test");
assert(
  "P3: node:test runs the tester's file by path, with the replay's reporter",
  iNode.mode === "files" &&
    iNode.runner === "node-test" &&
    /^node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter='[^']+\/\.gaffer-replay-n1\/reporter\.mjs' --test-reporter-destination='[^']+\/events\.jsonl' 'test\/acceptance\.test\.mjs'$/.test(
      iNode.command,
    ),
  iNode.command,
);
assert(
  "P3: the proof directory is a fresh one inside the scratch worktree",
  iNode.proof.dir === join(R, ".gaffer-replay-n1"),
);
assert(
  "P3: vitest — `vitest run <files>` with a JSON report",
  /^npx --no-install vitest run .*--outputFile\.json='[^']+report\.json' 'test\/acceptance\.test\.mjs'$/.test(
    inv("vitest run").command,
  ),
  inv("vitest run").command,
);
assert(
  "P3: jest — `--runTestsByPath <files>` with a JSON report",
  /^npx --no-install jest --ci --runTestsByPath --json --outputFile='[^']+' 'test\/acceptance\.test\.mjs'$/.test(
    inv("jest").command,
  ),
);
assert(
  "P3: pytest — the registered interpreter, verbose node ids, the files",
  inv("python3 -m pytest -q").command === "python3 -m pytest -vv 'test/acceptance.test.mjs'",
  inv("python3 -m pytest -q").command,
);
const iGo = replayInvocation({
  worktree: R,
  base: BASE,
  testCommand: "go test ./...",
  files: ["pkg/a/x_test.go"],
  nonce: "n1",
});
assert(
  "P3: go — `go list` the packages' test files, then `go test` those packages",
  /^go list -f '.*' '\.\/pkg\/a' > '[^']+golist\.txt' && go test '\.\/pkg\/a'$/.test(iGo.command),
  iGo.command,
);
const iCargo = replayInvocation({
  worktree: R,
  base: BASE,
  testCommand: "cargo test",
  files: ["tests/accept.rs"],
  nonce: "n1",
});
assert(
  "P3: cargo — `cargo test --test <name>`",
  iCargo.command === "cargo test --test 'accept'",
  iCargo.command,
);
const iCargoSrc = replayInvocation({
  worktree: R,
  base: BASE,
  testCommand: "cargo test",
  files: ["src/lib_test.rs"],
  nonce: "n1",
});
assert("P3: cargo outside tests/ → the registered command", iCargoSrc.mode === "registered");
const iReg = inv("sh scripts/test.sh");
assert(
  "P3: an unknown runner runs the registered command with the reporter in NODE_OPTIONS",
  iReg.mode === "registered" &&
    iReg.command === "sh scripts/test.sh" &&
    /--test-reporter=\S+reporter\.mjs --test-reporter-destination=\S+events\.jsonl$/.test(
      iReg.env.NODE_OPTIONS,
    ),
  JSON.stringify(iReg.env),
);

console.log("== P4: REAL node:test, by path ==");
rmSync(join(R, "package.json"));
git(R, "checkout", "-q", "--", "package.json");
write(R, "test/label.test.mjs", 'import test from "node:test";\ntest("label", () => {});\n');
write(
  R,
  "test/acceptance.test.mjs",
  'import test from "node:test";\nimport assert from "node:assert";\ntest("Ada", () => assert.equal(1, 1));\n',
);
write(R, "test/empty.test.mjs", "// defines no test\n");
const i4 = replayInvocation({
  worktree: R,
  base: BASE,
  testCommand: "npm test",
  files: ["test/acceptance.test.mjs", "test/empty.test.mjs"],
  nonce: "p4",
});
prepareReplayProof(i4);
const r4 = run(R, i4);
const p4 = replayProof({
  inv: i4,
  files: ["test/acceptance.test.mjs", "test/empty.test.mjs"],
  worktree: R,
});
assert("P4: the by-path run passes", r4.status === 0, r4.stderr);
assert(
  "P4: the tester's file ran (although the registered command names another) and is proven",
  p4.ran.includes("test/acceptance.test.mjs"),
  JSON.stringify(p4),
);
assert(
  "P4: a file that defines no test is unproven",
  JSON.stringify(p4.unproven) === '["test/empty.test.mjs"]',
  JSON.stringify(p4),
);
assert("P4: the reason names the unproven file", /test\/empty\.test\.mjs/.test(p4.reason));
write(
  R,
  "test/acceptance.test.mjs",
  'import test from "node:test";\nimport assert from "node:assert";\ntest("Ada", () => assert.equal(undefined, "Ada"));\n',
);
const i4b = replayInvocation({
  worktree: R,
  base: BASE,
  testCommand: "npm test",
  files: ["test/acceptance.test.mjs"],
  nonce: "p4b",
});
prepareReplayProof(i4b);
assert(
  "P4: a failing tester file fails the by-path run (red, not unverified)",
  run(R, i4b).status !== 0,
);

console.log("== P5: REAL registered command (no file-scoped invocation known) ==");
write(R, "test/acceptance.test.mjs", 'import test from "node:test";\ntest("Ada", () => {});\n');
write(R, "scripts/test.sh", "node --test test/label.test.mjs\n");
const i5 = replayInvocation({
  worktree: R,
  base: BASE,
  testCommand: "sh scripts/test.sh",
  files: ["test/acceptance.test.mjs"],
  nonce: "p5",
});
prepareReplayProof(i5);
const r5 = run(R, i5);
const p5 = replayProof({ inv: i5, files: ["test/acceptance.test.mjs"], worktree: R });
assert("P5: the registered command passes", r5.status === 0, r5.stderr);
assert(
  "P5: …but never ran the tester's file: unproven",
  p5.ran.length === 0 && p5.unproven[0] === "test/acceptance.test.mjs",
  JSON.stringify(p5),
);
write(R, "scripts/test.sh", "node --test\n");
const i5b = replayInvocation({
  worktree: R,
  base: BASE,
  testCommand: "sh scripts/test.sh",
  files: ["test/acceptance.test.mjs"],
  nonce: "p5b",
});
prepareReplayProof(i5b);
run(R, i5b);
const p5b = replayProof({ inv: i5b, files: ["test/acceptance.test.mjs"], worktree: R });
assert(
  "P5: a registered command that runs every file proves the tester's file",
  p5b.ran[0] === "test/acceptance.test.mjs" && p5b.unproven.length === 0,
  JSON.stringify(p5b),
);

console.log("== P6: the other runners' evidence ==");
const fake = (runner, nonce, fl = ["x"]) => {
  const i = replayInvocation({
    worktree: R,
    base: BASE,
    testCommand: {
      "node-test": "node --test",
      vitest: "vitest",
      jest: "jest",
      pytest: "pytest",
      go: "go test ./...",
      cargo: "cargo test",
    }[runner],
    files: fl,
    nonce,
  });
  prepareReplayProof(i);
  return i;
};
const iv = fake("vitest", "v");
writeFileSync(
  iv.proof.report,
  JSON.stringify({
    testResults: [
      { name: join(R, "test/a.test.ts"), assertionResults: [{ status: "passed" }] },
      { name: join(R, "test/skipped.test.ts"), assertionResults: [{ status: "skipped" }] },
    ],
  }),
);
const pv = replayProof({
  inv: iv,
  files: ["test/a.test.ts", "test/skipped.test.ts", "test/missing.test.ts"],
  worktree: R,
});
assert(
  "P6: vitest JSON proves the file it ran",
  JSON.stringify(pv.ran) === '["test/a.test.ts"]',
  JSON.stringify(pv),
);
assert(
  "P6: …not a file whose tests were all skipped, nor one it never named",
  JSON.stringify(pv.unproven) === '["test/skipped.test.ts","test/missing.test.ts"]',
);
const ij = fake("jest", "j");
writeFileSync(
  ij.proof.report,
  JSON.stringify({
    testResults: [{ name: join(R, "test/b.test.js"), assertionResults: [{ status: "failed" }] }],
  }),
);
assert(
  "P6: jest JSON proves the file it ran",
  replayProof({ inv: ij, files: ["test/b.test.js"], worktree: R }).ran[0] === "test/b.test.js",
);
const ip = fake("pytest", "p");
writeFileSync(
  ip.proof.output,
  "tests/test_a.py::test_x PASSED  [ 50%]\ntests/test_b.py::test_y SKIPPED [100%]\n",
);
const pp = replayProof({ inv: ip, files: ["tests/test_a.py", "tests/test_b.py"], worktree: R });
assert(
  "P6: pytest node ids prove the file that ran, not the skipped one",
  JSON.stringify(pp.ran) === '["tests/test_a.py"]' && pp.unproven[0] === "tests/test_b.py",
  JSON.stringify(pp),
);
const ig = fake("go", "g");
mkdirSync(join(R, "pkg/a"), { recursive: true });
writeFileSync(ig.proof.golist, `${join(R, "pkg/a")} a_test.go other_test.go\n`);
const pg = replayProof({
  inv: ig,
  files: ["pkg/a/a_test.go", "pkg/a/tagged_test.go", "pkg/a/helper.go"],
  worktree: R,
});
assert(
  "P6: go list proves a test file compiled into its package; a build-tagged or non-test file is unproven",
  JSON.stringify(pg.ran) === '["pkg/a/a_test.go"]' && pg.unproven.length === 2,
  JSON.stringify(pg),
);
const ic = fake("cargo", "c", ["tests/accept.rs"]);
writeFileSync(ic.proof.output, "     Running tests/accept.rs (target/debug/deps/accept-1)\n");
assert(
  "P6: cargo's Running line proves the integration test it ran",
  JSON.stringify(
    replayProof({ inv: ic, files: ["tests/accept.rs", "tests/other.rs"], worktree: R }).ran,
  ) === '["tests/accept.rs"]',
);
const ir = fake("registered", "r");
writeFileSync(
  ir.proof.output,
  " ✓ test/c.test.ts (2 tests) 3ms\nPASS test/d.test.js\nsome line mentioning test/e.test.js\n",
);
const pr = replayProof({
  inv: ir,
  files: ["test/c.test.ts", "test/d.test.js", "test/e.test.js"],
  worktree: R,
});
assert(
  "P6: a registered run's per-file runner lines prove those files; a mere mention does not",
  JSON.stringify(pr.ran) === '["test/c.test.ts","test/d.test.js"]' &&
    pr.unproven[0] === "test/e.test.js",
  JSON.stringify(pr),
);

console.log();
if (fails.length === 0) {
  console.log(`tester-replay-proof: ALL ${pass} checks passed`);
  process.exit(0);
}
console.log(`tester-replay-proof: ${fails.length} FAILURE(S):`);
for (const f of fails) console.log(`  - ${f}`);
process.exit(1);
