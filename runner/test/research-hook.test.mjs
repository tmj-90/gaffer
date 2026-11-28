#!/usr/bin/env node
// =====================================================================
// The safety hook's research role (backlog 69, protections A, B, C and D in the hook).
//   - WebSearch and WebFetch pass under the URL rules; every other tool name is refused
//     (Read, Grep, Glob, Bash, Write, Edit, Task, Agent, Skill, mcp__*, unknown names);
//   - an input key the two tools do not document (a method, a header, a body) is refused;
//   - where names resolve, a host that does not resolve or resolves to a non-public
//     address is refused; GAFFER_RESEARCH_RESOLVE=proxy (the docker research profile)
//     leaves that to the egress proxy;
//   - the budget: the 41st fetch, the 21st search and the 26th distinct host are refused,
//     with a message telling the agent to write its result now;
//   - every allowed call is appended to the run's log; PostToolUse records completion;
//   - no state directory, an unparseable payload or an unknown event: refused;
//   - the role cannot be forged: runner/safety-hook.mjs (every other agent's hook) still
//     refuses WebFetch and WebSearch under every environment a research run uses, and the
//     two settings rules refuse each other's templates;
//   - the process wrapper runner/research-hook.mjs keeps the exit-code contract.
// Run: node runner/test/research-hook.test.mjs
// =====================================================================
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BUDGET, decideResearch, readResearchLog } from "../lib/hook/research.mjs";
import { decide } from "../safety-hook-core.mjs";
import {
  renderAgentSettings,
  validateAgentSettings,
  validateResearchSettings,
} from "../lib/agent-settings.mjs";
import { gafferMkdtemp } from "./lib/tmpdir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(HERE, "..");

let passed = 0;
const failures = [];
const assert = (label, cond) => {
  if (cond) passed += 1;
  else failures.push(label);
};

const scratch = gafferMkdtemp(join(tmpdir(), "research-hook-"));
let n = 0;
const freshState = () => {
  const d = join(scratch, `state-${(n += 1)}`);
  mkdirSync(d);
  return d;
};
const publicResolver = async () => ["140.82.112.3"];
const fetchCall = (url, extra = {}) =>
  JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "WebFetch",
    tool_input: { url, prompt: "What does this page say about pricing?", ...extra },
  });
const searchCall = (input) =>
  JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "WebSearch", tool_input: input });
const run = (raw, state, opts = {}) =>
  decideResearch(raw, {
    env: { GAFFER_RESEARCH_STATE: state, ...(opts.env ?? {}) },
    resolve: opts.resolve ?? publicResolver,
  });

// --- the two tools under the rules ---------------------------------------------------
{
  const s = freshState();
  const a = await run(fetchCall("https://github.com/vitejs/vite"), s);
  assert(`WebFetch of an ordinary page is allowed (${a.reason})`, a.exitCode === 0);
  const b = await run(searchCall({ query: "open source workout tracker" }), s);
  assert(`WebSearch is allowed (${b.reason})`, b.exitCode === 0);
  const c = await run(fetchCall("http://github.com/vitejs/vite"), s);
  assert("WebFetch of http is refused", c.exitCode === 2 && /scheme/.test(c.reason));
  const d = await run(fetchCall("https://github.com/login"), s);
  assert("WebFetch of a login page is refused", d.exitCode === 2 && /auth-step/.test(d.reason));
  const e = await run(searchCall({ query: "x", allowed_domains: ["localhost"] }), s);
  assert("WebSearch with a bad query is refused", e.exitCode === 2);
  const f = await run(searchCall({ query: "habit tracker", mode: "turbo" }), s);
  assert("WebSearch with an unknown mode is refused", f.exitCode === 2);
  const g = await run(fetchCall("https://github.com/vitejs/vite", { offset: -1 }), s);
  assert("WebFetch with a negative offset is refused", g.exitCode === 2);
  const h = await run(fetchCall("https://github.com/vitejs/vite", { prompt: "x".repeat(2001) }), s);
  assert("WebFetch with an over-long prompt is refused", h.exitCode === 2);
  const log = readResearchLog(s);
  assert(
    `only the allowed calls are logged (${log.fetches.length} fetch, ${log.searches.length} search)`,
    log.fetches.length === 1 && log.searches.length === 1,
  );
  assert(
    "the log records the URL and host",
    log.fetches[0].url === "https://github.com/vitejs/vite" && log.fetches[0].host === "github.com",
  );
  assert("the log records the query", log.searches[0].query === "open source workout tracker");
}

// --- no way to send a form, a header or a body ----------------------------------------
{
  const s = freshState();
  for (const extra of [
    { method: "POST" },
    { headers: { Cookie: "a=b" } },
    { body: "user=x&pass=y" },
    { data: "x" },
    { cookie: "a" },
  ]) {
    const v = await run(fetchCall("https://github.com/vitejs/vite", extra), s);
    assert(
      `WebFetch with ${Object.keys(extra)[0]} is refused`,
      v.exitCode === 2 && /do not know/.test(v.reason),
    );
  }
  const v = await run(searchCall({ query: "habit tracker", user_location: "x" }), s);
  assert("WebSearch with an undocumented key is refused", v.exitCode === 2);
}

// --- every other tool name ------------------------------------------------------------
{
  const s = freshState();
  const names = [
    "Read",
    "Grep",
    "Glob",
    "LS",
    "Bash",
    "BashOutput",
    "KillShell",
    "Write",
    "Edit",
    "MultiEdit",
    "NotebookEdit",
    "NotebookRead",
    "Task",
    "Agent",
    "Skill",
    "ToolSearch",
    "TodoWrite",
    "Monitor",
    "PowerShell",
    "REPL",
    "Workflow",
    "Artifact",
    "SendMessage",
    "PushNotification",
    "RemoteTrigger",
    "CronCreate",
    "AskUserQuestion",
    "ExitPlanMode",
    "EnterWorktree",
    "LSP",
    "ListMcpResourcesTool",
    "ReadMcpResourceTool",
    "mcp__dispatch__get_ticket",
    "mcp__memory__search",
    "mcp__fetch__fetch",
    "mcp__playwright__browser_navigate",
    "webfetch",
    "Webfetch",
    "WebFetch ",
    "WebFetchX",
    "",
    "SomeFutureTool",
  ];
  for (const tool of names) {
    const v = await run(
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: tool,
        tool_input: { url: "https://github.com/" },
      }),
      s,
    );
    assert(`tool ${JSON.stringify(tool)} is refused in the research role`, v.exitCode === 2);
  }
  assert("refused tools write no log", readResearchLog(s).fetches.length === 0);
}

// --- name resolution --------------------------------------------------------------------
{
  const s = freshState();
  const priv = await run(fetchCall("https://router.github-dummy.org/"), s, {
    resolve: async () => ["192.168.1.1"],
  });
  assert(
    "a public name resolving to a private address is refused",
    priv.exitCode === 2 && /non-public/.test(priv.reason),
  );
  const mixed = await run(fetchCall("https://router.github-dummy.org/"), s, {
    resolve: async () => ["140.82.112.3", "127.0.0.1"],
  });
  assert("one non-public answer among several is refused", mixed.exitCode === 2);
  const meta = await run(fetchCall("https://metadata.github-dummy.org/"), s, {
    resolve: async () => ["169.254.169.254"],
  });
  assert("a name resolving to the metadata address is refused", meta.exitCode === 2);
  const mapped = await run(fetchCall("https://mapped.github-dummy.org/"), s, {
    resolve: async () => ["::ffff:10.0.0.1"],
  });
  assert("a name resolving to an IPv4-mapped private address is refused", mapped.exitCode === 2);
  const none = await run(fetchCall("https://nowhere.github-dummy.org/"), s, {
    resolve: async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    },
  });
  assert(
    "a name that does not resolve is refused",
    none.exitCode === 2 && /does not resolve/.test(none.reason),
  );
  const empty = await run(fetchCall("https://nowhere.github-dummy.org/"), s, {
    resolve: async () => [],
  });
  assert("an empty answer is refused", empty.exitCode === 2);
  const proxy = await run(fetchCall("https://nowhere.github-dummy.org/"), s, {
    env: { GAFFER_RESEARCH_RESOLVE: "proxy" },
    resolve: async () => {
      throw new Error("must not be called");
    },
  });
  assert(
    "under the proxy profile the hook leaves resolution to the egress proxy",
    proxy.exitCode === 0,
  );
  const proxyRules = await run(fetchCall("https://127.0.0.1/"), s, {
    env: { GAFFER_RESEARCH_RESOLVE: "proxy" },
  });
  assert("the proxy profile still applies the URL rules", proxyRules.exitCode === 2);
}

// --- the budget ------------------------------------------------------------------------------
{
  const s = freshState();
  let okCount = 0;
  for (let i = 0; i < BUDGET.fetches; i += 1) {
    const v = await run(fetchCall(`https://github.com/org/repo-${i}`), s);
    if (v.exitCode === 0) okCount += 1;
  }
  assert(`${BUDGET.fetches} fetches are allowed (${okCount})`, okCount === BUDGET.fetches);
  const over = await run(fetchCall("https://github.com/org/one-more"), s);
  assert(
    "the 41st fetch is refused and says to write the result now",
    over.exitCode === 2 && /write your result now/.test(over.reason),
  );
  assert(
    "the log holds exactly the allowed fetches",
    readResearchLog(s).fetches.length === BUDGET.fetches,
  );
}
{
  const s = freshState();
  for (let i = 0; i < BUDGET.searches; i += 1)
    await run(searchCall({ query: `habit tracker ${i}` }), s);
  const over = await run(searchCall({ query: "habit tracker more" }), s);
  assert(
    "the 21st search is refused and says to write the result now",
    over.exitCode === 2 && /write your result now/.test(over.reason),
  );
}
{
  const s = freshState();
  for (let i = 0; i < BUDGET.hosts; i += 1)
    await run(fetchCall(`https://site${i}.github-dummy.org/page`), s);
  const newHost = await run(fetchCall("https://site-new.github-dummy.org/page"), s);
  assert(
    "the 26th distinct host is refused",
    newHost.exitCode === 2 && /different sites/.test(newHost.reason),
  );
  const oldHost = await run(fetchCall("https://site3.github-dummy.org/other"), s);
  assert("a host already visited is still allowed under the fetch cap", oldHost.exitCode === 0);
}
{
  // Parallel hook processes share the lock: 50 concurrent fetches allow exactly 40.
  const s = freshState();
  const results = await Promise.all(
    Array.from({ length: 50 }, (_, i) => run(fetchCall(`https://github.com/org/p-${i}`), s)),
  );
  const allowed = results.filter((r) => r.exitCode === 0).length;
  assert(`concurrent calls cannot pass the cap (${allowed} allowed)`, allowed === BUDGET.fetches);
}

// --- PostToolUse records completion --------------------------------------------------------
{
  const s = freshState();
  const post = await run(
    JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "WebFetch",
      tool_input: { url: "https://github.com/vitejs/vite", prompt: "p" },
      tool_response: { url: "https://github.com/vitejs/vite/tree/main", code: 200, result: "..." },
    }),
    s,
  );
  assert("PostToolUse never blocks", post.exitCode === 0);
  const log = readResearchLog(s);
  assert(
    "PostToolUse records the completed fetch and a final URL that passes",
    log.fetched.length === 1 &&
      log.fetched[0].final_url === "https://github.com/vitejs/vite/tree/main",
  );
  await run(
    JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "WebFetch",
      tool_input: { url: "https://github.com/a/b", prompt: "p" },
      tool_response: { url: "http://127.0.0.1/admin" },
    }),
    s,
  );
  const log2 = readResearchLog(s);
  assert(
    "a final URL that fails the rules is not recorded",
    log2.fetched.length === 2 && log2.fetched[1].final_url === undefined,
  );
}

// --- fail closed ----------------------------------------------------------------------------
{
  const noState = await decideResearch(fetchCall("https://github.com/vitejs/vite"), {
    env: {},
    resolve: publicResolver,
  });
  assert("no state directory: refused", noState.exitCode === 2);
  const rel = await decideResearch(fetchCall("https://github.com/vitejs/vite"), {
    env: { GAFFER_RESEARCH_STATE: "rel/dir" },
    resolve: publicResolver,
  });
  assert("a relative state directory: refused", rel.exitCode === 2);
  const missing = await decideResearch(fetchCall("https://github.com/vitejs/vite"), {
    env: { GAFFER_RESEARCH_STATE: join(scratch, "nope") },
    resolve: publicResolver,
  });
  assert("a state directory that does not exist: refused", missing.exitCode === 2);
  const fileState = join(scratch, "a-file");
  writeFileSync(fileState, "x");
  const notDir = await decideResearch(fetchCall("https://github.com/vitejs/vite"), {
    env: { GAFFER_RESEARCH_STATE: fileState },
    resolve: publicResolver,
  });
  assert("a state path that is a file: refused", notDir.exitCode === 2);
  const s = freshState();
  assert("an unparseable payload: refused", (await run("{not json", s)).exitCode === 2);
  assert("an empty payload: refused", (await run("", s)).exitCode === 2);
  assert("a non-object payload: refused", (await run("[1]", s)).exitCode === 2);
  assert(
    "an unknown event: refused",
    (await run(JSON.stringify({ hook_event_name: "SessionStart", tool_name: "WebFetch" }), s))
      .exitCode === 2,
  );
  const crash = await run(fetchCall("https://github.com/vitejs/vite"), s, {
    resolve: () => {
      throw new Error("boom");
    },
  });
  assert("a resolver that throws synchronously: refused, not a crash", crash.exitCode === 2);
}

// --- the role is not forgeable ----------------------------------------------------------------
{
  const s = freshState();
  const envs = [
    {},
    { GAFFER_RESEARCH_STATE: s },
    { GAFFER_RESEARCH_STATE: s, GAFFER_RESEARCH_RESOLVE: "proxy" },
    { GAFFER_HOOK_ROLE: "research", GAFFER_ROLE: "research", GAFFER_AGENT_ROLE: "research" },
    { GAFFER_WRITE_ROOTS: scratch, GAFFER_RESEARCH_STATE: s },
    { GAFFER_BOOTSTRAP_INSTALL: "1", GAFFER_WRITE_ROOTS: scratch, GAFFER_RESEARCH_STATE: s },
  ];
  for (const extra of envs) {
    const env = { ...process.env, ...extra };
    for (const [tool, input] of [
      ["WebFetch", { url: "https://github.com/vitejs/vite", prompt: "p" }],
      ["WebSearch", { query: "habit tracker" }],
    ]) {
      const v = decide({ tool_name: tool, tool_input: input }, { env, cwd: scratch });
      assert(
        `safety-hook.mjs still refuses ${tool} with env ${JSON.stringify(Object.keys(extra))}`,
        v.allow === false && v.exitCode === 2,
      );
    }
  }
  // Today's verdicts for the other names the general hook decides by name, pinned so this
  // change cannot move them unnoticed.
  for (const [tool, allowed] of [
    ["Task", true],
    ["Agent", true],
    ["Skill", true],
    ["ToolSearch", true],
    ["TodoWrite", true],
    ["mcp__dispatch__get_ticket", true],
    ["mcp__memory__search", true],
    ["mcp__fetch__fetch", false],
    ["Monitor", false],
    ["REPL", false],
    ["SomeFutureTool", false],
  ]) {
    const v = decide(
      { tool_name: tool, tool_input: {} },
      { env: { ...process.env }, cwd: scratch },
    );
    assert(
      `safety-hook.mjs keeps today's verdict for ${tool} (${allowed ? "allow" : "block"})`,
      v.allow === allowed,
    );
  }
  // The general template still denies both web tools and routes neither to a hook.
  const general = JSON.parse(readFileSync(join(RUNNER, "claude", "settings.json"), "utf8"));
  assert("the general settings deny WebFetch", general.permissions.deny.includes("WebFetch"));
  assert("the general settings deny WebSearch", general.permissions.deny.includes("WebSearch"));
  assert(
    "the general settings allow neither web tool",
    !general.permissions.allow.some((t) => /^Web/.test(t)),
  );
  assert(
    "the general settings run only safety-hook.mjs",
    JSON.stringify(general.hooks).includes("safety-hook.mjs") &&
      !JSON.stringify(general.hooks).includes("research-hook"),
  );
  // Each rule refuses the other's template.
  const researchText = renderAgentSettings(
    readFileSync(join(RUNNER, "claude", "research-settings.json"), "utf8"),
    RUNNER,
  );
  const generalText = renderAgentSettings(
    readFileSync(join(RUNNER, "claude", "settings.json"), "utf8"),
    RUNNER,
  );
  assert(
    "the research template passes the research rule",
    validateResearchSettings(researchText, RUNNER).ok,
  );
  assert(
    "the research template fails the general rule",
    !validateAgentSettings(researchText, RUNNER).ok,
  );
  assert(
    "the general template fails the research rule",
    !validateResearchSettings(generalText, RUNNER).ok,
  );
  assert(
    "the general template still passes the general rule",
    validateAgentSettings(generalText, RUNNER).ok,
  );
  // Broken research templates are refused.
  const r = JSON.parse(researchText);
  const variants = [
    ["hooks switched off", { ...r, disableAllHooks: true }],
    ["MCP servers enabled", { ...r, enableAllProjectMcpServers: true }],
    ["Bash allowed", { ...r, permissions: { ...r.permissions, allow: ["WebFetch", "Bash"] } }],
    [
      "Agent not denied",
      {
        ...r,
        permissions: { ...r.permissions, deny: r.permissions.deny.filter((t) => t !== "Agent") },
      },
    ],
    [
      "matcher narrowed",
      {
        ...r,
        hooks: {
          ...r.hooks,
          PreToolUse: [{ ...r.hooks.PreToolUse[0], matcher: "WebFetch|WebSearch" }],
        },
      },
    ],
    [
      "no onFailure",
      {
        ...r,
        hooks: {
          ...r.hooks,
          PreToolUse: [
            { matcher: "*", hooks: [{ ...r.hooks.PreToolUse[0].hooks[0], onFailure: undefined }] },
          ],
        },
      },
    ],
    [
      "async hook",
      {
        ...r,
        hooks: {
          ...r.hooks,
          PreToolUse: [
            { matcher: "*", hooks: [{ ...r.hooks.PreToolUse[0].hooks[0], async: true }] },
          ],
        },
      },
    ],
    [
      "hook bypassed with ||",
      {
        ...r,
        hooks: {
          ...r.hooks,
          PreToolUse: [
            {
              matcher: "*",
              hooks: [
                {
                  ...r.hooks.PreToolUse[0].hooks[0],
                  command: `true || node "${RUNNER}/research-hook.mjs"`,
                },
              ],
            },
          ],
        },
      },
    ],
    [
      "general hook mixed in",
      {
        ...r,
        hooks: {
          ...r.hooks,
          PreToolUse: [
            ...r.hooks.PreToolUse,
            {
              matcher: "Bash",
              hooks: [
                {
                  type: "command",
                  command: `node "${RUNNER}/safety-hook.mjs"`,
                  timeout: 60,
                  onFailure: "block",
                },
              ],
            },
          ],
        },
      },
    ],
  ];
  for (const [why, obj] of variants) {
    assert(
      `the research rule refuses a template with ${why}`,
      !validateResearchSettings(JSON.stringify(obj), RUNNER).ok,
    );
  }
}

// --- an agent's shell cannot write research (protection I) -----------------------------------
{
  const env = { ...process.env, GAFFER_WRITE_ROOTS: scratch };
  const bash = (command) =>
    decide({ tool_name: "Bash", tool_input: { command } }, { env, cwd: scratch });
  for (const cmd of [
    "wg research create --idea 'a tracker'",
    "dispatch research feature 1a2b ft1 --keep",
    "wg research feature-add 1a2b --title x --priority must",
    "wg research question 1a2b q1 --drop",
    "wg research draft-spec 1a2b",
    "wg research discard 1a2b",
    "w\\g research draft-spec 1a2b",
    "X=wg; $X research draft-spec 1a2b",
    "bash -c 'wg research create --idea x'",
    "$CLI research create --idea x",
    "runner/gaffer research 'an idea'",
    "gaffer research --discard",
    "bash runner/gaffer research 'an idea'",
    "node runner/bin/research-run.mjs --input x.json",
    "node ./bin/research-run.mjs",
  ]) {
    const v = bash(cmd);
    assert(`an agent shell is refused: ${cmd}`, v.allow === false);
  }
  for (const cmd of [
    'grep -rn "research draft-spec" docs/',
    "git commit -m 'research: draft-spec from kept items'",
    "echo research create",
  ]) {
    const v = bash(cmd);
    assert(`a mention stays allowed: ${cmd} (${v.reason})`, v.allow === true);
  }
}

// --- the process wrapper -----------------------------------------------------------------------
{
  const s = freshState();
  const hook = (payload, env) =>
    spawnSync(process.execPath, [join(RUNNER, "research-hook.mjs")], {
      input: payload,
      encoding: "utf8",
      env: { PATH: process.env.PATH, ...env },
    });
  const ok = hook(fetchCall("https://github.com/vitejs/vite"), {
    GAFFER_RESEARCH_STATE: s,
    GAFFER_RESEARCH_RESOLVE: "proxy",
  });
  assert(`the wrapper exits 0 on an allowed fetch (${ok.status} ${ok.stderr})`, ok.status === 0);
  const bad = hook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }), {
    GAFFER_RESEARCH_STATE: s,
  });
  assert(
    "the wrapper exits 2 on a refused tool, with the reason on stderr",
    bad.status === 2 && /BLOCKED by gaffer research hook/.test(bad.stderr),
  );
  const noState = hook(fetchCall("https://github.com/vitejs/vite"), {});
  assert("the wrapper exits 2 with no state directory", noState.status === 2);

  // A copy of the wrapper whose research modules are missing or do not parse fails
  // CLOSED (exit 2) at load, for an allowed-shape call too.
  const lone = join(scratch, "lone");
  mkdirSync(join(lone, "lib", "hook"), { recursive: true });
  writeFileSync(join(lone, "research-hook.mjs"), readFileSync(join(RUNNER, "research-hook.mjs")));
  const mods = ["research.mjs", "url-rules.mjs"];
  for (const m of mods) {
    writeFileSync(join(lone, "lib", "hook", m), readFileSync(join(RUNNER, "lib", "hook", m)));
  }
  const loneHook = (env) =>
    spawnSync(process.execPath, [join(lone, "research-hook.mjs")], {
      input: fetchCall("https://github.com/vitejs/vite"),
      encoding: "utf8",
      env: { PATH: process.env.PATH, ...env },
    });
  const env = { GAFFER_RESEARCH_STATE: s, GAFFER_RESEARCH_RESOLVE: "proxy" };
  assert("the complete copy allows the fetch", loneHook(env).status === 0);
  for (const m of mods) {
    const p = join(lone, "lib", "hook", m);
    const src = readFileSync(p, "utf8");
    rmSync(p);
    const missing = loneHook(env);
    assert(
      `a missing lib/hook/${m} fails closed (${missing.status})`,
      missing.status === 2 && /FAILING CLOSED/.test(missing.stderr),
    );
    writeFileSync(p, `${src}\n}{\n`);
    const broken = loneHook(env);
    assert(`a broken lib/hook/${m} fails closed (${broken.status})`, broken.status === 2);
    writeFileSync(p, src);
  }
}

rmSync(scratch, { recursive: true, force: true });
if (failures.length) {
  for (const f of failures) console.log(`FAIL ${f}`);
  console.log(`research-hook: ${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`research-hook: all ${passed} checks passed`);
