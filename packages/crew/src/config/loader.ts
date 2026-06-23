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
import { crewConfigSchema, type CrewConfig } from "./schema.js";

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

/** Load + validate the crew config file from disk. */
export function loadConfig(configPath: string): LoadedConfig {
  const absolute = isAbsolute(configPath) ? configPath : resolve(process.cwd(), configPath);
  const raw = readYamlFile(absolute);
  const config = parseWith(crewConfigSchema, raw, "crew config", absolute);
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
