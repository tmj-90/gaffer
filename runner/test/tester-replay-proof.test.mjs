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
//      "Running tests/<name>.rs" lines prove exactly the files they name; a registered
//      command's plain output lines prove nothing;
//   P7 FORGERY (the reviewer's follow-up): code under test that stops the tester's file
//      before its tests register and prints / writes "passed" evidence for it — runner
//      lines, reporter-shaped events, a line with a wrong signature — leaves the file
//      unproven, by path and through the registered command; the test processes never
//      see the signing key; a reported file that was not requested, a replayed line or a
//      report naming an extra file / a wrong count makes the whole replay unverified.
// Run: node runner/test/tester-replay-proof.test.mjs
// =====================================================================
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gafferMkdtemp } from "./lib/tmpdir.mjs";
import * as TR from "../lib/tester-replay.mjs";
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
    /^node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter='[^']+\/\.gaffer-replay-n1\/reporter\.mjs' --test-reporter-destination=stdout 'test\/acceptance\.test\.mjs'$/.test(
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
    /--test-reporter=\S+reporter\.mjs --test-reporter-destination=stdout$/.test(
      iReg.env.NODE_OPTIONS,
    ) &&
    /^[0-9a-f]{64}$/.test(iReg.env.GAFFER_REPLAY_PROOF_KEY || ""),
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
    numTotalTests: 2,
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
    numTotalTests: 1,
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
  "P6: a registered run's plain output lines prove nothing (anything the tests print can look like them)",
  pr.ran.length === 0 && pr.unproven.length === 3,
  JSON.stringify(pr),
);

console.log("== P7: forged evidence ==");
const TAG = TR.PROOF_TAG || "gaffer-replay-proof";
// The delivery's src/label.js: when the tester's file imports it, it prints / writes
// "passed" evidence for that file, in every shape a runner uses, and exits before the
// file's tests register (so none of them runs). A detached helper appends a reporter-shaped
// event to any proof file in the worktree once the runner has written there.
const FORGER = `import { spawn } from "node:child_process";
import { readdirSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
const me = resolve("test/acceptance.test.mjs");
const ev = JSON.stringify({ pid: process.ppid, seq: 1, type: "test:pass", file: me, name: "the label is Ada", skip: false, todo: false, suite: false });
const helper = \`const fs = require("fs"); const t0 = Date.now();
const tick = () => { for (const d of fs.readdirSync(".")) if (d.startsWith(".gaffer-replay-")) for (const f of ["events.jsonl", "output.txt"]) { try { if (fs.statSync(d + "/" + f).size > 0) { fs.appendFileSync(d + "/" + f, \${JSON.stringify(ev + "\\n")}); return; } } catch {} } if (Date.now() - t0 < 4000) setImmediate(tick); };
tick();\`;
spawn(process.execPath, ["-e", helper], { detached: true, stdio: "ignore" }).unref();
for (const d of readdirSync(".")) if (d.startsWith(".gaffer-replay-")) { try { appendFileSync(d + "/events.jsonl", ev + "\\n"); } catch {} }
console.log("✔ the label is Ada (0.1ms)");
console.log(" ✓ test/acceptance.test.mjs (1 test) 1ms");
console.log("PASS test/acceptance.test.mjs");
console.log(ev);
console.log("${TAG} " + "0".repeat(64) + " " + ev);
console.log("key seen by the test process: " + JSON.stringify(process.env.GAFFER_REPLAY_PROOF_KEY ?? null));
await new Promise((r) => setTimeout(r, 300));
process.exit(0);
export function label() { return "Ada"; }
`;
const F = join(WORK, "forge");
mkdirSync(F, { recursive: true });
git(F, "init", "-q", "-b", "main");
write(F, "package.json", JSON.stringify({ type: "module" }));
write(F, "src/label.js", FORGER);
write(F, "test/label.test.mjs", 'import test from "node:test";\ntest("label", () => {});\n');
write(
  F,
  "test/acceptance.test.mjs",
  'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { label } from "../src/label.js";\ntest("the label is Ada", () => assert.equal(label(), "Ada"));\n',
);
write(F, "scripts/test.sh", "node --test test/acceptance.test.mjs\n");
const forged = (testCommand, nonce) => {
  const i = replayInvocation({
    worktree: F,
    testCommand,
    files: ["test/acceptance.test.mjs"],
    nonce,
  });
  prepareReplayProof(i);
  const r = run(F, i);
  // Give the detached helper time to append to the proof files the runner wrote.
  spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 600)"]);
  return { i, r, p: replayProof({ inv: i, files: ["test/acceptance.test.mjs"], worktree: F }) };
};
const f1 = forged("node --test test/label.test.mjs", "f1");
assert("P7: (fixture) the by-path run exits 0 although no tester assertion ran", f1.r.status === 0);
assert(
  "P7: by path — forged runner lines and events for the tester's file leave it UNPROVEN",
  f1.p.ran.length === 0 && f1.p.unproven[0] === "test/acceptance.test.mjs",
  JSON.stringify(f1.p),
);
assert(
  "P7: the tester's test process never sees the signing key",
  /key seen by the test process: null/.test(readFileSync(f1.i.proof.output, "utf8")),
  readFileSync(f1.i.proof.output, "utf8").slice(0, 600),
);
const f2 = forged("sh scripts/test.sh", "f2");
assert(
  "P7: the registered command — the same forgery leaves the tester's file UNPROVEN",
  f2.i.mode === "registered" && f2.p.ran.length === 0 && f2.p.unproven.length === 1,
  JSON.stringify(f2.p),
);
// Control: the honest module, same commands — the file is proven.
write(F, "src/label.js", 'export function label() { return "Ada"; }\n');
const f3 = forged("node --test test/label.test.mjs", "f3");
const f4 = forged("sh scripts/test.sh", "f4");
assert(
  "P7: control — the honest delivery proves the tester's file (by path and registered)",
  f3.p.ran[0] === "test/acceptance.test.mjs" && f4.p.ran[0] === "test/acceptance.test.mjs",
  JSON.stringify([f3.p, f4.p]),
);
// Signed lines (as the reporter writes them) checked for integrity.
const signed = (key, o) => {
  const j = JSON.stringify(o);
  return `${TAG} ${createHmac("sha256", key).update(j).digest("hex")} ${j}\n`;
};
const fakeNode = (nonce, lines) => {
  const i = replayInvocation({
    worktree: F,
    testCommand: "node --test",
    files: ["test/acceptance.test.mjs"],
    nonce,
  });
  prepareReplayProof(i);
  writeFileSync(i.proof.output, lines(i.proof.key).join(""));
  return replayProof({ inv: i, files: ["test/acceptance.test.mjs"], worktree: F });
};
const acc = join(F, "test/acceptance.test.mjs");
const okEv = {
  pid: 7,
  seq: 1,
  type: "test:pass",
  file: acc,
  name: "Ada",
  skip: false,
  todo: false,
  suite: false,
};
const g1 = fakeNode("g1", (k) => [signed(k, okEv), signed(k, { pid: 7, type: "end", count: 1 })]);
assert(
  "P7: a well-signed run proves its file",
  g1.ran[0] === "test/acceptance.test.mjs",
  JSON.stringify(g1),
);
const g2 = fakeNode("g2", (k) => [
  signed(k, okEv),
  signed(k, { ...okEv, seq: 2, file: join(F, "test/label.test.mjs"), name: "label" }),
  signed(k, { pid: 7, type: "end", count: 2 }),
]);
assert(
  "P7: by path, the runner reporting a file it was not given → the whole replay unverified",
  g2.ran.length === 0 && /not given/.test(g2.reason),
  JSON.stringify(g2),
);
const g3 = fakeNode("g3", (k) => [
  signed(k, okEv),
  signed(k, okEv),
  signed(k, { pid: 7, type: "end", count: 1 }),
]);
assert("P7: a replayed (duplicate) line → unverified", g3.ran.length === 0, JSON.stringify(g3));
const g4 = fakeNode("g4", (k) => [signed(k, okEv)]);
assert("P7: no closing count → unverified", g4.ran.length === 0, JSON.stringify(g4));
const g5 = fakeNode("g5", (k) => [
  signed(k, okEv),
  signed(k, { pid: 7, type: "end", count: 1 }),
  signed("not-the-key", { ...okEv, pid: 8 }),
]);
assert("P7: a line signed with another key → unverified", g5.ran.length === 0, JSON.stringify(g5));
const iv7 = fake("vitest", "v7", ["test/a.test.ts"]);
writeFileSync(
  iv7.proof.report,
  JSON.stringify({
    numTotalTests: 2,
    testResults: [
      { name: join(R, "test/a.test.ts"), assertionResults: [{ status: "passed" }] },
      { name: join(R, "test/other.test.ts"), assertionResults: [{ status: "passed" }] },
    ],
  }),
);
const pv7 = replayProof({ inv: iv7, files: ["test/a.test.ts"], worktree: R });
assert(
  "P7: a vitest report naming a file that was not requested → unverified",
  pv7.ran.length === 0 && pv7.unproven[0] === "test/a.test.ts",
  JSON.stringify(pv7),
);
writeFileSync(
  iv7.proof.report,
  JSON.stringify({
    numTotalTests: 5,
    testResults: [{ name: join(R, "test/a.test.ts"), assertionResults: [{ status: "passed" }] }],
  }),
);
assert(
  "P7: a report whose test count does not match its results → unverified",
  replayProof({ inv: iv7, files: ["test/a.test.ts"], worktree: R }).ran.length === 0,
);
writeFileSync(
  iv7.proof.report,
  JSON.stringify({
    testResults: [{ name: join(R, "test/a.test.ts"), assertionResults: [{ status: "passed" }] }],
  }),
);
assert(
  "P7: a report without the runner's shape (no test count) → unverified",
  replayProof({ inv: iv7, files: ["test/a.test.ts"], worktree: R }).ran.length === 0,
);
void appendFileSync;

console.log();
if (fails.length === 0) {
  console.log(`tester-replay-proof: ALL ${pass} checks passed`);
  process.exit(0);
}
console.log(`tester-replay-proof: ${fails.length} FAILURE(S):`);
for (const f of fails) console.log(`  - ${f}`);
process.exit(1);
