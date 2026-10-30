/**
 * crew's safety surfaces say which verdict is ENFORCED.
 *
 * Regression: `crew safety check`, explain_safety_policy and the check_* MCP
 * tools explained safety_policy.yaml as if it were the boundary, but the live
 * PreToolUse hook (runner/safety-hook.mjs) never reads that file. So a raw
 * `sqlite3 dispatch.sqlite 'delete …'` was reported "allowed" while the hook
 * blocks it, a policy `needs_approval` (docker compose down -v) was not gated at
 * runtime, and the runner's own gaffer/ticket-N-slug branches were reported
 * "denied" under the old `dispatch/` default prefix.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

import { initFactory } from "../src/config/init.js";
import { FakeDispatchClient } from "../src/dispatch/fakeClient.js";
import { makeHandlers } from "../src/mcp/tools.js";
import { runDoctor } from "../src/ops/doctor.js";
import { loadFactory } from "../src/runtime/wiring.js";
import { checkBranchPolicy } from "../src/safety/branchPolicy.js";
import { classifyCommand } from "../src/safety/commandGuard.js";
import { checkWithLiveHook, compareVerdicts } from "../src/safety/liveHook.js";
import { defaultSafetyPolicy } from "../src/safety/policySchema.js";

const RAW_DB_WRITE = `sqlite3 dispatch.sqlite 'delete from tickets'`;
const policy = defaultSafetyPolicy();

describe("branch policy defaults match the runner's branches", () => {
  it("a real gaffer/ticket-N-slug branch is allowed under the default policy", () => {
    expect(checkBranchPolicy("gaffer/ticket-12-add-login", policy.git).outcome).toBe("allowed");
  });
});

describe("checkWithLiveHook asks runner/safety-hook.mjs", () => {
  it("reports the hook BLOCKING a raw DB write the advisory policy allows", () => {
    const advisory = classifyCommand(RAW_DB_WRITE, { commands: policy.commands, git: policy.git });
    expect(advisory.outcome).toBe("allowed");
    const enforced = checkWithLiveHook({ tool: "Bash", command: RAW_DB_WRITE });
    expect(enforced.available).toBe(true);
    expect(enforced.blocked).toBe(true);
    expect(enforced.reason).toBeTruthy();
    expect(compareVerdicts(advisory, enforced)).toMatch(/live safety hook BLOCKS/);
  });

  it("reports an advisory needs_approval the hook does not gate", () => {
    // (Not `terraform apply`: the hook refuses that one now, as a credential-using CLI
    // against real state.)
    const advisory = classifyCommand("docker compose down -v", {
      commands: policy.commands,
      git: policy.git,
    });
    expect(advisory.outcome).toBe("needs_approval");
    const enforced = checkWithLiveHook({ tool: "Bash", command: "docker compose down -v" });
    expect(enforced.blocked).toBe(false);
    expect(compareVerdicts(advisory, enforced)).toMatch(/nothing gates this at runtime/);
  });

  it("agreement yields no mismatch (git push --force: denied and blocked)", () => {
    const advisory = classifyCommand("git push --force", {
      commands: policy.commands,
      git: policy.git,
    });
    const enforced = checkWithLiveHook({ tool: "Bash", command: "git push --force" });
    expect(enforced.blocked).toBe(true);
    expect(compareVerdicts(advisory, enforced)).toBeNull();
  });

  it("real secrets stay blocked on the path check (.env, .env.local, keys)", () => {
    const root = mkdtempSync(join(tmpdir(), "gaffer-live-hook-root-"));
    try {
      for (const p of [".env", ".env.local", "id_rsa", "certs/server.key"]) {
        const v = checkWithLiveHook(
          { tool: "Write", filePath: join(root, p), writeRoots: [root] },
          { cwd: root },
        );
        expect(v.blocked, p).toBe(true);
      }
      const ok = checkWithLiveHook(
        { tool: "Write", filePath: join(root, "src/a.ts"), writeRoots: [root] },
        { cwd: root },
      );
      expect(ok.blocked).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never writes the factory's block ledger (GAFFER_DATA is stripped)", () => {
    const data = mkdtempSync(join(tmpdir(), "gaffer-live-hook-data-"));
    try {
      const v = checkWithLiveHook(
        { tool: "Bash", command: RAW_DB_WRITE },
        { env: { ...process.env, GAFFER_DATA: data } },
      );
      expect(v.blocked).toBe(true);
      expect(existsSync(join(data, "safety-blocks.jsonl"))).toBe(false);
      expect(existsSync(join(data, "tool-metrics.jsonl"))).toBe(false);
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });

  it("a missing hook is reported as unavailable, never as allowed", () => {
    const v = checkWithLiveHook(
      { tool: "Bash", command: "ls" },
      { env: { ...process.env, GAFFER_SAFETY_HOOK: "/nonexistent/safety-hook.mjs" } },
    );
    expect(v.available).toBe(false);
    expect(v.blocked).toBeNull();
    expect(compareVerdicts({ outcome: "allowed" }, v)).toBeNull();
  });
});

describe("MCP + doctor label the policy as advisory", () => {
  let tmp: string;
  let ctx: ReturnType<typeof loadFactory>;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "gaffer-live-hook-mcp-"));
    initFactory({ dir: tmp, factoryName: "advisory", force: true });
    ctx = loadFactory({ config: join(tmp, "crew.yaml") });
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("check_command_allowed returns the enforced verdict and the mismatch", async () => {
    const handlers = makeHandlers({ ctx, openDispatch: async () => new FakeDispatchClient() });
    const out = (await handlers.check_command_allowed({ command: RAW_DB_WRITE }))
      .structuredContent as {
      decision: { outcome: string };
      enforced: { blocked: boolean };
      mismatch?: string;
    };
    expect(out.decision.outcome).toBe("allowed");
    expect(out.enforced.blocked).toBe(true);
    expect(out.mismatch).toMatch(/BLOCKS/);
  });

  it("explain_safety_policy says the policy is advisory", async () => {
    const handlers = makeHandlers({ ctx, openDispatch: async () => new FakeDispatchClient() });
    const out = (await handlers.explain_safety_policy({})).structuredContent as {
      advisory: boolean;
      note: string;
      git: { requireBranchPrefix: string };
    };
    expect(out.advisory).toBe(true);
    expect(out.note).toContain("runner/safety-hook.mjs");
    expect(out.git.requireBranchPrefix).toBe("gaffer/");
  });

  it("doctor labels the policy check advisory and warns on a prefix the runner never uses", async () => {
    const fresh = await runDoctor({
      ctx,
      openDispatch: async () => new FakeDispatchClient(),
      env: {},
    });
    const check = fresh.checks.find((c) => c.label === "Safety policy (advisory) sane");
    expect(check?.level).toBe("ok");
    expect(check?.detail).toContain("does not read it");

    // An existing factory scaffolded with the old `dispatch/` prefix.
    const policyPath = join(tmp, "safety_policy.yaml");
    const pol = parse(readFileSync(policyPath, "utf8")) as { git: Record<string, unknown> };
    pol.git.require_branch_prefix = "dispatch/";
    writeFileSync(policyPath, stringify(pol));
    const old = loadFactory({ config: join(tmp, "crew.yaml") });
    const report = await runDoctor({
      ctx: old,
      openDispatch: async () => new FakeDispatchClient(),
      env: {},
    });
    const warn = report.checks.find((c) => c.label === "Safety policy (advisory) sane");
    expect(warn?.level).toBe("warn");
    expect(warn?.detail).toContain("'dispatch/'");
  });
});
