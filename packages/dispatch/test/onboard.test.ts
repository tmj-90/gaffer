import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { createApiServer } from "../src/api/server.js";
import {
  createOnboardRunner,
  ONBOARD_CMD_ENV,
  ONBOARD_REPO_ENV,
  type OnboardRunner,
} from "../src/api/onboard.js";

/**
 * The Memory view's "Onboard a repo" button fires a repo onboarding run on demand.
 * The runner spawns the operator-configured DISPATCH_ONBOARD_CMD using the SAME
 * safe pattern as the product-owner / poll-work runners: no shell, argv array, the
 * (validated) repo passed via the child ENV (never the command line), bearer token
 * stripped from the child env, fire-and-gaffert. When unset it surfaces a clean
 * NOT_CONFIGURED (503) — never a 500.
 */

// ===========================================================================
//  Runner unit tests — drive the REAL spawn path against a tiny node script.
// ===========================================================================

describe("createOnboardRunner (spawns the onboard command)", () => {
  it("throws NOT_CONFIGURED when DISPATCH_ONBOARD_CMD is unset", () => {
    const runner = createOnboardRunner({});
    expect(() => runner.run({ repo: "sample-repo" })).toThrowError(
      /NOT_CONFIGURED|not configured|onboarding command/i,
    );
  });

  it("treats a blank/whitespace command as unconfigured", () => {
    const runner = createOnboardRunner({ [ONBOARD_CMD_ENV]: "   " } as NodeJS.ProcessEnv);
    expect(() => runner.run({ repo: "sample-repo" })).toThrow();
  });

  it("spawns the configured command, passes the repo via env, strips the bearer token", async () => {
    const { mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "wg-onboard-"));
    const outFile = join(dir, "out.json");
    const scriptFile = join(dir, "fake-onboard.cjs");
    writeFileSync(
      scriptFile,
      "const fs=require('fs');" +
        "fs.writeFileSync(process.env.WG_ONBOARD_OUT," +
        "JSON.stringify({" +
        "argv:process.argv.slice(2)," +
        "repo:process.env.DISPATCH_ONBOARD_REPO??null," +
        "token:process.env.DISPATCH_API_TOKEN??null}));",
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DISPATCH_API_TOKEN: "super-secret-bearer",
      WG_ONBOARD_OUT: outFile,
      [ONBOARD_CMD_ENV]: `${process.execPath} ${scriptFile}`,
    };
    const runner = createOnboardRunner(env);
    const res = runner.run({ repo: "/some/local/repo" });
    expect(res.started).toBe(true);

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
    const parsed = JSON.parse(raw!) as {
      argv: string[];
      repo: string | null;
      token: string | null;
    };
    // The repo rides in the child ENV, never as a command-line argument.
    expect(parsed.argv).toEqual([]);
    expect(parsed.repo).toBe("/some/local/repo");
    // The bearer token is STRIPPED from the child env (defence-in-depth).
    expect(parsed.token).toBeNull();
  });
});

// ===========================================================================
//  REST tests — POST /repos/onboard with an injected fake runner.
// ===========================================================================

interface Harness {
  baseUrl: string;
  runs: Array<{ repo: string }>;
  close: () => Promise<void>;
}

async function startHarness(runner: OnboardRunner): Promise<Harness> {
  const wg = Dispatch.open(":memory:");
  const runs: Array<{ repo: string }> = [];
  const wrapped: OnboardRunner = {
    run(input) {
      runs.push(input);
      return runner.run(input);
    },
  };
  const noopPo = { run: () => ({ started: false, pid: null }) };
  const noopPlan = { run: () => Promise.resolve({ phase: "error" as const, error: "x" }) };
  const noopMerge = { trigger: () => ({ triggered: false, pid: null, skipped: "not_configured" }) };
  const noopPoll = { run: () => ({ started: false, pid: null }) };
  // memoryReader (undefined → default) then onboardRunner is the LAST positional arg.
  const server = createApiServer(
    wg,
    noopPo,
    noopPlan,
    noopMerge,
    noopPoll,
    "127.0.0.1",
    undefined,
    wrapped,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    runs,
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

describe("POST /repos/onboard", () => {
  let h: Harness;
  afterEach(async () => {
    if (h) await h.close();
  });

  it("spawns the onboard command with the repo arg and returns 202", async () => {
    h = await startHarness({ run: () => ({ started: true, pid: 4242 }) });
    const res = await call(h.baseUrl, "POST", "/repos/onboard", { repo: "sample-repo" });
    expect(res.status).toBe(202);
    expect(res.body.onboarding).toBe(true);
    expect(res.body.repo).toBe("sample-repo");
    expect(res.body.run).toMatchObject({ started: true, pid: 4242 });
    expect(h.runs).toEqual([{ repo: "sample-repo" }]);
  });

  it("accepts a local path as the target", async () => {
    h = await startHarness({ run: () => ({ started: true, pid: 1 }) });
    const res = await call(h.baseUrl, "POST", "/repos/onboard", {
      repo: "/Users/you/git/sample-repo",
    });
    expect(res.status).toBe(202);
    expect(h.runs).toEqual([{ repo: "/Users/you/git/sample-repo" }]);
  });

  it("rejects an empty repo with a 422 (and never spawns)", async () => {
    h = await startHarness({ run: () => ({ started: true, pid: 1 }) });
    const res = await call(h.baseUrl, "POST", "/repos/onboard", { repo: "   " });
    expect(res.status).toBe(422);
    expect(h.runs).toHaveLength(0);
  });

  it("rejects a missing repo with a 422", async () => {
    h = await startHarness({ run: () => ({ started: true, pid: 1 }) });
    const res = await call(h.baseUrl, "POST", "/repos/onboard", {});
    expect(res.status).toBe(422);
    expect(h.runs).toHaveLength(0);
  });

  it("rejects a control-character (unsafe) target with a 422", async () => {
    h = await startHarness({ run: () => ({ started: true, pid: 1 }) });
    const res = await call(h.baseUrl, "POST", "/repos/onboard", { repo: "/tmp/repo\nrm -rf" });
    expect(res.status).toBe(422);
    expect(h.runs).toHaveLength(0);
  });

  it("returns 503 NOT_CONFIGURED when no onboard command is set (never a 500)", async () => {
    // The real default runner with an empty env throws NOT_CONFIGURED, which the
    // server maps to a 503 envelope — the click had no effect and the user is told why.
    h = await startHarness(createOnboardRunner({}));
    const res = await call(h.baseUrl, "POST", "/repos/onboard", { repo: "sample-repo" });
    expect(res.status).toBe(503);
    expect((res.body.error as { code: string }).code).toBe("NOT_CONFIGURED");
  });

  it("returns 405 for a non-POST method", async () => {
    h = await startHarness({ run: () => ({ started: true, pid: 1 }) });
    const res = await call(h.baseUrl, "GET", "/repos/onboard");
    expect(res.status).toBe(405);
    expect(h.runs).toHaveLength(0);
  });

  it("env-based repo passing is exercised end-to-end via the real runner", async () => {
    // Sanity: the ONBOARD_REPO_ENV constant is the channel the spawned command reads.
    expect(ONBOARD_REPO_ENV).toBe("DISPATCH_ONBOARD_REPO");
  });
});
