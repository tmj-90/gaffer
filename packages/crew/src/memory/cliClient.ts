/**
 * CLI-backed ASYNC Memory client.
 *
 * Writes the onboarding Repo Digest + feature inventory to the MEMORY product by
 * spawning its deterministic CLI verbs (`<memory-cli> digest set` / `feature add` /
 * `features`), driven by `MEMORY_CLI_BIN` + `MEMORY_DB` in the environment —
 * with NO dependency on `crew.yaml`'s MCP config and NO spawned MCP server.
 *
 * This is the SAME channel the factory's merge producer uses
 * (`runner/lib/feature-digest.mjs` → `lg digest set` / `lg feature add`), so
 * the onboard flush and the merge flush land in one store via one contract:
 *   - `digest set <repo> --overview .. --structure .. --conventions .. [--stack ..] --source ..`
 *   - `feature add <repo> --name .. --summary .. --status .. [--scope-node ..] [--provenance ..]`
 *   - `features <repo>`  (read-back for client-side repo+name de-dupe)
 *
 * It implements only the verbs the onboard flush needs
 * ({@link flushRepoUnderstanding}: `updateRepoDigest`, `listFeatures`, `addFeature`);
 * the pre-fetch/backlog verbs throw `MEMORY_UNAVAILABLE` because this client is a
 * write-only onboard bridge, not a query surface. Each spawn that exits non-zero is
 * surfaced as a structured `CrewError` so the flush helper degrades cleanly.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

import { CrewError } from "../util/errors.js";
import type {
  AdvanceFeatureResult,
  BacklogFeature,
  ExistingFeature,
  FeatureInput,
  FeatureStatus,
  LoreRecord,
  LoreSearchQuery,
  LoreSuggestionInput,
  LoreSuggestionResult,
  RepoDigestInput,
  RepoDigestResult,
} from "./client.js";
import type { AsyncMemoryClient } from "./mcpClient.js";

/** Env var naming the memory CLI executable (a Node script run via `node <bin>`). */
export const MEMORY_CLI_BIN_ENV = "MEMORY_CLI_BIN";
/** Env var naming the memory sqlite the CLI writes to (the CLI's bin contract). */
export const MEMORY_DB_ENV = "MEMORY_DB";

/** Result of one CLI invocation (the subset {@link CliRunner} must return). */
export interface CliRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error | undefined;
}

/**
 * Runs the memory CLI with the given args. Injected so unit tests can stub the
 * spawn without a real CLI on disk. The default spawns `node <bin> <...args>` with
 * `MEMORY_DB` in the child env (the CLI's bin contract — DB via env, no flag).
 */
export type CliRunner = (args: readonly string[]) => CliRunResult;

export interface CliMemoryConfig {
  /** Absolute path to the memory CLI bin (`MEMORY_CLI_BIN`). */
  cliBin: string;
  /** Memory sqlite path forwarded to the child as `MEMORY_DB`. */
  db: string;
  /** Override the spawn (tests). Defaults to a real `spawnSync(node, ...)`. */
  runner?: CliRunner;
}

/**
 * Resolve a CLI client config from the environment, or `null` when the memory CLI
 * bin is not configured. Keeping the env-read here (not in the client) means the
 * factory resolver can decide robustly with no `crew.yaml` coupling.
 */
export function cliConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): { cliBin: string; db: string } | null {
  const cliBin = env[MEMORY_CLI_BIN_ENV]?.trim();
  const db = env[MEMORY_DB_ENV]?.trim();
  if (!cliBin || !db) return null;
  return { cliBin, db };
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
 * Parse a `features <repo>` human listing into the repo+name pairs the de-dupe
 * needs. Each feature line renders as:
 *   `  [<status>] <name>[  @<scope>][  (<area>)]  (<id>)`
 * so we strip the `  [status] ` prefix and the trailing `  (id)` (and an optional
 * `  @scope` / `  (area)` between them) to recover the name. Lines that don't match
 * (headers, summaries, blanks) are ignored. Tolerant by design: a format the parser
 * can't read yields no de-dupe entry, and the server's add still runs.
 */
export function parseFeatureNames(stdout: string, repo: string): ExistingFeature[] {
  const names: ExistingFeature[] = [];
  const line = /^\s*\[(?:backlog|building|shipped)\]\s+(.+?)\s+\([^()]+\)\s*$/;
  for (const raw of stdout.split("\n")) {
    const m = line.exec(raw);
    if (!m || m[1] === undefined) continue;
    // Drop a trailing `  @scope` and/or `  (area)` the name capture may have grabbed.
    let name = m[1];
    name = name.replace(/\s+\([^()]*\)\s*$/, ""); // a trailing `(area)`
    const at = name.indexOf("  @");
    if (at >= 0) name = name.slice(0, at);
    name = name.trim();
    if (name) names.push({ repo, name });
  }
  return names;
}

export class CliMemoryClient implements AsyncMemoryClient {
  private readonly run: CliRunner;

  constructor(config: CliMemoryConfig) {
    this.run = config.runner ?? makeSpawnRunner(config.cliBin, config.db);
  }

  /** Build from the environment, or return null when the memory CLI isn't configured. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): CliMemoryClient | null {
    const cfg = cliConfigFromEnv(env);
    return cfg ? new CliMemoryClient(cfg) : null;
  }

  async updateRepoDigest(input: RepoDigestInput): Promise<RepoDigestResult> {
    // `digest set` upserts by repo (a partial set merges; the first set must carry
    // every section — onboarding always supplies all four, so this is safe on both
    // first onboard and re-onboard). `--source` stamps provenance.
    const args = [
      "digest",
      "set",
      input.repo,
      "--overview",
      input.overview,
      "--structure",
      input.structure,
      "--conventions",
      input.conventions,
      "--source",
      input.source,
    ];
    // The memory CLI's first `digest set` requires every section, including stack;
    // fall back to an explicit "unknown" rather than omit it when the scan found none.
    args.push("--stack", input.stack ?? "unknown");

    this.exec("digest set", args);
    // The CLI doesn't report created-vs-updated; "updated" is the upsert's common case.
    return { repo: input.repo, status: "updated" };
  }

  async listFeatures(repo: string): Promise<ExistingFeature[]> {
    const res = this.run(["features", repo]);
    if (res.error) {
      throw new CrewError("MEMORY_UNAVAILABLE", "Memory CLI 'features' failed to spawn.", {
        repo,
        cause: res.error.message,
      });
    }
    // `features` exits 0 with "no features for '<repo>'" when empty — treat any
    // non-zero exit as unavailable so the flush logs + degrades rather than guesses.
    if ((res.status ?? 0) !== 0) {
      throw new CrewError("MEMORY_UNAVAILABLE", "Memory CLI 'features' reported an error.", {
        repo,
        status: res.status,
        detail: res.stderr.trim() || res.stdout.trim(),
      });
    }
    return parseFeatureNames(res.stdout, repo);
  }

  async addFeature(input: FeatureInput): Promise<FeatureResultLocal> {
    // `feature add` takes the repo as a POSITIONAL (no --repo) and no actor flag —
    // the local CLI runs as the trust principal (matches the merge producer).
    const args = [
      "feature",
      "add",
      input.repo,
      "--name",
      input.name,
      "--summary",
      input.summary,
      "--status",
      input.status,
      "--provenance",
      input.provenance,
    ];
    if (input.scopeNode !== undefined && input.scopeNode.trim().length > 0) {
      args.push("--scope-node", input.scopeNode.trim());
    }
    this.exec("feature add", args);
    // The memory CLI inserts a fresh row per add (no server-side repo+name de-dupe),
    // so the caller's `listFeatures` pre-check owns idempotency; report "added".
    return { featureId: "memory-feature", status: "added" };
  }

  // ── Query verbs are out of scope for the write-only onboard bridge ──────────

  async searchLore(_query: LoreSearchQuery): Promise<LoreRecord[]> {
    throw this.unsupported("searchLore");
  }
  async suggestLore(_input: LoreSuggestionInput): Promise<LoreSuggestionResult> {
    throw this.unsupported("suggestLore");
  }
  async listBacklogFeatures(_repo: string, _status: FeatureStatus): Promise<BacklogFeature[]> {
    throw this.unsupported("listBacklogFeatures");
  }
  async advanceFeature(_id: string, _toStatus: FeatureStatus): Promise<AdvanceFeatureResult> {
    throw this.unsupported("advanceFeature");
  }

  async close(): Promise<void> {
    // Nothing to close — every verb is a one-shot spawn.
  }

  /** Run a write verb; a spawn error or non-zero exit becomes MEMORY_UNAVAILABLE. */
  private exec(verb: string, args: readonly string[]): void {
    const res = this.run(args);
    if (res.error) {
      throw new CrewError("MEMORY_UNAVAILABLE", `Memory CLI '${verb}' failed to spawn.`, {
        cause: res.error.message,
      });
    }
    if ((res.status ?? 0) !== 0) {
      throw new CrewError("MEMORY_UNAVAILABLE", `Memory CLI '${verb}' exited non-zero.`, {
        status: res.status,
        detail: res.stderr.trim() || res.stdout.trim(),
      });
    }
  }

  private unsupported(verb: string): CrewError {
    return new CrewError("MEMORY_UNAVAILABLE", `Memory CLI client does not support '${verb}'.`, {
      verb,
    });
  }
}

/** Local alias so the file reads without importing the result type name verbatim. */
type FeatureResultLocal = Awaited<ReturnType<AsyncMemoryClient["addFeature"]>>;
