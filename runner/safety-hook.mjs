#!/usr/bin/env node
/**
 * Gaffer factory — Claude Code PreToolUse safety hook (the deterministic bouncer).
 *
 * Claude Code invokes this before a tool runs, passing the tool call as JSON on
 * stdin. Exit 0 = allow; exit 2 = BLOCK (stderr is fed back to the model as the
 * reason). This is the security boundary for unattended runs: the model proposes
 * actions, this hook decides — deterministically, not by trusting the model.
 *
 * This file is the PROCESS CONTRACT only: stdin → decide → stderr + exit code.
 * The decision, every rule, lives in ./safety-hook-core.mjs (decideRaw; its header
 * carries the design notes and the SECRET BOUNDARY MODEL). Nothing here allows a
 * call the core did not allow.
 */
import { writeSync } from "node:fs";

// FAIL CLOSED on a missing/broken decision core, for the reason the core loads its
// deny-list this way: a STATIC `import` of a sibling that is deleted, renamed or
// corrupt crashes this module at LOAD time, and a load-time crash exits non-2,
// which Claude Code reads as ALLOW, silently disabling the ENTIRE hook. The guarded
// dynamic import (top-level await resolves before the stdin handlers below process
// anything) BLOCKS (exit 2) on any failure instead. Loading the core also loads the
// deny-list, which fails closed on its own with its own message (see the core).
let decideRaw;
try {
  ({ decideRaw } = await import("./safety-hook-core.mjs"));
  if (typeof decideRaw !== "function") throw new Error("decideRaw is not a function");
} catch (err) {
  process.stderr.write(
    `safety-hook: cannot load the decision core (${err && err.message ? err.message : err}) — FAILING CLOSED (exit 2).\n`,
  );
  process.exit(2);
}

// FAIL-CLOSED GLOBAL GUARD: Claude Code treats ONLY exit 2 as blocking — ANY
// other exit (including the exit 1 an uncaught exception produces) ALLOWS the
// tool, voiding the entire hook. So ANY error we do not otherwise handle must
// still BLOCK. We deliberately do NOT route this through block() (which touches
// the telemetry ledger and could itself throw); we write stderr and exit 2
// directly, the minimal fail-closed action.
process.on("uncaughtException", (err) => {
  try {
    process.stderr.write(
      `BLOCKED by gaffer safety hook: internal error — failing closed: ${err && err.message ? err.message : err}\n`,
    );
  } catch {
    /* stderr write must never itself prevent the exit-2 fail-closed */
  }
  process.exit(2);
});

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  // The core fails closed on its own (an unparseable payload or a crash while
  // deciding comes back as a block); anything that still escapes it reaches the
  // uncaughtException guard above (exit 2). stdout goes out through writeSync: an
  // allowed Grep's decision JSON must be flushed before process.exit, on every
  // platform, and a failed write is a crash the core turns into a block.
  const verdict = decideRaw(raw, { stdout: (text) => writeSync(1, text) });
  if (verdict.stderr) process.stderr.write(verdict.stderr);
  process.exit(verdict.exitCode);
});
