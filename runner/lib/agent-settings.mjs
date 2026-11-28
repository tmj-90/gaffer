#!/usr/bin/env node
// =====================================================================
// agent-settings.mjs: the ONE rule for the agent's project settings, used by the shell
// writer (lib/agent-env.sh gaffer_write_agent_settings, through the CLI below) and the
// Node writer (lib/agent-home.mjs writeAgentSettings).
// ---------------------------------------------------------------------
// The shell writer used to grep the rendered file for the strings "PreToolUse" and the
// hook path ANYWHERE, and count "onFailure"/"timeout" occurrences across the whole file,
// while the Node writer parsed the JSON. A custom template with the hook under another
// event (and the word PreToolUse in a comment), or a PreToolUse entry whose matcher
// covers no tool, passed the shell check and was refused by Node. Now both call
// validateAgentSettings:
//   * the rendered settings parse as JSON;
//   * hooks.PreToolUse holds entries whose hooks run `<runner>/safety-hook.mjs` as a
//     `"type": "command"` hook: the command is exactly `node <hook>` (or the hook path
//     alone), one plain command with no shell syntax, and the entry holds no key that
//     could change whether it blocks (`"async"`). An entry that names the hook path
//     without running it (a comment, `true || node <hook>`, a background hook) is
//     refused, not counted;
//   * every one of those safety-hook entries says `"onFailure": "block"` and carries a
//     positive numeric timeout (Claude Code otherwise runs the tool when the hook times
//     out or crashes);
//   * the settings do not switch hooks off (`"disableAllHooks"` other than false,
//     `"allowManagedHooksOnly"`);
//   * together their matchers cover EVERY tool the safety hook decides (REQUIRED_TOOLS).
//     A matcher of "*" or "" (or none) covers every tool, as in Claude Code.
// The file is written through lib/safe-write.mjs (never through a link) and read back.
//
// CLI: node agent-settings.mjs write <root> <rel> <template> <runner-dir>
//        render <template> into <root>/<rel>, verify, write. Exit 0 written; 3 refused
//        by the rule (SAFETY: ... on stderr); 4 refused by the path rule
//        (unsafe_worktree_path: ... on stderr); 2 usage; 1 other failure.
//      node agent-settings.mjs validate <file> <runner-dir>
//        check an already-rendered file against the rule (exit 0 / 3).
// =====================================================================
import { readFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EXIT_UNSAFE, UnsafePathError, safeRemoveFile, safeWriteFile } from "./safe-write.mjs";

/** Exit code of the CLI for a settings refusal (the rule, not the path). */
export const EXIT_SAFETY = 3;

/**
 * The file tools the safety hook decides (lib/hook/decide.mjs) that the shipped template
 * routes to it: a tool missing from the PreToolUse matchers never reaches the hook at all.
 * decide.mjs also decides NotebookRead, which the shipped template does not match (current
 * Claude Code reads notebooks with Read); it is not required here so that template stays
 * accepted.
 */
export const REQUIRED_TOOLS = Object.freeze([
  "Bash",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Read",
  "Grep",
  "Glob",
  "LS",
]);

/**
 * Substitute `${RUNNER_DIR}` in the template text (literal, no regex) with the NORMALISED
 * runner directory: the shell hands over an inherited RUNNER_DIR as it is (a trailing
 * slash included), and validateAgentSettings looks for the resolved hook path.
 */
export function renderAgentSettings(templateText, runnerDir) {
  return String(templateText).split("${RUNNER_DIR}").join(resolve(runnerDir));
}

/** Does the PreToolUse matcher `m` cover `tool` (Claude Code's matcher semantics)? */
function matcherCovers(m, tool) {
  if (m === undefined || m === null || m === "" || m === "*") return true;
  if (typeof m !== "string") return false;
  try {
    return new RegExp(`^(?:${m})$`).test(tool);
  } catch {
    return false;
  }
}

/**
 * The words of `command` when it is ONE plain command, else null. Plain: words separated
 * by blanks, single or double quotes around a word allowed, and nothing the shell would
 * act on: no `;`, `&`, `|`, redirect, subshell, `$` or backtick expansion, backslash,
 * comment, glob, brace or leading tilde, and no line break. A hook command is run by a
 * shell, so anything else can turn "the safety hook" into a different command that
 * merely mentions it.
 */
export function plainCommandWords(command) {
  const words = [];
  let cur = null;
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (c === " " || c === "\t") {
      if (cur !== null) words.push(cur);
      cur = null;
    } else if (c === "'" || c === '"') {
      const end = command.indexOf(c, i + 1);
      if (end === -1) return null;
      const inner = command.slice(i + 1, end);
      if (c === '"' && /[$`\\!]/.test(inner)) return null;
      if (/[\n\r]/.test(inner)) return null;
      cur = (cur ?? "") + inner;
      i = end;
    } else if (/[;&|<>()$`\\#\n\r*?[\]{}!]/.test(c) || (c === "~" && cur === null)) {
      return null;
    } else cur = (cur ?? "") + c;
  }
  if (cur !== null) words.push(cur);
  return words;
}

/** The keys a safety-hook entry may carry: any other could change how, or whether, it runs. */
const HOOK_ENTRY_KEYS = new Set(["type", "command", "timeout", "onFailure", "statusMessage"]);

/**
 * Why hook entry `h` does not RUN the safety hook at `hookPath`, or null when it does. It
 * runs it when its command is exactly `node <hookPath>` (`node` by name or by an absolute
 * path) or `<hookPath>` alone, as one plain command, and the entry holds no key this rule
 * does not know (`"async": true`, for one, starts the hook in the background, where its
 * verdict blocks nothing).
 */
export function hookCommandProblem(h, hookPath) {
  const unknown = Object.keys(h).filter((k) => !HOOK_ENTRY_KEYS.has(k));
  if (unknown.length > 0) {
    return `it sets ${unknown.join(", ")}, which this check does not know (a key such as "async" changes whether the hook can block; allowed: ${[...HOOK_ENTRY_KEYS].join(", ")})`;
  }
  const words = plainCommandWords(h.command);
  // A runner directory whose path holds a blank or a character the shell acts on has to
  // be quoted in the template, or the shell splits it and the hook never starts.
  const bare = plainCommandWords(`node ${hookPath}`);
  const quote = bare && bare.length === 2 && bare[1] === hookPath ? "" : '"';
  const form = `its command must be exactly: node ${quote}${hookPath}${quote}`;
  if (words === null) {
    return `its command is not one plain command (shell syntax, an expansion or a comment); ${form}`;
  }
  const isNode = (w) => w === "node" || (isAbsolute(w) && basename(w) === "node");
  if (words.length === 1 && words[0] === hookPath) return null;
  if (words.length === 2 && isNode(words[0]) && words[1] === hookPath) return null;
  return form;
}

/**
 * Check rendered settings text against the rule. Returns `{ ok: true, parsed }` or
 * `{ ok: false, why }` (why: one sentence, no "SAFETY:" prefix).
 */
export function validateAgentSettings(text, runnerDir) {
  const hookPath = resolve(runnerDir, "safety-hook.mjs");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, why: `the rendered settings are not valid JSON: ${err.message}` };
  }
  // An entry that NAMES the hook (so a mistake in it is reported as one) and an entry that
  // RUNS it. Naming is not running: `# node <hook>`, `true || node <hook>`,
  // `echo <hook>` and a hook started in the background all carry the path and decide
  // nothing.
  const namesHook = (h) =>
    h && h.type === "command" && typeof h.command === "string" && h.command.includes(hookPath);
  const runsHook = (h) => namesHook(h) && hookCommandProblem(h, hookPath) === null;
  // A settings file can switch every hook off without touching PreToolUse:
  // `"disableAllHooks": true` (and, where Claude Code honours it, `allowManagedHooksOnly`,
  // which drops project hooks). Either one means the safety hook never runs. An explicit
  // `"disableAllHooks": false` is what the shipped template writes: project settings take
  // precedence over the user's, so it keeps a `true` in ~/.claude/settings.json from
  // switching the factory's hook off.
  if (parsed && typeof parsed === "object") {
    if ("disableAllHooks" in parsed && parsed.disableAllHooks !== false) {
      return {
        ok: false,
        why: `the settings set "disableAllHooks" to ${JSON.stringify(parsed.disableAllHooks)}, which switches the safety hook off (only false is allowed)`,
      };
    }
    if ("allowManagedHooksOnly" in parsed && parsed.allowManagedHooksOnly !== false) {
      return {
        ok: false,
        why: `the settings set "allowManagedHooksOnly", which drops the project's hooks and with them the safety hook`,
      };
    }
  }
  const pre = parsed?.hooks?.PreToolUse;
  const wired = Array.isArray(pre)
    ? pre.filter(
        (m) => m && typeof m === "object" && Array.isArray(m.hooks) && m.hooks.some(runsHook),
      )
    : [];
  if (Array.isArray(pre)) {
    for (const m of pre) {
      if (!m || typeof m !== "object" || !Array.isArray(m.hooks)) continue;
      for (const h of m.hooks) {
        if (!namesHook(h)) continue;
        const problem = hookCommandProblem(h, hookPath);
        if (problem) {
          return {
            ok: false,
            why: `the PreToolUse entry for ${m.matcher ?? "*"} names the safety hook but does not run it: ${problem}`,
          };
        }
      }
    }
  }
  if (wired.length === 0) {
    return { ok: false, why: `no PreToolUse hook runs the safety hook (${hookPath})` };
  }
  for (const m of wired) {
    for (const h of m.hooks) {
      if (!runsHook(h)) continue;
      if (h.onFailure !== "block" || !(typeof h.timeout === "number" && h.timeout > 0)) {
        return {
          ok: false,
          why: `the safety-hook entry for ${m.matcher ?? "*"} lacks "onFailure": "block" and a timeout (a timed-out hook would let the tool run)`,
        };
      }
    }
  }
  const uncovered = REQUIRED_TOOLS.filter((t) => !wired.some((m) => matcherCovers(m.matcher, t)));
  if (uncovered.length) {
    return {
      ok: false,
      why: `no PreToolUse safety-hook (${hookPath}) matcher for ${uncovered.join(", ")}`,
    };
  }
  return { ok: true, parsed };
}

/** The only tools the research agent's settings may allow (backlog 69). */
export const RESEARCH_ALLOWED_TOOLS = Object.freeze(["WebSearch", "WebFetch"]);
/** Tools the research settings must deny by name (each reaches files, a shell or a sub-agent). */
export const RESEARCH_REQUIRED_DENY = Object.freeze([
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Task",
  "Agent",
  "Skill",
  "Monitor",
]);

/**
 * The research agent's settings rule (runner/claude/research-settings.json, rendered by
 * runner/bin/research-run.mjs only). Separate from validateAgentSettings, which every
 * other agent's settings keep passing unchanged:
 *   * valid JSON; hooks not switched off (`disableAllHooks` false only, no
 *     `allowManagedHooksOnly`); project MCP servers not enabled;
 *   * EVERY PreToolUse entry runs `<runner>/research-hook.mjs` and nothing else, and one
 *     of them has the match-all matcher (`*`, `""` or none), so every tool name reaches
 *     the research decision; each with `"onFailure": "block"` and a timeout;
 *   * no entry runs the general safety hook (a template that mixed the two would let a
 *     delivery-shaped file pass as research or the reverse);
 *   * permissions.allow names only WebSearch and WebFetch; permissions.deny names at least
 *     RESEARCH_REQUIRED_DENY.
 * Returns `{ ok: true, parsed }` or `{ ok: false, why }`.
 */
export function validateResearchSettings(text, runnerDir) {
  const hookPath = resolve(runnerDir, "research-hook.mjs");
  const generalHook = resolve(runnerDir, "safety-hook.mjs");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, why: `the rendered research settings are not valid JSON: ${err.message}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, why: "the research settings are not an object" };
  }
  if (parsed.disableAllHooks !== false) {
    return { ok: false, why: 'the research settings must set "disableAllHooks": false' };
  }
  if ("allowManagedHooksOnly" in parsed && parsed.allowManagedHooksOnly !== false) {
    return {
      ok: false,
      why: 'the research settings set "allowManagedHooksOnly", which drops the hook',
    };
  }
  if (parsed.enableAllProjectMcpServers === true || "enabledMcpjsonServers" in parsed) {
    return {
      ok: false,
      why: "the research settings enable MCP servers; the research agent has none",
    };
  }
  const pre = parsed.hooks?.PreToolUse;
  if (!Array.isArray(pre) || pre.length === 0) {
    return { ok: false, why: `no PreToolUse hook runs the research hook (${hookPath})` };
  }
  const allEntries = Object.values(parsed.hooks ?? {}).flatMap((v) => (Array.isArray(v) ? v : []));
  for (const m of allEntries) {
    for (const h of Array.isArray(m?.hooks) ? m.hooks : []) {
      if (h && typeof h.command === "string" && h.command.includes(generalHook)) {
        return {
          ok: false,
          why: "the research settings run the general safety hook; they must run only the research hook",
        };
      }
    }
  }
  let matchAll = false;
  for (const m of pre) {
    if (!m || typeof m !== "object" || !Array.isArray(m.hooks) || m.hooks.length === 0) {
      return { ok: false, why: "a PreToolUse entry of the research settings has no hook" };
    }
    for (const h of m.hooks) {
      if (!h || h.type !== "command" || typeof h.command !== "string") {
        return {
          ok: false,
          why: "a PreToolUse hook of the research settings is not a command hook",
        };
      }
      const problem = hookCommandProblem(h, hookPath);
      if (problem) {
        return {
          ok: false,
          why: `a PreToolUse hook of the research settings does not run the research hook: ${problem}`,
        };
      }
      if (h.onFailure !== "block" || !(typeof h.timeout === "number" && h.timeout > 0)) {
        return {
          ok: false,
          why: 'the research hook entry lacks "onFailure": "block" and a timeout',
        };
      }
    }
    if (m.matcher === undefined || m.matcher === null || m.matcher === "" || m.matcher === "*") {
      matchAll = true;
    }
  }
  if (!matchAll) {
    return {
      ok: false,
      why: "no PreToolUse entry of the research settings matches every tool (*)",
    };
  }
  const allow = parsed.permissions?.allow ?? [];
  const deny = parsed.permissions?.deny ?? [];
  if (!Array.isArray(allow) || allow.some((t) => !RESEARCH_ALLOWED_TOOLS.includes(t))) {
    return {
      ok: false,
      why: `the research settings allow a tool other than ${RESEARCH_ALLOWED_TOOLS.join(" and ")}`,
    };
  }
  const missing = RESEARCH_REQUIRED_DENY.filter((t) => !Array.isArray(deny) || !deny.includes(t));
  if (missing.length) {
    return { ok: false, why: `the research settings do not deny ${missing.join(", ")}` };
  }
  return { ok: true, parsed };
}

/**
 * Render the research template into `<root>/<rel>`, verify it with
 * validateResearchSettings, write it without following a link and read it back. Throws an
 * Error starting "SAFETY:" (or an UnsafePathError) on any refusal, like
 * writeVerifiedSettings.
 */
export function writeVerifiedResearchSettings(root, rel, settingsPath, runnerDir) {
  const refuse = (why) => {
    try {
      safeRemoveFile(root, rel);
    } catch {
      /* nothing of ours to remove */
    }
    throw new Error(`SAFETY: ${why}; refusing to launch the research agent (fail closed)`);
  };
  let rendered;
  try {
    rendered = renderAgentSettings(readFileSync(settingsPath, "utf8"), runnerDir);
  } catch (err) {
    return refuse(`cannot read the research settings template ${settingsPath}: ${err.message}`);
  }
  const v = validateResearchSettings(rendered, runnerDir);
  if (!v.ok) return refuse(`${settingsPath}: ${v.why}`);
  let target;
  try {
    target = safeWriteFile(root, rel, rendered);
    if (readFileSync(target, "utf8") !== rendered) throw new Error("read-back mismatch");
  } catch (err) {
    if (err instanceof UnsafePathError) throw err;
    return refuse(`could not write ${resolve(root, rel)}: ${err.message}`);
  }
  return target;
}

/**
 * Render `settingsPath` into `<root>/<rel>`, verify it against the rule, and write it
 * without following a link. Throws an Error starting "SAFETY:" on a rule refusal and an
 * UnsafePathError on a path refusal; on either, a regular file left at the destination
 * by an earlier write is removed (never through a link). Returns the path written.
 */
export function writeVerifiedSettings(root, rel, settingsPath, runnerDir) {
  const refuse = (why) => {
    try {
      safeRemoveFile(root, rel);
    } catch {
      /* the path itself is unsafe: nothing of ours to remove */
    }
    throw new Error(
      `SAFETY: ${why}; refusing to launch an agent without its safety hook (fail closed)`,
    );
  };
  let rendered;
  try {
    rendered = renderAgentSettings(readFileSync(settingsPath, "utf8"), runnerDir);
  } catch (err) {
    return refuse(`cannot read the agent settings template ${settingsPath}: ${err.message}`);
  }
  const v = validateAgentSettings(rendered, runnerDir);
  if (!v.ok) return refuse(`${settingsPath}: ${v.why}`);
  let target;
  try {
    target = safeWriteFile(root, rel, rendered);
    if (readFileSync(target, "utf8") !== rendered) throw new Error("read-back mismatch");
  } catch (err) {
    if (err instanceof UnsafePathError) throw err;
    return refuse(`could not write ${resolve(root, rel)}: ${err.message}`);
  }
  return target;
}

function main(argv) {
  const [verb, ...rest] = argv;
  try {
    if (verb === "write" && rest.length === 4) {
      writeVerifiedSettings(rest[0], rest[1], rest[2], rest[3]);
      return 0;
    }
    if (verb === "validate" && rest.length === 2) {
      const v = validateAgentSettings(readFileSync(rest[0], "utf8"), rest[1]);
      if (v.ok) return 0;
      process.stderr.write(`SAFETY: ${rest[0]}: ${v.why}\n`);
      return EXIT_SAFETY;
    }
  } catch (err) {
    process.stderr.write(`${err && err.message ? err.message : err}\n`);
    if (err instanceof UnsafePathError) return EXIT_UNSAFE;
    return /^SAFETY:/.test(String(err?.message)) ? EXIT_SAFETY : 1;
  }
  process.stderr.write(
    "usage: agent-settings.mjs write <root> <rel> <template> <runner-dir> | validate <file> <runner-dir>\n",
  );
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
