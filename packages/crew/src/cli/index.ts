#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Command } from "commander";
import { z } from "zod";

import { systemGitAdapter, DryRunGitAdapter } from "../adapters/gitAdapter.js";
import { systemCommandRunner } from "../adapters/commandRunner.js";
import { initFactory } from "../config/init.js";
import { EventLog } from "../events/eventLog.js";
import { defaultBuiltinHooks } from "../hooks/builtins.js";
import { HookRegistry } from "../hooks/hookRegistry.js";
import { NullMemoryClient } from "../memory/client.js";
import { resolveAsyncMemory, resolveUnderstandingSink } from "../memory/factory.js";
import { resolveDecomposer } from "../adapters/decomposerFactory.js";
import {
  prefetchLore,
  seededSyncClient,
  flushSuggestions,
  flushRepoUnderstanding,
  type RepoUnderstandingFlushResult,
} from "../memory/prefetch.js";
import { ingestGithubIssues } from "../ingest/githubIssues.js";
import { ingestJiraIssues } from "../ingest/jiraIssues.js";
import {
  runIdleLoops,
  runIdleLoreGap,
  runIdleFeatureBacklog,
  runMaintenanceLane,
} from "../loops/idleRegistry.js";
import { runImplementationLoop } from "../loops/implementationLoop.js";
import { MockAgentRuntime } from "../runtime/agentRuntime.js";
import { loadSkillRegistry } from "../skills/loader.js";
import { buildStats, renderDoctor, renderStats, runDoctor } from "../ops/index.js";
import { loadFactory, openDispatch } from "../runtime/wiring.js";
import { checkBranchPolicy } from "../safety/branchPolicy.js";
import { classifyCommand } from "../safety/commandGuard.js";
import { checkFileWrite } from "../safety/fsGuard.js";
import { scanRepo } from "../scan/repoScan.js";
import { RepoContextStore } from "../onboarding/contextStore.js";
import {
  onboardRepo,
  rescanRepo,
  availableScopeNodes,
  type OnboardMappingChoice,
} from "../onboarding/onboard.js";
import {
  // NOTE: `authorOnboardingQuestions` / `requestOnboardingClarifications` are
  // deliberately NOT imported here any more — onboarding no longer auto-emits the
  // generic clarifying-question decision batch (the "floods the review queue"
  // anti-pattern). The grounded model-backed analysis replaces it. The functions
  // remain in clarify.ts for the human-authored `clarify-capture` flow.
  buildClarificationSuggestions,
  onboardClarifications,
  type AnsweredClarification,
  type RaisedClarification,
} from "../onboarding/clarify.js";
import { systemClock } from "../util/clock.js";
import { CrewError } from "../util/errors.js";

/** Stable factory id slug derived from the factory name (for the context-store path). */
function factoryIdFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "default";
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Backwards-compatible alias for the shared loader used across CLI commands. */
const loadEverything = loadFactory;

const program = new Command();
program
  .name("crew")
  .description("Local-first software factory runtime")
  .option("-c, --config <path>", "path to crew.yaml")
  .showHelpAfterError();

program
  .command("init")
  .description("Scaffold crew.yaml and safety_policy.yaml")
  .option("-d, --dir <path>", "factory directory", ".")
  .option("-n, --name <name>", "factory name")
  .option("--force", "overwrite existing files", false)
  .action((opts) => {
    const result = initFactory({
      dir: opts.dir,
      ...(opts.name ? { factoryName: opts.name } : {}),
      force: opts.force,
    });
    printJson({ ok: true, ...result });
  });

program
  .command("scan")
  .description("Scan configured repos (branch + stack) and report")
  .action((_opts, cmd) => {
    const { loaded, repoRegistry } = loadEverything(cmd.optsWithGlobals());
    const repos = repoRegistry.list().map((repo) => {
      const abs = repoRegistry.absolutePath(repo);
      return {
        id: repo.id,
        name: repo.name,
        configured: { stack: repo.stack },
        scan: scanRepo(abs, systemGitAdapter),
      };
    });
    printJson({ ok: true, factory: loaded.config.factory.name, repos });
  });

const repo = program
  .command("repo")
  .description("Repo onboarding into the Factory Map (FG-003/FG-004)");

repo
  .command("onboard <path>")
  .description("Scan a repo and onboard it (unmapped, standalone, or attached to scope nodes)")
  .option("--id <id>", "repo id (defaults to the directory name)")
  .option("--name <name>", "display name (defaults to the directory name)")
  .option("--standalone", "treat as a standalone single-repo scope", false)
  .option("--scope <id...>", "attach to one or more Dispatch scope node ids (implies mapped)")
  .option("--tag <tag...>", "extra lore tags to record on the repo context")
  .option("--relation <relation>", "scope attachment relation (mapped mode)")
  .option("--access <access>", "default access for scope attachments (mapped mode)")
  .option("--list-scopes", "list attachable scope nodes and exit", false)
  .action(async (path, opts, cmd) => {
    const ctx = loadEverything(cmd.optsWithGlobals());
    const dispatch = await openDispatch(ctx);

    if (opts.listScopes) {
      printJson({ ok: true, scopeNodes: availableScopeNodes(dispatch) });
      return;
    }

    // Mapping choice: --scope wins (mapped), then --standalone, else unmapped.
    const mapping: OnboardMappingChoice =
      opts.scope && opts.scope.length > 0
        ? { mode: "mapped", scopeNodeIds: opts.scope }
        : opts.standalone
          ? { mode: "standalone" }
          : { mode: "unmapped" };

    const store = new RepoContextStore({
      factoryId: factoryIdFromName(ctx.loaded.config.factory.name),
    });
    const result = onboardRepo(
      path,
      {
        ...(opts.id ? { repoId: opts.id } : {}),
        ...(opts.name ? { name: opts.name } : {}),
        mapping,
        ...(opts.tag ? { tags: opts.tag } : {}),
        ...(opts.relation ? { relation: opts.relation } : {}),
        ...(opts.access ? { defaultAccess: opts.access } : {}),
      },
      { store, dispatch, git: systemGitAdapter },
    );

    // Onboarding captures product intent again — RE-ENABLED, BATCHED (Track 1c).
    // `onboardClarifications` no longer raises one `human_required` decision PER
    // question (the "floods the review queue" anti-pattern); instead it raises a
    // SINGLE bundled decision listing every authored question, so the review queue
    // gains ONE item, not one-per-question, while the product's "why"/non-goals/key
    // decisions are still asked and captured. Answers land as DRAFT lore (human-gated)
    // alongside the grounded model-backed analysis (runner/lib/onboard-analyze.mjs).
    const clarifications: RaisedClarification[] = onboardClarifications(
      result.scan,
      { repoId: result.repoId, name: result.name },
      { dispatch },
    );

    // Persist the Repo Digest + feature inventory derived from the SAME scan.
    // Best effort: a missing/dead Memory must not fail onboarding. The digest
    // upserts by repo; features de-dupe by repo+name, so a re-onboard is safe.
    let understandingFlush: RepoUnderstandingFlushResult | undefined;
    const events = new EventLog(systemClock, {
      filePath: ctx.loaded.config.logging.event_log_path,
      redact: ctx.loaded.config.logging.redact,
    });
    // The digest+feature WRITE flush prefers the memory CLI bridge (env-driven,
    // no MCP server) so it lands in the SAME store the Memory views read.
    const understandingSink = await resolveUnderstandingSink(ctx.loaded.config, events);
    if (understandingSink) {
      try {
        understandingFlush = await flushRepoUnderstanding(
          understandingSink,
          result.understanding,
          events,
        );
      } finally {
        await understandingSink.close();
      }
    }

    printJson({
      ok: true,
      onboarded: result,
      // The raised onboarding clarifications (Track 1c): every authored question,
      // each pointing at the ONE bundled human-required decision. Empty only when the
      // scan authors no questions.
      clarifications,
      ...(understandingFlush ? { understanding: understandingFlush } : {}),
    });
  });

repo
  .command("rescan <id>")
  .description("Rescan an onboarded repo, refresh its context, and surface lore suggestions")
  .requiredOption("--path <path>", "the repo's local path")
  .option("--tag <tag...>", "lore tags to record (replaces existing tags)")
  .action(async (id, opts, cmd) => {
    const ctx = loadEverything(cmd.optsWithGlobals());
    const dispatch = await openDispatch(ctx);
    const store = new RepoContextStore({
      factoryId: factoryIdFromName(ctx.loaded.config.factory.name),
    });

    // Pre-fetch nothing; rescan SUGGESTS lore on change but never auto-promotes.
    // Flush is wired only when a real Memory is configured.
    const result = rescanRepo(opts.path, {
      store,
      dispatch,
      git: systemGitAdapter,
      repoId: id,
      ...(opts.tag ? { tags: opts.tag } : {}),
    });

    let flushedSuggestions = 0;
    if (result.loreSuggestions.length > 0) {
      const events = new EventLog(systemClock, {
        filePath: ctx.loaded.config.logging.event_log_path,
        redact: ctx.loaded.config.logging.redact,
      });
      const asyncLore = await resolveAsyncMemory(ctx.loaded.config, events);
      if (asyncLore) {
        const flush = await flushSuggestions(asyncLore, result.loreSuggestions, events);
        flushedSuggestions = flush.flushed.length;
        await asyncLore.close();
      }
    }

    printJson({
      ok: true,
      changed: result.changed,
      context: result.context,
      loreSuggestions: result.loreSuggestions,
      flushedSuggestions,
    });
  });

const answeredClarificationSchema = z.array(
  z.object({
    topic: z.string().min(1),
    question: z.string().min(1),
    answer: z.string(),
  }),
);

repo
  .command("clarify-capture <id>")
  .description(
    "Draft answered onboarding clarifying questions into Memory for ratification (Ticket #9)",
  )
  .requiredOption("--answers <file>", "JSON file: array of { topic, question, answer }")
  .action(async (id, opts, cmd) => {
    const ctx = loadEverything(cmd.optsWithGlobals());
    // Validate the external answers file at the boundary before drafting lore.
    const answers: AnsweredClarification[] = answeredClarificationSchema.parse(
      JSON.parse(readFileSync(opts.answers, "utf8")),
    );
    const suggestions = buildClarificationSuggestions(id, answers);

    let flushed = 0;
    if (suggestions.length > 0) {
      const events = new EventLog(systemClock, {
        filePath: ctx.loaded.config.logging.event_log_path,
        redact: ctx.loaded.config.logging.redact,
      });
      const asyncLore = await resolveAsyncMemory(ctx.loaded.config, events);
      if (asyncLore) {
        const result = await flushSuggestions(asyncLore, suggestions, events);
        flushed = result.flushed.length;
        await asyncLore.close();
      }
    }

    printJson({ ok: true, suggestions, flushed });
  });

// SEAL (Track 1c): this `run` command wires `MockAgentRuntime` — see the
// `runtime:` field below. It does NOT invoke a real agent and writes NO files;
// it exercises the loop's orchestration/bookkeeping (claim → packet → branch →
// evidence → submit) against a scripted runtime. The LIVE production delivery
// path is the bash runner (`runner/tick.sh` → `claude -p`). Any NEW production
// delivery feature (context assembly, close-path harvesting, what the agent
// actually receives) MUST also land in `runner/tick.sh` / `runner/lib` until a
// real `ClaudeAgentRuntime` is wired here — a feature added only to this loop
// silently misses the live agent. See runner/CLAUDE.md.
program
  .command("run")
  .description("Run one implementation-loop tick (MOCK runtime — not the live agent)")
  .requiredOption("-a, --agent <id>", "agent id")
  .option("--dry-run", "do not perform real git mutations", false)
  .action(async (opts, cmd) => {
    const ctx = loadEverything(cmd.optsWithGlobals());
    const { loaded, policy, repoRegistry } = ctx;
    const events = new EventLog(systemClock, {
      filePath: loaded.config.logging.event_log_path,
      redact: loaded.config.logging.redact,
    });
    const dispatch = await openDispatch(ctx);
    let hooks: HookRegistry | undefined;
    if (loaded.config.hooks.enabled) {
      hooks = new HookRegistry(events);
      for (const hook of defaultBuiltinHooks(loaded.config)) hooks.register(hook);
    }

    // Pre-fetch lore (async) and seed a SYNC client for the unchanged sync loop.
    // When no real Memory is configured, this resolves to the Null client.
    const asyncLore = await resolveAsyncMemory(loaded.config, events);
    const repoTags = [...new Set(repoRegistry.list().flatMap((r) => r.lore_tags))];
    const seeded = asyncLore
      ? seededSyncClient(await prefetchLore(asyncLore, { tags: repoTags }, events))
      : null;

    const outcome = runImplementationLoop(
      { agentId: opts.agent, dryRun: opts.dryRun },
      {
        config: loaded.config,
        policy,
        repoRegistry,
        dispatch,
        memory: seeded ?? new NullMemoryClient(),
        git: opts.dryRun ? new DryRunGitAdapter() : systemGitAdapter,
        runtime: new MockAgentRuntime(),
        events,
        skillRegistry: loadSkillRegistry({ factoryDir: loaded.rootDir }),
        ...(hooks ? { hooks } : {}),
      },
    );

    // Flush any suggestions the sync loop collected back to Memory (async).
    if (asyncLore && seeded) {
      await flushSuggestions(asyncLore, seeded.suggestions, events);
      await asyncLore.close();
    }
    printJson({ ok: true, outcome, events: events.types() });
  });

program
  .command("ingest")
  .description("Ingest labelled GitHub/Jira issues into Dispatch as draft tickets")
  .action(async (_opts, cmd) => {
    const ctx = loadEverything(cmd.optsWithGlobals());
    const { loaded, repoRegistry } = ctx;
    const events = new EventLog(systemClock, {
      filePath: loaded.config.logging.event_log_path,
      redact: loaded.config.logging.redact,
    });
    const dispatch = await openDispatch(ctx);
    const deps = {
      config: loaded.config,
      repoRegistry,
      dispatch,
      runner: systemCommandRunner,
      events,
    };
    const summary = ingestGithubIssues(deps);
    const jira = loaded.config.ingest.jira.enabled ? ingestJiraIssues(deps) : null;
    printJson({ ok: true, summary, ...(jira ? { jira } : {}), events: events.types() });
  });

program
  .command("idle")
  .description("Run all configured idle loops (creates draft tickets only)")
  .action(async (_opts, cmd) => {
    const ctx = loadEverything(cmd.optsWithGlobals());
    const { loaded, repoRegistry } = ctx;
    const events = new EventLog(systemClock, {
      filePath: loaded.config.logging.event_log_path,
      redact: loaded.config.logging.redact,
    });
    const dispatch = await openDispatch(ctx);
    const baseDeps = {
      config: loaded.config,
      repoRegistry,
      dispatch,
      runner: systemCommandRunner,
      events,
      clock: systemClock,
    };

    // Pull real labelled GitHub/Jira issues BEFORE the scan loops, so an idle
    // tick first ingests teammate-filed work, then scans. Guarded by config.
    const ingestDeps = {
      config: loaded.config,
      repoRegistry,
      dispatch,
      runner: systemCommandRunner,
      events,
    };
    const ingest = loaded.config.ingest.github.enabled ? ingestGithubIssues(ingestDeps) : null;
    const jira = loaded.config.ingest.jira.enabled ? ingestJiraIssues(ingestDeps) : null;

    const report = runIdleLoops(baseDeps);

    // Async lore-gap loop (behind loops.idle_lore_gap.enabled + real Memory).
    const loreGap: { id: "lore_gap"; outcome: unknown } | null = await (async () => {
      const asyncLore = await resolveAsyncMemory(loaded.config, events);
      if (!asyncLore) return null;
      try {
        return await runIdleLoreGap({ ...baseDeps, memory: asyncLore });
      } finally {
        await asyncLore.close();
      }
    })();

    // Async feature-backlog loop (behind loops.idle_feature_backlog.enabled +
    // real Memory + a configured brownfield decomposer).
    const featureBacklog: { id: "feature_backlog"; outcome: unknown } | null = await (async () => {
      const decomposer = resolveDecomposer(loaded.config);
      if (!decomposer) return null;
      const asyncLore = await resolveAsyncMemory(loaded.config, events);
      if (!asyncLore) return null;
      try {
        return await runIdleFeatureBacklog({ ...baseDeps, memory: asyncLore, decomposer });
      } finally {
        await asyncLore.close();
      }
    })();

    printJson({
      ok: true,
      ...(ingest ? { ingest } : {}),
      ...(jira ? { jira } : {}),
      report,
      ...(loreGap ? { loreGap } : {}),
      ...(featureBacklog ? { featureBacklog } : {}),
      events: events.types(),
    });
  });

program
  .command("maintain")
  .description(
    "Run the idle MAINTENANCE LANE: one scheduler-chosen maintenance loop (priority + rotation)",
  )
  .action(async (_opts, cmd) => {
    const ctx = loadEverything(cmd.optsWithGlobals());
    const { loaded, repoRegistry } = ctx;
    const events = new EventLog(systemClock, {
      filePath: loaded.config.logging.event_log_path,
      redact: loaded.config.logging.redact,
    });
    const dispatch = await openDispatch(ctx);
    const baseDeps = {
      config: loaded.config,
      repoRegistry,
      dispatch,
      runner: systemCommandRunner,
      events,
      clock: systemClock,
    };

    // Cursor path precedence: explicit config override → $GAFFER_DATA →
    // factory root. Persisting the cursor keeps the rotation cadence across ticks.
    const dataDir =
      process.env.GAFFER_DATA && process.env.GAFFER_DATA.length > 0
        ? process.env.GAFFER_DATA
        : loaded.rootDir;
    const cursorPath =
      loaded.config.loops.maintenance.cursor_path ?? join(dataDir, "maintenance-cursor.json");

    const report = runMaintenanceLane(baseDeps, cursorPath);
    printJson({ ok: true, report, events: events.types() });
  });

program
  .command("skills")
  .description("List skills available to the factory (built-ins + skills/ dir)")
  .option("--stack <stack>", "filter by stack")
  .option("--capability <capability>", "filter by capability")
  .action((opts, cmd) => {
    const { loaded } = loadEverything(cmd.optsWithGlobals());
    const registry = loadSkillRegistry({ factoryDir: loaded.rootDir });
    const skills =
      opts.stack || opts.capability
        ? registry.select({
            ...(opts.stack ? { stacks: [opts.stack] } : {}),
            ...(opts.capability ? { capabilities: [opts.capability] } : {}),
          })
        : registry.list();
    printJson({ ok: true, count: skills.length, skills });
  });

program
  .command("doctor")
  .description("Pre-flight: config valid, repos resolve, Dispatch/Memory reachable, skills, safety")
  .option("--json", "emit the structured report instead of the rendered checks", false)
  .action(async (opts, cmd) => {
    const ctx = loadEverything(cmd.optsWithGlobals());
    const report = await runDoctor({ ctx, openDispatch });
    if (opts.json) printJson({ ok: report.ok, checks: report.checks });
    else process.stdout.write(`${renderDoctor(report)}\n`);
    if (!report.ok) process.exitCode = 1;
  });

program
  .command("stats")
  .description("Snapshot: repos, skills by capability, idle-loop config, recent run outcomes")
  .option("--json", "emit the structured snapshot instead of the rendered report", false)
  .action((opts, cmd) => {
    const ctx = loadEverything(cmd.optsWithGlobals());
    const stats = buildStats(ctx);
    if (opts.json) printJson({ ok: true, stats });
    else process.stdout.write(`${renderStats(stats)}\n`);
  });

const safety = program.command("safety").description("Safety policy tools");
safety
  .command("check")
  .description("Explain a command or path safety decision")
  .option("--command <cmd>", "classify a shell command")
  .option("--path <path>", "classify a filesystem write")
  .option("--branch <branch>", "classify a branch name")
  .option("--repo <ref>", "repo context for a path/branch check")
  .action((opts, cmd) => {
    const { policy, repoRegistry } = loadEverything(cmd.optsWithGlobals());
    const out: Record<string, unknown> = { ok: true };
    if (opts.command) {
      out.command = classifyCommand(opts.command, { commands: policy.commands, git: policy.git });
    }
    if (opts.branch) {
      out.branch = checkBranchPolicy(opts.branch, policy.git);
    }
    if (opts.path) {
      const repo = opts.repo ? repoRegistry.get(opts.repo) : repoRegistry.list()[0];
      const repoRoot = repo ? repoRegistry.absolutePath(repo) : process.cwd();
      out.path = checkFileWrite(opts.path, { repoRoot, policy: policy.filesystem });
    }
    if (!opts.command && !opts.path && !opts.branch) {
      throw new CrewError("BAD_USAGE", "Provide --command, --path or --branch.");
    }
    printJson(out);
  });

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof CrewError) {
      process.stderr.write(
        `${JSON.stringify({ ok: false, code: err.code, message: err.message, details: err.details })}\n`,
      );
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

void main();
