/**
 * PRINCIPAL SCOPES: ONE decision-visibility rule (external review 17, finding 2).
 *
 * A decision linked to tickets A and B is readable only by a caller who may read every
 * ticket it is linked to (the rule GET /decisions/:id always applied). Before this, a
 * reader scoped to A got 403 on the decision itself and did not see it in the list,
 * yet read its title and question through ticket A's detail (`blocking_decisions`) and
 * through ticket A's claimability. Now every nested response asks the same rule: a
 * decision the caller may not read still shows where it blocks the caller's ticket,
 * as a generic marker (`outside_scope: true`, no id, title, question or answer), and
 * the policy still counts it (A stays blocked).
 *
 * Covered on a real database and HTTP server (REST), the factory MCP mount, and the
 * CLI acting as a principal, with negative controls: the shared token, an unscoped
 * principal and a principal scoped to both tickets still read the whole decision.
 *
 * Secondary finding: a request resolves its credential exactly once. A resolver that
 * answers the first lookup and not a later one used to turn a principal into the
 * shared operator part way through a request (scope gate skipped, principal admin
 * allowed). Now the first resolution is the request's identity, and a credential that
 * does not resolve is refused, never widened.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setPrincipalResolver, type ResolvedPrincipal } from "../src/api/auth.js";
import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import type { Actor, Decision, Ticket } from "../src/domain/types.js";
import { makeHandlers } from "../src/mcp/tools.js";
import { TestClock } from "../src/util/clock.js";
import { nonEmptyDiffRunner } from "./helpers/realDiff.js";

// The CLI cases spawn the built CLI (about half a second a call).
vi.setConfig({ testTimeout: 60_000 });

const FULL = "shared-full-token-for-decision-scope-0123456789abcdef";
const human: Actor = { type: "human", id: "tom" };
const mcpAgent: Actor = { type: "agent", id: "mcp-agent" };

const SHARED_TITLE = "SHARED-TITLE-q7";
const SHARED_QUESTION = "SHARED-QUESTION-q7";
const ANSWERED_TITLE = "ANSWERED-TITLE-q7";
const ANSWERED_QUESTION = "ANSWERED-QUESTION-q7";
const ANSWER = "ANSWER-TEXT-q7";
const OWN_TITLE = "OWN-TITLE-q7";

const ENV_KEYS = [
  "DISPATCH_API_TOKEN",
  "DISPATCH_AUDIT_OFF",
  "GAFFER_FACTORY",
  "GAFFER_CLAIM_TOKEN",
  "GAFFER_SCOPE_TICKET",
  "GAFFER_REVIEW_TICKET",
] as const;
let saved: Record<string, string | undefined> = {};
let close: (() => Promise<void>) | undefined;
let dir = "";
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS.slice(2)) delete process.env[k];
});
afterEach(async () => {
  await close?.();
  close = undefined;
  setPrincipalResolver(null);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

interface World {
  wg: Dispatch;
  a: Ticket;
  b: Ticket;
  shared: Decision;
  answered: Decision;
  own: Decision;
}

/** Ticket A on repo app, ticket B on repo svc; decisions shared by both, and one on A. */
function seed(wg: Dispatch): World {
  const app = wg.registerRepository({ name: "app", default_branch: "main" }, human);
  const svc = wg.registerRepository({ name: "svc", default_branch: "main" }, human);
  const mk = (title: string, repo: string): Ticket => {
    const t = wg.createTicketWithLinks(
      { title, description: "", policy_pack: "solo_loose", risk_level: "low" },
      { repoAccess: [{ repo_id: repo, access: "write" }] },
      human,
    );
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, human);
    return wg.resolveTicket(t.id);
  };
  const a = mk("ticket A", app.id);
  const b = mk("ticket B", svc.id);
  const shared = wg.createDecision(
    {
      title: SHARED_TITLE,
      question: SHARED_QUESTION,
      severity: "human_required",
      ticketId: a.id,
      ticketIds: [b.id],
    },
    human,
  );
  const answered = wg.createDecision(
    {
      title: ANSWERED_TITLE,
      question: ANSWERED_QUESTION,
      severity: "human_required",
      ticketId: a.id,
      ticketIds: [b.id],
    },
    human,
  );
  wg.resolveDecision({ decisionId: answered.id, status: "accepted", answer: ANSWER }, human);
  const own = wg.createDecision(
    { title: OWN_TITLE, question: "own question", severity: "human_required", ticketId: a.id },
    human,
  );
  return { wg, a, b, shared, answered, own };
}

async function start(file?: string): Promise<{ base: string } & World> {
  process.env.DISPATCH_AUDIT_OFF = "1";
  process.env.DISPATCH_API_TOKEN = FULL;
  const wg = Dispatch.open(file ?? ":memory:", new TestClock(), nonEmptyDiffRunner, {
    testingEnabled: false,
  });
  const world = seed(wg);
  const server = createApiServer(wg);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  close = () =>
    new Promise<void>((resolve) =>
      server.close(() => {
        wg.db.close();
        resolve();
      }),
    );
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, ...world };
}

interface Reply {
  status: number;
  text: string;
  body: Record<string, unknown> & { error?: { code: string; message: string } };
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
  return { status: res.status, text, body: text ? (JSON.parse(text) as Reply["body"]) : {} };
}

function mint(wg: Dispatch, name: string, tickets?: Ticket[]): string {
  return wg.createPrincipal(
    { name, ...(tickets ? { tickets: tickets.map((t) => t.id) } : {}) },
    human,
  ).token;
}

/** Nothing of the restricted decisions: no title, question, answer or id. */
function expectNoRestricted(text: string, w: World, where: string): void {
  for (const secret of [
    SHARED_TITLE,
    SHARED_QUESTION,
    ANSWERED_TITLE,
    ANSWERED_QUESTION,
    ANSWER,
    w.shared.id,
    w.answered.id,
  ]) {
    expect(text.includes(secret), `${where} leaks ${secret}`).toBe(false);
  }
}

/** Read the live feed for a while and return everything it sent. */
async function readStream(base: string, token: string, ms: number): Promise<string> {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events/stream?since=0`, {
    headers: { authorization: `Bearer ${token}` },
    signal: ac.signal,
  });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  let text = "";
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ value?: undefined }>((r) => setTimeout(() => r({}), 200)),
    ]);
    if (chunk.value) text += new TextDecoder().decode(chunk.value);
  }
  ac.abort();
  return text;
}

type Blocking = Array<{ id: string | null; title: string | null; outside_scope?: true }>;

describe("one decision-visibility rule (REST)", () => {
  it("an A-only reader never reads a decision shared with B, and A stays blocked by it", async () => {
    const w = await start();
    const { base, wg, a } = w;
    const tok = mint(wg, "a-only", [a]);

    // The direct routes (unchanged): 403 on the decision, left out of the list.
    expect((await call(base, "GET", `/decisions/${w.shared.id}`, tok)).status).toBe(403);
    const list = await call(base, "GET", "/decisions", tok);
    expect(list.status).toBe(200);
    expect((list.body.decisions as Decision[]).map((d) => d.id)).toEqual([w.own.id]);

    // Ticket A's detail: its own decision in full, the shared one as a generic blocker.
    const detail = await call(base, "GET", `/tickets/${a.id}`, tok);
    expect(detail.status).toBe(200);
    expectNoRestricted(detail.text, w, "GET /tickets/:id");
    const blocking = detail.body.blocking_decisions as Blocking;
    expect(blocking).toHaveLength(2);
    expect(blocking.find((d) => d.id === w.own.id)?.title).toBe(OWN_TITLE);
    expect(blocking.filter((d) => d.outside_scope === true)).toEqual([
      { id: null, title: null, outside_scope: true },
    ]);

    // Claimability: still blocked by both decisions, the shared one named generically.
    const claim = await call(base, "GET", `/tickets/${a.id}/claimability`, tok);
    expect(claim.status).toBe(200);
    expectNoRestricted(claim.text, w, "GET /tickets/:id/claimability");
    expect(claim.body.ready).toBe(false);
    const blocker = (claim.body.blockers as Array<{ code: string; message: string }>).find(
      (b) => b.code === "DECISION_BLOCKED",
    );
    expect(blocker?.message).toContain("2 decisions");
    expect(blocker?.message).toContain(OWN_TITLE);
    expect(blocker?.message).toContain("outside this credential's scope");

    // The policy still counts the hidden decision: A is not claimable for anyone.
    expect(wg.claimability(a.id).ready).toBe(false);
    expect(
      wg
        .view(a.id)
        .blockingDecisions.map((d) => d.id)
        .sort(),
    ).toEqual([w.shared.id, w.own.id].sort());

    // Every other read the scoped reader may make.
    for (const path of [
      "/tickets",
      `/tickets/details?ids=${a.id}&include=repositories,scopes,dependencies,rework_trail,events,evidence`,
      "/tickets/details",
      "/api/board",
      "/api/human-queue",
      "/claims",
      `/tickets/${a.id}/events`,
      `/tickets/${a.id}/dossier`,
      "/api/whoami",
    ]) {
      const r = await call(base, "GET", path, tok);
      expectNoRestricted(r.text, w, `GET ${path} (${r.status})`);
    }
    // The live feed carries ticket events only.
    expectNoRestricted(await readStream(base, tok, 800), w, "GET /api/events/stream");
  });

  it("negative control: the shared token, an unscoped principal and an A+B principal read it whole", async () => {
    const w = await start();
    const { base, wg, a, b } = w;
    for (const [who, tok] of [
      ["shared token", FULL],
      ["unscoped principal", mint(wg, "everyone")],
      ["A+B principal", mint(wg, "both", [a, b])],
    ] as const) {
      expect((await call(base, "GET", `/decisions/${w.shared.id}`, tok)).status, who).toBe(200);
      const list = await call(base, "GET", "/decisions", tok);
      expect(list.text.includes(w.shared.id), who).toBe(true);
      const detail = await call(base, "GET", `/tickets/${a.id}`, tok);
      const blocking = detail.body.blocking_decisions as Blocking;
      expect(blocking.map((d) => d.title).sort(), who).toEqual([OWN_TITLE, SHARED_TITLE].sort());
      expect(detail.text.includes("outside_scope"), who).toBe(false);
      const claim = await call(base, "GET", `/tickets/${a.id}/claimability`, tok);
      expect(claim.text.includes(SHARED_TITLE), who).toBe(true);
      expect(claim.text.includes("outside this credential's scope"), who).toBe(false);
    }
  });
});

describe("the factory MCP mount: every decision on the agent's own ticket", () => {
  // The factory mount is not a scoped principal: it carries no credential, opens the
  // factory database itself and reads any ticket whole through get_ticket, and the runner
  // already hands a delivery agent each answer (`_RD`, from `wg ticket show` with no
  // principal). Hiding a decision there protected nothing, and it starved the reviewer,
  // tester, clarify and planning agents, whose only source is get_ticket (and _RD keeps
  // only the last five answers). So a mount reads every decision linked to a ticket it is
  // bound to, whatever else that decision is linked to.
  const bindings: Array<[string, (w: World) => void]> = [
    [
      "delivery / clarify (GAFFER_SCOPE_TICKET)",
      (w) => (process.env.GAFFER_SCOPE_TICKET = String(w.a.number)),
    ],
    [
      "reviewer / tester (GAFFER_REVIEW_TICKET)",
      (w) => (process.env.GAFFER_REVIEW_TICKET = String(w.a.number)),
    ],
  ];
  for (const [role, bind] of bindings) {
    it(`a ${role} mount bound to A reads the decisions shared with B whole, answers included`, () => {
      const wg = Dispatch.open(":memory:", new TestClock());
      const w = seed(wg);
      // More answers than the runner's prompt carries (its last five), all shared with B.
      const extra: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const d = wg.createDecision(
          {
            title: `OLD-${i}`,
            question: `old ${i}?`,
            severity: "human_required",
            ticketId: w.a.id,
            ticketIds: [w.b.id],
          },
          human,
        );
        wg.resolveDecision(
          { decisionId: d.id, status: "accepted", answer: `OLD-ANSWER-${i}` },
          human,
        );
        extra.push(`OLD-ANSWER-${i}`);
      }
      process.env.GAFFER_FACTORY = "1";
      bind(w);
      const h = makeHandlers(wg, mcpAgent);

      const got = h.get_ticket({ ticket_id: w.a.id });
      expect(got.isError).toBeUndefined();
      const text = JSON.stringify(got.structuredContent);
      const blocking = got.structuredContent.blocking_decisions as Blocking;
      expect(blocking.map((d) => d.title).sort()).toEqual([OWN_TITLE, SHARED_TITLE].sort());
      expect(text).not.toContain("outside_scope");
      for (const answer of [ANSWER, ...extra]) expect(text, role).toContain(answer);
      expect((got.structuredContent.resolved_decisions as unknown[]).length).toBe(7);

      const pending = JSON.stringify(h.list_pending_decisions({}).structuredContent);
      expect(pending).toContain(SHARED_TITLE);
      expect(pending).toContain(OWN_TITLE);
      wg.db.close();
    });
  }

  it("a mount bound to A does not read a decision linked only to B; an unattached one stays open to all", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    const w = seed(wg);
    const bOnly = wg.createDecision(
      {
        title: "B-ONLY-TITLE-q7",
        question: "B-ONLY-QUESTION-q7",
        severity: "human_required",
        ticketId: w.b.id,
      },
      human,
    );
    wg.createDecision(
      { title: "UNATTACHED-TITLE-q7", question: "unattached?", severity: "human_required" },
      human,
    );
    process.env.GAFFER_FACTORY = "1";
    process.env.GAFFER_SCOPE_TICKET = String(w.a.number);
    const h = makeHandlers(wg, mcpAgent);

    const pending = JSON.stringify(h.list_pending_decisions({}).structuredContent);
    expect(pending).not.toContain("B-ONLY");
    expect(pending).not.toContain(bOnly.id);
    expect(pending).toContain("UNATTACHED-TITLE-q7");
    expect(pending).toContain(SHARED_TITLE);

    // Reading B (no write follows from it) shows the decision on A and B, and B's own one
    // only as the generic blocker.
    const gotB = h.get_ticket({ ticket_id: w.b.id });
    const textB = JSON.stringify(gotB.structuredContent);
    expect(textB).not.toContain("B-ONLY");
    expect(textB).not.toContain(bOnly.id);
    expect(textB).toContain(SHARED_TITLE);
    expect(
      (gotB.structuredContent.blocking_decisions as Blocking).filter((d) => d.outside_scope),
    ).toEqual([{ id: null, title: null, outside_scope: true }]);
    wg.db.close();
  });

  it("outside the factory, and for a human actor, nothing is filtered", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    const w = seed(wg);
    wg.createDecision(
      { title: "B-ONLY-TITLE-q7", question: "?", severity: "human_required", ticketId: w.b.id },
      human,
    );
    for (const [actor, factory] of [
      [mcpAgent, false],
      [human, true],
    ] as const) {
      if (factory) {
        process.env.GAFFER_FACTORY = "1";
        process.env.GAFFER_SCOPE_TICKET = String(w.a.number);
      }
      const h = makeHandlers(wg, actor);
      expect(JSON.stringify(h.list_pending_decisions({}).structuredContent)).toContain(
        "B-ONLY-TITLE-q7",
      );
      expect(JSON.stringify(h.get_ticket({ ticket_id: w.b.id }).structuredContent)).toContain(
        "B-ONLY-TITLE-q7",
      );
    }
    wg.db.close();
  });
});

describe("one decision-visibility rule (CLI acting as a principal)", () => {
  function cli(db: string, args: string[], token: string) {
    return spawnSync(
      process.execPath,
      [join(__dirname, "../dist/cli/index.js"), "--db", db, ...args],
      {
        encoding: "utf8",
        env: { ...process.env, DISPATCH_AUDIT_OFF: "1", GAFFER_PRINCIPAL_TOKEN: token },
      },
    );
  }

  it("ticket show under an A-only principal hides the shared decision; A+B and the operator see it", () => {
    dir = mkdtempSync(join(tmpdir(), "decision-scope-"));
    const db = join(dir, "d.sqlite");
    const wg = Dispatch.open(db, undefined, nonEmptyDiffRunner, { testingEnabled: false });
    const w = seed(wg);
    const aOnly = mint(wg, "a-only", [w.a]);
    const both = mint(wg, "both", [w.a, w.b]);
    wg.db.close();

    const scoped = cli(db, ["ticket", "show", String(w.a.number)], aOnly);
    expect(scoped.status, scoped.stderr).toBe(0);
    expectNoRestricted(scoped.stdout, w, "CLI ticket show");
    const view = JSON.parse(scoped.stdout) as { blockingDecisions: Blocking };
    expect(view.blockingDecisions.filter((d) => d.outside_scope === true)).toEqual([
      { id: null, title: null, outside_scope: true },
    ]);

    for (const tok of [both, ""]) {
      const r = cli(db, ["ticket", "show", String(w.a.number)], tok);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain(SHARED_TITLE);
      expect(r.stdout).toContain(ANSWER);
    }
  });
});

describe("a request resolves its identity once", () => {
  /** The real resolver, answering only its first `n` lookups (then: revoked). */
  function flaky(wg: Dispatch, n: number): { calls: () => number } {
    let calls = 0;
    setPrincipalResolver((token): ResolvedPrincipal | null => {
      calls += 1;
      return calls <= n ? wg.resolvePrincipalToken(token) : null;
    });
    return { calls: () => calls };
  }

  it("a principal that stops resolving part way through never becomes the shared operator", async () => {
    const w = await start();
    const { base, wg, b } = w;
    const tok = mint(wg, "a-only", [w.a]);
    const lookups: string[] = [];
    for (let n = 1; n <= 6; n += 1) {
      const r = flaky(wg, n);
      // A read outside its scope.
      const read = await call(base, "GET", `/tickets/${b.id}`, tok);
      expect([401, 403], `read with ${n} good lookup(s): ${read.status}`).toContain(read.status);
      expect(read.text.includes("ticket B"), `read with ${n}`).toBe(false);
      lookups.push(`read n=${n}: ${r.calls()}`);

      // Principal administration, which only the shared token may do.
      const r2 = flaky(wg, n);
      const mintIt = await call(base, "POST", "/api/principals", tok, { name: `forged-${n}` });
      expect([401, 403], `mint with ${n} good lookup(s): ${mintIt.status}`).toContain(
        mintIt.status,
      );
      expect(wg.principals.getByName(`forged-${n}`), `minted with ${n}`).toBeFalsy();
      lookups.push(`write n=${n}: ${r2.calls()}`);
    }
    // One lookup per request, whatever the request does.
    expect(lookups).toEqual(lookups.map((l) => l.replace(/: \d+$/, ": 1")));
  });

  it("a principal token that does not resolve at all is refused (401), never the operator", async () => {
    const w = await start();
    const tok = mint(w.wg, "a-only", [w.a]);
    flaky(w.wg, 0);
    const read = await call(w.base, "GET", `/tickets/${w.b.id}`, tok);
    expect(read.status).toBe(401);
    const who = await call(w.base, "GET", "/api/whoami", tok);
    expect(who.status).toBe(401);
  });
});
