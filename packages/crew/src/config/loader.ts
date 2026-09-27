import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { parse as parseYaml } from "yaml";
import { ZodError, type ZodTypeAny, type z } from "zod";

import {
  defaultSafetyPolicy,
  safetyPolicySchema,
  type SafetyPolicy,
} from "../safety/policySchema.js";
import { CrewError, invalidConfig } from "../util/errors.js";
import { crewConfigSchema, type CrewConfig, type IdleLoopMode } from "./schema.js";

/** Format a ZodError into a precise, multi-line, path-prefixed message. */
function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  - ${path}: ${issue.message}`;
    })
    .join("\n");
}

function parseWith<S extends ZodTypeAny>(
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
        issues: err.issues,
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
 *      any repo worktree so delivery hygiene checks stay clean.
 *   2. `config.logging.event_log_path` from the YAML (default `./.crew/events.jsonl`).
 *
 * The resolved path is what every EventLog consumer should write to. The
 * override is also applied inside `loadConfig` so that
 * `loaded.config.logging.event_log_path` always returns the effective path —
 * callers do not need to call this function separately.
 */
export function resolveEventLogPath(loaded: LoadedConfig): string {
  const envOverride = process.env.GAFFER_CREW_EVENTS;
  if (envOverride && envOverride.length > 0) {
    return envOverride;
  }
  return loaded.config.logging.event_log_path;
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

/** Load + validate the crew config file from disk. */
export function loadConfig(configPath: string): LoadedConfig {
  const absolute = isAbsolute(configPath) ? configPath : resolve(process.cwd(), configPath);
  const raw = readYamlFile(absolute);
  const parsed = parseWith(crewConfigSchema, raw, "crew config", absolute);
  // B29: the dashboard's idle-loop settings reach the loops through the env.
  const config = applyIdleLoopEnvOverrides(parsed);

  // Apply the GAFFER_CREW_EVENTS env override so every consumer that reads
  // config.logging.event_log_path automatically gets the redirected path
  // without needing to call resolveEventLogPath() explicitly.
  const envOverride = process.env.GAFFER_CREW_EVENTS;
  if (envOverride && envOverride.length > 0) {
    const overridden: typeof config = {
      ...config,
      logging: { ...config.logging, event_log_path: envOverride },
    };
    return { config: overridden, rootDir: dirname(absolute), configPath: absolute };
  }

  return { config, rootDir: dirname(absolute), configPath: absolute };
}

/**
 * Resolve the Dispatch sqlite path for a loaded config. An absolute value is
 * used as-is; a relative value resolves against the config file's directory
 * (the factory root) — NEVER against process.cwd(). This mirrors how the policy
 * path is resolved in {@link loadSafetyPolicy} and guarantees every consumer
 * opens the same db the orchestrator + dashboard use, regardless of cwd.
 */
export function resolveSqlitePath(loaded: LoadedConfig): string {
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
