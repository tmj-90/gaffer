#!/usr/bin/env node
// =====================================================================
// THE TICK'S JSON SERVER (runner/lib/json-serve.mjs), in process.
// ---------------------------------------------------------------------
// Each request evaluates lib/json-tool.mjs afresh with the call's argv, environment, cwd
// and stdin. For a table of calls (the subcommands a tick uses, hostile ticket text, exit
// codes, stderr) a served call must give exactly what `node json-tool.mjs <args>` gives:
//   S1  the same stdout and stderr bytes, in write order, and the same exit code;
//   S2  what cannot be identical is answered NOT-RUN (so the caller runs it one-shot):
//       a crash (node's report), a read of stdin the caller did not send, a changed
//       start-up environment, a cwd that is gone;
//   S3  nothing carries over: the environment, the cwd, process.argv and process.exit are
//       put back, and a later request sees its own environment and cwd;
//   S4  a request's output never leaks into the next one (a fresh module each time).
// Run: node runner/test/json-serve.test.mjs
// =====================================================================
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { gafferMkdtemp } from "./lib/tmpdir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = resolve(HERE, "..");
const TOOL = join(RUNNER_DIR, "lib", "json-tool.mjs");
const { JsonServer, parseRequest, splitFields } = await import(
  join(RUNNER_DIR, "lib", "json-serve.mjs")
);

let passed = 0;
const failures = [];
const ok = (l) => {
  passed += 1;
  console.log(`  ok   ${l}`);
};
const fail = (l) => {
  failures.push(l);
  console.log(`  FAIL ${l}`);
};
const check = (l, c) => (c ? ok(l) : fail(l));

const WORK = gafferMkdtemp(join(tmpdir(), "json-serve-"));
mkdirSync(join(WORK, "sub"));
writeFileSync(join(WORK, "doc.json"), JSON.stringify({ a: { b: "from a file" } }));
writeFileSync(join(WORK, "skip"), "2\n");

const server = new JsonServer();
let n = 0;
const req = (args, env = {}, cwd = WORK) => {
  n += 1;
  return { nonce: `1.${n}.0`, cwd, umask: 0o22, set: Object.entries(env), unset: [], args };
};
const oneShot = (args, stdin, env = {}, cwd = WORK) => {
  const r = spawnSync(process.execPath, [TOOL, ...args], {
    input: stdin ?? "",
    env: { ...process.env, ...env },
    cwd,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const served = async (args, stdin, env = {}, cwd = WORK) => {
  const r = await server.handle(
    req(args, env, cwd),
    stdin === null ? null : Buffer.from(stdin ?? ""),
  );
  if (r.kind !== "ran") return r;
  const pick = (fd) => Buffer.concat(r.segments.filter((s) => s.fd === fd).map((s) => s.data));
  return { kind: "ran", code: r.code, out: pick(1), err: pick(2), segments: r.segments };
};

const HOSTILE = `Fix "auth" $(touch ${WORK}/pwned) \`id\` 'q'\ttab\nline\n\n\u001b[31mred\u001b[0m café`;
const SHOW = JSON.stringify({
  ticket: { number: 7, title: HOSTILE, description: HOSTILE, risk_level: null, attempt_count: 2 },
  repositories: [
    {
      id: "r1",
      name: "repo",
      access: "write",
      relation: "confirmed",
      local_path: "/r/a b",
      default_branch: "main",
    },
    { id: "r2", name: "ctx", access: "read", relation: "confirmed", local_path: "/r/ctx" },
  ],
  acceptanceCriteria: [{ text: "x" }],
  evidence: [],
  events: [],
});

console.log("== S1: served equals one-shot ==");
const CASES = [
  ["expr title", ["expr", "d.ticket.title"], SHOW],
  ["expr number", ["expr", "d.ticket.number + 1"], SHOW],
  ["expr null", ["expr", "d.ticket.risk_level"], SHOW],
  ["expr object", ["expr", "d.repositories[0]"], SHOW],
  ["expr bad JSON", ["expr", "d.a"], "not json"],
  ["expr --default", ["expr", "d.a", "--default", "fb"], "not json"],
  ["expr --file", ["expr", "d.a.b", "--file", join(WORK, "doc.json")], null],
  ["expr throws", ["expr", "d.nope.deeper"], SHOW],
  [
    "expr env",
    ["expr", "env.GAFFER_SERVE_PROBE || 'unset'"],
    SHOW,
    { GAFFER_SERVE_PROBE: "per-call" },
  ],
  [
    "fields",
    ["fields", "d.ticket.title", "", "d.nope.x", "dflt", "d.ticket.attempt_count", "0"],
    SHOW,
  ],
  ["partition", ["partition"], SHOW],
  ["review-feedback", ["review-feedback"], SHOW],
  ["resolved-decisions", ["resolved-decisions"], SHOW],
  ["ticket-named-code", ["ticket-named-code"], SHOW],
  ["dod-cmd-map", ["dod-cmd-map"], SHOW],
  [
    "pick-unskipped",
    ["pick-unskipped", join(WORK, "skip"), "--all"],
    JSON.stringify([{ number: 1 }, { number: 2 }, { number: 3 }]),
  ],
  ["numbers-joined", ["numbers-joined"], JSON.stringify([{ number: 4 }, { number: 5 }])],
  ["quarantine", ["quarantine", "TITLE", "single"], HOSTILE],
  ["realpath relative to the cwd", ["realpath", "sub"], null],
  ["unknown subcommand (stderr, exit 2)", ["nosuch"], null],
  ["fields with no pairs (exit 2)", ["fields"], SHOW],
];
for (const [label, args, stdin, env] of CASES) {
  const one = oneShot(args, stdin, env);
  const s = await served(args, stdin, env);
  if (s.kind !== "ran") {
    fail(`S1: ${label}: answered NOT-RUN (${s.reason})`);
    continue;
  }
  check(
    `S1: ${label}: same stdout, stderr and exit code (${one.code})`,
    s.code === one.code && s.out.equals(one.out) && s.err.equals(one.err),
  );
}

console.log("== S2: NOT-RUN where a fresh process would differ ==");
const crash = await served(["pick-unskipped", join(WORK, "no-such-skip-file")], "[]");
check(
  "S2: a crash (node's report) is NOT-RUN",
  crash.kind === "not-run" && crash.reason === "exception",
);
const wanted = await served(["expr", "d.a"], null);
check(
  "S2: a read of stdin the caller did not send is NOT-RUN",
  wanted.kind === "not-run" && wanted.reason === "stdin",
);
const startup = await served(["expr", "1"], "{}", { NODE_OPTIONS: "--max-old-space-size=64" });
check(
  "S2: a changed start-up environment is NOT-RUN",
  startup.kind === "not-run" && startup.reason === "startup-env",
);
const gone = await served(["expr", "1"], "{}", {}, join(WORK, "no-such-dir"));
check("S2: a cwd that is gone is NOT-RUN", gone.kind === "not-run" && gone.reason === "cwd");

console.log("== S3: nothing carries over ==");
const before = { cwd: process.cwd(), argv: process.argv, exit: process.exit };
await served(["expr", "1"], "{}", { GAFFER_SERVE_PROBE: "x" }, join(WORK, "sub"));
check("S3: the environment is put back", process.env.GAFFER_SERVE_PROBE === undefined);
check("S3: the cwd is put back", process.cwd() === before.cwd);
check(
  "S3: process.argv and process.exit are put back",
  process.argv === before.argv && process.exit === before.exit,
);
const e2 = await served(["expr", "env.GAFFER_SERVE_PROBE || 'unset'"], "{}");
check(
  "S3: the next request does not see the last one's environment",
  e2.kind === "ran" && e2.out.toString() === "unset\n",
);

console.log("== S4: a fresh module per request ==");
const a1 = await served(["expr", "d.x"], '{"x":"first"}');
const a2 = await served(["expr", "d.x"], '{"x":"second"}');
check(
  "S4: each request prints only its own output",
  a1.out?.toString() === "first\n" && a2.out?.toString() === "second\n",
);
check("S4: no hostile value ran", !existsSync(join(WORK, "pwned")));

// The request format (shared with the dispatch server's).
check(
  "format: splitFields keeps empty fields",
  JSON.stringify(splitFields(Buffer.from("a\0\0b\0"))) === '["a","","b"]',
);
check(
  "format: a malformed request is null",
  parseRequest(["GWG1", "../x", "/", "022", "0", "0", "0"]) === null,
);

rmSync(WORK, { recursive: true, force: true });
if (failures.length === 0) {
  console.log(`PASS: ${passed} checks passed`);
  process.exit(0);
}
console.log(`FAILED: ${failures.length} of ${passed + failures.length}`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
