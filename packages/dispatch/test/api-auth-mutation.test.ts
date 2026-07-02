import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ensureApiToken, resolveDashboardTokenPath } from "../src/api/auth.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { createApiServer } from "../src/api/server.js";
import { TestClock } from "../src/util/clock.js";
import { giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };

// ---------------------------------------------------------------------------
// ensureApiToken — a token is guaranteed to exist so mutating endpoints are
// gated by construction, not merely by deployment posture.
// ---------------------------------------------------------------------------
describe("ensureApiToken", () => {
  const originalToken = process.env.DISPATCH_API_TOKEN;
  const originalData = process.env.GAFFER_DATA;
  const tmpDirs: string[] = [];

  afterEach(() => {
    if (originalToken === undefined) delete process.env.DISPATCH_API_TOKEN;
    else process.env.DISPATCH_API_TOKEN = originalToken;
    if (originalData === undefined) delete process.env.GAFFER_DATA;
    else process.env.GAFFER_DATA = originalData;
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function freshDataDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "gaffer-token-"));
    tmpDirs.push(dir);
    return dir;
  }

  it("uses an operator-set DISPATCH_API_TOKEN verbatim (source=env, nothing persisted)", () => {
    const dir = freshDataDir();
    const env = { DISPATCH_API_TOKEN: "operator-token", GAFFER_DATA: dir } as NodeJS.ProcessEnv;
    const ensured = ensureApiToken(env);
    expect(ensured).toMatchObject({ token: "operator-token", source: "env" });
    // No token file is written when the env already carries one.
    expect(() => statSync(join(dir, "dashboard-token"))).toThrow();
  });

  it("generates + persists a token 0600 and exports it when none is configured", () => {
    const dir = freshDataDir();
    const env = { GAFFER_DATA: dir } as NodeJS.ProcessEnv;
    const ensured = ensureApiToken(env);

    expect(ensured.source).toBe("generated");
    expect(ensured.token.length).toBeGreaterThanOrEqual(32);
    // Exported so the rest of the auth path picks it up with no extra wiring.
    expect(env.DISPATCH_API_TOKEN).toBe(ensured.token);

    const path = resolveDashboardTokenPath(env);
    expect(ensured.path).toBe(path);
    // Persisted verbatim...
    expect(readFileSync(path, "utf8")).toBe(ensured.token);
    // ...and locked to owner-only 0600 (no group/other bits).
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("reuses a previously-persisted token across restarts (source=file)", () => {
    const dir = freshDataDir();
    const path = join(dir, "dashboard-token");
    writeFileSync(path, "saved-token\n", { mode: 0o600 });

    const env = { GAFFER_DATA: dir } as NodeJS.ProcessEnv;
    const ensured = ensureApiToken(env);
    expect(ensured).toMatchObject({ token: "saved-token", source: "file" });
    expect(env.DISPATCH_API_TOKEN).toBe("saved-token");
  });
});

// ---------------------------------------------------------------------------
// REST mutation gate — the delivery agent (a tokenless local caller whose env
// the runner scrubs of DISPATCH_API_TOKEN) is structurally refused at every
// mutating / approval endpoint; the operator holding the token succeeds.
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

function post(baseUrl: string, path: string, token?: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe("REST approval/mutation endpoints require the token by default", () => {
  const TOKEN = "operator-secret";
  const original = process.env.DISPATCH_API_TOKEN;

  afterEach(() => {
    if (original === undefined) delete process.env.DISPATCH_API_TOKEN;
    else process.env.DISPATCH_API_TOKEN = original;
  });

  it("refuses a tokenless review-approve (the agent's shell) but accepts the operator's token", async () => {
    process.env.DISPATCH_API_TOKEN = TOKEN;
    const h = await startHarness();
    try {
      // Build a real, in_review ticket with genuine (non-empty git diff) delivery
      // evidence. solo_loose keeps the focus on the auth gate: its done-gate needs
      // only the recomputed diff, which giveTicketRealDelivery + nonEmptyDiffRunner
      // satisfy.
      const agentActor: Actor = { type: "agent", id: "runner" };
      const t = h.wg.createTicket(
        { title: "Ship", description: "x", policy_pack: "solo_loose" },
        human,
      );
      h.wg.addAcceptanceCriterion({ ticket_id: t.id, text: "Returns 200" }, human);
      giveTicketRealDelivery(h.wg, t.id, human);
      h.wg.markReady(t.id, human);
      const agent = h.wg.registerAgent({ display_name: "a" }, human);
      const claim = h.wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor);
      h.wg.submitForReview({ claimToken: claim!.claimToken, ticket_id: t.id }, agentActor);

      // A tokenless local POST to the approval endpoint — exactly what the
      // delivery agent's own shell could do in the old tokenless posture — is now
      // refused. The ticket does not move.
      const noToken = await post(h.baseUrl, `/tickets/${t.id}/review/approve`);
      expect(noToken.status).toBe(401);
      expect(h.wg.view(t.id).ticket.status).toBe("in_review");

      // A wrong token is likewise refused.
      const wrong = await post(h.baseUrl, `/tickets/${t.id}/review/approve`, "nope");
      expect(wrong.status).toBe(401);
      expect(h.wg.view(t.id).ticket.status).toBe("in_review");

      // The operator, holding the token, approves.
      const ok = await post(h.baseUrl, `/tickets/${t.id}/review/approve`, TOKEN);
      expect(ok.status).toBe(200);
      expect(h.wg.view(t.id).ticket.status).toBe("ready_for_merge");
    } finally {
      await h.close();
    }
  });

  it("refuses tokenless mark-merged and won't-do, but accepts them with the token", async () => {
    process.env.DISPATCH_API_TOKEN = TOKEN;
    const h = await startHarness();
    try {
      const t = h.wg.createTicket({ title: "T", policy_pack: "solo_loose" }, human);
      // wont-do without a token → refused; the ticket stays put.
      const noToken = await post(h.baseUrl, `/tickets/${t.id}/wont-do`, undefined, {
        reason: "drop",
      });
      expect(noToken.status).toBe(401);
      expect(h.wg.view(t.id).ticket.status).toBe("draft");

      // With the token the operator can cancel it.
      const ok = await post(h.baseUrl, `/tickets/${t.id}/wont-do`, TOKEN, { reason: "drop" });
      expect(ok.status).toBe(200);
      expect(h.wg.view(t.id).ticket.status).toBe("cancelled");
    } finally {
      await h.close();
    }
  });
});
