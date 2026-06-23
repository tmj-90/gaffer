import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { classifyCommand } from "../src/safety/commandGuard.js";
import { classifyGitCommand } from "../src/safety/gitGuard.js";
import { checkFileWrite } from "../src/safety/fsGuard.js";
import { checkBranchPolicy, buildBranchName } from "../src/safety/branchPolicy.js";
import { redactSecrets, redactDeep } from "../src/safety/redaction.js";
import { defaultSafetyPolicy } from "../src/safety/policySchema.js";
import { forbiddenActions } from "../src/safety/forbiddenActions.js";

const policy = defaultSafetyPolicy();

describe("git command classifier", () => {
  it("denies force push (--force)", () => {
    const d = classifyGitCommand("git push --force origin feature", policy.git);
    expect(d.outcome).toBe("denied");
    expect(d.reason).toMatch(/force push/i);
  });

  it("denies force push short flag (-f)", () => {
    expect(classifyGitCommand("git push -f", policy.git).outcome).toBe("denied");
  });

  it("denies force push via +refspec", () => {
    expect(classifyGitCommand("git push origin +main:main", policy.git).outcome).toBe("denied");
  });

  it("denies push to a protected branch", () => {
    const d = classifyGitCommand("git push origin main", policy.git);
    expect(d.outcome).toBe("denied");
    expect(d.reason).toMatch(/protected branch/i);
  });

  it("denies push to release/* protected branch", () => {
    expect(classifyGitCommand("git push origin release/1.2", policy.git).outcome).toBe("denied");
  });

  it("allows push to a prefixed feature branch", () => {
    expect(classifyGitCommand("git push origin dispatch/ticket-1", policy.git).outcome).toBe(
      "allowed",
    );
  });

  it("denies branch deletion", () => {
    expect(classifyGitCommand("git branch -D old", policy.git).outcome).toBe("denied");
  });

  it("approval-gates hard reset", () => {
    expect(classifyGitCommand("git reset --hard origin/main", policy.git).outcome).toBe(
      "needs_approval",
    );
  });
});

describe("command classifier", () => {
  const ctx = { commands: policy.commands, git: policy.git };

  it("denies rm -rf .git", () => {
    expect(classifyCommand("rm -rf .git", ctx).outcome).toBe("denied");
  });

  it("requires approval for pnpm install", () => {
    const d = classifyCommand("pnpm install", ctx);
    expect(d.outcome).toBe("needs_approval");
    expect(d.approvalScope).toBe("command:pnpm install");
  });

  it("requires approval for pip install requests", () => {
    expect(classifyCommand("pip install requests", ctx).outcome).toBe("needs_approval");
  });

  it("allows plain test commands", () => {
    expect(classifyCommand("pytest -q", ctx).outcome).toBe("allowed");
  });

  it("honours repo-level allow list", () => {
    const d = classifyCommand("npm run special", { ...ctx, repoAllow: ["npm run special"] });
    expect(d.outcome).toBe("allowed");
    expect(d.rule).toBe("command.allow");
  });
});

describe("filesystem write guard", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "fg-fs-"));
  const ctx = { repoRoot, policy: policy.filesystem };

  it("denies writing to .env", () => {
    const d = checkFileWrite(".env", ctx);
    expect(d.outcome).toBe("denied");
    expect(d.rule).toBe("fs.denied_path");
  });

  it("denies writing to a nested secrets dir", () => {
    expect(checkFileWrite("config/secrets/db.txt", ctx).outcome).toBe("denied");
  });

  it("denies writing inside .git", () => {
    expect(checkFileWrite(".git/config", ctx).outcome).toBe("denied");
  });

  it("denies writing outside the repo root", () => {
    const d = checkFileWrite("../../etc/passwd", ctx);
    expect(d.outcome).toBe("denied");
    expect(d.rule).toBe("fs.outside_root");
  });

  it("denies an absolute path outside the root", () => {
    expect(checkFileWrite("/etc/hosts", ctx).outcome).toBe("denied");
  });

  it("requires approval for package.json", () => {
    const d = checkFileWrite("package.json", ctx);
    expect(d.outcome).toBe("needs_approval");
  });

  it("requires approval for a migration file", () => {
    expect(checkFileWrite("migrations/001_init.sql", ctx).outcome).toBe("needs_approval");
  });

  it("allows a normal source file", () => {
    expect(checkFileWrite("src/index.ts", ctx).outcome).toBe("allowed");
  });
});

describe("branch policy", () => {
  it("denies a protected branch name", () => {
    expect(checkBranchPolicy("main", policy.git).outcome).toBe("denied");
  });

  it("denies a branch missing the required prefix", () => {
    expect(checkBranchPolicy("feature/x", policy.git).outcome).toBe("denied");
  });

  it("allows a prefixed branch", () => {
    expect(checkBranchPolicy("dispatch/ticket-1-x", policy.git).outcome).toBe("allowed");
  });

  it("builds a prefixed branch name from a slug", () => {
    expect(buildBranchName("Ticket 12: Add Reset!", policy.git)).toBe(
      "dispatch/ticket-12-add-reset",
    );
  });
});

describe("secret redaction", () => {
  it("redacts an AWS access key", () => {
    const { text, redactedCount } = redactSecrets("key=AKIAIOSFODNN7EXAMPLE here");
    expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(text).toContain("[REDACTED]");
    expect(redactedCount).toBeGreaterThan(0);
  });

  it("redacts a github token", () => {
    expect(redactSecrets("ghp_abcdefghijklmnopqrstuvwxyz0123456789").text).toContain("[REDACTED]");
  });

  it("masks assigned secret values but keeps the key", () => {
    const { text } = redactSecrets("DB_PASSWORD=superSecret123");
    expect(text).toContain("DB_PASSWORD=");
    expect(text).not.toContain("superSecret123");
  });

  it("redacts a connection string", () => {
    const { text } = redactSecrets("postgres://user:pass@db.internal:5432/app");
    expect(text).not.toContain("user:pass@");
  });

  it("redacts deeply through objects and arrays", () => {
    const out = redactDeep({ a: ["ghp_abcdefghijklmnopqrstuvwxyz0123456789"], b: { token: "x" } });
    expect(JSON.stringify(out)).not.toContain("ghp_abcdefghij");
  });

  it("leaves ordinary text untouched", () => {
    expect(redactSecrets("hello world").redactedCount).toBe(0);
  });
});

describe("forbidden actions", () => {
  it("lists protected-branch push and secret writes", () => {
    const actions = forbiddenActions(policy);
    expect(actions.some((a) => /protected branches/i.test(a))).toBe(true);
    expect(actions.some((a) => /outside the repository root/i.test(a))).toBe(true);
    expect(actions.some((a) => /Force-push/i.test(a))).toBe(true);
  });
});
