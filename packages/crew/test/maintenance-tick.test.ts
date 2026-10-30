/**
 * `crew maintain`'s tick (runMaintenanceTick): the maintenance lane is the default
 * idle path, so ingest and the async loops (lore gap, feature backlog) must run on
 * it — they used to run only on the legacy every-loop `crew idle` scan, which the
 * runner reaches only with the lane OFF. Also pins what the runner reads: `filed`
 * (what the tick produced) and `spent` (a model-backed step ran).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CommandResult, CommandRunner } from "../src/adapters/commandRunner.js";
import type { Decomposer, EpicPlan } from "../src/adapters/decomposer.js";
import { crewConfigSchema, type CrewConfig } from "../src/config/schema.js";
import { FakeDispatchClient } from "../src/dispatch/fakeClient.js";
import { EventLog } from "../src/events/eventLog.js";
import { runMaintenanceTick } from "../src/loops/idleTick.js";
import type {
  AdvanceFeatureResult,
  BacklogFeature,
  ExistingFeature,
  FeatureResult,
  FeatureStatus,
  LoreRecord,
  LoreSuggestionResult,
  RepoDigestInput,
  RepoDigestResult,
} from "../src/memory/client.js";
import type { AsyncMemoryClient } from "../src/memory/mcpClient.js";
import { RepoRegistry } from "../src/registry/repoRegistry.js";
import { TestClock } from "../src/util/clock.js";
import { CrewError } from "../src/util/errors.js";

/** `gh issue list` answers one labelled issue; every other command succeeds silently. */
class GhRunner implements CommandRunner {
  readonly commands: string[] = [];
  run(command: string): CommandResult {
    this.commands.push(command);
    if (command.startsWith("gh issue list")) {
      return {
        stdout: JSON.stringify([
          { number: 7, title: "Export breaks", body: "b", url: "https://github.com/o/r/issues/7" },
        ]),
        exitCode: 0,
      };
    }
    return { stdout: "", exitCode: 0 };
  }
  runArgs(): CommandResult {
    return { stdout: "", exitCode: 0 };
  }
}

/** One backlog feature; claim/release follow memory's lifecycle. */
class OneFeatureMemory implements AsyncMemoryClient {
  status: FeatureStatus = "backlog";
  closed = false;
  async searchLore(): Promise<LoreRecord[]> {
    return [];
  }
  async suggestLore(): Promise<LoreSuggestionResult> {
    return { suggestionId: "s", status: "draft" };
  }
  async updateRepoDigest(i: RepoDigestInput): Promise<RepoDigestResult> {
    return { repo: i.repo, status: "updated" };
  }
  async listFeatures(): Promise<ExistingFeature[]> {
    return [];
  }
  async listBacklogFeatures(repo: string, status: FeatureStatus): Promise<BacklogFeature[]> {
    return this.status === status
      ? [{ id: "f1", repo, name: "Export", summary: "CSV", status }]
      : [];
  }
  async addFeature(): Promise<FeatureResult> {
    return { featureId: "f", status: "added" };
  }
  async advanceFeature(id: string, to: FeatureStatus): Promise<AdvanceFeatureResult> {
    this.status = to;
    return { id, status: to };
  }
  async releaseFeature(id: string): Promise<AdvanceFeatureResult> {
    this.status = "backlog";
    return { id, status: "backlog" };
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

const PLAN: EpicPlan = {
  epic: { name: "Export", description: "" },
  tickets: [
    {
      title: "Add export",
      description: "d",
      acceptanceCriteria: ["works"],
      priority: 1,
      repo: "demo",
      bootstrap: false,
      dependsOn: [],
    },
  ],
};

describe("runMaintenanceTick", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gaffer-maint-tick-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function config(): CrewConfig {
    return crewConfigSchema.parse({
      factory: { name: "t" },
      repos: [{ id: "demo", name: "demo", path: tmp, remote_url: "https://github.com/o/r.git" }],
    });
  }

  function deps(cfg: CrewConfig, opts: { memory?: AsyncMemoryClient; decomposer?: Decomposer }) {
    const runner = new GhRunner();
    const dispatch = new FakeDispatchClient();
    return {
      runner,
      dispatch,
      tickDeps: {
        config: cfg,
        repoRegistry: RepoRegistry.fromConfig(cfg, tmp),
        dispatch,
        runner,
        events: new EventLog(new TestClock()),
        clock: new TestClock(),
        env: {},
        resolveMemory: async () => opts.memory ?? null,
        resolveDecomposer: () => opts.decomposer ?? null,
      },
    };
  }

  it("ingests labelled GitHub issues on a maintenance tick and counts them as filed", async () => {
    const cfg = config();
    cfg.loops.maintenance.enabled = true;
    cfg.ingest.github.enabled = true;
    const { tickDeps, runner } = deps(cfg, {});
    const tick = await runMaintenanceTick(tickDeps, join(tmp, "cursor.json"));
    expect(runner.commands.some((c) => c.startsWith("gh issue list"))).toBe(true);
    expect(tick.ingest?.ingested).toHaveLength(1);
    expect(tick.report.chosen).toBeNull(); // no scan lane enabled — ingest still ran
    expect(tick.filed).toBe(1);
    expect(tick.spent).toBe(false);
  });

  it("runs the feature backlog alongside the lane; spent=true when it planned", async () => {
    const cfg = config();
    cfg.loops.maintenance.enabled = true;
    cfg.loops.idle_feature_backlog.enabled = true;
    const memory = new OneFeatureMemory();
    const { tickDeps } = deps(cfg, { memory, decomposer: { decompose: async () => PLAN } });
    const tick = await runMaintenanceTick(tickDeps, join(tmp, "cursor.json"));
    expect(tick.featureBacklog?.outcome.status).toBe("draft_created");
    expect(tick.filed).toBe(1);
    expect(tick.spent).toBe(true);
    expect(memory.closed).toBe(true);
  });

  it("a failed planning call still reports spent (the runner counts it against the day cap)", async () => {
    const cfg = config();
    cfg.loops.maintenance.enabled = true;
    cfg.loops.idle_feature_backlog.enabled = true;
    const memory = new OneFeatureMemory();
    const { tickDeps } = deps(cfg, {
      memory,
      decomposer: {
        decompose: async () => {
          throw new CrewError("DECOMPOSE_FAILED", "no plan");
        },
      },
    });
    const tick = await runMaintenanceTick(tickDeps, join(tmp, "cursor.json"));
    expect(tick.filed).toBe(0);
    expect(tick.spent).toBe(true);
    expect(memory.status).toBe("backlog"); // released, not stranded
  });

  it("does nothing beyond reporting `disabled` while the lane is off (no ingest, no memory)", async () => {
    const cfg = config();
    cfg.ingest.github.enabled = true;
    cfg.loops.idle_feature_backlog.enabled = true;
    const memory = new OneFeatureMemory();
    const { tickDeps, runner } = deps(cfg, { memory, decomposer: { decompose: async () => PLAN } });
    const tick = await runMaintenanceTick(tickDeps, join(tmp, "cursor.json"));
    expect(tick.report.outcome).toEqual({ status: "disabled" });
    expect(runner.commands).toHaveLength(0);
    expect(tick.featureBacklog).toBeNull();
    expect(tick.spent).toBe(false);
  });

  it("does not spawn a memory server when no async loop is enabled", async () => {
    const cfg = config();
    cfg.loops.maintenance.enabled = true;
    let asked = 0;
    const { tickDeps } = deps(cfg, {});
    tickDeps.resolveMemory = async () => {
      asked += 1;
      return null;
    };
    await runMaintenanceTick(tickDeps, join(tmp, "cursor.json"));
    expect(asked).toBe(0);
  });
});
