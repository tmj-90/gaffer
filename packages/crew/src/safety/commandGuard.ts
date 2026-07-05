import { allow, deny, needsApproval, type SafetyDecision } from "./decision.js";
import { classifyGitCommand } from "./gitGuard.js";
import type { CommandPolicy, GitPolicy } from "./policySchema.js";

/** Collapse runs of whitespace so pattern matching is stable. */
function normalise(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

/** True when `command` begins with, or contains, the policy `pattern`. */
function commandMatches(command: string, pattern: string): boolean {
  const c = normalise(command);
  const p = normalise(pattern);
  return (
    c === p ||
    c.startsWith(`${p} `) ||
    c.includes(` ${p} `) ||
    c.includes(` ${p}`) ||
    c.startsWith(p)
  );
}

export interface CommandGuardContext {
  commands: CommandPolicy;
  git: GitPolicy;
  /** Extra allow-listed commands contributed by a repo's config. */
  repoAllow?: readonly string[];
}

/**
 * Built-in dangerous-command classes that are denied regardless of the
 * configurable policy lists. These intentionally mirror the deny families in
 * `runner/safety-hook.mjs` (the runtime PreToolUse enforcer) so the two
 * deliberately-duplicated implementations cannot silently drift: a class the
 * runtime hook blocks must also be caught here. `test/safety-hook-parity.test.ts`
 * pins this parity. The configurable `deny`/`require_approval` lists in policy
 * remain additive on top of these baseline guarantees.
 */
const DANGEROUS_COMMAND_RULES: ReadonlyArray<{ re: RegExp; why: string; rule: string }> = [
  // Recursive force-remove of ANY target (rm -rf /, rm -rf ., rm -rf x …), not
  // just the literal paths a policy deny-list might enumerate.
  {
    re: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i,
    why: "recursive force-remove (rm -rf)",
    rule: "command.rm_rf",
  },
  // Pipe a downloaded script straight into a shell.
  {
    re: /\b(curl|wget)\b[^\n|;&]*\|\s*(sh|bash|zsh)\b/i,
    why: "pipe-to-shell of a downloaded script",
    rule: "command.pipe_to_shell",
  },
  // Privilege escalation.
  { re: /\bsudo\b/i, why: "privilege escalation (sudo)", rule: "command.sudo" },
];

// Read/copy/exfil tools that, when pointed at a secret path, leak secrets.
// Mirrors READ_COPY_TOOLS in safety-hook.mjs.
const READ_COPY_TOOLS =
  /\b(cat|head|tail|less|more|bat|sed|awk|grep|egrep|fgrep|rg|strings|xxd|od|hexdump|base64|cp|mv|scp|rsync|tar|dd|nl|tac|cut|tee)\b/i;
// Named secret-path fragment matched anywhere in a command. Kept in lock-step with
// SECRET_PATH_FRAGMENT in runner/safety-hook.mjs (S-M4) — the two duplicated guards
// must not drift, so this mirrors the hook's families INCLUDING the factory's own
// fixed-name secrets (`dashboard-token`, `mcp-runtime.*.json`), `.gnupg/`, and the
// `*-token` file family. `test/safety-hook-parity.test.ts` pins representative
// secret-path commands against this classifier so a gap here fails the build.
//
// The two helper constants below are ported verbatim from the hook:
//  - MCP_RUNTIME_FILE anchors the runtime JSON that carries the substituted
//    GAFFER_CLAIM_TOKEN (a rogue read of it recovers the claim token).
//  - TOKEN_SOURCE_EXT_GUARD exempts token-NAMED source/design files
//    (`src/design-tokens.json`, `csrf_token.ts`) so an ordinary edit is not flagged,
//    while `dashboard-token` keeps its own guard-free alternative and always fires.
const MCP_RUNTIME_FILE = String.raw`mcp-runtime(?:\.\w+)*\.json`;
const TOKEN_CODE_EXT = String.raw`tsx|ts|jsx|js|mjs|cjs|css|scss|sass|less|vue|svelte`;
const TOKEN_SOURCE_EXT_GUARD = String.raw`(?!(?:\.(?:${TOKEN_CODE_EXT})|(?<=design[._-]tokens?)(?:\.[\w-]+)?|(?<=\.tokens)(?:\.json)?)(?![\w.]))`;
const SECRET_PATH_FRAGMENT = new RegExp(
  String.raw`(\.env\b|\.env\.[\w-]+|[\w./-]*\.pem\b|[\w./-]*\.key\b|[\w./-]*\.p12\b|id_rsa\b|id_ed25519\b|id_[a-z0-9]+\b|\.ssh\/|\.aws\/|\.npmrc\b|\.git-credentials\b|\.netrc\b|\.gnupg\/|credentials\b|secrets?\b|${MCP_RUNTIME_FILE}\b|dashboard-token\b|[\w./-]*[._-]tokens?${TOKEN_SOURCE_EXT_GUARD}\b)`,
  "i",
);

/** True when a command reads/copies a named secret path (e.g. `cat .env`). */
function readsSecretFile(command: string): boolean {
  return READ_COPY_TOOLS.test(command) && SECRET_PATH_FRAGMENT.test(command);
}

/**
 * Built-in dangerous-command classification, independent of configurable policy.
 * Returns a deny decision for a matched class, or undefined when none match.
 */
function classifyDangerousCommand(command: string): SafetyDecision | undefined {
  for (const { re, why, rule } of DANGEROUS_COMMAND_RULES) {
    if (re.test(command)) return deny(`Denied: ${why}.`, rule);
  }
  if (readsSecretFile(command)) {
    return deny(
      "Denied: reads/copies a secret file (keeps secrets out of context).",
      "command.read_secret",
    );
  }
  return undefined;
}

/**
 * Classify an arbitrary shell command:
 *  0. Built-in dangerous classes (rm -rf, pipe-to-shell, sudo, secret reads) →
 *     denied, regardless of policy, mirroring the runtime safety hook.
 *  1. Explicit deny list → denied.
 *  2. Git-specific destructive operations (delegated) → denied/approval.
 *  3. Approval list (risky installs, applies) → needs_approval.
 *  4. Allow list (global + repo) → allowed.
 *  5. Otherwise allowed by default in MVP, but flagged via reason.
 */
export function classifyCommand(command: string, ctx: CommandGuardContext): SafetyDecision {
  const c = normalise(command);

  const dangerous = classifyDangerousCommand(c);
  if (dangerous) return dangerous;

  for (const denied of ctx.commands.deny) {
    if (commandMatches(c, denied)) {
      return deny(`Command matches denied pattern '${denied}'.`, "command.denied");
    }
  }

  if (c.startsWith("git ") || c === "git") {
    const gitDecision = classifyGitCommand(c, ctx.git);
    if (gitDecision.outcome !== "allowed") return gitDecision;
  }

  for (const risky of ctx.commands.require_approval) {
    if (commandMatches(c, risky)) {
      return needsApproval(
        `Command '${risky}' modifies dependencies/infra/state and is approval-gated.`,
        `command:${risky}`,
        "command.approval",
      );
    }
  }

  const allowList = [
    ...ctx.commands.allow,
    ...(ctx.commands.allow_from_repo_config ? (ctx.repoAllow ?? []) : []),
  ];
  for (const allowed of allowList) {
    if (commandMatches(c, allowed)) {
      return allow(`Command matches allow-listed pattern '${allowed}'.`, "command.allow");
    }
  }

  return allow("Command is not denied or approval-gated by policy.", "command.default_allow");
}
