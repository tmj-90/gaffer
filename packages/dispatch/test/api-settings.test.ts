import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { createApiServer } from "../src/api/server.js";

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
  type: string;
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
  const TOUCHED = ["GAFFER_DATA", "GAFFER_PLAN_DEBATE", "MAX_TICKS"];

  beforeEach(async () => {
    for (const k of TOUCHED) savedEnv[k] = process.env[k];
    for (const k of TOUCHED) delete process.env[k];
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
    for (const k of TOUCHED) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it("GET reports every known setting with value/envLocked/group", async () => {
    const res = await fetch(`${h.baseUrl}/api/settings`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { settings: SettingView[] };
    expect(body.settings.length).toBeGreaterThan(0);
    const max = body.settings.find((s) => s.key === "MAX_TICKS");
    expect(max).toBeDefined();
    expect(max?.value).toBe("");
    expect(max?.envLocked).toBe(false);
    expect(max?.group).toBe("budget");
  });

  it("POST persists a non-env key to settings.json and reflects it back", async () => {
    const res = await fetch(`${h.baseUrl}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { MAX_TICKS: "42" } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { settings: SettingView[]; written: string[] };
    expect(body.written).toContain("MAX_TICKS");
    expect(body.settings.find((s) => s.key === "MAX_TICKS")?.value).toBe("42");

    // Round-trips on a fresh GET.
    const after = (await (await fetch(`${h.baseUrl}/api/settings`)).json()) as {
      settings: SettingView[];
    };
    expect(after.settings.find((s) => s.key === "MAX_TICKS")?.value).toBe("42");

    // Written as a flat JSON map of strings.
    const onDisk = JSON.parse(readFileSync(h.settingsPath, "utf8")) as Record<string, string>;
    expect(onDisk).toEqual({ MAX_TICKS: "42" });
  });

  it("reports an env-set key as envLocked and POST will not change it", async () => {
    process.env.GAFFER_PLAN_DEBATE = "1";

    const get = (await (await fetch(`${h.baseUrl}/api/settings`)).json()) as {
      settings: SettingView[];
    };
    expect(get.settings.find((s) => s.key === "GAFFER_PLAN_DEBATE")?.envLocked).toBe(true);

    const res = await fetch(`${h.baseUrl}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { GAFFER_PLAN_DEBATE: "0" } }),
    });
    const body = (await res.json()) as { rejected: string[]; written: string[] };
    expect(body.rejected).toContain("GAFFER_PLAN_DEBATE");
    expect(body.written).not.toContain("GAFFER_PLAN_DEBATE");
  });
});
