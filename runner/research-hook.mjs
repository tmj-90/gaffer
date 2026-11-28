#!/usr/bin/env node
/**
 * Gaffer factory: the safety hook for the RESEARCH agent (backlog 69).
 *
 * Claude Code runs this before (PreToolUse) and after (PostToolUse) every tool call of
 * the one agent that may use the web, passing the call as JSON on stdin. Exit 0 =
 * allow; exit 2 = BLOCK (stderr is the reason the model reads).
 *
 * The role is this PROGRAM, chosen by the settings the research launcher renders
 * (runner/claude/research-settings.json): it never reads a role from the environment,
 * and runner/safety-hook.mjs, which every other agent runs, never becomes more
 * permissive (it refuses WebFetch and WebSearch by name). The decision lives in
 * runner/lib/hook/research.mjs; this file is the process contract only.
 */

// FAIL CLOSED on a missing or broken decision module: a load-time crash would exit
// non-2, which Claude Code reads as "run the tool" (with onFailure: block it does not,
// but an older CLI would). So the module is loaded with a guarded dynamic import.
let decideResearch;
try {
  ({ decideResearch } = await import("./lib/hook/research.mjs"));
  if (typeof decideResearch !== "function") throw new Error("decideResearch is not a function");
} catch (err) {
  process.stderr.write(
    `research-hook: cannot load the decision (${err && err.message ? err.message : err}); FAILING CLOSED (exit 2).\n`,
  );
  process.exit(2);
}

process.on("uncaughtException", (err) => {
  try {
    process.stderr.write(
      `BLOCKED by gaffer research hook: internal error, failing closed: ${err && err.message ? err.message : err}\n`,
    );
  } catch {
    /* the exit below is what matters */
  }
  process.exit(2);
});

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", async () => {
  const v = await decideResearch(raw);
  if (v.stderr) process.stderr.write(v.stderr);
  process.exit(v.exitCode === 0 ? 0 : 2);
});
