#!/usr/bin/env node
// =====================================================================
// TESTER LANE CLEAN REPLAY CONTAINMENT (bin/tester-run.mjs replayTesterTests)
// ---------------------------------------------------------------------
// The clean replay runs test files the tester agent wrote. They are the tester's code,
// so they run inside the gate sandbox seam, in a stripped environment, and the proof
// reporter's signing key never sits in any process's environment. A fixture test file
// (the "probe") records what it can reach from inside the replay; this file asserts it:
//   (a) ENVIRONMENT (Linux, /proc): walking its ancestor processes and reading each one's
//       /proc/<pid>/environ, the probe finds no GAFFER_REPLAY_PROOF_KEY, only the
//       GAFFER_REPLAY_PROOF_KEY_FILE path, and that file is gone by the time a test runs;
//   (b) READS OUTSIDE THE CHECKOUT: $GAFFER_DATA/factory.log and $HOME/.ssh/id_test are
//       refused under sandbox-exec (macOS) and absent under the docker provider; where
//       neither exists, strict mode HOLDS the replay instead of running it unsandboxed;
//   (c) THE DISPATCH CLI: a stub `wg` on the runner's PATH is never reached from inside;
//   (d) STRICT MODE with no sandbox on the host: the replay holds (never runs), and the
//       tester's PASS is held unverified with a reason naming the sandbox;
//   (e) MODEL CREDENTIALS: ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, GAFFER_DATA and
//       DISPATCH_DB are absent from the probe's environment.
// The docker provider is driven through lib/fake-docker.sh (no daemon): the wrapper is the
// real lib/sandbox-docker.sh, and the recorded `docker run` argv shows what the container
// would have been given.
// Run: node runner/test/tester-replay-containment.test.mjs
// =====================================================================
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { gafferMkdtemp } from "./lib/tmpdir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0;
let skips = 0;
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
function skip(reason) {
  skips++;
  console.log(`SKIP: ${reason}`);
}

const WORK = realpathSync(gafferMkdtemp(join(tmpdir(), "tester-replay-containment-")));
process.on("exit", () => rmSync(WORK, { recursive: true, force: true }));
const DATA = join(WORK, "data");
const HOME = join(WORK, "home");
const BIN = join(WORK, "bin");
const MARKER = join(WORK, "wg-was-called");
mkdirSync(join(DATA, "worktrees"), { recursive: true });
mkdirSync(join(HOME, ".ssh"), { recursive: true });
mkdirSync(BIN, { recursive: true });
const FACTORY_LOG = join(DATA, "factory.log");
const SSH_KEY = join(HOME, ".ssh", "id_test");
writeFileSync(FACTORY_LOG, "dummy factory log, not a secret\n");
writeFileSync(SSH_KEY, "dummy key, not a secret\n");
// A stub `wg` first on the runner's PATH: if the replay's test code reaches it, the marker
// appears.
writeFileSync(join(BIN, "wg"), `#!/bin/sh\necho "$@" > ${JSON.stringify(MARKER)}\nexit 0\n`);
chmodSync(join(BIN, "wg"), 0o755);

// The runner's own environment, as a live runner has it (dummy values only).
Object.assign(process.env, {
  GAFFER_DATA: DATA,
  DISPATCH_DB: join(DATA, "dispatch.sqlite"),
  HOME,
  PATH: `${BIN}:${process.env.PATH}`,
  ANTHROPIC_API_KEY: "dummy-api-key-for-the-containment-test",
  CLAUDE_CODE_OAUTH_TOKEN: "dummy-oauth-token-for-the-containment-test",
});
for (const k of ["STRICT_MODE", "GAFFER_STRICT_REQUIRE", "SANDBOX_PROVIDER", "GAFFER_DOD_SANDBOX"])
  delete process.env[k];
writeFileSync(join(DATA, "dispatch.sqlite"), "");

const { replayTesterTests, unverifiedPassReason } = await import("../bin/tester-run.mjs");

// ── The fixture: a repo with one candidate test, and a tester worktree with the probe ──
const git = (cwd, ...a) =>
  spawnSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...a], {
    encoding: "utf8",
  });
const REPO = join(WORK, "repo");
mkdirSync(join(REPO, "test"), { recursive: true });
git(REPO, "init", "-q", "-b", "main");
writeFileSync(join(REPO, "package.json"), JSON.stringify({ name: "fx", type: "module" }));
writeFileSync(
  join(REPO, "test", "base.test.mjs"),
  'import test from "node:test";\ntest("base", () => {});\n',
);
git(REPO, "add", "-A");
git(REPO, "commit", "-qm", "base");
const COMMIT = git(REPO, "rev-parse", "HEAD").stdout.trim();

const TESTER = join(WORK, "tester");
mkdirSync(join(TESTER, "test"), { recursive: true });
const PROBE = `import test from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
test("probe", () => {
  const out = { names: [], keyFiles: [], ancestors: 0, reads: {}, wg: null, env: [] };
  // (a) every ancestor's initial environment (Linux /proc only).
  const names = new Set();
  let pid = process.pid;
  for (let i = 0; i < 40 && pid > 1; i++) {
    let environ = "";
    try { environ = readFileSync("/proc/" + pid + "/environ", "utf8"); } catch {}
    if (environ) out.ancestors++;
    for (const kv of environ.split("\\0")) {
      const k = kv.split("=")[0];
      if (!k.startsWith("GAFFER_REPLAY_")) continue;
      names.add(k);
      if (k.endsWith("_FILE")) { const p = kv.slice(k.length + 1); out.keyFiles.push({ path: p, exists: existsSync(p) }); }
    }
    let status = "";
    try { status = readFileSync("/proc/" + pid + "/status", "utf8"); } catch { break; }
    const m = /PPid:\\s*(\\d+)/.exec(status);
    if (!m) break;
    pid = Number(m[1]);
  }
  out.names = [...names].sort();
  // (b) reads outside the checkout.
  for (const [k, p] of Object.entries({ factoryLog: ${JSON.stringify(FACTORY_LOG)}, sshKey: ${JSON.stringify(SSH_KEY)} })) {
    try { readFileSync(p, "utf8"); out.reads[k] = "read"; } catch (e) { out.reads[k] = "refused:" + (e.code || e.message); }
  }
  // (c) the dispatch CLI as the system actor.
  const r = spawnSync("wg", ["ticket", "tester-pass", "1", "--as", "system"], { encoding: "utf8" });
  out.wg = { status: r.status, error: r.error ? r.error.code : null, stderr: (r.stderr || "").slice(0, 200) };
  // (e) the runner's credentials and data-plane variables.
  out.env = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "GAFFER_DATA", "DISPATCH_DB", "GAFFER_REPLAY_PROOF_KEY"].filter((k) => k in process.env);
  writeFileSync("probe.json", JSON.stringify(out));
});
`;
writeFileSync(join(TESTER, "test", "probe.test.mjs"), PROBE);

// The registered command prints what the probe wrote as its last line: the replay checkout
// is removed afterwards, and the replay's tail is its last lines of output.
const TEST_CMD = 'node --test; s=$?; echo "PROBE $(cat probe.json 2>/dev/null)"; exit $s';
let nReplay = 100;
function replay(envOverrides = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(envOverrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(MARKER, { force: true });
  try {
    const res = replayTesterTests({
      repoPath: REPO,
      testedCommit: COMMIT,
      testerWorktree: TESTER,
      testFiles: ["test/probe.test.mjs"],
      testCommand: TEST_CMD,
      n: nReplay++,
    });
    const line = String(res.tail || "")
      .split("\n")
      .reverse()
      .find((l) => l.startsWith("PROBE "));
    let probe = null;
    try {
      probe = line ? JSON.parse(line.slice("PROBE ".length)) : null;
    } catch {
      probe = null;
    }
    return { res, probe, marker: existsSync(MARKER) };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
const isLinux = process.platform === "linux" && existsSync("/proc/self/environ");
const hasSandboxExec = spawnSync("sh", ["-c", "command -v sandbox-exec"]).status === 0;

console.log("== no sandbox configured: the env scrub and the key file still apply ==");
{
  const { res, probe, marker } = replay();
  assert(
    "the replay runs and passes with no sandbox configured",
    res.state === "passed" && probe !== null,
    JSON.stringify(res).slice(0, 600),
  );
  if (isLinux) {
    assert(
      "(a) the probe read its ancestors' environments (the walk worked)",
      probe && probe.ancestors >= 2,
      JSON.stringify(probe),
    );
    assert(
      "(a) no ancestor of a test process holds the signing key in its environment",
      probe && !probe.names.includes("GAFFER_REPLAY_PROOF_KEY"),
      JSON.stringify(probe && probe.names),
    );
    assert(
      "(a) only the key FILE's path travels in the environment",
      probe &&
        probe.names.length === 1 &&
        probe.names[0] === "GAFFER_REPLAY_PROOF_KEY_FILE" &&
        probe.keyFiles.length > 0,
      JSON.stringify(probe && probe.names),
    );
    assert(
      "(a) the key file no longer exists by the time a test runs",
      probe && probe.keyFiles.length > 0 && probe.keyFiles.every((f) => f.exists === false),
      JSON.stringify(probe && probe.keyFiles),
    );
  } else
    skip(
      "(a) the /proc ancestor walk needs Linux; on macOS the sandbox-exec run below covers the replay",
    );
  assert(
    "(a) the replay's identities are still proven with the key in a file",
    Array.isArray(res.tests) && res.tests.some((t) => /probe\.test\.mjs$/.test(t.file || "")),
    JSON.stringify(res.tests),
  );
  assert(
    "(c) `wg ticket tester-pass` from inside the replay does not reach the runner's wg",
    !marker && probe && probe.wg && probe.wg.status !== 0,
    JSON.stringify(probe && probe.wg),
  );
  assert(
    "(e) no model credential, GAFFER_DATA or DISPATCH_DB in the test process's environment",
    probe && probe.env.length === 0,
    JSON.stringify(probe && probe.env),
  );
}

console.log("== (b)/(d) strict mode: sandboxed, or held when the host has no sandbox ==");
if (hasSandboxExec) {
  const { res, probe, marker } = replay({ STRICT_MODE: "1", SANDBOX_PROVIDER: "sandbox-exec" });
  assert(
    "(b) the replay runs under sandbox-exec and passes",
    res.state === "passed" && probe !== null,
    JSON.stringify(res).slice(0, 600),
  );
  assert(
    "(b) $GAFFER_DATA/factory.log cannot be read from inside the replay",
    probe && /^refused/.test(probe.reads.factoryLog || ""),
    JSON.stringify(probe && probe.reads),
  );
  assert(
    "(b) $HOME/.ssh/id_test cannot be read from inside the replay",
    probe && /^refused/.test(probe.reads.sshKey || ""),
    JSON.stringify(probe && probe.reads),
  );
  assert("(c) wg not reached under sandbox-exec either", !marker);
  assert("(e) no credential under sandbox-exec either", probe && probe.env.length === 0);
} else {
  skip(
    "(b) sandbox-exec is macOS-only and no docker daemon runs here: the read refusal is asserted on the macOS CI jobs; the strict-mode hold is asserted below",
  );
  const { res, probe, marker } = replay({ STRICT_MODE: "1", SANDBOX_PROVIDER: "sandbox-exec" });
  assert(
    "(d) STRICT_MODE=1 with no sandbox on this host: the replay HOLDS instead of running",
    res.state === "held",
    JSON.stringify(res).slice(0, 600),
  );
  assert("(d) the hold's reason names the sandbox", /sandbox/i.test(res.reason || ""), res.reason);
  assert(
    "(d) no tester code ran (no probe output, wg not reached)",
    probe === null && !marker,
    JSON.stringify({ probe, marker }),
  );
  const why = unverifiedPassReason({ replay: res, repoName: "fx", ticket: 1 });
  assert(
    "(d) the PASS is held unverified with the sandbox named, never recorded",
    /^unverified: /.test(why) && /sandbox/i.test(why) && /not recorded/.test(why),
    why,
  );
}
{
  const { res, probe, marker } = replay({ GAFFER_STRICT_REQUIRE: "1", SANDBOX_PROVIDER: "none" });
  assert(
    "(d) GAFFER_STRICT_REQUIRE=1 with SANDBOX_PROVIDER=none: the provider refuses, the replay HOLDS",
    res.state === "held" && /sandbox/i.test(res.reason || "") && probe === null && !marker,
    JSON.stringify(res).slice(0, 600),
  );
}
{
  // STRICT_MODE=1 and an unknown provider on any host: no wrap, so a hold, never a bare run.
  const { res, probe } = replay({ STRICT_MODE: "1", SANDBOX_PROVIDER: "no-such-provider" });
  assert(
    "(d) STRICT_MODE=1 whose provider supplies no wrap: held, on every host",
    res.state === "held" && probe === null,
    JSON.stringify(res).slice(0, 600),
  );
}

console.log("== the docker provider (lib/fake-docker.sh: the real wrapper, no daemon) ==");
{
  const FAKEBIN = join(WORK, "fakebin");
  const LOG = join(WORK, "docker-log");
  mkdirSync(FAKEBIN, { recursive: true });
  // The wrapper starts with the runner's sandbox settings only (wrappedSpawn), so the
  // fake's log directory is baked into a small `docker` front for it.
  copyFileSync(join(HERE, "lib", "fake-docker.sh"), join(WORK, "fake-docker.sh"));
  writeFileSync(
    join(FAKEBIN, "docker"),
    `#!/usr/bin/env bash\nFAKE_DOCKER_LOG=${JSON.stringify(LOG)} exec bash ${JSON.stringify(join(WORK, "fake-docker.sh"))} "$@"\n`,
  );
  chmodSync(join(FAKEBIN, "docker"), 0o755);
  const { res, probe, marker } = replay({
    STRICT_MODE: "1",
    SANDBOX_PROVIDER: "docker",
    PATH: `${FAKEBIN}:${process.env.PATH}`,
    // The fake "container" is this host: its PATH must find this node.
    GAFFER_SANDBOX_PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
  });
  assert(
    "docker: the replay ran through the container wrapper and passed",
    res.state === "passed" && probe !== null,
    JSON.stringify(res).slice(0, 600),
  );
  assert(
    "docker: the reporter read the key file inside the container: the identities are proven",
    Array.isArray(res.tests) && res.tests.some((t) => /probe\.test\.mjs$/.test(t.file || "")),
    JSON.stringify(res.tests),
  );
  const calls = existsSync(join(LOG, "calls.txt"))
    ? readFileSync(join(LOG, "calls.txt"), "utf8").trim().split("\n")
    : [];
  const runs = calls
    .filter((l) => / run$/.test(l))
    .map((l) => readFileSync(join(LOG, `${l.split(" ")[0]}.argv`), "utf8").split("\0"))
    .filter((a) => a.includes("--rm"));
  assert("docker: one container per replay run", runs.length >= 1, JSON.stringify(calls));
  const argv = runs[0] || [];
  const mounts = argv
    .map((a, i) => (argv[i - 1] === "-v" ? a : null))
    .filter(Boolean)
    .map((m) => m.split(":")[0]);
  const forwarded = argv.map((a, i) => (argv[i - 1] === "-e" ? a : null)).filter(Boolean);
  const dataMounts = mounts.filter(
    (m) => m.startsWith(DATA) && !m.startsWith(join(DATA, "worktrees", "tester-replay-")),
  );
  assert(
    "docker: nothing under $GAFFER_DATA is mounted but the replay checkout (validation layout)",
    dataMounts.filter((m) => !m.startsWith(join(DATA, "sandbox-git"))).length === 0,
    JSON.stringify(mounts),
  );
  assert(
    "docker: $HOME is not mounted",
    !mounts.some((m) => m === HOME || m.startsWith(`${HOME}/`)),
    JSON.stringify(mounts),
  );
  assert(
    "docker: no model credential and no signing key forwarded to the container",
    !forwarded.some((e) =>
      /^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|GAFFER_REPLAY_PROOF_KEY)(=|$)/.test(e),
    ),
    JSON.stringify(forwarded),
  );
  const inner = argv.slice(argv.indexOf("env"));
  assert(
    "docker: the command's own environment carries the key FILE path, never the key",
    inner.some((a) => a.startsWith("GAFFER_REPLAY_PROOF_KEY_FILE=")) &&
      !inner.some((a) => a.startsWith("GAFFER_REPLAY_PROOF_KEY=")),
    JSON.stringify(inner.slice(0, 12)),
  );
  assert(
    "docker: no credential in the test process, wg not reached",
    probe && probe.env.length === 0 && !marker,
    JSON.stringify(probe),
  );
  if (isLinux)
    assert(
      "docker: the key file was gone before the probe ran",
      probe && probe.keyFiles.length > 0 && probe.keyFiles.every((f) => f.exists === false),
      JSON.stringify(probe && probe.keyFiles),
    );
}

console.log("== the replay sandbox-exec profile (generated on any host) ==");
{
  const WT = join(DATA, "worktrees", "tester-replay-x");
  const RR = join(REPO, "node_modules");
  mkdirSync(WT, { recursive: true });
  mkdirSync(RR, { recursive: true });
  const out = join(WORK, "replay.sb");
  const r = spawnSync(
    "bash",
    [
      "-c",
      'source "$0/lib/sandbox.sh" && _sandbox_exec_profile "$1" "$2" "$3"',
      resolve(HERE, ".."),
      WT,
      out,
      RR,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, GAFFER_SANDBOX_PROFILE: "replay", GAFFER_DATA: DATA, HOME },
    },
  );
  const sb = existsSync(out) ? readFileSync(out, "utf8") : "";
  assert("the replay profile is generated", r.status === 0 && sb.length > 0, r.stderr);
  const after = (needle, from) => sb.indexOf(needle, from);
  const denyData = after(`(deny file-read-data`);
  assert(
    "replay profile: reads of $GAFFER_DATA are denied",
    denyData >= 0 && sb.indexOf(`(subpath "${DATA}")`, denyData) > denyData,
    sb,
  );
  const allowData = after(`(allow file-read-data`, denyData);
  assert(
    "replay profile: …then re-allowed for the checkout and the dependency link only",
    allowData > denyData &&
      sb.indexOf(`(subpath "${WT}")`, allowData) > allowData &&
      sb.indexOf(`(subpath "${RR}")`, allowData) > allowData,
    sb,
  );
  const denyHome = after(`(deny file-read*`, allowData);
  assert(
    "replay profile: HOME's secret folders are denied after that",
    denyHome > allowData &&
      [".ssh", ".aws", ".config/gh", ".claude", ".npmrc", ".netrc", ".gnupg"].every(
        (d) => sb.indexOf(`(subpath "${HOME}/${d}")`, denyHome) > denyHome,
      ),
    sb,
  );
  const denyWrite = sb.indexOf(`(deny file-write*\n  (subpath "${DATA}"))`);
  const regrant = sb.indexOf("(allow file-write*", denyWrite);
  assert(
    "replay profile: $GAFFER_DATA is not a write root (writes there denied, the checkout re-granted)",
    denyWrite > 0 && regrant > denyWrite && sb.indexOf(`(subpath "${WT}")`, regrant) > regrant,
    sb,
  );
  const v = spawnSync(
    "bash",
    [
      "-c",
      'source "$0/lib/sandbox.sh" && _sandbox_exec_profile "$1" "$2"',
      resolve(HERE, ".."),
      WT,
      join(WORK, "validation.sb"),
    ],
    {
      encoding: "utf8",
      env: { ...process.env, GAFFER_SANDBOX_PROFILE: "validation", GAFFER_DATA: DATA, HOME },
    },
  );
  const vsb = existsSync(join(WORK, "validation.sb"))
    ? readFileSync(join(WORK, "validation.sb"), "utf8")
    : "";
  assert(
    "the validation profile is unchanged (no read denials, $GAFFER_DATA writable)",
    v.status === 0 && !/deny file-read/.test(vsb) && vsb.includes(`(subpath "${DATA}")`),
    vsb,
  );
}

// Nothing the replays left behind: every replay checkout and scratch dir is gone.
const leftovers = readdirSync(join(DATA, "worktrees")).filter((d) =>
  d.startsWith("tester-replay-1"),
);
assert("every replay checkout was removed", leftovers.length === 0, JSON.stringify(leftovers));

console.log(
  `\n${fails.length === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fails.length} failed, ${skips} skipped`,
);
if (fails.length) {
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
