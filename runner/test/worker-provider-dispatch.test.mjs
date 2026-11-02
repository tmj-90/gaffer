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
//   • provider=command: the second real provider — GAFFER_WORKER_COMMAND runs under the
//     GAFFER_WORKER_* contract (read from the launcher's claude-shaped argv), needs an
//     OS sandbox unless GAFFER_STRICT_REQUIRE=0, and res.stdout is the canonical envelope.
//   • provider=codex / local / unknown: FAIL CLOSED — res.error set, non-zero
//     res.status, the exact message, and NO spawn (negative control: NO marker).
//   • the honest message is word-for-word the bash seam's.
//   • callers' existing `res.error` handling fires (decompose throws it,
//     product-owner calls fail()) — verified via the shape of the returned object.
//
// Zero deps beyond node. Run: node test/worker-provider-dispatch.test.mjs
// =====================================================================
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { gafferMkdtemp } from "./lib/tmpdir.mjs";
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

const WORK = gafferMkdtemp(join(tmpdir(), "worker-provider-mjs-"));
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

console.log("== a usage-window pause: no spawn, status 75, like the bash seam and gaffer plan ==");
// The bash seam (tick.sh, worker.sh, loop.sh) and `gaffer plan` start nothing while
// $GAFFER_DATA/usage-pause.json is in force; every Node launcher (the dashboard's
// planner, Suggest work, onboarding, the tester, the merge resolver) goes through
// deliver(), so the refusal lives there: before any spawn, both providers.
{
  const PAUSE_DATA = join(WORK, "pause-data");
  mkdirSync(PAUSE_DATA, { recursive: true });
  const until = Date.now() + 3600e3;
  writeFileSync(
    join(PAUSE_DATA, "usage-pause.json"),
    JSON.stringify({
      paused_until: new Date(until).toISOString(),
      until_ms: until,
      kind: "usage_limit",
      basis: "default",
      message: "stub limit",
      ticket: null,
      lane: "delivery",
      recorded_at: new Date().toISOString(),
    }),
  );
  const prevData = process.env.GAFFER_DATA;
  const prevFile = process.env.GAFFER_USAGE_PAUSE_FILE;
  delete process.env.GAFFER_USAGE_PAUSE_FILE;
  process.env.GAFFER_DATA = PAUSE_DATA;
  try {
    const res = callDeliver("claude-code");
    !existsSync(MARKER)
      ? ok("paused: claude-code did NOT spawn (no marker)")
      : bad("paused: claude-code spawned a paid call while the factory is paused");
    res.status === 75 && res.usagePaused === true && !res.budgetRefused
      ? ok("paused: status 75 (gaffer run / gaffer plan's code), usagePaused set")
      : bad(`paused: status=${res.status} usagePaused=${res.usagePaused}`);
    res.error instanceof Error && res.error.code !== "ETIMEDOUT" && res.stdout === ""
      ? ok(
          "paused: res.error set, not a timeout, empty stdout (callers' error path fires, nothing to ledger)",
        )
      : bad(`paused: error=${res.error} stdout=${JSON.stringify(res.stdout)}`);
    /paused until .* UTC: usage limit/.test(res.error?.message || "") &&
    /usage-pause\.mjs clear/.test(res.error?.message || "")
      ? ok("paused: the message names the pause line and how to lift it")
      : bad(`paused: message '${res.error?.message}'`);
    const cmd = callDeliver("command");
    !existsSync(MARKER) && cmd.status === 75 && cmd.usagePaused === true
      ? ok("paused: the command provider refuses the same way")
      : bad(`paused: command provider status=${cmd.status} usagePaused=${cmd.usagePaused}`);
    // An expired pause is no pause.
    const past = Date.now() - 60e3;
    writeFileSync(
      join(PAUSE_DATA, "usage-pause.json"),
      JSON.stringify({ paused_until: new Date(past).toISOString(), until_ms: past }),
    );
    const after = callDeliver("claude-code");
    existsSync(MARKER) && !after.error
      ? ok("an expired pause: claude-code spawns again")
      : bad(`expired pause still refused (status=${after.status})`);
  } finally {
    if (prevData === undefined) delete process.env.GAFFER_DATA;
    else process.env.GAFFER_DATA = prevData;
    if (prevFile !== undefined) process.env.GAFFER_USAGE_PAUSE_FILE = prevFile;
  }
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

// =====================================================================
// THE COMMAND PROVIDER at the mjs seam (parity with worker_deliver; the e2e tick and
// the bash-side containment rule live in worker-command.test.sh).
// =====================================================================
const CMD_DUMP = join(WORK, "command-env.json");
// The worker program lives OUTSIDE the call's cwd/write roots and $GAFFER_DATA (the seam
// refuses one an agent could rewrite), mode 755.
const TOOLS = gafferMkdtemp(join(tmpdir(), "worker-provider-tools-"));
// A CommonJS script (.cjs) so `require` works whatever package type surrounds it. It
// dumps its env, cwd and the prompt file's text; GAFFER_TEST_CMD_SLEEP starts a
// grandchild (its pid recorded) and then hangs, for the timeout test.
const FAKE_CMD_CJS = join(TOOLS, "fake-command-worker.cjs");
const GRANDCHILD_PID = join(WORK, "grandchild.pid");
writeFileSync(
  FAKE_CMD_CJS,
  `#!/usr/bin/env node
const fs = require("node:fs");
let promptFromFile = null;
try { if (process.env.GAFFER_WORKER_PROMPT_FILE) promptFromFile = fs.readFileSync(process.env.GAFFER_WORKER_PROMPT_FILE, "utf8"); } catch (e) { promptFromFile = "ERR " + e.code; }
fs.writeFileSync(${JSON.stringify(CMD_DUMP)}, JSON.stringify({ env: process.env, cwd: process.cwd(), promptFromFile }));
if (process.env.GAFFER_TEST_CMD_SLEEP) {
  const c = require("node:child_process").spawn("sleep", ["30"], { stdio: "ignore" });
  fs.writeFileSync(${JSON.stringify(GRANDCHILD_PID)}, String(c.pid));
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else {
  process.stdout.write("noise\\n" + (process.env.GAFFER_TEST_CMD_STDOUT || JSON.stringify({ result: "cmd ok", cost_usd: 0.5, num_turns: 4, model: "m-cmd", usage: { input_tokens: 7, output_tokens: 2 } })) + "\\n");
  process.exit(Number(process.env.GAFFER_TEST_CMD_EXIT || 0));
}
`,
);
chmodSync(FAKE_CMD_CJS, 0o755);
// A fake docker for the command worker: `docker info` and the egress plumbing succeed,
// `docker run` records its argv and runs the command after the image locally.
const DOCKER_BIN = join(TOOLS, "dockerbin");
const DOCKER_LOG = join(WORK, "docker.log");
mkdirSync(DOCKER_BIN, { recursive: true });
writeFileSync(
  join(DOCKER_BIN, "docker"),
  `#!/usr/bin/env bash
case "$1" in ps) echo fake-proxy; exit 0 ;; run) ;; *) exit 0 ;; esac
shift
for a in "$@"; do [ "$a" = -d ] && exit 0; done
w=""
printf 'RUN' >> ${JSON.stringify(DOCKER_LOG)}
while [ "$#" -gt 0 ]; do
  case "$1" in
    fake-sbx-image) shift; break ;;
    -w) w="$2"; shift 2 ;;
    -v|-e|--tmpfs) printf ' %s %s' "$1" "$2" >> ${JSON.stringify(DOCKER_LOG)}; shift 2 ;;
    --network|--pids-limit|--memory|--cpus|--name) shift 2 ;;
    *) shift ;;
  esac
done
printf '\\nCMD %s\\n' "$1 $2" >> ${JSON.stringify(DOCKER_LOG)}
[ -n "$w" ] && cd "$w"
exec "$@"
`,
);
chmodSync(join(DOCKER_BIN, "docker"), 0o755);
const DOCKER_ENV = {
  SANDBOX_PROVIDER: "docker",
  GAFFER_SANDBOX_IMAGE: "fake-sbx-image",
  GAFFER_SANDBOX_PATH: process.env.PATH,
  GAFFER_MCP_BRIDGE: "1",
  PATH: `${DOCKER_BIN}:${process.env.PATH}`,
};
const CMD_KEYS = [
  "GAFFER_WORKER_PROVIDER",
  "GAFFER_WORKER_COMMAND",
  "GAFFER_WORKER_COMMAND_ENV",
  "GAFFER_STRICT_REQUIRE",
  "STRICT_MODE",
  "SANDBOX_PROVIDER",
  "GAFFER_SANDBOX_DRY_RUN",
  "GAFFER_DATA",
  "GAFFER_TEST_CMD_STDOUT",
  "GAFFER_TEST_CMD_EXIT",
  "OTHER_MODEL_API_KEY",
  "GAFFER_MCP_BRIDGE",
  "GAFFER_SANDBOX_IMAGE",
  "GAFFER_SANDBOX_PATH",
  "GAFFER_WORKER_COMMAND_COST_USD",
  "GAFFER_KILL_ESTIMATE_USD",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "PATH",
];
const CMD_ARGV = [
  "-p",
  "the command prompt",
  "--output-format",
  "json",
  "--mcp-config",
  join(WORK, "mcp.json"),
  "--model",
  "m-hint",
  "--max-turns",
  "4",
  "--tools",
  "",
];
writeFileSync(join(WORK, "mcp.json"), "{}");
function callCommand(extra, callerEnv = {}, { argv = CMD_ARGV, timeoutMs = 10_000 } = {}) {
  const saved = Object.fromEntries(CMD_KEYS.map((k) => [k, process.env[k]]));
  for (const k of CMD_KEYS) if (k !== "PATH") delete process.env[k];
  Object.assign(process.env, {
    GAFFER_WORKER_PROVIDER: "command",
    GAFFER_WORKER_COMMAND: FAKE_CMD_CJS,
    GAFFER_DATA: SBX_DATA,
    ...extra,
  });
  rmSync(CMD_DUMP, { force: true });
  rmSync(MARKER, { force: true });
  try {
    return deliver({
      kind: "decompose",
      bin: FAKE,
      argv,
      cwd: WORK,
      timeoutMs,
      maxBuffer: 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ANTHROPIC_API_KEY: "sk-not-real",
        ...callerEnv,
      },
    });
  } finally {
    for (const k of CMD_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}
const dump = () => (existsSync(CMD_DUMP) ? JSON.parse(readFileSync(CMD_DUMP, "utf8")) : null);

console.log("== provider=command: misconfigured → refuses (status 70), no spawn ==");
{
  const res = callCommand({ GAFFER_WORKER_COMMAND: "", GAFFER_STRICT_REQUIRE: "0" });
  res.status === 70 && !dump() && /GAFFER_WORKER_COMMAND is not set/.test(res.error?.message || "")
    ? ok("GAFFER_WORKER_COMMAND unset → status 70 naming it, nothing spawned")
    : bad(`unset command should refuse (status=${res.status} msg=${res.error?.message})`);
  const rel = callCommand({ GAFFER_WORKER_COMMAND: "worker.cjs", GAFFER_STRICT_REQUIRE: "0" });
  rel.status === 70 && !dump()
    ? ok("a relative GAFFER_WORKER_COMMAND → status 70")
    : bad(`relative command should refuse (status=${rel.status})`);
}

console.log(
  "== provider=command: no OS sandbox → refuses (status 75), whatever STRICT_REQUIRE says ==",
);
for (const extra of [
  { SANDBOX_PROVIDER: "none" },
  { SANDBOX_PROVIDER: "none", GAFFER_STRICT_REQUIRE: "1" },
]) {
  const res = callCommand(extra);
  res.status === 75 && !dump() && (res.stdout || "") === ""
    ? ok(`${JSON.stringify(extra)} → status 75, no spawn, no envelope`)
    : bad(`command without a sandbox should refuse (status=${res.status} spawned=${!!dump()})`);
  /GAFFER_WORKER_PROVIDER=command[\s\S]*SANDBOX_PROVIDER=docker[\s\S]*GAFFER_STRICT_REQUIRE=0/.test(
    res.error?.message || "",
  )
    ? ok("…the refusal names the cause and the fix")
    : bad(`refusal message lacks the fix (got: ${res.error?.message})`);
}

console.log("== provider=command: explicit GAFFER_STRICT_REQUIRE=0 → runs, under the contract ==");
{
  const res = callCommand(
    {
      SANDBOX_PROVIDER: "none",
      GAFFER_STRICT_REQUIRE: "0",
      GAFFER_WORKER_COMMAND_ENV: "OTHER_MODEL_API_KEY",
      OTHER_MODEL_API_KEY: "other-not-real",
    },
    { CLAUDE_FLAGS: "--x" },
  );
  const d = dump();
  res.status === 0 && d
    ? ok("the command worker ran (status 0)")
    : bad(`opt-out should run the worker (status=${res.status} err=${res.error?.message})`);
  !existsSync(MARKER)
    ? ok("…and the claude binary did not")
    : bad("the claude bin ran under provider=command");
  const e = (d && d.env) || {};
  e.GAFFER_WORKER_CONTRACT === "1" &&
  e.GAFFER_WORKER_PROMPT === "the command prompt" &&
  e.GAFFER_WORKER_MODEL === "m-hint" &&
  e.GAFFER_WORKER_MAX_TURNS === "4" &&
  e.GAFFER_WORKER_TOOLS === "none" &&
  e.GAFFER_WORKER_KIND === "decompose" &&
  e.GAFFER_WORKER_MCP_CONFIG === join(WORK, "mcp.json") &&
  e.GAFFER_WORKER_TIMEOUT_SECS === "10"
    ? ok(
        "the claude-shaped argv became the GAFFER_WORKER_* contract (prompt, model, turns, tools none, MCP, kind, timeout)",
      )
    : bad(
        `contract wrong: ${JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => k.startsWith("GAFFER_WORKER_"))))}`,
      );
  !("ANTHROPIC_API_KEY" in e) &&
  !("CLAUDE_FLAGS" in e) &&
  e.OTHER_MODEL_API_KEY === "other-not-real"
    ? ok(
        "the claude-code auth/config surface is dropped; the GAFFER_WORKER_COMMAND_ENV name is passed",
      )
    : bad("command env scrub wrong");
  const j = JSON.parse(res.stdout || "null");
  j &&
  j.gaffer_worker_provider === "command" &&
  j.total_cost_usd === 0.5 &&
  j.num_turns === 4 &&
  j.modelUsage?.["m-cmd"]?.inputTokens === 7
    ? ok("res.stdout is the canonical envelope (the parser adapter ran)")
    : bad(`stdout not normalized: ${res.stdout}`);
  const p = Worker.parseResult(res.stdout);
  p.resultText === "cmd ok" &&
  p.usage.totalCostUsd === 0.5 &&
  p.capHit.numTurns === 4 &&
  p.usageLimit === null
    ? ok("parseResult reads it into the same {resultText, usage, capHit, stopReason} contract")
    : bad(`parseResult on the command envelope: ${JSON.stringify(p)}`);
}
{
  const res = callCommand(
    { SANDBOX_PROVIDER: "none", GAFFER_STRICT_REQUIRE: "0" },
    { GAFFER_TEST_CMD_EXIT: "77" },
  );
  res.status === 1 && !res.budgetRefused
    ? ok("a worker exiting 77 is a failed call (status 1), never the runner's budget refusal")
    : bad(`reserved exit not remapped (status=${res.status})`);
}

console.log("== provider=command: a wrapping sandbox is APPLIED (docker dry-run) ==");
{
  const FAKEBIN = join(WORK, "bin");
  const res = callCommand({
    SANDBOX_PROVIDER: "docker",
    GAFFER_SANDBOX_DRY_RUN: "1",
    PATH: `${FAKEBIN}:${process.env.PATH}`,
  });
  // The dry-run wrapper prints the docker argv instead of running it, so stdout holds
  // no JSON object and the adapter yields no envelope; the worker never ran on the host.
  !dump() && (res.stdout || "") === ""
    ? ok("the host command worker was NOT run directly (the docker wrap intercepted the spawn)")
    : bad("the command worker ran on the host despite the docker wrap");
  res.status === 0
    ? ok("docker (dry-run) wrapped the command worker spawn (status 0)")
    : bad(`docker dry-run status=${res.status} ${res.error?.message || ""}`);
}

console.log("== provider=command: only docker with the MCP bridge counts as containment ==");
{
  // sandbox-exec present (a fake on PATH): a write-only profile that still grants writes
  // under $GAFFER_DATA, which only claude-code's in-process hook guards.
  const SBXBIN = join(TOOLS, "sbxbin");
  mkdirSync(SBXBIN, { recursive: true });
  writeFileSync(
    join(SBXBIN, "sandbox-exec"),
    '#!/usr/bin/env bash\n[ "$1" = -f ] && shift 2\nexec "$@"\n',
  );
  chmodSync(join(SBXBIN, "sandbox-exec"), 0o755);
  const res = callCommand({
    SANDBOX_PROVIDER: "sandbox-exec",
    PATH: `${SBXBIN}:${process.env.PATH}`,
  });
  res.status === 75 &&
  !dump() &&
  /sandbox-exec[\s\S]*GAFFER_DATA[\s\S]*SANDBOX_PROVIDER=docker/.test(res.error?.message || "")
    ? ok("SANDBOX_PROVIDER=sandbox-exec (available) → status 75, no spawn, the refusal says why")
    : bad(
        `sandbox-exec must not contain the command worker (status=${res.status} spawned=${!!dump()} msg=${res.error?.message})`,
      );
  const srv = join(WORK, "mcp-servers.json");
  writeFileSync(
    srv,
    JSON.stringify({ mcpServers: { dispatch: { command: process.execPath, args: ["-e", "0"] } } }),
  );
  const argv = CMD_ARGV.map((a) => (a === join(WORK, "mcp.json") ? srv : a));
  const leg = callCommand({ ...DOCKER_ENV, GAFFER_MCP_BRIDGE: "0" }, {}, { argv });
  leg.status === 75 && !dump() && /GAFFER_MCP_BRIDGE/.test(leg.error?.message || "")
    ? ok("docker without the MCP bridge (databases in the container) → status 75, no spawn")
    : bad(`legacy docker layout should refuse (status=${leg.status} msg=${leg.error?.message})`);
}

console.log("== provider=command: the program must live where no agent can rewrite it ==");
{
  const inCwd = join(WORK, "worker-in-cwd.cjs");
  writeFileSync(inCwd, readFileSync(FAKE_CMD_CJS));
  chmodSync(inCwd, 0o755);
  const inData = join(SBX_DATA, "worker-in-data.cjs");
  writeFileSync(inData, readFileSync(FAKE_CMD_CJS));
  chmodSync(inData, 0o755);
  const gw = join(TOOLS, "worker-gw.cjs");
  writeFileSync(gw, readFileSync(FAKE_CMD_CJS));
  chmodSync(gw, 0o775);
  for (const [label, cmd] of [
    ["in the call's cwd / write root", inCwd],
    ["in $GAFFER_DATA", inData],
    ["group-writable", gw],
  ]) {
    const res = callCommand({ GAFFER_WORKER_COMMAND: cmd, GAFFER_STRICT_REQUIRE: "0" });
    res.status === 70 && !dump()
      ? ok(`a program ${label} → status 70, not spawned`)
      : bad(
          `a program ${label} should be refused (status=${res.status} msg=${res.error?.message})`,
        );
  }
}

console.log("== provider=command under docker: env -i inside, mounts, no claude credential ==");
{
  writeFileSync(DOCKER_LOG, "");
  // The launcher's scrubbed env carries the GAFFER_* knobs (agentChildEnv), which is how
  // the wrapper learns the image name.
  // $GAFFER_DATA outside the write root here, so the prompt file needs its own mount.
  const DATA2 = join(TOOLS, "data");
  mkdirSync(DATA2, { recursive: true });
  const res = callCommand(
    { ...DOCKER_ENV, GAFFER_DATA: DATA2 },
    {
      ANTHROPIC_API_KEY: "sk-not-real",
      GAFFER_SANDBOX_IMAGE: "fake-sbx-image",
    },
  );
  const d = dump();
  const log = readFileSync(DOCKER_LOG, "utf8");
  res.status === 0 && d && /^CMD env -i$/m.test(log)
    ? ok("the command worker ran inside the docker wrapper as `env -i … <program>`")
    : bad(
        `docker-wrapped command worker (status=${res.status} ran=${!!d} log=${log.slice(0, 300)})`,
      );
  const e = (d && d.env) || {};
  !("RUNNER_DIR" in e) && !("GAFFER_HOME" in e) && !("ANTHROPIC_API_KEY" in e) && e.HOME === "/root"
    ? ok(
        "…its env is the scrubbed set only (no wrapper-only vars, no claude credential, HOME rebased)",
      )
    : bad(
        `inner env leaked: ${["RUNNER_DIR", "GAFFER_HOME", "ANTHROPIC_API_KEY"].filter((k) => k in e).join(",")} HOME=${e.HOME}`,
      );
  !/-e ANTHROPIC_API_KEY|-e CLAUDE_CODE_OAUTH_TOKEN/.test(log)
    ? ok("…and the wrapper forwards no claude credential into its container")
    : bad("the claude credential was forwarded into the command worker's container");
  const pf = e.GAFFER_WORKER_PROMPT_FILE || "";
  pf && log.includes(`-v ${pf}:${pf}:ro`) && d.promptFromFile === "the command prompt"
    ? ok("…the prompt file is mounted read-only and holds the prompt")
    : bad(`prompt file not mounted / wrong (file=${pf} content=${d && d.promptFromFile})`);
  pf && !existsSync(pf) ? ok("…and removed after the call") : bad(`prompt file left behind: ${pf}`);
}

console.log("== provider=command: a prompt too big for the environment still arrives ==");
{
  const big = "#big " + "context block line\n".repeat(17000);
  const argv = CMD_ARGV.map((a) => (a === "the command prompt" ? big : a));
  const res = callCommand({ SANDBOX_PROVIDER: "none", GAFFER_STRICT_REQUIRE: "0" }, {}, { argv });
  const d = dump();
  res.status === 0 && d && d.promptFromFile === big && d.env.GAFFER_WORKER_PROMPT === ""
    ? ok(
        `a ${Buffer.byteLength(big)}-byte prompt spawns and arrives whole through GAFFER_WORKER_PROMPT_FILE`,
      )
    : bad(
        `big prompt (status=${res.status} err=${res.error?.code || res.error?.message} got=${d && d.promptFromFile && d.promptFromFile.length})`,
      );
}

console.log("== provider=command: the cost floor ==");
{
  const unrep = JSON.stringify({ result: "r", num_turns: 2 });
  let j = JSON.parse(
    callCommand(
      { SANDBOX_PROVIDER: "none", GAFFER_STRICT_REQUIRE: "0" },
      { GAFFER_TEST_CMD_STDOUT: unrep },
    ).stdout || "{}",
  );
  j.total_cost_usd === 0.05 && j.gaffer_cost_basis === "floor"
    ? ok("an unreported cost is booked at the default floor ($0.05)")
    : bad(`default floor: ${JSON.stringify(j)}`);
  const capped = [...CMD_ARGV, "--max-budget-usd", "0.4"];
  j = JSON.parse(
    callCommand(
      { SANDBOX_PROVIDER: "none", GAFFER_STRICT_REQUIRE: "0" },
      { GAFFER_TEST_CMD_STDOUT: unrep },
      { argv: capped },
    ).stdout || "{}",
  );
  j.total_cost_usd === 0.4 && j.gaffer_cost_basis === "floor"
    ? ok("…or at this call's dollar cap when it has one ($0.40)")
    : bad(`per-call floor: ${JSON.stringify(j)}`);
  j = JSON.parse(
    callCommand(
      { SANDBOX_PROVIDER: "none", GAFFER_STRICT_REQUIRE: "0", GAFFER_WORKER_COMMAND_COST_USD: "0" },
      { GAFFER_TEST_CMD_STDOUT: unrep },
    ).stdout || "{}",
  );
  !("total_cost_usd" in j) && j.gaffer_cost_basis === "unreported"
    ? ok("GAFFER_WORKER_COMMAND_COST_USD=0 trusts the worker (unreported stays unknown)")
    : bad(`explicit 0 floor: ${JSON.stringify(j)}`);
  const W = await import(WORKER);
  W.commandCostFloorUsd({ explicit: "", perCall: "", killFloor: "0.2" }) === 0.2 &&
  W.commandCostFloorUsd({ explicit: "1.5", perCall: "0.4", killFloor: "0.2" }) === 1.5 &&
  W.commandCostFloorUsd({ explicit: "junk", perCall: "", killFloor: "" }) === 0.05
    ? ok("commandCostFloorUsd precedence: explicit, per-call cap, kill floor, $0.05")
    : bad("commandCostFloorUsd precedence wrong");
}

console.log("== provider=command: the timeout takes down the whole process group ==");
{
  rmSync(GRANDCHILD_PID, { force: true });
  const t0 = Date.now();
  const res = callCommand(
    { SANDBOX_PROVIDER: "none", GAFFER_STRICT_REQUIRE: "0" },
    { GAFFER_TEST_CMD_SLEEP: "1" },
    { timeoutMs: 1500 },
  );
  const took = Date.now() - t0;
  const gpid = existsSync(GRANDCHILD_PID) ? Number(readFileSync(GRANDCHILD_PID, "utf8")) : 0;
  let alive = false;
  if (gpid) {
    for (let i = 0; i < 20; i++) {
      try {
        process.kill(gpid, 0);
        alive = true;
      } catch {
        alive = false;
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  took < 8000 && res.status !== 0
    ? ok(`a TERM-ignoring worker is stopped at the timeout (${took} ms)`)
    : bad(`the timed-out worker held the launcher (${took} ms, status=${res.status})`);
  gpid && !alive
    ? ok("…and the grandchild it started is gone too (the group was swept)")
    : bad(`the worker's grandchild survived the timeout (pid ${gpid || "<none>"})`);
  if (gpid && alive) {
    try {
      process.kill(gpid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
}

console.log("== the parser adapter never lets a worker envelope release a ticket attempt-free ==");
{
  const n = Worker.normalizeCommandEnvelope(
    JSON.stringify({
      result: "You've hit your usage limit · resets 3pm (UTC)",
      stop_reason: "max_turns",
    }),
  );
  const j = JSON.parse(n);
  Worker.parseResult(n).usageLimit === null
    ? ok("a usage-limit sentence in a command envelope is NOT a usage-limit outcome")
    : bad("a command envelope was read as a usage-limit refusal");
  j.subtype === "error_max_turns" &&
  j.gaffer_cost_basis === "unreported" &&
  !("total_cost_usd" in j)
    ? ok("stop_reason max_turns → a cap hit; an unreported cost stays unknown (basis: unreported)")
    : bad(`cap/cost normalisation wrong: ${n}`);
  Worker.normalizeCommandEnvelope("no json here") === ""
    ? ok("stdout with no JSON object → no envelope (the ledger books a conservative estimate)")
    : bad("garbage stdout produced an envelope");
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
rmSync(TOOLS, { recursive: true, force: true });

console.log();
if (failures.length === 0) {
  console.log(`PASS: ${passed} checks`);
  process.exit(0);
} else {
  console.log(`FAILED: ${failures.length} of ${passed + failures.length}`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
