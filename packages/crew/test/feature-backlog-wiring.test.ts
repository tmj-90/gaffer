/**
 * The idle feature-backlog loop against the REAL memory-mcp server.
 *
 * Live audit: with the Settings toggle on, the loop never planned a feature —
 *   (a) a `crew init` config leaves memory.mcp.command and decompose_script null and
 *       nothing set them, so there was no memory client and no decomposer;
 *   (b) the stdio transport dropped MEMORY_DB, so memory-mcp opened the operator's
 *       global ~/.memory/lore.db instead of the factory DB;
 *   (c) advance_feature was called with `toStatus`; the server requires `to_status`,
 *       so every claim failed;
 *   (d) SpawnDecomposer omitted --force-plan, so an unattended first-turn clarify
 *       rolled the feature back.
 * The mock-server unit tests mirrored the client's wrong arg name, so they passed.
 * This drives the real server (skipped when packages/memory is not built).
 */
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SpawnDecomposer } from "../src/adapters/decomposer.js";
import { resolveDecomposer } from "../src/adapters/decomposerFactory.js";
import { applyFactoryWiringEnv } from "../src/config/loader.js";
import { crewConfigSchema, type CrewConfig } from "../src/config/schema.js";
import { RealDispatchClient } from "../src/dispatch/realClient.js";
import { memoryServerEnv, resolveAsyncMemory } from "../src/memory/factory.js";

const MEMORY_MCP = resolve(__dirname, "../../memory/dist/bin/memory-mcp.js");
const haveMemory = existsSync(MEMORY_MCP);

function baseConfig(): CrewConfig {
  return crewConfigSchema.parse({ factory: { name: "t" } });
}

describe("applyFactoryWiringEnv (the runner's fg fallbacks)", () => {
  it("fills a null memory command and decompose_script from the env", () => {
    const cfg = applyFactoryWiringEnv(
      baseConfig(),
      { CREW_MEMORY_MCP_BIN: "/x/memory-mcp.js", CREW_DECOMPOSE_SCRIPT: "/r/bin/decompose.mjs" },
      "/usr/bin/node",
    );
    expect(cfg.memory.mcp).toEqual({ command: "/usr/bin/node", args: ["/x/memory-mcp.js"] });
    expect(cfg.loops.idle_feature_backlog.decompose_script).toBe("/r/bin/decompose.mjs");
  });

  it("never overrides an explicit crew.yaml value, and is inert without the env", () => {
    const explicit = crewConfigSchema.parse({
      factory: { name: "t" },
      memory: { mcp: { command: "memory-mcp", args: [] } },
      loops: { idle_feature_backlog: { decompose_script: "/mine.mjs" } },
    });
    const cfg = applyFactoryWiringEnv(explicit, {
      CREW_MEMORY_MCP_BIN: "/x/memory-mcp.js",
      CREW_DECOMPOSE_SCRIPT: "/r/bin/decompose.mjs",
    });
    expect(cfg.memory.mcp.command).toBe("memory-mcp");
    expect(cfg.loops.idle_feature_backlog.decompose_script).toBe("/mine.mjs");
    const base = baseConfig();
    expect(applyFactoryWiringEnv(base, {})).toBe(base);
  });

  it("with the toggle on, the env-wired config resolves a real decomposer", () => {
    const cfg = applyFactoryWiringEnv(
      crewConfigSchema.parse({
        factory: { name: "t" },
        loops: { idle_feature_backlog: { enabled: true } },
      }),
      { CREW_DECOMPOSE_SCRIPT: "/r/bin/decompose.mjs" },
    );
    expect(resolveDecomposer(cfg)).toBeInstanceOf(SpawnDecomposer);
  });
});

describe("RealDispatchClient.createEpic against the real dispatch", () => {
  const plan = (ready: boolean) => ({
    name: "Dark mode",
    description: "Theme toggle",
    ready,
    tickets: [
      { title: "Theme state", acceptanceCriteria: ["theme persists"] },
      { title: "Toggle UI", acceptanceCriteria: ["toggle flips theme"], dependsOn: [0] },
    ],
  });

  it("files DRAFTS carrying the plan's ACs and dependency order, with real ticket ids", async () => {
    const client = await RealDispatchClient.open(":memory:");
    const res = client.createEpic(plan(false));
    // The two plan tickets + the epic acceptance ticket dispatch appends.
    expect(res.ticketIds).toHaveLength(3);
    const first = client.getTicket(res.ticketIds[0]!);
    expect(first.ticket.status).toBe("draft");
    expect(first.ticket.title).toBe("Theme state");
    expect(first.acceptanceCriteria.map((a) => a.text)).toEqual(["theme persists"]);
    const second = client.getTicket(res.ticketIds[1]!);
    expect(second.ticket.status).toBe("draft");
    expect(second.ticket.title).toBe("Toggle UI");
  });

  it("create_ready_tickets readies each ticket through the gate-aware markReady", async () => {
    // Dispatch returns ticket NUMBERS; markReady needs ids. Passing the number used to
    // throw not-found inside a swallowed catch, so a "ready" epic stayed all drafts.
    const client = await RealDispatchClient.open(":memory:");
    const res = client.createEpic(plan(true));
    expect(res.ticketIds).toHaveLength(3);
    expect(res.ticketIds.map((id) => client.getTicket(id).ticket.status)).toEqual([
      "ready",
      "ready",
      "ready",
    ]);
  });
});

describe("memoryServerEnv", () => {
  it("forwards MEMORY_* and the SDK default env, nothing else", () => {
    const env = memoryServerEnv({
      MEMORY_DB: "/d/memory.sqlite",
      MEMORY_AUDIT_LOG: "/d/audit.log",
      GAFFER_FACTORY: "1",
      DISPATCH_API_TOKEN: "secret",
    });
    expect(env.MEMORY_DB).toBe("/d/memory.sqlite");
    expect(env.MEMORY_AUDIT_LOG).toBe("/d/audit.log");
    expect(env.GAFFER_FACTORY).toBeUndefined();
    expect(env.DISPATCH_API_TOKEN).toBeUndefined();
  });
});

describe("SpawnDecomposer", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "crew-decomposer-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("runs the helper with --force-plan (unattended: no human answers a clarify round)", async () => {
    const script = join(dir, "decompose.mjs");
    writeFileSync(
      script,
      `const argv = process.argv.slice(2);\n` +
        `process.stdout.write(JSON.stringify({ phase: argv.includes("--force-plan") ? "plan" : "clarify",\n` +
        `  questions: ["web or mobile?"],\n` +
        `  plan: { epic: { name: "E", description: argv.join(" ") }, tickets: [{ title: "t", acceptanceCriteria: ["a"] }] } }));\n`,
    );
    chmodSync(script, 0o755);
    const plan = await new SpawnDecomposer({ scriptPath: script, timeoutMs: 20_000 }).decompose({
      brief: "Dark mode: a theme toggle",
      repo: "app",
    });
    expect(plan.epic.description).toContain("--force-plan");
    expect(plan.tickets[0]!.repo).toBe("app");
  });
});

describe.skipIf(!haveMemory)("McpMemoryClient against the real memory-mcp", () => {
  let dir: string;
  const saved = { MEMORY_DB: process.env.MEMORY_DB, HOME: process.env.HOME };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "crew-real-memory-"));
    process.env.MEMORY_DB = join(dir, "memory.sqlite");
    // A wrong (pre-fix) client would open $HOME/.memory/lore.db — keep it in the temp dir.
    process.env.HOME = join(dir, "home");
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("claims a backlog feature into `building` in the FACTORY's MEMORY_DB", async () => {
    const config = applyFactoryWiringEnv(baseConfig(), { CREW_MEMORY_MCP_BIN: MEMORY_MCP });
    const memory = await resolveAsyncMemory(config);
    expect(memory).not.toBeNull();
    try {
      const added = await memory!.addFeature({
        repo: "app",
        name: "Dark mode",
        summary: "A theme toggle",
        status: "backlog",
        area: "ui",
        provenance: "test",
      });
      const backlog = await memory!.listBacklogFeatures("app", "backlog");
      expect(backlog.map((f) => f.id)).toEqual([added.featureId]);

      const res = await memory!.advanceFeature(added.featureId, "building");
      expect(res.status).toBe("building");
      expect(await memory!.listBacklogFeatures("app", "backlog")).toEqual([]);
      const building = await memory!.listBacklogFeatures("app", "building");
      expect(building.map((f) => f.id)).toEqual([added.featureId]);
    } finally {
      await memory!.close();
    }
    // The server wrote the factory DB, not the operator's global store.
    expect(existsSync(process.env.MEMORY_DB!)).toBe(true);
    expect(existsSync(join(dir, "home", ".memory", "lore.db"))).toBe(false);
  }, 60_000);
});
