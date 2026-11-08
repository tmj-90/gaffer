// The agent isolation posture the Settings page shows (src/api/isolation.ts): the probe
// is `runner/gaffer sandbox-status` (overridable as a JSON argv), its JSON line becomes
// the status, a probe that fails or prints nothing becomes "unknown", and GET
// /api/settings carries the answer next to the settings.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import {
  DEFAULT_SANDBOX_STATUS_ARGV,
  GAFFER_SANDBOX_STATUS_CMD_ENV,
  lastIsolationStatus,
  parseIsolationStatus,
  refreshIsolationStatus,
  resetIsolationStatus,
  sandboxStatusArgv,
} from "../src/api/isolation.js";
import { createApiServer } from "../src/api/server.js";

const MISSING = {
  provider: "docker",
  available: false,
  required: true,
  optedOut: false,
  missing: "Docker is installed but its daemon is not reachable",
  fix: "start the docker daemon",
};

let dir = "";
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wg-isolation-"));
  for (const k of [GAFFER_SANDBOX_STATUS_CMD_ENV, "GAFFER_DATA"]) saved[k] = process.env[k];
  resetIsolationStatus();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

function stubProbe(body: string): string {
  const f = join(dir, "probe.sh");
  writeFileSync(f, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(f, 0o755);
  return JSON.stringify([f]);
}

describe("isolation probe", () => {
  it("defaults to runner/gaffer sandbox-status and honours a JSON argv override", () => {
    expect(DEFAULT_SANDBOX_STATUS_ARGV[0]).toBe("bash");
    expect(DEFAULT_SANDBOX_STATUS_ARGV[1]).toMatch(/runner[\\/]gaffer$/);
    expect(DEFAULT_SANDBOX_STATUS_ARGV[2]).toBe("sandbox-status");
    expect(sandboxStatusArgv({})).toEqual([...DEFAULT_SANDBOX_STATUS_ARGV]);
    expect(sandboxStatusArgv({ [GAFFER_SANDBOX_STATUS_CMD_ENV]: '["/x","y"]' })).toEqual([
      "/x",
      "y",
    ]);
    // Not a string[]: the default, never a guess.
    expect(sandboxStatusArgv({ [GAFFER_SANDBOX_STATUS_CMD_ENV]: "not json" })).toEqual([
      ...DEFAULT_SANDBOX_STATUS_ARGV,
    ]);
  });

  it("parses the probe's last JSON line, ignoring warnings before it", () => {
    const text = `WARNING: something\n${JSON.stringify(MISSING)}\n`;
    expect(parseIsolationStatus(text)).toEqual(MISSING);
    expect(parseIsolationStatus("")).toBeNull();
    expect(parseIsolationStatus("{not json")).toBeNull();
    expect(parseIsolationStatus('{"available":true}')).toBeNull();
  });

  it("runs the probe and remembers its answer; a failing probe reads as unknown", async () => {
    const env = {
      ...process.env,
      [GAFFER_SANDBOX_STATUS_CMD_ENV]: stubProbe(`echo '${JSON.stringify(MISSING)}'`),
    };
    expect(await refreshIsolationStatus(env)).toEqual(MISSING);
    expect(lastIsolationStatus()).toEqual(MISSING);
    const bad = { ...process.env, [GAFFER_SANDBOX_STATUS_CMD_ENV]: stubProbe("exit 3") };
    const st = await refreshIsolationStatus(bad);
    expect(st.provider).toBe("unknown");
    expect(st.available).toBe(false);
    expect(st.error).toMatch(/isolation probe failed/);
  });

  it("GET /api/settings never waits long for a slow probe: it answers with what it has, and the probe's answer shows on a later load", async () => {
    process.env.GAFFER_DATA = dir;
    // A probe that takes three seconds (a docker CLI slow to answer `docker info`).
    process.env[GAFFER_SANDBOX_STATUS_CMD_ENV] = stubProbe(
      `sleep 3\necho '${JSON.stringify(MISSING)}'`,
    );
    const wg = Dispatch.open(":memory:");
    const server = createApiServer(wg);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const { port } = server.address() as AddressInfo;
      const t0 = Date.now();
      const res = await fetch(`http://127.0.0.1:${port}/api/settings`);
      const elapsed = Date.now() - t0;
      expect(res.status).toBe(200);
      expect(elapsed).toBeLessThan(2_500);
      const body = (await res.json()) as { isolation: { provider: string; error?: string } };
      expect(body.isolation.provider).toBe("unknown");
      expect(body.isolation.error).toMatch(/still running/);
      // The one probe finishes on its own; the next load carries its answer.
      await new Promise((r) => setTimeout(r, 3_200));
      const again = await fetch(`http://127.0.0.1:${port}/api/settings`);
      const after = (await again.json()) as { isolation: unknown };
      expect(after.isolation).toEqual(MISSING);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      wg.db.close();
    }
  }, 15_000);

  it("GET /api/settings carries the isolation posture", async () => {
    process.env.GAFFER_DATA = dir;
    process.env[GAFFER_SANDBOX_STATUS_CMD_ENV] = stubProbe(`echo '${JSON.stringify(MISSING)}'`);
    const wg = Dispatch.open(":memory:");
    const server = createApiServer(wg);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/api/settings`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { settings: unknown[]; isolation: unknown };
      expect(Array.isArray(body.settings)).toBe(true);
      expect(body.isolation).toEqual(MISSING);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      wg.db.close();
    }
  });
});
