import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createApiServer } from "../src/api/server.js";
import {
  createPlanBuildRunner,
  type PlanBuildRequest,
  type PlanBuildResult,
  type PlanBuildRunner,
} from "../src/api/planBuild.js";
import { Dispatch } from "../src/core.js";
import { TestClock } from "../src/util/clock.js";

const STUB = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "decompose-stub.mjs");

// ===========================================================================
//  Runner unit tests — drives the REAL spawn path against a stub binary the
//  GAFFER_DECOMPOSE_BIN env points at (echoes a fixed JSON per GAFFER_STUB_MODE).
// ===========================================================================

function runnerForMode(mode: string, timeoutMs?: number): PlanBuildRunner {
  return createPlanBuildRunner(
    { GAFFER_DECOMPOSE_BIN: STUB, GAFFER_STUB_MODE: mode } as NodeJS.ProcessEnv,
    timeoutMs,
  );
}

describe("createPlanBuildRunner (spawns the decompose helper)", () => {
  it("returns a clarify turn from the helper's stdout", async () => {
    const result = await runnerForMode("clarify").run({ brief: "an app", history: [] });
    expect(result.phase).toBe("clarify");
    if (result.phase === "clarify") {
      expect(result.questions).toEqual(["Web or mobile?", "Which database?"]);
    }
  });

  it("returns a plan turn whose tickets match the create_epic shape", async () => {
    const result = await runnerForMode("plan").run({ brief: "gym tracker", history: [] });
    expect(result.phase).toBe("plan");
    if (result.phase === "plan") {
      const plan = result.plan as { epic: { name: string }; tickets: unknown[] };
      expect(plan.epic.name).toBe("Gym tracker");
      expect(plan.tickets).toHaveLength(2);
    }
  });

  it("maps the helper's own error phase (exit 1) to an error envelope", async () => {
    const result = await runnerForMode("error").run({ brief: "x", history: [] });
    expect(result).toEqual<PlanBuildResult>({ phase: "error", error: "brief too vague" });
  });

  it("turns non-JSON helper output into a clean error envelope", async () => {
    const result = await runnerForMode("badjson").run({ brief: "x", history: [] });
    expect(result.phase).toBe("error");
    if (result.phase === "error") expect(result.error).toMatch(/not valid JSON/i);
  });

  it("turns a hard crash (non-zero exit, no stdout) into an error envelope", async () => {
    const result = await runnerForMode("crash").run({ brief: "x", history: [] });
    expect(result.phase).toBe("error");
    if (result.phase === "error") expect(result.error).toMatch(/decompose blew up/);
  });

  it("times out a hung helper and returns an error envelope (never hangs)", async () => {
    const result = await runnerForMode("hang", 150).run({ brief: "x", history: [] });
    expect(result.phase).toBe("error");
    if (result.phase === "error") expect(result.error).toMatch(/timed out/i);
  });

  it("streams the brief + history to the child over stdin", async () => {
    const request: PlanBuildRequest = {
      brief: "build a thing",
      history: [{ role: "user", answer: "web" }],
    };
    const result = await runnerForMode("echo").run(request);
    expect(result.phase).toBe("clarify");
    if (result.phase === "clarify") {
      expect(JSON.parse(result.questions[0]!)).toEqual({
        brief: "build a thing",
        history: [{ role: "user", answer: "web" }],
      });
    }
  });

  it("streams the extend-existing context to the child over stdin", async () => {
    const context = {
      mode: "extend" as const,
      scopeNodeId: "node-1",
      scopeNodeName: "Checkout",
      scopeNodeType: "product",
    };
    const result = await runnerForMode("echo-context").run({
      brief: "add CSV export",
      history: [],
      context,
    });
    expect(result.phase).toBe("clarify");
    if (result.phase === "clarify") {
      expect(JSON.parse(result.questions[0]!)).toEqual({ context });
    }
  });

  it("omits context from the child payload entirely when none is given (greenfield)", async () => {
    const result = await runnerForMode("echo-context").run({ brief: "a new app", history: [] });
    expect(result.phase).toBe("clarify");
    if (result.phase === "clarify") {
      expect(JSON.parse(result.questions[0]!)).toEqual({ context: null });
    }
  });

  it("streams forcePlan to the child over stdin when set (build the tickets now)", async () => {
    const result = await runnerForMode("echo-force").run({
      brief: "build it now",
      history: [{ role: "user", answer: "web" }],
      forcePlan: true,
    });
    expect(result.phase).toBe("clarify");
    if (result.phase === "clarify") {
      expect(JSON.parse(result.questions[0]!)).toEqual({ forcePlan: true });
    }
  });

  it("omits forcePlan from the child payload entirely when not set (normal turn)", async () => {
    const result = await runnerForMode("echo-force").run({ brief: "an app", history: [] });
    expect(result.phase).toBe("clarify");
    if (result.phase === "clarify") {
      expect(JSON.parse(result.questions[0]!)).toEqual({ forcePlan: null });
    }
  });

  it("streams a FROZEN spec's clauses to the child over stdin (spec-driven build)", async () => {
    // Regression: the spec→decompose chain was dead because the frozen spec never reached
    // the runner. With the frontend now sending it, assert the runner threads it through.
    const result = await runnerForMode("echo-spec").run({
      brief: "build the spec",
      history: [],
      spec: [
        { clause_id: "c1", kind: "requirement", text: "adds two numbers" },
        { clause_id: "c2", kind: "non-goal", text: "no trigonometry" },
      ],
    });
    expect(result.phase).toBe("clarify");
    if (result.phase === "clarify") {
      expect(JSON.parse(result.questions[0]!)).toEqual({ specClauseIds: ["c1", "c2"] });
    }
  });

  it("strips DISPATCH_API_TOKEN from the child env (defence-in-depth)", async () => {
    const runner = createPlanBuildRunner({
      GAFFER_DECOMPOSE_BIN: STUB,
      GAFFER_STUB_MODE: "echo-token",
      DISPATCH_API_TOKEN: "super-secret",
    } as NodeJS.ProcessEnv);
    const result = await runner.run({ brief: "x", history: [] });
    expect(result.phase).toBe("clarify");
    if (result.phase === "clarify") expect(result.questions[0]).toBe("token:ABSENT");
  });

  it("falls back to an error envelope when the binary does not exist", async () => {
    const runner = createPlanBuildRunner({
      GAFFER_DECOMPOSE_BIN: join(STUB, "..", "does-not-exist.mjs"),
    } as NodeJS.ProcessEnv);
    const result = await runner.run({ brief: "x", history: [] });
    expect(result.phase).toBe("error");
  });
});

// ===========================================================================
//  REST tests — POST /plan-build wired with an injected fake runner, plus the
//  plan → POST /epics (create_epic) confirm path the panel performs.
// ===========================================================================

interface Harness {
  wg: Dispatch;
  baseUrl: string;
  calls: PlanBuildRequest[];
  close: () => Promise<void>;
}

async function startHarness(result: PlanBuildResult): Promise<Harness> {
  const wg = Dispatch.open(":memory:", new TestClock());
  const calls: PlanBuildRequest[] = [];
  const planBuild: PlanBuildRunner = {
    run(input) {
      calls.push(input);
      return Promise.resolve(result);
    },
  };
  // The product-owner runner is irrelevant here; pass a no-op so we never spawn.
  const noopPo = { run: () => ({ started: false, pid: null }) };
  const server = createApiServer(wg, noopPo, planBuild);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    wg,
    calls,
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

async function call(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

describe("POST /plan-build", () => {
  it("returns the clarify turn from the runner with a 200", async () => {
    const h = await startHarness({ phase: "clarify", questions: ["Web or mobile?"] });
    try {
      const res = await call(h.baseUrl, "POST", "/plan-build", { brief: "an app" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ phase: "clarify", questions: ["Web or mobile?"] });
      expect(h.calls).toEqual([{ brief: "an app", history: [] }]);
    } finally {
      await h.close();
    }
  });

  it("passes the accumulated history through to the runner", async () => {
    const h = await startHarness({ phase: "clarify", questions: ["Which DB?"] });
    try {
      const history = [
        { role: "assistant", questions: ["Web or mobile?"] },
        { role: "user", answer: "web" },
      ];
      await call(h.baseUrl, "POST", "/plan-build", { brief: "an app", history });
      expect(h.calls[0]).toEqual({ brief: "an app", history });
    } finally {
      await h.close();
    }
  });

  it("forwards the extend-existing context to the runner", async () => {
    const h = await startHarness({ phase: "clarify", questions: ["What exactly?"] });
    try {
      const context = {
        mode: "extend",
        scopeNodeId: "node-9",
        scopeNodeName: "Reports",
        scopeNodeType: "product",
      };
      await call(h.baseUrl, "POST", "/plan-build", { brief: "add export", history: [], context });
      expect(h.calls[0]).toEqual({ brief: "add export", history: [], context });
    } finally {
      await h.close();
    }
  });

  it("forwards a brownfield extend context carrying the target repo name", async () => {
    const h = await startHarness({ phase: "clarify", questions: ["Which screen?"] });
    try {
      const context = {
        mode: "extend",
        scopeNodeId: "node-7",
        scopeNodeName: "Billing",
        scopeNodeType: "product",
        repo: "billing-svc",
      };
      await call(h.baseUrl, "POST", "/plan-build", { brief: "add invoices", history: [], context });
      // The repo rides along inside context so decompose takes the existing-repo path.
      expect(h.calls[0]).toEqual({ brief: "add invoices", history: [], context });
      expect((h.calls[0]?.context as { repo?: string })?.repo).toBe("billing-svc");
    } finally {
      await h.close();
    }
  });

  it("omits context from the runner call when the body has none (greenfield)", async () => {
    const h = await startHarness({ phase: "clarify", questions: ["Q?"] });
    try {
      await call(h.baseUrl, "POST", "/plan-build", { brief: "a new app" });
      expect(h.calls[0]).toEqual({ brief: "a new app", history: [] });
      expect("context" in (h.calls[0] as object)).toBe(false);
    } finally {
      await h.close();
    }
  });

  it("forwards forcePlan to the runner (build the tickets now escape)", async () => {
    const plan = { epic: { name: "App" }, tickets: [{ title: "t", dependsOn: [] }] };
    const h = await startHarness({ phase: "plan", plan });
    try {
      const history = [
        { role: "assistant", questions: ["Web or mobile?"] },
        { role: "user", answer: "web" },
      ];
      const res = await call(h.baseUrl, "POST", "/plan-build", {
        brief: "an app",
        history,
        forcePlan: true,
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ phase: "plan", plan });
      expect(h.calls[0]).toEqual({ brief: "an app", history, forcePlan: true });
    } finally {
      await h.close();
    }
  });

  it("omits forcePlan from the runner call when the body has none (normal turn)", async () => {
    const h = await startHarness({ phase: "clarify", questions: ["Q?"] });
    try {
      await call(h.baseUrl, "POST", "/plan-build", { brief: "an app" });
      expect("forcePlan" in (h.calls[0] as object)).toBe(false);
    } finally {
      await h.close();
    }
  });

  it("rejects a context with an invalid mode with a 422", async () => {
    const h = await startHarness({ phase: "clarify", questions: [] });
    try {
      const res = await call(h.baseUrl, "POST", "/plan-build", {
        brief: "x",
        context: { mode: "sideways" },
      });
      expect(res.status).toBe(422);
      expect(h.calls).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it("returns a plan turn with a 200", async () => {
    const plan = { epic: { name: "App" }, tickets: [{ title: "t", dependsOn: [] }] };
    const h = await startHarness({ phase: "plan", plan });
    try {
      const res = await call(h.baseUrl, "POST", "/plan-build", { brief: "an app" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ phase: "plan", plan });
    } finally {
      await h.close();
    }
  });

  it("rides the helper's error phase back as a 200 envelope", async () => {
    const h = await startHarness({ phase: "error", error: "too vague" });
    try {
      const res = await call(h.baseUrl, "POST", "/plan-build", { brief: "x" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ phase: "error", error: "too vague" });
    } finally {
      await h.close();
    }
  });

  it("rejects a missing brief with a 422 and never calls the runner", async () => {
    const h = await startHarness({ phase: "clarify", questions: [] });
    try {
      const res = await call(h.baseUrl, "POST", "/plan-build", { history: [] });
      expect(res.status).toBe(422);
      expect(h.calls).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it("returns 405 for a non-POST method", async () => {
    const h = await startHarness({ phase: "clarify", questions: [] });
    try {
      const res = await call(h.baseUrl, "GET", "/plan-build");
      expect(res.status).toBe(405);
    } finally {
      await h.close();
    }
  });
});

describe("plan → create_epic confirm path", () => {
  it("a confirmed plan POSTs to /epics and lands draft tickets the Epics view can read", async () => {
    // The panel gets a plan from /plan-build, then (on human confirm) hands the
    // exact plan shape to POST /epics. That shape is what create_epic accepts.
    const plan = {
      epic: { name: "Gym tracker", description: "Track workouts" },
      tickets: [
        { title: "bootstrap", bootstrap: true, dependsOn: [] },
        { title: "model", acceptanceCriteria: ["persists"], dependsOn: [0] },
      ],
    };
    const h = await startHarness({ phase: "plan", plan });
    try {
      const planned = await call(h.baseUrl, "POST", "/plan-build", { brief: "gym app" });
      expect(planned.body.phase).toBe("plan");

      // Confirm: hand the plan straight to create_epic.
      const created = await call(h.baseUrl, "POST", "/epics", planned.body.plan);
      expect(created.status).toBe(201);
      const epicNodeId = created.body.epic_node_id as string;
      const numbers = created.body.ticket_numbers as number[];
      expect(numbers).toHaveLength(2);

      // The epic surfaces as a scope node of type "epic".
      const nodes = await call(h.baseUrl, "GET", "/scope/nodes");
      const epics = (nodes.body.nodes as Array<{ id: string; type: string }>).filter(
        (n) => n.type === "epic",
      );
      expect(epics.map((e) => e.id)).toContain(epicNodeId);

      // Tickets land as draft, are contained by the epic node (via `scopes`), and
      // the dependent ticket reports its blocker — everything the Epics view needs.
      // (The Epics view resolves ticket ids from the list the same way.)
      const all = (await call(h.baseUrl, "GET", "/tickets")).body.tickets as Array<{
        id: string;
        number: number;
        status: string;
      }>;
      const featureRow = all.find((t) => t.number === numbers[1])!;
      expect(featureRow.status).toBe("draft");
      const feature = await call(h.baseUrl, "GET", `/tickets/${featureRow.id}`);
      const scopes = feature.body.scopes as Array<{ id: string }>;
      expect(scopes.map((s) => s.id)).toContain(epicNodeId);
      const deps = feature.body.dependencies as Array<{ satisfied: boolean }>;
      expect(deps).toHaveLength(1);
      expect(deps[0]?.satisfied).toBe(false);
    } finally {
      await h.close();
    }
  });

  it("greenfield seam: create_epic rejects an unknown repo, accepts once it is stripped", async () => {
    // A bootstrap plan names a repo that does not exist yet (the runner registers
    // it later). The confirm path drops `repo`/`access` for unknown repos before
    // POSTing; this guards that contract end to end.
    const h = await startHarness({ phase: "error", error: "unused" });
    try {
      const greenfield = {
        epic: { name: "Greenfield app" },
        tickets: [
          { title: "bootstrap", bootstrap: true, repo: "brand-new-repo", dependsOn: [] },
          { title: "feature", repo: "brand-new-repo", dependsOn: [0] },
        ],
      };

      // As-is, the unknown repo is rejected — this is shipped create_epic policy.
      const rejected = await call(h.baseUrl, "POST", "/epics", greenfield);
      expect(rejected.status).toBe(404);

      // Strip repo/access for the (unknown) repo, exactly as confirmPlanBuild does.
      const known = new Set(
        (
          (await call(h.baseUrl, "GET", "/repositories")).body.repositories as Array<{
            name: string;
          }>
        ).map((r) => r.name),
      );
      const tickets = greenfield.tickets.map((t) => {
        if (t.repo && !known.has(t.repo)) {
          const { repo, ...rest } = t;
          void repo;
          return rest;
        }
        return t;
      });
      const created = await call(h.baseUrl, "POST", "/epics", { epic: greenfield.epic, tickets });
      expect(created.status).toBe(201);
      expect(created.body.ticket_numbers).toHaveLength(2);
    } finally {
      await h.close();
    }
  });
});
