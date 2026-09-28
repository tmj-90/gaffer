#!/usr/bin/env node
// Gaffer — the MCP data-plane BRIDGE for the `docker` sandbox provider.
//
// Problem (external review, finding 2): the agent's MCP servers (dispatch, memory) ran
// INSIDE the sandbox container and wrote the canonical SQLite files directly, so the
// worker's shell and the services enforcing ticket/approval rules shared a filesystem
// — $GAFFER_DATA had to be mounted read-write and a process that skipped the MCP tools
// could open dispatch.sqlite itself.
//
// Fix: the MCP servers run on the HOST, spawned by this bridge, and the container talks
// to them over ONE unix socket that is the only thing mounted. Nothing under $GAFFER_DATA
// (databases, ledgers, other workers' claim tokens, settings, the dashboard token) is in
// the container's filesystem any more, and the dispatch claim token never enters it: the
// rendered runtime config (with its env block) stays host-side with the bridge; the
// container sees a "bridged" config whose every server is `node mcp-bridge.mjs connect`.
//
//   serve   --socket <path> --config <mcp-runtime.json>          (HOST, one per agent run)
//           Listens on the unix socket. Each connection sends a one-line JSON header
//           {"server":"<name>"}; the bridge spawns that server from the config (command,
//           args, env — host-side) and pipes bytes both ways. Connection closed ⇒ server
//           killed. Unknown server ⇒ connection refused (closed). Prints
//           `mcp-bridge: listening <socket>` on stdout once ready.
//   connect --socket <path> --server <name>                       (CONTAINER, per server)
//           What claude spawns as the "MCP server": connects, sends the header, then
//           stdin → socket and socket → stdout. MCP's stdio framing (newline-delimited
//           JSON-RPC) is byte-transparent through the bridge.
//   render  --config <in.json> --out <out.json> --socket <path> [--bridge <this file>]
//           Writes the bridged config for the container: same server names, each
//           replaced by the `connect` command, NO env (the env stays with `serve`).
//
// Node built-ins only (the image ships node; nothing to install). No shell, no eval.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);

function usage(msg) {
  if (msg) process.stderr.write(`mcp-bridge: ${msg}\n`);
  process.stderr.write(
    "usage: mcp-bridge.mjs serve --socket <path> --config <mcp-runtime.json>\n" +
      "       mcp-bridge.mjs connect --socket <path> --server <name>\n" +
      "       mcp-bridge.mjs render --config <in.json> --out <out.json> --socket <path> [--bridge <path>] [--node <bin>]\n",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) usage(`unexpected argument '${a}'`);
    const key = a.slice(2);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) usage(`--${key} needs a value`);
    out[key] = v;
    i++;
  }
  return out;
}

function readConfig(path) {
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    usage(`cannot read config ${path}: ${e && e.message ? e.message : e}`);
  }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg))
    usage(`config ${path} is not a JSON object`);
  // No `mcpServers` (claude accepts `{}`) ⇒ an EMPTY data plane: nothing to bridge.
  if (cfg.mcpServers === undefined || cfg.mcpServers === null) cfg.mcpServers = {};
  if (typeof cfg.mcpServers !== "object" || Array.isArray(cfg.mcpServers))
    usage(`config ${path}: mcpServers is not an object`);
  return cfg;
}

// ── render ─────────────────────────────────────────────────────────────────────
function render(opts) {
  const { config, out, socket } = opts;
  if (!config || !out || !socket) usage("render needs --config, --out and --socket");
  const cfg = readConfig(config);
  const bridge = opts.bridge || SELF;
  const nodeBin = opts.node || "node";
  const servers = {};
  for (const name of Object.keys(cfg.mcpServers)) {
    // Only the name survives: command/args/env are the HOST's business (serve).
    servers[name] = {
      command: nodeBin,
      args: [bridge, "connect", "--socket", socket, "--server", name],
    };
  }
  const rendered = { ...cfg, mcpServers: servers };
  if (typeof rendered._comment === "string") {
    rendered._comment =
      "BRIDGED for the docker sandbox: every server is `mcp-bridge.mjs connect` over the mounted unix socket; the real servers (and their env, incl. the claim token) run on the host. " +
      rendered._comment;
  }
  writeFileSync(out, JSON.stringify(rendered, null, 2) + "\n", { mode: 0o600 });
}

// ── serve ──────────────────────────────────────────────────────────────────────
function serve(opts) {
  const { socket, config } = opts;
  if (!socket || !config) usage("serve needs --socket and --config");
  const cfg = readConfig(config);
  try {
    if (existsSync(socket)) unlinkSync(socket); // a stale socket from a killed run
  } catch {
    /* best effort */
  }
  const children = new Set();
  // allowHalfOpen: a client that has finished sending (FIN) must still receive the
  // server's replies — a `printf … | connect` probe and an MCP client's final
  // request/response both depend on it. The server side ends the socket itself once
  // the spawned server exits.
  const server = net.createServer({ allowHalfOpen: true }, (sock) => {
    let header = "";
    let child = null;
    const onData = (chunk) => {
      if (child) return; // after the header, data is piped (below)
      header += chunk.toString("utf8");
      const nl = header.indexOf("\n");
      if (nl < 0) {
        if (header.length > 4096) sock.destroy(); // not a header — refuse
        return;
      }
      const rest = header.slice(nl + 1);
      header = header.slice(0, nl);
      let want;
      try {
        want = JSON.parse(header);
      } catch {
        sock.destroy();
        return;
      }
      const name = want && typeof want.server === "string" ? want.server : "";
      const spec = cfg.mcpServers[name];
      if (!spec || typeof spec.command !== "string") {
        process.stderr.write(`mcp-bridge: refused connection for unknown server '${name}'\n`);
        sock.destroy();
        return;
      }
      const args = Array.isArray(spec.args) ? spec.args.map(String) : [];
      const env = { ...process.env, ...(spec.env && typeof spec.env === "object" ? spec.env : {}) };
      child = spawn(spec.command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
      children.add(child);
      child.on("error", (e) => {
        process.stderr.write(`mcp-bridge: could not spawn '${name}': ${e.message}\n`);
        sock.destroy();
      });
      child.stderr.on("data", (d) => process.stderr.write(`[mcp:${name}] ${d}`));
      sock.removeListener("data", onData);
      if (rest) child.stdin.write(rest);
      sock.pipe(child.stdin);
      child.stdout.pipe(sock);
      const done = () => {
        children.delete(child);
        try {
          sock.end();
        } catch {
          /* closed */
        }
      };
      child.on("exit", done);
      // The client finished sending: the pipe has ended the server's stdin. A well-behaved
      // MCP server exits on stdin EOF; one that does not is reaped after a grace period so
      // no host-side server outlives its client.
      sock.on("end", () => {
        setTimeout(() => {
          if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
        }, 2000).unref();
      });
      sock.on("close", () => {
        if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
      });
      sock.on("error", () => {
        if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
      });
    };
    sock.on("data", onData);
    sock.on("error", () => {
      /* peer went away before a header */
    });
  });
  const shutdown = () => {
    for (const c of children) {
      try {
        c.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
    server.close(() => {
      try {
        unlinkSync(socket);
      } catch {
        /* gone */
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGHUP", shutdown);
  server.on("error", (e) => {
    process.stderr.write(`mcp-bridge: listen failed on ${socket}: ${e.message}\n`);
    process.exit(1);
  });
  server.listen(socket, () => {
    try {
      chmodSync(socket, 0o600); // the host user + the container's root only
    } catch {
      /* best effort */
    }
    process.stdout.write(`mcp-bridge: listening ${socket}\n`);
  });
}

// ── connect ────────────────────────────────────────────────────────────────────
function connect(opts) {
  const { socket, server } = opts;
  if (!socket || !server) usage("connect needs --socket and --server");
  const sock = net.connect({ path: socket, allowHalfOpen: true });
  let got = false; // any byte from the server ⇒ the bridge accepted us
  sock.on("connect", () => {
    sock.write(JSON.stringify({ server }) + "\n");
    process.stdin.pipe(sock);
    sock.on("data", () => {
      got = true;
    });
    sock.pipe(process.stdout);
  });
  sock.on("error", (e) => {
    process.stderr.write(`mcp-bridge: connect to ${socket} failed: ${e.message}\n`);
    process.exit(1);
  });
  // Closed without ever answering ⇒ refused (unknown server / spawn failure): exit 1.
  sock.on("close", () => process.exit(got ? 0 : 1));
  process.stdin.on("end", () => {
    try {
      sock.end();
    } catch {
      /* closed */
    }
  });
}

const [mode, ...rest] = process.argv.slice(2);
const opts = parseArgs(rest);
switch (mode) {
  case "serve":
    serve(opts);
    break;
  case "connect":
    connect(opts);
    break;
  case "render":
    render(opts);
    break;
  default:
    usage(mode ? `unknown mode '${mode}'` : "missing mode");
}
