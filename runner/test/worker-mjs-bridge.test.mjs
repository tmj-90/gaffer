// NODE LAUNCHER × MCP BRIDGE — lib/worker.mjs deliver() runs the same host-side bridge
// lifecycle as lib/worker.sh under the docker provider (the second recheck's finding B:
// the Node launcher never started a bridge, so its docker spawns selected the legacy
// DB-directory layout). Drives the REAL deliver() with a fake `docker` on PATH and the
// wrapper in GAFFER_SANDBOX_DRY_RUN=1 (prints the docker argv instead of running), and a
// real host-side bridge with a stub MCP server. Proves:
//   • the docker argv mounts the bridge SOCKET and the BRIDGED config, never $GAFFER_DATA,
//     and no database path or DB env is in it; the claude argv names the bridged config;
//   • the socket was live during the spawn and is gone (with the bridged file) after;
//   • an EMPTY config ({}) ⇒ data plane `none` (no bridge, no databases);
//   • GAFFER_MCP_BRIDGE=0 ⇒ the legacy layout only when asked;
//   • an unrenderable config ⇒ status 76, no spawn;
//   • Worker exposes mcpBridgeOn / startMcpBridge.
// Run: node test/worker-mjs-bridge.test.mjs
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Worker, deliver, mcpBridgeOn } from "../lib/worker.mjs";

const RUNNER_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
let pass = 0;
const failures = [];
const ok = (m) => {
  pass++;
  console.log(`  ok   ${m}`);
};
const bad = (m) => {
  failures.push(m);
  console.log(`  FAIL ${m}`);
};
const check = (c, m) => (c ? ok(m) : bad(m));

const WORK = mkdtempSync(join(tmpdir(), "worker-mjs-bridge-"));
const DATA = join(WORK, "data");
mkdirSync(DATA, { recursive: true });
const FAKEBIN = join(WORK, "bin");
mkdirSync(FAKEBIN);
writeFileSync(join(FAKEBIN, "docker"), "#!/usr/bin/env bash\nexit 0\n");
chmodSync(join(FAKEBIN, "docker"), 0o755);
const STUB = join(WORK, "stub.mjs");
writeFileSync(STUB, `process.stdin.on("data", (d) => process.stdout.write(d));\n`);
const MCP = join(DATA, "mcp-runtime.777.json");
writeFileSync(
  MCP,
  JSON.stringify({
    mcpServers: {
      dispatch: {
        command: process.execPath,
        args: [STUB],
        env: { DISPATCH_DB: join(DATA, "dispatch.sqlite"), GAFFER_CLAIM_TOKEN: "TOPSECRET" },
      },
    },
  }),
);
writeFileSync(join(DATA, "dispatch.sqlite"), "");
// The docker dry-run prints the argv; the dry-run wrapper never runs the command, so a
// "socket live during the spawn" probe is the wrapper's own `-e` check: it _dies if the
// socket path does not exist when it assembles the mounts.
const CWD = join(WORK, "wt");
mkdirSync(CWD);

const SAVED = { ...process.env };
function withEnv(extra, fn) {
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED, extra);
  try {
    return fn();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
    Object.assign(process.env, SAVED);
  }
}
const BASE = {
  STRICT_MODE: "1",
  SANDBOX_PROVIDER: "docker",
  GAFFER_SANDBOX_DRY_RUN: "1",
  GAFFER_DATA: DATA,
  RUNNER_DIR,
  PATH: `${FAKEBIN}:${process.env.PATH}`,
};
// The wrapper (sandbox-docker.sh) reads its dry-run switch + fake-docker PATH from the
// env deliver() passes it, so the caller env carries BASE too (as the runners' does).
const run = (extra, argv) =>
  withEnv({ ...BASE, ...extra }, () =>
    deliver({
      bin: "claude",
      argv,
      cwd: CWD,
      timeoutMs: 20_000,
      maxBuffer: 4 << 20,
      env: { ...BASE, ...extra, GAFFER_WRITE_ROOTS: CWD, GAFFER_READ_ROOTS: "" },
    }),
  );
const lines = (r) => (r.stdout || "").split("\n");

console.log("== helpers ==");
check(
  mcpBridgeOn({ GAFFER_MCP_BRIDGE: "1" }) === true &&
    mcpBridgeOn({ GAFFER_MCP_BRIDGE: "0" }) === false,
  "mcpBridgeOn honours 1/0",
);
check(
  typeof Worker.mcpBridgeOn === "function" && typeof Worker.startMcpBridge === "function",
  "Worker exposes mcpBridgeOn + startMcpBridge",
);

console.log("== bridge on + real MCP config ⇒ bridged argv, socket mounted, no $GAFFER_DATA ==");
{
  const r = run({ GAFFER_MCP_BRIDGE: "1" }, ["-p", "hi", "--mcp-config", MCP]);
  const L = lines(r);
  check(
    r.status === 0,
    `docker dry-run wrap ran (status ${r.status}) ${(r.stderr || "").slice(0, 200)}`,
  );
  const sockMount = L.find((l) => /^\/tmp\/gaffer-mcp\.[^/:]+\/b\.sock:.*:rw$/.test(l));
  check(!!sockMount, `the bridge socket is mounted rw (${sockMount || "missing"})`);
  check(
    L.includes(
      `${MCP.replace(/\.json$/, "")}.bridge.json:${MCP.replace(/\.json$/, "")}.bridge.json:ro`,
    ),
    "the BRIDGED config is mounted ro",
  );
  check(
    L.includes(`${MCP.replace(/\.json$/, "")}.bridge.json`),
    "claude's --mcp-config names the BRIDGED config",
  );
  check(!L.includes(MCP), "the host config (with the token) is not handed to claude");
  check(!L.includes(`${DATA}:${DATA}:rw`), "$GAFFER_DATA is NOT mounted");
  check(!L.some((l) => /dispatch\.sqlite/.test(l)), "no database path anywhere in the argv");
  check(!L.includes("DISPATCH_DB"), "DISPATCH_DB not forwarded");
  check(L.includes(`${CWD}:${CWD}:rw`), "the write root is still mounted rw");
  const leftovers = readdirSync(DATA).filter((f) => /\.sock$|\.bridge\.json$/.test(f));
  check(
    leftovers.length === 0,
    `socket + bridged config removed after the spawn (${leftovers.join(",") || "none left"})`,
  );
  const sockDir = sockMount ? sockMount.split(":")[0].replace(/\/b\.sock$/, "") : "";
  check(
    sockDir !== "" && !existsSync(sockDir),
    `private socket dir removed after the spawn (${sockDir})`,
  );
}

console.log("== empty config ({}) ⇒ data plane none: no bridge, no databases ==");
{
  const EMPTY = join(DATA, "mcp-runtime.empty.json");
  writeFileSync(EMPTY, "{}");
  const r = run({ GAFFER_MCP_BRIDGE: "1" }, ["-p", "hi", "--mcp-config", EMPTY]);
  const L = lines(r);
  check(
    r.status === 0,
    `empty config spawns (status ${r.status}) ${(r.stderr || "").slice(0, 200)}`,
  );
  check(L.includes(EMPTY), "the original (empty) config is handed to claude");
  check(!L.some((l) => /\.sock:/.test(l)), "no bridge socket mounted");
  check(!L.includes(`${DATA}:${DATA}:rw`), "$GAFFER_DATA is NOT mounted (data plane none)");
}

console.log("== GAFFER_MCP_BRIDGE=0 ⇒ the legacy layout, only when asked ==");
{
  const r = run({ GAFFER_MCP_BRIDGE: "0" }, ["-p", "hi", "--mcp-config", MCP]);
  const L = lines(r);
  check(
    r.status === 0 && L.includes(`${DATA}:${DATA}:rw`),
    "bridge off: the DB directory is mounted rw (legacy, masked)",
  );
  check(
    /MCP data plane runs INSIDE the container/.test(r.stderr || ""),
    "bridge off: the wrapper WARNS that the databases are reachable",
  );
}

console.log("== unrenderable config ⇒ status 76, no spawn ==");
{
  const BAD = join(DATA, "mcp-runtime.bad.json");
  writeFileSync(BAD, "not json");
  const r = run({ GAFFER_MCP_BRIDGE: "1" }, ["-p", "hi", "--mcp-config", BAD]);
  check(r.status === 76, `status 76 (got ${r.status})`);
  check(!(r.stdout || "").trim(), "no docker argv printed — nothing was spawned");
  check(
    /fail closed/.test(r.error ? String(r.error.message || r.error) : "") ||
      /fail closed/.test(r.stderr || ""),
    "the refusal says fail closed",
  );
}

rmSync(WORK, { recursive: true, force: true });
console.log();
if (failures.length === 0) {
  console.log(`worker-mjs-bridge: ALL ${pass} checks passed`);
  process.exit(0);
}
console.log(`worker-mjs-bridge: ${failures.length} FAILED (of ${pass + failures.length})`);
process.exit(1);
