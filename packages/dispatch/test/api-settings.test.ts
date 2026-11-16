import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { createApiServer } from "../src/api/server.js";
import { resetDerivedSettings, SETTING_DEFS } from "../src/api/settings.js";

interface Harness {
  baseUrl: string;
  settingsPath: string;
  close: () => Promise<void>;
}

interface SettingView {
  key: string;
  value: string;
  envLocked: boolean;
  group: string;
  origin: string;
  effective: string;
}

async function startHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "wg-api-settings-"));
  // The settings module reads process.env.GAFFER_DATA at call time, so pointing
  // it at a temp dir isolates this test's settings.json.
  process.env.GAFFER_DATA = dir;
  const wg = Dispatch.open(":memory:");
  const server = createApiServer(wg);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    settingsPath: join(dir, "settings.json"),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          wg.db.close();
          rmSync(dir, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}

describe("API: GET/POST /api/settings", () => {
  let h: Harness;
  const savedEnv: Record<string, string | undefined> = {};
  const TOUCHED = [
    "GAFFER_DATA",
    "GAFFER_EFFORT",
    "GAFFER_MODE",
    "GAFFER_DAILY_BUDGET_USD",
    "GAFFER_CONCURRENCY",
    "AUTO_MERGE",
    "DISPATCH_ALLOW_AGENT_APPROVE",
  ];

  beforeEach(async () => {
    for (const k of TOUCHED) savedEnv[k] = process.env[k];
    for (const k of TOUCHED) delete process.env[k];
    resetDerivedSettings(process.env);
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
    resetDerivedSettings(process.env);
    for (const k of TOUCHED) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it("GET reports the fourteen settings and the read-only derived and migration blocks", async () => {
    const res = await fetch(`${h.baseUrl}/api/settings`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      settings: SettingView[];
      derived: { name: string; setting: string }[];
      migration: unknown[];
      overrides: unknown[];
      cleanup: { drop: unknown[]; rewrite: unknown[]; digest: string };
    };
    expect(body.settings.map((s) => s.key)).toEqual(SETTING_DEFS.map((d) => d.key));
    const effort = body.settings.find((s) => s.key === "GAFFER_EFFORT");
    expect(effort).toMatchObject({
      value: "",
      envLocked: false,
      origin: "default",
      effective: "standard",
    });
    expect(body.derived.find((d) => d.name === "GAFFER_TICK_TIMEOUT")?.setting).toBe(
      "GAFFER_EFFORT",
    );
    expect(body.migration).toEqual([]);
    expect(body.cleanup).toMatchObject({ drop: [], rewrite: [] });
    expect(body.cleanup.digest).toMatch(/^[0-9a-f]{32}$/);
  });

  it("POST (and PUT) persists a setting to settings.json and reflects it back", async () => {
    const res = await fetch(`${h.baseUrl}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { GAFFER_EFFORT: "large" } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { settings: SettingView[]; written: string[] };
    expect(body.written).toEqual(["GAFFER_EFFORT"]);
    expect(body.settings.find((s) => s.key === "GAFFER_EFFORT")).toMatchObject({
      value: "large",
      origin: "dashboard",
    });
    const put = await fetch(`${h.baseUrl}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { GAFFER_CONCURRENCY: " 2 " } }),
    });
    expect(put.status).toBe(200);
    const onDisk = JSON.parse(readFileSync(h.settingsPath, "utf8")) as Record<string, string>;
    expect(onDisk).toEqual({ GAFFER_EFFORT: "large", GAFFER_CONCURRENCY: "2" });
  });

  it("an old key is refused whole with a 422 naming the setting that decides it now", async () => {
    const res = await fetch(`${h.baseUrl}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { AUTO_MERGE: "1", GAFFER_EFFORT: "large" } }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { message: string; details?: { invalid?: { key: string; decidedBy?: string }[] } };
    };
    expect(body.error.message).toMatch(
      /AUTO_MERGE is no longer a setting: GAFFER_MODE decides it now/,
    );
    expect(body.error.details?.invalid).toEqual([
      expect.objectContaining({ key: "AUTO_MERGE", decidedBy: "GAFFER_MODE" }),
    ]);
    expect(() => readFileSync(h.settingsPath, "utf8")).toThrow();
    // ...and the dashboard's own auto merge does not move.
    expect(process.env.AUTO_MERGE ?? "0").toBe("0");
  });

  it("reports an env-set setting as envLocked and POST will not change it", async () => {
    process.env.GAFFER_MODE = "strict";
    resetDerivedSettings(process.env);
    const get = (await (await fetch(`${h.baseUrl}/api/settings`)).json()) as {
      settings: SettingView[];
    };
    expect(get.settings.find((s) => s.key === "GAFFER_MODE")).toMatchObject({
      envLocked: true,
      origin: "environment",
    });
    const res = await fetch(`${h.baseUrl}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { GAFFER_MODE: "autonomous" } }),
    });
    const body = (await res.json()) as { rejected: string[]; written: string[] };
    expect(body.rejected).toEqual(["GAFFER_MODE"]);
    expect(body.written).toEqual([]);
  });

  it("POST refuses an invalid value with a 422 that names the field, and writes nothing", async () => {
    const res = await fetch(`${h.baseUrl}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        settings: {
          GAFFER_EFFORT: "large",
          GAFFER_DAILY_BUDGET_USD: "abc",
          GAFFER_CONCURRENCY: "65",
        },
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { code: string; message: string; details?: { invalid?: { key: string }[] } };
    };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toMatch(/Daily budget \(USD\) is not a dollar amount/);
    expect(body.error.message).toMatch(/Tickets at once is not a whole number from 1 to 64/);
    expect((body.error.details?.invalid ?? []).map((i) => i.key).sort()).toEqual([
      "GAFFER_CONCURRENCY",
      "GAFFER_DAILY_BUDGET_USD",
    ]);
    expect(() => readFileSync(h.settingsPath, "utf8")).toThrow();
  });

  it("the removal act drops what the page showed, and refuses a stale plan with 409", async () => {
    writeFileSync(
      h.settingsPath,
      JSON.stringify({ GAFFER_MODE: "lite", AUTO_MERGE: "1", FOO: "x" }),
    );
    const get = (await (await fetch(`${h.baseUrl}/api/settings`)).json()) as {
      cleanup: { drop: { key: string }[]; rewrite: { key: string }[]; digest: string };
    };
    expect(get.cleanup.drop.map((d) => d.key).sort()).toEqual(["AUTO_MERGE", "FOO"]);
    const stale = await fetch(`${h.baseUrl}/api/settings/remove-old-keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ drop: ["AUTO_MERGE"], rewrite: [], digest: get.cleanup.digest }),
    });
    expect(stale.status).toBe(409);
    expect(JSON.parse(readFileSync(h.settingsPath, "utf8"))).toEqual({
      GAFFER_MODE: "lite",
      AUTO_MERGE: "1",
      FOO: "x",
    });
    const ok = await fetch(`${h.baseUrl}/api/settings/remove-old-keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        drop: ["AUTO_MERGE", "FOO"],
        rewrite: [],
        digest: get.cleanup.digest,
      }),
    });
    expect(ok.status).toBe(200);
    expect(JSON.parse(readFileSync(h.settingsPath, "utf8"))).toEqual({ GAFFER_MODE: "lite" });
  });

  it("a settings.json changed by hand while the server runs reaches its own readers before the next request", async () => {
    // The approve floor (services/reviewGate/approval.ts) and auto merge on a human
    // approval (routes/tickets.ts) read this process's environment. A person who
    // tightens the mode by editing settings.json must not leave the server deciding on
    // the looser values until the next save or restart.
    const post = await fetch(`${h.baseUrl}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { GAFFER_MODE: "autonomous" } }),
    });
    expect(post.status).toBe(200);
    expect(process.env["AUTO_MERGE"]).toBe("1");
    expect(process.env["DISPATCH_ALLOW_AGENT_APPROVE"]).toBe("1");
    writeFileSync(h.settingsPath, JSON.stringify({ GAFFER_MODE: "supervised" }));
    const res = await fetch(`${h.baseUrl}/api/whoami`);
    expect(res.status).toBe(200);
    expect(process.env["AUTO_MERGE"]).toBe("0");
    expect(process.env["DISPATCH_ALLOW_AGENT_APPROVE"]).toBe("0");
    expect(process.env["GAFFER_MODE"]).toBe("supervised");
  });
});
