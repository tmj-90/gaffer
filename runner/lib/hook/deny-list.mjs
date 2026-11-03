/**
 * The dangerous-command deny list (lib/dangerous-commands.mjs), loaded so that a missing
 * or broken list fails the hook CLOSED.
 *
 * Part of the safety hook's decision, split out of runner/safety-hook-core.mjs (the one
 * module the hook and the tests import); see the map in its header.
 */

// Canonical dangerous-command deny list — the SINGLE source of truth shared with
// the crew classifier's parity test (S-3). The hook consumes `{ re, why, install? }`;
// the extra parity metadata on each rule is inert here. See the module header.
//
// FAIL CLOSED on a missing/broken deny-list. A STATIC `import` of this sibling would
// crash the module at LOAD time if the file were deleted/renamed/corrupt — and a
// load-time crash exits non-2, which Claude Code reads as ALLOW, silently disabling
// the ENTIRE hook. So load it via a guarded dynamic import (top-level await resolves
// before the stdin handlers below process anything) and BLOCK (exit 2) on any failure
// or an empty/malformed list. tick.sh preflights this file's existence too.
let DENY_COMMANDS;
try {
  ({ DANGEROUS_COMMANDS: DENY_COMMANDS } = await import("../dangerous-commands.mjs"));
  if (!Array.isArray(DENY_COMMANDS) || DENY_COMMANDS.length === 0) {
    throw new Error("deny-list is empty or not an array");
  }
} catch (err) {
  process.stderr.write(
    `safety-hook: cannot load the dangerous-command deny-list (${err && err.message ? err.message : err}) — FAILING CLOSED (exit 2).\n`,
  );
  process.exit(2);
}

export { DENY_COMMANDS };
