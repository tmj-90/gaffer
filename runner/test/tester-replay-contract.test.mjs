#!/usr/bin/env node
// =====================================================================
// TESTER REPLAY: THE REGISTERED COMMAND IS AN EXECUTION CONTRACT, AND A PASS BINDS TEST
// IDENTITIES (external review 10, lib/tester-replay.mjs replayInvocation / replayProof)
// ---------------------------------------------------------------------
// The landing replay used to rebuild a GENERIC command from the detected runner
// (`node --test <files>`, `npx vitest run <files>`, `pytest -vv <files>`, `go test <dirs>`,
// `cargo test --test <name>`), dropping the registered command's env assignments, config
// files, markers, build tags, features and toolchain. And the proof marked a FILE as run
// when any one assertion in it passed. Together: the registered env/config enables the
// substantive assertion, the replay drops it, that assertion skips, a smoke test in the
// same file passes, the file counts as replayed and the landing records a green.
//   C1 every dropped-semantic class, per runner (table-driven on replayInvocation): the
//      registered command runs as registered, the runner's own file selection and proof
//      reporter appended;
//   C2 commands the replay cannot extend safely (pipelines, a runner before `&&`/`||`/`;`,
//      two runners, a runner behind a wrapper or substitution the parser cannot see) run
//      as registered, and give no green without the runner's own evidence;
//   C3 the COMBINED COUNTEREXAMPLE, real node:test and real vitest: the env/config-gated
//      required assertion runs with the registered semantics (red when it fails on the
//      candidate, green when it passes), never a skipped assertion behind a passing smoke;
//   C4 identity binding: a required identity renamed, deleted, skipped or failed on the
//      candidate holds; an extra test does not stand in for a missing one;
//   C5 the identities each runner reports (node:test, vitest, jest, pytest, go, cargo),
//      parser level, and real pytest / go where they are installed.
// Run: node runner/test/tester-replay-contract.test.mjs
// =====================================================================
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { gafferMkdtemp } from "./lib/tmpdir.mjs";
import * as TR from "../lib/tester-replay.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

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

const WORK = gafferMkdtemp(join(tmpdir(), "tester-replay-contract-"));
process.on("exit", () => rmSync(WORK, { recursive: true, force: true }));
const git = (cwd, ...a) =>
  spawnSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...a], {
    encoding: "utf8",
  });
const write = (dir, rel, text) => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
const has = (bin) => spawnSync("bash", ["-c", `command -v ${bin}`]).status === 0;
// Run an invocation the way bin/dod-regate.sh does (bash -c in the worktree, the
// invocation's env added), keeping its combined output where the proof reads it.
const run = (cwd, inv) => {
  const r = spawnSync("bash", ["-c", inv.command], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...inv.env, CI: "1" },
    timeout: 120_000,
  });
  writeFileSync(inv.proof.output, `${r.stdout || ""}${r.stderr || ""}`);
  return r;
};
const fresh = (name, pkg = { type: "module" }) => {
  const d = join(WORK, name);
  mkdirSync(d, { recursive: true });
  git(d, "init", "-q", "-b", "main");
  write(d, "package.json", JSON.stringify(pkg));
  git(d, "add", "-A");
  git(d, "commit", "-qm", "init");
  return d;
};
const inv = (worktree, testCommand, files, extra = {}) => {
  const i = TR.replayInvocation({ worktree, testCommand, files, nonce: "c", ...extra });
  TR.prepareReplayProof(i);
  return i;
};

console.log("== C1: the registered semantics survive, per runner ==");
const W = fresh("c1", {
  type: "module",
  scripts: { test: "PROFILE_API_V2=1 node --test test/smoke.test.mjs" },
});
const BASE = git(W, "rev-parse", "HEAD").stdout.trim();
const ACC = ["test/acceptance.test.mjs"];
const contract = [
  // [label, registered, files, must contain (in order), runner]
  [
    "node: a leading env assignment",
    "PROFILE_API_V2=1 node --test",
    ACC,
    ["PROFILE_API_V2=1 node --test", "'test/acceptance.test.mjs'"],
    "node-test",
  ],
  [
    "node: loader and env-file flags",
    "node --env-file=.env.test --import tsx --test",
    ACC,
    ["node --env-file=.env.test --import tsx --test", "'test/acceptance.test.mjs'"],
    "node-test",
  ],
  [
    "node: the package script, env assignment included (npm test)",
    "npm test",
    ACC,
    [
      "PROFILE_API_V2=1 node --test",
      "--test-reporter=",
      "test/smoke.test.mjs",
      "'test/acceptance.test.mjs'",
    ],
    "node-test",
  ],
  [
    "vitest: --config / -c",
    "vitest run --config vitest.ci.config.mjs",
    ["test/a.test.ts"],
    ["vitest run --config vitest.ci.config.mjs", "--outputFile.json=", "'test/a.test.ts'"],
    "vitest",
  ],
  [
    "vitest: -c, --root, --environment and an env prefix",
    "API_V2=1 npx vitest run -c ci.mjs --root app --environment jsdom",
    ["test/a.test.ts"],
    [
      "API_V2=1 npx vitest run -c ci.mjs --root app --environment jsdom",
      "--reporter=json",
      "'test/a.test.ts'",
    ],
    "vitest",
  ],
  [
    "jest: --config and --selectProjects",
    "jest --config jest.ci.config.js --selectProjects api",
    ["test/a.test.js"],
    [
      "jest --config jest.ci.config.js --selectProjects api",
      "--json --outputFile=",
      "--runTestsByPath 'test/a.test.js'",
    ],
    "jest",
  ],
  [
    "pytest: a marker, a plugin, an ini override, --rootdir and -c",
    `python3 -m pytest -m "not slow" -p no:cacheprovider -o addopts= --rootdir . -c pytest.ci.ini`,
    ["tests/test_a.py"],
    [
      `python3 -m pytest -m "not slow" -p no:cacheprovider -o addopts= --rootdir . -c pytest.ci.ini`,
      "-vv",
      "'tests/test_a.py'",
    ],
    "pytest",
  ],
  [
    "go: -tags, -race and -run, ./... replaced by the tester's package",
    "go test -tags integration -race -run 'TestAPI' ./...",
    ["pkg/a/a_test.go"],
    ["go test -json -tags integration -race -run 'TestAPI' './pkg/a'"],
    "go",
  ],
  [
    "go: an env prefix and a package list",
    "CGO_ENABLED=0 go test -count=1 ./pkg/... ./cmd/...",
    ["pkg/a/a_test.go"],
    ["CGO_ENABLED=0 go test -json -count=1 './pkg/a'"],
    "go",
  ],
  [
    "cargo: +toolchain, --features, --manifest-path and -p",
    "cargo +nightly test --features api-v2 --manifest-path Cargo.toml -p app",
    ["tests/accept.rs"],
    ["cargo +nightly test --features api-v2 --manifest-path Cargo.toml -p app", "--test 'accept'"],
    "cargo",
  ],
  [
    "cargo: --all-features, the test binary's args stay after --",
    "cargo test --all-features -- --nocapture",
    ["tests/accept.rs"],
    ["cargo test --all-features --test 'accept' -- --nocapture"],
    "cargo",
  ],
];
for (const [label, cmd, files, wants, runner] of contract) {
  const i = TR.replayInvocation({ worktree: W, base: BASE, testCommand: cmd, files, nonce: "c1" });
  let at = 0;
  let ok = i.mode === "files" && i.runner === runner;
  for (const w of wants) {
    const k = i.command.indexOf(w, at);
    if (k < 0) ok = false;
    else at = k + w.length;
  }
  assert(`C1: ${label}`, ok, `${i.mode}/${i.runner}: ${i.command}`);
}
const iGo = TR.replayInvocation({
  worktree: W,
  base: BASE,
  testCommand: "go test -tags integration ./...",
  files: ["pkg/a/a_test.go"],
  nonce: "c1",
});
assert(
  "C1: go names the tester's packages' test files first (go list) with the same build tags",
  /^go list -tags integration -f '[^']+' '\.\/pkg\/a' > '[^']+golist\.txt' && go test -json -tags integration '\.\/pkg\/a'$/.test(
    iGo.command,
  ),
  iGo.command,
);
const iScript = TR.replayInvocation({
  worktree: W,
  base: BASE,
  testCommand: "npm test",
  files: ACC,
  nonce: "c1",
});
assert(
  "C1: a package script runs with the worktree's node_modules/.bin on PATH (as the package manager would)",
  /^PATH="\$PWD\/node_modules\/\.bin:\$PATH"; PROFILE_API_V2=1 node --test --test-reporter=.* test\/smoke\.test\.mjs 'test\/acceptance\.test\.mjs'$/.test(
    iScript.command,
  ),
  iScript.command,
);
const iClean = TR.replayInvocation({
  worktree: W,
  base: BASE,
  testCommand: "vitest run --config ci.mjs",
  files: ["test/a.test.ts"],
  nonce: "c1",
  select: false,
});
assert(
  "C1: the clean replay (select:false) runs the registered command with only the proof reporter added",
  iClean.mode === "files" &&
    /^vitest run --config ci\.mjs --reporter=default --reporter=json --outputFile\.json='[^']+'$/.test(
      iClean.command,
    ),
  iClean.command,
);

console.log("== C2: commands the replay cannot extend run as registered ==");
for (const cmd of [
  "vitest run | tee vitest.log",
  "node --test || true",
  "node --test; echo done",
  "vitest run && jest",
  'bash -c "vitest run"',
  "$(npm bin)/vitest run",
  "`npm bin`/jest",
  "make test",
  "(cd app && vitest run)",
  "vitest run &",
]) {
  const i = TR.replayInvocation({
    worktree: W,
    base: BASE,
    testCommand: cmd,
    files: ACC,
    nonce: "c2",
  });
  assert(
    `C2: ${JSON.stringify(cmd)} runs as registered (the signed node:test reporter in NODE_OPTIONS)`,
    i.mode === "registered" &&
      i.command === cmd &&
      /--test-reporter=/.test(i.env.NODE_OPTIONS || ""),
    `${i.mode}: ${i.command}`,
  );
}
const iChain = TR.replayInvocation({
  worktree: W,
  base: BASE,
  testCommand: "npm run build && vitest run",
  files: ["test/a.test.ts"],
  nonce: "c2",
});
assert(
  "C2: a chain whose LAST command is the runner is extended there",
  iChain.mode === "files" &&
    /^npm run build && vitest run .*'test\/a\.test\.ts'$/.test(iChain.command),
  iChain.command,
);
// A pipeline gives no node:test evidence for a vitest suite: no green.
const P = fresh("c2p");
write(P, "test/acceptance.test.mjs", 'import test from "node:test";\ntest("ok", () => {});\n');
const iPipe = inv(P, "node --test test/none.test.mjs 2>&1 | cat", ACC);
run(P, iPipe);
const pPipe = TR.replayProof({
  inv: iPipe,
  files: ACC,
  worktree: P,
  required: [{ file: "test/acceptance.test.mjs", name: "ok" }],
});
assert(
  "C2: a pipeline that never ran the tester's file yields no green (its identity is missing)",
  iPipe.mode === "registered" && pPipe.ran.length === 0 && pPipe.unproven.length === 1,
  JSON.stringify(pPipe),
);

console.log("== C3: the combined counterexample (real node:test) ==");
// The registered command's env enables the substantive assertion; without it the
// assertion skips. A smoke test in the same file passes either way.
const N = fresh("c3n");
const ACCEPT_NODE = `import test from "node:test";
import assert from "node:assert/strict";
import { profile } from "../src/profile.js";
test("the module loads", () => assert.equal(typeof profile, "function"));
test("the v2 profile is named Ada", { skip: !process.env.PROFILE_API_V2 }, () => assert.equal(profile().name, "Ada"));
`;
write(N, "test/acceptance.test.mjs", ACCEPT_NODE);
const nodeCmd = "PROFILE_API_V2=1 node --test test/smoke.test.mjs";
write(N, "test/smoke.test.mjs", 'import test from "node:test";\ntest("smoke", () => {});\n');
// The candidate: the v2 profile lost its name (the assertion the tester bound FAILS).
write(N, "src/profile.js", "export function profile() { return { name: undefined }; }\n");
const REQ_NODE = [
  { file: "test/acceptance.test.mjs", name: "the module loads" },
  { file: "test/acceptance.test.mjs", name: "the v2 profile is named Ada" },
];
const n1 = inv(N, nodeCmd, ACC);
const rn1 = run(N, n1);
const pn1 = TR.replayProof({ inv: n1, files: ACC, worktree: N, required: REQ_NODE });
assert(
  "C3 node: the registered env reaches the replay: the bound assertion RUNS and fails (red, no record)",
  rn1.status !== 0 && pn1.ran.length === 0,
  `rc=${rn1.status} ${n1.command} ${JSON.stringify(pn1)}`,
);
assert(
  "C3 node: …and the proof names it as failed, not as skipped",
  JSON.stringify((pn1.failed || []).map((t) => t.name)) === '["the v2 profile is named Ada"]',
  JSON.stringify(pn1),
);
// The same candidate with the name back: green, and every bound identity is proven.
write(N, "src/profile.js", 'export function profile() { return { name: "Ada" }; }\n');
const n2 = inv(N, nodeCmd, ACC);
const rn2 = run(N, n2);
const pn2 = TR.replayProof({ inv: n2, files: ACC, worktree: N, required: REQ_NODE });
assert(
  "C3 node: with the assertion passing on the candidate the replay is green with both identities",
  rn2.status === 0 &&
    JSON.stringify(pn2.ran) === JSON.stringify(ACC) &&
    JSON.stringify((pn2.tests || []).map((t) => t.name).sort()) ===
      JSON.stringify(REQ_NODE.map((t) => t.name).sort()),
  `rc=${rn2.status} ${JSON.stringify(pn2)}`,
);
// A replay that drops the env (the generic rebuild) skips the bound assertion: held,
// never green, even though the smoke test in the same file passed.
const n3 = inv(N, "node --test test/smoke.test.mjs", ACC);
run(N, n3);
const pn3 = TR.replayProof({ inv: n3, files: ACC, worktree: N, required: REQ_NODE });
assert(
  "C3 node: a run in which the bound assertion SKIPS is unproven (held), though the smoke passed",
  pn3.ran.length === 0 &&
    JSON.stringify((pn3.skipped || []).map((t) => t.name)) === '["the v2 profile is named Ada"]',
  JSON.stringify(pn3),
);

console.log("== C3: the combined counterexample (real vitest, --config enables it) ==");
const VITEST_MODS = join(ROOT, "packages", "dispatch", "node_modules");
if (!existsSync(join(VITEST_MODS, ".bin", "vitest"))) {
  console.log("  SKIP C3 vitest: packages/dispatch has no vitest installed");
} else {
  const V = fresh("c3v");
  symlinkSync(VITEST_MODS, join(V, "node_modules"));
  write(V, "vitest.ci.config.mjs", 'export default { test: { env: { PROFILE_API_V2: "1" } } };\n');
  write(V, "test/smoke.test.mjs", 'import { it } from "vitest";\nit("smoke", () => {});\n');
  write(
    V,
    "test/acceptance.test.mjs",
    `import { describe, it, expect } from "vitest";
import { profile } from "../src/profile.js";
it("the module loads", () => expect(typeof profile).toBe("function"));
describe("v2", () => {
  it.skipIf(!process.env.PROFILE_API_V2)("the profile is named Ada", () => expect(profile().name).toBe("Ada"));
});
`,
  );
  write(V, "src/profile.js", "export function profile() { return { name: undefined }; }\n");
  const vCmd = "vitest run --config vitest.ci.config.mjs test/smoke.test.mjs";
  const REQ_V = [
    { file: "test/acceptance.test.mjs", name: "the module loads" },
    { file: "test/acceptance.test.mjs", name: "v2 > the profile is named Ada" },
  ];
  const vrun = (cmd) => {
    const i = TR.replayInvocation({ worktree: V, testCommand: cmd, files: ACC, nonce: "v" });
    TR.prepareReplayProof(i);
    // vitest is found where the package manager would put it.
    const r = spawnSync("bash", ["-c", `PATH="$PWD/node_modules/.bin:$PATH"; ${i.command}`], {
      cwd: V,
      encoding: "utf8",
      env: { ...process.env, ...i.env, CI: "1" },
      timeout: 120_000,
    });
    writeFileSync(i.proof.output, `${r.stdout || ""}${r.stderr || ""}`);
    return { i, r, p: TR.replayProof({ inv: i, files: ACC, worktree: V, required: REQ_V }) };
  };
  const v1 = vrun(vCmd);
  assert(
    "C3 vitest: --config reaches the replay: the bound assertion RUNS and fails (red, no record)",
    v1.r.status !== 0 && v1.p.ran.length === 0,
    `rc=${v1.r.status} ${v1.i.command} ${JSON.stringify(v1.p)} ${(v1.r.stdout || "").slice(-400)}`,
  );
  write(V, "src/profile.js", 'export function profile() { return { name: "Ada" }; }\n');
  const v2 = vrun(vCmd);
  assert(
    "C3 vitest: with the assertion passing the replay is green with both identities",
    v2.r.status === 0 &&
      JSON.stringify(v2.p.ran) === JSON.stringify(ACC) &&
      (v2.p.tests || []).length === 2,
    `rc=${v2.r.status} ${JSON.stringify(v2.p)} ${(v2.r.stdout || "").slice(-400)}`,
  );
  const v3 = vrun("vitest run test/smoke.test.mjs");
  assert(
    "C3 vitest: a run without the config skips the bound assertion: unproven (held), not green",
    v3.r.status === 0 && v3.p.ran.length === 0 && (v3.p.skipped || []).length === 1,
    `rc=${v3.r.status} ${JSON.stringify(v3.p)}`,
  );
}

console.log("== C4: identity binding ==");
const B = fresh("c4");
const two = `import test from "node:test";
test("smoke", () => {});
test("the label is Ada", () => {});
`;
const req = [
  { file: "test/acceptance.test.mjs", name: "smoke" },
  { file: "test/acceptance.test.mjs", name: "the label is Ada" },
];
const prove = (body, nonce, required = req) => {
  write(B, "test/acceptance.test.mjs", body);
  const i = TR.replayInvocation({ worktree: B, testCommand: "node --test", files: ACC, nonce });
  TR.prepareReplayProof(i);
  run(B, i);
  return TR.replayProof({ inv: i, files: ACC, worktree: B, required });
};
const b0 = prove(two, "b0");
assert(
  "C4: control: both bound identities pass → proven",
  b0.ran.length === 1 && b0.unproven.length === 0,
  JSON.stringify(b0),
);
const b1 = prove(two.replace("the label is Ada", "the label is Bob"), "b1");
assert(
  "C4: a bound identity RENAMED on the candidate is missing → held, the identity named",
  b1.ran.length === 0 && /the label is Ada/.test(b1.reason) && (b1.missing || []).length === 1,
  JSON.stringify(b1),
);
const b2 = prove('import test from "node:test";\ntest("smoke", () => {});\n', "b2");
assert(
  "C4: a bound identity DELETED → held",
  b2.ran.length === 0 && (b2.missing || []).length === 1,
  JSON.stringify(b2),
);
const b3 = prove(
  two.replace(
    'test("the label is Ada", () => {})',
    'test("the label is Ada", { skip: true }, () => {})',
  ),
  "b3",
);
assert(
  "C4: a bound identity SKIPPED → held",
  b3.ran.length === 0 && (b3.skipped || []).length === 1,
  JSON.stringify(b3),
);
const b3t = prove(
  two.replace('test("the label is Ada", () => {})', 'test.todo("the label is Ada")'),
  "b3t",
);
assert(
  "C4: a bound identity turned TODO → held",
  b3t.ran.length === 0 && (b3t.skipped || []).length === 1,
  JSON.stringify(b3t),
);
const b4 = prove(
  `${two.replace("the label is Ada", "renamed")}test("an extra test", () => {});\n`,
  "b4",
);
assert(
  "C4: an extra passing test in the file does not satisfy the missing one",
  b4.ran.length === 0 && (b4.missing || []).length === 1,
  JSON.stringify(b4),
);
const b5 = prove(two, "b5", []);
assert(
  "C4: a PASS that binds no identity in its files proves nothing → held",
  b5.ran.length === 0 && b5.unproven.length === 1,
  JSON.stringify(b5),
);
const b6 = prove(two, "b6", null);
assert(
  "C4: an older PASS without identities keeps the file-level rule, labelled",
  b6.ran.length === 1 && b6.evidence === "files" && (b6.tests || []).length === 2,
  JSON.stringify(b6),
);
assert("C4: an identity-bound proof says so", b0.evidence === "identities", JSON.stringify(b0));
const nested = prove(
  `import { describe, it } from "node:test";
describe("outer", () => { describe("inner", () => { it("leaf", () => {}); }); });
`,
  "b7",
  [{ file: "test/acceptance.test.mjs", name: "outer > inner > leaf" }],
);
assert(
  "C4: node:test identities carry the full name (suites included) and the call site",
  nested.ran.length === 1 &&
    ((nested.tests || [])[0] || {}).name === "outer > inner > leaf" &&
    ((nested.tests || [])[0] || {}).line === 2,
  JSON.stringify(nested),
);

console.log("== C5: identities per runner (parser level) ==");
const X = fresh("c5");
const fakeInv = (cmd, files, nonce) => {
  const i = TR.replayInvocation({ worktree: X, testCommand: cmd, files, nonce });
  TR.prepareReplayProof(i);
  return i;
};
const ij = fakeInv("jest", ["test/a.test.js"], "j");
writeFileSync(
  ij.proof.report,
  JSON.stringify({
    numTotalTests: 3,
    testResults: [
      {
        name: join(X, "test/a.test.js"),
        assertionResults: [
          { status: "passed", ancestorTitles: ["api"], title: "v2" },
          { status: "pending", ancestorTitles: ["api"], title: "v3" },
          { status: "passed", ancestorTitles: [], title: "smoke" },
        ],
      },
    ],
  }),
);
const pj = TR.replayProof({
  inv: ij,
  files: ["test/a.test.js"],
  worktree: X,
  required: [
    { file: "test/a.test.js", name: "api > v2" },
    { file: "test/a.test.js", name: "api > v3" },
  ],
});
assert(
  "C5 jest: a pending bound identity holds even beside passing ones",
  pj.ran.length === 0 && (pj.skipped || []).map((t) => t.name).join() === "api > v3",
  JSON.stringify(pj),
);
const ip = fakeInv("pytest -m api", ["tests/test_a.py"], "p");
writeFileSync(
  ip.proof.output,
  [
    "tests/test_a.py::test_smoke PASSED   [ 33%]",
    "tests/test_a.py::TestApi::test_v2 SKIPPED (needs api) [ 66%]",
    "tests/test_a.py::test_x[1-2] XFAIL   [100%]",
    "",
  ].join("\n"),
);
const pp = TR.replayProof({
  inv: ip,
  files: ["tests/test_a.py"],
  worktree: X,
  required: [
    { file: "tests/test_a.py", name: "test_smoke" },
    { file: "tests/test_a.py", name: "TestApi::test_v2" },
  ],
});
assert(
  "C5 pytest: node ids are the identities; a SKIPPED bound one holds",
  pp.ran.length === 0 && (pp.skipped || []).map((t) => t.name).join() === "TestApi::test_v2",
  JSON.stringify(pp),
);
const ppx = TR.replayProof({
  inv: ip,
  files: ["tests/test_a.py"],
  worktree: X,
  required: [{ file: "tests/test_a.py", name: "test_x[1-2]" }],
});
assert(
  "C5 pytest: an XFAIL bound identity is not a pass",
  ppx.ran.length === 0,
  JSON.stringify(ppx),
);
mkdirSync(join(X, "pkg/a"), { recursive: true });
write(
  X,
  "pkg/a/a_test.go",
  'package a\n\nimport "testing"\n\nfunc TestName(t *testing.T) {}\nfunc TestSkip(t *testing.T) { t.Skip() }\n',
);
const ig = fakeInv("go test -tags api ./...", ["pkg/a/a_test.go"], "g");
writeFileSync(ig.proof.golist, `example.com/m/pkg/a ${join(X, "pkg/a")} a_test.go\n`);
writeFileSync(
  ig.proof.output,
  [
    '{"Action":"run","Package":"example.com/m/pkg/a","Test":"TestName"}',
    '{"Action":"output","Package":"example.com/m/pkg/a","Test":"TestName","Output":"{\\"Action\\":\\"pass\\",\\"Package\\":\\"example.com/m/pkg/a\\",\\"Test\\":\\"TestSkip\\"}\\n"}',
    '{"Action":"pass","Package":"example.com/m/pkg/a","Test":"TestName/sub"}',
    '{"Action":"pass","Package":"example.com/m/pkg/a","Test":"TestName"}',
    '{"Action":"skip","Package":"example.com/m/pkg/a","Test":"TestSkip"}',
    '{"Action":"pass","Package":"example.com/m/pkg/a"}',
    "",
  ].join("\n"),
);
const pg = TR.replayProof({
  inv: ig,
  files: ["pkg/a/a_test.go"],
  worktree: X,
  required: [
    { file: "pkg/a/a_test.go", name: "TestName" },
    { file: "pkg/a/a_test.go", name: "TestName/sub" },
  ],
});
assert(
  "C5 go: -json events name Package/Test; the test's file is the one that declares it",
  pg.ran.length === 1 && pg.tests.length === 2,
  JSON.stringify(pg),
);
const pgs = TR.replayProof({
  inv: ig,
  files: ["pkg/a/a_test.go"],
  worktree: X,
  required: [{ file: "pkg/a/a_test.go", name: "TestSkip" }],
});
assert(
  "C5 go: a skipped bound test holds; a pass event printed BY a test (an output event) proves nothing",
  pgs.ran.length === 0 && (pgs.skipped || []).length === 1,
  JSON.stringify(pgs),
);
const ic = fakeInv("cargo test --features api", ["tests/accept.rs"], "cg");
writeFileSync(
  ic.proof.output,
  [
    "     Running unittests src/lib.rs (target/debug/deps/app-1)",
    "test tests::unit ... ok",
    "     Running tests/accept.rs (target/debug/deps/accept-2)",
    "test api::v2_name ... ok",
    "test api::v3_name ... ignored",
    "",
  ].join("\n"),
);
const pc = TR.replayProof({
  inv: ic,
  files: ["tests/accept.rs"],
  worktree: X,
  required: [{ file: "tests/accept.rs", name: "api::v2_name" }],
});
assert(
  "C5 cargo: `test <path> ... ok` under its target's Running line",
  pc.ran.length === 1,
  JSON.stringify(pc),
);
const pci = TR.replayProof({
  inv: ic,
  files: ["tests/accept.rs"],
  worktree: X,
  required: [{ file: "tests/accept.rs", name: "api::v3_name" }],
});
assert("C5 cargo: an ignored bound test holds", pci.ran.length === 0, JSON.stringify(pci));

console.log("== C5: real pytest / go where installed ==");
if (!has("pytest")) console.log("  SKIP C5 pytest: pytest is not installed");
else {
  const Y = fresh("c5py");
  write(Y, "pytest.ci.ini", "[pytest]\nmarkers =\n    api: the api suite\n");
  write(
    Y,
    "tests/test_acc.py",
    'import os, pytest\n\ndef test_smoke():\n    assert True\n\n@pytest.mark.skipif(not os.environ.get("PROFILE_API_V2"), reason="v2 off")\ndef test_v2():\n    assert os.environ["PROFILE_API_V2"] == "1"\n',
  );
  const files = ["tests/test_acc.py"];
  const yi = inv(Y, "PROFILE_API_V2=1 pytest -c pytest.ci.ini -p no:cacheprovider", files);
  const yr = run(Y, yi);
  const yp = TR.replayProof({
    inv: yi,
    files,
    worktree: Y,
    required: [
      { file: "tests/test_acc.py", name: "test_smoke" },
      { file: "tests/test_acc.py", name: "test_v2" },
    ],
  });
  assert(
    "C5 pytest (real): the env prefix keeps the bound test running",
    yr.status === 0 && yp.ran.length === 1,
    `${yi.command} ${JSON.stringify(yp)}`,
  );
}
if (!has("go")) console.log("  SKIP C5 go: go is not installed");
else {
  const G = fresh("c5go");
  write(G, "go.mod", "module example.com/m\n\ngo 1.21\n");
  write(G, "pkg/a/a.go", 'package a\n\nfunc Name() string { return "Ada" }\n');
  write(
    G,
    "pkg/a/a_test.go",
    '//go:build api\n\npackage a\n\nimport "testing"\n\nfunc TestName(t *testing.T) { if Name() != "Ada" { t.Fatal(Name()) } }\n',
  );
  const files = ["pkg/a/a_test.go"];
  const gi = inv(G, "go test -tags api ./...", files);
  const gr = spawnSync("bash", ["-c", gi.command], {
    cwd: G,
    encoding: "utf8",
    env: {
      ...process.env,
      GOFLAGS: "-mod=mod",
      GOCACHE: join(WORK, "gocache"),
      GOPATH: join(WORK, "gopath"),
    },
    timeout: 180_000,
  });
  writeFileSync(gi.proof.output, `${gr.stdout || ""}${gr.stderr || ""}`);
  const gp = TR.replayProof({
    inv: gi,
    files,
    worktree: G,
    required: [{ file: "pkg/a/a_test.go", name: "TestName" }],
  });
  assert(
    "C5 go (real): the build tag survives, so the tagged test file compiles and its test passes",
    gr.status === 0 && gp.ran.length === 1,
    `${gi.command} rc=${gr.status} ${JSON.stringify(gp)} ${(gr.stderr || "").slice(-300)}`,
  );
}

console.log();
if (fails.length === 0) {
  console.log(`tester-replay-contract: ALL ${pass} checks passed`);
  process.exit(0);
}
console.log(`tester-replay-contract: ${fails.length} FAILURE(S):`);
for (const f of fails) console.log(`  - ${f}`);
process.exit(1);
