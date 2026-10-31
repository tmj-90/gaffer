/* eslint-disable @typescript-eslint/no-unused-expressions -- `cond ? ok(…) : bad(…)` is the assertion idiom of this harness */
// The stub worker behind stub-claude.sh (see its header for the modes). No model
// call is ever made: every answer is canned, every git change is real.
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const argAfter = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const prompt = argAfter("-p") ?? "";
const DATA = process.env.GAFFER_DATA || "/tmp";
const cwd = process.cwd();

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

// ── classify the call ───────────────────────────────────────────────────────
const isWorktree = existsSync(path.join(cwd, ".git")) && existsSync(path.join(cwd, "package.json"));
// A greenfield bootstrap runs IN the fresh repo dir the runner just created (a git repo
// with a README baseline and no package.json yet); GAFFER_BOOTSTRAP_DIR names it.
const isBootstrapDir =
  existsSync(path.join(cwd, ".git")) &&
  !existsSync(path.join(cwd, "package.json")) &&
  Boolean(process.env.GAFFER_BOOTSTRAP_DIR || process.env.GAFFER_TICKET);
let kind = "other";
if (/black-box tests for #\d+/.test(prompt)) kind = "tester";
else if (/machine-read verdict/.test(prompt) || /\{"verdict"/.test(prompt)) kind = "reviewer";
else if (/You are an INTAKE agent/.test(prompt)) kind = "clarify";
else if (/resolve a merge conflict on the delivery branch/.test(prompt)) kind = "resolver";
else if (isBootstrapDir) kind = "bootstrap";
else if (isWorktree) kind = "delivery";

const num = (re) => {
  const m = re.exec(prompt);
  return m ? m[1] : "";
};
const ticket =
  kind === "delivery" && process.env.GAFFER_TICKET
    ? String(process.env.GAFFER_TICKET)
    : kind === "tester"
      ? num(/black-box tests for #(\d+)/)
      : kind === "reviewer"
        ? num(/ticket #(\d+)/)
        : kind === "clarify"
          ? num(/DRAFT ticket #(\d+)/)
          : kind === "resolver"
            ? num(/\(ticket #(\d+)\)/)
            : kind === "bootstrap"
              ? String(process.env.GAFFER_TICKET || num(/Bootstrap ticket #(\d+)/))
              : String(process.env.GAFFER_TICKET || "");

// ── mode + per-ticket call counter ─────────────────────────────────────────
let modeSpec = { mode: "ok" };
try {
  const all = JSON.parse(readFileSync(path.join(DATA, "stub-mode.json"), "utf8"));
  const v = (ticket && all[ticket]) ?? all["*"];
  if (typeof v === "string") modeSpec = { mode: v };
  else if (v && typeof v === "object") modeSpec = { mode: "ok", ...v };
} catch {
  /* no mode file: ok */
}
const mode = modeSpec.mode;
const stateDir = path.join(DATA, "stub-state");
mkdirSync(stateDir, { recursive: true });
const counterFile = path.join(stateDir, `${kind}-${ticket || "none"}.count`);
let call = 1;
try {
  call = Number(readFileSync(counterFile, "utf8")) + 1;
} catch {
  /* first call */
}
writeFileSync(counterFile, String(call));

// ── record the call ─────────────────────────────────────────────────────────
const env = {};
for (const [k, v] of Object.entries(process.env)) if (/^GAFFER_/.test(k)) env[k] = v;
const shownArgv = argv.map((a, i) => (argv[i - 1] === "-p" ? "<prompt>" : a));
try {
  appendFileSync(
    path.join(DATA, "stub-calls.jsonl"),
    JSON.stringify({
      ts: new Date().toISOString(),
      kind,
      ticket,
      mode,
      call,
      cwd,
      argv: shownArgv,
      env,
      prompt,
    }) + "\n",
  );
  appendFileSync(
    path.join(DATA, "stub-claude.log"),
    `${new Date().toTimeString().slice(0, 8)} cwd=${cwd} kind=${kind} ticket=${ticket} mode=${mode} call=${call}\n`,
  );
} catch {
  /* recording is best-effort */
}

const git = (dir, ...a) =>
  execFileSync("git", ["-c", "user.email=stub@gaffer", "-c", "user.name=stub", ...a], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();
const commitAll = (msg, dir = cwd) => {
  try {
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", msg);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── a minimal MCP client over stdio for the server the runner mounted ──────
// The runner passes --mcp-config <bridged.json>; its "dispatch" entry is a stdio
// command. Speak JSON-RPC to it exactly as an agent's client would.
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
      const t = setTimeout(() => reject(new Error(`mcp ${method} timed out`)), 20000);
      waiters.set(my, (m) => {
        clearTimeout(t);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: my, method, params }) + "\n");
    });
  try {
    await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "gaffer-stub", version: "1" },
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    );
    const r = await rpc("tools/call", { name: tool, arguments: args });
    if (r && r.isError) throw new Error(JSON.stringify(r.content).slice(0, 400));
    // Tools answer one text block holding JSON: hand back the parsed value.
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
const mcpLog = (line) => {
  try {
    appendFileSync(path.join(DATA, "stub-mcp.log"), `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* best-effort */
  }
};

// ── answers ────────────────────────────────────────────────────────────────
async function main() {
  if (kind === "tester") {
    const t = ticket || "0";
    const wm = /Work ONLY in this worktree \(your single write root\): (\S+)/.exec(prompt);
    const dir = wm && existsSync(wm[1]) ? wm[1] : cwd;
    if (mode === "tester_fail")
      return envelope(
        `Wrote black-box checks for #${t}.\nFAIL: the first acceptance criterion does not hold (stub tester observed helper${t} keeps completed tasks).\n{"verdict":"FAIL"}`,
      );
    if (mode === "tester_no_verdict")
      return envelope(`Wrote black-box checks for #${t} but ran out of budget before a verdict.`);
    // tester_pass (and the default)
    mkdirSync(path.join(dir, "test"), { recursive: true });
    writeFileSync(
      path.join(dir, "test", `tester-${t}.test.js`),
      `import test from "node:test"; import assert from "node:assert/strict";\nimport { addTask } from "../src/tasks.js";\ntest("tester ${t}: the task list still grows", () => { assert.equal(addTask([], "x").length, 1); });\n`,
    );
    commitAll(`black-box tests for #${t}`, dir);
    return envelope(
      `Wrote one black-box test per criterion for #${t} and ran the repo's tests.\nPASS: every acceptance criterion holds from the outside.\n{"verdict":"PASS"}`,
    );
  }

  if (kind === "reviewer") {
    const changes = mode === "changes_verdict" && call === 1;
    // As the real reviewer is told to: record the verdict per criterion via the MCP.
    try {
      const show = await mcpCall("dispatch", "get_ticket", { ticket_id: ticket });
      const tk = show.ticket || show;
      const tid = tk.id || ticket;
      const acIds = (show.acceptance_criteria || show.acceptanceCriteria || []).map((a) => a.id);
      for (const ac of acIds.length ? acIds : [undefined])
        await mcpCall("dispatch", "record_ac_evidence", {
          ticket_id: tid,
          ...(ac ? { ac_id: ac } : {}),
          evidence_type: "manual_note",
          summary: changes
            ? "Reviewer agent: FAIL: the new helper needs a docstring before it can be approved."
            : "Reviewer agent: PASS: the criterion is met in the diff and covered by a test.",
        });
      mcpLog(`reviewer #${ticket}: verdict recorded (${acIds.length} AC)`);
    } catch (e) {
      mcpLog(`reviewer #${ticket}: could not record the verdict: ${e.message}`);
    }
    if (changes)
      return envelope(
        'Reviewed the diff. RECOMMEND CHANGES: stub reviewer asks for a docstring on the new helper.\n{"verdict":"CHANGES"}',
        { total_cost_usd: 0.01, num_turns: 2 },
      );
    return envelope('Reviewed the diff. RECOMMEND APPROVE\n{"verdict":"APPROVE"}', {
      total_cost_usd: 0.01,
      num_turns: 2,
    });
  }

  if (kind === "clarify") {
    if (mode === "clarify" && ticket) {
      try {
        const show = await mcpCall("dispatch", "get_ticket", { ticket_id: ticket });
        const tid = (show.ticket || show).id || ticket;
        await mcpCall("dispatch", "add_acceptance_criterion", {
          ticket_id: tid,
          text: `Stub clarify: an empty list stays empty (#${ticket})`,
        });
        await mcpCall("dispatch", "request_decision", {
          title: `Stub clarify question for #${ticket}: keep completed tasks?`,
          question: "Should completed tasks be archived or deleted?",
          severity: "human_required",
          ticket_id: tid,
        });
        mcpLog(`clarify #${ticket}: AC + decision filed`);
      } catch (e) {
        mcpLog(`clarify #${ticket} failed: ${e.message}`);
      }
    }
    return envelope("Clarified the draft.");
  }

  if (kind === "resolver") {
    // Merge the default branch in (a real merge, real conflicts) and resolve each
    // conflict block: main's lines first, then this branch's lines main does not have
    // — except the branch's own rewrite of addTask, which main's version supersedes.
    // Option resolver:"markers" commits the conflicted files AS-IS (markers and all),
    // the bad resolution the re-gate must hold.
    const def = (/Merge the default branch "([^"]+)" INTO/.exec(prompt) || [])[1] || "main";
    let conflicted;
    try {
      git(cwd, "-c", "merge.conflictstyle=merge", "merge", "--no-edit", def);
      return envelope(`Merged ${def} cleanly; nothing to resolve.`);
    } catch {
      conflicted = git(cwd, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
    }
    const markers = modeSpec.resolver === "markers";
    for (const f of conflicted) {
      if (markers) continue;
      const file = path.join(cwd, f);
      const txt = readFileSync(file, "utf8").replace(
        /<<<<<<< [^\n]*\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>> [^\n]*\n/g,
        (_m, ours, theirs) => {
          const th = theirs.split("\n").filter(Boolean);
          const extra = ours
            .split("\n")
            .filter(Boolean)
            .filter((l) => !th.includes(l) && !/^export function addTask\b/.test(l));
          return [...th, ...extra].join("\n") + "\n";
        },
      );
      writeFileSync(file, txt);
    }
    commitAll(
      markers
        ? `Merge ${def} into the branch (stub resolver: markers left in ${conflicted.join(", ")})`
        : `Merge ${def} into the branch; resolve ${conflicted.join(", ")} (stub resolver)`,
    );
    return envelope(
      markers
        ? `Merged ${def}; committed ${conflicted.join(", ")} with the conflict markers still in.`
        : `Resolved the conflicts in ${conflicted.join(", ")}: kept ${def}'s addTask and this branch's helper and test. Tests pass.`,
      { total_cost_usd: 0.01, num_turns: 3 },
    );
  }

  if (kind === "bootstrap") {
    // Scaffold a tiny node project with a passing test, as a bootstrap agent would.
    const t = ticket || "0";
    mkdirSync(path.join(cwd, "src"), { recursive: true });
    mkdirSync(path.join(cwd, "test"), { recursive: true });
    const name = path.basename(cwd);
    writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify(
        {
          name,
          version: "0.1.0",
          private: true,
          type: "module",
          scripts: { test: "node --test", lint: 'node -e "process.exit(0)"' },
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(
      path.join(cwd, "src", "tasks.js"),
      "export function addTask(list, title) { return [...list, { title, done: false }]; }\n",
    );
    writeFileSync(
      path.join(cwd, "test", "tasks.test.js"),
      'import test from "node:test"; import assert from "node:assert/strict";\nimport { addTask } from "../src/tasks.js";\ntest("addTask appends", () => { assert.equal(addTask([], "a").length, 1); });\n',
    );
    commitAll(`feat: scaffold ${name} (stub bootstrap for #${t})`);
    return envelope(
      `Scaffolded ${name}: package.json with a node --test script, src/tasks.js and one passing test.\n\nSmallest-change note: a fresh scaffold of three files (package.json, src/tasks.js, test/tasks.test.js); nothing else.`,
      { total_cost_usd: 0.02, num_turns: 4 },
    );
  }

  if (kind === "delivery") {
    const t = ticket || "0";
    if (mode === "slow_claim") await sleep(1000 * Number(modeSpec.secs || 25));
    if (mode === "clarify" && call === 1) {
      try {
        const show = await mcpCall("dispatch", "get_ticket", { ticket_id: t });
        const tid = (show.ticket || show).id || t;
        await mcpCall("dispatch", "request_decision", {
          title: `Stub agent asks on #${t}: which list order?`,
          question: "Should the helper keep insertion order or sort by title?",
          severity: "human_required",
          ticket_id: tid,
        });
        await mcpCall("dispatch", "mark_ticket_blocked", {
          ticket_id: tid,
          reason: "waiting on a product decision (stub agent)",
        });
        mcpLog(`delivery #${t}: decision requested, ticket blocked`);
      } catch (e) {
        mcpLog(`delivery #${t} request_decision failed: ${e.message}`);
      }
      return envelope(
        `Blocked on a product decision for #${t}; raised it with request_decision and stopped without code.`,
        { total_cost_usd: 0.005, num_turns: 3 },
      );
    }
    if (mode === "clarify" && call > 1) {
      // As a real agent is told to: read the ticket first. Keep what get_ticket gave
      // back so a suite can prove a human's answer reached the agent.
      try {
        const show = await mcpCall("dispatch", "get_ticket", { ticket_id: t });
        writeFileSync(path.join(stateDir, `delivery-${t}.get_ticket.json`), JSON.stringify(show));
      } catch (e) {
        mcpLog(`delivery #${t} get_ticket failed: ${e.message}`);
      }
    }
    const fn = `helper${t}`;
    const tasks = path.join(cwd, "src", "tasks.js");
    const tests = path.join(cwd, "test", "tasks.test.js");
    const src = readFileSync(tasks, "utf8");
    if (mode === "conflict" && !src.includes(`conflict ${t}`)) {
      const lines = src.split("\n");
      lines[0] = `export function addTask(list, title) { /* conflict ${t} */ return [...list, { title, done: false, by: ${t} }]; }`;
      writeFileSync(tasks, lines.join("\n"));
      commitAll(`feat: addTask variant for #${t} (stub conflict delivery)`);
    }
    if (!src.includes(`export function ${fn}`)) {
      appendFileSync(tasks, `export function ${fn}(list) { return list.filter(t => !t.done); }\n`);
      appendFileSync(
        tests,
        `import { ${fn} } from "../src/tasks.js";\ntest("${fn} drops completed", () => { assert.equal(${fn}([{title:"a",done:true}]).length, 0); });\n`,
      );
      if (mode === "fail_first" || mode === "fail_always")
        appendFileSync(
          tests,
          `test("stubFailFirst${t} keeps one task", () => { assert.equal(${fn}([{title:"a",done:true}]).length, 1); });\n`,
        );
      commitAll(`feat: ${fn} helper (stub agent delivery)`);
    } else if (mode === "fail_always") {
      // Never fixes: the failing test stays, so every attempt fails the tests gate.
      appendFileSync(tasks, `// ${fn} still failing (delivery call ${call})\n`);
      commitAll(`chore: ${fn} attempt ${call} (stub agent, still failing)`);
    } else if (mode !== "fail_first") {
      // A redelivery (rework, resume) still changes something, as an agent would.
      appendFileSync(tasks, `// ${fn} revisited (delivery call ${call})\n`);
      commitAll(`chore: ${fn} revisited (stub agent rework)`);
    } else {
      if (modeSpec.secs) await sleep(1000 * Number(modeSpec.secs));
      const cur = readFileSync(tests, "utf8");
      const fixed = cur.replace(
        `test("stubFailFirst${t} keeps one task", () => { assert.equal(${fn}([{title:"a",done:true}]).length, 1); });`,
        `test("stubFailFirst${t} keeps one task", () => { assert.equal(${fn}([{title:"a",done:false}]).length, 1); });`,
      );
      if (fixed !== cur) {
        writeFileSync(tests, fixed);
        commitAll(`fix: stubFailFirst${t} asserts on an open task (stub rework)`);
      }
    }
    if (mode === "pause_first" && call === 1)
      return envelope(`Implemented ${fn}; stopped at the turn cap.`, {
        subtype: "error_max_turns",
        is_error: true,
        total_cost_usd: 0.02,
        num_turns: 999,
      });
    return envelope(
      `Implemented ${fn} with a test.\n\nSmallest-change note: modified src/tasks.js (added ${fn}) and test/tasks.test.js (one new test) only — no other files touched.`,
      { total_cost_usd: 0.02, num_turns: 6 },
    );
  }

  return envelope("ok");
}

main()
  .then((out) => {
    process.stdout.write(out + "\n");
    process.exit(0);
  })
  .catch((e) => {
    process.stdout.write(envelope(`stub error: ${e.message}`) + "\n");
    process.exit(0);
  });
