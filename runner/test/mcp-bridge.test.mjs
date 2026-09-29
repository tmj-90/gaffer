// MCP data-plane BRIDGE (lib/mcp-bridge.mjs) — the docker provider's way of keeping the
// dispatch/memory servers (and their SQLite files + claim token) on the HOST while the
// container talks to them over one unix socket. Real processes, real socket, no docker:
//   • render: every server becomes `mcp-bridge.mjs connect …`, with NO env (the token
//     never enters the container's config);
//   • serve + connect: newline-delimited JSON round-trips byte-for-byte; the server
//     process sees the config's env (DISPATCH_DB, GAFFER_CLAIM_TOKEN) — the client does not;
//   • an unknown server name is refused (connect exits 1, nothing spawned);
//   • closing the client ends the server process (no orphans);
//   • SIGTERM to serve removes the socket.
// Run: node test/mcp-bridge.test.mjs
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const BRIDGE = join(RUNNER_DIR, "lib", "mcp-bridge.mjs");
let pass = 0;
const failures = [];
const ok = (m) => {
  pass++;
  console.log(`  ok   ${m}`);
};
const fail = (m) => {
  failures.push(m);
  console.log(`  FAIL ${m}`);
};
const assert = (c, m) => (c ? ok(m) : fail(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WORK = mkdtempSync(join(tmpdir(), "mcp-bridge-"));
// A stub "MCP server": echoes each stdin line back as JSON plus what it sees in its env.
const STUB = join(WORK, "stub-server.mjs");
writeFileSync(
  STUB,
  `import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
rl.on("line", (l) => process.stdout.write(JSON.stringify({ echo: l, db: process.env.DISPATCH_DB || null, tok: process.env.GAFFER_CLAIM_TOKEN || null, pid: process.pid }) + "\\n"));
rl.on("close", () => process.exit(0));
`,
);
const CONFIG = join(WORK, "mcp-runtime.json");
writeFileSync(
  CONFIG,
  JSON.stringify(
    {
      _comment: "test",
      mcpServers: {
        dispatch: {
          command: process.execPath,
          args: [STUB],
          env: {
            DISPATCH_DB: join(WORK, "dispatch.sqlite"),
            GAFFER_CLAIM_TOKEN: "TOPSECRET_CLAIM",
            GAFFER_FACTORY: "1",
          },
        },
      },
    },
    null,
    2,
  ),
);
const SOCK = join(WORK, "bridge.sock");

console.log("== render: bridged config carries names only — no env, no host command ==");
const OUT = join(WORK, "mcp-runtime.bridge.json");
const r = spawnSync(
  process.execPath,
  [BRIDGE, "render", "--config", CONFIG, "--out", OUT, "--socket", SOCK],
  { encoding: "utf8" },
);
assert(r.status === 0, `render exits 0 (${r.stderr.trim()})`);
const bridged = JSON.parse(readFileSync(OUT, "utf8"));
const d = bridged.mcpServers.dispatch;
assert(
  d && d.command === "node" && d.args[0] === BRIDGE && d.args[1] === "connect",
  "dispatch → `node mcp-bridge.mjs connect …`",
);
assert(
  d.args.includes("--socket") &&
    d.args.includes(SOCK) &&
    d.args.includes("--server") &&
    d.args.includes("dispatch"),
  "connect argv names the socket + server",
);
assert(!("env" in d), "bridged server has NO env block");
assert(
  !readFileSync(OUT, "utf8").includes("TOPSECRET_CLAIM"),
  "the claim token is not in the bridged config",
);

console.log("== serve + connect: round trip, env stays host-side ==");
const serveLog = [];
const server = spawn(process.execPath, [BRIDGE, "serve", "--socket", SOCK, "--config", CONFIG], {
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (b) => serveLog.push(String(b)));
server.stderr.on("data", (b) => serveLog.push(String(b)));
// The socket file exists as soon as listen() binds; the "listening" line is written in
// listen()'s callback and still has to cross the stdout pipe. Wait for BOTH (bounded),
// or a slow runner sees the socket before the announcement arrives.
for (let i = 0; i < 100 && !(existsSync(SOCK) && serveLog.join("").includes("listening")); i++)
  await sleep(50);
assert(existsSync(SOCK), "socket appears");
assert(serveLog.join("").includes("listening"), "serve announces listening");

function runClient(serverName, lines, env = {}) {
  return new Promise((resolveP) => {
    const c = spawn(
      process.execPath,
      [BRIDGE, "connect", "--socket", SOCK, "--server", serverName],
      {
        env: { PATH: process.env.PATH, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let out = "";
    let err = "";
    c.stdout.on("data", (b) => (out += b));
    c.stderr.on("data", (b) => (err += b));
    c.on("close", (code) => resolveP({ code, out, err }));
    for (const l of lines) c.stdin.write(l + "\n");
    // give the server a moment to answer, then close stdin (⇒ end of session)
    setTimeout(() => c.stdin.end(), 400);
  });
}
const a = await runClient("dispatch", ['{"jsonrpc":"2.0","id":1,"method":"ping"}', '{"id":2}']);
assert(a.code === 0, `client exits 0 (stderr: ${a.err.trim()})`);
const replies = a.out
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
assert(
  replies.length === 2 &&
    replies[0].echo === '{"jsonrpc":"2.0","id":1,"method":"ping"}' &&
    replies[1].echo === '{"id":2}',
  "both lines round-tripped in order, byte-exact",
);
assert(
  replies[0].db === join(WORK, "dispatch.sqlite"),
  "the HOST server sees DISPATCH_DB from the config env",
);
assert(
  replies[0].tok === "TOPSECRET_CLAIM",
  "the HOST server sees the claim token from the config env",
);
const serverPid = replies[0].pid;
await sleep(300);
let alive = true;
try {
  process.kill(serverPid, 0);
} catch {
  alive = false;
}
assert(!alive, "closing the client ended the spawned server process (no orphan)");

console.log("== unknown server is refused ==");
const u = await runClient("nosuch", ["{}"]);
assert(
  u.code === 1 && u.out === "",
  `connect to an unknown server exits 1 with no output (code=${u.code})`,
);
assert(serveLog.join("").includes("unknown server 'nosuch'"), "serve logs the refusal");

console.log("== two concurrent clients get two independent servers ==");
const [c1, c2] = await Promise.all([
  runClient("dispatch", ['{"n":1}']),
  runClient("dispatch", ['{"n":2}']),
]);
const p1 = JSON.parse(c1.out.trim()).pid;
const p2 = JSON.parse(c2.out.trim()).pid;
assert(
  c1.code === 0 && c2.code === 0 && p1 !== p2,
  "each connection spawned its own server process",
);

console.log("== SIGTERM: serve exits and removes the socket ==");
server.kill("SIGTERM");
await new Promise((r2) => server.on("close", r2));
assert(!existsSync(SOCK), "socket removed on shutdown");

console.log(
  "== render: `{}` is an EMPTY data plane (claude accepts it); a non-object is refused ==",
);
writeFileSync(join(WORK, "empty.json"), "{}");
const emp = spawnSync(
  process.execPath,
  [BRIDGE, "render", "--config", join(WORK, "empty.json"), "--out", OUT, "--socket", SOCK],
  { encoding: "utf8" },
);
assert(
  emp.status === 0 && Object.keys(JSON.parse(readFileSync(OUT, "utf8")).mcpServers).length === 0,
  "`{}` renders to zero bridged servers (nothing to bridge)",
);
writeFileSync(join(WORK, "bad.json"), "[1,2]");
const bad = spawnSync(
  process.execPath,
  [BRIDGE, "render", "--config", join(WORK, "bad.json"), "--out", OUT, "--socket", SOCK],
  { encoding: "utf8" },
);
assert(
  bad.status === 2 && /not a JSON object/.test(bad.stderr),
  "a non-object config is refused (exit 2)",
);

rmSync(WORK, { recursive: true, force: true });
console.log();
if (failures.length === 0) {
  console.log(`mcp-bridge: ALL ${pass} checks passed`);
  process.exit(0);
}
console.log(`mcp-bridge: ${failures.length} FAILED (of ${pass + failures.length})`);
process.exit(1);
