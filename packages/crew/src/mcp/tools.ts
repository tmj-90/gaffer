import { z } from "zod";

import { audit, summariseArgs, type AuditOptions } from "../audit/index.js";
import { buildContextPacket } from "../context/packet.js";
import { EventLog } from "../events/eventLog.js";
import { NullMemoryClient } from "../memory/client.js";
import { resolveAsyncMemory } from "../memory/factory.js";
import { resolveDecomposer } from "../adapters/decomposerFactory.js";
import { prefetchLore, seededSyncClient } from "../memory/prefetch.js";
import { runIdleLoops, runIdleLoreGap, runIdleFeatureBacklog } from "../loops/idleRegistry.js";
import { systemCommandRunner } from "../adapters/commandRunner.js";
import type { FactoryContext } from "../runtime/wiring.js";
import { classifyCommand } from "../safety/commandGuard.js";
import { checkFileWrite } from "../safety/fsGuard.js";
import { scanRepo } from "../scan/repoScan.js";
import { loadSkillRegistry } from "../skills/loader.js";
import { systemGitAdapter } from "../adapters/gitAdapter.js";
import { systemClock } from "../util/clock.js";
import { CrewError } from "../util/errors.js";
import type { DispatchClient } from "../dispatch/client.js";

/**
 * Structured tool result mirroring the MCP `CallToolResult` shape. The SDK
 * serialises `structuredContent` for clients and renders `content` as the
 * human-readable fallback. `isError` flags a tool-level (not protocol) failure.
 */
export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

function ok(data: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function toolError(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): ToolResult {
  const data = { error: { code, message, ...details } };
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
    isError: true,
  };
}

/**
 * Run an async tool body, mapping CrewError and Zod validation failures
 * onto structured `{ error: { code, message } }` results with `isError: true`.
 * Any other throw is a programming error and propagates to the SDK.
 */
async function guard(fn: () => Promise<Record<string, unknown>>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    if (err instanceof CrewError) {
      return toolError(err.code, err.message, { details: err.details });
    }
    if (err instanceof z.ZodError) {
      return toolError("VALIDATION_ERROR", "Invalid tool arguments.", { issues: err.issues });
    }
    throw err;
  }
}

// --- Argument schemas -----------------------------------------------------

export const toolSchemas = {
  get_factory_status: {},
  list_agents: {},
  list_repos: {
    scan: z.boolean().optional(),
  },
  get_context_packet: {
    ticketRef: z.string().min(1),
  },
  run_idle_loop: {},
  explain_safety_policy: {},
  check_command_allowed: {
    command: z.string().min(1),
  },
  check_path_write_allowed: {
    path: z.string().min(1),
    repo: z.string().optional(),
  },
} satisfies Record<string, z.ZodRawShape>;

export type ToolName = keyof typeof toolSchemas;

/** Parse args for a tool against its schema, throwing a ZodError on failure. */
function parseArgs<N extends ToolName>(
  name: N,
  args: Record<string, unknown>,
): z.infer<z.ZodObject<(typeof toolSchemas)[N]>> {
  return z.object(toolSchemas[name]).parse(args ?? {}) as z.infer<
    z.ZodObject<(typeof toolSchemas)[N]>
  >;
}

/**
 * How a tool handler opens Dispatch. Injected so tests can pass a shared
 * in-memory facade; production wires the real `openDispatch`. A factory function
 * (rather than a single instance) so read-only tools never open a DB they do not
 * need, and `get_factory_status` can probe reachability and discard the handle.
 */
export type DispatchOpener = (ctx: FactoryContext) => Promise<DispatchClient>;

export interface HandlerDeps {
  ctx: FactoryContext;
  openDispatch: DispatchOpener;
  /**
   * Where the redacted MCP audit log is written. Optional: omit in tests to use
   * the default (`GAFFER_AUDIT` / `~/.crew/audit.jsonl`); pass `{ env }` with
   * `GAFFER_AUDIT_OFF=1` (or a temp path) to keep tests off the real log.
   */
  audit?: AuditOptions;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

/**
 * Per-tool audit projection: which raw-arg keys are safe identifiers (kept
 * verbatim) and how to derive the redacted count/ids from a SUCCESS payload.
 * Content is never read here — only ids, counts and flags.
 */
interface AuditSpec {
  /** Arg names whose string values are identifiers, not content. */
  readonly idKeys?: readonly string[];
  /** Extract `{ resultCount, resultIds }` from the structured success data. */
  readonly extract?: (data: Record<string, unknown>) => {
    resultCount?: number | undefined;
    resultIds?: string[] | undefined;
  };
}

function idsOf<T>(rows: readonly T[] | undefined, pick: (row: T) => unknown): string[] {
  return (rows ?? []).map(pick).filter((v): v is string => typeof v === "string" && v.length > 0);
}

const AUDIT_SPECS: Record<ToolName, AuditSpec> = {
  get_factory_status: {},
  list_agents: {
    extract: (d) => {
      const agents = d.agents as Array<{ id?: string }> | undefined;
      return { resultCount: agents?.length, resultIds: idsOf(agents, (a) => a.id) };
    },
  },
  list_repos: {
    extract: (d) => {
      const repos = d.repos as Array<{ id?: string }> | undefined;
      return { resultCount: repos?.length, resultIds: idsOf(repos, (r) => r.id) };
    },
  },
  get_context_packet: {
    idKeys: ["ticketRef"],
    extract: (d) => {
      const packet = d.packet as { ticket?: { id?: string } } | undefined;
      const id = packet?.ticket?.id;
      return { resultCount: 1, resultIds: typeof id === "string" ? [id] : [] };
    },
  },
  run_idle_loop: {
    extract: (d) => {
      const outcome = d.outcome as { drafts?: Array<{ ticketId?: string }> } | undefined;
      const drafts = outcome?.drafts;
      return { resultCount: drafts?.length ?? 0, resultIds: idsOf(drafts, (t) => t.ticketId) };
    },
  },
  explain_safety_policy: {},
  // command/path arguments are free-text — summariseArgs reduces them to a length;
  // we keep the decision status (allowed/denied) only via the redacted args/error path.
  check_command_allowed: {},
  check_path_write_allowed: { idKeys: ["repo"] },
};

/**
 * Wrap a tool handler so every call is recorded to the redacted audit log:
 * tool name + summarised args + result count/ids on success, or the error code
 * on failure. Content (prompts, file bodies, lore text, secrets) never enters
 * the log — only `summariseArgs` output and the spec-derived ids/counts. Audit
 * writes are best-effort and never alter the tool result.
 */
function withAudit(
  name: ToolName,
  spec: AuditSpec,
  auditOpts: AuditOptions | undefined,
  handler: ToolHandler,
): ToolHandler {
  return async (rawArgs) => {
    const result = await handler(rawArgs);
    const args = summariseArgs(rawArgs ?? {}, spec.idKeys);
    if (result.isError) {
      const error = (result.structuredContent.error as { code?: string } | undefined)?.code;
      audit({ tool: name, args, error: error ?? "ERROR" }, auditOpts);
      return result;
    }
    const { resultCount, resultIds } = spec.extract?.(result.structuredContent) ?? {};
    audit(
      {
        tool: name,
        args,
        ...(resultCount !== undefined ? { resultCount } : {}),
        ...(resultIds && resultIds.length > 0 ? { resultIds } : {}),
      },
      auditOpts,
    );
    return result;
  };
}

/**
 * Build the handler map. Read-only tools never mutate; `run_idle_loop` is the
 * only mutating tool (and only ever creates *draft* tickets).
 */
export function makeHandlers(deps: HandlerDeps): Record<ToolName, ToolHandler> {
  const { ctx } = deps;
  const open = deps.openDispatch;
  const auditOpts = deps.audit;

  const handlers: Record<ToolName, ToolHandler> = {
    get_factory_status: () =>
      guard(async () => {
        const { config } = ctx.loaded;
        let dispatch: { ok: boolean; error?: { code: string; message: string } };
        try {
          // Probe with a real read, not a bare open(). The real client's open()
          // creates the sqlite (+ schema) when absent, so opening alone can never
          // prove the store is queryable. `listReady()` exercises the connection
          // and schema, so `dispatch.ok` means "actually usable", which is what
          // the agent relies on before calling get_context_packet / run_idle_loop.
          const wg = await open(ctx);
          wg.listReady();
          dispatch = { ok: true };
        } catch (err) {
          // Reachability probe must report, not throw — the rest of the status
          // is still useful when Dispatch is mid-build or absent.
          if (err instanceof CrewError) {
            dispatch = { ok: false, error: { code: err.code, message: err.message } };
          } else {
            dispatch = { ok: false, error: { code: "UNKNOWN", message: String(err) } };
          }
        }
        return {
          factory: {
            name: config.factory.name,
            mode: config.factory.mode,
            timezone: config.factory.timezone,
          },
          repoCount: ctx.repoRegistry.list().length,
          agentCount: ctx.agentRegistry.list().length,
          activeAgentCount: ctx.agentRegistry.active().length,
          loops: {
            implementation: {
              enabled: config.loops.implementation.enabled,
              maxConcurrentAgents: config.loops.implementation.max_concurrent_agents,
            },
            idleCoverage: {
              enabled: config.loops.idle_coverage.enabled,
              mode: config.loops.idle_coverage.mode,
              repos: config.loops.idle_coverage.repos,
              minimumGapThreshold: config.loops.idle_coverage.minimum_gap_threshold,
            },
          },
          dispatch,
        };
      }),

    list_agents: () =>
      guard(async () => ({
        agents: ctx.agentRegistry.list().map((a) => ({
          id: a.id,
          displayName: a.display_name,
          runtime: a.runtime,
          model: a.model,
          capabilities: a.capabilities,
          maxRisk: a.max_risk,
          status: a.status,
          allowedRepos: a.allowed_repos,
          deniedRepos: a.denied_repos,
        })),
      })),

    list_repos: (rawArgs) =>
      guard(async () => {
        const args = parseArgs("list_repos", rawArgs);
        const repos = ctx.repoRegistry.list().map((repo) => {
          const base = {
            id: repo.id,
            name: repo.name,
            path: ctx.repoRegistry.absolutePath(repo),
            defaultBranch: repo.default_branch,
            stack: repo.stack,
            mutationMode: repo.mutation_mode,
            riskLevel: repo.risk_level,
          };
          if (!args.scan) return base;
          return { ...base, scan: scanRepo(ctx.repoRegistry.absolutePath(repo), systemGitAdapter) };
        });
        return { repos };
      }),

    get_context_packet: (rawArgs) =>
      guard(async () => {
        const args = parseArgs("get_context_packet", rawArgs);
        const dispatch = await open(ctx);

        // Pre-fetch lore (async) for the ticket's repos + title, then seed a SYNC
        // client so the unchanged sync packet builder can use it. Degrades to the
        // Null client when no real Memory is configured (or it is unavailable).
        const events = new EventLog(systemClock, {
          filePath: ctx.loaded.config.logging.event_log_path,
          redact: ctx.loaded.config.logging.redact,
        });
        const asyncLore = await resolveAsyncMemory(ctx.loaded.config, events);
        let memory = new NullMemoryClient() as
          | ReturnType<typeof seededSyncClient>
          | NullMemoryClient;
        if (asyncLore) {
          const bundle = dispatch.getTicket(args.ticketRef);
          const tags = [
            ...new Set(
              bundle.repositories.flatMap((r) => ctx.repoRegistry.find(r.name)?.lore_tags ?? []),
            ),
          ];
          const records = await prefetchLore(
            asyncLore,
            { tags, text: bundle.ticket.title },
            events,
          );
          memory = seededSyncClient(records);
          await asyncLore.close();
        }

        const packet = buildContextPacket(args.ticketRef, {
          config: ctx.loaded.config,
          policy: ctx.policy,
          repoRegistry: ctx.repoRegistry,
          dispatch,
          memory,
          skillRegistry: loadSkillRegistry({ factoryDir: ctx.loaded.rootDir }),
        });
        return { packet };
      }),

    run_idle_loop: () =>
      guard(async () => {
        const dispatch = await open(ctx);
        const events = new EventLog(systemClock, {
          filePath: ctx.loaded.config.logging.event_log_path,
          redact: ctx.loaded.config.logging.redact,
        });
        const baseDeps = {
          config: ctx.loaded.config,
          repoRegistry: ctx.repoRegistry,
          dispatch,
          runner: systemCommandRunner,
          events,
          clock: systemClock,
        };
        // Run the SAME full idle registry the CLI runs, so the MCP idle path and
        // `crew idle` can never drift to different loop sets.
        const report = runIdleLoops(baseDeps);

        // Async lore-gap loop, behind loops.idle_lore_gap.enabled + real Memory.
        const asyncLore = await resolveAsyncMemory(ctx.loaded.config, events);
        let loreGap: unknown = null;
        let featureBacklog: unknown = null;
        if (asyncLore) {
          try {
            loreGap = await runIdleLoreGap({ ...baseDeps, memory: asyncLore });
            // Async feature-backlog loop: shares the live memory client; needs a
            // configured brownfield decomposer too, else it no-ops.
            const decomposer = resolveDecomposer(ctx.loaded.config);
            if (decomposer) {
              featureBacklog = await runIdleFeatureBacklog({
                ...baseDeps,
                memory: asyncLore,
                decomposer,
              });
            }
          } finally {
            await asyncLore.close();
          }
        }

        return {
          report,
          ...(loreGap ? { loreGap } : {}),
          ...(featureBacklog ? { featureBacklog } : {}),
          events: events.types(),
        };
      }),

    explain_safety_policy: () =>
      guard(async () => {
        const { git, filesystem, commands, secrets } = ctx.policy;
        return {
          git: {
            requireBranchPrefix: git.require_branch_prefix,
            protectedBranches: git.protected_branches,
            denyForcePush: git.deny_force_push,
            denyPushToProtectedBranches: git.deny_push_to_protected_branches,
            denyDeleteBranch: git.deny_delete_branch,
            denyTagMutation: git.deny_tag_mutation,
            denyRebaseSharedBranch: git.deny_rebase_shared_branch,
          },
          filesystem: {
            allowedRoots: filesystem.allowed_roots,
            denyWritePaths: filesystem.deny_write_paths,
            requireApprovalWritePaths: filesystem.require_approval_write_paths,
          },
          commands: {
            deny: commands.deny,
            requireApproval: commands.require_approval,
            allow: commands.allow,
            allowFromRepoConfig: commands.allow_from_repo_config,
          },
          secrets: {
            redactInContext: secrets.redact_in_context,
            denySecretFileReads: secrets.deny_secret_file_reads,
            highEntropyRedaction: secrets.high_entropy_redaction,
          },
        };
      }),

    check_command_allowed: (rawArgs) =>
      guard(async () => {
        const args = parseArgs("check_command_allowed", rawArgs);
        const decision = classifyCommand(args.command, {
          commands: ctx.policy.commands,
          git: ctx.policy.git,
        });
        return { command: args.command, decision };
      }),

    check_path_write_allowed: (rawArgs) =>
      guard(async () => {
        const args = parseArgs("check_path_write_allowed", rawArgs);
        // Resolve the repo root the same way the CLI's `safety check` does:
        // explicit repo ref, else the first configured repo, else cwd.
        const repo = args.repo ? ctx.repoRegistry.get(args.repo) : ctx.repoRegistry.list()[0];
        const repoRoot = repo ? ctx.repoRegistry.absolutePath(repo) : process.cwd();
        const decision = checkFileWrite(args.path, { repoRoot, policy: ctx.policy.filesystem });
        return { path: args.path, repo: repo?.id ?? null, repoRoot, decision };
      }),
  };

  // Wrap every handler with the redacted audit recorder.
  const audited = {} as Record<ToolName, ToolHandler>;
  for (const name of Object.keys(handlers) as ToolName[]) {
    audited[name] = withAudit(name, AUDIT_SPECS[name], auditOpts, handlers[name]);
  }
  return audited;
}
