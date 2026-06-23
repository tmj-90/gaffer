import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { isSecretPath } from "../safety/secretPaths.js";
import type { Clock } from "../util/clock.js";
import { systemClock } from "../util/clock.js";
import type { OnboardingScanResult } from "./onboardScan.js";

/**
 * Non-committed repo context store (FG-004).
 *
 * Derived repo context lives OUTSIDE git, under:
 *   <root>/factories/<factory_id>/repos/<repo_id>/
 *     profile.json       — stable identity: path, remote, default branch, mapping.
 *     context.json       — derived context: commands, stack, important paths,
 *                          tags, scan timestamps + content fingerprint.
 *     scan-history.jsonl — append-only log of every (re)scan (ts + fingerprint).
 *
 * The root defaults to `~/.crew` (override per-factory via config /
 * `GAFFER_DATA_DIR`). Nothing here is ever committed to a repo, and NO raw
 * secret is stored — the scan that feeds it already excludes secret paths
 * (see {@link isSecretPath}), and {@link assertNoSecrets} is a belt-and-braces
 * check on the important-paths list before any write.
 */

const DEFAULT_DIR_NAME = ".crew";
const DATA_DIR_ENV = "GAFFER_DATA_DIR";

/** How a repo is associated with the scope graph (or not). */
export type RepoMappingMode = "unmapped" | "standalone" | "mapped";

export const repoMappingSchema = z.object({
  mode: z.enum(["unmapped", "standalone", "mapped"]),
  /** Scope node ids the repo is attached to (only for `mapped`). */
  scopeNodeIds: z.array(z.string()).default([]),
});
export type RepoMapping = z.infer<typeof repoMappingSchema>;

export const repoProfileSchema = z.object({
  repoId: z.string().min(1),
  name: z.string().min(1),
  localPath: z.string().min(1),
  remoteUrl: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  isGitRepo: z.boolean(),
  mapping: repoMappingSchema,
  onboardedAt: z.string(),
});
export type RepoProfile = z.infer<typeof repoProfileSchema>;

export const repoContextSchema = z.object({
  stack: z.string().nullable(),
  packageManager: z.string().nullable(),
  commands: z.object({
    test: z.string().nullable(),
    lint: z.string().nullable(),
    build: z.string().nullable(),
    coverage: z.string().nullable(),
  }),
  importantPaths: z.array(z.string()),
  tags: z.array(z.string()),
  riskSignals: z.array(z.string()),
  /** Content fingerprint of the manifest set — changes when deps/scripts change. */
  fingerprint: z.string(),
  /** When this context was first written. */
  firstScannedAt: z.string(),
  /** Freshness: when the context was last (re)scanned. */
  lastScannedAt: z.string(),
  /** How many times the repo has been scanned (1 on first onboard). */
  scanCount: z.number().int().positive(),
});
export type RepoContext = z.infer<typeof repoContextSchema>;

/** One appended scan-history line. */
export interface ScanHistoryEntry {
  ts: string;
  fingerprint: string;
  /** True when this scan's fingerprint differed from the previous one. */
  changed: boolean;
  stack: string | null;
}

export interface ContextStoreOptions {
  /** Storage root. Defaults to `GAFFER_DATA_DIR` env, else `~/.crew`. */
  root?: string;
  factoryId: string;
  clock?: Clock;
  env?: NodeJS.ProcessEnv;
}

/** Resolve the storage root (pure; no I/O) so callers can report the same path. */
export function resolveDataRoot(opts: { root?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const env = opts.env ?? process.env;
  const fromEnv = env[DATA_DIR_ENV];
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  if (opts.root && opts.root.trim().length > 0) return opts.root;
  return join(homedir(), DEFAULT_DIR_NAME);
}

/** Belt-and-braces: refuse to persist any secret-looking important path. */
function assertNoSecrets(paths: readonly string[]): void {
  const offending = paths.find((p) => isSecretPath(p));
  if (offending) {
    throw new Error(`Refusing to store secret-looking path in repo context: ${offending}`);
  }
}

/**
 * Filesystem-backed repo context store. One instance is scoped to a single
 * factory; per-repo files live under `repos/<repoId>/`.
 */
export class RepoContextStore {
  private readonly factoryRoot: string;
  private readonly clock: Clock;

  constructor(opts: ContextStoreOptions) {
    const root = resolveDataRoot({
      ...(opts.root ? { root: opts.root } : {}),
      ...(opts.env ? { env: opts.env } : {}),
    });
    this.factoryRoot = join(root, "factories", opts.factoryId);
    this.clock = opts.clock ?? systemClock;
  }

  /** Absolute directory for one repo's context files. */
  repoDir(repoId: string): string {
    return join(this.factoryRoot, "repos", repoId);
  }

  private path(repoId: string, file: string): string {
    return join(this.repoDir(repoId), file);
  }

  /** True when this repo already has stored context. */
  has(repoId: string): boolean {
    return existsSync(this.path(repoId, "profile.json"));
  }

  readProfile(repoId: string): RepoProfile | null {
    return this.readJson(this.path(repoId, "profile.json"), repoProfileSchema);
  }

  readContext(repoId: string): RepoContext | null {
    return this.readJson(this.path(repoId, "context.json"), repoContextSchema);
  }

  /** Read the append-only scan history (oldest first), or [] when none. */
  readScanHistory(repoId: string): ScanHistoryEntry[] {
    const file = this.path(repoId, "scan-history.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ScanHistoryEntry);
  }

  /**
   * Onboard a repo: write its profile + context and start its scan history.
   * Throws if context already exists (use {@link rescan} to refresh).
   */
  onboard(input: {
    repoId: string;
    name: string;
    scan: OnboardingScanResult;
    mapping: RepoMapping;
    tags?: string[];
  }): { profile: RepoProfile; context: RepoContext } {
    if (this.has(input.repoId)) {
      throw new Error(`Repo '${input.repoId}' is already onboarded; use rescan to refresh.`);
    }
    assertNoSecrets(input.scan.importantPaths);
    const now = this.clock.now();

    const profile: RepoProfile = {
      repoId: input.repoId,
      name: input.name,
      localPath: input.scan.path,
      remoteUrl: input.scan.remoteUrl,
      defaultBranch: input.scan.defaultBranch,
      isGitRepo: input.scan.isGitRepo,
      mapping: input.mapping,
      onboardedAt: now,
    };
    const context: RepoContext = {
      stack: input.scan.stack,
      packageManager: input.scan.packageManager,
      commands: {
        test: input.scan.testCommand,
        lint: input.scan.lintCommand,
        build: input.scan.buildCommand,
        coverage: input.scan.coverageCommand,
      },
      importantPaths: input.scan.importantPaths,
      tags: input.tags ?? [],
      riskSignals: input.scan.riskSignals,
      fingerprint: input.scan.fingerprint,
      firstScannedAt: now,
      lastScannedAt: now,
      scanCount: 1,
    };

    this.writeJson(input.repoId, "profile.json", profile);
    this.writeJson(input.repoId, "context.json", context);
    this.appendHistory(input.repoId, {
      ts: now,
      fingerprint: context.fingerprint,
      changed: true,
      stack: context.stack,
    });
    return { profile, context };
  }

  /**
   * Rescan an onboarded repo: refresh its context from a fresh scan, bump the
   * freshness timestamp + scan count, and append a scan-history line recording
   * whether the fingerprint changed. The profile's identity is preserved; only
   * remote/default-branch (which can legitimately move) is refreshed. Throws if
   * the repo has not been onboarded.
   */
  rescan(input: { repoId: string; scan: OnboardingScanResult; tags?: string[] }): {
    context: RepoContext;
    changed: boolean;
  } {
    const existing = this.readContext(input.repoId);
    const profile = this.readProfile(input.repoId);
    if (!existing || !profile) {
      throw new Error(`Repo '${input.repoId}' is not onboarded; onboard it before rescanning.`);
    }
    assertNoSecrets(input.scan.importantPaths);
    const now = this.clock.now();
    const changed = existing.fingerprint !== input.scan.fingerprint;

    const context: RepoContext = {
      stack: input.scan.stack,
      packageManager: input.scan.packageManager,
      commands: {
        test: input.scan.testCommand,
        lint: input.scan.lintCommand,
        build: input.scan.buildCommand,
        coverage: input.scan.coverageCommand,
      },
      importantPaths: input.scan.importantPaths,
      tags: input.tags ?? existing.tags,
      riskSignals: input.scan.riskSignals,
      fingerprint: input.scan.fingerprint,
      firstScannedAt: existing.firstScannedAt,
      lastScannedAt: now,
      scanCount: existing.scanCount + 1,
    };
    const refreshedProfile: RepoProfile = {
      ...profile,
      remoteUrl: input.scan.remoteUrl,
      defaultBranch: input.scan.defaultBranch,
    };

    this.writeJson(input.repoId, "profile.json", refreshedProfile);
    this.writeJson(input.repoId, "context.json", context);
    this.appendHistory(input.repoId, {
      ts: now,
      fingerprint: context.fingerprint,
      changed,
      stack: context.stack,
    });
    return { context, changed };
  }

  private writeJson(repoId: string, file: string, value: unknown): void {
    const dir = this.repoDir(repoId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.path(repoId, file), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  private appendHistory(repoId: string, entry: ScanHistoryEntry): void {
    const dir = this.repoDir(repoId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(this.path(repoId, "scan-history.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
  }

  private readJson<S extends z.ZodTypeAny>(file: string, schema: S): z.infer<S> | null {
    if (!existsSync(file)) return null;
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return schema.parse(parsed) as z.infer<S>;
  }
}
