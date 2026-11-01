/**
 * The OpenAPI response contract, checked against the LIVE routes.
 *
 *   schemas  — every operation spec.ts gives a response schema is called against a
 *              seeded server and its body is validated with that schema (the same
 *              zod object the document renders), so a route that changes its
 *              envelope or casing fails here.
 *   Location — every `Location` header a 201 emits answers a GET with 200 (POST
 *              /decisions and the principal / scope edge / scope repo creates used to
 *              point at URLs with no GET route).
 */

import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ZodType } from "zod";

import { setPrincipalResolver } from "../src/api/auth.js";
import * as R from "../src/api/openapi/responses.js";
import { ENDPOINTS } from "../src/api/openapi/spec.js";
import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { TestClock } from "../src/util/clock.js";
import { contractHash } from "../src/util/contractHash.js";

import { buildOpenApiDocument } from "../src/api/openapi/spec.js";

import {
  giveTicketRealDelivery,
  nonEmptyDiffRunner,
  shownCommits,
  testWeakeningDiffRunner,
} from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };
const reviewer: Actor = { type: "human", id: "rev" };
const agentActor: Actor = { type: "agent", id: "agent-runner" };
const FULL = "shared-full-token-for-openapi-response-tests-0123";

let base = "";
let wg: Dispatch;
let close: () => Promise<void>;
const saved = process.env.DISPATCH_API_TOKEN;

beforeEach(async () => {
  process.env.DISPATCH_AUDIT_OFF = "1";
  process.env.DISPATCH_API_TOKEN = FULL;
  wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner, { testingEnabled: false });
  const server = createApiServer(wg);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () =>
    new Promise<void>((resolve) =>
      server.close(() => {
        wg.db.close();
        resolve();
      }),
    );
});
afterEach(async () => {
  await close();
  setPrincipalResolver(null);
  if (saved === undefined) delete process.env.DISPATCH_API_TOKEN;
  else process.env.DISPATCH_API_TOKEN = saved;
});

interface Res {
  status: number;
  location: string | null;
  body: unknown;
}
async function call(method: string, path: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${FULL}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, location: res.headers.get("location"), body: await res.json() };
}

/** Operation key → the response schema spec.ts declares for its success status. */
const DECLARED = new Map<string, keyof typeof R>();
for (const e of ENDPOINTS) {
  const r = e.responses.find((x) => x.status < 300 && x.schema);
  if (r?.schema) DECLARED.set(`${e.method} ${e.path}`, r.schema);
}
const checked = new Set<string>();

/** Call an operation and validate its body with the schema spec.ts names for it. */
async function expectContract(
  op: string,
  path: string,
  body?: unknown,
  status = 200,
): Promise<Res> {
  const [method, specPath] = op.split(" ") as [string, string];
  const name = DECLARED.get(op);
  expect(name, `${op} declares a response schema`).toBeDefined();
  const res = await call(method, path ?? specPath, body);
  expect(res.status, `${op}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(status);
  const parsed = (R[name!] as ZodType).safeParse(res.body);
  expect(parsed.success, `${op} body vs ${name}: ${JSON.stringify(parsed.error?.issues)}`).toBe(
    true,
  );
  checked.add(op);
  return res;
}

function deliver(ticketId: string): void {
  const agent = wg.registerAgent({ display_name: `a-${ticketId}` }, human);
  const claim = wg.claimTicket(
    { ticket_id: ticketId, agent_id: agent.id, ttl_seconds: 300 },
    agentActor,
  );
  giveTicketRealDelivery(wg, ticketId, human, { repoName: `delivery-${ticketId}` });
  wg.recordDeliveryArtifact(
    { claim_token: claim.claimToken, ticket_id: ticketId, branch_name: "feat/x" },
    agentActor,
  );
  wg.submitForReview({ claimToken: claim.claimToken, ticket_id: ticketId }, agentActor);
}

describe("OpenAPI response schemas match the live routes", () => {
  it("every schema'd operation's live body validates", async () => {
    // --- tickets ---------------------------------------------------------------
    const created = await expectContract("POST /tickets", "/tickets", { title: "Ship" }, 201);
    const id = (created.body as { ticket: { id: string } }).ticket.id;
    await expectContract("GET /tickets", "/tickets");
    await expectContract("GET /tickets", "/tickets?fields=summary&limit=1");
    await expectContract("GET /tickets/:id", `/tickets/${id}`);
    await expectContract("GET /tickets/details", `/tickets/details?ids=${id},missing-id`);
    await expectContract(
      "GET /tickets/details",
      "/tickets/details?include=repositories,scopes,dependencies,rework_trail,events,evidence&limit=2",
    );
    await expectContract(
      "POST /tickets/:id/acceptance-criteria",
      `/tickets/${id}/acceptance-criteria`,
      { text: "works" },
      201,
    );
    // cli-wg/F-02: the contract edits (and the create-time pack warning).
    const strict = await expectContract(
      "POST /tickets",
      "/tickets",
      { title: "Strict", policy_pack: "team_light" },
      201,
    );
    expect((strict.body as { warnings?: unknown[] }).warnings).toHaveLength(1);
    await expectContract("PATCH /tickets/:id", `/tickets/${id}`, { description: "why" });
    const extra = await call("POST", `/tickets/${id}/acceptance-criteria`, { text: "extra" });
    const extraId = (extra.body as { acceptance_criterion: { id: string } }).acceptance_criterion
      .id;
    await expectContract(
      "PATCH /tickets/:id/acceptance-criteria/:acId",
      `/tickets/${id}/acceptance-criteria/${extraId}`,
      { verification_method: "unit test" },
    );
    await expectContract(
      "DELETE /tickets/:id/acceptance-criteria/:acId",
      `/tickets/${id}/acceptance-criteria/${extraId}`,
    );
    await expectContract("POST /tickets/:id/testable", `/tickets/${id}/testable`, {
      can_be_tested: true,
    });
    await expectContract(
      "POST /tickets/:id/allow-test-changes",
      `/tickets/${id}/allow-test-changes`,
      { allow_test_changes: true },
    );
    await expectContract("POST /tickets/:id/test-contract", `/tickets/${id}/test-contract`, {
      run_command: "npm start",
    });
    await expectContract("POST /tickets/:id/mono-fallback", `/tickets/${id}/mono-fallback`);
    await expectContract("POST /tickets/:id/ready", `/tickets/${id}/ready`);
    await expectContract("POST /tickets/:id/move", `/tickets/${id}/move`, { to: "draft" });

    // --- review / merge ----------------------------------------------------------
    const t1 = wg.createTicket({ title: "a", policy_pack: "solo_loose" }, human);
    wg.addAcceptanceCriterion({ ticket_id: t1.id, text: "AC" }, human);
    wg.markReady(t1.id, human);
    deliver(t1.id);
    await expectContract("GET /tickets/:id/diff", `/tickets/${t1.id}/diff`);
    await expectContract(
      "POST /tickets/:id/review/approve",
      `/tickets/${t1.id}/review/approve`,
      shownCommits(wg, t1.id),
    );
    await expectContract("POST /tickets/:id/mark-merged", `/tickets/${t1.id}/mark-merged`);
    await expectContract(
      "POST /tickets/:id/reopen-for-review",
      `/tickets/${t1.id}/reopen-for-review`,
      { reason: "conflict", resolution: "kept both" },
    );
    await expectContract("POST /tickets/:id/review/reject", `/tickets/${t1.id}/review/reject`, {
      reason: "needs a test",
      to: "refining",
    });
    await expectContract("POST /tickets/:id/wont-do", `/tickets/${t1.id}/wont-do`, {
      reason: "superseded",
    });
    await expectContract("POST /tickets/:id/reopen", `/tickets/${t1.id}/reopen`, {});

    // --- the tester verdict (acceptance ticket in_testing) ------------------------
    wg.registerRepository({ name: "app", default_branch: "main" }, human);
    const epic = wg.createEpic(
      {
        epic: { name: "E", description: "d" },
        tickets: [{ title: "Store", acceptanceCriteria: ["a"], repo: "app" }],
      },
      human,
    );
    const [impl, acc] = (epic.ticketNumbers as number[]).map((n) => wg.resolveTicket(`#${n}`).id);
    for (const t of [impl!, acc!]) {
      wg.markReady(t, human);
      deliver(t);
      wg.approveReview(t, reviewer);
      if (t === impl) wg.markMerged(t, { type: "system" });
    }
    await expectContract("POST /tickets/:id/tester", `/tickets/${acc}/tester`, {
      verdict: "pass",
      summary: "bound",
      tested_commit: "0123456789abcdef0123456789abcdef01234567",
      contract_hash: contractHash(wg.db, acc!),
      replay: "passed",
    });

    // --- decisions -----------------------------------------------------------------
    const d = await expectContract(
      "POST /decisions",
      "/decisions",
      { title: "t", question: "q" },
      201,
    );
    const dId = (d.body as { decision: { id: string } }).decision.id;
    await expectContract("GET /decisions/:id", `/decisions/${dId}`);
    await expectContract("POST /decisions/:id/resolve", `/decisions/${dId}/resolve`, {
      status: "accepted",
      answer: "yes",
    });

    // --- principals ----------------------------------------------------------------
    await expectContract("GET /api/whoami", "/api/whoami");
    await expectContract("POST /api/principals", "/api/principals", { name: "ci" }, 201);
    await expectContract("GET /api/principals/:id", "/api/principals/ci");
    await expectContract("DELETE /api/principals/:id", "/api/principals/ci");

    // Every operation that declares a schema was exercised.
    expect([...DECLARED.keys()].filter((k) => !checked.has(k))).toEqual([]);
  });

  it("the testable / mono-fallback bodies are snake_case (camelCase kept as deprecated twins)", async () => {
    const t = wg.createTicket({ title: "x", policy_pack: "solo_loose" }, human);
    const r = await call("POST", `/tickets/${t.id}/testable`, { can_be_tested: true });
    expect(r.body).toMatchObject({ ticket_id: t.id, can_be_tested: true, ticketId: t.id });
    const m = await call("POST", `/tickets/${t.id}/mono-fallback`);
    expect(m.body).toMatchObject({ applied: false, ticket_id: t.id });
  });
});

describe("GET /tickets/:id/diff documents its risk annotations", () => {
  it("a live test-modified annotation validates against TicketDiff, RiskAnnotation is a component", async () => {
    const w = Dispatch.open(":memory:", new TestClock(), testWeakeningDiffRunner, {
      testingEnabled: false,
    });
    const server = createApiServer(w);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const t = w.createTicket({ title: "weaken", policy_pack: "solo_loose" }, human);
      giveTicketRealDelivery(w, t.id, human);
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/tickets/${t.id}/diff`, {
        headers: { authorization: `Bearer ${FULL}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        repos: Array<{ riskAnnotations: Array<{ kind: string }> }>;
      };
      const parsed = R.TicketDiff.safeParse(body);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      expect(body.repos.flatMap((r) => r.riskAnnotations.map((a) => a.kind))).toContain(
        "test-modified",
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      w.db.close();
    }

    const doc = buildOpenApiDocument() as {
      components: { schemas: Record<string, Record<string, unknown>> };
    };
    const schemas = doc.components.schemas;
    expect(schemas.RiskKind?.enum).toContain("test-modified");
    expect(JSON.stringify(schemas.RepoDiff)).toContain(
      '"$ref":"#/components/schemas/RiskAnnotation"',
    );
    expect(JSON.stringify(schemas.RiskAnnotation)).toContain(
      '"$ref":"#/components/schemas/RiskKind"',
    );
    expect(JSON.stringify(schemas.TicketDiff)).toContain('"$ref":"#/components/schemas/RepoDiff"');
  });
});

describe("every Location header answers a GET", () => {
  it("tickets, decisions, principals, scope nodes / edges / repos, specs, plan sessions, epics", async () => {
    const repo = wg.registerRepository({ name: "svc", path: "/tmp/svc" }, human);
    const creates: Array<[string, unknown]> = [
      ["/tickets", { title: "t" }],
      ["/decisions", { title: "t", question: "q" }],
      ["/api/principals", { name: "loc" }],
      ["/specs", { title: "s" }],
      ["/plan-sessions", {}],
      ["/epics", { epic: { name: "E2", acceptance: false }, tickets: [{ title: "x" }] }],
    ];
    const n1 = await call("POST", "/scope/nodes", { name: "A", type: "product" });
    const n2 = await call("POST", "/scope/nodes", { name: "B", type: "service" });
    const a = (n1.body as { node: { id: string } }).node.id;
    const b = (n2.body as { node: { id: string } }).node.id;
    creates.push(["/scope/edges", { from_node_id: a, to_node_id: b, relation: "contains" }]);
    creates.push(["/scope/repos", { scope_node_id: a, repo_id: repo.id }]);
    const locations = [n1.location];
    for (const [path, body] of creates) {
      const r = await call("POST", path, body);
      expect(r.status, `${path}: ${JSON.stringify(r.body)}`).toBe(201);
      locations.push(r.location);
    }
    for (const loc of locations) {
      expect(loc).toMatch(/^\//);
      const r = await call("GET", loc!);
      expect(r.status, `GET ${loc}`).toBe(200);
    }
  });
});
