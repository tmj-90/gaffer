/**
 * Plan-failure ledger for the idle feature-backlog loop.
 *
 * A failed plan RELEASES the feature back to `backlog` (it is never stranded in
 * `building`), so on its own the next idle tick would claim the same feature again
 * and pay for another planner call — a feature the planner can never plan would
 * spend one model call per idle tick, up to MAX_TICKS_PER_DAY, every day. This
 * ledger counts consecutive failed plans per feature; once a feature reaches
 * `loops.idle_feature_backlog.max_plan_failures` the loop stops claiming it (it
 * stays in `backlog` for a human to rewrite or plan by hand). A successful filing
 * clears the count.
 *
 * Persisted as a tiny JSON file under `$GAFFER_DATA` (beside the maintenance
 * cursor) so the count survives across ticks and processes. Fail-soft on read: a
 * missing or corrupt file reads as "no failures" (at worst a feature gets its
 * remaining attempts again — still bounded). Writes are atomic (temp + rename).
 * To give a parked feature another try, delete its entry (or the whole file).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";

import type { CrewConfig } from "../config/schema.js";

/** File name of the ledger under `$GAFFER_DATA` (or the event log's directory). */
export const FEATURE_FAILURES_FILE = "feature-backlog-failures.json";

const entrySchema = z.object({
  failures: z.number().int().nonnegative(),
  lastError: z.string().default(""),
  lastFailedAt: z.string().default(""),
});

const ledgerSchema = z.object({
  features: z.record(z.string(), entrySchema).default({}),
});

export type FeatureFailureEntry = z.infer<typeof entrySchema>;

/** The per-feature consecutive plan-failure counts the loop consults. */
export interface FeatureFailureStore {
  /** Consecutive failed plans recorded for the feature (0 when none). */
  failures(featureId: string): number;
  /** Record one more failed plan; returns the new count. */
  recordFailure(featureId: string, error: string, at: string): number;
  /** Forget the feature's failures (its epic was filed). */
  clear(featureId: string): void;
}

/** An in-process store — used when there is no data dir to persist into (tests). */
export class MemoryFeatureFailureStore implements FeatureFailureStore {
  private readonly counts = new Map<string, number>();
  failures(featureId: string): number {
    return this.counts.get(featureId) ?? 0;
  }
  recordFailure(featureId: string): number {
    const next = this.failures(featureId) + 1;
    this.counts.set(featureId, next);
    return next;
  }
  clear(featureId: string): void {
    this.counts.delete(featureId);
  }
}

/** A JSON-file store at `path` (re-read on every call so concurrent ticks see each other). */
export class FileFeatureFailureStore implements FeatureFailureStore {
  constructor(readonly path: string) {}

  private load(): Record<string, FeatureFailureEntry> {
    if (!existsSync(this.path)) return {};
    try {
      const parsed = ledgerSchema.safeParse(JSON.parse(readFileSync(this.path, "utf8")));
      return parsed.success ? parsed.data.features : {};
    } catch {
      return {};
    }
  }

  private save(features: Record<string, FeatureFailureEntry>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
    try {
      writeFileSync(tmp, `${JSON.stringify({ features }, null, 2)}\n`, "utf8");
      renameSync(tmp, this.path);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
  }

  failures(featureId: string): number {
    return this.load()[featureId]?.failures ?? 0;
  }

  recordFailure(featureId: string, error: string, at: string): number {
    const features = this.load();
    const failures = (features[featureId]?.failures ?? 0) + 1;
    features[featureId] = { failures, lastError: error.slice(0, 500), lastFailedAt: at };
    this.save(features);
    return failures;
  }

  clear(featureId: string): void {
    const features = this.load();
    if (!(featureId in features)) return;
    delete features[featureId];
    this.save(features);
  }
}

/**
 * Where the ledger lives: `$GAFFER_DATA/feature-backlog-failures.json` (what the
 * runner sets on every idle tick), else beside the crew event log when that path is
 * absolute (a loaded config always resolves it), else null (no data dir known).
 */
export function featureFailuresPath(config: CrewConfig, env: NodeJS.ProcessEnv): string | null {
  const data = env.GAFFER_DATA?.trim();
  if (data) return join(data, FEATURE_FAILURES_FILE);
  const eventLog = config.logging.event_log_path;
  if (isAbsolute(eventLog)) return join(dirname(eventLog), FEATURE_FAILURES_FILE);
  return null;
}

/** The store for one tick: file-backed when a data dir is known, else in-process. */
export function resolveFeatureFailureStore(
  config: CrewConfig,
  env: NodeJS.ProcessEnv,
): FeatureFailureStore {
  const path = featureFailuresPath(config, env);
  return path ? new FileFeatureFailureStore(path) : new MemoryFeatureFailureStore();
}
