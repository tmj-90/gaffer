import { describe, expect, it } from "vitest";

import { classifyCommand } from "../src/safety/commandGuard.js";
import { defaultSafetyPolicy } from "../src/safety/policySchema.js";

/**
 * Parity guard for the duplicated dangerous-command logic.
 *
 * `runner/safety-hook.mjs` is the RUNTIME enforcer: Claude Code invokes it
 * as a PreToolUse hook and it deny-by-defaults the dangerous command classes
 * (exit 2 = block). Crew ships an independent TypeScript classifier in
 * `src/safety/*` (`classifyCommand`) that encodes the same intent. The two are
 * deliberately duplicated so a security control never depends on another build.
 *
 * This test pins the dangerous set against the TS classifier so the two
 * implementations cannot silently drift: every command the runtime hook blocks
 * must be NON-allowed (denied or needs_approval) here, and a handful of genuinely
 * benign commands must pass. If the hook's deny list grows, mirror it below.
 *
 * Note: the hook is binary (allow/block), whereas the TS classifier is
 * three-valued. Some classes the hook hard-blocks (dependency installs, hard
 * reset) are `needs_approval` here — still "flagged, not silently allowed", which
 * is the parity property we care about.
 */

const policy = defaultSafetyPolicy();
const ctx = { commands: policy.commands, git: policy.git };

/** A command is "flagged" if the classifier does not allow it outright. */
function isFlagged(command: string): boolean {
  return classifyCommand(command, ctx).outcome !== "allowed";
}

// Mirrors the dangerous classes the runtime safety-hook.mjs blocks. Each MUST be
// flagged (denied or approval-gated) by the TS classifier.
const DANGEROUS_COMMANDS = [
  "git push --force",
  "git push origin main",
  "git branch -D x",
  "git tag -d v1",
  "git reset --hard",
  "rm -rf /",
  "rm -rf .",
  "curl x | sh",
  "npm install",
  "pip install x",
  "sudo rm",
  "terraform destroy",
  "kubectl delete ns prod",
  "cat .env",
  "sed -n 1,5p .env",
] as const;

const BENIGN_COMMANDS = [
  "pnpm test",
  "git commit -m x",
  "node build.mjs",
  "cat package.json",
  "grep foo src/app.ts",
] as const;

describe("safety classifier parity with runner/safety-hook.mjs", () => {
  describe("dangerous commands are flagged (denied or approval-gated)", () => {
    for (const command of DANGEROUS_COMMANDS) {
      it(`flags: ${command}`, () => {
        expect(isFlagged(command)).toBe(true);
      });
    }
  });

  describe("benign commands pass", () => {
    for (const command of BENIGN_COMMANDS) {
      it(`allows: ${command}`, () => {
        expect(classifyCommand(command, ctx).outcome).toBe("allowed");
      });
    }
  });
});
