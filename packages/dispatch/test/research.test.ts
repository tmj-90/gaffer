/**
 * RESEARCH RUNS (backlog 69): the research object in front of the spec step.
 *
 *   - the migration: a fresh database has research_runs at schema_version 35, and the
 *     state export leaves it out on purpose;
 *   - create / read / edit / keep / drop / add / discard, and the marks recomputed from
 *     the stored log (a mark the model set is ignored; a URL that fails the rules is
 *     dropped);
 *   - drafting the spec: the exact clause text and kinds, the back-reference, could and
 *     dropped items left out, findings never carried;
 *   - person-only: an agent or system actor is refused for every write;
 *   - REST: one run per plan session; the shared token and a human or admin principal may
 *     act; a read token, a read principal and a scoped principal are refused; the
 *     launcher's result is stored when it exits;
 *   - MCP: no tool writes (or reads) research.
 */
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deriveReadToken, setPrincipalResolver } from "../src/api/auth.js";
import { resetIsolationStatus } from "../src/api/isolation.js";
import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import { SCHEMA_VERSION } from "../src/db/schema.js";
import type { Actor } from "../src/domain/types.js";
import { EXCLUDED_TABLES, EXPORT_TABLES } from "../src/io/stateExport.js";
import { toolSchemas } from "../src/mcp/tools.js";
import { parseSpecClauses } from "../src/domain/types.js";
import { TestClock } from "../src/util/clock.js";

const human: Actor = { type: "human", id: "tom" };
const agent: Actor = { type: "agent", id: "agent-1" };
const system: Actor = { type: "system", id: "runner" };

function open(): Dispatch {
  process.env.DISPATCH_AUDIT_OFF = "1";
  return Dispatch.open(":memory:", new TestClock());
}

/** What runner/bin/research-run.mjs prints on success (already validated there). */
function launcherOutput() {
  return {
    phase: "research",
    result: {
      summary: "Trackers exist; quick logging matters.",
      findings: [
        {
          id: "f1",
          claim: "Strong leads.",
          why: "Sets the bar",
          // A mark the model (or a forged row) set is ignored and recomputed.
          sources: [
            { url: "https://www.strong.app/", host: "www.strong.app", fetched: false },
            { url: "https://never.fetched.org/x", host: "never.fetched.org", fetched: true },
          ],
        },
        {
          id: "f2",
          claim: "People want offline use.",
          why: "",
          sources: [{ url: "https://never.fetched.org/y" }],
        },
        { id: "f3", claim: "A bad link.", why: "", sources: [{ url: "http://www.strong.app/" }] },
      ],
      comparables: [{ name: "Strong", note: "iOS", source: { url: "https://www.strong.app/" } }],
      features: [
        {
          id: "ft1",
          title: "Log sets quickly",
          description: "Two taps per set.",
          priority: "must",
          backed_by: ["f1"],
        },
        {
          id: "ft2",
          title: "Offline mode",
          description: "Works with no signal.",
          priority: "should",
          backed_by: ["f2"],
        },
        { id: "ft3", title: "Themes", description: "", priority: "could", backed_by: [] },
        {
          id: "ft4",
          title: "Social feed",
          description: "Share workouts.",
          priority: "wont",
          backed_by: [],
        },
      ],
      open_questions: [
        { id: "q1", text: "Which platforms first?" },
        { id: "q2", text: "Free or paid?" },
      ],
      risks: [{ id: "k1", text: "Crowded market" }],
      dropped_urls: 0,
      injected: "<script>x</script>",
    },
    log: {
      fetches: [
        { url: "https://www.strong.app/", host: "www.strong.app", ts: "2026-11-28T00:00:00Z" },
      ],
      searches: [{ query: "gym tracker", ts: "2026-11-28T00:00:00Z" }],
    },
  };
}

describe("research runs: schema", () => {
  it("creates research_runs at schema_version 35 and leaves it out of the export on purpose", () => {
    const wg = open();
    expect(SCHEMA_VERSION).toBe(35);
    const cols = (
      wg.db.prepare("PRAGMA table_info(research_runs)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "idea",
        "status",
        "features_json",
        "log_json",
        "plan_session_id",
        "spec_id",
      ]),
    );
    expect((EXPORT_TABLES as readonly string[]).includes("research_runs")).toBe(false);
    expect(EXCLUDED_TABLES.research_runs).toMatch(/spec drafted from it/);
    wg.db.close();
  });
});

describe("research runs: the service", () => {
  it("stores a run, recomputes every mark from the log, keeps nothing outside the schema", () => {
    const wg = open();
    const { run, started } = wg.researchSvc.startRun({ idea: "a gym workout tracker" }, human);
    expect(started).toBe(true);
    expect(run.status).toBe("running");
    const done = wg.researchSvc.completeRun(run.id, launcherOutput());
    expect(done.status).toBe("ready");
    const [f1, f2, f3] = done.findings;
    expect(f1!.sources.map((s) => [s.url, s.fetched])).toEqual([
      ["https://www.strong.app/", true],
      ["https://never.fetched.org/x", false],
    ]);
    expect(f1!.opinion).toBe(false);
    expect(f2!.opinion).toBe(true);
    expect(f3!.sources).toEqual([]);
    expect(done.dropped_urls).toBe(1);
    expect(done.features.find((f) => f.id === "ft1")!.unsupported).toBe(false);
    expect(done.features.find((f) => f.id === "ft2")!.unsupported).toBe(true);
    expect(done.features.every((f) => f.kept && f.origin === "agent")).toBe(true);
    expect(JSON.stringify(wg.db.prepare("SELECT * FROM research_runs").all())).not.toContain(
      "<script>",
    );
    expect(done.log.fetches).toHaveLength(1);
    // A second result for the same run is refused.
    expect(() => wg.researchSvc.completeRun(run.id, launcherOutput())).toThrow(/not running/);
    wg.db.close();
  });

  it("refuses a result over a cap and records it as a failure", () => {
    const wg = open();
    const { run } = wg.researchSvc.startRun({ idea: "x idea" }, human);
    const out = launcherOutput();
    out.result.summary = "s".repeat(1201);
    const failed = wg.researchSvc.completeRun(run.id, out);
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/schema/);
    wg.db.close();
  });

  it("edits: keep, drop, reword, re-rank, add a person's feature, keep or drop a question", () => {
    const wg = open();
    const { run } = wg.researchSvc.startRun({ idea: "a gym workout tracker" }, human);
    wg.researchSvc.completeRun(run.id, launcherOutput());
    const edited = wg.researchSvc.editRun(
      run.id,
      {
        features: [
          {
            id: "ft1",
            title: "Log sets in two taps",
            description: "Fast.",
            priority: "must",
            kept: true,
          },
          {
            id: "ft2",
            title: "Offline mode",
            description: "Works with no signal.",
            priority: "should",
            kept: false,
          },
          { id: "ft3", title: "Themes", description: "", priority: "could", kept: true },
          {
            id: "ft4",
            title: "Social feed",
            description: "Share workouts.",
            priority: "wont",
            kept: true,
          },
          { title: "Export CSV", description: "Own your data.", priority: "should", kept: true },
        ],
        open_questions: [{ id: "q2", kept: false }],
      },
      human,
    );
    expect(edited.features.map((f) => [f.id, f.kept])).toEqual([
      ["ft1", true],
      ["ft2", false],
      ["ft3", true],
      ["ft4", true],
      ["p1", true],
    ]);
    expect(edited.features[0]!.title).toBe("Log sets in two taps");
    expect(edited.features[4]!.origin).toBe("person");
    expect(edited.features[4]!.unsupported).toBe(true);
    expect(edited.open_questions.map((q) => [q.id, q.kept])).toEqual([
      ["q1", true],
      ["q2", false],
    ]);
    wg.db.close();
  });

  it("drafts the spec deterministically from what was kept, with a back-reference", () => {
    const wg = open();
    const { run } = wg.researchSvc.startRun(
      { idea: "a gym workout tracker", repo: "gym-app" },
      human,
    );
    wg.researchSvc.completeRun(run.id, launcherOutput());
    wg.researchSvc.editRun(
      run.id,
      {
        features: [
          {
            id: "ft1",
            title: "Log sets quickly",
            description: "Two taps per set.",
            priority: "must",
            kept: true,
          },
          {
            id: "ft2",
            title: "Offline mode",
            description: "Works with no signal.",
            priority: "should",
            kept: false,
          },
          { id: "ft3", title: "Themes", description: "", priority: "could", kept: true },
          {
            id: "ft4",
            title: "Social feed",
            description: "Share workouts.",
            priority: "wont",
            kept: true,
          },
          { title: "Export CSV", description: "", priority: "should", kept: true },
        ],
        open_questions: [{ id: "q2", kept: false }],
      },
      human,
    );
    const { spec, research } = wg.researchSvc.draftSpec(run.id, human);
    expect(spec.status).toBe("draft");
    expect(spec.title).toBe("a gym workout tracker");
    expect(spec.brief).toBe("a gym workout tracker");
    expect(spec.target_repo).toBe("gym-app");
    const clauses = parseSpecClauses(spec.clauses_json);
    expect(clauses.map((c) => [c.clause_id, c.kind, c.text])).toEqual([
      [`${spec.id}:research-ft1`, "requirement", "Log sets quickly: Two taps per set."],
      [`${spec.id}:research-p1`, "requirement", "Export CSV"],
      [`${spec.id}:research-ft4`, "non-goal", "Social feed: Share workouts."],
      [`${spec.id}:research-q1`, "decision", "To decide: Which platforms first?"],
    ]);
    expect(clauses[0]!.rationale).toBe(`From research ${run.id}, feature ft1 (must).`);
    expect(clauses[1]!.rationale).toBe(
      `From research ${run.id}, feature p1 (should, added by a person).`,
    );
    expect(JSON.stringify(clauses)).not.toMatch(/strong\.app|Strong leads|Crowded/);
    expect(research.spec_id).toBe(spec.id);
    // Once drafted, the run is closed for edits; the spec is edited instead.
    expect(() => wg.researchSvc.draftSpec(run.id, human)).toThrow(/already drafted/);
    expect(() => wg.researchSvc.editRun(run.id, { open_questions: [] }, human)).toThrow(
      /already drafted/,
    );
    // The existing freeze carries on unchanged.
    expect(wg.freezeSpec(spec.id, human).status).toBe("frozen");
    wg.db.close();
  });

  it("refuses to draft when nothing a spec can carry is kept", () => {
    const wg = open();
    const { run } = wg.researchSvc.startRun({ idea: "an idea" }, human);
    wg.researchSvc.completeRun(run.id, launcherOutput());
    wg.researchSvc.editRun(
      run.id,
      {
        features: [{ id: "ft3", title: "Themes", description: "", priority: "could", kept: true }],
        open_questions: [
          { id: "q1", kept: false },
          { id: "q2", kept: false },
        ],
      },
      human,
    );
    expect(() => wg.researchSvc.draftSpec(run.id, human)).toThrow(/Nothing is kept/);
    wg.db.close();
  });

  it("is a person's object: an agent or the system is refused for every write", () => {
    const wg = open();
    for (const actor of [agent, system]) {
      expect(() => wg.researchSvc.startRun({ idea: "x" }, actor)).toThrow(/person's act/);
    }
    const { run } = wg.researchSvc.startRun({ idea: "an idea" }, human);
    wg.researchSvc.completeRun(run.id, launcherOutput());
    for (const actor of [agent, system]) {
      expect(() => wg.researchSvc.editRun(run.id, { open_questions: [] }, actor)).toThrow(
        /person's act/,
      );
      expect(() => wg.researchSvc.draftSpec(run.id, actor)).toThrow(/person's act/);
      expect(() => wg.researchSvc.discardRun(run.id, actor)).toThrow(/person's act/);
    }
    expect(wg.researchSvc.discardRun(run.id, { type: "admin", id: "boss" }).status).toBe(
      "discarded",
    );
    wg.db.close();
  });

  it("gives one run per plan session", () => {
    const wg = open();
    const a = wg.researchSvc.startRun({ idea: "one", plan_session_id: "ps-1" }, human);
    const b = wg.researchSvc.startRun({ idea: "two", plan_session_id: "ps-1" }, human);
    expect(a.started).toBe(true);
    expect(b.started).toBe(false);
    expect(b.run.id).toBe(a.run.id);
    wg.db.close();
  });
});

describe("research runs: MCP", () => {
  it("has no MCP tool that writes or reads research", () => {
    const names = Object.keys(toolSchemas);
    expect(names.length).toBeGreaterThan(10);
    expect(names.filter((n) => /research/i.test(n))).toEqual([]);
  });
});

// --- REST ---------------------------------------------------------------------------
const FULL = "shared-full-token-for-research-tests-0123456789abcdef";
let close: (() => Promise<void>) | undefined;
let stubDir = "";
const savedEnv = { ...process.env };
beforeEach(() => {
  stubDir = mkdtempSync(join(tmpdir(), "research-api-"));
});
afterEach(async () => {
  await close?.();
  close = undefined;
  setPrincipalResolver(null);
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  rmSync(stubDir, { recursive: true, force: true });
});

/** What the isolation probe answers (a stub of `gaffer sandbox-status`), forgetting the last answer. */
function isolation(status: Record<string, unknown> | null): void {
  resetIsolationStatus();
  process.env.GAFFER_SANDBOX_STATUS_CMD = JSON.stringify(
    status === null
      ? [process.execPath, "-e", "process.exit(3)"]
      : [process.execPath, "-e", `console.log(${JSON.stringify(JSON.stringify(status))})`],
  );
}

async function start(): Promise<{ base: string; wg: Dispatch }> {
  process.env.DISPATCH_AUDIT_OFF = "1";
  process.env.DISPATCH_API_TOKEN = FULL;
  process.env.GAFFER_ALLOW_UNCAPPED = "1";
  const stub = join(stubDir, "research-stub.mjs");
  writeFileSync(join(stubDir, "out.json"), JSON.stringify(launcherOutput()));
  writeFileSync(
    stub,
    `import { readFileSync, writeFileSync } from "node:fs";\nconst input = readFileSync(0, "utf8");\nwriteFileSync(${JSON.stringify(join(stubDir, "stdin.json"))}, input);\nprocess.stdout.write(readFileSync(${JSON.stringify(join(stubDir, "out.json"))}, "utf8") + "\\n");\n`,
  );
  chmodSync(stub, 0o755);
  process.env.GAFFER_RESEARCH_BIN = stub;
  isolation({ provider: "docker", available: true, required: true });
  const wg = Dispatch.open(":memory:", new TestClock());
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

async function call(base: string, method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
}
async function mint(base: string, body: Record<string, unknown>): Promise<string> {
  const r = await call(base, "POST", "/api/principals", FULL, body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.token as string;
}
async function waitReady(base: string, id: string): Promise<Record<string, any>> {
  for (let i = 0; i < 100; i += 1) {
    const r = await call(base, "GET", `/research/${id}`, FULL);
    if (r.body.research?.status !== "running") return r.body.research;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error("research run never finished");
}

describe("research runs: REST", () => {
  it("starts a run, stores the launcher's result, edits, drafts the spec", async () => {
    const { base } = await start();
    const s = await call(base, "POST", "/research", FULL, {
      idea: "a gym workout tracker",
      plan_session_id: "ps-9",
    });
    expect(s.status).toBe(202);
    expect(s.body.started).toBe(true);
    const ready = await waitReady(base, s.body.research.id);
    expect(ready.status).toBe("ready");
    expect(ready.findings[0].sources[0].fetched).toBe(true);
    // The same plan session never starts a second paid run.
    const again = await call(base, "POST", "/research", FULL, {
      idea: "something else",
      plan_session_id: "ps-9",
    });
    expect(again.status).toBe(200);
    expect(again.body.started).toBe(false);
    expect(again.body.research.id).toBe(s.body.research.id);
    const list = await call(base, "GET", "/research?plan_session=ps-9", FULL);
    expect(list.body.research).toHaveLength(1);
    const d = await call(base, "POST", `/research/${ready.id}/draft-spec`, FULL);
    expect(d.status).toBe(201);
    expect(d.body.spec.status).toBe("draft");
  });

  it("refuses a read token, a read principal and a scoped principal; allows human and admin principals", async () => {
    const { base, wg } = await start();
    wg.registerRepository({ name: "app", default_branch: "main" }, human);
    const readTok = deriveReadToken(FULL);
    const readP = await mint(base, { name: "reader", capability: "read" });
    const scoped = await mint(base, { name: "app-bot", repos: ["app"] });
    const person = await mint(base, { name: "carol" });
    const admin = await mint(base, { name: "boss", actor_type: "admin" });
    for (const tok of [readTok, readP]) {
      const r = await call(base, "POST", "/research", tok, { idea: "x idea" });
      expect(r.status).toBe(403);
    }
    const sc = await call(base, "POST", "/research", scoped, { idea: "x idea" });
    expect(sc.status).toBe(403);
    expect(sc.body.error.code).toBe("SCOPE_DENIED");
    const scRead = await call(base, "GET", "/research", scoped);
    expect(scRead.status).toBe(403);
    const ok = await call(base, "POST", "/research", person, { idea: "a person's idea" });
    expect(ok.status).toBe(202);
    const r = await waitReady(base, ok.body.research.id);
    for (const tok of [readTok, readP, scoped]) {
      expect(
        (await call(base, "PATCH", `/research/${r.id}`, tok, { open_questions: [] })).status,
      ).toBe(403);
      expect((await call(base, "POST", `/research/${r.id}/draft-spec`, tok)).status).toBe(403);
      expect((await call(base, "POST", `/research/${r.id}/discard`, tok)).status).toBe(403);
    }
    expect(
      (
        await call(base, "PATCH", `/research/${r.id}`, admin, {
          open_questions: [{ id: "q1", kept: false }],
        })
      ).status,
    ).toBe(200);
  });

  it("does not start without a dollar cap (the paid-launch admission rule)", async () => {
    const { base, wg } = await start();
    delete process.env.GAFFER_ALLOW_UNCAPPED;
    const avail = await call(base, "GET", "/research/availability", FULL);
    expect(avail.body.available).toBe(false);
    expect(avail.body.reason).toMatch(/dollar cap/);
    const r = await call(base, "POST", "/research", FULL, { idea: "an idea" });
    expect(r.status).toBe(409);
    expect(wg.researchSvc.listRuns({ includeDiscarded: true })).toHaveLength(0);
  });

  // The disabled checkbox is a courtesy: the server refuses on its own, before any run row
  // or launcher exists, for every case the dashboard disables the box for.
  for (const [label, status, env] of [
    [
      "no usable sandbox",
      {
        provider: "docker",
        available: false,
        required: true,
        missing: "docker daemon unavailable",
      },
      {},
    ],
    ["a probe that cannot answer", null, {}],
    [
      "the sandbox opted out",
      { provider: "sandbox-exec", available: true, required: false, optedOut: true },
      {},
    ],
  ] as const) {
    it(`refuses to start with ${label}, even when the client sends the request`, async () => {
      const { base, wg } = await start();
      isolation(status as Record<string, unknown> | null);
      Object.assign(process.env, env);
      const avail = await call(base, "GET", "/research/availability", FULL);
      expect(avail.body.available).toBe(false);
      expect(avail.body.reason).toMatch(/OS sandbox/);
      const r = await call(base, "POST", "/research", FULL, {
        idea: "an idea",
        plan_session_id: "ps-x",
      });
      expect(r.status).toBe(409);
      expect(wg.researchSvc.listRuns({ includeDiscarded: true })).toHaveLength(0);
      expect(existsSync(join(stubDir, "stdin.json"))).toBe(false);
    });
  }

  it("refuses an agent principal and the factory agent's credential for every write", async () => {
    const { base, wg } = await start();
    // The REST mint refuses agent principals; an agent-typed credential (the factory
    // agent's, or a forged row) is modelled by resolving a real principal as an agent.
    const agentTok = await mint(base, { name: "worker-bot" });
    setPrincipalResolver((token) => {
      const p = wg.resolvePrincipalToken(token);
      return p ? { ...p, actor: { type: "agent", id: "agent-1" } } : null;
    });
    const r = await call(base, "POST", "/research", agentTok, { idea: "an agent's idea" });
    expect(r.status).toBe(403);
    expect(wg.researchSvc.listRuns({ includeDiscarded: true })).toHaveLength(0);
    expect(existsSync(join(stubDir, "stdin.json"))).toBe(false);
    const ok = await call(base, "POST", "/research", FULL, { idea: "a person's idea" });
    const run = await waitReady(base, ok.body.research.id);
    for (const [method, path, body] of [
      ["PATCH", `/research/${run.id}`, { open_questions: [] }],
      ["POST", `/research/${run.id}/draft-spec`, undefined],
      ["POST", `/research/${run.id}/discard`, undefined],
    ] as const) {
      expect((await call(base, method, path, agentTok, body)).status).toBe(403);
    }
    expect(wg.researchSvc.getRun(run.id).status).toBe("ready");
  });

  it("starts exactly one paid run for a double submit of one plan session", async () => {
    const { base, wg } = await start();
    const body = { idea: "a gym workout tracker", plan_session_id: "ps-double" };
    const [a, b] = await Promise.all([
      call(base, "POST", "/research", FULL, body),
      call(base, "POST", "/research", FULL, body),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 202]);
    expect(a.body.research.id).toBe(b.body.research.id);
    expect(wg.researchSvc.listRuns({ includeDiscarded: true })).toHaveLength(1);
    await waitReady(base, a.body.research.id);
  });

  it("records a launcher error as a failed run", async () => {
    const { base } = await start();
    writeFileSync(
      join(stubDir, "out.json"),
      JSON.stringify({ phase: "error", error: "refused: no OS sandbox", code: "sandbox" }),
    );
    const s = await call(base, "POST", "/research", FULL, { idea: "an idea" });
    const done = await waitReady(base, s.body.research.id);
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/no OS sandbox/);
  });
});
