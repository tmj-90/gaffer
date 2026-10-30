/**
 * crew-mcp sees the same repos `crew idle` does.
 *
 * Regression: run_idle_loop (and list_repos, get_factory_status,
 * get_context_packet, check_path_write_allowed) read crew.yaml's `repos:` only,
 * while `crew idle` / `crew maintain` merge in Dispatch's registry — the one
 * dashboard onboarding writes. On a dashboard-onboarded factory (crew.yaml
 * `repos: []`) the MCP idle tool answered `no_repos` forever while `crew idle`
 * drafted work. Both now run the one shared tick (loops/idleTick.ts).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

import { systemCommandRunner } from "../src/adapters/commandRunner.js";
import { initFactory } from "../src/config/init.js";
import { FakeDispatchClient } from "../src/dispatch/fakeClient.js";
import { EventLog } from "../src/events/eventLog.js";
import { runIdleTick } from "../src/loops/idleTick.js";
import { makeHandlers, type ToolResult } from "../src/mcp/tools.js";
import { loadFactory } from "../src/runtime/wiring.js";
import { systemClock } from "../src/util/clock.js";

type Report = { loops: Array<{ id: string; outcome: { status: string } }>; totalDrafts: number };

function structured(result: ToolResult): Record<string, unknown> {
  return result.structuredContent;
}

describe("crew-mcp merges Dispatch's repo registry like `crew idle`", () => {
  let tmp: string;
  let ctx: ReturnType<typeof loadFactory>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gaffer-mcp-dispatch-repos-"));
    initFactory({ dir: tmp, factoryName: "mcp-dispatch-repos", force: true });
    const cfgPath = join(tmp, "crew.yaml");
    const cfg = parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    cfg.repos = []; // dashboard-onboarded: crew.yaml lists NO repos
    const loops = cfg.loops as {
      idle_coverage: { enabled: boolean; repos: string[]; minimum_gap_threshold: number };
    };
    loops.idle_coverage.enabled = true;
    loops.idle_coverage.repos = [];
    loops.idle_coverage.minimum_gap_threshold = 80; // the seeded 64% is below this target
    writeFileSync(cfgPath, stringify(cfg));
    ctx = loadFactory({ config: cfgPath });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  /** A Dispatch holding the one onboarded repo, with a coverage gap to find. */
  function dispatchWithRepo(): FakeDispatchClient {
    const wg = new FakeDispatchClient();
    wg.seedRepository({
      id: "repo-1",
      name: "onboarded-app",
      localPath: tmp,
      coverageCommand: "echo 'TOTAL 120 43 64%'",
    });
    return wg;
  }

  it("run_idle_loop scans a Dispatch-only repo instead of answering no_repos", async () => {
    const wg = dispatchWithRepo();
    const handlers = makeHandlers({ ctx, openDispatch: async () => wg });
    const report = structured(await handlers.run_idle_loop({})).report as Report;
    const coverage = report.loops.find((l) => l.id === "coverage");
    expect(coverage?.outcome.status).not.toBe("no_repos");
    expect(coverage?.outcome.status).toBe("draft_created");
    expect(report.totalDrafts).toBeGreaterThanOrEqual(1);
  });

  it("matches the shared idle tick the CLI runs, loop by loop", async () => {
    const handlers = makeHandlers({ ctx, openDispatch: async () => dispatchWithRepo() });
    const mcp = structured(await handlers.run_idle_loop({})).report as Report;
    const cli = await runIdleTick({
      config: ctx.loaded.config,
      repoRegistry: ctx.repoRegistry,
      dispatch: dispatchWithRepo(),
      runner: systemCommandRunner,
      events: new EventLog(systemClock),
      clock: systemClock,
      resolveMemory: async () => null,
    });
    expect(cli.repoIds).toEqual(["repo-1"]);
    const statuses = (r: Report) => r.loops.map((l) => [l.id, l.outcome.status]);
    expect(statuses(mcp)).toEqual(statuses(cli.report));
  });

  it("list_repos and get_factory_status include the Dispatch repo", async () => {
    const wg = dispatchWithRepo();
    const handlers = makeHandlers({ ctx, openDispatch: async () => wg });
    const repos = structured(await handlers.list_repos({})).repos as Array<{ name: string }>;
    expect(repos.map((r) => r.name)).toEqual(["onboarded-app"]);
    const status = structured(await handlers.get_factory_status({}));
    expect(status.repoCount).toBe(1);
  });

  it("list_repos falls back to crew.yaml's repos when Dispatch can't be opened", async () => {
    const handlers = makeHandlers({
      ctx,
      openDispatch: async () => {
        throw new Error("dispatch down");
      },
    });
    const result = await handlers.list_repos({});
    expect(result.isError).toBeUndefined();
    expect(structured(result).repos).toEqual([]);
  });
});
