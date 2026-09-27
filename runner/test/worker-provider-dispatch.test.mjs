#!/usr/bin/env node
// =====================================================================
// Worker Abstraction Seam — Phase 3 PROVIDER DISPATCH (Spec 3, mjs side).
// ---------------------------------------------------------------------
// Worker.deliver (lib/worker.mjs) picks its backend on $GAFFER_WORKER_PROVIDER,
// mirroring the bash seam (worker.sh) and the sandbox seam (sandbox.sh). This
// suite proves the SEAM — one real provider + honest fail-closed stubs:
//
//   • provider=claude-code (default): BYTE-IDENTICAL — it actually spawns `bin`
//     (positive control: a marker file the fake bin writes appears; status 0).
//   • provider=codex / local / unknown: FAIL CLOSED — res.error set, non-zero
//     res.status, the exact message, and NO spawn (negative control: NO marker).
//   • the honest message is word-for-word the bash seam's.
//   • callers' existing `res.error` handling fires (decompose throws it,
//     product-owner calls fail()) — verified via the shape of the returned object.
//
// Zero deps beyond node. Run: node test/worker-provider-dispatch.test.mjs
// =====================================================================
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = resolve(HERE, "..");
const WORKER = resolve(RUNNER_DIR, "lib", "worker.mjs");

const {
  Worker,
  deliver,
  workerProvider,
  unsupportedProviderMessage,
  DEFAULT_WORKER_PROVIDER,
  sandboxWanted,
  sandboxRequired,
} = await import(WORKER);

let passed = 0;
const failures = [];
const ok = (m) => {
  passed++;
  console.log(`  ok   ${m}`);
};
const bad = (m) => {
  failures.push(m);
  console.log(`  FAIL ${m}`);
};

const WORK = mkdtempSync(join(tmpdir(), "worker-provider-mjs-"));
const MARKER = join(WORK, "spawned.marker");
// A fake worker binary that PROVES a spawn by writing a marker. Path baked in so
// it survives whatever env the caller passes.
const FAKE = join(WORK, "fake-claude.sh");
writeFileSync(
  FAKE,
  `#!/usr/bin/env bash\n: > ${JSON.stringify(MARKER)}\nprintf '%s\\n' '{"result":"ok"}'\n`,
);
chmodSync(FAKE, 0o755);

function callDeliver(provider) {
  try {
    rmSync(MARKER, { force: true });
  } catch {
    /* first run: nothing to remove */
  }
  const prev = process.env.GAFFER_WORKER_PROVIDER;
  if (provider === undefined) delete process.env.GAFFER_WORKER_PROVIDER;
  else process.env.GAFFER_WORKER_PROVIDER = provider;
  try {
    return deliver({
      bin: "bash",
      argv: [FAKE],
      cwd: WORK,
      timeoutMs: 10_000,
      maxBuffer: 1024 * 1024,
      env: process.env,
    });
  } finally {
    if (prev === undefined) delete process.env.GAFFER_WORKER_PROVIDER;
    else process.env.GAFFER_WORKER_PROVIDER = prev;
  }
}

console.log("== helpers ==");
DEFAULT_WORKER_PROVIDER === "claude-code"
  ? ok("DEFAULT_WORKER_PROVIDER is claude-code")
  : bad(`DEFAULT_WORKER_PROVIDER should be claude-code (got ${DEFAULT_WORKER_PROVIDER})`);
workerProvider({}) === "claude-code"
  ? ok("workerProvider defaults to claude-code when unset")
  : bad("workerProvider should default to claude-code");
workerProvider({ GAFFER_WORKER_PROVIDER: "  codex " }) === "codex"
  ? ok("workerProvider trims the env value")
  : bad("workerProvider should trim");
unsupportedProviderMessage("codex") ===
"worker provider codex not yet supported; safety-hook containment unavailable"
  ? ok("unsupportedProviderMessage matches the bash seam word-for-word")
  : bad("unsupportedProviderMessage drifted from the bash seam");

console.log("== provider=claude-code (default) — the real path SPAWNS ==");
{
  const res = callDeliver("claude-code");
  (res.status === 0 || res.status === null) && !res.error
    ? ok("claude-code spawned cleanly (no error)")
    : bad(`claude-code should spawn cleanly (status=${res.status} error=${res.error})`);
  existsSync(MARKER)
    ? ok("claude-code actually spawned the worker (marker present)")
    : bad("claude-code did not spawn (no marker)");
  /"result":"ok"/.test(res.stdout || "")
    ? ok("claude-code returns the worker's stdout verbatim")
    : bad("claude-code did not return the worker stdout");
}

console.log("== default (unset provider) is claude-code — still spawns ==");
{
  const res = callDeliver(undefined);
  existsSync(MARKER) && !res.error
    ? ok("unset provider defaults to claude-code and spawns")
    : bad("unset provider should default to claude-code and spawn");
}

console.log("== provider=codex / local / unknown FAIL CLOSED — no spawn ==");
for (const prov of ["codex", "local", "made-up"]) {
  const res = callDeliver(prov);
  !existsSync(MARKER)
    ? ok(`provider=${prov} did NOT spawn (no marker — fail closed before execution)`)
    : bad(`provider=${prov} spawned — must fail closed before any execution`);
  res.error instanceof Error
    ? ok(`provider=${prov} returns res.error (callers' error path fires)`)
    : bad(`provider=${prov} should set res.error`);
  typeof res.status === "number" && res.status !== 0
    ? ok(`provider=${prov} returns non-zero status (${res.status})`)
    : bad(`provider=${prov} should return non-zero status (got ${res.status})`);
  res.error && res.error.code !== "ETIMEDOUT"
    ? ok(`provider=${prov} error is NOT ETIMEDOUT (so callers don't misledger a timeout)`)
    : bad(`provider=${prov} error must not masquerade as ETIMEDOUT`);
  (res.error?.message || "").includes(
    `worker provider ${prov} not yet supported; safety-hook containment unavailable`,
  )
    ? ok(`provider=${prov} carries the honest containment message`)
    : bad(`provider=${prov} message wrong (got: ${res.error?.message})`);
  (res.stdout || "") === ""
    ? ok(`provider=${prov} stdout is empty (no fabricated envelope)`)
    : bad(`provider=${prov} must not fabricate stdout`);
}

// =====================================================================
// OS-SANDBOX CONTAINMENT AT THE MJS SEAM (parity with worker.sh's worker_deliver).
// The bug this pins: the node seam applied the provider dispatch but NOT the
// sandbox decision the bash seam applies — so under GAFFER_STRICT_REQUIRE=1 with no
// provider available, the merge-conflict resolver / product-owner / tester /
// onboarding analysis spawned BARE while every bash spawn site refused (rc 75).
// =====================================================================
const SANDBOX_KEYS = [
  "STRICT_MODE",
  "GAFFER_STRICT_REQUIRE",
  "SANDBOX_PROVIDER",
  "GAFFER_SANDBOX_DRY_RUN",
  "GAFFER_DATA",
  "PATH",
];
function callDeliverWith(extra) {
  const saved = Object.fromEntries(SANDBOX_KEYS.map((k) => [k, process.env[k]]));
  for (const k of SANDBOX_KEYS) delete process.env[k];
  process.env.PATH = saved.PATH;
  Object.assign(process.env, extra);
  try {
    return callDeliver("claude-code");
  } finally {
    for (const k of SANDBOX_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}
const SBX_DATA = join(WORK, ".gaffer");
mkdirSync(SBX_DATA, { recursive: true });

console.log("== sandbox helpers mirror the bash seam's decision ==");
sandboxRequired({ GAFFER_STRICT_REQUIRE: "1" }) &&
sandboxRequired({ GAFFER_STRICT_REQUIRE: "yes" }) &&
!sandboxRequired({ GAFFER_STRICT_REQUIRE: "0" }) &&
!sandboxRequired({})
  ? ok("sandboxRequired: 1|true|yes|on ⇒ required (sandbox.sh _sandbox_strict_required)")
  : bad("sandboxRequired drifted from _sandbox_strict_required");
sandboxWanted({ STRICT_MODE: "1" }) &&
sandboxWanted({ GAFFER_STRICT_REQUIRE: "1" }) &&
!sandboxWanted({ STRICT_MODE: "0", GAFFER_STRICT_REQUIRE: "0" }) &&
!sandboxWanted({})
  ? ok("sandboxWanted: STRICT_MODE=1 OR required (worker.sh _worker_sandbox_wanted)")
  : bad("sandboxWanted drifted from _worker_sandbox_wanted");

console.log("== sandbox REQUIRED + no provider → FAIL CLOSED (rc 75, no spawn, no envelope) ==");
{
  const res = callDeliverWith({
    STRICT_MODE: "0",
    GAFFER_STRICT_REQUIRE: "1",
    SANDBOX_PROVIDER: "none",
    GAFFER_DATA: SBX_DATA,
  });
  !existsSync(MARKER)
    ? ok("strict-require + provider none: the agent was NOT spawned")
    : bad("strict-require + provider none: agent spawned despite a required, unavailable sandbox");
  res.status === 75
    ? ok("strict-require + provider none: status 75 (the bash seam's refusal code)")
    : bad(`strict-require + provider none: expected status 75 (got ${res.status})`);
  res.error instanceof Error && res.error.code !== "ETIMEDOUT"
    ? ok("strict-require + provider none: res.error set (callers' error path fires), not ETIMEDOUT")
    : bad("strict-require + provider none: res.error should be set and not ETIMEDOUT");
  /fail closed/.test(res.error?.message || "")
    ? ok("strict-require + provider none: refusal is loud and says 'fail closed'")
    : bad(
        `strict-require + provider none: message lacks 'fail closed' (got: ${res.error?.message})`,
      );
  (res.stdout || "") === ""
    ? ok("strict-require + provider none: stdout empty (no fabricated envelope)")
    : bad("strict-require + provider none: stdout must be empty");
}
{
  const res = callDeliverWith({
    STRICT_MODE: "1",
    GAFFER_STRICT_REQUIRE: "1",
    SANDBOX_PROVIDER: "lima",
    GAFFER_DATA: SBX_DATA,
  });
  !existsSync(MARKER) && res.status === 75
    ? ok("STRICT_MODE=1 + unknown provider 'lima' under strict-require → refused, no spawn")
    : bad(
        `unknown provider under strict-require should refuse (status=${res.status} marker=${existsSync(MARKER)})`,
      );
}

console.log("== sandbox off / not required → invocation unchanged (spawns) ==");
{
  const res = callDeliverWith({
    STRICT_MODE: "0",
    GAFFER_STRICT_REQUIRE: "0",
    SANDBOX_PROVIDER: "none",
    GAFFER_DATA: SBX_DATA,
  });
  existsSync(MARKER) && res.status === 0
    ? ok("sandbox off: the agent spawned, status 0")
    : bad(`sandbox off should spawn (status=${res.status})`);
}
{
  const res = callDeliverWith({
    STRICT_MODE: "1",
    GAFFER_STRICT_REQUIRE: "0",
    SANDBOX_PROVIDER: "none",
    GAFFER_DATA: SBX_DATA,
  });
  existsSync(MARKER) && res.status === 0
    ? ok("STRICT_MODE=1 + provider none (not required) degrades and still spawns")
    : bad(`STRICT_MODE=1/none/not-required should degrade (status=${res.status})`);
}

console.log("== a wrapping provider is APPLIED at the mjs seam (docker dry-run) ==");
{
  // Fake `docker` so sandbox_wrap_cmd emits the docker prefix; the wrapper runs in
  // dry-run mode and prints the argv (one element per line) instead of executing —
  // proving the wrap reached the seam and the host binary was NOT run directly.
  const FAKEBIN = join(WORK, "bin");
  mkdirSync(FAKEBIN, { recursive: true });
  writeFileSync(join(FAKEBIN, "docker"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(FAKEBIN, "docker"), 0o755);
  const res = callDeliverWith({
    STRICT_MODE: "1",
    SANDBOX_PROVIDER: "docker",
    GAFFER_SANDBOX_DRY_RUN: "1",
    GAFFER_DATA: SBX_DATA,
    PATH: `${FAKEBIN}:${process.env.PATH}`,
  });
  const lines = (res.stdout || "").split("\n");
  res.status === 0
    ? ok("docker provider (dry-run) wrapped the mjs spawn (status 0)")
    : bad(`docker dry-run wrap status=${res.status} stderr=${(res.stderr || "").slice(0, 200)}`);
  !existsSync(MARKER)
    ? ok("the host worker binary was NOT run directly (the wrap intercepted the spawn)")
    : bad("host worker ran directly — the wrap was not applied");
  lines.includes(`${WORK}:${WORK}:rw`)
    ? ok("the write root (cwd) is mounted rw in the container argv")
    : bad(`write root mount missing from docker argv (got: ${lines.slice(0, 40).join(" | ")})`);
  lines.includes("claude")
    ? ok("inside docker the image's own `claude` is invoked, not the host path")
    : bad("expected the container claude binary in argv");
  lines.includes("HOME=/root")
    ? ok("HOME is rebased to the container's /root for the in-container command")
    : bad("HOME not rebased for the container");
}

console.log("== Worker.* namespace re-exports the seam ==");
typeof Worker.workerProvider === "function" &&
typeof Worker.unsupportedProviderMessage === "function"
  ? ok("Worker exposes workerProvider + unsupportedProviderMessage")
  : bad("Worker should re-export the provider helpers");
typeof Worker.sandboxWanted === "function" &&
typeof Worker.sandboxRequired === "function" &&
typeof Worker.sandboxWrapArgv === "function"
  ? ok("Worker exposes the sandbox decision helpers")
  : bad("Worker should re-export sandboxWanted / sandboxRequired / sandboxWrapArgv");

rmSync(WORK, { recursive: true, force: true });

console.log();
if (failures.length === 0) {
  console.log(`PASS: ${passed} checks`);
  process.exit(0);
} else {
  console.log(`FAILED: ${failures.length} of ${passed + failures.length}`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
