import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createApiServer } from "../src/api/server.js";
import {
  createSpecAuthorRunner,
  type SpecAuthorRequest,
  type SpecAuthorResult,
  type SpecAuthorRunner,
} from "../src/api/specAuthor.js";
import { Dispatch } from "../src/core.js";
import { TestClock } from "../src/util/clock.js";

const STUB = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "spec-author-stub.mjs");

// ===========================================================================
//  Runner unit tests — drives the REAL spawn path against a stub binary the
//  GAFFER_SPEC_AUTHOR_BIN env points at (echoes a fixed JSON per GAFFER_STUB_MODE).
// ===========================================================================

function runnerForMode(mode: string, timeoutMs?: number): SpecAuthorRunner {
  return createSpecAuthorRunner(
    { GAFFER_SPEC_AUTHOR_BIN: STUB, GAFFER_STUB_MODE: mode } as NodeJS.ProcessEnv,
    timeoutMs,
  );
}

describe("createSpecAuthorRunner (spawns the spec-author helper)", () => {
  it("returns a clarify turn from the helper's stdout", async () => {
    const result = await runnerForMode("clarify").run({ brief: "an app", history: [] });
    expect(result.phase).toBe("clarify");
    if (result.phase === "clarify") {
      expect(result.questions).toEqual(["Web or mobile?", "Which database?"]);
    }
  });

  it("returns a spec turn whose clauses match the create_spec shape", async () => {
    const result = await runnerForMode("spec").run({ brief: "gym tracker", history: [] });
    expect(result.phase).toBe("spec");
    if (result.phase === "spec") {
      const spec = result.spec as { clauses: Array<{ clause_id: string; kind: string }> };
      expect(spec.clauses).toHaveLength(2);
      expect(spec.clauses[0]!.clause_id).toBe("c1");
      expect(spec.clauses[0]!.kind).toBe("requirement");
      expect(spec.clauses[1]!.kind).toBe("non-goal");
    }
  });

  it("maps the helper's own error phase (exit 1) to an error envelope", async () => {
    const result = await runnerForMode("error").run({ brief: "x", history: [] });
    expect(result).toEqual<SpecAuthorResult>({ phase: "error", error: "brief too vague" });
  });

  it("turns non-JSON helper output into a clean error envelope", async () => {
    const result = await runnerForMode("badjson").run({ brief: "x", history: [] });
    expect(result.phase).toBe("error");
    if (result.phase === "error") expect(result.error).toMatch(/not valid JSON/i);
  });

  it("turns a hard crash (non-zero exit, no stdout) into an error envelope", async () => {
    const result = await runnerForMode("crash").run({ brief: "x", history: [] });
    expect(result.phase).toBe("error");
    if (result.phase === "error") expect(result.error).toMatch(/spec-author blew up/);
  });

  it("times out a hung helper and returns an error envelope (never hangs)", async () => {
    const result = await runnerForMode("hang", 150).run({ brief: "x", history: [] });
    expect(result.phase).toBe("error");
    if (result.phase === "error") expect(result.error).toMatch(/timed out/i);
  });

  it("streams the brief + history to the child over stdin", async () => {
    const request: SpecAuthorRequest = {
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

  it("streams the free-text context to the child over stdin when present", async () => {
    const result = await runnerForMode("echo-context").run({
      brief: "add CSV export",
      history: [],
      context: "existing repo uses Vite + React",
    });
    expect(result.phase).toBe("clarify");
    if (result.phase === "clarify") {
      expect(JSON.parse(result.questions[0]!)).toEqual({
        context: "existing repo uses Vite + React",
      });
    }
  });

  it("omits context from the child payload entirely when none is given", async () => {
    const result = await runnerForMode("echo-context").run({ brief: "a new app", history: [] });
    expect(result.phase).toBe("clarify");
    if (result.phase === "clarify") {
      expect(JSON.parse(result.questions[0]!)).toEqual({ context: null });
    }
  });

  it("streams forcePlan to the child over stdin when set (draft the spec now)", async () => {
    const result = await runnerForMode("echo-force").run({
      brief: "draft it now",
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

  it("strips DISPATCH_API_TOKEN from the child env (defence-in-depth)", async () => {
    const runner = createSpecAuthorRunner({
      GAFFER_SPEC_AUTHOR_BIN: STUB,
      GAFFER_STUB_MODE: "echo-token",
      DISPATCH_API_TOKEN: "super-secret",
    } as NodeJS.ProcessEnv);
    const result = await runner.run({ brief: "x", history: [] });
    expect(result.phase).toBe("clarify");
    if (result.phase === "clarify") expect(result.questions[0]).toBe("token:ABSENT");
  });

  it("falls back to an error envelope when the binary does not exist", async () => {
    const runner = createSpecAuthorRunner({
      GAFFER_SPEC_AUTHOR_BIN: join(STUB, "..", "does-not-exist.mjs"),
    } as NodeJS.ProcessEnv);
    const result = await runner.run({ brief: "x", history: [] });
    expect(result.phase).toBe("error");
  });
});

// ===========================================================================
//  REST tests — POST /spec-build wired with an injected fake runner.
// ===========================================================================

interface Harness {
  wg: Dispatch;
  baseUrl: string;
  calls: SpecAuthorRequest[];
  close: () => Promise<void>;
}

async function startHarness(result: SpecAuthorResult): Promise<Harness> {
  const wg = Dispatch.open(":memory:", new TestClock());
  const calls: SpecAuthorRequest[] = [];
  const specAuthor: SpecAuthorRunner = {
    run(input) {
      calls.push(input);
      return Promise.resolve(result);
    },
  };
  // The other runners are irrelevant here; use defaults except the last param
  // (specAuthorRunner) which we inject. All positional slots up to it are defaults.
  const noopPo = { run: () => ({ started: false, pid: null }) };
  const server = createApiServer(
    wg,
    noopPo,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    specAuthor,
  );
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

describe("POST /spec-build", () => {
  it("returns the clarify turn from the runner with a 200 (continues the turn)", async () => {
    const h = await startHarness({ phase: "clarify", questions: ["Web or mobile?"] });
    try {
      const res = await call(h.baseUrl, "POST", "/spec-build", { brief: "an app" });
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
      await call(h.baseUrl, "POST", "/spec-build", { brief: "an app", history });
      expect(h.calls[0]).toEqual({ brief: "an app", history });
    } finally {
      await h.close();
    }
  });

  it("passes a spec turn straight through as a 200 envelope", async () => {
    const spec = {
      clauses: [{ clause_id: "c1", kind: "requirement", text: "does the thing" }],
    };
    const h = await startHarness({ phase: "spec", spec });
    try {
      const res = await call(h.baseUrl, "POST", "/spec-build", { brief: "an app" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ phase: "spec", spec });
    } finally {
      await h.close();
    }
  });

  it("forwards the free-text context to the runner when present", async () => {
    const h = await startHarness({ phase: "clarify", questions: ["Q?"] });
    try {
      await call(h.baseUrl, "POST", "/spec-build", {
        brief: "add export",
        history: [],
        context: "existing repo uses Vite + React",
      });
      expect(h.calls[0]).toEqual({
        brief: "add export",
        history: [],
        context: "existing repo uses Vite + React",
      });
    } finally {
      await h.close();
    }
  });

  it("omits context from the runner call when the body has none", async () => {
    const h = await startHarness({ phase: "clarify", questions: ["Q?"] });
    try {
      await call(h.baseUrl, "POST", "/spec-build", { brief: "a new app" });
      expect("context" in (h.calls[0] as object)).toBe(false);
    } finally {
      await h.close();
    }
  });

  it("forwards forcePlan to the runner (draft the spec now escape)", async () => {
    const spec = { clauses: [{ clause_id: "c1", kind: "requirement", text: "x" }] };
    const h = await startHarness({ phase: "spec", spec });
    try {
      const res = await call(h.baseUrl, "POST", "/spec-build", {
        brief: "an app",
        history: [],
        forcePlan: true,
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ phase: "spec", spec });
      expect(h.calls[0]).toEqual({ brief: "an app", history: [], forcePlan: true });
    } finally {
      await h.close();
    }
  });

  it("omits forcePlan from the runner call when the body has none (normal turn)", async () => {
    const h = await startHarness({ phase: "clarify", questions: ["Q?"] });
    try {
      await call(h.baseUrl, "POST", "/spec-build", { brief: "an app" });
      expect("forcePlan" in (h.calls[0] as object)).toBe(false);
    } finally {
      await h.close();
    }
  });

  it("rides the helper's error phase back as a 200 envelope", async () => {
    const h = await startHarness({ phase: "error", error: "too vague" });
    try {
      const res = await call(h.baseUrl, "POST", "/spec-build", { brief: "x" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ phase: "error", error: "too vague" });
    } finally {
      await h.close();
    }
  });

  // NEGATIVE CONTROL: a malformed body (missing/blank brief) is rejected at the
  // Zod boundary with a 422 and NEVER reaches the runner (no spawn, no cost).
  it("rejects a missing brief with a 422 and never calls the runner", async () => {
    const h = await startHarness({ phase: "clarify", questions: [] });
    try {
      const res = await call(h.baseUrl, "POST", "/spec-build", { history: [] });
      expect(res.status).toBe(422);
      expect(h.calls).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it("rejects a blank brief with a 422 and never calls the runner", async () => {
    const h = await startHarness({ phase: "clarify", questions: [] });
    try {
      const res = await call(h.baseUrl, "POST", "/spec-build", { brief: "   " });
      expect(res.status).toBe(422);
      expect(h.calls).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it("returns 405 for a non-POST method", async () => {
    const h = await startHarness({ phase: "clarify", questions: [] });
    try {
      const res = await call(h.baseUrl, "GET", "/spec-build");
      expect(res.status).toBe(405);
    } finally {
      await h.close();
    }
  });
});
