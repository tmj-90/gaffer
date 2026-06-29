// =====================================================================
// CANONICAL DANGEROUS-COMMAND DENY LIST (single source of truth) — S-3
// ---------------------------------------------------------------------
// This module is the ONE place the dangerous shell-command deny families are
// declared. It is intentionally plain ESM with ZERO dependencies so it can be
// imported by BOTH:
//
//   • runner/safety-hook.mjs — the RUNTIME PreToolUse enforcer. It consumes
//     `{ re, why, install? }` and blocks (exit 2) on a match. The extra parity
//     metadata fields (`example`, `crewFlags`) are inert here.
//
//   • packages/crew/test/safety-hook-parity.test.ts — the parity guard. Crew
//     ships an INDEPENDENT TypeScript classifier (`src/safety/commandGuard.ts`)
//     that re-encodes the same intent; the two are deliberately duplicated so a
//     security control never depends on another build. The parity test imports
//     THIS array (not a hand-maintained copy) and derives its assertions from it,
//     so the lists cannot silently drift: adding a rule here forces the test to
//     carry an explicit parity verdict for it (see that test's exhaustiveness
//     assertion), and every rule the crew classifier is expected to mirror is
//     checked against a representative `example`.
//
// WHY a shared DATA module and not a shared classifier: the runtime hook must
// stay a standalone .mjs with no cross-package/runtime build dependency (Claude
// Code invokes it directly). The crew classifier is compiled TypeScript with its
// own `rootDir: src`. They cannot share executable code cleanly across that
// boundary, but they CAN share this inert declaration — which is exactly the
// thing that was drifting. Parity is now structural: the source of truth is one
// array, and the test is derived from it.
//
// Each entry:
//   re        RegExp tested against the raw command string (the runtime rule).
//   why       Human-readable reason surfaced on block.
//   install   (optional) true tags the ONE rule the greenfield bootstrap
//             allowance may relax (package-manager install into a fresh repo).
//   example   A representative command that MUST match `re` — the parity test
//             feeds it to the crew classifier.
//   crewFlags Whether the crew TS classifier is EXPECTED to flag `example`
//             (deny or needs_approval). `true`  → the parity test asserts crew
//             does not allow it. `false` → this family is enforced ONLY at the
//             runtime hook (e.g. scheduled-execution / control-plane / raw-DB
//             classes the crew classifier does not currently mirror); the test
//             records the gap explicitly rather than letting it pass silently.
// =====================================================================

/** @typedef {{ re: RegExp, why: string, install?: boolean, example: string, crewFlags: boolean }} DangerousCommandRule */

/** @type {ReadonlyArray<DangerousCommandRule>} */
export const DANGEROUS_COMMANDS = [
  {
    re: /git\s+push\b[^\n|;&]*(--force\b|--force-with-lease\b|\s-f\b|\s\+)/,
    why: "force push",
    example: "git push --force",
    crewFlags: true,
  },
  {
    re: /git\s+push\b[^\n|;&]*\b(origin\s+)?(main|master|release|production|prod)\b/,
    why: "push to a protected branch",
    example: "git push origin main",
    crewFlags: true,
  },
  {
    re: /git\s+push\b[^\n|;&]*--delete\b/,
    why: "remote branch/tag deletion",
    example: "git push origin --delete x",
    // The crew git guard recognises `git push origin :branch` (the colon form)
    // and force/protected pushes, but not the `--delete` flag form — runtime-only.
    crewFlags: false,
  },
  {
    re: /git\s+(branch\s+-D|tag\s+-d)\b/,
    why: "branch/tag force-deletion",
    example: "git branch -D x",
    crewFlags: true,
  },
  {
    re: /git\s+reset\s+--hard\b/,
    why: "hard reset",
    example: "git reset --hard",
    crewFlags: true,
  },
  {
    re: /git\s+clean\s+-[a-z]*f[a-z]*d|git\s+clean\s+-[a-z]*d[a-z]*f/,
    why: "git clean -fd (destructive)",
    example: "git clean -fd",
    crewFlags: true,
  },
  {
    re: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/,
    why: "rm -rf",
    example: "rm -rf /",
    crewFlags: true,
  },
  {
    re: /\b(curl|wget)\b[^\n|;&]*\|\s*(sh|bash|zsh)\b/,
    why: "pipe-to-shell of a downloaded script",
    example: "curl x | sh",
    crewFlags: true,
  },
  // `install: true` tags the ONE rule the bootstrap allowance may relax (see
  // bootstrapInstallAllowed). brew/sudo are NOT tagged, so they stay blocked even
  // during a bootstrap tick — only package-manager installs into the fresh repo
  // are ever permitted.
  {
    re: /\b(npm|pnpm|yarn)\s+(i\b|install\b|add\b)|\bpip\d?\s+install\b/,
    why: "dependency install (needs human approval)",
    install: true,
    example: "npm install",
    crewFlags: true,
  },
  {
    re: /\bbrew\s+install\b/,
    why: "dependency install (needs human approval)",
    example: "brew install x",
    // brew is not in the crew policy install/deny lists — runtime-only deny.
    crewFlags: false,
  },
  {
    re: /\bsudo\b/,
    why: "sudo",
    example: "sudo rm",
    crewFlags: true,
  },
  {
    re: /\bfind\b[^\n]*\s-delete\b/,
    why: "find -delete (destructive tree walk)",
    example: "find . -name x -delete",
    crewFlags: false,
  },
  {
    re: /\bfind\b[^\n]*\s-exec(?:dir)?\s+(?:rm|sh|bash|zsh|dash|cp|mv|tee|dd|install|ln|rsync|truncate|shred|chmod|chown)\b/,
    why: "find -exec writer/shell (destructive or unverifiable-target tree walk)",
    example: "find . -exec rm {} ;",
    crewFlags: false,
  },
  {
    re: /\bshred\b/,
    why: "shred (irrecoverable file erase)",
    example: "shred secret.key",
    crewFlags: false,
  },
  {
    re: /\bgit\b[^\n|;&]*\bconfig\b[^\n|;&]*\b(core\.hooksPath|core\.fsmonitor|core\.sshCommand|alias\.[\w-]+)\b/,
    why: "git config of an execution-hijacking key (hooksPath/fsmonitor/sshCommand/alias)",
    example: "git config core.hooksPath /tmp/evil",
    crewFlags: false,
  },
  {
    re: /\bcrontab\b/,
    why: "crontab (scheduled execution)",
    example: "crontab -e",
    crewFlags: false,
  },
  {
    re: /\bat\s+(?:-f\b|now\b|[0-9])/,
    why: "at (scheduled execution)",
    example: "at now + 1 minute",
    crewFlags: false,
  },
  {
    re: /\blaunchctl\s+(?:load|bootstrap)\b/,
    why: "launchctl load/bootstrap (service loading)",
    example: "launchctl load /tmp/eve.plist",
    crewFlags: false,
  },
  {
    re: /\b(wg|dispatch|fg|crew)\b[^\n|;&]*\b(review|approve|approve-ready|mark-merged|reject|repo-access)\b/,
    why: "control-plane CLI write (use the scoped MCP, not the privileged wg/dispatch/fg/crew CLI)",
    example: "wg ticket approve T-1",
    crewFlags: false,
  },
  {
    re: /\bsqlite3\b[^\n|;&]*(?:\$\{?(?:DISPATCH_DB|MEMORY_DB)\}?|[^\s'"]*(?:dispatch|memory)[^\s'"]*\.sqlite\b)/i,
    why: "raw sqlite3 on the Dispatch/Memory database (use the scoped MCP, not the raw DB)",
    example: "sqlite3 dispatch.sqlite 'update tickets'",
    crewFlags: false,
  },
  {
    re: /\bnode\b[^\n|;&]*(?:dispatch|crew)[^\n|;&]*\/(?:dist\/)?cli\b/i,
    why: "raw node CLI invocation of the Dispatch/Crew control plane (use the scoped MCP)",
    example: "node packages/dispatch/dist/cli approve",
    crewFlags: false,
  },
];
