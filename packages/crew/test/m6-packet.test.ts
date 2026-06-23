import { describe, expect, it } from "vitest";

import { buildContextPacket, assertPacketSecretFree } from "../src/context/packet.js";
import { defaultSafetyPolicy } from "../src/safety/policySchema.js";
import { FakeDispatchClient } from "../src/dispatch/fakeClient.js";
import { NullMemoryClient, StubMemoryClient } from "../src/memory/client.js";
import { SkillRegistry } from "../src/skills/registry.js";
import { skillSchema } from "../src/skills/schema.js";
import { testConfig, testRepoRegistry } from "./helpers.js";

function skillRegistryWith(
  defs: ReadonlyArray<{ id: string; stacks?: string[]; capabilities?: string[] }>,
): SkillRegistry {
  return new SkillRegistry(
    defs.map((d) =>
      skillSchema.parse({
        id: d.id,
        name: d.id,
        applies_to: { stacks: d.stacks ?? [], capabilities: d.capabilities ?? [] },
        steps: ["do the thing"],
      }),
    ),
  );
}

function seedClaimedTicket(wg: FakeDispatchClient) {
  return wg.seedTicket({
    title: "Add password reset",
    description: "Implement reset flow.",
    riskLevel: "medium",
    acceptanceCriteria: [{ text: "Reset email is sent" }, { text: "Token expires after 1 hour" }],
    repositories: [{ name: "web-app", localPath: "/tmp/test-web-app", testCommand: "pnpm test" }],
  });
}

describe("context packet", () => {
  it("includes ticket, AC, repo paths/commands and branch policy", () => {
    const config = testConfig();
    const wg = new FakeDispatchClient();
    const ticket = seedClaimedTicket(wg);

    const packet = buildContextPacket(ticket.id, {
      config,
      policy: defaultSafetyPolicy(),
      repoRegistry: testRepoRegistry(config),
      dispatch: wg,
      memory: new NullMemoryClient(),
    });

    expect(packet.ticket.title).toBe("Add password reset");
    expect(packet.acceptanceCriteria).toHaveLength(2);
    const repo = packet.repositories[0]!;
    expect(repo.path).toContain("test-web-app");
    expect(repo.testCommand).toBe("pnpm test");
    expect(repo.branchPolicy.requiredPrefix).toBe("dispatch/");
    expect(repo.branchPolicy.suggestedBranch.startsWith("dispatch/")).toBe(true);
    expect(repo.branchPolicy.suggestedBranchAllowed).toBe(true);
    expect(packet.verification.testCommands).toContain("pnpm test");
  });

  it("includes the forbidden-actions list", () => {
    const config = testConfig();
    const wg = new FakeDispatchClient();
    const ticket = seedClaimedTicket(wg);
    const packet = buildContextPacket(ticket.id, {
      config,
      policy: defaultSafetyPolicy(),
      repoRegistry: testRepoRegistry(config),
      dispatch: wg,
      memory: new NullMemoryClient(),
    });
    expect(packet.forbiddenActions.some((a) => /protected branches/i.test(a))).toBe(true);
    expect(packet.forbiddenActions.some((a) => /outside the repository root/i.test(a))).toBe(true);
  });

  it("includes relevant lore when a stub provides some", () => {
    const config = testConfig();
    const wg = new FakeDispatchClient();
    const ticket = seedClaimedTicket(wg);
    const lore = new StubMemoryClient([
      {
        id: "L1",
        title: "Auth convention",
        summary: "Use argon2id",
        tags: ["auth"],
        recordType: "convention",
      },
      {
        id: "L2",
        title: "Frontend rule",
        summary: "Hooks only",
        tags: ["react"],
        recordType: "convention",
      },
      { id: "L3", title: "Irrelevant", summary: "x", tags: ["payments"], recordType: "convention" },
    ]);
    const packet = buildContextPacket(ticket.id, {
      config,
      policy: defaultSafetyPolicy(),
      repoRegistry: testRepoRegistry(config),
      dispatch: wg,
      memory: lore,
    });
    const ids = packet.relevantLore.map((r) => r.id);
    expect(ids).toContain("L1");
    expect(ids).toContain("L2");
    expect(ids).not.toContain("L3");
  });

  it("never includes secrets in the packet", () => {
    const config = testConfig();
    const wg = new FakeDispatchClient();
    const ticket = wg.seedTicket({
      title: "Hook up API ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      description: "Use AWS key AKIAIOSFODNN7EXAMPLE and DB_PASSWORD=hunter2secret",
      acceptanceCriteria: [{ text: "token AKIAIOSFODNN7EXAMPLE removed" }],
      repositories: [{ name: "web-app", localPath: "/tmp/test-web-app" }],
    });
    const lore = new StubMemoryClient([
      {
        id: "L1",
        title: "x",
        summary: "secret ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        tags: ["auth"],
        recordType: "note",
      },
    ]);
    const packet = buildContextPacket(ticket.id, {
      config,
      policy: defaultSafetyPolicy(),
      repoRegistry: testRepoRegistry(config),
      dispatch: wg,
      memory: lore,
    });
    const json = JSON.stringify(packet);
    expect(json).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(json).not.toContain("ghp_abcdefghij");
    expect(json).not.toContain("hunter2secret");
    expect(() => assertPacketSecretFree(packet)).not.toThrow();
  });

  it("derives the ticket's stacks from its repos (compound stack expanded)", () => {
    const config = testConfig();
    const wg = new FakeDispatchClient();
    const ticket = seedClaimedTicket(wg);
    const packet = buildContextPacket(ticket.id, {
      config,
      policy: defaultSafetyPolicy(),
      repoRegistry: testRepoRegistry(config),
      dispatch: wg,
      memory: new NullMemoryClient(),
    });
    // Repo stack is "typescript-react" → whole + parts.
    expect(packet.stacks).toEqual(
      expect.arrayContaining(["typescript-react", "typescript", "react"]),
    );
    expect(packet.repositories[0]!.stack).toBe("typescript-react");
  });

  it("pre-filters skills to the ticket's stack (agnostic + matching only)", () => {
    const config = testConfig();
    const wg = new FakeDispatchClient();
    const ticket = seedClaimedTicket(wg);
    const skillRegistry = skillRegistryWith([
      { id: "agnostic-skill" }, // stacks: [] → always applies
      { id: "react-skill", stacks: ["react"] }, // matches
      { id: "python-skill", stacks: ["python"] }, // does not match
    ]);
    const packet = buildContextPacket(ticket.id, {
      config,
      policy: defaultSafetyPolicy(),
      repoRegistry: testRepoRegistry(config),
      dispatch: wg,
      memory: new NullMemoryClient(),
      skillRegistry,
    });
    const ids = packet.skills.map((s) => s.id);
    expect(ids).toContain("agnostic-skill");
    expect(ids).toContain("react-skill");
    expect(ids).not.toContain("python-skill");
  });

  it("carries no skills when no skill registry is wired", () => {
    const config = testConfig();
    const wg = new FakeDispatchClient();
    const ticket = seedClaimedTicket(wg);
    const packet = buildContextPacket(ticket.id, {
      config,
      policy: defaultSafetyPolicy(),
      repoRegistry: testRepoRegistry(config),
      dispatch: wg,
      memory: new NullMemoryClient(),
    });
    expect(packet.skills).toEqual([]);
  });

  it("caps skills to config.context.max_skills (stable selection)", () => {
    const base = testConfig();
    const config = testConfig({ context: { ...base.context, max_skills: 2 } });
    const wg = new FakeDispatchClient();
    const ticket = seedClaimedTicket(wg);
    const skillRegistry = skillRegistryWith([
      { id: "c-skill" },
      { id: "a-skill" },
      { id: "b-skill" },
      { id: "d-skill" },
    ]);
    const packet = buildContextPacket(ticket.id, {
      config,
      policy: defaultSafetyPolicy(),
      repoRegistry: testRepoRegistry(config),
      dispatch: wg,
      memory: new NullMemoryClient(),
      skillRegistry,
    });
    // Sorted by id, capped to 2 → a-skill, b-skill.
    expect(packet.skills.map((s) => s.id)).toEqual(["a-skill", "b-skill"]);
  });

  it("caps lore results to config.context.lore_limit", () => {
    const base = testConfig();
    const config = testConfig({ context: { ...base.context, lore_limit: 2 } });
    const wg = new FakeDispatchClient();
    const ticket = seedClaimedTicket(wg);
    const lore = new StubMemoryClient([
      { id: "L1", title: "a", summary: "a", tags: ["frontend"], recordType: "note" },
      { id: "L2", title: "b", summary: "b", tags: ["react"], recordType: "note" },
      { id: "L3", title: "c", summary: "c", tags: ["auth"], recordType: "note" },
      { id: "L4", title: "d", summary: "d", tags: ["typescript"], recordType: "note" },
    ]);
    const packet = buildContextPacket(ticket.id, {
      config,
      policy: defaultSafetyPolicy(),
      repoRegistry: testRepoRegistry(config),
      dispatch: wg,
      memory: lore,
    });
    expect(packet.relevantLore.length).toBeLessThanOrEqual(2);
  });

  it("returns no lore when memory is disabled in config", () => {
    const config = testConfig({ memory: { ...testConfig().memory, enabled: false } });
    const wg = new FakeDispatchClient();
    const ticket = seedClaimedTicket(wg);
    const lore = new StubMemoryClient([
      { id: "L1", title: "x", summary: "y", tags: ["auth"], recordType: "note" },
    ]);
    const packet = buildContextPacket(ticket.id, {
      config,
      policy: defaultSafetyPolicy(),
      repoRegistry: testRepoRegistry(config),
      dispatch: wg,
      memory: lore,
    });
    expect(packet.relevantLore).toHaveLength(0);
  });
});
