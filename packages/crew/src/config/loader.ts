import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { parse as parseYaml } from "yaml";
import { ZodError, type ZodType, type z } from "zod";

import {
  defaultSafetyPolicy,
  safetyPolicySchema,
  type SafetyPolicy,
} from "../safety/policySchema.js";
import { CrewError, invalidConfig } from "../util/errors.js";
import { toZod3Issues } from "../util/zod3Compat.js";
import { crewConfigSchema, type CrewConfig, type IdleLoopMode } from "./schema.js";

/** Format a ZodError into a precise, multi-line, path-prefixed message. */
function formatZodError(error: ZodError): string {
  return toZod3Issues(error.issues)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  - ${path}: ${issue.message}`;
    })
    .join("\n");
}

function parseWith<S extends ZodType>(
  schema: S,
  raw: unknown,
  what: string,
  source: string,
): z.infer<S> {
  try {
    return schema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      throw invalidConfig(`Invalid ${what} (${source}):\n${formatZodError(err)}`, {
        source,
        issues: toZod3Issues(err.issues),
      });
    }
    throw err;
  }
}

export interface LoadedConfig {
  config: CrewConfig;
  /** Absolute directory the config file lives in — the factory root. */
  rootDir: string;
  configPath: string;
}

function readYamlFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    throw new CrewError("CONFIG_NOT_FOUND", `Config file not found: ${path}`, {
      path,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
  try {
    return parseYaml(text);
  } catch (cause) {
    throw invalidConfig(
      `Could not parse YAML in ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        path,
      },
    );
  }
}

/** Parse + validate crew config from a YAML string. */
export function parseConfig(yamlText: string, source = "<string>"): CrewConfig {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (cause) {
    throw invalidConfig(
      `Could not parse YAML: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        source,
      },
    );
  }
  return parseWith(crewConfigSchema, raw, "crew config", source);
}

/**
 * Resolve the effective events-log path for a loaded config.
 *
 * Priority (highest first):
 *   1. `GAFFER_CREW_EVENTS` env var — lets the runner redirect the log outside
 *      any repo worktree so delivery hygiene checks stay clean. A relative
 *      value resolves against the cwd (its natural meaning for an env var).
 *   2. `config.logging.event_log_path` from the YAML (default `./.crew/events.jsonl`).
 *      A relative value resolves against the config file's directory (the
 *      factory root), like `sqlite_path` and `policy_file` — NEVER the cwd, or
 *      `crew repo onboard .` run inside a repo leaks `.crew/` into that checkout.
 *
 * The result is always absolute, and is what every EventLog consumer should
 * write to. The same resolution happens inside `loadConfig`, so
 * `loaded.config.logging.event_log_path` already holds the effective path —
 * callers do not need to call this function separately.
 */
export function resolveEventLogPath(loaded: LoadedConfig): string {
  return effectiveEventLogPath(loaded.config.logging.event_log_path, loaded.rootDir);
}

function effectiveEventLogPath(yamlPath: string, rootDir: string): string {
  const envOverride = process.env.GAFFER_CREW_EVENTS;
  if (envOverride && envOverride.length > 0) return resolve(process.cwd(), envOverride);
  return isAbsolute(yamlPath) ? yamlPath : resolve(rootDir, yamlPath);
}

/**
 * The dashboard's idle-loop settings, as env overrides (B29). `GAFFER_IDLE_MODE` and
 * `GAFFER_IDLE_FEATURE_BACKLOG` were offered in the Settings panel (and exported into
 * every runner child process) but nothing ever read them — the panel's help text
 * promised control over the crew idle loops that never happened. They now override
 * the crew.yaml values the same way `GAFFER_CREW_EVENTS` overrides the events path:
 *
 *   - `GAFFER_IDLE_MODE` — sets the mode of EVERY idle loop (`loops.idle_*.mode`) and
 *     `safety.default_idle_loop_mode`. Accepts the crew vocabulary
 *     (`observe_only` · `create_draft_tickets` · `create_ready_tickets`) plus the
 *     short forms the panel once offered (`create_draft` · `create_ready`). An
 *     unrecognised value is IGNORED (crew.yaml stands) — a typo must never turn a
 *     read-only observe factory into one that files ready tickets, nor crash a tick.
 *   - `GAFFER_IDLE_FEATURE_BACKLOG` — `loops.idle_feature_backlog.enabled`
 *     (1/true/yes/on → on, 0/false/no/off → off; anything else ignored).
 *
 * Empty / unset leaves crew.yaml untouched, so a factory that never set them is
 * byte-identical.
 */
export const IDLE_MODE_ALIASES: Readonly<Record<string, IdleLoopMode>> = {
  observe_only: "observe_only",
  create_draft_tickets: "create_draft_tickets",
  create_ready_tickets: "create_ready_tickets",
  create_draft: "create_draft_tickets",
  create_ready: "create_ready_tickets",
};

/** Parse the env value of GAFFER_IDLE_MODE, or null when unset / unrecognised. */
export function idleModeFromEnv(raw: string | undefined): IdleLoopMode | null {
  const key = (raw ?? "").trim().toLowerCase();
  if (key === "") return null;
  return IDLE_MODE_ALIASES[key] ?? null;
}

/** Parse a 0/1/true/false/yes/no/on/off env flag, or null when unset / unrecognised. */
export function boolFromEnv(raw: string | undefined): boolean | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "") return null;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return null;
}

export function applyIdleLoopEnvOverrides(
  config: CrewConfig,
  env: NodeJS.ProcessEnv = process.env,
): CrewConfig {
  const mode = idleModeFromEnv(env.GAFFER_IDLE_MODE);
  const backlog = boolFromEnv(env.GAFFER_IDLE_FEATURE_BACKLOG);
  if (mode === null && backlog === null) return config;

  const loops: Record<string, unknown> = { ...config.loops };
  if (mode !== null) {
    for (const [key, value] of Object.entries(loops)) {
      if (
        key.startsWith("idle_") &&
        value !== null &&
        typeof value === "object" &&
        "mode" in (value as Record<string, unknown>)
      ) {
        loops[key] = { ...(value as Record<string, unknown>), mode };
      }
    }
  }
  if (backlog !== null) {
    // Spread the (possibly mode-overridden) entry, not the original, so both knobs compose.
    loops.idle_feature_backlog = {
      ...(loops.idle_feature_backlog as CrewConfig["loops"]["idle_feature_backlog"]),
      enabled: backlog,
    };
  }
  return {
    ...config,
    loops: loops as CrewConfig["loops"],
    safety: mode !== null ? { ...config.safety, default_idle_loop_mode: mode } : config.safety,
  };
}

/**
 * The factory's wiring for the async idle loops, as env FALLBACKS. A `crew init`
 * config leaves `memory.mcp.command` and `loops.idle_feature_backlog.decompose_script`
 * null and nothing (setup, the dashboard writer) ever set them, so the Settings
 * "Feature backlog" toggle alone could never run the loop: no memory client, no
 * decomposer. The runner's `fg` helper now names both:
 *
 *   - `CREW_MEMORY_MCP_BIN`    — the built memory-mcp bin; used as
 *     `memory.mcp = { command: <node>, args: [bin] }` when crew.yaml sets no command.
 *   - `CREW_DECOMPOSE_SCRIPT`  — runner's `bin/decompose.mjs`; used as
 *     `loops.idle_feature_backlog.decompose_script` when crew.yaml sets none.
 *
 * Fallbacks only: an explicit crew.yaml value always wins, and unset/blank env
 * leaves the config untouched (a standalone crew is byte-identical).
 */
export function applyFactoryWiringEnv(
  config: CrewConfig,
  env: NodeJS.ProcessEnv = process.env,
  nodeBin: string = process.execPath,
): CrewConfig {
  const memBin = (env.CREW_MEMORY_MCP_BIN ?? "").trim();
  const script = (env.CREW_DECOMPOSE_SCRIPT ?? "").trim();
  const memory =
    memBin !== "" && config.memory.mcp.command === null
      ? { ...config.memory, mcp: { command: nodeBin, args: [memBin] } }
      : config.memory;
  const backlog = config.loops.idle_feature_backlog;
  const loops =
    script !== "" && backlog.decompose_script === null
      ? { ...config.loops, idle_feature_backlog: { ...backlog, decompose_script: script } }
      : config.loops;
  if (memory === config.memory && loops === config.loops) return config;
  return { ...config, memory, loops };
}

/** Load + validate the crew config file from disk. */
export function loadConfig(configPath: string): LoadedConfig {
  const absolute = isAbsolute(configPath) ? configPath : resolve(process.cwd(), configPath);
  const raw = readYamlFile(absolute);
  const parsed = parseWith(crewConfigSchema, raw, "crew config", absolute);
  // B29: the dashboard's idle-loop settings reach the loops through the env.
  const config = applyFactoryWiringEnv(applyIdleLoopEnvOverrides(parsed));

  // Resolve the events-log path (GAFFER_CREW_EVENTS, else the YAML value against
  // the factory root) to an absolute path here, so every consumer that reads
  // config.logging.event_log_path gets the effective path without calling
  // resolveEventLogPath() — and never writes relative to whatever the cwd is.
  const rootDir = dirname(absolute);
  const resolved: typeof config = {
    ...config,
    logging: {
      ...config.logging,
      event_log_path: effectiveEventLogPath(config.logging.event_log_path, rootDir),
    },
  };
  return { config: resolved, rootDir, configPath: absolute };
}

/**
 * Resolve the Dispatch sqlite path for a loaded config.
 *
 * `CREW_DISPATCH_DB` wins when set: the runner's `fg` exports it as the factory's
 * $DISPATCH_DB, so a crew.yaml whose sqlite_path has drifted (a moved or restored
 * $GAFFER_DATA, an overridden DISPATCH_DB) can no longer send idle drafts and
 * onboard registrations to a DB nobody reads. Otherwise crew.yaml's value: an
 * absolute value is used as-is; a relative value resolves against the config
 * file's directory (the factory root) — NEVER against process.cwd(). This mirrors
 * how the policy path is resolved in {@link loadSafetyPolicy}.
 */
export function resolveSqlitePath(
  loaded: LoadedConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.CREW_DISPATCH_DB?.trim();
  if (override) return resolve(process.cwd(), override);
  return configuredSqlitePath(loaded);
}

/** crew.yaml's own sqlite_path, resolved against the factory root (no env override). */
export function configuredSqlitePath(loaded: LoadedConfig): string {
  const p = loaded.config.dispatch.local.sqlite_path;
  return isAbsolute(p) ? p : resolve(loaded.rootDir, p);
}

/** Load + validate the safety policy referenced by a loaded config. */
export function loadSafetyPolicy(loaded: LoadedConfig): SafetyPolicy {
  const policyPath = loaded.config.safety.policy_file;
  const absolute = isAbsolute(policyPath) ? policyPath : resolve(loaded.rootDir, policyPath);
  const raw = readYamlFile(absolute);
  return parseWith(safetyPolicySchema, raw, "safety policy", absolute);
}

/** Parse + validate a safety policy from a YAML string (falls back to defaults). */
export function parseSafetyPolicy(yamlText: string, source = "<string>"): SafetyPolicy {
  const trimmed = yamlText.trim();
  if (trimmed.length === 0) return defaultSafetyPolicy();
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (cause) {
    throw invalidConfig(
      `Could not parse safety policy YAML: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        source,
      },
    );
  }
  return parseWith(safetyPolicySchema, raw, "safety policy", source);
}
