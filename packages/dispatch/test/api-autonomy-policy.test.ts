/**
 * Integration tests for the Graduated Autonomy enablement control plane (Spec 2,
 * Phase 3): POST /api/autonomy/policy + GET /api/autonomy/policies. Drives the REAL
 * API + service + DB. Covers the explicit-confirm trust boundary (enable without
 * confirm is rejected) and the reversible OFF.
 */
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import { nonEmptyDiffRunner } from "./helpers/realDiff.js";
import type { Actor } from "../src/domain/types.js";

const human: Actor = { type: "human", id: "tom" };

interface Harness {
  wg: Dispatch;
  baseUrl: string;
  repoId: string;
  close: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  process.env.DISPATCH_AUDIT_OFF = "1";
  const wg = Dispatch.open(":memory:", undefined, nonEmptyDiffRunner);
  const repo = wg.registerRepository(
    { name: "api-repo", default_branch: "main", local_path: process.cwd() },
    human,
  );
  const server = createApiServer(wg);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    wg,
    repoId: repo.id,
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

async function req(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    ...(body
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

describe("API: autonomy policy control plane", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("GET /api/autonomy/policies is empty before any enablement", async () => {
    const { status, body } = await req(h.baseUrl, "GET", "/api/autonomy/policies");
    expect(status).toBe(200);
    expect(body.policies).toEqual([]);
  });

  it("POST enables a policy with confirm:true and it appears in the active list", async () => {
    const enable = await req(h.baseUrl, "POST", "/api/autonomy/policy", {
      repo_id: h.repoId,
      risk_level: "low",
      gate: "approve",
      mode: "auto",
      confirm: true,
    });
    expect(enable.status).toBe(200);
    expect(enable.body.policy.mode).toBe("auto");
    expect(enable.body.policy.enabled_by).toBeTruthy();
    expect(enable.body.policy.evidence_json).toBeTruthy();

    const list = await req(h.baseUrl, "GET", "/api/autonomy/policies");
    const row = (list.body.policies as any[]).find(
      (p) => p.repo_id === h.repoId && p.gate === "approve",
    );
    expect(row).toBeDefined();
    expect(row.mode).toBe("auto");
    expect(row.repo_name).toBe("api-repo");
  });

  it("POST enable WITHOUT confirm is rejected (explicit-confirm trust boundary)", async () => {
    const res = await req(h.baseUrl, "POST", "/api/autonomy/policy", {
      repo_id: h.repoId,
      risk_level: "low",
      gate: "approve",
      mode: "auto",
      confirm: false,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    // Nothing was enabled.
    const list = await req(h.baseUrl, "GET", "/api/autonomy/policies");
    expect(list.body.policies).toEqual([]);
  });

  it("POST mode=off (no confirm needed) reverses an enablement", async () => {
    await req(h.baseUrl, "POST", "/api/autonomy/policy", {
      repo_id: h.repoId,
      risk_level: "low",
      gate: "approve",
      mode: "auto",
      confirm: true,
    });
    const off = await req(h.baseUrl, "POST", "/api/autonomy/policy", {
      repo_id: h.repoId,
      risk_level: "low",
      gate: "approve",
      mode: "off",
    });
    expect(off.status).toBe(200);
    expect(off.body.policy.mode).toBe("off");
    // The active list (mode=auto only, filtered client-side) still returns the row,
    // but its mode is now off — the enforcement re-gates.
    const list = await req(h.baseUrl, "GET", "/api/autonomy/policies");
    const row = (list.body.policies as any[]).find((p) => p.repo_id === h.repoId);
    expect(row.mode).toBe("off");
  });

  it("POST for an unknown repo is a 404", async () => {
    const res = await req(h.baseUrl, "POST", "/api/autonomy/policy", {
      repo_id: "does-not-exist",
      risk_level: "low",
      gate: "approve",
      mode: "auto",
      confirm: true,
    });
    expect(res.status).toBe(404);
  });

  it("GET /api/autonomy/policy (singular) rejects a non-POST", async () => {
    const res = await fetch(`${h.baseUrl}/api/autonomy/policy`, { method: "GET" });
    expect(res.status).toBe(405);
  });
});
