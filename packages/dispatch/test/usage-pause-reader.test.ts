/**
 * USAGE-WINDOW PAUSE — the dashboard's read of the runner's pause file
 * (src/health/usagePause.ts) and its place on GET /api/health. The reader must
 * agree with runner/lib/usage-pause.mjs readPause: absent / expired → not paused,
 * a live pause reported verbatim, a corrupt file ACTIVE (fail closed).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import { readUsagePause } from "../src/health/usagePause.js";
import { TestClock } from "../src/util/clock.js";

const NOW = Date.UTC(2026, 9, 31, 12, 0);

describe("readUsagePause", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "usage-pause-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const write = (o: unknown) => writeFileSync(join(dir, "usage-pause.json"), JSON.stringify(o));

  it("no GAFFER_DATA or no file → not paused", () => {
    expect(readUsagePause({}, NOW)).toEqual({ active: false });
    expect(readUsagePause({ GAFFER_DATA: dir }, NOW)).toEqual({ active: false });
  });

  it("a live pause is reported; an expired one is not", () => {
    write({
      paused_until: "2026-10-31T15:01:00.000Z",
      until_ms: Date.UTC(2026, 9, 31, 15, 1),
      kind: "usage_limit",
      basis: "reset",
      message: "You've hit your session limit · resets 3pm (UTC)",
      ticket: 7,
    });
    expect(readUsagePause({ GAFFER_DATA: dir }, NOW)).toEqual({
      active: true,
      paused_until: "2026-10-31T15:01:00.000Z",
      kind: "usage_limit",
      basis: "reset",
      message: "You've hit your session limit · resets 3pm (UTC)",
      ticket: 7,
    });
    expect(readUsagePause({ GAFFER_DATA: dir }, Date.UTC(2026, 9, 31, 16))).toEqual({
      active: false,
    });
  });

  it("a corrupt pause file fails closed: active for the default wait from its mtime", () => {
    writeFileSync(join(dir, "usage-pause.json"), "not json {");
    const v = readUsagePause({ GAFFER_DATA: dir }, Date.now());
    expect(v.active).toBe(true);
    expect(v.unreadable).toBe(true);
    const mins = (Date.parse(String(v.paused_until)) - Date.now()) / 60_000;
    expect(mins).toBeGreaterThan(58);
    expect(mins).toBeLessThanOrEqual(60.1);
    // The setting is honoured, and never below the 10-minute floor.
    const low = readUsagePause(
      { GAFFER_DATA: dir, GAFFER_USAGE_PAUSE_DEFAULT_MIN: "1" },
      Date.now(),
    );
    expect((Date.parse(String(low.paused_until)) - Date.now()) / 60_000).toBeGreaterThan(9);
  });

  it("GAFFER_USAGE_PAUSE_FILE overrides the path", () => {
    const f = join(dir, "elsewhere.json");
    writeFileSync(f, JSON.stringify({ until_ms: NOW + 60_000, kind: "rate_limit" }));
    const v = readUsagePause({ GAFFER_USAGE_PAUSE_FILE: f }, NOW);
    expect(v.active).toBe(true);
    expect(v.kind).toBe("rate_limit");
  });
});

describe("GET /api/health usage_pause", () => {
  let dir: string;
  let saved: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "usage-pause-api-"));
    saved = process.env.GAFFER_DATA;
    process.env.GAFFER_DATA = dir;
    process.env.DISPATCH_AUDIT_OFF = "1";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.GAFFER_DATA;
    else process.env.GAFFER_DATA = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  async function health(): Promise<Record<string, unknown>> {
    const wg = Dispatch.open(":memory:", new TestClock());
    const server = createApiServer(wg);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(res.status).toBe(200);
      return (await res.json()) as Record<string, unknown>;
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      wg.db.close();
    }
  }

  it("reports { active: false } when the factory is not paused", async () => {
    expect((await health()).usage_pause).toEqual({ active: false });
  });

  it("reports the runner's pause when one is in force", async () => {
    const until = Date.now() + 3_600_000;
    writeFileSync(
      join(dir, "usage-pause.json"),
      JSON.stringify({
        paused_until: new Date(until).toISOString(),
        until_ms: until,
        kind: "usage_limit",
        basis: "default",
        message: "You've hit your usage limit",
        ticket: 3,
      }),
    );
    const p = (await health()).usage_pause as Record<string, unknown>;
    expect(p.active).toBe(true);
    expect(p.kind).toBe("usage_limit");
    expect(p.ticket).toBe(3);
    expect(p.paused_until).toBe(new Date(until).toISOString());
  });
});
