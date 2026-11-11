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
//     `"type": "command"` hook;
//   * every one of those safety-hook entries says `"onFailure": "block"` and carries a
//     positive numeric timeout (Claude Code otherwise runs the tool when the hook times
//     out or crashes);
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
import { resolve } from "node:path";
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
  const runsHook = (h) =>
    h && h.type === "command" && typeof h.command === "string" && h.command.includes(hookPath);
  const pre = parsed?.hooks?.PreToolUse;
  const wired = Array.isArray(pre)
    ? pre.filter(
        (m) => m && typeof m === "object" && Array.isArray(m.hooks) && m.hooks.some(runsHook),
      )
    : [];
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
