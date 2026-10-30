/**
 * Resolve which Memory client a factory should use.
 *
 *   memory.enabled && memory.mcp.command  -> real async McpMemoryClient
 *   memory.enabled && MEMORY_MCP_BIN + MEMORY_DB in the environment
 *                                         -> real McpMemoryClient on the factory's
 *                                            own memory-mcp + DB (what runner/tick.sh
 *                                            passes on an idle tick)
 *   otherwise                                   -> null (caller uses NullMemoryClient)
 *
 * Returning `null` (rather than throwing) keeps the offline/no-Memory path a
 * first-class, exception-free case: callers fall back to the Null client.
 *
 * NOTE: this is the QUERY-and-suggest resolver (search_lore / suggest_lore /
 * list_features for the backlog loop). The onboarding digest+feature WRITE flush
 * uses {@link resolveUnderstandingSink} instead, which prefers the memory CLI
 * bridge so a fresh install populates memory with no MCP server configured.
 */
import { CliMemoryClient, cliConfigFromEnv } from "./cliClient.js";
import {
  MEMORY_SERVER_ENV_KEYS,
  McpMemoryClient,
  memoryServerEnv,
  type AsyncMemoryClient,
} from "./mcpClient.js";
import type { CrewConfig } from "../config/schema.js";
import type { EventLog } from "../events/eventLog.js";

/** True when config declares a real Memory MCP server. */
export function hasRealMemory(config: CrewConfig): boolean {
  return config.memory.enabled && config.memory.mcp.command !== null;
}

/**
 * The Memory MCP server to spawn: crew.yaml's `memory.mcp` when set, else the
 * factory's own server from the environment (`MEMORY_MCP_BIN`, run with this
 * node, against `MEMORY_DB`). The runner exports both on the idle-tick crew
 * calls, so the async idle loops (lore gap, feature backlog) reach the SAME
 * memory DB the dashboard and the delivery agents use with no hand-wiring.
 * Null when memory is disabled or neither source is present.
 */
export function resolveMemoryServer(
  config: CrewConfig,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[]; env: Record<string, string> } | null {
  if (!config.memory.enabled) return null;
  // The server reads its DB + audit-log paths from these; forward them from the
  // SAME env the server was resolved from (the stdio transport drops them).
  const serverEnv = memoryServerEnv(env);
  const forwarded: Record<string, string> = {};
  for (const key of MEMORY_SERVER_ENV_KEYS) {
    if (serverEnv[key] !== undefined) forwarded[key] = serverEnv[key];
  }
  if (config.memory.mcp.command !== null) {
    return { command: config.memory.mcp.command, args: config.memory.mcp.args, env: forwarded };
  }
  const bin = env.MEMORY_MCP_BIN?.trim();
  const db = env.MEMORY_DB?.trim();
  if (bin && db) return { command: process.execPath, args: [bin], env: forwarded };
  return null;
}

/**
 * Connect the real async Memory client when configured, else return null.
 * A connection failure degrades to `null` + a warning event — never a throw —
 * so a dead Memory can't crash the (async) entry point.
 */
export async function resolveAsyncMemory(
  config: CrewConfig,
  events?: EventLog,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AsyncMemoryClient | null> {
  const server = resolveMemoryServer(config, env);
  if (server === null) return null;
  try {
    return await McpMemoryClient.connect(server);
  } catch (err) {
    events?.record("memory_unavailable", {
      stage: "connect",
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Resolve the memory CLI config the onboard flush should write through, in order:
 *   1. the `MEMORY_CLI_BIN` + `MEMORY_DB` environment (the factory's contract);
 *   2. `memory.cli.command` from config, paired with `MEMORY_DB` from env.
 * Returns null when no CLI channel is configured.
 */
function resolveCliConfig(
  config: CrewConfig,
  env: NodeJS.ProcessEnv,
): { cliBin: string; db: string } | null {
  const fromEnv = cliConfigFromEnv(env);
  if (fromEnv) return fromEnv;
  const command = config.memory.cli.command;
  const db = env.MEMORY_DB?.trim();
  if (command && db) return { cliBin: command, db };
  return null;
}

/**
 * Resolve the WRITE sink for the onboarding Repo Digest + feature inventory, in
 * priority order:
 *
 *   1. memory CLI bridge — MEMORY_CLI_BIN + MEMORY_DB (or memory.cli.command
 *      + MEMORY_DB) -> CliMemoryClient. NO MCP server, NO yaml MCP coupling;
 *      the SAME channel the factory's merge producer writes through, so the onboard
 *      flush and the merge flush land in one store via one contract. This is why a
 *      fresh install populates memory on first onboard even with mcp.command = null.
 *   2. a real MCP server (memory.mcp.command) -> McpMemoryClient.
 *   3. otherwise null (caller no-ops the flush).
 *
 * Disabled Memory short-circuits to null. A spawn/connect failure degrades to a
 * warning event + null — never a throw — so a dead sink can't fail onboarding.
 */
export async function resolveUnderstandingSink(
  config: CrewConfig,
  events?: EventLog,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AsyncMemoryClient | null> {
  if (!config.memory.enabled) return null;

  const cli = resolveCliConfig(config, env);
  if (cli) return new CliMemoryClient(cli);

  const command = config.memory.mcp.command;
  if (command === null) return null;
  try {
    return await McpMemoryClient.connect({ command, args: config.memory.mcp.args });
  } catch (err) {
    events?.record("memory_unavailable", {
      stage: "connect",
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
