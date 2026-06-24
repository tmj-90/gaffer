import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { DispatchError } from "../util/errors.js";

/**
 * Dashboard control surface for the crew idle-loop scan loops.
 *
 * The 5 scan loops + `idle_feature_backlog` live in `crew.yaml` under
 * `loops.idle_<key>.{enabled, repos}` — crew.yaml-only until now. This module
 * reads + writes JUST that slice of the YAML so the dashboard Settings panel can
 * enable a loop and scope it to repos, and the crew loop backend stays
 * unchanged: it still reads repo NAMES (an empty list means ALL repos).
 *
 * The contract this module owns:
 *  - {@link readIdleLoops} parses `crew.yaml`, returning each known loop as a
 *    flat `{ key, label, enabled, repos }` row (+ the factory-wide idle `mode`).
 *    A missing/unparseable file yields a clean "not configured" shape — never a
 *    throw — so the panel renders an empty state instead of a 500.
 *  - {@link writeIdleLoops} validates the requested keys + repo names, mutates
 *    ONLY the loops slice of the loaded YAML, and writes it back atomically. The
 *    rest of the YAML is preserved (parse → mutate → stringify).
 *
 * Changes apply on the crew runner's NEXT tick (it re-reads crew.yaml each
 * tick), so there is no live restart.
 */

/** The idle loops the dashboard exposes: the 5 scan loops + the feature backlog. */
export const IDLE_LOOP_KEYS = [
  "idle_coverage",
  "idle_test_quality",
  "idle_documentation",
  "idle_dependencies",
  "idle_security_hotspot",
  "idle_feature_backlog",
] as const;

export type IdleLoopKey = (typeof IDLE_LOOP_KEYS)[number];

/** Human labels for the panel — kept here so the API is the single source. */
const IDLE_LOOP_LABELS: Record<IdleLoopKey, string> = {
  idle_coverage: "Coverage",
  idle_test_quality: "Test quality",
  idle_documentation: "Documentation",
  idle_dependencies: "Dependencies",
  idle_security_hotspot: "Security hotspots",
  idle_feature_backlog: "Feature backlog",
};

const KNOWN_KEYS = new Set<string>(IDLE_LOOP_KEYS);

/** One idle loop as the dashboard sees it. */
export interface IdleLoopRow {
  readonly key: IdleLoopKey;
  readonly label: string;
  readonly enabled: boolean;
  /** Scoped repo NAMES; an empty list means "all repos" (schema semantics). */
  readonly repos: readonly string[];
}

/** The GET payload: the loop rows + factory-wide idle mode + whether configured. */
export interface IdleLoopsView {
  /** False when crew.yaml is absent/unreadable — the panel shows an empty state. */
  readonly configured: boolean;
  /** `safety.default_idle_loop_mode` from crew.yaml (empty when not configured). */
  readonly mode: string;
  readonly loops: readonly IdleLoopRow[];
}

/** One requested update — the editable fields only. */
export interface IdleLoopUpdate {
  readonly key: string;
  readonly enabled: boolean;
  readonly repos: readonly string[];
}

/**
 * Resolve the crew.yaml path. Precedence: `$CREW_CONFIG` (which `gaffer
 * dashboard` forwards) → `$GAFFER_DATA/crew.yaml` → `~/.gaffer/crew.yaml`. Mirrors
 * the runner's `factory.config.sh` default of `$GAFFER_DATA/crew.yaml`.
 */
export function resolveCrewConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.CREW_CONFIG ?? "").trim();
  if (explicit !== "") return resolve(explicit);
  const dataDir = (env.GAFFER_DATA ?? "").trim();
  const base = dataDir !== "" ? resolve(dataDir) : join(homedir(), ".gaffer");
  return join(base, "crew.yaml");
}

/** A single loop's `enabled` flag, read defensively from the parsed YAML. */
function readEnabled(loop: unknown): boolean {
  if (typeof loop !== "object" || loop === null) return false;
  return (loop as Record<string, unknown>).enabled === true;
}

/** A single loop's `repos` list, read defensively (only strings survive). */
function readRepos(loop: unknown): string[] {
  if (typeof loop !== "object" || loop === null) return [];
  const raw = (loop as Record<string, unknown>).repos;
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is string => typeof r === "string");
}

/**
 * Read the idle-loop view from `crew.yaml`. A missing or unparseable file is the
 * normal "not configured yet" state and yields `configured: false` with every
 * loop defaulted (disabled, all repos) — never a throw — so the panel renders an
 * empty state rather than a 500.
 */
export function readIdleLoops(path: string): IdleLoopsView {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return notConfiguredView();
    // A present-but-unreadable file (permissions) is still surfaced cleanly as
    // "not configured" rather than a 500 — the dashboard can't act on it anyway.
    return notConfiguredView();
  }

  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch {
    return notConfiguredView();
  }
  if (typeof doc !== "object" || doc === null) return notConfiguredView();

  const root = doc as Record<string, unknown>;
  const loopsNode =
    typeof root.loops === "object" && root.loops !== null
      ? (root.loops as Record<string, unknown>)
      : {};
  const safetyNode =
    typeof root.safety === "object" && root.safety !== null
      ? (root.safety as Record<string, unknown>)
      : {};
  const mode =
    typeof safetyNode.default_idle_loop_mode === "string"
      ? safetyNode.default_idle_loop_mode
      : "create_draft_tickets";

  const loops = IDLE_LOOP_KEYS.map((key): IdleLoopRow => {
    const node = loopsNode[key];
    return {
      key,
      label: IDLE_LOOP_LABELS[key],
      enabled: readEnabled(node),
      repos: readRepos(node),
    };
  });

  return { configured: true, mode, loops };
}

/** The clean "crew.yaml absent" shape: every loop disabled, scoped to all repos. */
function notConfiguredView(): IdleLoopsView {
  return {
    configured: false,
    mode: "",
    loops: IDLE_LOOP_KEYS.map((key) => ({
      key,
      label: IDLE_LOOP_LABELS[key],
      enabled: false,
      repos: [],
    })),
  };
}

/**
 * Apply idle-loop updates to `crew.yaml`. Validates every requested key is a
 * known idle loop and every named repo exists (cross-checked against
 * `knownRepoNames`), then mutates ONLY the `loops.idle_<key>.{enabled,repos}`
 * slice of the loaded YAML and writes it back atomically — the rest of the YAML
 * is preserved.
 *
 * Throws a {@link DispatchError} (`VALIDATION_ERROR` → 422) on an unknown loop
 * key or an unregistered repo name, and `NOT_CONFIGURED` (→ 503) when crew.yaml
 * is missing (there is nothing to write into).
 */
export function writeIdleLoops(
  path: string,
  updates: readonly IdleLoopUpdate[],
  knownRepoNames: readonly string[],
): IdleLoopsView {
  // Reject unknown loop keys up front with a clear message.
  for (const u of updates) {
    if (!KNOWN_KEYS.has(u.key)) {
      throw new DispatchError("VALIDATION_ERROR", `Unknown idle loop key: ${u.key}.`);
    }
  }
  // Reject duplicate keys — an ambiguous request should not silently last-wins.
  const seen = new Set<string>();
  for (const u of updates) {
    if (seen.has(u.key)) {
      throw new DispatchError("VALIDATION_ERROR", `Duplicate idle loop key: ${u.key}.`);
    }
    seen.add(u.key);
  }
  // Reject any repo NAME that is not registered in Dispatch — the crew loop only
  // understands names, so an unknown name would silently scope the loop to nothing.
  const knownRepos = new Set(knownRepoNames);
  for (const u of updates) {
    for (const repo of u.repos) {
      if (!knownRepos.has(repo)) {
        throw new DispatchError("VALIDATION_ERROR", `Unknown repo name: ${repo}.`);
      }
    }
  }

  let rawText: string;
  try {
    rawText = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new DispatchError(
        "NOT_CONFIGURED",
        `No crew.yaml to update at ${path}. Run 'crew init' first.`,
      );
    }
    throw new DispatchError(
      "INTERNAL_ERROR",
      `Could not read crew.yaml at ${path}: ${describe(err)}`,
    );
  }

  let doc: unknown;
  try {
    doc = parseYaml(rawText);
  } catch (err) {
    throw new DispatchError(
      "INTERNAL_ERROR",
      `Could not parse crew.yaml at ${path}: ${describe(err)}`,
    );
  }
  if (typeof doc !== "object" || doc === null) {
    throw new DispatchError("INTERNAL_ERROR", `crew.yaml at ${path} is not a mapping.`);
  }

  const root = doc as Record<string, unknown>;
  if (typeof root.loops !== "object" || root.loops === null) {
    root.loops = {};
  }
  const loopsNode = root.loops as Record<string, unknown>;

  for (const u of updates) {
    const existing =
      typeof loopsNode[u.key] === "object" && loopsNode[u.key] !== null
        ? (loopsNode[u.key] as Record<string, unknown>)
        : {};
    // Mutate only the two editable fields; everything else on the loop (mode,
    // thresholds, decompose wiring) is preserved verbatim.
    existing.enabled = u.enabled;
    existing.repos = [...u.repos];
    loopsNode[u.key] = existing;
  }

  atomicWriteYaml(path, root);
  return readIdleLoops(path);
}

/** Serialise `data` to `path` atomically (temp file in the same dir + rename). */
function atomicWriteYaml(path: string, data: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  // Random suffix (not Date.now()) so two writes in the same millisecond on the
  // same pid can't collide on the temp path and clobber each other's contents.
  const tmp = join(dir, `.crew.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  const body = stringifyYaml(data);
  try {
    writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    // A failed rename (cross-device, permissions) must not leave the temp file
    // littering the data dir — clean it up best-effort, then surface the error.
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file may never have been created; nothing to clean up.
    }
    throw err;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
