import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import type { AuditOptions } from "../audit/index.js";
import type { FactoryContext } from "../runtime/wiring.js";
import { loadFactory, openDispatch } from "../runtime/wiring.js";
import {
  makeHandlers,
  toolSchemas,
  type ToolName,
  type ToolResult,
  type DispatchOpener,
} from "./tools.js";

/**
 * Agent-coaching tool descriptions. Each one tells the agent operating the
 * factory WHEN to reach for the tool, HOW to read the result, what to do on an
 * empty/failed result, and which anti-patterns to avoid. The factory's whole
 * safety story depends on agents calling `check_*` and `explain_safety_policy`
 * BEFORE acting — so those descriptions lean hard on cost asymmetry.
 */
const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  get_factory_status:
    "**Call this first when you start operating a factory you don't already know.** " +
    "It is the cheap orientation read: factory name + mode (local_loose / " +
    "local_strict / shared_team), how many repos and agents are configured, how " +
    "many agents are active, which loops are enabled, and — critically — whether " +
    "Dispatch (the work store) is reachable.\n\n" +
    "Read `dispatch.ok` before any work-driving tool. If it is `false`, " +
    "`get_context_packet` and `run_idle_loop` WILL fail the same way — fix the " +
    "Dispatch connection first (the `dispatch.error.code` tells you why; " +
    "`DISPATCH_UNAVAILABLE` usually means its package isn't built yet). " +
    "The `mode` shapes how strict the safety policy is: in `local_loose` more is " +
    "auto-allowed, in `shared_team` expect more `needs_approval` decisions. " +
    "This tool is read-only and never mutates anything — call it freely.",

  list_agents:
    "List the agents this factory can route work to, with each one's " +
    "capabilities, risk ceiling (`maxRisk`), status, and repo allow/deny lists. " +
    "**Use it to answer 'who can take this ticket?'** before driving an " +
    "implementation loop: an agent can only claim work whose required " +
    "capabilities it has, whose risk is at or below its ceiling, and whose repo " +
    "isn't denied to it. `status` other than `active` (paused/disabled/" +
    "unhealthy) means the agent is out of rotation — don't route to it. " +
    "An empty list means no agents are configured yet; add them to " +
    "crew.yaml before expecting any loop to claim work. Read-only.",

  list_repos:
    "List the repositories under this factory, with each repo's stack, default " +
    "branch, mutation mode and risk level. **Call it to learn what you're " +
    "allowed to touch and how.** `mutationMode` is the hard ceiling on changes — " +
    "`read_only` and `branch_only` mean exactly that; never assume you can push " +
    "to a default branch. Pass `scan: true` to add a live git scan (current " +
    "branch, dirty/clean, detected stack) — do that when you need ground truth " +
    "about a repo's working state, but skip it (omit `scan`) for a cheap " +
    "configuration-only listing, since scanning shells out per repo. An empty " +
    "list means the factory has no repos configured. Read-only.",

  get_context_packet:
    "**Call this to get everything you need to work a ticket — and nothing you " +
    "shouldn't see.** Given a `ticketRef`, it assembles a single packet: the " +
    "ticket + its acceptance criteria, the repos involved with their paths and " +
    "test/lint commands, the branch policy and forbidden actions that apply, and " +
    "the relevant team lore (conventions, gotchas) pre-fetched from Memory. " +
    "Every free-text field is run through secret redaction before it reaches " +
    "you, so the packet is the *sanctioned* view of the work — prefer it over " +
    "reading raw ticket rows or repo `.env` files yourself.\n\n" +
    "Requires Dispatch to be reachable (check `get_factory_status` first if " +
    "unsure). A bad `ticketRef` fails with `NOT_FOUND` — re-list ready work " +
    "rather than guessing ids. If the lore section is empty, Memory simply " +
    "has nothing tagged for this work; proceed, and consider suggesting lore " +
    "afterwards if you learn something the team should remember. Read-only: " +
    "building a packet never changes the ticket.",

  run_idle_loop:
    "Run one idle-coverage tick: scan the configured repos for low-coverage / " +
    "quality gaps and file the findings as work. **This is the only tool that " +
    "writes to Dispatch — and it ONLY ever creates DRAFT tickets.** It never " +
    "edits code, never claims or readies tickets, and never touches git. Call it " +
    "when the work queue is empty and you want the factory to propose its own " +
    "next tasks, not when you already have a ticket to work.\n\n" +
    "Inspect `outcome.status`: `draft_created` means new drafts were filed (see " +
    "`outcome.drafts[].ticketId`); a no-work status means nothing crossed the " +
    "configured gap threshold — that's a healthy result, not an error, so don't " +
    "retry in a loop. Each call is one tick; the drafts wait for a human to " +
    "promote them to ready. Requires Dispatch to be reachable.",

  explain_safety_policy:
    "Return the loaded safety policy in full: git rules (branch prefix, " +
    "protected branches, force-push / delete / rebase bans), filesystem rules " +
    "(allowed roots, denied and approval-gated write paths), command rules " +
    "(denied, approval-gated, allowed), and secret handling. **Read this before " +
    "planning any mutation so you know the boundary you're operating inside.** " +
    "The policy is enforced deterministically by a PreToolUse hook regardless of " +
    "what you do — these are the rules you'll be held to, not suggestions. Use " +
    "it to choose a compliant approach up front (e.g. a correctly-prefixed " +
    "branch) instead of getting denied mid-task. For a yes/no on one specific " +
    "command or path, call `check_command_allowed` / `check_path_write_allowed` " +
    "instead — they're cheaper than reasoning over the whole policy. Read-only.",

  check_command_allowed:
    "**Call this BEFORE running any shell command whose safety you're unsure of " +
    "— the check is far cheaper than a denied or destructive action.** It " +
    "classifies the command against the git + command policy and returns a " +
    "three-valued decision: `allowed` (proceed), `needs_approval` (a human must " +
    "sign off — stop and request it; do not try to route around it), or `denied` " +
    "(never run this; find another way). The `reason` explains which rule " +
    "matched. Destructive git (force-push, branch/tag deletion, rebase of shared " +
    "branches) and risky installs are the usual `needs_approval`/`denied` hits. " +
    "When in doubt, check — a false 'allowed' assumption is the expensive " +
    "mistake, an extra check costs one cheap call. Read-only; classifying a " +
    "command never runs it.",

  check_path_write_allowed:
    "**Call this before writing to any path you're not certain is in-bounds.** " +
    "It classifies a filesystem write against the policy and returns the same " +
    "three-valued decision as `check_command_allowed`: `allowed`, " +
    "`needs_approval`, or `denied`. Pass the target `path` and optionally a " +
    "`repo` to anchor relative paths to that repo's root (otherwise the first " +
    "configured repo, else the process cwd, is used). Writes outside the " +
    "allowed roots, and to secret files like `.env`, are denied or gated — this " +
    "is the boundary that keeps agents from exfiltrating or corrupting files " +
    "outside the sanctioned work area. Prefer one cheap check over a denied " +
    "write that wastes a whole turn. Read-only; checking a path never writes it.",
};

export interface ServerOptions {
  /** Pre-loaded factory context. Falls back to {@link loadFactory} when omitted. */
  ctx?: FactoryContext;
  /** Path to crew.yaml; ignored when `ctx` is supplied. */
  config?: string;
  /** How tools open Dispatch. Defaults to the real adapter; tests inject a fake. */
  dispatchOpener?: DispatchOpener;
  /**
   * Override the redacted MCP audit log destination. By default the log lands
   * beside the factory data dir (the factory root), overridable via the
   * `GAFFER_AUDIT` env var or disabled via `GAFFER_AUDIT_OFF=1`. Tests pass a temp
   * path or `{ env: { GAFFER_AUDIT_OFF: "1" } }` to stay off the real log.
   */
  audit?: AuditOptions;
}

/**
 * Build an MCP server exposing the Crew factory tools. Transport-agnostic:
 * call {@link runStdioServer} to serve over stdio, or register the returned
 * handlers directly in tests. Wiring (config + registries + safety policy) is
 * loaded once and shared by every tool.
 */
export function createCrewServer(options: ServerOptions = {}): McpServer {
  const ctx = options.ctx ?? loadFactory(options.config ? { config: options.config } : {});
  // Default the audit log to live beside the factory data dir (the config's root)
  // so a per-factory log is kept without extra config; GAFFER_AUDIT still overrides.
  const audit: AuditOptions = options.audit ?? { dataDir: ctx.loaded.rootDir };
  const handlers = makeHandlers({
    ctx,
    openDispatch: options.dispatchOpener ?? openDispatch,
    audit,
  });

  const server = new McpServer({ name: "crew", version: "0.1.0" });

  for (const name of Object.keys(toolSchemas) as ToolName[]) {
    const handler = handlers[name];
    server.registerTool(
      name,
      {
        description: TOOL_DESCRIPTIONS[name],
        inputSchema: toolSchemas[name],
      },
      // The SDK passes parsed args; handlers re-validate defensively and return
      // a structured ToolResult (Promise-returning, hence the async bridge).
      async (args: Record<string, unknown>): Promise<ToolResult> => handler(args ?? {}),
    );
  }

  return server;
}

/**
 * Resolve config (CREW_CONFIG / -c / --config / default) and serve the
 * Crew MCP tools over stdio.
 */
export async function runStdioServer(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const config = resolveConfigArg(argv) ?? process.env.CREW_CONFIG;
  const server = createCrewServer(config ? { config } : {});
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/** Extract a `-c <path>` / `--config <path>` (or `=` form) value from argv. */
function resolveConfigArg(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "-c" || arg === "--config") return argv[i + 1];
    if (arg.startsWith("--config=")) return arg.slice("--config=".length);
    if (arg.startsWith("-c=")) return arg.slice("-c=".length);
  }
  return undefined;
}
