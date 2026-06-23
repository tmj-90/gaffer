import { resolveConfigPath } from "../config/init.js";
import {
  loadConfig,
  loadSafetyPolicy,
  resolveSqlitePath,
  type LoadedConfig,
} from "../config/loader.js";
import { AgentRegistry } from "../registry/agentRegistry.js";
import { RepoRegistry } from "../registry/repoRegistry.js";
import type { SafetyPolicy } from "../safety/policySchema.js";
import { RealDispatchClient } from "../dispatch/realClient.js";
import type { DispatchClient } from "../dispatch/client.js";

/**
 * The fully-wired factory context shared by the CLI and the MCP server: a
 * validated config plus the read-only registries and safety policy derived from
 * it. Centralising this keeps both entry points loading the factory the same
 * way (and means a schema change is wired in exactly one place).
 */
export interface FactoryContext {
  loaded: LoadedConfig;
  policy: SafetyPolicy;
  repoRegistry: RepoRegistry;
  agentRegistry: AgentRegistry;
}

/** Load + validate the factory config and build its registries + safety policy. */
export function loadFactory(opts: { config?: string }): FactoryContext {
  const loaded = loadConfig(resolveConfigPath(opts.config));
  const policy = loadSafetyPolicy(loaded);
  const repoRegistry = RepoRegistry.fromConfig(loaded.config, loaded.rootDir);
  const agentRegistry = AgentRegistry.fromConfig(loaded.config);
  return { loaded, policy, repoRegistry, agentRegistry };
}

/**
 * Open the real Dispatch adapter against the factory's configured SQLite path.
 * Lazy: only the real adapter is touched here. If Dispatch is mid-build this
 * throws a structured {@link import("../util/errors.js").CrewError} rather
 * than crashing the host process.
 */
export async function openDispatch(ctx: FactoryContext): Promise<DispatchClient> {
  return RealDispatchClient.open(resolveSqlitePath(ctx.loaded));
}
