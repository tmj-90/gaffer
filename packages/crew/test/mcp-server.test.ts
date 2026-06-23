/**
 * Smoke test for the Crew MCP server. Builds the server and tool handlers
 * against a temp config and a REAL shared Dispatch (via RealDispatchClient,
 * like test/e2e-mvp.test.ts), then asserts:
 *   - `tools/list` over a real in-memory MCP client/server round-trip;
 *   - a read-only tool (check_command_allowed) denies a destructive command;
 *   - the mutating tool (run_idle_loop) creates a DRAFT ticket.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { Dispatch } from "dispatch";

import { initFactory } from "../src/config/init.js";
import { EventLog } from "../src/events/eventLog.js";
import { runIdleLoops } from "../src/loops/idleRegistry.js";
import { createCrewServer } from "../src/mcp/server.js";
import { makeHandlers, toolSchemas, type ToolResult } from "../src/mcp/tools.js";
import { systemCommandRunner } from "../src/adapters/commandRunner.js";
import { loadFactory } from "../src/runtime/wiring.js";
import { systemClock } from "../src/util/clock.js";
import { RealDispatchClient } from "../src/dispatch/realClient.js";
import type { DispatchClient } from "../src/dispatch/client.js";

const human = { type: "human", id: "demo" } as const;

function structured(result: ToolResult): Record<string, unknown> {
  return result.structuredContent;
}

describe("MCP server: factory tools", () => {
  let tmp: string;
  let wg: ReturnType<typeof Dispatch.open>;
  let dispatch: DispatchClient;
  let ctx: ReturnType<typeof loadFactory>;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "gaffer-mcp-"));
    initFactory({ dir: tmp, factoryName: "mcp-factory", force: true });

    // One repo with a coverage command so the idle loop has work to do.
    const cfgPath = join(tmp, "crew.yaml");
    const cfg = parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    cfg.repos = [
      {
        id: "demo-repo",
        name: "demo-repo",
        path: tmp,
        default_branch: "main",
        stack: "node",
        test_command: "echo tests",
        coverage_command: "echo 'TOTAL 120 43 64%'",
      },
    ];
    cfg.agents = [
      { id: "agent-a", display_name: "Agent A", capabilities: ["impl"], max_risk: "high" },
    ];
    const idleCfg = cfg.loops as { idle_coverage: { enabled: boolean; repos: string[] } };
    idleCfg.idle_coverage.enabled = true;
    idleCfg.idle_coverage.repos = ["demo-repo"];
    writeFileSync(cfgPath, stringify(cfg));

    ctx = loadFactory({ config: cfgPath });

    // Real Dispatch, shared via fromFacade so the idle loop mutates the store
    // every tool observes.
    wg = Dispatch.open(":memory:");
    wg.registerRepository(
      { name: "demo-repo", local_path: tmp, default_branch: "main", test_command: "echo tests" },
      human,
    );
    // A real Dispatch satisfies the facade at runtime; cast past the strict
    // Record<string, unknown> return-shape variance.
    dispatch = RealDispatchClient.fromFacade(
      wg as unknown as Parameters<typeof RealDispatchClient.fromFacade>[0],
    );
  });

  afterAll(() => {
    wg.db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("exposes exactly the eight factory tools over tools/list", async () => {
    const server = createCrewServer({ ctx, dispatchOpener: async () => dispatch });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(Object.keys(toolSchemas).sort());
    expect(names).toContain("get_factory_status");
    expect(names).toContain("run_idle_loop");

    await client.close();
  });

  it("check_command_allowed denies 'git push --force'", async () => {
    const handlers = makeHandlers({ ctx, openDispatch: async () => dispatch });
    const result = await handlers.check_command_allowed({ command: "git push --force" });
    const decision = structured(result).decision as { allowed: boolean; outcome: string };
    expect(result.isError).toBeUndefined();
    expect(decision.allowed).toBe(false);
    expect(decision.outcome).toBe("denied");
  });

  it("run_idle_loop runs the full idle registry and creates a draft ticket", async () => {
    const handlers = makeHandlers({ ctx, openDispatch: async () => dispatch });
    const result = await handlers.run_idle_loop({});
    // MCP now runs the SAME registry as the CLI, so the response carries a
    // `report` with per-loop outcomes (not a single coverage `outcome`).
    const report = structured(result).report as {
      loops: Array<{ id: string; outcome: { status: string } }>;
      totalDrafts: number;
    };
    expect(report.loops.length).toBeGreaterThan(0);
    const coverage = report.loops.find((l) => l.id === "coverage");
    expect(coverage?.outcome.status).toBe("draft_created");
    expect(report.totalDrafts).toBeGreaterThanOrEqual(1);

    // The coverage draft is observable in the shared Dispatch store.
    const drafts = wg.list("draft");
    expect(drafts.length).toBeGreaterThanOrEqual(1);
    expect(wg.view(String(drafts[0]!.id)).ticket.status).toBe("draft");
  });

  it("MCP run_idle_loop covers the SAME loop set as the CLI idle registry", async () => {
    const handlers = makeHandlers({ ctx, openDispatch: async () => dispatch });
    const mcp = structured(await handlers.run_idle_loop({})).report as {
      loops: Array<{ id: string }>;
    };
    const mcpLoopIds = mcp.loops.map((l) => l.id).sort();

    // The CLI idle path runs runIdleLoops with the same deps; the enabled loop
    // set MUST match so the two surfaces can't drift.
    const events = new EventLog(systemClock);
    const cli = runIdleLoops({
      config: ctx.loaded.config,
      repoRegistry: ctx.repoRegistry,
      dispatch,
      runner: systemCommandRunner,
      events,
      clock: systemClock,
    });
    const cliLoopIds = cli.loops.map((l) => l.id).sort();

    expect(mcpLoopIds).toEqual(cliLoopIds);
    expect(mcpLoopIds.length).toBeGreaterThan(0);
  });

  it("get_factory_status reports repo/agent counts and dispatch reachability", async () => {
    const handlers = makeHandlers({ ctx, openDispatch: async () => dispatch });
    const status = structured(await handlers.get_factory_status({}));
    expect((status.factory as { name: string }).name).toBe("mcp-factory");
    expect(status.repoCount).toBe(1);
    expect(status.agentCount).toBe(1);
    expect((status.dispatch as { ok: boolean }).ok).toBe(true);
  });

  it("get_factory_status.dispatch.ok reflects a real read, not just an open()", async () => {
    // A store that opens but throws on the first read must report ok:false with the
    // error code — proving the probe is a query, not a vacuous open() (open() would
    // succeed and falsely claim reachability).
    const brokenStore: DispatchClient = {
      ...dispatch,
      listReady() {
        throw new Error("no such table: tickets");
      },
    };
    const handlers = makeHandlers({ ctx, openDispatch: async () => brokenStore });
    const status = structured(await handlers.get_factory_status({}));
    const wg2 = status.dispatch as { ok: boolean; error?: { code: string; message: string } };
    expect(wg2.ok).toBe(false);
    expect(wg2.error?.message).toContain("no such table");
  });
});
