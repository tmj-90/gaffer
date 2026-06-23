import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { createApiServer } from "../src/api/server.js";
import { createPollWorkRunner, TICK_CMD_ENV, type PollWorkRunner } from "../src/api/pollWork.js";

/**
 * The "Poll for work" button fires a single factory tick on demand. The runner
 * spawns the operator-configured DISPATCH_TICK_CMD using the SAME safe pattern
 * as the merge runner: no shell, argv array, bearer token stripped from the
 * child env, fire-and-gaffert. When unset it surfaces NOT_CONFIGURED (like the
 * product-owner runner) rather than silently doing nothing.
 */

// ===========================================================================
//  Runner unit tests — drive the REAL spawn path against a tiny node script.
// ===========================================================================

describe("createPollWorkRunner (spawns the tick command)", () => {
  it("throws NOT_CONFIGURED when DISPATCH_TICK_CMD is unset", () => {
    const runner = createPollWorkRunner({});
    expect(() => runner.run()).toThrowError(/NOT_CONFIGURED|not configured|tick command/i);
  });

  it("treats a blank/whitespace command as unconfigured", () => {
    const runner = createPollWorkRunner({ [TICK_CMD_ENV]: "   " } as NodeJS.ProcessEnv);
    expect(() => runner.run()).toThrow();
  });

  it("spawns the configured command and strips DISPATCH_API_TOKEN from the child env", async () => {
    const { mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "wg-tick-"));
    const outFile = join(dir, "out.json");
    const scriptFile = join(dir, "fake-tick.cjs");
    writeFileSync(
      scriptFile,
      "const fs=require('fs');" +
        "fs.writeFileSync(process.env.WG_TICK_OUT," +
        "JSON.stringify({argv:process.argv.slice(2),token:process.env.DISPATCH_API_TOKEN??null}));",
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DISPATCH_API_TOKEN: "super-secret-bearer",
      WG_TICK_OUT: outFile,
      [TICK_CMD_ENV]: `${process.execPath} ${scriptFile}`,
    };
    const runner = createPollWorkRunner(env);
    const res = runner.run();
    expect(res.started).toBe(true);

    // Wait for the detached child to write the file.
    const deadline = Date.now() + 4000;
    let raw: string | null = null;
    while (Date.now() < deadline) {
      try {
        raw = readFileSync(outFile, "utf8");
        if (raw) break;
      } catch {
        // not written yet
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as { argv: string[]; token: string | null };
    // No request-derived args are appended (the tick takes none).
    expect(parsed.argv).toEqual([]);
    // The bearer token is STRIPPED from the child env (defence-in-depth).
    expect(parsed.token).toBeNull();
  });
});

// ===========================================================================
//  REST tests — POST /poll-work with an injected fake runner.
// ===========================================================================

interface Harness {
  baseUrl: string;
  runCount: () => number;
  close: () => Promise<void>;
}

async function startHarness(runner: PollWorkRunner, seedReady = true): Promise<Harness> {
  const wg = Dispatch.open(":memory:");
  if (seedReady) {
    // The route only fires a tick when something is actually READY; seed one so the
    // spawn / NOT_CONFIGURED paths below are exercised (empty queue is tested separately).
    const human = { type: "human" as const, id: "tom" };
    const t = wg.createTicket({ title: "seed ready" }, human);
    wg.markReady(t.id, human);
  }
  let runs = 0;
  const wrapped: PollWorkRunner = {
    run() {
      runs += 1;
      return runner.run();
    },
  };
  const noopPo = { run: () => ({ started: false, pid: null }) };
  const noopPlan = { run: () => Promise.resolve({ phase: "error" as const, error: "x" }) };
  const noopMerge = { trigger: () => ({ triggered: false, pid: null, skipped: "not_configured" }) };
  const server = createApiServer(wg, noopPo, noopPlan, noopMerge, wrapped);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    runCount: () => runs,
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

describe("POST /poll-work", () => {
  let h: Harness;
  afterEach(async () => {
    if (h) await h.close();
  });

  it("fires one tick and returns 202 with the run result", async () => {
    h = await startHarness({ run: () => ({ started: true, pid: 1234 }) });
    const res = await call(h.baseUrl, "POST", "/poll-work");
    expect(res.status).toBe(202);
    expect(res.body.run).toMatchObject({ started: true, pid: 1234 });
    expect(h.runCount()).toBe(1);
  });

  it("returns 503 NOT_CONFIGURED when no tick command is set", async () => {
    // The real default runner with an empty env throws NOT_CONFIGURED, which the
    // server maps to a 503 — the click had no effect and the user is told why.
    h = await startHarness(createPollWorkRunner({}));
    const res = await call(h.baseUrl, "POST", "/poll-work");
    expect(res.status).toBe(503);
    expect((res.body.error as { code: string }).code).toBe("NOT_CONFIGURED");
  });

  it("returns 405 for a non-POST method", async () => {
    h = await startHarness({ run: () => ({ started: true, pid: 1 }) });
    const res = await call(h.baseUrl, "GET", "/poll-work");
    expect(res.status).toBe(405);
    expect(h.runCount()).toBe(0);
  });

  it("returns 200 'no ready work' (and never spawns) when the queue has nothing ready", async () => {
    h = await startHarness({ run: () => ({ started: true, pid: 1 }) }, /* seedReady */ false);
    const res = await call(h.baseUrl, "POST", "/poll-work");
    expect(res.status).toBe(200);
    expect(res.body.polled).toBe(false);
    expect(res.body.reason).toBe("no_ready_work");
    expect(h.runCount()).toBe(0);
  });
});
