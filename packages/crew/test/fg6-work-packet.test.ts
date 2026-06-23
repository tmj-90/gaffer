import { describe, expect, it } from "vitest";

import { buildContextPacket } from "../src/context/packet.js";
import { defaultSafetyPolicy } from "../src/safety/policySchema.js";
import { FakeDispatchClient } from "../src/dispatch/fakeClient.js";
import { RealDispatchClient } from "../src/dispatch/realClient.js";
import { NullMemoryClient, StubMemoryClient } from "../src/memory/client.js";
import { testConfig, testRepoRegistry } from "./helpers.js";
import { crewConfigSchema, type CrewConfig } from "../src/index.js";

/**
 * A two-repo factory config: an `api` write repo and a `web-app` read-only
 * context repo, each with distinct lore_tags so lore selection by repo can be
 * asserted to include the right records and exclude unrelated ones. Built
 * through the schema so repo defaults are applied (not a post-parse spread).
 */
function multiRepoConfig(): CrewConfig {
  return crewConfigSchema.parse({
    factory: { name: "test-factory", mode: "local_strict" },
    repos: [
      {
        id: "api",
        name: "api",
        path: "/tmp/test-api",
        stack: "typescript",
        test_command: "pnpm test",
        lore_tags: ["billing", "backend"],
      },
      {
        id: "web-app",
        name: "web-app",
        path: "/tmp/test-web-app",
        stack: "typescript-react",
        test_command: "pnpm test",
        lore_tags: ["frontend"],
      },
    ],
  });
}

function seedMappedTicket(wg: FakeDispatchClient) {
  const ticket = wg.seedTicket({
    title: "Wire billing into checkout",
    description: "Cross-repo change.",
    acceptanceCriteria: [{ text: "Checkout charges the customer" }],
    repositories: [{ name: "api", localPath: "/tmp/test-api", testCommand: "pnpm test" }],
  });
  wg.seedWorkPacket(ticket.id, {
    primaryScope: {
      id: "S-billing",
      name: "Billing",
      type: "product_area",
      loreTags: ["billing-policy"],
    },
    secondaryScopes: [
      { id: "S-checkout", name: "Checkout", type: "feature", loreTags: ["checkout-policy"] },
    ],
    writeRepos: [
      { id: "R-api", name: "api", path: "/tmp/test-api", reason: "Primary billing service." },
    ],
    readOnlyRepos: [
      { id: "R-web", name: "web-app", path: "/tmp/test-web-app", reason: "Reads the billing API." },
    ],
    testRepos: [
      { id: "R-api", name: "api", path: "/tmp/test-api", reason: "Hosts billing tests." },
    ],
  });
  return ticket;
}

describe("FakeDispatchClient.getWorkPacket", () => {
  it("returns the seeded scopes and partitioned repos", () => {
    const wg = new FakeDispatchClient();
    const ticket = seedMappedTicket(wg);
    const work = wg.getWorkPacket(ticket.id);

    expect(work.scopes.primary?.name).toBe("Billing");
    expect(work.scopes.primary?.loreTags).toEqual(["billing-policy"]);
    expect(work.scopes.secondary.map((s) => s.name)).toEqual(["Checkout"]);
    expect(work.writeRepos.map((r) => r.name)).toEqual(["api"]);
    expect(work.readOnlyRepos.map((r) => r.name)).toEqual(["web-app"]);
    expect(work.testRepos.map((r) => r.name)).toEqual(["api"]);
    expect(work.writeRepos[0]!.reason).toBe("Primary billing service.");
  });

  it("falls back to a single-repo write packet when no packet is seeded", () => {
    const wg = new FakeDispatchClient();
    const ticket = wg.seedTicket({
      title: "Mono ticket",
      repositories: [{ name: "web-app", localPath: "/tmp/test-web-app" }],
    });
    const work = wg.getWorkPacket(ticket.id);

    expect(work.scopes.primary).toBeUndefined();
    expect(work.scopes.secondary).toEqual([]);
    expect(work.writeRepos.map((r) => r.name)).toEqual(["web-app"]);
    expect(work.readOnlyRepos).toEqual([]);
    expect(work.writeRepos[0]!.reason).toMatch(/single-repo fallback/);
  });
});

describe("RealDispatchClient.getWorkPacket", () => {
  it("maps facade scopes + workPacketRepos into a work packet (with reasons)", () => {
    const client = RealDispatchClient.fromFacade({
      view: () => ({
        ticket: { id: "T1" },
        acceptanceCriteria: [],
        repositories: [{ id: "R-api", name: "api", local_path: "/repos/api" }],
        scopes: [
          {
            id: "S1",
            name: "Billing",
            type: "product_area",
            relation: "primary",
            lore_tags_json: '["billing"]',
          },
          {
            id: "S2",
            name: "Checkout",
            type: "feature",
            relation: "secondary",
            lore_tags_json: '["checkout"]',
          },
        ],
      }),
      workPacketRepos: () => ({
        writeRepos: [
          {
            id: "R-api",
            name: "api",
            local_path: "/repos/api",
            reasons_json: '[{"reason":"write here"}]',
          },
        ],
        readOnlyRepos: [
          { id: "R-web", name: "web-app", local_path: "/repos/web", reasons_json: '["context"]' },
        ],
        testRepos: [],
      }),
    });

    const work = client.getWorkPacket("T1");
    expect(work.scopes.primary?.name).toBe("Billing");
    expect(work.scopes.primary?.loreTags).toEqual(["billing"]);
    expect(work.scopes.secondary.map((s) => s.name)).toEqual(["Checkout"]);
    expect(work.writeRepos).toEqual([
      { id: "R-api", name: "api", path: "/repos/api", reason: "write here" },
    ]);
    expect(work.readOnlyRepos[0]!.reason).toBe("context");
  });

  it("falls back to the ticket's repos as write targets when no graph exists", () => {
    const client = RealDispatchClient.fromFacade({
      view: () => ({
        ticket: { id: "T1" },
        acceptanceCriteria: [],
        repositories: [{ id: "R-solo", name: "solo", local_path: "/repos/solo" }],
        scopes: [],
      }),
      workPacketRepos: () => ({ writeRepos: [], readOnlyRepos: [], testRepos: [] }),
    });

    const work = client.getWorkPacket("T1");
    expect(work.scopes.primary).toBeUndefined();
    expect(work.writeRepos.map((r) => r.name)).toEqual(["solo"]);
    expect(work.writeRepos[0]!.reason).toMatch(/single-repo fallback/);
  });

  it("promotes an implicit_repo scope to primary (mono-fallback scope)", () => {
    const client = RealDispatchClient.fromFacade({
      view: () => ({
        ticket: { id: "T1" },
        acceptanceCriteria: [],
        repositories: [{ id: "R-solo", name: "solo", local_path: "/repos/solo" }],
        scopes: [
          {
            id: "S-imp",
            name: "solo",
            type: "repo",
            relation: "implicit_repo",
            lore_tags_json: null,
          },
        ],
      }),
      workPacketRepos: () => ({
        writeRepos: [{ id: "R-solo", name: "solo", local_path: "/repos/solo", reasons_json: null }],
        readOnlyRepos: [],
        testRepos: [],
      }),
    });
    const work = client.getWorkPacket("T1");
    expect(work.scopes.primary?.name).toBe("solo");
  });
});

describe("context packet — scope-aware work boundary (FG-006)", () => {
  it("separates write from read-only repos with reasons + write guidance", () => {
    const config = multiRepoConfig();
    const wg = new FakeDispatchClient();
    const ticket = seedMappedTicket(wg);

    const packet = buildContextPacket(ticket.id, {
      config,
      policy: defaultSafetyPolicy(),
      repoRegistry: testRepoRegistry(config),
      dispatch: wg,
      memory: new NullMemoryClient(),
    });

    const ws = packet.workScope;
    expect(ws.monoFallback).toBe(false);
    expect(ws.writeRepos.map((r) => r.name)).toEqual(["api"]);
    expect(ws.readOnlyRepos.map((r) => r.name)).toEqual(["web-app"]);
    // Reasons are present on both sides.
    expect(ws.writeRepos[0]!.reason).toBe("Primary billing service.");
    expect(ws.readOnlyRepos[0]!.reason).toBe("Reads the billing API.");
    // Paths resolve from configured repos.
    expect(ws.writeRepos[0]!.path).toContain("test-api");
    // Explicit WRITE / READ-ONLY guidance for the agent.
    expect(ws.guidance.some((g) => /You may WRITE to: api/.test(g))).toBe(true);
    expect(ws.guidance.some((g) => /READ-ONLY context: web-app/.test(g))).toBe(true);
  });

  it("includes primary + secondary scope nodes (name/type)", () => {
    const config = multiRepoConfig();
    const wg = new FakeDispatchClient();
    const ticket = seedMappedTicket(wg);

    const packet = buildContextPacket(ticket.id, {
      config,
      policy: defaultSafetyPolicy(),
      repoRegistry: testRepoRegistry(config),
      dispatch: wg,
      memory: new NullMemoryClient(),
    });

    expect(packet.workScope.primary).toEqual({
      id: "S-billing",
      name: "Billing",
      type: "product_area",
    });
    expect(packet.workScope.secondary).toEqual([
      { id: "S-checkout", name: "Checkout", type: "feature" },
    ]);
  });

  it("selects lore by repo AND scope tags, each with a reason, excluding unrelated", () => {
    const config = multiRepoConfig();
    const wg = new FakeDispatchClient();
    const ticket = seedMappedTicket(wg);
    const lore = new StubMemoryClient([
      {
        id: "L-repo-api",
        title: "API rule",
        summary: "x",
        tags: ["billing"],
        recordType: "convention",
      },
      {
        id: "L-repo-web",
        title: "Web rule",
        summary: "x",
        tags: ["frontend"],
        recordType: "convention",
      },
      {
        id: "L-scope-billing",
        title: "Billing policy",
        summary: "x",
        tags: ["billing-policy"],
        recordType: "policy",
      },
      {
        id: "L-scope-checkout",
        title: "Checkout policy",
        summary: "x",
        tags: ["checkout-policy"],
        recordType: "policy",
      },
      {
        id: "L-unrelated",
        title: "Payments infra",
        summary: "x",
        tags: ["payments-infra"],
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

    const byId = new Map(packet.scopedLore.map((r) => [r.id, r]));
    // Included by write repo (api → billing) and read-only repo (web-app → frontend).
    expect(byId.get("L-repo-api")?.reason).toMatch(/write repo 'api'/);
    expect(byId.get("L-repo-web")?.reason).toMatch(/read-only repo 'web-app'/);
    // Included by primary + secondary scope lore_tags.
    expect(byId.get("L-scope-billing")?.reason).toMatch(/primary scope 'Billing'/);
    expect(byId.get("L-scope-checkout")?.reason).toMatch(/secondary scope 'Checkout'/);
    // Unrelated lore is excluded.
    expect(byId.has("L-unrelated")).toBe(false);
  });

  it("excludes unrelated repo paths — only write+read repos appear in the work scope", () => {
    const config = multiRepoConfig();
    const wg = new FakeDispatchClient();
    const ticket = seedMappedTicket(wg);

    const packet = buildContextPacket(ticket.id, {
      config,
      policy: defaultSafetyPolicy(),
      repoRegistry: testRepoRegistry(config),
      dispatch: wg,
      memory: new NullMemoryClient(),
    });

    const names = [...packet.workScope.writeRepos, ...packet.workScope.readOnlyRepos].map(
      (r) => r.name,
    );
    expect(new Set(names)).toEqual(new Set(["api", "web-app"]));
  });

  it("mono-fallback: single unmapped repo still builds a working single-repo packet", () => {
    const config = testConfig();
    const wg = new FakeDispatchClient();
    // No seedWorkPacket → mono-fallback path.
    const ticket = wg.seedTicket({
      title: "Single-repo work",
      acceptanceCriteria: [{ text: "It works" }],
      repositories: [{ name: "web-app", localPath: "/tmp/test-web-app", testCommand: "pnpm test" }],
    });

    const packet = buildContextPacket(ticket.id, {
      config,
      policy: defaultSafetyPolicy(),
      repoRegistry: testRepoRegistry(config),
      dispatch: wg,
      memory: new NullMemoryClient(),
    });

    expect(packet.workScope.monoFallback).toBe(true);
    expect(packet.workScope.primary).toBeNull();
    expect(packet.workScope.secondary).toEqual([]);
    expect(packet.workScope.writeRepos.map((r) => r.name)).toEqual(["web-app"]);
    expect(packet.workScope.writeRepos[0]!.path).toContain("test-web-app");
    expect(packet.workScope.readOnlyRepos).toEqual([]);
    // The packet still carries ticket/AC/repos so single-repo execution proceeds.
    expect(packet.repositories.map((r) => r.name)).toEqual(["web-app"]);
    expect(packet.workScope.guidance.some((g) => /single-repo/.test(g))).toBe(true);
  });
});
