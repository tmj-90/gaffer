#!/usr/bin/env node
// A stub COMMAND worker for the runner tests (GAFFER_WORKER_PROVIDER=command, see
// docs/worker-providers.md). It never calls a model. It reads the contract the way a
// real worker program would (the GAFFER_WORKER_* variables, the cwd), makes a real
// committed change when it runs in a git worktree, talks to the dispatch MCP server
// named in GAFFER_WORKER_MCP_CONFIG exactly as an agent's MCP client would, and prints
// the JSON envelope on stdout (after a line of log noise, which the runner tolerates).
//
// Test knobs (GAFFER_-prefixed so the agent-env scrub lets them through):
//   GAFFER_TEST_COMMAND_WORKER_STDOUT  print this verbatim instead of the envelope
//   GAFFER_TEST_COMMAND_WORKER_EXIT    exit with this code (default 0)
// Every call appends one line to $GAFFER_DATA/command-worker.jsonl: what it received
// (contract values, the env NAMES it saw, never their values) and what the MCP said.
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const env = process.env;
const cwd = process.cwd();
const prompt = env.GAFFER_WORKER_PROMPT ?? "";
const ticket = env.GAFFER_TICKET || "";
const record = {
  ts: new Date().toISOString(),
  cwd,
  contract: env.GAFFER_WORKER_CONTRACT ?? null,
  kind: env.GAFFER_WORKER_KIND ?? null,
  model: env.GAFFER_WORKER_MODEL ?? null,
  maxTurns: env.GAFFER_WORKER_MAX_TURNS ?? null,
  maxBudgetUsd: env.GAFFER_WORKER_MAX_BUDGET_USD ?? null,
  tools: env.GAFFER_WORKER_TOOLS ?? null,
  timeoutSecs: env.GAFFER_WORKER_TIMEOUT_SECS ?? null,
  mcpConfig: env.GAFFER_WORKER_MCP_CONFIG ?? null,
  prompt: prompt.slice(0, 200),
  promptHasTicket: ticket ? prompt.includes(`#${ticket}`) : null,
  envNames: Object.keys(env).sort(),
  mcp: [],
};

const git = (...a) =>
  execFileSync("git", ["-c", "user.email=cmd@gaffer", "-c", "user.name=cmd", ...a], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();

// A minimal MCP client over stdio, the same handshake stub-worker.mjs speaks.
async function mcpCall(server, tool, args) {
  const cfgPath = env.GAFFER_WORKER_MCP_CONFIG;
  if (!cfgPath) throw new Error("no GAFFER_WORKER_MCP_CONFIG");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const entry = (cfg.mcpServers || {})[server];
  if (!entry) throw new Error(`no ${server} server in ${cfgPath}`);
  const child = spawn(entry.command, entry.args || [], {
    env: { ...env, ...(entry.env || {}) },
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
      const t = setTimeout(() => reject(new Error(`mcp ${method} timed out`)), 20000);
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
      clientInfo: { name: "gaffer-command-worker-stub", version: "1" },
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

async function main() {
  const isWorktree = existsSync(path.join(cwd, ".git"));
  if (isWorktree && ticket) {
    writeFileSync(
      path.join(cwd, "DELIVERED.txt"),
      `delivered by the command worker for #${ticket}\n`,
    );
    git("add", "-A");
    git("commit", "-qm", `deliver: add DELIVERED.txt (command worker, #${ticket})`);
    record.committed = true;
  }
  if (ticket && env.GAFFER_WORKER_MCP_CONFIG) {
    try {
      const show = await mcpCall("dispatch", "get_ticket", { ticket_id: ticket });
      const tk = show.ticket || show;
      record.mcp.push({ tool: "get_ticket", ok: true, status: tk.status ?? null });
      const acs = show.acceptance_criteria || show.acceptanceCriteria || [];
      for (const ac of acs) {
        await mcpCall("dispatch", "record_ac_evidence", {
          ticket_id: tk.id || ticket,
          ac_id: ac.id,
          evidence_type: "manual_note",
          summary: "command worker: DELIVERED.txt is at the repo root",
        });
        record.mcp.push({ tool: "record_ac_evidence", ok: true, ac: ac.id });
      }
    } catch (e) {
      record.mcp.push({ ok: false, error: String(e.message || e).slice(0, 300) });
    }
  }
}

let rc = Number(env.GAFFER_TEST_COMMAND_WORKER_EXIT || 0);
try {
  await main();
} catch (e) {
  record.error = String(e.message || e).slice(0, 300);
  rc = 1;
}
try {
  if (env.GAFFER_DATA)
    appendFileSync(
      path.join(env.GAFFER_DATA, "command-worker.jsonl"),
      JSON.stringify(record) + "\n",
    );
} catch {
  /* recording is best-effort */
}
process.stderr.write("command-worker: done\n");
if (env.GAFFER_TEST_COMMAND_WORKER_STDOUT !== undefined) {
  process.stdout.write(env.GAFFER_TEST_COMMAND_WORKER_STDOUT + "\n");
} else {
  process.stdout.write("command-worker: log noise before the envelope\n");
  process.stdout.write(
    JSON.stringify({
      result: `Added DELIVERED.txt.\n\nSmallest-change note: one new file, DELIVERED.txt; nothing else touched.`,
      stop_reason: "end_turn",
      cap_hit: false,
      num_turns: 2,
      duration_ms: 1500,
      cost_usd: 0.0123,
      model: "stub-command-model",
      usage: { input_tokens: 10, output_tokens: 5 },
    }) + "\n",
  );
}
process.exit(rc);
