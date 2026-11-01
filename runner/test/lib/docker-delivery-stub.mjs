#!/usr/bin/env node
// Stub `claude` for the docker-provider delivery e2e (runner/test/sandbox-docker-delivery.test.sh
// and its daemon-free twin sandbox-docker-delivery-seam.test.sh). The test installs it as
// the image's own `claude` (/usr/local/bin/claude), so it runs exactly where the real CLI
// would: INSIDE the container, spawned by lib/worker.sh through lib/sandbox-docker.sh.
// Node built-ins only: the image ships node and nothing of the host is installed in it.
//
// A delivery call (cwd is a git worktree, GAFFER_TICKET set) does what an agent does,
// and probes the boundary while it is there:
//   1. PROBES, recorded as data, never acted on: is this a container (/.dockerenv), is
//      the dispatch/memory database under $GAFFER_DATA visible, can the host HOME and a
//      host canary file (both outside every mount) be read, can a file be written next
//      to the canary, did the claim token reach this process's env or its MCP config.
//      The paths come from the probe file the test bakes into the image
//      (/etc/gaffer-e2e/probe.json, or gaffer-e2e-probe.json beside this script).
//   2. MCP ROUND TRIP through the server named "dispatch" in the --mcp-config the runner
//      handed over (the BRIDGED config: `node mcp-bridge.mjs connect` over the mounted
//      socket): get_ticket, then record_ac_evidence on the ticket's first criterion with
//      the probe tokens in the summary. No claim token is passed: the host-side server
//      resolves it from its own env, so the write lands only if the bridge carried it.
//   3. WORKTREE WRITE: appends one helper + one test, commits inside the container (the
//      repo's .git is mounted ro with only the commit paths rw).
//   4. Prints the `--output-format json` result envelope (with a smallest-change note).
// A reviewer prompt gets an APPROVE envelope; anything else a bare "ok" envelope.
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write("0.0.0 (gaffer docker-delivery stub)\n");
  process.exit(0);
}
const argAfter = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const prompt = argAfter("-p") ?? "";
const cwd = process.cwd();
const ticket = String(process.env.GAFFER_TICKET || "");

const envelope = (result, extra = {}) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result,
    total_cost_usd: 0.001,
    num_turns: 1,
    ...extra,
  });

function readProbeConfig() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const f of ["/etc/gaffer-e2e/probe.json", path.join(here, "gaffer-e2e-probe.json")]) {
    try {
      return JSON.parse(readFileSync(f, "utf8"));
    } catch {
      /* next candidate */
    }
  }
  return null;
}

function probes(mcpConfigPath) {
  const cfg = readProbeConfig();
  const out = [];
  out.push(existsSync("/.dockerenv") ? "INSIDE_CONTAINER" : "NOT_IN_CONTAINER");
  // The claim token stays with the host-side MCP server: never in this env, never in
  // the (bridged) config handed to the agent.
  let cfgText = "";
  try {
    cfgText = readFileSync(mcpConfigPath, "utf8");
  } catch {
    /* none */
  }
  const tokenSeen =
    "GAFFER_CLAIM_TOKEN" in process.env || /GAFFER_CLAIM_TOKEN|DISPATCH_DB|"env"/.test(cfgText);
  out.push(tokenSeen ? "TOKEN_LEAK" : "TOKEN_ABSENT");
  if (!cfg) {
    out.push("NO_PROBE_FILE");
    return out;
  }
  out.push("PROBE_FILE");
  const data = cfg.gafferData || process.env.GAFFER_DATA || "";
  const dbs = ["dispatch.sqlite", "memory.sqlite"].map((f) => path.join(data, f));
  out.push(data && dbs.some((p) => existsSync(p)) ? "DB_VISIBLE" : "DB_UNMOUNTED");
  out.push(existsSync(path.join(data, "settings.json")) ? "SETTINGS_VISIBLE" : "SETTINGS_ABSENT");
  let homeSeen = false;
  try {
    readdirSync(cfg.hostHome);
    homeSeen = true;
  } catch {
    /* not there */
  }
  try {
    readFileSync(path.join(cfg.hostHome, ".aws", "credentials"), "utf8");
    homeSeen = true;
  } catch {
    /* not there */
  }
  out.push(homeSeen ? "HOME_READABLE" : "HOME_UNREADABLE");
  let canary = "";
  try {
    canary = readFileSync(cfg.canary, "utf8");
  } catch {
    /* not there */
  }
  out.push(canary.includes(cfg.canaryToken || "\0") ? "CANARY_LEAK" : "CANARY_UNREADABLE");
  let wrote = false;
  try {
    writeFileSync(path.join(path.dirname(cfg.canary), "written-from-container"), "escape\n");
    wrote = true;
  } catch {
    /* refused or absent */
  }
  out.push(wrote ? "HOST_WRITE_POSSIBLE" : "HOST_WRITE_CONTAINED");
  return out;
}

// A minimal MCP client over stdio, speaking to the server the --mcp-config names.
async function mcpCall(server, tool, args) {
  const cfgPath = argAfter("--mcp-config");
  if (!cfgPath) throw new Error("no --mcp-config on the argv");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const entry = (cfg.mcpServers || {})[server];
  if (!entry) throw new Error(`no ${server} server in ${cfgPath}`);
  const child = spawn(entry.command, entry.args || [], {
    env: { ...process.env, ...(entry.env || {}) },
    stdio: ["pipe", "pipe", "ignore"],
  });
  let buf = "";
  const waiters = new Map();
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && waiters.has(msg.id)) waiters.get(msg.id)(msg);
      } catch {
        /* not json */
      }
    }
  });
  let id = 0;
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const my = ++id;
      const t = setTimeout(() => reject(new Error(`mcp ${method} timed out`)), 30000);
      waiters.set(my, (m) => {
        clearTimeout(t);
        if (m.error) reject(new Error(JSON.stringify(m.error)));
        else resolve(m.result);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: my, method, params }) + "\n");
    });
  try {
    await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "gaffer-docker-delivery-stub", version: "1" },
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    );
    const r = await rpc("tools/call", { name: tool, arguments: args });
    if (r && r.isError) throw new Error(JSON.stringify(r.content).slice(0, 400));
    const text = r && Array.isArray(r.content) && r.content[0] && r.content[0].text;
    try {
      return text ? JSON.parse(text) : r;
    } catch {
      return r;
    }
  } finally {
    child.kill();
  }
}

const git = (...a) =>
  execFileSync("git", ["-c", "user.email=stub@gaffer", "-c", "user.name=stub", ...a], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();

async function deliver() {
  const tokens = probes(argAfter("--mcp-config"));
  let mcp;
  try {
    const show = await mcpCall("dispatch", "get_ticket", { ticket_id: ticket });
    const tk = show.ticket || show;
    const acs = show.acceptance_criteria || show.acceptanceCriteria || [];
    const ac = acs[0] && acs[0].id;
    await mcpCall("dispatch", "record_ac_evidence", {
      ticket_id: tk.id || ticket,
      ...(ac ? { ac_id: ac } : {}),
      evidence_type: "manual_note",
      summary: `docker-delivery-stub: the helper is added and tested; in-container probes: ${tokens.join(" ")} MCP_BRIDGED status_seen=${tk.status || "?"}. Smallest-change note: one helper in src/a.js and one test in test/a.test.js, nothing else.`,
    });
    mcp = "MCP_OK";
  } catch (e) {
    mcp = `MCP_FAIL(${String(e && e.message ? e.message : e).slice(0, 200)})`;
  }
  tokens.push(mcp);
  const fn = `helper${ticket || "0"}`;
  appendFileSync(path.join(cwd, "src", "a.js"), `export function ${fn}() { return 2; }\n`);
  appendFileSync(
    path.join(cwd, "test", "a.test.js"),
    `import { ${fn} } from "../src/a.js";\ntest("${fn}", () => { assert.equal(${fn}(), 2); });\n`,
  );
  let committed;
  try {
    git("add", "-A");
    git("commit", "-qm", `feat: ${fn} (docker-delivery stub)\n\nprobes: ${tokens.join(" ")}`);
    committed = "COMMIT_OK";
  } catch (e) {
    committed = `COMMIT_FAIL(${String(e && e.message ? e.message : e).slice(0, 200)})`;
  }
  tokens.push(committed);
  return envelope(
    `Implemented ${fn} with a test. docker-delivery-stub probes: ${tokens.join(" ")}\n\nSmallest-change note: modified src/a.js (added ${fn}) and test/a.test.js (one new test) only.`,
    { total_cost_usd: 0.02, num_turns: 3 },
  );
}

async function main() {
  if (/machine-read verdict|REVIEWER agent|\{"verdict"/.test(prompt))
    return envelope('Reviewed the diff. RECOMMEND APPROVE\n{"verdict":"APPROVE"}');
  if (ticket && existsSync(path.join(cwd, ".git"))) return deliver();
  return envelope("ok");
}

main()
  .then((out) => {
    process.stdout.write(out + "\n");
    process.exit(0);
  })
  .catch((e) => {
    process.stdout.write(envelope(`docker-delivery-stub error: ${e && e.message}`) + "\n");
    process.exit(0);
  });
