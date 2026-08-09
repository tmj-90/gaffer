import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  deriveReadToken,
  hasValidBearer,
  isMutationAuthorized,
  requestCapability,
} from "../src/api/auth.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { createApiServer } from "../src/api/server.js";
import { TestClock } from "../src/util/clock.js";
import { giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };

/** Minimal IncomingMessage carrying only an Authorization header. */
function reqWith(token?: string): IncomingMessage {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return { headers } as unknown as IncomingMessage;
}

// ---------------------------------------------------------------------------
// deriveReadToken — one-way derivation of the read-scoped credential.
// ---------------------------------------------------------------------------
describe("deriveReadToken", () => {
  it("is deterministic for a given full token", () => {
    expect(deriveReadToken("full-secret")).toBe(deriveReadToken("full-secret"));
  });

  it("differs from the full token and varies with it", () => {
    expect(deriveReadToken("full-secret")).not.toBe("full-secret");
    expect(deriveReadToken("full-a")).not.toBe(deriveReadToken("full-b"));
  });

  it("is one-way: re-deriving from the read token does not recover the full token", () => {
    const full = "full-secret";
    const read = deriveReadToken(full);
    // Treating the read token as if it were a full token yields a different value,
    // so a read-token holder cannot reconstruct the full (merge-granting) token.
    expect(deriveReadToken(read)).not.toBe(full);
    expect(deriveReadToken(read)).not.toBe(read);
  });
});

// ---------------------------------------------------------------------------
// Pure capability-tier decision functions — fail-closed, no socket.
// ---------------------------------------------------------------------------
describe("capability tier resolution", () => {
  const original = process.env.DISPATCH_API_TOKEN;
  afterEach(() => {
    if (original === undefined) delete process.env.DISPATCH_API_TOKEN;
    else process.env.DISPATCH_API_TOKEN = original;
  });

  it("requestCapability: full → full, read → read, wrong → null, missing → null", () => {
    const full = "operator-secret";
    process.env.DISPATCH_API_TOKEN = full;
    expect(requestCapability(reqWith(full))).toBe("full");
    expect(requestCapability(reqWith(deriveReadToken(full)))).toBe("read");
    expect(requestCapability(reqWith("nope"))).toBeNull();
    expect(requestCapability(reqWith())).toBeNull();
  });

  it("requestCapability: no token configured → full (auth-disabled posture)", () => {
    delete process.env.DISPATCH_API_TOKEN;
    expect(requestCapability(reqWith())).toBe("full");
    expect(requestCapability(reqWith("anything"))).toBe("full");
  });

  it("isMutationAuthorized: full → true, read → false, unknown → false", () => {
    const full = "operator-secret";
    process.env.DISPATCH_API_TOKEN = full;
    expect(isMutationAuthorized(reqWith(full))).toBe(true);
    expect(isMutationAuthorized(reqWith(deriveReadToken(full)))).toBe(false);
    expect(isMutationAuthorized(reqWith("nope"))).toBe(false);
    expect(isMutationAuthorized(reqWith())).toBe(false);
  });

  it("isMutationAuthorized: no token configured → true (embedder posture unchanged)", () => {
    delete process.env.DISPATCH_API_TOKEN;
    expect(isMutationAuthorized(reqWith())).toBe(true);
  });

  it("hasValidBearer: true for full AND read tokens, false for wrong/missing", () => {
    const full = "operator-secret";
    process.env.DISPATCH_API_TOKEN = full;
    // Both credentials satisfy the DNS-rebinding bypass so the read-only dashboard
    // loads over the LAN.
    expect(hasValidBearer(reqWith(full))).toBe(true);
    expect(hasValidBearer(reqWith(deriveReadToken(full)))).toBe(true);
    expect(hasValidBearer(reqWith("nope"))).toBe(false);
    expect(hasValidBearer(reqWith())).toBe(false);
  });

  it("hasValidBearer: false when no token configured (proves credential, not disabled auth)", () => {
    delete process.env.DISPATCH_API_TOKEN;
    expect(hasValidBearer(reqWith("anything"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End-to-end over a real loopback server — the read token browses but is 403
// on every mutating/gate route; the full token is unchanged.
// ---------------------------------------------------------------------------
interface Harness {
  wg: Dispatch;
  baseUrl: string;
  close: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner);
  const server = createApiServer(wg);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    wg,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          wg.db.close();
          resolve();
        });
      }),
  };
}

function get(baseUrl: string, path: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}${path}`, { method: "GET", headers });
}

function send(
  baseUrl: string,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** Build a real, in_review ticket with genuine (non-empty git diff) delivery. */
function seedInReviewTicket(wg: Dispatch): string {
  const agentActor: Actor = { type: "agent", id: "runner" };
  const t = wg.createTicket({ title: "Ship", description: "x", policy_pack: "solo_loose" }, human);
  wg.addAcceptanceCriterion({ ticket_id: t.id, text: "Returns 200" }, human);
  giveTicketRealDelivery(wg, t.id, human);
  wg.markReady(t.id, human);
  const agent = wg.registerAgent({ display_name: "a" }, human);
  const claim = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor);
  wg.submitForReview({ claimToken: claim!.claimToken, ticket_id: t.id }, agentActor);
  return t.id;
}

describe("scoped API tokens — read tier browses, is 403 on mutations", () => {
  const FULL = "operator-secret";
  const READ = deriveReadToken(FULL);
  const original = process.env.DISPATCH_API_TOKEN;

  afterEach(() => {
    if (original === undefined) delete process.env.DISPATCH_API_TOKEN;
    else process.env.DISPATCH_API_TOKEN = original;
  });

  it("read token can GET read-model / board routes", async () => {
    process.env.DISPATCH_API_TOKEN = FULL;
    const h = await startHarness();
    try {
      for (const path of ["/tickets", "/api/board", "/api/dashboard"]) {
        const r = await get(h.baseUrl, path, READ);
        expect(r.status).toBe(200);
      }
    } finally {
      await h.close();
    }
  });

  it("read token can GET a diff (a GET that shells out to git is still a read)", async () => {
    process.env.DISPATCH_API_TOKEN = FULL;
    const h = await startHarness();
    try {
      const id = seedInReviewTicket(h.wg);
      const r = await get(h.baseUrl, `/tickets/${id}/diff`, READ);
      expect(r.status).toBe(200);
    } finally {
      await h.close();
    }
  });

  it("read token → 403 READ_ONLY_TOKEN on approve, and the ticket does not move", async () => {
    process.env.DISPATCH_API_TOKEN = FULL;
    const h = await startHarness();
    try {
      const id = seedInReviewTicket(h.wg);
      const r = await send(h.baseUrl, "POST", `/tickets/${id}/review/approve`, READ);
      expect(r.status).toBe(403);
      expect((await r.json()).error.code).toBe("READ_ONLY_TOKEN");
      // State unchanged — the structural gate never fired.
      expect(h.wg.view(id).ticket.status).toBe("in_review");

      // The full token approves it (unchanged behaviour, backward compat).
      const ok = await send(h.baseUrl, "POST", `/tickets/${id}/review/approve`, FULL);
      expect(ok.status).toBe(200);
      expect(h.wg.view(id).ticket.status).toBe("ready_for_merge");
    } finally {
      await h.close();
    }
  });

  it("read token → 403 on every mutating/gate route", async () => {
    process.env.DISPATCH_API_TOKEN = FULL;
    const h = await startHarness();
    try {
      const cases: Array<[string, string, unknown?]> = [
        ["POST", "/tickets", { title: "T", policy_pack: "solo_loose" }],
        ["POST", "/product-owner/runs", { repo: "x" }],
        ["POST", "/poll-work", {}],
        ["POST", "/repos/onboard", { repo: "x" }],
        ["POST", "/api/settings", { settings: {} }],
        ["PUT", "/api/idle-loops", { loops: {} }],
        [
          "POST",
          "/api/autonomy/policy",
          { repo_id: "x", risk_level: "low", gate: "review", mode: "off" },
        ],
      ];
      for (const [method, path, body] of cases) {
        const r = await send(h.baseUrl, method, path, READ, body);
        expect(r.status, `${method} ${path}`).toBe(403);
        expect((await r.json()).error.code, `${method} ${path}`).toBe("READ_ONLY_TOKEN");
      }
      // No ticket was created by the refused POST /tickets.
      const board = await (await get(h.baseUrl, "/tickets", READ)).json();
      expect(Array.isArray(board.tickets) ? board.tickets.length : 0).toBe(0);
    } finally {
      await h.close();
    }
  });

  it("read token → 403 on ticket move / mark-merged / wont-do; state unchanged", async () => {
    process.env.DISPATCH_API_TOKEN = FULL;
    const h = await startHarness();
    try {
      const t = h.wg.createTicket({ title: "T", policy_pack: "solo_loose" }, human);
      const before = h.wg.view(t.id).ticket.status;
      for (const path of [
        `/tickets/${t.id}/wont-do`,
        `/tickets/${t.id}/move`,
        `/tickets/${t.id}/mark-merged`,
      ]) {
        const r = await send(h.baseUrl, "POST", path, READ, { reason: "x" });
        expect(r.status, path).toBe(403);
      }
      expect(h.wg.view(t.id).ticket.status).toBe(before);
    } finally {
      await h.close();
    }
  });

  it("401 fires before 403: no credential on a mutation → 401, read credential → 403", async () => {
    process.env.DISPATCH_API_TOKEN = FULL;
    const h = await startHarness();
    try {
      const id = seedInReviewTicket(h.wg);
      const none = await send(h.baseUrl, "POST", `/tickets/${id}/review/approve`);
      expect(none.status).toBe(401);
      const wrong = await send(h.baseUrl, "POST", `/tickets/${id}/review/approve`, "garbage");
      expect(wrong.status).toBe(401);
      const read = await send(h.baseUrl, "POST", `/tickets/${id}/review/approve`, READ);
      expect(read.status).toBe(403);
    } finally {
      await h.close();
    }
  });

  it("full (legacy) token is unaffected: read AND mutating routes behave as today", async () => {
    process.env.DISPATCH_API_TOKEN = FULL;
    const h = await startHarness();
    try {
      expect((await get(h.baseUrl, "/api/board", FULL)).status).toBe(200);
      const created = await send(h.baseUrl, "POST", "/tickets", FULL, {
        title: "T",
        policy_pack: "solo_loose",
      });
      expect(created.status).toBe(201);
    } finally {
      await h.close();
    }
  });

  it("no token configured: mutations still succeed (embedder posture unchanged)", async () => {
    delete process.env.DISPATCH_API_TOKEN;
    const h = await startHarness();
    try {
      const created = await send(h.baseUrl, "POST", "/tickets", undefined, {
        title: "T",
        policy_pack: "solo_loose",
      });
      expect(created.status).toBe(201);
    } finally {
      await h.close();
    }
  });
});
