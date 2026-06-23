import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

import { CrewError } from "../util/errors.js";
import { defaultConfigYaml, defaultSafetyPolicyYaml } from "./template.js";

export interface InitOptions {
  /** Factory root directory (defaults to cwd). */
  dir?: string;
  factoryName?: string;
  timezone?: string;
  force?: boolean;
}

export interface InitResult {
  rootDir: string;
  configPath: string;
  safetyPolicyPath: string;
  created: string[];
  skipped: string[];
}

/**
 * Write a commented crew.yaml + safety_policy.yaml into the target dir.
 * Existing files are skipped unless `force` is set, so init never clobbers a
 * tuned config by accident.
 */
export function initFactory(opts: InitOptions = {}): InitResult {
  const rootDir = resolve(opts.dir ?? process.cwd());
  if (!existsSync(rootDir)) mkdirSync(rootDir, { recursive: true });

  const factoryName = opts.factoryName ?? basename(rootDir);
  const configPath = join(rootDir, "crew.yaml");
  const safetyPolicyPath = join(rootDir, "safety_policy.yaml");
  // Absolute, cwd-independent: point Crew at the SAME Dispatch db the
  // orchestrator + dashboard use (`<factory_root>/dispatch.sqlite`). A
  // cwd-relative value here is the footgun this guards against.
  const sqlitePath = join(rootDir, "dispatch.sqlite");

  const created: string[] = [];
  const skipped: string[] = [];

  writeIfAllowed(
    configPath,
    defaultConfigYaml({
      factoryName,
      sqlitePath,
      ...(opts.timezone ? { timezone: opts.timezone } : {}),
    }),
    opts.force ?? false,
    created,
    skipped,
  );
  writeIfAllowed(
    safetyPolicyPath,
    defaultSafetyPolicyYaml(),
    opts.force ?? false,
    created,
    skipped,
  );

  return { rootDir, configPath, safetyPolicyPath, created, skipped };
}

function writeIfAllowed(
  path: string,
  content: string,
  force: boolean,
  created: string[],
  skipped: string[],
): void {
  if (existsSync(path) && !force) {
    skipped.push(path);
    return;
  }
  try {
    writeFileSync(path, content, "utf8");
  } catch (cause) {
    throw new CrewError("INIT_WRITE_FAILED", `Could not write ${path}`, {
      path,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
  created.push(path);
}

/** Resolve a config path: explicit, or crew.yaml in the given/cwd dir. */
export function resolveConfigPath(explicit?: string, dir = process.cwd()): string {
  if (explicit) return isAbsolute(explicit) ? explicit : resolve(dir, explicit);
  return join(resolve(dir), "crew.yaml");
}
