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
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = resolve(HERE, "..");
const WORKER = resolve(RUNNER_DIR, "lib", "worker.mjs");

const { Worker, deliver, workerProvider, unsupportedProviderMessage, DEFAULT_WORKER_PROVIDER } =
  await import(WORKER);

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

console.log("== Worker.* namespace re-exports the seam ==");
typeof Worker.workerProvider === "function" &&
typeof Worker.unsupportedProviderMessage === "function"
  ? ok("Worker exposes workerProvider + unsupportedProviderMessage")
  : bad("Worker should re-export the provider helpers");

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
