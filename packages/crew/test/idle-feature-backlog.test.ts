import { describe, expect, it } from "vitest";

import { FakeCommandRunner } from "../src/adapters/commandRunner.js";
import {
  parseEpicPlan,
  type Decomposer,
  type DecomposeRequest,
  type EpicPlan,
} from "../src/adapters/decomposer.js";
import { EventLog } from "../src/events/eventLog.js";
import {
  pickBacklogFeature,
  runIdleFeatureBacklogLoop,
  type IdleFeatureBacklogDeps,
} from "../src/loops/idleFeatureBacklog.js";
import { runIdleFeatureBacklog } from "../src/loops/idleRegistry.js";
import { CrewError } from "../src/util/errors.js";
import { RepoRegistry } from "../src/index.js";
import { TestClock } from "../src/util/clock.js";
import { FakeDispatchClient } from "../src/dispatch/fakeClient.js";
import { crewConfigSchema, type CrewConfig, type IdleLoopMode } from "../src/config/schema.js";
import type {
  AdvanceFeatureResult,
  BacklogFeature,
  ExistingFeature,
  FeatureInput,
  FeatureResult,
  FeatureStatus,
  LoreRecord,
  LoreSearchQuery,
  LoreSuggestionInput,
  LoreSuggestionResult,
  RepoDigestInput,
  RepoDigestResult,
} from "../src/memory/client.js";
import type { AsyncMemoryClient } from "../src/memory/mcpClient.js";

/** A memory client that serves seeded backlog features + records advances. */
class FakeMemory implements AsyncMemoryClient {
  readonly advances: Array<{ id: string; toStatus: FeatureStatus }> = [];
  /** Force listBacklogFeatures to throw for a repo (models a dead lookup). */
  listThrowsFor = new Set<string>();

  constructor(private features: BacklogFeature[] = []) {}

  /** Current ledger state for a feature id (reflects recorded advances). */
  statusOf(id: string): FeatureStatus | undefined {
    const advanced = [...this.advances].reverse().find((a) => a.id === id);
    if (advanced) return advanced.toStatus;
    return this.features.find((f) => f.id === id)?.status;
  }

  async searchLore(_q: LoreSearchQuery): Promise<LoreRecord[]> {
    return [];
  }
  async suggestLore(_i: LoreSuggestionInput): Promise<LoreSuggestionResult> {
    return { suggestionId: "x", status: "draft" };
  }
  async updateRepoDigest(input: RepoDigestInput): Promise<RepoDigestResult> {
    return { repo: input.repo, status: "updated" };
  }
  async listFeatures(repo: string): Promise<ExistingFeature[]> {
    return this.features
      .filter((f) => f.repo === repo)
      .map((f) => ({ repo: f.repo, name: f.name }));
  }
  async listBacklogFeatures(repo: string, status: FeatureStatus): Promise<BacklogFeature[]> {
    if (this.listThrowsFor.has(repo)) throw new CrewError("MEMORY_UNAVAILABLE", "boom");
    return this.features.filter(
      (f) => f.repo === repo && (this.statusOf(f.id) ?? f.status) === status,
    );
  }
  async advanceFeature(id: string, toStatus: FeatureStatus): Promise<AdvanceFeatureResult> {
    this.advances.push({ id, toStatus });
    return { id, status: toStatus };
  }
  async addFeature(_input: FeatureInput): Promise<FeatureResult> {
    return { featureId: "f", status: "added" };
  }
  async close(): Promise<void> {}
}

/** A decomposer returning a canned plan, or throwing when configured to fail. */
class FakeDecomposer implements Decomposer {
  readonly calls: DecomposeRequest[] = [];
  constructor(
    private readonly behaviour: { kind: "ok"; plan: EpicPlan } | { kind: "fail"; error: Error },
  ) {}
  async decompose(request: DecomposeRequest): Promise<EpicPlan> {
    this.calls.push(request);
    if (this.behaviour.kind === "fail") throw this.behaviour.error;
    return this.behaviour.plan;
  }
}

function plan(repo: string): EpicPlan {
  return {
    epic: { name: "Add export", description: "Export the thing." },
    tickets: [
      {
        title: "Wire export endpoint",
        description: "Add the route.",
        acceptanceCriteria: ["GET /export returns 200"],
        priority: 1,
        repo,
        bootstrap: false,
        dependsOn: [],
      },
      {
        title: "Add export button",
        description: "UI hook-up.",
        acceptanceCriteria: ["Button triggers download"],
        priority: 2,
        repo,
        bootstrap: false,
        dependsOn: [0],
      },
    ],
  };
}

function feature(over: Partial<BacklogFeature> = {}): BacklogFeature {
  return {
    id: over.id ?? "feat-1",
    repo: over.repo ?? "demo",
    name: over.name ?? "Data export",
    summary: over.summary ?? "Let users export their data as CSV.",
    status: over.status ?? "backlog",
    ...(over.priority !== undefined ? { priority: over.priority } : {}),
    ...(over.createdAt !== undefined ? { createdAt: over.createdAt } : {}),
  };
}

function config(mode: IdleLoopMode = "create_draft_tickets"): CrewConfig {
  const cfg = crewConfigSchema.parse({
    factory: { name: "test", mode: "local_strict" },
    repos: [{ id: "demo", name: "demo", path: "/tmp/demo" }],
  });
  cfg.loops.idle_feature_backlog.enabled = true;
  cfg.loops.idle_feature_backlog.mode = mode;
  cfg.loops.idle_feature_backlog.decompose_script = "/tmp/decompose.mjs";
  return cfg;
}

function deps(
  cfg: CrewConfig,
  memory: FakeMemory,
  decomposer: Decomposer,
  wg = new FakeDispatchClient(),
): IdleFeatureBacklogDeps {
  return {
    config: cfg,
    repoRegistry: RepoRegistry.fromConfig(cfg, "/tmp"),
    dispatch: wg,
    runner: new FakeCommandRunner({ stdout: "", exitCode: 0 }),
    events: new EventLog(new TestClock()),
    clock: new TestClock(),
    memory: memory,
    decomposer,
  };
}

describe("pickBacklogFeature ordering", () => {
  it("prefers lower priority, then oldest, then id", () => {
    const chosen = pickBacklogFeature([
      feature({ id: "c", priority: 2 }),
      feature({ id: "a", priority: 1, createdAt: "2026-02-01T00:00:00.000Z" }),
      feature({ id: "b", priority: 1, createdAt: "2026-01-01T00:00:00.000Z" }),
    ]);
    expect(chosen?.id).toBe("b"); // priority 1 + oldest createdAt
  });

  it("falls back to createdAt then id when no priority", () => {
    const chosen = pickBacklogFeature([
      feature({ id: "z", createdAt: "2026-03-01T00:00:00.000Z" }),
      feature({ id: "y", createdAt: "2026-01-01T00:00:00.000Z" }),
    ]);
    expect(chosen?.id).toBe("y");
  });

  it("returns undefined for an empty list", () => {
    expect(pickBacklogFeature([])).toBeUndefined();
  });
});

describe("parseEpicPlan", () => {
  it("accepts a brownfield plan and stamps the repo on every ticket", () => {
    const out = JSON.stringify({
      phase: "plan",
      plan: { epic: { name: "E", description: "" }, tickets: [{ title: "t", priority: 0 }] },
    });
    const parsed = parseEpicPlan(out, "demo");
    expect(parsed.tickets[0]!.repo).toBe("demo");
  });

  it("rejects a clarify phase", () => {
    const out = JSON.stringify({ phase: "clarify", questions: ["web or mobile?"] });
    expect(() => parseEpicPlan(out, "demo")).toThrow(/not a plan/i);
  });

  it("rejects a bootstrap ticket (brownfield must have none)", () => {
    const out = JSON.stringify({
      phase: "plan",
      plan: { epic: { name: "E", description: "" }, tickets: [{ title: "t", bootstrap: true }] },
    });
    expect(() => parseEpicPlan(out, "demo")).toThrow(/bootstrap/i);
  });

  it("rejects a plan over the ticket cap", () => {
    const out = JSON.stringify({
      phase: "plan",
      plan: {
        epic: { name: "E", description: "" },
        tickets: [{ title: "a" }, { title: "b" }, { title: "c" }],
      },
    });
    expect(() => parseEpicPlan(out, "demo", 2)).toThrow(/over the 2 cap/i);
  });
});

describe("idle feature-backlog loop", () => {
  it("advances one feature to building and files a DRAFT epic in create_draft mode", async () => {
    const memory = new FakeMemory([feature()]);
    const decomposer = new FakeDecomposer({ kind: "ok", plan: plan("demo") });
    const wg = new FakeDispatchClient();
    const d = deps(config("create_draft_tickets"), memory, decomposer, wg);

    const outcome = await runIdleFeatureBacklogLoop(d);

    expect(outcome.status).toBe("draft_created");
    if (outcome.status !== "draft_created") throw new Error("unreachable");
    expect(outcome.ticketCount).toBe(2);

    // Feature was claimed into building exactly once.
    expect(memory.advances).toEqual([{ id: "feat-1", toStatus: "building" }]);
    expect(memory.statusOf("feat-1")).toBe("building");

    // The decomposer got the feature's name+summary as the brief, and the repo.
    expect(decomposer.calls).toHaveLength(1);
    expect(decomposer.calls[0]!.repo).toBe("demo");
    expect(decomposer.calls[0]!.brief).toMatch(/Data export/);
    expect(decomposer.calls[0]!.brief).toMatch(/export their data/);

    // One epic was filed, its tickets are DRAFTS (not past the human gate).
    expect(wg.epics).toHaveLength(1);
    for (const ticketId of wg.epics[0]!.ticketIds) {
      expect(wg.getTicket(ticketId).ticket.status).toBe("draft");
    }
    expect(wg.listReady()).toHaveLength(0);
    expect(d.events.types()).toContain("feature_backlog_epic_filed");
  });

  it("files READY tickets in create_ready_tickets mode (explicit opt-in past the gate)", async () => {
    const memory = new FakeMemory([feature()]);
    const decomposer = new FakeDecomposer({ kind: "ok", plan: plan("demo") });
    const wg = new FakeDispatchClient();
    const d = deps(config("create_ready_tickets"), memory, decomposer, wg);

    const outcome = await runIdleFeatureBacklogLoop(d);

    expect(outcome.status).toBe("ready_created");
    expect(wg.listReady().length).toBe(2);
  });

  it("observe_only reports the candidate, files nothing and leaves status backlog", async () => {
    const memory = new FakeMemory([feature()]);
    const decomposer = new FakeDecomposer({ kind: "ok", plan: plan("demo") });
    const wg = new FakeDispatchClient();
    const d = deps(config("observe_only"), memory, decomposer, wg);

    const outcome = await runIdleFeatureBacklogLoop(d);

    expect(outcome.status).toBe("observed");
    expect(memory.advances).toHaveLength(0); // never advanced
    expect(memory.statusOf("feat-1")).toBe("backlog");
    expect(decomposer.calls).toHaveLength(0); // nothing decomposed
    expect(wg.epics).toHaveLength(0); // nothing filed
    expect(d.events.types()).toContain("feature_backlog_observed");
  });

  it("rolls the feature back to backlog when decompose fails", async () => {
    const memory = new FakeMemory([feature()]);
    const decomposer = new FakeDecomposer({
      kind: "fail",
      error: new CrewError("DECOMPOSE_FAILED", "model refused"),
    });
    const wg = new FakeDispatchClient();
    const d = deps(config("create_draft_tickets"), memory, decomposer, wg);

    const outcome = await runIdleFeatureBacklogLoop(d);

    expect(outcome.status).toBe("no_findings");
    // Advanced to building, then rolled back to backlog — not stranded.
    expect(memory.advances).toEqual([
      { id: "feat-1", toStatus: "building" },
      { id: "feat-1", toStatus: "backlog" },
    ]);
    expect(memory.statusOf("feat-1")).toBe("backlog");
    expect(wg.epics).toHaveLength(0); // nothing filed
    expect(d.events.types()).toContain("feature_backlog_rolled_back");
  });

  it("rolls back when create_epic fails after the claim", async () => {
    const memory = new FakeMemory([feature()]);
    const decomposer = new FakeDecomposer({ kind: "ok", plan: plan("demo") });
    const wg = new FakeDispatchClient();
    // Make createEpic throw to model a Dispatch failure post-claim.
    wg.createEpic = () => {
      throw new CrewError("DISPATCH_UNAVAILABLE", "db locked");
    };
    const d = deps(config("create_draft_tickets"), memory, decomposer, wg);

    const outcome = await runIdleFeatureBacklogLoop(d);

    expect(outcome.status).toBe("no_findings");
    expect(memory.statusOf("feat-1")).toBe("backlog");
  });

  it("no-ops when there are no backlog features", async () => {
    const memory = new FakeMemory([]);
    const decomposer = new FakeDecomposer({ kind: "ok", plan: plan("demo") });
    const d = deps(config("create_draft_tickets"), memory, decomposer);

    const outcome = await runIdleFeatureBacklogLoop(d);

    expect(outcome.status).toBe("no_findings");
    expect(memory.advances).toHaveLength(0);
    expect(decomposer.calls).toHaveLength(0);
  });

  it("skips when ready tickets exist (factory busy)", async () => {
    const memory = new FakeMemory([feature()]);
    const decomposer = new FakeDecomposer({ kind: "ok", plan: plan("demo") });
    const wg = new FakeDispatchClient();
    wg.seedTicket({ title: "ready work", status: "ready" });
    const d = deps(config("create_draft_tickets"), memory, decomposer, wg);

    const outcome = await runIdleFeatureBacklogLoop(d);

    expect(outcome.status).toBe("skipped_tickets_ready");
    expect(memory.advances).toHaveLength(0);
  });

  it("tolerates a dead per-repo lookup without crashing the tick", async () => {
    const memory = new FakeMemory([feature()]);
    memory.listThrowsFor.add("demo");
    const decomposer = new FakeDecomposer({ kind: "ok", plan: plan("demo") });
    const d = deps(config("create_draft_tickets"), memory, decomposer);

    const outcome = await runIdleFeatureBacklogLoop(d);

    expect(outcome.status).toBe("no_findings"); // no candidate, but no throw
    expect(d.events.types()).toContain("feature_backlog_list_failed");
  });
});

describe("runIdleFeatureBacklog registry entry", () => {
  it("returns null when the loop is disabled (default off)", async () => {
    const cfg = config("create_draft_tickets");
    cfg.loops.idle_feature_backlog.enabled = false;
    const d = deps(
      cfg,
      new FakeMemory([feature()]),
      new FakeDecomposer({ kind: "ok", plan: plan("demo") }),
    );
    expect(await runIdleFeatureBacklog(d)).toBeNull();
  });

  it("normalises a draft outcome to draftCount", async () => {
    const cfg = config("create_draft_tickets");
    const d = deps(
      cfg,
      new FakeMemory([feature()]),
      new FakeDecomposer({ kind: "ok", plan: plan("demo") }),
    );
    const result = await runIdleFeatureBacklog(d);
    expect(result?.id).toBe("feature_backlog");
    expect(result?.outcome).toEqual({ status: "draft_created", draftCount: 2 });
  });
});
