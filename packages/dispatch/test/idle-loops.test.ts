import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  IDLE_LOOP_KEYS,
  readIdleLoops,
  resolveCrewConfigPath,
  writeIdleLoops,
} from "../src/api/idleLoops.js";
import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { TestClock } from "../src/util/clock.js";

const human: Actor = { type: "human", id: "tom" };

/** A minimal-but-valid crew.yaml with the idle loops + a couple of repos. */
function crewYaml(): string {
  return `factory:
  name: demo
  mode: local_strict
  timezone: Europe/London

dispatch:
  mode: local
  local:
    sqlite_path: ./dispatch.sqlite
  default_policy_pack: solo_loose

repos:
  - name: api
  - name: web

safety:
  policy_file: ./safety_policy.yaml
  default_idle_loop_mode: create_draft_tickets

loops:
  default_min_delivered_tickets: 0
  implementation:
    enabled: true
    trigger: manual_or_queue
  idle_coverage:
    enabled: false
    trigger: when_queue_empty
    mode: create_draft_tickets
    repos: []
    minimum_gap_threshold: 10
  idle_test_quality:
    enabled: false
    mode: create_draft_tickets
    repos: []
  idle_documentation:
    enabled: false
    mode: create_draft_tickets
    repos: []
  idle_dependencies:
    enabled: false
    mode: create_draft_tickets
    repos: []
    audit_command: null
  idle_security_hotspot:
    enabled: false
    mode: create_draft_tickets
    repos: []
  idle_feature_backlog:
    enabled: false
    mode: create_draft_tickets
    repos: []

logging:
  level: info
`;
}

describe("idleLoops module: read/write crew.yaml slice", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wg-idle-loops-"));
    path = join(dir, "crew.yaml");
    writeFileSync(path, crewYaml(), "utf8");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads each known idle loop with enabled + repos + mode", () => {
    const view = readIdleLoops(path);
    expect(view.configured).toBe(true);
    expect(view.mode).toBe("create_draft_tickets");
    expect(view.loops.map((l) => l.key)).toEqual([...IDLE_LOOP_KEYS]);
    for (const loop of view.loops) {
      expect(loop.enabled).toBe(false);
      expect(loop.repos).toEqual([]);
      expect(typeof loop.label).toBe("string");
    }
  });

  it("missing crew.yaml yields a clean not-configured shape, not a throw", () => {
    const missing = join(dir, "does-not-exist.yaml");
    const view = readIdleLoops(missing);
    expect(view.configured).toBe(false);
    expect(view.mode).toBe("");
    expect(view.loops.map((l) => l.key)).toEqual([...IDLE_LOOP_KEYS]);
    expect(view.loops.every((l) => !l.enabled && l.repos.length === 0)).toBe(true);
  });

  it("unparseable crew.yaml yields not-configured rather than throwing", () => {
    writeFileSync(path, ":\n  - this is : not: valid: yaml: {[}", "utf8");
    const view = readIdleLoops(path);
    expect(view.configured).toBe(false);
  });

  it("writes enabled + repos back and round-trips, preserving the rest of the YAML", () => {
    const view = writeIdleLoops(
      path,
      [
        { key: "idle_coverage", enabled: true, repos: ["api"] },
        { key: "idle_security_hotspot", enabled: true, repos: ["api", "web"] },
      ],
      ["api", "web"],
    );

    const coverage = view.loops.find((l) => l.key === "idle_coverage")!;
    expect(coverage.enabled).toBe(true);
    expect(coverage.repos).toEqual(["api"]);
    const security = view.loops.find((l) => l.key === "idle_security_hotspot")!;
    expect(security.enabled).toBe(true);
    expect(security.repos).toEqual(["api", "web"]);

    // Read back fresh from disk to confirm persistence.
    const reread = readIdleLoops(path);
    expect(reread.loops.find((l) => l.key === "idle_coverage")!.repos).toEqual(["api"]);

    // The rest of the YAML is preserved: factory + untouched loop fields survive.
    const doc = parseYaml(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect((doc.factory as Record<string, unknown>).name).toBe("demo");
    const loops = doc.loops as Record<string, Record<string, unknown>>;
    // The unrelated field on idle_coverage survives the mutation.
    expect(loops.idle_coverage!.minimum_gap_threshold).toBe(10);
    // An untouched loop keeps its disabled state.
    expect(loops.idle_documentation!.enabled).toBe(false);
  });

  it("clearing repos to [] means 'all repos'", () => {
    writeIdleLoops(path, [{ key: "idle_coverage", enabled: true, repos: ["api"] }], ["api", "web"]);
    const view = writeIdleLoops(
      path,
      [{ key: "idle_coverage", enabled: true, repos: [] }],
      ["api", "web"],
    );
    expect(view.loops.find((l) => l.key === "idle_coverage")!.repos).toEqual([]);
  });

  it("rejects an unknown loop key", () => {
    expect(() =>
      writeIdleLoops(path, [{ key: "idle_bogus", enabled: true, repos: [] }], ["api", "web"]),
    ).toThrow(/Unknown idle loop key/);
  });

  it("rejects an unregistered repo name", () => {
    expect(() =>
      writeIdleLoops(
        path,
        [{ key: "idle_coverage", enabled: true, repos: ["ghost"] }],
        ["api", "web"],
      ),
    ).toThrow(/Unknown repo name/);
  });

  it("rejects a write when crew.yaml is missing", () => {
    const missing = join(dir, "absent.yaml");
    expect(() =>
      writeIdleLoops(missing, [{ key: "idle_coverage", enabled: true, repos: [] }], ["api"]),
    ).toThrow(/No crew.yaml/);
  });

  it("resolveCrewConfigPath honours CREW_CONFIG then GAFFER_DATA", () => {
    expect(resolveCrewConfigPath({ CREW_CONFIG: "/tmp/x/crew.yaml" })).toBe("/tmp/x/crew.yaml");
    expect(resolveCrewConfigPath({ GAFFER_DATA: "/tmp/data" })).toBe("/tmp/data/crew.yaml");
  });
});

interface Harness {
  wg: Dispatch;
  baseUrl: string;
  close: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const wg = Dispatch.open(":memory:", new TestClock());
  const server = createApiServer(wg);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    wg,
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

describe("API: /api/idle-loops", () => {
  let h: Harness;
  let dir: string;
  let crewPath: string;
  let priorCrewConfig: string | undefined;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "wg-idle-api-"));
    crewPath = join(dir, "crew.yaml");
    writeFileSync(crewPath, crewYaml(), "utf8");
    // The route resolves the path from process.env; point it at our temp file.
    priorCrewConfig = process.env.CREW_CONFIG;
    process.env.CREW_CONFIG = crewPath;
    h = await startHarness();
    // Register the repos the crew.yaml references so name validation passes.
    h.wg.registerRepository({ name: "api" }, human);
    h.wg.registerRepository({ name: "web" }, human);
  });
  afterEach(async () => {
    await h.close();
    if (priorCrewConfig === undefined) delete process.env.CREW_CONFIG;
    else process.env.CREW_CONFIG = priorCrewConfig;
    rmSync(dir, { recursive: true, force: true });
  });

  it("GET returns the idle loops from crew.yaml", async () => {
    const res = await call(h.baseUrl, "GET", "/api/idle-loops");
    expect(res.status).toBe(200);
    const view = res.body.idle_loops as { configured: boolean; loops: { key: string }[] };
    expect(view.configured).toBe(true);
    expect(view.loops.map((l) => l.key)).toEqual([...IDLE_LOOP_KEYS]);
  });

  it("PUT writes enabled + repos and round-trips to disk", async () => {
    const res = await call(h.baseUrl, "PUT", "/api/idle-loops", {
      loops: [{ key: "idle_coverage", enabled: true, repos: ["api"] }],
    });
    expect(res.status).toBe(200);
    const view = res.body.idle_loops as {
      loops: { key: string; enabled: boolean; repos: string[] }[];
    };
    const coverage = view.loops.find((l) => l.key === "idle_coverage")!;
    expect(coverage.enabled).toBe(true);
    expect(coverage.repos).toEqual(["api"]);

    // Confirm it landed in the actual file.
    const doc = parseYaml(readFileSync(crewPath, "utf8")) as Record<string, unknown>;
    const loops = doc.loops as Record<string, Record<string, unknown>>;
    expect(loops.idle_coverage!.enabled).toBe(true);
    expect(loops.idle_coverage!.repos).toEqual(["api"]);
  });

  it("PUT rejects an unknown loop key with a 422", async () => {
    const res = await call(h.baseUrl, "PUT", "/api/idle-loops", {
      loops: [{ key: "idle_bogus", enabled: true, repos: [] }],
    });
    expect(res.status).toBe(422);
    expect((res.body.error as { code: string }).code).toBe("VALIDATION_ERROR");
  });

  it("PUT rejects an unregistered repo name with a 422", async () => {
    const res = await call(h.baseUrl, "PUT", "/api/idle-loops", {
      loops: [{ key: "idle_coverage", enabled: true, repos: ["ghost"] }],
    });
    expect(res.status).toBe(422);
    expect((res.body.error as { code: string }).code).toBe("VALIDATION_ERROR");
  });
});
