import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { FakeCommandRunner } from "../src/adapters/commandRunner.js";
import {
  parseEpicPlan,
  SpawnDecomposer,
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
import {
  FEATURE_FAILURES_FILE,
  featureFailuresPath,
  FileFeatureFailureStore,
  MemoryFeatureFailureStore,
  type FeatureFailureStore,
} from "../src/loops/featureBacklogFailures.js";
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
    // Mirror memory's forward-only lifecycle: building → backlog is refused there
    // (an earlier fake accepted it, which hid the stranded-in-building bug).
    const from = this.statusOf(id);
    const legal =
      (from === "backlog" && (toStatus === "building" || toStatus === "shipped")) ||
      (from === "building" && toStatus === "shipped");
    if (!legal) throw new CrewError("MEMORY_UNAVAILABLE", `illegal ${from} -> ${toStatus}`);
    this.advances.push({ id, toStatus });
    return { id, status: toStatus };
  }
  readonly releases: string[] = [];
  async releaseFeature(id: string): Promise<AdvanceFeatureResult> {
    if (this.statusOf(id) !== "building") throw new CrewError("MEMORY_UNAVAILABLE", "not building");
    this.releases.push(id);
    this.advances.push({ id, toStatus: "backlog" });
    return { id, status: "backlog" };
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
  failures: FeatureFailureStore = new MemoryFeatureFailureStore(),
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
    failures,
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
    // Advanced to building, then RELEASED back to backlog (memory's release_feature,
    // not a backward advance_feature, which memory refuses) — not stranded.
    expect(memory.advances).toEqual([
      { id: "feat-1", toStatus: "building" },
      { id: "feat-1", toStatus: "backlog" },
    ]);
    expect(memory.releases).toEqual(["feat-1"]);
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

  it("files the epic with a single-line name + description (Dispatch scope nodes refuse newlines)", async () => {
    const memory = new FakeMemory([feature()]);
    const multiLine = plan("demo");
    multiLine.epic = { name: "Add\nexport", description: "Line one.\n\nLine two.\tTabbed." };
    const decomposer = new FakeDecomposer({ kind: "ok", plan: multiLine });
    const wg = new FakeDispatchClient();
    const seen: Array<{ name: string; description?: string }> = [];
    const original = wg.createEpic.bind(wg);
    wg.createEpic = (p) => {
      seen.push({
        name: p.name,
        ...(p.description !== undefined ? { description: p.description } : {}),
      });
      return original(p);
    };
    const d = deps(config("create_draft_tickets"), memory, decomposer, wg);

    const outcome = await runIdleFeatureBacklogLoop(d);

    expect(outcome.status).toBe("draft_created");
    // eslint-disable-next-line no-control-regex -- asserting no control bytes reach Dispatch.
    const control = /[\x00-\x1f]/;
    expect(seen[0]!.name).toBe("Add export");
    expect(control.test(seen[0]!.description ?? "")).toBe(false);
    expect(seen[0]!.description).toContain("Line one. Line two. Tabbed.");
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

describe("a feature whose plan keeps failing is not re-claimed every idle tick", () => {
  const failing = () =>
    new FakeDecomposer({
      kind: "fail",
      error: new CrewError("DECOMPOSE_FAILED", "Decompose returned phase 'clarify', not a plan."),
    });

  it("stops claiming the feature after max_plan_failures failed plans (default 2)", async () => {
    const memory = new FakeMemory([feature()]);
    const decomposer = failing();
    const wg = new FakeDispatchClient();
    const store = new MemoryFeatureFailureStore();
    const cfg = config("create_draft_tickets");
    expect(cfg.loops.idle_feature_backlog.max_plan_failures).toBe(2);

    const runs: string[] = [];
    let last: IdleFeatureBacklogDeps | undefined;
    for (let i = 0; i < 4; i += 1) {
      last = deps(cfg, memory, decomposer, wg, store);
      runs.push((await runIdleFeatureBacklogLoop(last)).status);
    }

    expect(runs).toEqual(["no_findings", "no_findings", "no_findings", "no_findings"]);
    // Two paid planner calls, then none: the feature is parked, not re-claimed.
    expect(decomposer.calls).toHaveLength(2);
    expect(memory.releases).toEqual(["feat-1", "feat-1"]);
    expect(memory.statusOf("feat-1")).toBe("backlog"); // waits for a human, never stranded
    expect(last!.events.types()).toContain("feature_backlog_skipped_failing");
    expect(last!.events.types()).not.toContain("feature_backlog_claimed");
  });

  it("says when a feature is parked, and still plans the next backlog feature", async () => {
    const memory = new FakeMemory([
      feature({ id: "doomed", priority: 1 }),
      feature({ id: "fine", name: "Fine", priority: 2 }),
    ]);
    const store = new MemoryFeatureFailureStore();
    const cfg = config("create_draft_tickets");
    cfg.loops.idle_feature_backlog.max_plan_failures = 1;
    const wg = new FakeDispatchClient();

    const first = deps(cfg, memory, failing(), wg, store);
    await runIdleFeatureBacklogLoop(first);
    expect(first.events.types()).toContain("feature_backlog_parked");

    const ok = new FakeDecomposer({ kind: "ok", plan: plan("demo") });
    const second = deps(cfg, memory, ok, wg, store);
    const outcome = await runIdleFeatureBacklogLoop(second);
    expect(outcome.status).toBe("draft_created");
    expect(outcome.status === "draft_created" && outcome.feature.id).toBe("fine");
    expect(memory.statusOf("doomed")).toBe("backlog");
  });

  it("a filed epic clears the feature's earlier failures", async () => {
    const memory = new FakeMemory([feature()]);
    const store = new MemoryFeatureFailureStore();
    const cfg = config("create_draft_tickets");
    await runIdleFeatureBacklogLoop(deps(cfg, memory, failing(), new FakeDispatchClient(), store));
    expect(store.failures("feat-1")).toBe(1);
    const ok = new FakeDecomposer({ kind: "ok", plan: plan("demo") });
    await runIdleFeatureBacklogLoop(deps(cfg, memory, ok, new FakeDispatchClient(), store));
    expect(store.failures("feat-1")).toBe(0);
  });

  it("the file ledger persists across processes and reads a corrupt file as empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "fb-failures-"));
    try {
      const path = join(dir, FEATURE_FAILURES_FILE);
      const a = new FileFeatureFailureStore(path);
      expect(a.recordFailure("feat-1", "boom", "2026-10-30T00:00:00.000Z")).toBe(1);
      const b = new FileFeatureFailureStore(path); // a later tick
      expect(b.failures("feat-1")).toBe(1);
      expect(b.recordFailure("feat-1", "boom again", "2026-10-30T01:00:00.000Z")).toBe(2);
      expect(JSON.parse(readFileSync(path, "utf8")).features["feat-1"]).toMatchObject({
        failures: 2,
        lastError: "boom again",
      });
      b.clear("feat-1");
      expect(a.failures("feat-1")).toBe(0);
      writeFileSync(path, "{not json");
      expect(a.failures("feat-1")).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lives under $GAFFER_DATA (what the runner sets on an idle tick)", () => {
    const cfg = config();
    expect(featureFailuresPath(cfg, { GAFFER_DATA: "/data" })).toBe(
      join("/data", FEATURE_FAILURES_FILE),
    );
    cfg.logging.event_log_path = "/factory/.crew/events.jsonl";
    expect(featureFailuresPath(cfg, {})).toBe(join("/factory/.crew", FEATURE_FAILURES_FILE));
    cfg.logging.event_log_path = "./.crew/events.jsonl";
    expect(featureFailuresPath(cfg, {})).toBeNull();
  });
});

describe("the real runner planner (bin/decompose.mjs) files an epic on an idle tick", () => {
  // A stub `claude` that OBEYS its prompt the way the real planner does: a first turn
  // told "THIS IS THE FIRST TURN: return a CLARIFY result" clarifies; otherwise it
  // plans. Before SpawnDecomposer passed --force-plan, every unattended idle tick got
  // the clarify, the plan was rejected, the feature released, and the next tick paid
  // for the same call again.
  const RUNNER = resolve(dirname(fileURLToPath(import.meta.url)), "../../../runner");
  const SCRIPT = join(RUNNER, "bin", "decompose.mjs");

  function obeyingStub(dir: string): { bin: string; log: string } {
    const log = join(dir, "stub.log");
    const bin = join(dir, "claude");
    const clarify =
      '```json\n{"phase":"clarify","questions":["Which screens?","What format?"]}\n```';
    const planOut =
      '```json\n{"phase":"plan","plan":{"epic":{"name":"CSV export","description":"stub"},' +
      '"tickets":[{"title":"Add CSV export","description":"d","acceptanceCriteria":["header row"],' +
      '"priority":2,"dependsOn":[]}]}}\n```';
    // The canned replies live in files: inlined, bash would expand their backticks.
    writeFileSync(join(dir, "clarify.txt"), clarify);
    writeFileSync(join(dir, "plan.txt"), planOut);
    writeFileSync(
      bin,
      [
        "#!/usr/bin/env bash",
        '[ "${1:-}" = "--version" ] && { echo "0.0.0 stub"; exit 0; }',
        'p="$2"',
        'if printf "%s" "$p" | grep -q "THIS IS THE FIRST TURN: return a CLARIFY"; then',
        `  echo clarify >> ${JSON.stringify(log)}; out="$(cat ${JSON.stringify(join(dir, "clarify.txt"))})"`,
        "else",
        `  echo plan >> ${JSON.stringify(log)}; out="$(cat ${JSON.stringify(join(dir, "plan.txt"))})"`,
        "fi",
        `${JSON.stringify(process.execPath)} -e 'process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:false,result:process.argv[1],total_cost_usd:0.001,num_turns:1})+"\\n")' "$out"`,
        "",
      ].join("\n"),
    );
    chmodSync(bin, 0o755);
    return { bin, log };
  }

  it("plans on the first unattended turn (never clarifies) and the epic is filed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fb-real-planner-"));
    try {
      const stub = obeyingStub(dir);
      // A paid launch needs a dollar cap (runner/lib/budget-admission.mjs); the stub costs nothing.
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CLAUDE_BIN: stub.bin,
        GAFFER_DATA: dir,
        GAFFER_ALLOW_UNCAPPED: "1",
      };
      for (const k of [
        "CLAUDE_FLAGS",
        "MCP_CONFIG",
        "GAFFER_DECOMPOSE_FORCE_PLAN",
        "GAFFER_PLAN_DEBATE",
        "DISPATCH_DB",
        "MEMORY_DB",
      ])
        delete env[k];
      const decomposer = new SpawnDecomposer({
        scriptPath: SCRIPT,
        cwd: RUNNER,
        timeoutMs: 60_000,
        env,
      });
      const memory = new FakeMemory([
        feature({ name: "CSV export", summary: "Export tasks as CSV" }),
      ]);
      const wg = new FakeDispatchClient();
      const d = deps(config("create_draft_tickets"), memory, decomposer, wg);

      const outcome = await runIdleFeatureBacklogLoop(d);

      expect(readFileSync(stub.log, "utf8").trim().split("\n")).toEqual(["plan"]);
      expect(outcome.status).toBe("draft_created");
      expect(wg.epics).toHaveLength(1);
      expect(wg.epics[0]!.name).toBe("CSV export");
      expect(wg.epics[0]!.ticketIds).toHaveLength(1);
      expect(memory.statusOf("feat-1")).toBe("building");
      expect(d.events.types()).not.toContain("feature_backlog_failed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
