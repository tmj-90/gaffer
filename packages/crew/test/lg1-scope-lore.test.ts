/**
 * Lore-by-scope bridge (LG-001), built on FG-006's lore-by-scope prefetch.
 *
 * Asserts that scoped-lore selection:
 *   - queries by confirmed repos AND selected scope nodes' lore_tags (FG-006);
 *   - adds PARENT-scope lore at lower priority;
 *   - adds EDGE lore when work touches a related node via a scope_edge;
 *   - annotates every record with a clear "why included" reason;
 *   - falls back to repo-only lore in mono-fallback;
 *   - is implemented entirely in Crew (suggest-only; agents never ratify).
 */
import { describe, expect, it } from "vitest";

import { buildContextPacket } from "../src/context/packet.js";
import { buildScopeGraphView, selectScopedLore, LORE_PRIORITY } from "../src/memory/scopeLore.js";
import { defaultSafetyPolicy } from "../src/safety/policySchema.js";
import { StubMemoryClient, NullMemoryClient } from "../src/memory/client.js";
import { FakeDispatchClient } from "../src/dispatch/fakeClient.js";
import { crewConfigSchema, RepoRegistry, type CrewConfig } from "../src/index.js";
import type { WorkPacket } from "../src/dispatch/client.js";

function config(): CrewConfig {
  return crewConfigSchema.parse({
    factory: { name: "f", mode: "local_strict" },
    repos: [
      { id: "api", name: "api", path: "/tmp/api", stack: "typescript", lore_tags: ["billing"] },
    ],
  });
}

function registry(): RepoRegistry {
  return RepoRegistry.fromConfig(config(), "/tmp");
}

const allLore = () =>
  new StubMemoryClient([
    { id: "L-api", title: "API rule", summary: "x", tags: ["billing"], recordType: "convention" },
    {
      id: "L-primary",
      title: "Billing policy",
      summary: "x",
      tags: ["billing-policy"],
      recordType: "policy",
    },
    {
      id: "L-secondary",
      title: "Checkout policy",
      summary: "x",
      tags: ["checkout-policy"],
      recordType: "policy",
    },
    {
      id: "L-parent",
      title: "Payments domain rule",
      summary: "x",
      tags: ["payments-domain"],
      recordType: "policy",
    },
    {
      id: "L-edge",
      title: "Ledger contract",
      summary: "x",
      tags: ["ledger"],
      recordType: "contract",
    },
    {
      id: "L-unrelated",
      title: "Marketing note",
      summary: "x",
      tags: ["marketing"],
      recordType: "note",
    },
  ]);

function mappedWork(): WorkPacket {
  return {
    scopes: {
      primary: {
        id: "S-billing",
        name: "Billing",
        type: "capability",
        loreTags: ["billing-policy"],
      },
      secondary: [
        { id: "S-checkout", name: "Checkout", type: "feature", loreTags: ["checkout-policy"] },
      ],
    },
    writeRepos: [{ id: "R-api", name: "api", path: "/tmp/api", reason: "write" }],
    readOnlyRepos: [],
    testRepos: [],
  };
}

// Scope graph: Payments (domain) CONTAINS Billing; Billing DEPENDS_ON Ledger.
function scopeGraph() {
  return buildScopeGraphView(
    [
      { id: "S-payments", name: "Payments", loreTags: ["payments-domain"] },
      { id: "S-billing", name: "Billing", loreTags: ["billing-policy"] },
      { id: "S-ledger", name: "Ledger", loreTags: ["ledger"] },
      { id: "S-checkout", name: "Checkout", loreTags: ["checkout-policy"] },
    ],
    [
      { from: "S-payments", to: "S-billing", relation: "contains" },
      { from: "S-billing", to: "S-ledger", relation: "depends_on" },
    ],
  );
}

describe("selectScopedLore — FG-006 base", () => {
  it("selects by repo + primary + secondary scope, each with a reason, excluding unrelated", () => {
    const records = selectScopedLore(mappedWork(), {
      memory: allLore(),
      repoRegistry: registry(),
      limit: 20,
      redactSummary: (s) => s,
    });
    const byId = new Map(records.map((r) => [r.id, r]));
    expect(byId.get("L-api")?.reason).toMatch(/write repo 'api'/);
    expect(byId.get("L-primary")?.reason).toMatch(/primary scope 'Billing'/);
    expect(byId.get("L-secondary")?.reason).toMatch(/secondary scope 'Checkout'/);
    expect(byId.has("L-unrelated")).toBe(false);
  });
});

describe("selectScopedLore — LG-001 parent + edge lore", () => {
  it("includes parent-scope lore at lower priority with a clear reason", () => {
    const records = selectScopedLore(mappedWork(), {
      memory: allLore(),
      repoRegistry: registry(),
      scopeGraph: scopeGraph(),
      limit: 20,
      redactSummary: (s) => s,
    });
    const parent = records.find((r) => r.id === "L-parent");
    expect(parent).toBeDefined();
    expect(parent!.priority).toBe(LORE_PRIORITY.parentScope);
    expect(parent!.reason).toMatch(/parent scope 'Payments' of 'Billing'/);
    // Lower priority than the primary scope lore.
    const primary = records.find((r) => r.id === "L-primary")!;
    expect(parent!.priority).toBeGreaterThan(primary.priority);
  });

  it("includes edge lore at the lowest priority with the relation in the reason", () => {
    const records = selectScopedLore(mappedWork(), {
      memory: allLore(),
      repoRegistry: registry(),
      scopeGraph: scopeGraph(),
      limit: 20,
      redactSummary: (s) => s,
    });
    const edge = records.find((r) => r.id === "L-edge");
    expect(edge).toBeDefined();
    expect(edge!.priority).toBe(LORE_PRIORITY.edgeScope);
    expect(edge!.reason).toMatch(/related scope 'Ledger' \(depends_on edge from 'Billing'/);
  });

  it("orders results by priority (write repo + primary first, edge last)", () => {
    const records = selectScopedLore(mappedWork(), {
      memory: allLore(),
      repoRegistry: registry(),
      scopeGraph: scopeGraph(),
      limit: 20,
      redactSummary: (s) => s,
    });
    const priorities = records.map((r) => r.priority);
    const sorted = [...priorities].sort((a, b) => a - b);
    expect(priorities).toEqual(sorted);
    expect(records[0]!.priority).toBe(LORE_PRIORITY.writeRepo);
    expect(records.at(-1)!.priority).toBe(LORE_PRIORITY.edgeScope);
  });

  it("respects the limit, dropping lowest-priority (edge) lore first", () => {
    // limit 3: write repo + primary + secondary fill it; parent/edge are dropped.
    const records = selectScopedLore(mappedWork(), {
      memory: allLore(),
      repoRegistry: registry(),
      scopeGraph: scopeGraph(),
      limit: 3,
      redactSummary: (s) => s,
    });
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.id)).not.toContain("L-edge");
    expect(records.map((r) => r.id)).not.toContain("L-parent");
  });
});

describe("selectScopedLore — mono-fallback", () => {
  it("queries lore by repo only when there is no scope mapping", () => {
    const monoWork: WorkPacket = {
      scopes: { secondary: [] },
      writeRepos: [{ id: "R-api", name: "api", path: "/tmp/api", reason: "fallback" }],
      readOnlyRepos: [],
      testRepos: [],
    };
    const records = selectScopedLore(monoWork, {
      memory: allLore(),
      repoRegistry: registry(),
      scopeGraph: scopeGraph(),
      limit: 20,
      redactSummary: (s) => s,
    });
    expect(records.map((r) => r.id)).toEqual(["L-api"]);
  });
});

describe("packet integration — scopeGraph wired through buildContextPacket", () => {
  it("surfaces parent + edge lore on the packet's scopedLore with reasons", () => {
    const wg = new FakeDispatchClient();
    const ticket = wg.seedTicket({
      title: "Billing change",
      repositories: [{ name: "api", localPath: "/tmp/api", testCommand: "pnpm test" }],
    });
    wg.seedWorkPacket(ticket.id, {
      primaryScope: {
        id: "S-billing",
        name: "Billing",
        type: "capability",
        loreTags: ["billing-policy"],
      },
      secondaryScopes: [
        { id: "S-checkout", name: "Checkout", type: "feature", loreTags: ["checkout-policy"] },
      ],
      writeRepos: [{ id: "R-api", name: "api", path: "/tmp/api", reason: "write" }],
    });

    const packet = buildContextPacket(ticket.id, {
      config: config(),
      policy: defaultSafetyPolicy(),
      repoRegistry: registry(),
      dispatch: wg,
      memory: allLore(),
      scopeGraph: scopeGraph(),
    });

    const byId = new Map(packet.scopedLore.map((r) => [r.id, r]));
    expect(byId.get("L-parent")?.reason).toMatch(/parent scope 'Payments'/);
    expect(byId.get("L-edge")?.reason).toMatch(/depends_on edge/);
    expect(byId.has("L-unrelated")).toBe(false);
  });

  it("works without a scopeGraph (FG-006 behaviour unchanged)", () => {
    const wg = new FakeDispatchClient();
    const ticket = wg.seedTicket({
      title: "Billing change",
      repositories: [{ name: "api", localPath: "/tmp/api" }],
    });
    const packet = buildContextPacket(ticket.id, {
      config: config(),
      policy: defaultSafetyPolicy(),
      repoRegistry: registry(),
      dispatch: wg,
      memory: new NullMemoryClient(),
    });
    // No scope graph, Null lore → empty scoped lore, no crash.
    expect(packet.scopedLore).toEqual([]);
  });
});
