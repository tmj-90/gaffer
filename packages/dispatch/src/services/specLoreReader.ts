/**
 * Spec-clause → Memory lore STATUS reader (Spec-Driven Development, Phase 3).
 *
 * The freeze seeder ({@link file://./specClauseSeeder.ts}) pushes each frozen clause
 * into Memory as gated lore. This reader is the read-back half: for a spec's clauses
 * it reports each clause's ratification status — `draft` (seeded, unratified),
 * `active` (approved, reaching delivery agents), `absent` (Memory wired, nothing
 * seeded) or `unknown` (Memory unwired / read failed). It exists so the coverage
 * trace can show whether product intent has actually reached the agents.
 *
 * COMPONENT BOUNDARY: Memory is a standalone product with its own DB. Dispatch must
 * NEVER read that DB directly — it is a separate store, not a cross-DB SQL join. So
 * this reader shells out to Memory's own CLI (`memory search --tag spec-<id>
 * --json`), spawned exactly like the seeder and the crew onboard bridge: a one-shot
 * child, DB via the `MEMORY_DB` env var (the CLI's contract), no flag.
 *
 * BEST-EFFORT: reading is NON-FATAL to the coverage endpoint. A Memory hiccup (CLI
 * absent, spawn failure, non-zero exit, unparseable output) yields `unknown` for
 * every clause and NEVER throws. Matching a record to a clause is heuristic (the
 * seeder scopes each record with a `spec-<id>` tag; we match a clause by its text
 * appearing in the record summary), which is acceptable precisely because the
 * signal is advisory — a wrong/absent match degrades to a coarser status, never an
 * error.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

import type { Spec, SpecClause, SpecLoreStatus } from "../domain/types.js";

/** Env var naming the Memory CLI executable (a Node script run via `node <bin>`). */
export const MEMORY_CLI_BIN_ENV = "MEMORY_CLI_BIN";
/** Env var naming the Memory sqlite the CLI reads from (the CLI's bin contract). */
export const MEMORY_DB_ENV = "MEMORY_DB";

/** Search cap — one seed per clause, so 50 comfortably covers realistic specs. */
const SEARCH_LIMIT = 50;
/** Length of the clause-text prefix used to match a clause to a seeded record. */
const MATCH_PREFIX = 48;

/** Reads seeded-lore status for a frozen spec's clauses. MUST NOT throw. */
export interface SpecLoreReader {
  /**
   * Map each clause_id → its seeded-lore status. Best-effort; every failure mode
   * degrades to `unknown`. Never throws.
   */
  statusFor(spec: Spec, clauses: readonly SpecClause[]): Map<string, SpecLoreStatus>;
}

/** Result of one Memory CLI invocation (the subset {@link CliRunner} returns). */
export interface CliRunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error | undefined;
}

/** Runs the Memory CLI with the given args. Injected so tests avoid a real spawn. */
export type CliRunner = (args: readonly string[]) => CliRunResult;

/** Minimal logger — best-effort reads log failures without a logging dep. */
export type ReadLogger = (message: string) => void;

/** No-op reader — Memory isn't wired, so every clause is `unknown`. */
export class NullSpecLoreReader implements SpecLoreReader {
  statusFor(_spec: Spec, clauses: readonly SpecClause[]): Map<string, SpecLoreStatus> {
    return new Map(clauses.map((c) => [c.clause_id, "unknown" as SpecLoreStatus]));
  }
}

/** One record from `memory search --json` (the fields this reader consumes). */
interface LoreSearchHit {
  readonly title?: unknown;
  readonly summary?: unknown;
}

export interface CliSpecLoreReaderConfig {
  /** Absolute path to the Memory CLI bin (`MEMORY_CLI_BIN`). */
  readonly cliBin: string;
  /** Memory sqlite path forwarded to the child as `MEMORY_DB`. */
  readonly db: string;
  /** Override the spawn (tests). Defaults to a real `spawnSync(node, ...)`. */
  readonly runner?: CliRunner;
  /** Where to report a best-effort failure. Defaults to `console.warn`. */
  readonly log?: ReadLogger;
}

/** Normalise text for a tolerant clause↔record match (lowercase, collapse space). */
function norm(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Build the `memory search` argv for a spec's seeded lore. `includeDrafts` widens
 * the search to unratified records; without it, only `active` records match — which
 * is how the reader distinguishes draft from active with the same tag.
 */
export function buildSearchArgs(spec: Spec, includeDrafts: boolean): string[] {
  const args = ["search", "--tag", `spec-${spec.id}`, "--json", "--limit", String(SEARCH_LIMIT)];
  if (includeDrafts) args.push("--include-drafts");
  return args;
}

/**
 * CLI-backed reader. Runs two searches per spec (active-only, then including
 * drafts) and classifies each clause by which result set it appears in. One record
 * per clause keeps this to two spawns regardless of clause count.
 */
export class CliSpecLoreReader implements SpecLoreReader {
  private readonly run: CliRunner;
  private readonly log: ReadLogger;

  constructor(config: CliSpecLoreReaderConfig) {
    this.run = config.runner ?? makeSpawnRunner(config.cliBin, config.db);
    this.log = config.log ?? ((m) => console.warn(m));
  }

  /** Build from the environment, or null when Memory isn't configured. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): CliSpecLoreReader | null {
    const cliBin = env[MEMORY_CLI_BIN_ENV]?.trim();
    const db = env[MEMORY_DB_ENV]?.trim();
    if (!cliBin || !db) return null;
    return new CliSpecLoreReader({ cliBin, db });
  }

  statusFor(spec: Spec, clauses: readonly SpecClause[]): Map<string, SpecLoreStatus> {
    const out = new Map<string, SpecLoreStatus>();
    // Default every clause to `unknown`; only a successful search narrows it.
    for (const c of clauses) out.set(c.clause_id, "unknown");

    const activeHits = this.search(spec, false);
    const allHits = this.search(spec, true);
    // Either search failing means we cannot trust ANY classification → leave unknown.
    if (activeHits === null || allHits === null) return out;

    const activeText = activeHits.map(hitText);
    const allText = allHits.map(hitText);
    for (const clause of clauses) {
      const needle = norm(clause.text).slice(0, MATCH_PREFIX);
      if (needle.length === 0) {
        out.set(clause.clause_id, "absent");
        continue;
      }
      if (activeText.some((t) => t.includes(needle))) out.set(clause.clause_id, "active");
      else if (allText.some((t) => t.includes(needle))) out.set(clause.clause_id, "draft");
      else out.set(clause.clause_id, "absent");
    }
    return out;
  }

  /** Run one search; return its hits, or null on ANY failure (spawn/exit/parse). */
  private search(spec: Spec, includeDrafts: boolean): LoreSearchHit[] | null {
    let res: CliRunResult;
    try {
      res = this.run(buildSearchArgs(spec, includeDrafts));
    } catch (err) {
      this.logFailure(spec, `spawn threw: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    if (res.error) {
      this.logFailure(spec, `spawn failed: ${res.error.message}`);
      return null;
    }
    if ((res.status ?? 0) !== 0) {
      this.logFailure(spec, `CLI exited ${res.status}: ${res.stderr.trim() || res.stdout.trim()}`);
      return null;
    }
    try {
      const parsed = JSON.parse(res.stdout.trim() || "[]") as unknown;
      return Array.isArray(parsed) ? (parsed as LoreSearchHit[]) : [];
    } catch (err) {
      this.logFailure(
        spec,
        `unparseable JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private logFailure(spec: Spec, detail: string): void {
    this.log(`spec-lore-read: reading lore status for spec ${spec.id} (non-fatal): ${detail}`);
  }
}

/** Concatenated, normalised title+summary of a hit — the haystack for matching. */
function hitText(hit: LoreSearchHit): string {
  const title = typeof hit.title === "string" ? hit.title : "";
  const summary = typeof hit.summary === "string" ? hit.summary : "";
  return norm(`${title} ${summary}`);
}

/** Default runner: spawn `node <bin> <...args>` with `MEMORY_DB` in the child env. */
function makeSpawnRunner(cliBin: string, db: string): CliRunner {
  return (args: readonly string[]): CliRunResult => {
    const res: SpawnSyncReturns<string> = spawnSync(process.execPath, [cliBin, ...args], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, [MEMORY_DB_ENV]: db },
    });
    return {
      status: res.status,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      error: res.error,
    };
  };
}

/**
 * Resolve the reader to wire into the coverage service: a live CLI reader when
 * Memory is configured in the environment, else a no-op that reports `unknown`.
 */
export function resolveSpecLoreReader(env: NodeJS.ProcessEnv = process.env): SpecLoreReader {
  return CliSpecLoreReader.fromEnv(env) ?? new NullSpecLoreReader();
}
