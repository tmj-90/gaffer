#!/usr/bin/env node
// =====================================================================
// ACCEPTANCE PROFILES (Release C: C1 CLI, C2 API) — runner side, proven with a fixture
// repository that exposes a tiny CLI (bin/cli.mjs) and a tiny HTTP server (server.mjs),
// a stub tester (no live model) and stub dispatch seams.
//   P1  lib: a CLI case runs its argv (no shell), records exit / stdout / stderr (sha256 +
//       redacted, bounded excerpt) and the checkout's filesystem diff, and checks the
//       expectations; a failed expectation, a timeout and a missing command do not pass.
//   P2  lib: the API profile boots on a free port, waits for health, runs each probe
//       (status incl. a 401 negative probe, JSON keys, schema subset), and kills the
//       process group always; a server that never gets healthy does not pass.
//   P3  lib: the payload is bound, digested, signed, capped; a required sandbox the host
//       cannot supply refuses the run.
//   P4  tester-run --live: a cli-profiled PASS runs the registered commands on the clean
//       replay checkout, records the transcript as evidence and binds the PASS to it.
//   P5  tester-run --live: failed expectations, no registered commands, a not-yet-
//       runnable profile and an evidence row that cannot be recorded all HOLD the PASS.
//   P6  tester-run --live: an api-profiled PASS records the probe responses.
// Run: node test/tester-acceptance.test.mjs
// =====================================================================
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { gafferMkdtemp } from "./lib/tmpdir.mjs";

const require = createRequire(import.meta.url);
try {
  require("node:sqlite");
} catch {
  console.log("  SKIP: node:sqlite unavailable (needs Node >= 22.5)");
  process.exit(0);
}
const HERE = dirname(fileURLToPath(import.meta.url));
const HELPER = resolve(HERE, "..", "bin", "tester-run.mjs");
const LIB = resolve(HERE, "..", "lib", "acceptance-profiles.mjs");
const REDACTION = resolve(HERE, "..", "..", "packages", "crew", "dist", "safety", "redaction.js");
const lib = await import(LIB);

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
const check = (cond, label, detail = "") =>
  cond ? ok(label) : fail(`${label}${detail ? `: ${detail}` : ""}`);

// Probes in this file use the package's port range (9831-9850) unless GAFFER_ACCEPTANCE_PORT_BASE is set.
process.env.GAFFER_ACCEPTANCE_PORT_BASE ??= "9831";
const baseEnv = {
  ...process.env,
  STRICT_MODE: "0",
  GAFFER_STRICT_REQUIRE: "0",
  GAFFER_ALLOW_UNCAPPED: "1",
};
delete baseEnv.GAFFER_MODE;

const WORK = gafferMkdtemp(resolve(tmpdir(), "tester-acceptance-"));
const REPO = resolve(WORK, "repo");
const g = (...a) => spawnSync("git", ["-C", REPO, ...a], { encoding: "utf8" });

// ── The fixture repository ─────────────────────────────────────────────────
mkdirSync(resolve(REPO, "bin"), { recursive: true });
spawnSync("git", ["init", "-q", "-b", "main", REPO]);
g("config", "user.email", "t@t");
g("config", "user.name", "t");
writeFileSync(
  resolve(REPO, "package.json"),
  '{"name":"fx","type":"module","scripts":{"test":"node --test"}}\n',
);
writeFileSync(resolve(REPO, ".gitignore"), "node_modules/\nout/\n");
// A tiny CLI: --version, greet <name> (writes out/greeting.txt), env (prints a secret-looking
// line), sleep, fail.
writeFileSync(
  resolve(REPO, "bin", "cli.mjs"),
  [
    'import { mkdirSync, writeFileSync } from "node:fs";',
    "const [cmd, ...rest] = process.argv.slice(2);",
    'if (cmd === "--version") { console.log("fx 1.2.0"); process.exit(0); }',
    'if (cmd === "greet") { mkdirSync("out", { recursive: true }); writeFileSync("out/greeting.txt", `hello ${rest[0]}\\n`); console.log(`hello ${rest[0]}`); process.exit(0); }',
    'if (cmd === "where") { console.log(process.cwd()); console.log("home=" + process.env.HOME); console.log("runner-credential:" + (process.env.DISPATCH_API_TOKEN ? "present" : "absent")); process.exit(0); }',
    'if (cmd === "leak") { console.log("API_TOKEN=supersecretvalue123456"); process.exit(0); }',
    'if (cmd === "echo") { console.log(rest.join(" ")); process.exit(0); }',
    'if (cmd === "stdin") { let d = ""; process.stdin.on("data", (c) => (d += c)); process.stdin.on("end", () => { console.log("got:" + d.trim()); }); }',
    'else if (cmd === "sleep") { setTimeout(() => {}, 60000); }',
    'else { console.error("unknown command: " + cmd); process.exit(2); }',
  ].join("\n") + "\n",
);
// A tiny HTTP server: /health, GET /items, POST /items needs a bearer token; writes its pid.
writeFileSync(
  resolve(REPO, "server.mjs"),
  [
    'import { createServer } from "node:http";',
    'import { writeFileSync } from "node:fs";',
    "if (process.env.PID_FILE) writeFileSync(process.env.PID_FILE, String(process.pid));",
    "const delay = Number(process.env.BOOT_DELAY_MS || 0);",
    "setTimeout(() => createServer((req, res) => {",
    '  if (req.url === "/health") { res.writeHead(process.env.NEVER_HEALTHY ? 503 : 200); return res.end("ok"); }',
    '  if (req.url === "/items" && req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ items: [{ id: 1, name: "a" }], count: 1 })); }',
    '  if (req.url === "/items" && req.method === "POST") { if (req.headers.authorization !== "Bearer test-token-0000000000000") { res.writeHead(401, { "www-authenticate": "Bearer" }); return res.end("no"); } res.writeHead(201); return res.end("{}"); }',
    "  res.writeHead(404); res.end();",
    '}).listen(Number(process.env.PORT), "127.0.0.1"), delay);',
  ].join("\n") + "\n",
);
writeFileSync(
  resolve(REPO, "openapi.json"),
  JSON.stringify({
    components: {
      schemas: {
        Items: {
          type: "object",
          required: ["items", "count"],
          properties: {
            items: { type: "array", items: { $ref: "#/components/schemas/Item" } },
            count: { type: "integer" },
          },
        },
        Item: {
          type: "object",
          required: ["id", "name"],
          properties: { id: { type: "integer" }, name: { type: "string" } },
        },
        Strict: { type: "object", required: ["total"] },
      },
    },
  }),
);
g("add", "-A");
g("commit", "-q", "-m", "base");
g("checkout", "-q", "-b", "gaffer/ticket-1-cli");
writeFileSync(resolve(REPO, "VERSION"), "1.2.0\n");
g("add", "-A");
g("commit", "-q", "-m", "feat: cli");
g("checkout", "-q", "main");
const DELIVERY = g("rev-parse", "gaffer/ticket-1-cli").stdout.trim();

// A scratch checkout for the library tests.
const SCRATCH = resolve(WORK, "scratch");
spawnSync("git", ["-C", REPO, "worktree", "add", "-q", "--detach", SCRATCH, DELIVERY]);

const redact = (await lib.loadRedaction()) ?? ((s) => s);
check(existsSync(REDACTION), "the crew redaction module is built (packages/crew/dist)");
const noSb = { ok: true, wrap: [], label: "none", docker: false };
const far = () => Date.now() + 60000;

console.log("== P1: the CLI profile runs argv, records the transcript and checks expectations ==");
{
  const spec = {
    cases: [
      {
        name: "version",
        argv: ["node", "bin/cli.mjs", "--version"],
        expect: { exit: 0, stdout: ["fx 1.2.0", "/^fx \\d+\\.\\d+/m"] },
      },
      {
        name: "greet",
        argv: ["node", "bin/cli.mjs", "greet", "ada"],
        expect: { exit: 0, files: [{ path: "out/greeting.txt", contains: "hello ada" }] },
      },
      {
        name: "no shell",
        argv: ["node", "bin/cli.mjs", "echo", "$HOME", "`id`", ";", "rm", "-rf", "x"],
        expect: { stdout: ["$HOME `id` ; rm -rf x"] },
      },
      {
        name: "stdin",
        argv: ["node", "bin/cli.mjs", "stdin"],
        stdin: "abc",
        expect: { stdout: ["got:abc"] },
      },
      {
        name: "unknown",
        argv: ["node", "bin/cli.mjs", "nope"],
        expect: { exit: 2, stderr: ["unknown command"] },
      },
    ],
  };
  const r = lib.runCliProfile({
    checkout: SCRATCH,
    spec,
    redact,
    sb: noSb,
    env: baseEnv,
    deadline: far(),
  });
  check(r.passed === true, "every registered command met its expectations", r.reason);
  const greet = r.cases.find((c) => c.name === "greet");
  check(
    greet && greet.fs.added.includes("out/greeting.txt"),
    "the filesystem diff names the file the command wrote",
    JSON.stringify(greet?.fs),
  );
  const v = r.cases[0];
  check(
    /^[0-9a-f]{64}$/.test(v.stdout.sha256) && v.stdout.excerpt.includes("fx 1.2.0") && v.exit === 0,
    "stdout is hashed with an excerpt, the exit code recorded",
  );
  check(
    r.cases[2].held,
    "argv is never a shell string ($HOME, backticks and ; reach the program literally)",
  );
  const bad = lib.runCliProfile({
    checkout: SCRATCH,
    spec: {
      cases: [{ argv: ["node", "bin/cli.mjs", "--version"], expect: { stdout: ["fx 9.9"] } }],
    },
    redact,
    sb: noSb,
    env: baseEnv,
    deadline: far(),
  });
  check(
    bad.passed === false && /stdout has fx 9\.9/.test(bad.reason),
    "a stdout pattern that does not hold fails the profile",
    bad.reason,
  );
  const t0 = Date.now();
  const slow = lib.runCliProfile({
    checkout: SCRATCH,
    spec: { cases: [{ argv: ["node", "bin/cli.mjs", "sleep"], timeout_ms: 500 }] },
    redact,
    sb: noSb,
    env: baseEnv,
    deadline: far(),
  });
  check(
    slow.passed === false && slow.cases[0].timed_out && Date.now() - t0 < 20000,
    "a command over its time cap is killed and fails",
    JSON.stringify(slow.cases[0]?.checks),
  );
  const missing = lib.runCliProfile({
    checkout: SCRATCH,
    spec: { cases: [{ argv: ["definitely-not-a-binary-xyz"] }] },
    redact,
    sb: noSb,
    env: baseEnv,
    deadline: far(),
  });
  check(
    missing.passed === false && /could not start/.test(JSON.stringify(missing.cases[0].checks)),
    "a command that cannot start fails",
  );
  const env = lib.runCliProfile({
    checkout: SCRATCH,
    spec: {
      cases: [
        { argv: ["node", "bin/cli.mjs", "where"] },
        { argv: ["node", "bin/cli.mjs", "leak"] },
      ],
    },
    redact,
    sb: noSb,
    env: { ...baseEnv, DISPATCH_API_TOKEN: "runner-secret-token-xyz" },
    deadline: far(),
  });
  const out0 = env.cases[0].stdout.excerpt;
  check(
    out0.includes("runner-credential:absent") && !out0.includes(process.env.HOME || "\u0000"),
    "the command runs in a stripped env (no runner token, a throwaway HOME)",
    out0,
  );
  check(
    !env.cases[1].stdout.excerpt.includes("supersecretvalue123456") &&
      /\[REDACTED\]/.test(env.cases[1].stdout.excerpt),
    "a secret the command prints is redacted in the excerpt",
    env.cases[1].stdout.excerpt,
  );
  const outside = lib.runCliProfile({
    checkout: SCRATCH,
    spec: {
      cases: [
        {
          argv: ["node", "bin/cli.mjs", "--version"],
          expect: { files: [{ path: "../repo/package.json" }] },
        },
      ],
    },
    redact,
    sb: noSb,
    env: baseEnv,
    deadline: far(),
  });
  check(outside.passed === false, "a file expectation outside the checkout never holds");
  check(
    lib.confinedPath(SCRATCH, "../x") === null && lib.confinedPath(SCRATCH, "/etc/passwd") === null,
    "paths are confined to the checkout",
  );
}

console.log("== P2: the API profile boots, probes and always kills the service ==");
{
  const pidFile = resolve(WORK, "server.pid");
  const spec = {
    boot_argv: ["node", "server.mjs"],
    health_path: "/health",
    env: { PID_FILE: pidFile, BOOT_DELAY_MS: "300" },
    schema_path: "openapi.json",
    probes: [
      {
        method: "GET",
        path: "/items",
        expect: {
          status: 200,
          json_keys: ["items", "count"],
          schema_ref: "#/components/schemas/Items",
        },
      },
      {
        name: "unauthenticated write",
        method: "POST",
        path: "/items",
        body: { name: "b" },
        expect: { status: 401 },
      },
      {
        name: "authenticated write",
        method: "POST",
        path: "/items",
        headers: { authorization: "Bearer test-token-0000000000000" },
        body: { name: "b" },
        expect: { status: 201 },
      },
      { method: "GET", path: "/missing", expect: { status: 404 } },
    ],
  };
  const r = await lib.runApiProfile({
    checkout: SCRATCH,
    spec,
    redact,
    sb: noSb,
    env: baseEnv,
    deadline: far(),
  });
  check(
    r.passed === true,
    "every probe met its expectations (incl. a 401 negative probe and a schema check)",
    r.reason,
  );
  check(
    r.boot &&
      r.boot.health.healthy &&
      r.boot.port >= Number(process.env.GAFFER_ACCEPTANCE_PORT_BASE) &&
      r.boot.port < Number(process.env.GAFFER_ACCEPTANCE_PORT_BASE) + 20,
    "the service was healthy on a free port in the configured range",
    JSON.stringify(r.boot?.health),
  );
  const p0 = r.cases[0];
  check(
    p0 &&
      p0.response.status === 200 &&
      /^[0-9a-f]{64}$/.test(p0.response.body.sha256) &&
      p0.response.headers["content-type"] === "application/json",
    "a probe records the status, a headers subset and the body hash",
  );
  check(
    r.cases[2].request.headers.authorization === "[REDACTED]",
    "an Authorization header is never recorded",
  );
  const pid = Number(readFileSync(pidFile, "utf8"));
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  check(!alive, "the service's process group is killed after the probes");
  const wrong = await lib.runApiProfile({
    checkout: SCRATCH,
    spec: {
      ...spec,
      probes: [
        { path: "/items", expect: { status: 200, schema_ref: "#/components/schemas/Strict" } },
        { path: "/items", expect: { status: 500 } },
      ],
    },
    redact,
    sb: noSb,
    env: baseEnv,
    deadline: far(),
  });
  check(
    wrong.passed === false &&
      /total: required/.test(JSON.stringify(wrong.cases[0].checks)) &&
      /answered 200/.test(JSON.stringify(wrong.cases[1].checks)),
    "a schema mismatch and a wrong status fail the profile",
    wrong.reason,
  );
  const never = await lib.runApiProfile({
    checkout: SCRATCH,
    spec: { ...spec, env: { NEVER_HEALTHY: "1", PID_FILE: pidFile }, boot_timeout_ms: 1500 },
    redact,
    sb: noSb,
    env: baseEnv,
    deadline: far(),
  });
  check(
    never.passed === false &&
      /not healthy within the boot deadline/.test(never.reason) &&
      never.cases.length === 0,
    "a service that never gets healthy fails before any probe",
    never.reason,
  );
  const crash = await lib.runApiProfile({
    checkout: SCRATCH,
    spec: { ...spec, boot_argv: ["node", "-e", "process.exit(3)"] },
    redact,
    sb: noSb,
    env: baseEnv,
    deadline: far(),
  });
  check(
    crash.passed === false && /exited 3 before it was healthy/.test(crash.reason),
    "a service that exits on boot fails",
    crash.reason,
  );
  const docker = await lib.runApiProfile({
    checkout: SCRATCH,
    spec,
    redact,
    sb: { ...noSb, docker: true, wrap: ["x"] },
    env: baseEnv,
    deadline: far(),
  });
  check(
    docker.passed === false && /docker sandbox/.test(docker.reason),
    "the api profile is refused under the docker sandbox (probes run on the host)",
  );
}

console.log("== P3: payload binding, signature, cap, sandbox refusal ==");
{
  const key = lib.signingKey(resolve(WORK, "data-sign"));
  check(
    /^[0-9a-f]{64}$/.test(key) && lib.signingKey(resolve(WORK, "data-sign")) === key,
    "the signing key is created once and kept",
  );
  const mode = (
    require("node:fs").statSync(resolve(WORK, "data-sign", "acceptance-signing.key")).mode & 0o777
  ).toString(8);
  check(mode === "600", "the signing key is mode 0600", mode);
  const result = lib.runCliProfile({
    checkout: SCRATCH,
    spec: { cases: [{ argv: ["node", "bin/cli.mjs", "--version"] }] },
    redact,
    sb: noSb,
    env: baseEnv,
    deadline: far(),
  });
  const payload = lib.buildEvidencePayload({
    profile: "cli",
    testedCommit: DELIVERY,
    contractHash: "f".repeat(64),
    result,
    key,
  });
  check(
    payload.kind === "transcript" && payload.tested_commit === DELIVERY && payload.passed === true,
    "the payload is a transcript bound to the tested commit",
  );
  const v = lib.verifyEvidencePayload(payload, key);
  check(v.digest && v.signature, "its digest and signature verify with the runner's key");
  const forged = { ...payload, passed: false };
  check(
    !lib.verifyEvidencePayload(forged, key).digest,
    "an edited payload no longer matches its digest",
  );
  const big = {
    ...result,
    cases: Array.from({ length: 40 }, () => ({
      ...result.cases[0],
      stdout: { ...result.cases[0].stdout, excerpt: "x".repeat(4000) },
    })),
  };
  const capped = lib.buildEvidencePayload({
    profile: "cli",
    testedCommit: DELIVERY,
    contractHash: "f".repeat(64),
    result: big,
    key,
  });
  check(
    JSON.stringify(capped).length <= lib.PAYLOAD_MAX && capped.cases.length === 40,
    "a large transcript is cut to fit by its excerpts, never by its facts",
    String(JSON.stringify(capped).length),
  );
  const refused = await lib.runProfile({
    profile: "cli",
    checkout: SCRATCH,
    spec: { cases: [{ argv: ["node", "bin/cli.mjs", "--version"] }] },
    env: {
      ...baseEnv,
      GAFFER_STRICT_REQUIRE: "1",
      SANDBOX_PROVIDER: "none",
      GAFFER_DATA: resolve(WORK, "data-sign"),
    },
  });
  check(
    refused.passed === false && refused.sandbox === "refused" && refused.cases.length === 0,
    "a required sandbox the host cannot supply refuses the run (nothing executes)",
    JSON.stringify(refused),
  );
  const web = await lib.runProfile({ profile: "web", checkout: SCRATCH, spec: {}, env: baseEnv });
  check(
    web.passed === false && /not run by the runner yet/.test(web.reason),
    "a not-yet-runnable profile never passes",
  );
  const noRedact = await lib.runProfile({
    profile: "cli",
    checkout: SCRATCH,
    spec: { cases: [{ argv: ["node", "bin/cli.mjs", "--version"] }] },
    env: { ...baseEnv, GAFFER_REDACTION_MODULE: resolve(WORK, "missing.js") },
  });
  check(
    noRedact.passed === false && /redaction/.test(noRedact.reason) && noRedact.cases.length === 0,
    "without the redaction module nothing runs or is recorded",
  );
}
console.log("== P8: process hygiene, the wrapper's environment, body caps ==");
{
  const alivePid = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitFor = async (cond, ms = 5000) => {
    for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise((r) => setTimeout(r, 50)))
      if (cond()) return true;
    return cond();
  };
  // A command that exits 0 but leaves a child running in its group.
  const daemonPid = resolve(WORK, "daemon.pid");
  const left = lib.runCliProfile({
    checkout: SCRATCH,
    spec: {
      cases: [
        {
          argv: [
            "node",
            "-e",
            `const c = require("node:child_process").spawn("sleep", ["60"], { stdio: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(daemonPid)}, String(c.pid)); c.unref(); process.exit(0);`,
          ],
        },
      ],
    },
    redact,
    sb: noSb,
    env: baseEnv,
    deadline: far(),
  });
  const dpid = Number(readFileSync(daemonPid, "utf8"));
  check(
    await waitFor(() => !alivePid(dpid)),
    "a child a command left running is killed with its group",
    String(dpid),
  );
  check(left.cases[0]?.left_running === true, "the transcript says the command left one running");
  if (alivePid(dpid)) process.kill(dpid, "SIGKILL");

  // The spec's env reaches the command only, never the sandbox wrapper; reserved names drop.
  const penv = lib.profileEnv({
    home: "/h",
    extra: {
      FOO: "1",
      HOME: "/root",
      TMPDIR: "/x",
      BASH_ENV: "/evil.sh",
      LD_PRELOAD: "/evil.so",
      GAFFER_SANDBOX_DRY_RUN: "1",
      SANDBOX_PROVIDER: "none",
    },
    base: { PATH: "/usr/bin" },
  });
  check(
    penv.FOO === "1" &&
      penv.HOME === "/h" &&
      !("BASH_ENV" in penv) &&
      !("LD_PRELOAD" in penv) &&
      !("GAFFER_SANDBOX_DRY_RUN" in penv) &&
      !("SANDBOX_PROVIDER" in penv) &&
      penv.TMPDIR !== "/x",
    "a spec cannot set HOME, TMPDIR, loader or shell hooks, or the runner's settings",
    JSON.stringify(penv),
  );
  const [wbin, wargs, wenv] = lib.wrappedSpawn(
    ["node", "x.mjs"],
    { ...penv, NODE_OPTIONS: "--require ./evil.cjs" },
    { ok: true, wrap: ["sandbox-exec", "-f", "/p.sb"], docker: false },
    { PATH: "/usr/bin", GAFFER_SANDBOX_IMAGE: "img:1", DISPATCH_API_TOKEN: "t" },
  );
  check(
    wbin === "sandbox-exec" &&
      !("FOO" in wenv) &&
      !("NODE_OPTIONS" in wenv) &&
      !("DISPATCH_API_TOKEN" in wenv) &&
      wenv.GAFFER_SANDBOX_IMAGE === "img:1" &&
      wenv.GAFFER_SANDBOX_PROFILE === "validation" &&
      wargs.slice(2, 4).join(" ") === "env -i" &&
      wargs.includes("FOO=1") &&
      wargs.slice(-2).join(" ") === "node x.mjs",
    "the wrapper gets the runner's sandbox settings only; the command's env goes through env -i inside",
    JSON.stringify([wbin, wargs, wenv]),
  );

  // A required sandbox the host cannot supply refuses even with GAFFER_DOD_SANDBOX=0.
  const optOut = lib.profileSandbox({
    writeRoots: [SCRATCH],
    env: {
      ...baseEnv,
      GAFFER_STRICT_REQUIRE: "1",
      SANDBOX_PROVIDER: "none",
      GAFFER_DOD_SANDBOX: "0",
    },
  });
  check(
    optOut.ok === false,
    "the GAFFER_DOD_SANDBOX=0 opt-out does not run what a required sandbox refused",
  );

  // A probe's body is read up to a cap; a service that exits during the probes fails.
  const bigServer =
    'require("node:http").createServer((q, s) => { if (q.url === "/health") return s.end("ok"); if (q.url === "/big") { s.writeHead(200); const c = Buffer.alloc(65536, 120); let n = 0; const w = () => { while (n < 64) { n += 1; if (!s.write(c)) return s.once("drain", w); } s.end(); }; return w(); } if (q.url === "/bye") { s.end("bye"); return setImmediate(() => process.exit(0)); } s.writeHead(404); s.end(); }).listen(Number(process.env.PORT), "127.0.0.1");';
  const big = await lib.runApiProfile({
    checkout: SCRATCH,
    spec: {
      boot_argv: ["node", "-e", bigServer],
      health_path: "/health",
      probes: [{ path: "/big", expect: { status: 200 } }],
    },
    redact,
    sb: noSb,
    env: baseEnv,
    deadline: far(),
  });
  check(
    big.passed === true &&
      big.cases[0].response.body.bytes === lib.BODY_READ_MAX &&
      big.cases[0].response.body.truncated_at === lib.BODY_READ_MAX,
    "a 4 MB body is read only up to the cap, and the record says so",
    JSON.stringify(big.cases[0]?.response?.body)?.slice(0, 200),
  );
  const bye = await lib.runApiProfile({
    checkout: SCRATCH,
    spec: {
      boot_argv: ["node", "-e", bigServer],
      health_path: "/health",
      probes: [{ path: "/bye", expect: { status: 200 } }],
    },
    redact,
    sb: noSb,
    env: baseEnv,
    deadline: far(),
  });
  check(
    bye.passed === false,
    "a service that exits during the probes does not pass",
    JSON.stringify(bye.cases.map((c) => c.checks)),
  );

  // SIGTERM to the profile process kills the service it booted.
  const pidFile2 = resolve(WORK, "server2.pid");
  const specFile = resolve(WORK, "sigterm-spec.json");
  writeFileSync(
    specFile,
    JSON.stringify({
      boot_argv: ["node", "server.mjs"],
      env: { NEVER_HEALTHY: "1", PID_FILE: pidFile2 },
      health_path: "/health",
      boot_timeout_ms: 60000,
      probes: [{ path: "/items", expect: { status: 200 } }],
    }),
  );
  rmSync(pidFile2, { force: true });
  const { spawn: spawnAsync } = await import("node:child_process");
  const proc = spawnAsync(
    process.execPath,
    [LIB, "run", "--profile", "api", "--checkout", SCRATCH, "--spec-file", specFile],
    { env: baseEnv, stdio: "ignore" },
  );
  await waitFor(() => existsSync(pidFile2) && readFileSync(pidFile2, "utf8").length > 0, 10000);
  const spid = Number(readFileSync(pidFile2, "utf8"));
  proc.kill("SIGTERM");
  await new Promise((r) => proc.once("exit", r));
  check(
    await waitFor(() => !alivePid(spid)),
    "SIGTERM to the profile process kills the service it booted",
    String(spid),
  );
  if (alivePid(spid)) process.kill(spid, "SIGKILL");
}
spawnSync("git", ["-C", REPO, "worktree", "remove", "--force", SCRATCH]);

// ── tester-run --live with a fixture dispatch DB ───────────────────────────
const DB = resolve(WORK, "dispatch.sqlite");
const DATA = resolve(WORK, "data");
mkdirSync(DATA, { recursive: true });
{
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(DB);
  db.exec(
    "CREATE TABLE tickets (id TEXT PRIMARY KEY, number INTEGER UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, branch_name TEXT, pr_url TEXT, can_be_tested INTEGER NOT NULL DEFAULT 0, test_contract TEXT, acceptance INTEGER NOT NULL DEFAULT 0);" +
      "CREATE TABLE acceptance_criteria (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, text TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending');" +
      "CREATE TABLE repositories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, local_path TEXT, default_branch TEXT NOT NULL DEFAULT 'main', stack TEXT, test_command TEXT);" +
      "CREATE TABLE ticket_repos (ticket_id TEXT, repo_id TEXT, role TEXT DEFAULT 'primary', branch_name TEXT, access TEXT DEFAULT 'write');",
  );
  db.prepare(
    "INSERT INTO tickets (id,number,title,description,status,branch_name,can_be_tested,test_contract) VALUES (?,?,?,?,?,?,?,?)",
  ).run(
    "t1",
    1,
    "Add a version flag to the CLI",
    "the CLI prints its version",
    "in_testing",
    "gaffer/ticket-1-cli",
    1,
    "{}",
  );
  db.prepare("INSERT INTO acceptance_criteria (id,ticket_id,text) VALUES (?,?,?)").run(
    "ac1",
    "t1",
    "fx --version prints 1.2.0",
  );
  db.prepare(
    "INSERT INTO repositories (id,name,local_path,default_branch,stack,test_command) VALUES (?,?,?,?,?,?)",
  ).run("r1", "fx", REPO, "main", "typescript-node", "node --test");
  db.prepare(
    "INSERT INTO ticket_repos (ticket_id,repo_id,role,branch_name,access) VALUES (?,?,?,?,?)",
  ).run("t1", "r1", "primary", "gaffer/ticket-1-cli", "write");
  db.close();
}
const setContract = (c) => {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(DB);
  db.prepare("UPDATE tickets SET test_contract = ? WHERE id = 't1'").run(JSON.stringify(c));
  db.close();
};
const STUB = resolve(WORK, "claude-stub.sh");
const CAPTURE = resolve(WORK, "capture.txt");
writeFileSync(
  STUB,
  "#!/usr/bin/env bash\nset -uo pipefail\n" +
    'prompt=""; prev=""; for a in "$@"; do [ "$prev" = "-p" ] && prompt="$a"; prev="$a"; done\n' +
    `printf '%s' "$prompt" > ${JSON.stringify(CAPTURE)}\n` +
    'mkdir -p test && printf \'import test from "node:test"; import assert from "node:assert/strict"; import { readFileSync } from "node:fs"; test("v", () => assert.match(readFileSync("VERSION","utf8"), /1.2.0/));\\n\' > test/v.test.js\n' +
    // TAMPER: the tester's test rewrites the CLI in the checkout it runs in (a test file is
    // the tester's own code, and the replay runs it). The profile must not see the rewrite.
    'if [ -n "${TAMPER:-}" ]; then printf \'import test from "node:test"; import { writeFileSync } from "node:fs"; test("t", () => writeFileSync("bin/cli.mjs", "console.log(\\\\"fx 9.9.9\\\\")\\\\n"));\\n\' > test/t.test.js; fi\n' +
    "git add -A >/dev/null 2>&1 && git -c user.email=t@t -c user.name=t commit -q -m tests >/dev/null 2>&1 || true\n" +
    'printf \'{"type":"result","subtype":"success","is_error":false,"result":"PASS: version shown\\\\n{\\\\"verdict\\\\":\\\\"PASS\\\\"}","total_cost_usd":0.01,"num_turns":2}\\n\'\n',
);
chmodSync(STUB, 0o755);
const VERDICT_LOG = resolve(WORK, "verdict.jsonl");
const EVIDENCE_LOG = resolve(WORK, "evidence.jsonl");
const LANE_LOG = resolve(WORK, "lane.jsonl");
const logger = (file) => {
  const p = resolve(WORK, `${file}.mjs`);
  writeFileSync(
    p,
    "import { appendFileSync } from 'node:fs';\n" +
      `appendFileSync(${JSON.stringify(resolve(WORK, file + ".jsonl"))}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`,
  );
  return p;
};
const verdictStub = logger("verdict");
const laneStub = logger("lane");
const evidenceStub = resolve(WORK, "evidence.mjs");
writeFileSync(
  evidenceStub,
  "import { appendFileSync, readFileSync } from 'node:fs';\n" +
    "const [ticket, file] = process.argv.slice(2);\n" +
    `appendFileSync(${JSON.stringify(EVIDENCE_LOG)}, JSON.stringify({ ticket, payload: JSON.parse(readFileSync(file, 'utf8')) }) + '\\n');\n` +
    "if (process.env.EVIDENCE_STUB_FAIL) process.exit(1);\n" +
    // Indented, as the dispatch CLI prints it (printJson).
    "console.log(JSON.stringify({ ok: true, evidenceId: 'ev-' + ticket, passed: true }, null, 2));\n",
);
const lines = (f) =>
  existsSync(f)
    ? readFileSync(f, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
function live(extra = {}) {
  for (const f of [VERDICT_LOG, EVIDENCE_LOG, LANE_LOG, CAPTURE]) rmSync(f, { force: true });
  const r = spawnSync(process.execPath, [HELPER, "--ticket", "1", "--live"], {
    encoding: "utf8",
    env: {
      ...baseEnv,
      DISPATCH_DB: DB,
      GAFFER_DATA: DATA,
      CLAUDE_BIN: STUB,
      CLAUDE_FLAGS: "",
      DISPATCH_TESTER_VERDICT_CMD: JSON.stringify([process.execPath, verdictStub]),
      DISPATCH_LANE_VERDICT_CMD: JSON.stringify([process.execPath, laneStub]),
      DISPATCH_ACCEPTANCE_EVIDENCE_CMD: JSON.stringify([process.execPath, evidenceStub]),
      ...extra,
    },
  });
  let out;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    out = null;
  }
  return {
    code: r.status,
    out,
    verdicts: lines(VERDICT_LOG),
    evidence: lines(EVIDENCE_LOG),
    lane: lines(LANE_LOG),
    stderr: r.stderr,
  };
}
const BASE_CONTRACT = {
  changed_surfaces: ["the fx CLI"],
  runtime_deps: [],
  env_vars: [],
  run_command: "",
  harness_ready: false,
};

console.log(
  "== P4: a cli-profiled PASS runs the registered commands on the clean replay checkout ==",
);
{
  setContract({
    ...BASE_CONTRACT,
    profile: "cli",
    profile_spec: {
      cases: [
        {
          name: "version",
          argv: ["node", "bin/cli.mjs", "--version"],
          expect: { exit: 0, stdout: ["fx 1.2.0"] },
        },
        {
          name: "where",
          argv: ["node", "bin/cli.mjs", "where"],
          expect: { stdout: ["tester-accept-1"] },
        },
      ],
    },
  });
  const r = live();
  check(
    r.code === 0 && r.out?.phase === "verdict" && r.out?.verdict === "pass",
    "the PASS is recorded",
    `${r.code} ${JSON.stringify(r.out)} ${r.stderr.slice(-400)}`,
  );
  const ev = r.evidence[0]?.payload;
  check(
    ev &&
      ev.kind === "transcript" &&
      ev.profile === "cli" &&
      ev.passed === true &&
      ev.tested_commit === DELIVERY,
    "the transcript is recorded as evidence for the tested commit",
    JSON.stringify(ev)?.slice(0, 300),
  );
  check(
    ev && ev.cases.length === 2 && ev.cases[1].held,
    "the commands ran in their own clean checkout of the tested commit (not the tester's worktree or the replay's)",
    JSON.stringify(ev?.cases?.[1]?.stdout),
  );
  check(
    ev &&
      /^[0-9a-f]{64}$/.test(ev.signature || "") &&
      lib.verifyEvidencePayload(ev, lib.signingKey(DATA)).signature,
    "the transcript is signed with the runner's key",
  );
  const vargv = r.verdicts[0] || [];
  check(
    vargv.includes("--acceptance-evidence") &&
      vargv[vargv.indexOf("--acceptance-evidence") + 1] === "ev-1" &&
      vargv.includes("--replay"),
    "the PASS is bound to the evidence row (--acceptance-evidence)",
    JSON.stringify(vargv),
  );
  check(
    r.out?.acceptance?.evidenceId === "ev-1",
    "the emitted verdict names the acceptance evidence",
  );
  const prompt = existsSync(CAPTURE) ? readFileSync(CAPTURE, "utf8") : "";
  check(
    /Acceptance profile: cli/.test(prompt) && /bin\/cli\.mjs/.test(prompt),
    "the tester's prompt names the profile and its registered commands",
  );
}

console.log("== P5: a profiled PASS without passed runtime evidence is HELD ==");
{
  setContract({
    ...BASE_CONTRACT,
    profile: "cli",
    profile_spec: {
      cases: [{ argv: ["node", "bin/cli.mjs", "--version"], expect: { stdout: ["fx 9.9.9"] } }],
    },
  });
  let r = live();
  check(
    r.code === 2 &&
      r.out?.phase === "held" &&
      /runtime acceptance \(cli\) did not pass/.test(r.out?.reason || ""),
    "failed expectations hold the PASS",
    JSON.stringify(r.out)?.slice(0, 300),
  );
  check(r.verdicts.length === 0, "no verdict is recorded");
  check(
    r.evidence[0]?.payload?.passed === false,
    "the failed transcript is still recorded (a person sees why)",
  );
  check(r.lane[0]?.includes("held"), "the lane verdict is held");

  setContract({ ...BASE_CONTRACT, profile: "cli" });
  r = live();
  check(
    r.code === 2 &&
      /no commands are registered for the cli acceptance profile/.test(r.out?.reason || "") &&
      /wg ticket acceptance-profile 1 --profile cli/.test(r.out?.reason || ""),
    "a profile with no registered commands holds, saying how to register them",
    r.out?.reason,
  );
  check(r.verdicts.length === 0 && r.evidence.length === 0, "nothing is recorded");

  setContract({ ...BASE_CONTRACT, profile: "web", profile_spec: { base_path: "/" } });
  r = live();
  check(
    r.code === 2 && /web acceptance profile is not run by the runner yet/.test(r.out?.reason || ""),
    "a not-yet-runnable profile holds the PASS",
    r.out?.reason,
  );

  setContract({
    ...BASE_CONTRACT,
    profile: "cli",
    profile_spec: { cases: [{ argv: ["node", "bin/cli.mjs", "--version"] }] },
  });
  r = live({ EVIDENCE_STUB_FAIL: "1" });
  check(
    r.code === 2 && /could not be recorded/.test(r.out?.reason || "") && r.verdicts.length === 0,
    "evidence that cannot be recorded holds the PASS",
    r.out?.reason,
  );

  setContract(BASE_CONTRACT);
  r = live();
  check(
    r.code === 0 &&
      r.out?.phase === "verdict" &&
      r.evidence.length === 0 &&
      !(r.verdicts[0] || []).includes("--acceptance-evidence"),
    "a unit ticket is tested as before (no profile run)",
    JSON.stringify(r.out)?.slice(0, 200),
  );
}

console.log("== P7: the tester's tests cannot change what the profile runs ==");
{
  setContract({
    ...BASE_CONTRACT,
    profile: "cli",
    profile_spec: {
      cases: [{ argv: ["node", "bin/cli.mjs", "--version"], expect: { stdout: ["fx 9.9.9"] } }],
    },
  });
  const r = live({ TAMPER: "1" });
  check(
    r.code === 2 &&
      r.out?.phase === "held" &&
      /runtime acceptance \(cli\) did not pass/.test(r.out?.reason || "") &&
      r.verdicts.length === 0,
    "a test file that rewrites the CLI in the replay checkout does not make the profile pass",
    `${r.code} ${JSON.stringify(r.out)?.slice(0, 300)}`,
  );
  check(
    /fx 1\.2\.0/.test(r.evidence[0]?.payload?.cases?.[0]?.stdout?.excerpt || ""),
    "the transcript shows the delivered CLI's own output",
    JSON.stringify(r.evidence[0]?.payload?.cases?.[0]?.stdout),
  );
}

console.log("== P6: an api-profiled PASS records the probe responses ==");
{
  setContract({
    ...BASE_CONTRACT,
    profile: "api",
    profile_spec: {
      boot_argv: ["node", "server.mjs"],
      health_path: "/health",
      probes: [
        { method: "GET", path: "/items", expect: { status: 200, json_keys: ["items"] } },
        { method: "POST", path: "/items", body: {}, expect: { status: 401 } },
      ],
    },
  });
  const r = live();
  const ev = r.evidence[0]?.payload;
  check(
    r.code === 0 && r.out?.verdict === "pass",
    "the PASS is recorded",
    JSON.stringify(r.out)?.slice(0, 300),
  );
  check(
    ev &&
      ev.kind === "api_response" &&
      ev.passed &&
      ev.cases.length === 2 &&
      ev.boot?.health?.healthy,
    "the probe responses are recorded as evidence",
    JSON.stringify(ev)?.slice(0, 300),
  );
}

rmSync(WORK, { recursive: true, force: true });
if (failures.length === 0) {
  console.log(`tester-acceptance: all ${passed} checks passed`);
  process.exit(0);
}
console.log(`tester-acceptance: ${failures.length} FAILED of ${passed + failures.length}`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
