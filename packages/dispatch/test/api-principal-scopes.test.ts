/**
 * PER-REPO AND PER-TICKET PRINCIPALS (schema v31).
 *
 * A principal may carry a repo scope (`repos`) and a ticket scope (`tickets`).
 * The dispatch API's authorisation layer checks EVERY write and every read of
 * ticket data against it (services/accessScope.ts, the same evaluation the CLI and
 * the factory MCP mount use):
 *   - a ticket write is allowed when the ticket's write repos all sit inside the repo
 *     scope, or the ticket is in the ticket scope; otherwise 403 SCOPE_DENIED with
 *     details naming the scope;
 *   - a scoped principal sees only those tickets (the list, the board, a ticket's
 *     detail);
 *   - repository-level writes (repo settings, onboarding, a ticket's repo access,
 *     settings) need an admin principal;
 *   - approvals are recorded under the principal's identity;
 *   - read-only + scope = scoped reads.
 */

import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { setPrincipalResolver } from "../src/api/auth.js";
import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { listEvents } from "../src/events/eventWriter.js";
import { TestClock } from "../src/util/clock.js";
import { nonEmptyDiffRunner, shownCommits } from "./helpers/realDiff.js";

const FULL = "shared-full-token-for-scope-tests-0123456789abcdef";
const human: Actor = { type: "human", id: "tom" };
const agentActor: Actor = { type: "agent", id: "agent-1" };

const saved = process.env.DISPATCH_API_TOKEN;
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  setPrincipalResolver(null);
  if (saved === undefined) delete process.env.DISPATCH_API_TOKEN;
  else process.env.DISPATCH_API_TOKEN = saved;
});

async function start(): Promise<{ base: string; wg: Dispatch }> {
  process.env.DISPATCH_AUDIT_OFF = "1";
  process.env.DISPATCH_API_TOKEN = FULL;
  const wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner, {
    testingEnabled: false,
  });
  const server = createApiServer(wg);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  close = () =>
    new Promise<void>((resolve) =>
      server.close(() => {
        wg.db.close();
        resolve();
      }),
    );
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, wg };
}

interface Reply {
  status: number;
  body: Record<string, unknown> & {
    error?: { code: string; message: string; details?: Record<string, unknown> };
  };
}
async function call(
  base: string,
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<Reply> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Reply["body"]) : {} };
}

/** Two repos, a ticket on each, one on both and one on neither. */
function world(wg: Dispatch) {
  const app = wg.registerRepository({ name: "app", default_branch: "main" }, human);
  const svc = wg.registerRepository({ name: "svc", default_branch: "main" }, human);
  const mk = (title: string, repos: string[]) => {
    const t = wg.createTicketWithLinks(
      { title, description: "", policy_pack: "solo_loose", risk_level: "low" },
      {
        repoAccess: repos.map((r) => ({ repo_id: r, access: "write" as const })),
      },
      human,
    );
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, human);
    return t;
  };
  return {
    app,
    svc,
    onApp: mk("on app", [app.id]),
    onSvc: mk("on svc", [svc.id]),
    onBoth: mk("on both", [app.id, svc.id]),
    onNone: mk("on none", []),
  };
}

/** Deliver a ticket into Review (a diff on `repoName`, which must be its write repo). */
function intoReview(wg: Dispatch, ticketId: string, repoName: string): void {
  wg.markReady(ticketId, human);
  const agent = wg.registerAgent({ display_name: `a-${ticketId.slice(0, 6)}` }, human);
  const claim = wg.claimTicket(
    { ticket_id: ticketId, agent_id: agent.id, ttl_seconds: 300 },
    agentActor,
  );
  // A real (faked) diff on the ticket's own write repo: a checkout on disk + a branch.
  const repo = wg.repos.findByName(repoName);
  if (!repo) throw new Error(`no repo ${repoName}`);
  wg.db.prepare("UPDATE repositories SET local_path = ? WHERE id = ?").run(process.cwd(), repo.id);
  wg.recordRepoDelivery({ ticket_id: ticketId, repo_id: repo.id, branch_name: "feat/x" }, human);
  wg.recordDeliveryArtifact(
    { claim_token: claim.claimToken, ticket_id: ticketId, branch_name: "feat/x" },
    agentActor,
  );
  wg.submitForReview({ claimToken: claim.claimToken, ticket_id: ticketId }, agentActor);
  expect(wg.resolveTicket(ticketId).status).toBe("in_review");
}

async function mint(base: string, body: Record<string, unknown>): Promise<string> {
  const r = await call(base, "POST", "/api/principals", FULL, body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.token as string;
}

describe("principal scopes (REST)", () => {
  it("records repo and ticket scopes at creation, resolves names, refuses unknown ones", async () => {
    const { base, wg } = await start();
    const w = world(wg);
    const r = await call(base, "POST", "/api/principals", FULL, {
      name: "app-bot",
      repos: ["app"],
      tickets: [w.onSvc.number],
    });
    expect(r.status).toBe(201);
    expect(r.body.principal).toMatchObject({
      name: "app-bot",
      scope: {
        repos: [{ id: w.app.id, name: "app" }],
        tickets: [{ id: w.onSvc.id, number: w.onSvc.number }],
      },
    });
    const who = await call(base, "GET", "/api/whoami", r.body.token as string);
    expect(who.body.scope).toEqual({
      repos: [{ id: w.app.id, name: "app" }],
      tickets: [{ id: w.onSvc.id, number: w.onSvc.number }],
    });
    // An unscoped principal says so, and the shared token has no scope.
    const plain = await mint(base, { name: "plain" });
    expect((await call(base, "GET", "/api/whoami", plain)).body.scope).toBeNull();
    expect((await call(base, "GET", "/api/whoami", FULL)).body.scope).toBeNull();
    // Unknown repo or ticket: 404, nothing created.
    const before = wg.listPrincipals().length;
    expect(
      (await call(base, "POST", "/api/principals", FULL, { name: "x", repos: ["nope"] })).status,
    ).toBe(404);
    expect(
      (await call(base, "POST", "/api/principals", FULL, { name: "y", tickets: [9999] })).status,
    ).toBe(404);
    expect(wg.listPrincipals().length).toBe(before);
    // The creation event names the scope.
    const created = wg.getPrincipal("app-bot");
    const ev = listEvents(wg.db, "principal", created.id)[0];
    expect(JSON.parse(String(ev?.payload_json))).toMatchObject({
      scope_repos: ["app"],
      scope_tickets: [w.onSvc.number],
    });
  });

  it("a repo-scoped principal sees and changes only its repo's tickets", async () => {
    const { base, wg } = await start();
    const w = world(wg);
    const tok = await mint(base, { name: "app-bot", repos: ["app"] });

    const list = await call(base, "GET", "/tickets", tok);
    expect(list.status).toBe(200);
    const ids = (list.body.tickets as Array<{ id: string }>).map((t) => t.id);
    expect(ids).toEqual([w.onApp.id]);
    expect(list.body.total).toBe(1);

    expect((await call(base, "GET", `/tickets/${w.onApp.id}`, tok)).status).toBe(200);
    const denied = await call(base, "GET", `/tickets/${w.onBoth.id}`, tok);
    expect(denied.status).toBe(403);
    expect(denied.body.error?.code).toBe("SCOPE_DENIED");
    expect(denied.body.error?.details).toMatchObject({
      scope: { repos: [{ id: w.app.id, name: "app" }], tickets: null },
      ticket: w.onBoth.number,
      reason: "outside_repo_scope",
      outside_repos: ["svc"],
    });
    expect((await call(base, "GET", `/tickets/${w.onNone.id}/events`, tok)).status).toBe(403);

    // Writes: in scope passes, out of scope is refused before anything changes.
    expect((await call(base, "POST", `/tickets/${w.onApp.id}/ready`, tok)).status).toBe(200);
    const w403 = await call(base, "POST", `/tickets/${w.onSvc.id}/ready`, tok);
    expect(w403.status).toBe(403);
    expect(w403.body.error?.code).toBe("SCOPE_DENIED");
    expect(wg.resolveTicket(w.onSvc.id).status).toBe("draft");
    expect(
      (await call(base, "PATCH", `/tickets/${w.onBoth.id}`, tok, { title: "renamed" })).status,
    ).toBe(403);

    // The board shows only its tickets.
    const board = await call(base, "GET", "/api/board", tok);
    expect(board.status).toBe(200);
    const cards = (board.body.columns as Array<{ cards: Array<{ id: string }> }>).flatMap((c) =>
      c.cards.map((k) => k.id),
    );
    expect(cards).toEqual([w.onApp.id]);

    // Creating: only onto its repo.
    expect(
      (
        await call(base, "POST", "/tickets", tok, {
          title: "new on app",
          repoIds: [{ repo_id: w.app.id, access: "write" }],
        })
      ).status,
    ).toBe(201);
    const cOut = await call(base, "POST", "/tickets", tok, {
      title: "new on svc",
      repoIds: [{ repo_id: w.svc.id, access: "write" }],
    });
    expect(cOut.status).toBe(403);
    expect(cOut.body.error?.details).toMatchObject({ reason: "outside_repo_scope" });
    expect((await call(base, "POST", "/tickets", tok, { title: "no repo" })).status).toBe(403);
    expect(
      (await call(base, "POST", "/tickets", tok, { title: "legacy", repo: "app" })).status,
    ).toBe(201);

    // Factory-wide writes and reads are outside a scope.
    const poll = await call(base, "POST", "/poll-work", tok, {});
    expect(poll.status).toBe(403);
    expect(poll.body.error?.details).toMatchObject({ reason: "factory_wide" });
    expect((await call(base, "GET", "/api/runs", tok)).status).toBe(403);
    expect((await call(base, "GET", "/api/cost", tok)).status).toBe(403);
    // Reads with no ticket content stay open.
    expect((await call(base, "GET", "/api/squad", tok)).status).toBe(200);
    expect((await call(base, "GET", "/repositories", tok)).status).toBe(200);
  });

  it("a ticket-scoped principal reaches exactly its tickets", async () => {
    const { base, wg } = await start();
    const w = world(wg);
    const tok = await mint(base, { name: "one-ticket", tickets: [w.onNone.number] });
    const ids = ((await call(base, "GET", "/tickets", tok)).body.tickets as Array<{ id: string }>)
      .map((t) => t.id)
      .sort();
    expect(ids).toEqual([w.onNone.id]);
    expect(
      (await call(base, "PATCH", `/tickets/${w.onNone.id}`, tok, { title: "renamed" })).status,
    ).toBe(200);
    const d = await call(base, "PATCH", `/tickets/${w.onApp.id}`, tok, { title: "renamed" });
    expect(d.status).toBe(403);
    expect(d.body.error?.details).toMatchObject({
      reason: "outside_ticket_scope",
      scope: { repos: null, tickets: [{ id: w.onNone.id, number: w.onNone.number }] },
    });
  });

  it("approving: outside the scope is 403; inside is recorded under the principal's identity", async () => {
    const { base, wg } = await start();
    const w = world(wg);
    intoReview(wg, w.onApp.id, "app");
    intoReview(wg, w.onSvc.id, "svc");
    const tok = await mint(base, { name: "app-reviewer", repos: ["app"], actor_id: "rev@corp" });

    const out = await call(
      base,
      "POST",
      `/tickets/${w.onSvc.id}/review/approve`,
      tok,
      shownCommits(wg, w.onSvc.id),
    );
    expect(out.status).toBe(403);
    expect(out.body.error?.code).toBe("SCOPE_DENIED");
    expect(wg.resolveTicket(w.onSvc.id).status).toBe("in_review");

    const ok = await call(
      base,
      "POST",
      `/tickets/${w.onApp.id}/review/approve`,
      tok,
      shownCommits(wg, w.onApp.id),
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(wg.resolveTicket(w.onApp.id).status).toBe("ready_for_merge");
    const approved = listEvents(wg.db, "ticket", w.onApp.id).filter(
      (e) => e.event_type === "ticket.transitioned",
    );
    expect(approved[approved.length - 1]).toMatchObject({
      actor_type: "human",
      actor_id: "rev@corp",
    });
  });

  it("repo-level writes need an admin principal, and a scoped admin only inside its scope", async () => {
    const { base, wg } = await start();
    const w = world(wg);
    const humanScoped = await mint(base, { name: "h-app", repos: ["app"] });
    const humanPlain = await mint(base, { name: "h-plain" });
    const adminApp = await mint(base, { name: "a-app", actor_type: "admin", repos: ["app"] });
    const adminPlain = await mint(base, { name: "a-plain", actor_type: "admin" });

    const hide = (tok: string, repo: string) =>
      call(base, "POST", `/repos/${repo}/hidden`, tok, { hidden: false });
    for (const tok of [humanScoped, humanPlain]) {
      const r = await hide(tok, w.app.id);
      expect(r.status).toBe(403);
      expect(r.body.error?.code).toBe("SCOPE_DENIED");
      expect(r.body.error?.details).toMatchObject({ reason: "admin_required", required: "admin" });
    }
    expect((await hide(adminApp, w.app.id)).status).toBe(200);
    expect((await hide(adminApp, w.svc.id)).status).toBe(403);
    expect((await hide(adminPlain, w.svc.id)).status).toBe(200);
    expect((await hide(FULL, w.svc.id)).status).toBe(200);

    // A ticket's repo access is a repo link: admin only, inside the scope.
    const link = (tok: string, ticket: string, repo: string) =>
      call(base, "PUT", `/tickets/${ticket}/repo-access`, tok, {
        repo_id: repo,
        access: "read",
      });
    expect((await link(humanPlain, w.onApp.id, w.app.id)).status).toBe(403);
    expect((await link(adminApp, w.onApp.id, w.svc.id)).status).toBe(403);
    expect((await link(adminApp, w.onApp.id, w.app.id)).status).toBe(200);

    // Settings are factory-wide: a scoped admin is refused, an unscoped one is not.
    const s = await call(base, "POST", "/api/settings", adminApp, { settings: {} });
    expect(s.status).toBe(403);
    expect(s.body.error?.details).toMatchObject({ reason: "factory_wide" });
    expect((await call(base, "POST", "/api/settings", humanPlain, { settings: {} })).status).toBe(
      403,
    );
  });

  it("the live event stream carries only the scoped principal's tickets", async () => {
    const { base, wg } = await start();
    const w = world(wg);
    const tok = await mint(base, { name: "app-feed", repos: ["app"] });
    const ac = new AbortController();
    const res = await fetch(`${base}/api/events/stream?since=0`, {
      headers: { authorization: `Bearer ${tok}` },
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    let text = "";
    const until = Date.now() + 3000;
    while (Date.now() < until && !text.includes(w.onApp.id)) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ value?: undefined }>((r) => setTimeout(() => r({}), 500)),
      ]);
      if (chunk.value) text += new TextDecoder().decode(chunk.value);
    }
    // Let a few more polls pass so anything else would have arrived too.
    const settle = Date.now() + 600;
    while (Date.now() < settle) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ value?: undefined }>((r) => setTimeout(() => r({}), 200)),
      ]);
      if (chunk.value) text += new TextDecoder().decode(chunk.value);
    }
    ac.abort();
    expect(text).toContain(w.onApp.id);
    for (const other of [w.onSvc.id, w.onBoth.id, w.onNone.id, w.app.id]) {
      expect(text).not.toContain(other);
    }
  });

  it("read-only + scope = scoped reads", async () => {
    const { base, wg } = await start();
    const w = world(wg);
    const tok = await mint(base, { name: "ro-app", capability: "read", repos: ["app"] });
    expect((await call(base, "GET", `/tickets/${w.onApp.id}`, tok)).status).toBe(200);
    const out = await call(base, "GET", `/tickets/${w.onSvc.id}`, tok);
    expect(out.status).toBe(403);
    expect(out.body.error?.code).toBe("SCOPE_DENIED");
    const write = await call(base, "POST", `/tickets/${w.onApp.id}/ready`, tok);
    expect(write.status).toBe(403);
    expect(write.body.error?.code).toBe("READ_ONLY_TOKEN");
    const who = await call(base, "GET", "/api/whoami", tok);
    expect(who.body).toMatchObject({ capability: "read", scope: { repos: [{ name: "app" }] } });
  });
});
