/**
 * End-to-end MVP demo (docs/_suite/implementation/01-mvp-plan.md).
 *
 * Drives the REAL Crew loops against a REAL shared Dispatch instance to
 * prove the full path without hand-edited DB rows:
 *   register repo+agent → idle loop creates a draft → refine (AC + ready) →
 *   implementation loop claims → context packet → branch → evidence → review.
 *
 * Run from the repo root: `pnpm -C packages/crew exec tsx scripts/mvp-demo.ts`
 */
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

function step(n: number, msg: string): void {
  process.stdout.write(`\n[${n}] ${msg}\n`);
}
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  process.stdout.write(`    ✓ ${msg}\n`);
}

const tmp = mkdtempSync(join(tmpdir(), "gaffer-mvp-"));
const factoryDir = join(tmp, "factory");
const repoDir = join(tmp, "demo-repo");
const dbPath = join(tmp, "dispatch.sqlite");
mkdirSync(factoryDir, { recursive: true });
mkdirSync(repoDir, { recursive: true });
execSync("git init -q && git commit -q --allow-empty -m init", { cwd: repoDir });

try {
  step(1, "Initialise Crew config + patch in a repo with a coverage command");
  initFactory({ dir: factoryDir, factoryName: "demo-factory", force: true });
  const cfgPath = join(factoryDir, "crew.yaml");
  const cfg = parse(readFileSync(cfgPath, "utf8")) as Record<string, any>;
  cfg.dispatch.local.sqlite_path = dbPath;
  cfg.repos = [
    {
      id: "demo-repo",
      name: "demo-repo",
      path: repoDir,
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
  assert(loaded.config.factory.name === "demo-factory", "config loads + validates");

  step(2, "Open a real Dispatch; register the repo + an agent");
  const wg = Dispatch.open(dbPath);
  wg.registerRepository(
    { name: "demo-repo", local_path: repoDir, default_branch: "main", test_command: "echo tests" },
    { type: "human", id: "demo" },
  );
  const agent = wg.registerAgent(
    { display_name: "Demo coding agent", max_risk: "high", capabilities: [] },
    { type: "human", id: "demo" },
  );
  const dispatch = RealDispatchClient.fromFacade(wg);
  assert(typeof agent.id === "string", "agent registered");

  step(3, "Idle coverage loop runs (no ready tickets) and creates a DRAFT");
  const idleEvents = new EventLog(systemClock, { redact: true });
  const idle = runIdleCoverageLoop({
    config: loaded.config,
    repoRegistry,
    dispatch,
    runner: systemCommandRunner,
    events: idleEvents,
    clock: systemClock,
  });
  assert(idle.status === "draft_created", "idle loop created a draft (not code changes)");
  const draftId = idle.status === "draft_created" ? idle.drafts[0]!.ticketId : "";
  assert(wg.view(draftId).ticket.status === "draft", "ticket is in 'draft'");

  step(4, "Refine the draft: add an AC and mark it ready");
  wg.addAcceptanceCriterion(
    { ticket_id: draftId, text: "Coverage raised above the target" },
    { type: "human", id: "demo" },
  );
  wg.markReady(draftId, { type: "human", id: "demo" });
  assert(wg.view(draftId).ticket.status === "ready", "ticket is 'ready' and claimable");

  step(5, "Implementation loop: claim → packet → branch → evidence → submit review");
  const runEvents = new EventLog(systemClock, { redact: true });
  const outcome = runImplementationLoop(
    { agentId: agent.id, dryRun: true },
    {
      config: loaded.config,
      policy,
      repoRegistry,
      dispatch,
      memory: new NullMemoryClient(),
      git: new DryRunGitAdapter(),
      runtime: new MockAgentRuntime(),
      events: runEvents,
    },
  );
  assert(
    outcome.status === "submitted_for_review",
    `loop submitted for review (got '${outcome.status}')`,
  );
  if (outcome.status === "submitted_for_review") {
    assert(
      outcome.branch.startsWith(policy.git.require_branch_prefix),
      `branch '${outcome.branch}' has required prefix`,
    );
    assert(outcome.evidenceIds.length > 0, "AC evidence recorded");
    assert(outcome.packet.repositories.length > 0, "context packet includes the repo");
  }

  step(6, "Verify final state + full event history");
  const view = wg.view(draftId);
  assert(view.ticket.status === "in_review", "ticket reached 'in_review'");
  const eventTypes = view.events.map((e) => e.event_type);
  process.stdout.write(`    dispatch events: ${eventTypes.join(" → ")}\n`);
  process.stdout.write(`    crew run events: ${runEvents.types().join(" → ")}\n`);

  process.stdout.write("\n✅ MVP demo passed end-to-end.\n");
  wg.db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
