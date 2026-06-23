import { describe, expect, it } from "vitest";
import { Dispatch } from "dispatch";

import { RealDispatchClient } from "../src/dispatch/realClient.js";
import { FakeDispatchClient } from "../src/dispatch/fakeClient.js";
import { CrewError } from "../src/util/errors.js";

describe("RealDispatchClient (parallel-build guard)", () => {
  it("surfaces a structured error when a facade method is missing", () => {
    // Facade exposes only `list` — every other method is absent (mid-build).
    const client = RealDispatchClient.fromFacade({ list: () => [] });
    expect(client.listReady()).toEqual([]);
    expect(() => client.claimNextTicket({ agentId: "a", ttlSeconds: 10 })).toThrowError(CrewError);
    try {
      client.heartbeat("tok");
    } catch (err) {
      expect((err as CrewError).code).toBe("DISPATCH_METHOD_UNAVAILABLE");
    }
  });

  it("maps a fully-featured facade onto the client interface", () => {
    const client = RealDispatchClient.fromFacade({
      list: () => [{ id: "T1", number: 1, title: "x", policy_pack: "p", risk_level: "low" }],
      claimNextTicket: () => ({ ticketId: "T1", number: 1, claimToken: "tok" }),
      registerAgent: () => ({ agentId: "A1" }),
    });
    expect(client.listReady()[0]!.ticketId).toBe("T1");
    expect(client.claimNextTicket({ agentId: "a", ttlSeconds: 1 })?.claimToken).toBe("tok");
    expect(client.registerAgent({ capabilities: [] }).agentId).toBe("A1");
  });

  it("opens the real dispatch package and round-trips through the field mapping", async () => {
    // Dispatch is now built (dist present); the adapter should load it and the
    // camelCase↔snake_case mapping should round-trip a real facade operation.
    const client = await RealDispatchClient.open(":memory:");
    const draft = client.createDraftTicket({ title: "From Crew", description: "idle draft" });
    expect(draft.number).toBeGreaterThan(0);
    const bundle = client.getTicket(draft.ticketId);
    expect(bundle.ticket.title).toBe("From Crew");
    expect(bundle.ticket.status).toBe("draft");
  });

  it("claimTicket maps to the facade and translates a not-claimable throw to null", () => {
    let received: Record<string, unknown> | undefined;
    const ok = RealDispatchClient.fromFacade({
      claimTicket: (input) => {
        received = input as Record<string, unknown>;
        return { ticketId: "T9", number: 9, claimToken: "tok-9" };
      },
    });
    const claim = ok.claimTicket({
      ticketId: "T9",
      agentId: "a",
      ttlSeconds: 30,
      capabilities: ["impl"],
    });
    expect(claim).toEqual({ ticketId: "T9", number: 9, claimToken: "tok-9" });
    // Crew camelCase is mapped onto Dispatch's snake_case raw input.
    expect(received).toMatchObject({ ticket_id: "T9", agent_id: "a", ttl_seconds: 30 });

    const throwing = RealDispatchClient.fromFacade({
      claimTicket: () => {
        throw new Error("TICKET_NOT_CLAIMABLE");
      },
    });
    expect(throwing.claimTicket({ ticketId: "T9", agentId: "a", ttlSeconds: 30 })).toBeNull();
  });

  it("recordDeliveryArtifact maps camelCase onto the facade snake_case input", () => {
    let received: Record<string, unknown> | undefined;
    const client = RealDispatchClient.fromFacade({
      recordDeliveryArtifact: (input) => {
        received = input as Record<string, unknown>;
        return { ticketId: "T1", branchName: "dispatch/ticket-1", prUrl: null, eventId: "ev-1" };
      },
    });
    const res = client.recordDeliveryArtifact({
      claimToken: "tok",
      ticketId: "T1",
      branchName: "dispatch/ticket-1",
    });
    expect(res).toEqual({
      ticketId: "T1",
      branchName: "dispatch/ticket-1",
      prUrl: null,
      eventId: "ev-1",
    });
    expect(received).toMatchObject({
      claim_token: "tok",
      ticket_id: "T1",
      branch_name: "dispatch/ticket-1",
    });
  });

  it("round-trips claimTicket + recordDeliveryArtifact against the real package", async () => {
    const client = await RealDispatchClient.open(":memory:");
    const draft = client.createDraftTicket({ title: "Deliver me", description: "x" });
    client.markTicketReady(draft.ticketId);
    const agent = client.registerAgent({ capabilities: ["impl"], maxRisk: "high" });

    const claim = client.claimTicket({
      ticketId: draft.ticketId,
      agentId: agent.agentId,
      ttlSeconds: 60,
    });
    expect(claim?.ticketId).toBe(draft.ticketId);

    const delivery = client.recordDeliveryArtifact({
      claimToken: claim!.claimToken,
      ticketId: draft.ticketId,
      branchName: "dispatch/ticket-deliver",
    });
    expect(delivery.branchName).toBe("dispatch/ticket-deliver");
    expect(client.getTicket(draft.ticketId).ticket.branchName).toBe("dispatch/ticket-deliver");
  });

  it("recordRepoDelivery maps camelCase onto the facade and unwraps the delivery row", () => {
    let received: Record<string, unknown> | undefined;
    const client = RealDispatchClient.fromFacade({
      recordRepoDelivery: (input) => {
        received = input as Record<string, unknown>;
        return {
          delivery: {
            ticket_id: "T1",
            repo_id: "R-api",
            branch_name: "dispatch/ticket-1",
            pr_url: null,
            status: "review_ready",
          },
          eventId: "ev-2",
        };
      },
    });
    const res = client.recordRepoDelivery({
      ticketId: "T1",
      repoId: "R-api",
      branchName: "dispatch/ticket-1",
      status: "review_ready",
    });
    expect(res).toEqual({
      ticketId: "T1",
      repoId: "R-api",
      branchName: "dispatch/ticket-1",
      prUrl: null,
      status: "review_ready",
      eventId: "ev-2",
    });
    expect(received).toMatchObject({
      ticket_id: "T1",
      repo_id: "R-api",
      branch_name: "dispatch/ticket-1",
      status: "review_ready",
    });
  });

  it("round-trips recordRepoDelivery against the real package", () => {
    // Register the repo first so the ticket↔repo link resolves, then drive the
    // real facade through the adapter (parity with the per-repo delivery loop).
    const wg = Dispatch.open(":memory:");
    const human = { type: "human", id: "tester" } as const;
    wg.registerRepository({ name: "api", default_branch: "main" }, human);
    const client = RealDispatchClient.fromFacade(
      wg as unknown as Parameters<typeof RealDispatchClient.fromFacade>[0],
    );

    const draft = client.createDraftTicket({
      title: "Per-repo deliver",
      description: "x",
      repoName: "api",
    });
    const repoId = client.getTicket(draft.ticketId).repositories[0]!.id;

    const res = client.recordRepoDelivery({
      ticketId: draft.ticketId,
      repoId,
      branchName: "dispatch/ticket-per-repo",
      status: "review_ready",
    });
    expect(res.repoId).toBe(repoId);
    expect(res.branchName).toBe("dispatch/ticket-per-repo");
    expect(res.status).toBe("review_ready");
    wg.db.close();
  });

  it("surfaces a structured error when recordRepoDelivery is absent from the facade", () => {
    const client = RealDispatchClient.fromFacade({ list: () => [] });
    expect(() => client.recordRepoDelivery({ ticketId: "T1", repoId: "R1" })).toThrowError(
      CrewError,
    );
  });

  it("registerRepo calls registerRepository and returns the repo id, forwarding stack/test_command", () => {
    let received: Record<string, unknown> | undefined;
    const linkCalls: Array<Record<string, unknown>> = [];
    const client = RealDispatchClient.fromFacade({
      registerRepository: (input) => {
        received = input as Record<string, unknown>;
        return { id: "R-real" };
      },
      linkScopeRepo: (input) => {
        linkCalls.push(input as Record<string, unknown>);
        return { id: "SR1" };
      },
    });

    const res = client.registerRepo({
      repoId: "ignored-local-id",
      name: "api",
      localPath: "/repos/api",
      remoteUrl: "git@github.com:acme/api.git",
      defaultBranch: "trunk",
      stack: "typescript-react",
      testCommand: "pnpm test",
    });

    // The Repository.id (not the local repoId) is the canonical repoId.
    expect(res).toEqual({ repoId: "R-real", attachedScopeIds: [] });
    // No scope ids → no link calls.
    expect(linkCalls).toHaveLength(0);
    // Mapped onto registerRepoInput: stack + test_command + default_branch threaded.
    expect(received).toMatchObject({
      name: "api",
      local_path: "/repos/api",
      remote_url: "git@github.com:acme/api.git",
      default_branch: "trunk",
      stack: "typescript-react",
      test_command: "pnpm test",
    });
    // No scope fields leak into registerRepoInput.
    expect(received).not.toHaveProperty("scope_node_ids");
  });

  it("registerRepo defaults default_branch to main and omits null remote/test", () => {
    let received: Record<string, unknown> | undefined;
    const client = RealDispatchClient.fromFacade({
      registerRepository: (input) => {
        received = input as Record<string, unknown>;
        return { id: "R2" };
      },
    });

    client.registerRepo({
      repoId: "x",
      name: "lib",
      localPath: "/repos/lib",
      remoteUrl: null,
      defaultBranch: null,
      stack: null,
      testCommand: null,
    });

    expect(received).toMatchObject({
      name: "lib",
      local_path: "/repos/lib",
      default_branch: "main",
    });
    expect(received).not.toHaveProperty("remote_url");
    expect(received).not.toHaveProperty("test_command");
    expect(received).not.toHaveProperty("stack");
  });

  it("registerRepo links each scope node id via linkScopeRepo in mapped mode", () => {
    const linkCalls: Array<Record<string, unknown>> = [];
    const client = RealDispatchClient.fromFacade({
      registerRepository: () => ({ id: "R-mapped" }),
      linkScopeRepo: (input) => {
        linkCalls.push(input as Record<string, unknown>);
        return { id: `link-${linkCalls.length}` };
      },
    });

    const res = client.registerRepo({
      repoId: "x",
      name: "billing",
      localPath: "/repos/billing",
      scopeNodeIds: ["S1", "S2"],
      relation: "contains",
      defaultAccess: "write",
    });

    expect(res).toEqual({ repoId: "R-mapped", attachedScopeIds: ["S1", "S2"] });
    expect(linkCalls).toHaveLength(2);
    // Each link binds the registered repo id to a scope node with relation/access.
    expect(linkCalls[0]).toMatchObject({
      scope_node_id: "S1",
      repo_id: "R-mapped",
      relation: "contains",
      default_access: "write",
    });
    expect(linkCalls[1]).toMatchObject({ scope_node_id: "S2", repo_id: "R-mapped" });
  });

  it("registerRepo returns null when the facade cannot register repos yet", () => {
    const client = RealDispatchClient.fromFacade({ list: () => [] });
    expect(client.registerRepo({ repoId: "x", name: "n", localPath: "/p" })).toBeNull();
  });

  it("round-trips registerRepo (register + scope link) against the real package", () => {
    const wg = Dispatch.open(":memory:");
    const human = { type: "human", id: "tester" } as const;
    const node = wg.createScopeNode({ name: "Billing", type: "product" }, human);
    const client = RealDispatchClient.fromFacade(
      wg as unknown as Parameters<typeof RealDispatchClient.fromFacade>[0],
    );

    const res = client.registerRepo({
      repoId: "ignored",
      name: "billing-api",
      localPath: "/repos/billing-api",
      stack: "node",
      testCommand: "npm test",
      scopeNodeIds: [node.id],
      relation: "contains",
      defaultAccess: "write",
    });

    expect(res?.repoId).toBeTruthy();
    expect(res?.attachedScopeIds).toEqual([node.id]);
    wg.db.close();
  });

  it("maps markTicketReady onto the facade markReady", async () => {
    const client = await RealDispatchClient.open(":memory:");
    const draft = client.createDraftTicket({ title: "Ready me", description: "idle draft" });
    expect(client.getTicket(draft.ticketId).ticket.status).toBe("draft");
    client.markTicketReady(draft.ticketId);
    expect(client.getTicket(draft.ticketId).ticket.status).toBe("ready");
  });

  it("surfaces a structured error when markReady is absent from the facade", () => {
    const client = RealDispatchClient.fromFacade({ list: () => [] });
    expect(() => client.markTicketReady("T1")).toThrowError(CrewError);
  });
});

describe("FakeDispatchClient", () => {
  it("enforces single claim and rejects invalid tokens", () => {
    const wg = new FakeDispatchClient();
    wg.seedTicket({ title: "x" });
    const claim = wg.claimNextTicket({ agentId: "a", ttlSeconds: 10 });
    expect(claim).not.toBeNull();
    // Second claim finds nothing ready.
    expect(wg.claimNextTicket({ agentId: "b", ttlSeconds: 10 })).toBeNull();
    expect(() => wg.heartbeat("bad-token")).toThrowError(CrewError);
  });

  it("claimTicket claims the chosen ready ticket and rejects unknown/non-ready ids", () => {
    const wg = new FakeDispatchClient();
    const a = wg.seedTicket({ title: "first" });
    const b = wg.seedTicket({ title: "second" });

    // Claim the SECOND ticket specifically, not whatever claimNextTicket surfaces.
    const claim = wg.claimTicket({ ticketId: b.id, agentId: "a", ttlSeconds: 10 });
    expect(claim?.ticketId).toBe(b.id);
    expect(claim?.number).toBe(b.number);
    expect(wg.getTicket(b.id).ticket.status).toBe("claimed");
    // The other ticket is untouched and still claimable.
    expect(wg.getTicket(a.id).ticket.status).toBe("ready");

    // Re-claiming the now-claimed ticket, or an unknown id, yields null.
    expect(wg.claimTicket({ ticketId: b.id, agentId: "a", ttlSeconds: 10 })).toBeNull();
    expect(wg.claimTicket({ ticketId: "missing", agentId: "a", ttlSeconds: 10 })).toBeNull();
  });

  it("recordDeliveryArtifact persists the branch on the ticket and tracks the artifact", () => {
    const wg = new FakeDispatchClient();
    const t = wg.seedTicket({ title: "deliverable" });
    const claim = wg.claimTicket({ ticketId: t.id, agentId: "a", ttlSeconds: 10 });

    const res = wg.recordDeliveryArtifact({
      claimToken: claim!.claimToken,
      ticketId: t.id,
      branchName: "dispatch/ticket-1",
    });
    expect(res.ticketId).toBe(t.id);
    expect(res.branchName).toBe("dispatch/ticket-1");
    expect(res.eventId).not.toBe("");

    // Branch is now readable on the ticket (done-gate parity) and tracked.
    expect(wg.getTicket(t.id).ticket.branchName).toBe("dispatch/ticket-1");
    expect(wg.deliveryArtifacts).toHaveLength(1);
    expect(wg.deliveryArtifacts[0]).toMatchObject({
      ticketId: t.id,
      branchName: "dispatch/ticket-1",
    });
  });

  it("findTicketBySource matches the Source: marker and returns undefined otherwise", () => {
    const wg = new FakeDispatchClient();
    const url = "https://github.com/acme/web-app/issues/7";
    const created = wg.createDraftTicket({
      title: "Ingested",
      description: `Brute-force protection.\n\nSource: ${url}`,
    });
    expect(wg.findTicketBySource(url)?.ticketId).toBe(created.ticketId);
    expect(wg.findTicketBySource("https://github.com/acme/web-app/issues/999")).toBeUndefined();
  });
});

describe("RealDispatchClient.findTicketBySource", () => {
  it("matches an existing ticket by its Source: marker via the facade list", () => {
    const url = "https://github.com/acme/web-app/issues/7";
    const client = RealDispatchClient.fromFacade({
      list: () => [
        { id: "T1", description: "unrelated" },
        { id: "T2", description: `Body.\n\nSource: ${url}` },
      ],
    });
    expect(client.findTicketBySource(url)?.ticketId).toBe("T2");
    expect(client.findTicketBySource("https://github.com/acme/web-app/issues/8")).toBeUndefined();
  });
});
