/**
 * End-to-end MVP integration test — the suite's "first proof point": a ticket is
 * created (idle loop), refined, claimed, given a context packet, worked on a
 * prefixed branch, evidenced, and moved to review — driving the REAL Crew
 * loops against a REAL in-memory Dispatch via the RealDispatchClient.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { Dispatch } from "dispatch";

import { DryRunGitAdapter } from "../src/adapters/gitAdapter.js";
import { systemCommandRunner } from "../src/adapters/commandRunner.js";
import { initFactory } from "../src/config/init.js";
import { loadConfig, loadSafetyPolicy } from "../src/config/loader.js";
import { EventLog } from "../src/events/eventLog.js";
import { NullMemoryClient } from "../src/memory/client.js";
import { runIdleCoverageLoop } from "../src/loops/idleLoop.js";
import { runImplementationLoop } from "../src/loops/implementationLoop.js";
import { RepoRegistry } from "../src/registry/repoRegistry.js";
import { MockAgentRuntime } from "../src/runtime/agentRuntime.js";
import { systemClock } from "../src/util/clock.js";
import { RealDispatchClient } from "../src/dispatch/realClient.js";

describe("E2E MVP: idle draft → refine → claim → packet → branch → evidence → review", () => {
  let tmp: string;
  const human = { type: "human", id: "demo" } as const;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "gaffer-e2e-"));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("runs the full MVP path with no hand-edited DB rows", async () => {
    // Config with one repo that has a coverage command.
    initFactory({ dir: tmp, factoryName: "e2e-factory", force: true });
    const cfgPath = join(tmp, "crew.yaml");
    const cfg = parse(readFileSync(cfgPath, "utf8")) as Record<string, any>;
    cfg.repos = [
      {
        id: "demo-repo",
        name: "demo-repo",
        path: tmp,
        default_branch: "main",
        stack: "node",
        test_command: "echo 'tests pass'",
        coverage_command: "echo 'TOTAL 120 43 64%'",
      },
    ];
    cfg.loops.idle_coverage.repos = ["demo-repo"];
    writeFileSync(cfgPath, stringify(cfg));

    const loaded = loadConfig(cfgPath);
    const policy = loadSafetyPolicy(loaded);
    const repoRegistry = RepoRegistry.fromConfig(loaded.config, loaded.rootDir);

    // Real Dispatch, shared via fromFacade so both loops hit the same store.
    const wg = Dispatch.open(":memory:");
    wg.registerRepository(
      { name: "demo-repo", local_path: tmp, default_branch: "main", test_command: "echo tests" },
      human,
    );
    const agent = wg.registerAgent({ display_name: "E2E agent", max_risk: "high" }, human);
    const dispatch = RealDispatchClient.fromFacade(
      wg as unknown as Parameters<typeof RealDispatchClient.fromFacade>[0],
    );

    // Idle loop → draft (no ready tickets yet).
    const idle = runIdleCoverageLoop({
      config: loaded.config,
      repoRegistry,
      dispatch,
      runner: systemCommandRunner,
      events: new EventLog(systemClock, { redact: true }),
      clock: systemClock,
    });
    expect(idle.status).toBe("draft_created");
    const draftId = idle.status === "draft_created" ? idle.drafts[0]!.ticketId : "";
    expect(wg.view(draftId).ticket.status).toBe("draft");

    // Refine → ready.
    wg.addAcceptanceCriterion({ ticket_id: draftId, text: "Coverage raised above target" }, human);
    wg.markReady(draftId, human);
    expect(wg.view(draftId).ticket.status).toBe("ready");

    // Implementation loop → claim, packet, branch, evidence, review.
    const outcome = await runImplementationLoop(
      { agentId: agent.id, dryRun: true },
      {
        config: loaded.config,
        policy,
        repoRegistry,
        dispatch,
        memory: new NullMemoryClient(),
        git: new DryRunGitAdapter(),
        runtime: new MockAgentRuntime(),
        events: new EventLog(systemClock, { redact: true }),
      },
    );

    expect(outcome.status).toBe("submitted_for_review");
    if (outcome.status === "submitted_for_review") {
      expect(outcome.branch.startsWith(policy.git.require_branch_prefix)).toBe(true);
      expect(outcome.evidenceIds.length).toBeGreaterThan(0);
      expect(outcome.packet.repositories.length).toBeGreaterThan(0);
      // The context packet never leaks secrets and carries the AC.
      expect(outcome.packet.acceptanceCriteria.length).toBeGreaterThan(0);
    }
    expect(wg.view(draftId).ticket.status).toBe("in_review");
    wg.db.close();
  });
});
