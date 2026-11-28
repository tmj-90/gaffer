/**
 * The safety hook's RESEARCH ROLE (backlog 69): the decision for every tool call of the
 * one agent that may use the web. runner/research-hook.mjs is its process wrapper.
 *
 * HOW THE ROLE IS CHOSEN, AND WHY IT CANNOT BE FORGED. The role is the PROGRAM the
 * settings run, never a value in the environment. Only the research launcher
 * (runner/bin/research-run.mjs) renders runner/claude/research-settings.json, whose
 * every PreToolUse entry runs runner/research-hook.mjs. Every other launcher renders
 * runner/claude/settings.json, which runs runner/safety-hook.mjs; that program never
 * reads a role variable and refuses WebFetch and WebSearch by name (fail closed), and
 * that template denies both tools outright. So nothing an agent can put in an
 * environment, a settings `env` block or a nested process turns these rules on for
 * another agent, and a delivery agent pretending to be research gains nothing: its hook
 * is still safety-hook.mjs. The research agent itself cannot switch the role off: it has
 * no shell and no file tool, so it can neither edit the settings nor start a process.
 *
 * What it decides (every path fails closed: an unknown event, an unparseable payload, a
 * missing state directory, a crash, all block):
 *   PreToolUse
 *     - the tool is WebSearch or WebFetch; every other name (Read, Bash, Task, Agent,
 *       Skill, every mcp__ tool, anything unknown) is refused;
 *     - the input holds only the keys those tools document (WebFetch: url, prompt,
 *       offset; WebSearch: query, allowed_domains, blocked_domains, mode): a future
 *       method, header or body field is refused, not passed through;
 *     - WebFetch: the URL passes url-rules.mjs checkResearchUrl; where names can be
 *       resolved (GAFFER_RESEARCH_RESOLVE is not "proxy"), the host must resolve and
 *       every address must be public; the prompt is at most PROMPT_MAX characters;
 *     - WebSearch: the input passes checkResearchSearch;
 *     - the run's budget (BUDGET): past it every call is refused with a message telling
 *       the agent to write its result now;
 *     - an allowed call is appended to the run's log (fetch-log.jsonl) and counted.
 *   PostToolUse (WebFetch)
 *     - records that the fetch completed (and a final URL, if the tool reports one that
 *       passes the rules). Never blocks: the call already ran.
 *
 * STATE lives in GAFFER_RESEARCH_STATE, a directory the launcher makes beside the
 * agent's home and names in the agent CLI's environment (which the hook inherits).
 * The agent has no tool that writes files, so it cannot reset its counters or edit its
 * log. Concurrent hook processes (parallel tool calls) take a mkdir lock.
 *
 * TIME OF CHECK: the name is resolved here, then WebFetch resolves it again when it
 * connects. A name whose answer changes in between (DNS rebinding) passes this check and
 * reaches what the second answer names. Under the docker provider the research egress
 * proxy is where the request really goes out, and it refuses IP literals and internal
 * names itself; neither can stop a public name that resolves to a private address at
 * connect time. SECURITY.md says so.
 */

import { Buffer } from "node:buffer";
import { lookup } from "node:dns/promises";
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

import { checkResearchSearch, checkResearchUrl, isNonPublicAddress } from "./url-rules.mjs";

/** The run's budget. Constants: a knob could only loosen them. */
export const BUDGET = Object.freeze({ fetches: 40, searches: 20, hosts: 25 });
// Why these: a good comparison of an idea needs a handful of searches (competitors,
// alternatives, complaints, pricing, prior art) and a few pages per comparable product;
// 20 searches (each may run up to eight backend searches) and 40 pages over at most 25
// sites is a thorough survey, and bounds what one run can carry to how many sites.

/** The tools the research agent has, and the input keys each documents. */
export const RESEARCH_TOOL_KEYS = Object.freeze({
  WebFetch: Object.freeze(["url", "prompt", "offset"]),
  WebSearch: Object.freeze(["query", "allowed_domains", "blocked_domains", "mode"]),
});
export const PROMPT_MAX = 2000;
const RESEARCH_PAYLOAD_MAX = 2 * 1024 * 1024;
const LOCK_WAIT_MS = 10_000;
const RESOLVE_TIMEOUT_MS = 5_000;
export const LOG_FILE = "fetch-log.jsonl";
export const COUNTS_FILE = "counts.json";

function verdict(allow, reason) {
  return allow
    ? { allow: true, exitCode: 0, stderr: "" }
    : {
        allow: false,
        exitCode: 2,
        reason,
        stderr: `BLOCKED by gaffer research hook: ${reason}\n`,
      };
}

/** The state directory, or a refusal: absolute, an existing real directory. */
function stateDir(env) {
  const d = env.GAFFER_RESEARCH_STATE;
  if (typeof d !== "string" || d === "" || !isAbsolute(d)) {
    return { why: "the research run has no state directory (GAFFER_RESEARCH_STATE): every call is refused" };
  }
  try {
    const st = lstatSync(d);
    if (!st.isDirectory()) return { why: "the research state path is not a directory" };
  } catch {
    return { why: "the research state directory does not exist" };
  }
  return { dir: d };
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Run `fn` holding the run's lock (a mkdir lock; a lock older than 30 s is taken over). */
function withLock(dir, fn) {
  const lock = join(dir, ".lock");
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if (e && e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) {
          rmdirSync(lock);
          continue;
        }
      } catch {
        /* gone already */
      }
      if (Date.now() - start > LOCK_WAIT_MS) throw new Error("could not take the research state lock");
      sleepMs(20);
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      /* best effort */
    }
  }
}

function readCounts(dir) {
  try {
    const c = JSON.parse(readFileSync(join(dir, COUNTS_FILE), "utf8"));
    return {
      fetches: Number.isInteger(c.fetches) ? c.fetches : 0,
      searches: Number.isInteger(c.searches) ? c.searches : 0,
      hosts: Array.isArray(c.hosts) ? c.hosts.filter((h) => typeof h === "string") : [],
    };
  } catch {
    return { fetches: 0, searches: 0, hosts: [] };
  }
}

function writeCounts(dir, counts) {
  const tmp = join(dir, `${COUNTS_FILE}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(counts));
  renameSync(tmp, join(dir, COUNTS_FILE));
}

function appendLog(dir, entry) {
  appendFileSync(join(dir, LOG_FILE), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
}

const WRITE_NOW =
  "Do not search or fetch any more: write your result now, from what you have already found, as the one JSON block the task asks for.";

/** Resolve `host` (all addresses), bounded in time. Returns string[] or throws. */
async function defaultResolve(host) {
  const timer = new Promise((_, rej) =>
    setTimeout(() => rej(new Error("name resolution timed out")), RESOLVE_TIMEOUT_MS).unref(),
  );
  const res = await Promise.race([lookup(host, { all: true, verbatim: true }), timer]);
  return res.map((r) => r.address);
}

function unknownKeys(input, allowed) {
  return Object.keys(input).filter((k) => !allowed.includes(k));
}

async function decidePre(payload, env, dir, resolveHost) {
  const tool = payload.tool_name ?? payload.toolName ?? "";
  const input = payload.tool_input ?? payload.toolInput ?? {};
  if (!Object.prototype.hasOwnProperty.call(RESEARCH_TOOL_KEYS, tool)) {
    return verdict(
      false,
      `the research agent may use only WebSearch and WebFetch; "${String(tool).slice(0, 80)}" is refused`,
    );
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return verdict(false, `${tool} input is not an object`);
  }
  const extra = unknownKeys(input, RESEARCH_TOOL_KEYS[tool]);
  if (extra.length) {
    return verdict(
      false,
      `${tool} input holds ${extra.map((k) => JSON.stringify(k.slice(0, 40))).join(", ")}, which the research rules do not know (only ${RESEARCH_TOOL_KEYS[tool].join(", ")})`,
    );
  }

  if (tool === "WebSearch") {
    const r = checkResearchSearch(input);
    if (!r.ok) return verdict(false, `WebSearch refused: ${r.reason}`);
    if (input.mode !== undefined && input.mode !== "standard" && input.mode !== "extended") {
      return verdict(false, "WebSearch mode must be standard or extended");
    }
    return withLock(dir, () => {
      const c = readCounts(dir);
      if (c.searches >= BUDGET.searches) {
        return verdict(false, `the run has used its ${BUDGET.searches} searches. ${WRITE_NOW}`);
      }
      c.searches += 1;
      writeCounts(dir, c);
      appendLog(dir, {
        kind: "search",
        query: input.query,
        ...(input.allowed_domains ? { allowed_domains: input.allowed_domains } : {}),
        ...(input.blocked_domains ? { blocked_domains: input.blocked_domains } : {}),
      });
      return verdict(true);
    });
  }

  // WebFetch
  const r = checkResearchUrl(input.url);
  if (!r.ok) return verdict(false, `WebFetch refused (${r.code}): ${r.reason}`);
  if (typeof input.prompt !== "string" || input.prompt.length > PROMPT_MAX) {
    return verdict(false, `WebFetch prompt must be text of at most ${PROMPT_MAX} characters`);
  }
  if (input.offset !== undefined && !(Number.isInteger(input.offset) && input.offset >= 0)) {
    return verdict(false, "WebFetch offset must be a whole number");
  }
  if (env.GAFFER_RESEARCH_RESOLVE !== "proxy") {
    let addrs;
    try {
      addrs = await resolveHost(r.host);
    } catch (e) {
      return verdict(false, `${r.host} does not resolve (${e && e.message ? e.message : e}); a name that does not resolve is refused`);
    }
    if (!Array.isArray(addrs) || addrs.length === 0) {
      return verdict(false, `${r.host} does not resolve; a name that does not resolve is refused`);
    }
    const bad = addrs.find((a) => isNonPublicAddress(a));
    if (bad !== undefined) {
      return verdict(false, `${r.host} resolves to a non-public address (${bad}); refused`);
    }
  }
  return withLock(dir, () => {
    const c = readCounts(dir);
    if (c.fetches >= BUDGET.fetches) {
      return verdict(false, `the run has fetched its ${BUDGET.fetches} pages. ${WRITE_NOW}`);
    }
    if (!c.hosts.includes(r.host) && c.hosts.length >= BUDGET.hosts) {
      return verdict(
        false,
        `the run has reached ${BUDGET.hosts} different sites; ${r.host} would be one more. Fetch only from sites already visited, or ${WRITE_NOW.charAt(0).toLowerCase()}${WRITE_NOW.slice(1)}`,
      );
    }
    c.fetches += 1;
    if (!c.hosts.includes(r.host)) c.hosts.push(r.host);
    writeCounts(dir, c);
    appendLog(dir, { kind: "fetch", url: r.url, host: r.host });
    return verdict(true);
  });
}

function decidePost(payload, dir) {
  const tool = payload.tool_name ?? payload.toolName ?? "";
  if (tool !== "WebFetch") return verdict(true);
  const input = payload.tool_input ?? {};
  const url = checkResearchUrl(input.url);
  if (!url.ok) return verdict(true);
  const resp = payload.tool_response;
  const entry = { kind: "fetched", url: url.url };
  // The tool's result shape is not documented; take a final URL or a status code only
  // when the response carries one under an obvious name, and only a URL that passes.
  if (resp && typeof resp === "object" && !Array.isArray(resp)) {
    for (const k of ["url", "finalUrl", "final_url"]) {
      if (typeof resp[k] === "string") {
        const f = checkResearchUrl(resp[k]);
        if (f.ok && f.url !== url.url) entry.final_url = f.url;
        break;
      }
    }
    if (Number.isInteger(resp.code)) entry.status = resp.code;
  }
  try {
    withLock(dir, () => appendLog(dir, entry));
  } catch {
    /* a record that cannot be written changes nothing: the call already ran */
  }
  return verdict(true);
}

/**
 * Decide one hook payload (the raw stdin text) for the research agent.
 * Options: `env` (default process.env), `resolve(host) -> Promise<string[]>` (tests
 * inject one; default: the system resolver, bounded by RESOLVE_TIMEOUT_MS).
 * Returns `{ allow, exitCode, reason?, stderr }`. Never throws.
 */
export async function decideResearch(raw, { env = process.env, resolve = defaultResolve } = {}) {
  try {
    if (typeof raw !== "string" || Buffer.byteLength(raw) > RESEARCH_PAYLOAD_MAX) {
      return verdict(false, "hook payload missing or too large");
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return verdict(false, "unparseable hook payload; failing closed");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return verdict(false, "the hook payload is not an object; failing closed");
    }
    const st = stateDir(env);
    if (!st.dir) return verdict(false, st.why);
    const event = payload.hook_event_name ?? "PreToolUse";
    if (event === "PreToolUse") return await decidePre(payload, env, st.dir, resolve);
    if (event === "PostToolUse") return decidePost(payload, st.dir);
    return verdict(false, `unexpected hook event "${String(event).slice(0, 40)}"; failing closed`);
  } catch (err) {
    return verdict(
      false,
      `research hook crashed while deciding; failing closed: ${err && err.message ? err.message : err}`,
    );
  }
}

/**
 * Read a run's log (the launcher's view of what the hook allowed). Lines that do not
 * parse, or do not have the shape the hook writes, are skipped. Returns
 * `{ fetches: [{url, host, ts}], fetched: [{url, final_url?, ts}], searches: [{query, ts}] }`.
 */
export function readResearchLog(dir) {
  const out = { fetches: [], fetched: [], searches: [] };
  let text = "";
  try {
    text = readFileSync(join(dir, LOG_FILE), "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || typeof e.ts !== "string") continue;
    if (e.kind === "fetch" && typeof e.url === "string" && typeof e.host === "string") {
      out.fetches.push({ url: e.url, host: e.host, ts: e.ts });
    } else if (e.kind === "fetched" && typeof e.url === "string") {
      out.fetched.push({
        url: e.url,
        ts: e.ts,
        ...(typeof e.final_url === "string" ? { final_url: e.final_url } : {}),
      });
    } else if (e.kind === "search" && typeof e.query === "string") {
      out.searches.push({ query: e.query, ts: e.ts });
    }
  }
  return out;
}
