/**
 * Spec-clause → Memory lore seeder (Spec-Driven Development, Phase 2b).
 *
 * When a spec is FROZEN, each of its clauses is durable product intent — a
 * requirement the system must serve, a non-goal it deliberately won't, or a
 * settled decision. This seeder pushes each clause into the MEMORY product as a
 * gated draft lore record of the clause's kind, carrying structured provenance
 * (`spec_id` + `clause_id`). The EXISTING product-context primer
 * (`gaffer_product_context_block()` → `memory search --kind
 * decision,requirement,non-goal`) then surfaces the approved records to delivery
 * agents with ZERO primer changes — that is the payoff.
 *
 * COMPONENT BOUNDARY: Memory is a standalone product and Dispatch must never
 * write Memory's DB directly. Seeding therefore goes through Memory's own CLI
 * (`memory suggest` / `memory add`), spawned exactly like the crew onboard
 * bridge ({@link file://../../crew/src/memory/cliClient.ts}) and the runner's
 * `gaffer_distill_ticket_intent` close-time capture — a one-shot child process
 * per clause, DB via the `MEMORY_DB` env var (the CLI's contract), no flag.
 *
 * BEST-EFFORT: seeding is NON-FATAL to the freeze. A Memory hiccup (CLI absent,
 * spawn failure, non-zero exit) must never roll back or block the freeze — the
 * spec is already frozen and immutable by the time we seed. Every failure is
 * logged and swallowed.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

import { type Spec, type SpecClause } from "../domain/types.js";

/** Env var naming the Memory CLI executable (a Node script run via `node <bin>`). */
export const MEMORY_CLI_BIN_ENV = "MEMORY_CLI_BIN";
/** Env var naming the Memory sqlite the CLI writes to (the CLI's bin contract). */
export const MEMORY_DB_ENV = "MEMORY_DB";
/** Operator opt-in: when "1", seeded clauses land `active` immediately (else gated drafts). */
export const MEMORY_AUTO_APPROVE_ENV = "MEMORY_AUTO_APPROVE";

/** Memory caps titles at 200 chars and summaries at 800; stay comfortably under. */
const MAX_TITLE = 190;
const MAX_SUMMARY = 780;

/** Seeds a frozen spec's clauses into Memory. Implementations MUST NOT throw. */
export interface SpecClauseSeeder {
  /** Seed every clause of a just-frozen spec. Best-effort; never throws. */
  seedFrozenSpec(spec: Spec, clauses: readonly SpecClause[]): void;
}

/** No-op seeder — used when the Memory CLI is not configured (e.g. tests, offline). */
export class NullSpecClauseSeeder implements SpecClauseSeeder {
  seedFrozenSpec(_spec: Spec, _clauses: readonly SpecClause[]): void {
    // Intentionally nothing — Memory isn't wired, so there's nowhere to seed.
  }
}

/** Result of one Memory CLI invocation (the subset {@link CliRunner} returns). */
export interface CliRunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error | undefined;
}

/**
 * Runs the Memory CLI with the given args. Injected so tests drive the exact
 * command shape without a real CLI on disk. The default spawns
 * `node <bin> <...args>` with `MEMORY_DB` in the child env.
 */
export type CliRunner = (args: readonly string[]) => CliRunResult;

/** Minimal logger — best-effort seeding logs failures without a logging dep. */
export type SeedLogger = (message: string) => void;

export interface CliSpecClauseSeederConfig {
  /** Absolute path to the Memory CLI bin (`MEMORY_CLI_BIN`). */
  readonly cliBin: string;
  /** Memory sqlite path forwarded to the child as `MEMORY_DB`. */
  readonly db: string;
  /** When true, seed via `memory add` (active); else `memory suggest` (draft). */
  readonly autoApprove: boolean;
  /** Override the spawn (tests). Defaults to a real `spawnSync(node, ...)`. */
  readonly runner?: CliRunner;
  /** Where to report a best-effort failure. Defaults to `console.warn`. */
  readonly log?: SeedLogger;
}

/**
 * Truncate to a byte-safe max length with an ellipsis. Clause text is UNTRUSTED
 * (it may carry a prompt-injection payload); it is passed to the CLI as a
 * discrete argv element (no shell), so it cannot break out of the argument, and
 * Memory stores it as inert lore that the primer QUARANTINES before it ever
 * reaches an agent.
 */
function clamp(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : t.slice(0, max - 1) + "…";
}

const KIND_LABEL: Record<SpecClause["kind"], string> = {
  requirement: "Requirement",
  "non-goal": "Non-goal",
  decision: "Decision",
};

/**
 * Build the Memory CLI argv that seeds ONE clause. Exported for unit tests so the
 * exact command shape (verb, kind, provenance flags) is asserted without a spawn.
 */
export function buildSeedArgs(spec: Spec, clause: SpecClause, verb: "suggest" | "add"): string[] {
  const label = KIND_LABEL[clause.kind];
  const title = clamp(`${label} — ${spec.title}: ${clause.text}`, MAX_TITLE);
  const summaryParts = [clause.text];
  if (clause.rationale) summaryParts.push(`Rationale: ${clause.rationale}`);
  const summary = clamp(summaryParts.join(" "), MAX_SUMMARY);
  const body = clamp(
    `Frozen spec clause (${clause.kind}) from spec "${spec.title}" [${spec.id}], ` +
      `clause ${clause.clause_id}. Seeded at freeze for delivery-time product context.\n\n` +
      clause.text +
      (clause.rationale ? `\n\nRationale: ${clause.rationale}` : ""),
    MAX_SUMMARY,
  );

  const args = [
    verb,
    "--title",
    title,
    "--summary",
    summary,
    "--body",
    body,
    "--kind",
    clause.kind,
    "--tag",
    "spec-clause",
    "--tag",
    `spec-${spec.id}`,
    "--spec-id",
    spec.id,
    "--clause-id",
    clause.clause_id,
  ];
  // Scope the record to the spec's target repo when known, so the primer's
  // per-repo `search --repo <name>` surfaces it to that repo's delivery agents.
  if (spec.target_repo && spec.target_repo.trim().length > 0) {
    args.push("--repo", spec.target_repo.trim());
  }
  return args;
}

/**
 * Seeds spec clauses by spawning the Memory CLI once per clause. One process per
 * clause keeps each seed independent — a failure on clause N never abandons the
 * rest — and matches the one-shot-spawn contract of the onboard bridge.
 */
export class CliSpecClauseSeeder implements SpecClauseSeeder {
  private readonly run: CliRunner;
  private readonly autoApprove: boolean;
  private readonly log: SeedLogger;

  constructor(config: CliSpecClauseSeederConfig) {
    this.run = config.runner ?? makeSpawnRunner(config.cliBin, config.db);
    this.autoApprove = config.autoApprove;
    this.log = config.log ?? ((m) => console.warn(m));
  }

  /**
   * Build from the environment, or return null when the Memory CLI isn't
   * configured (no `MEMORY_CLI_BIN` / `MEMORY_DB`) — the caller then falls back
   * to a {@link NullSpecClauseSeeder}.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): CliSpecClauseSeeder | null {
    const cliBin = env[MEMORY_CLI_BIN_ENV]?.trim();
    const db = env[MEMORY_DB_ENV]?.trim();
    if (!cliBin || !db) return null;
    return new CliSpecClauseSeeder({
      cliBin,
      db,
      autoApprove: env[MEMORY_AUTO_APPROVE_ENV] === "1",
    });
  }

  seedFrozenSpec(spec: Spec, clauses: readonly SpecClause[]): void {
    const verb: "suggest" | "add" = this.autoApprove ? "add" : "suggest";
    for (const clause of clauses) {
      try {
        const res = this.run(buildSeedArgs(spec, clause, verb));
        if (res.error) {
          this.log(
            `spec-clause-seed: spawn failed for clause ${clause.clause_id} of spec ${spec.id} ` +
              `(non-fatal): ${res.error.message}`,
          );
          continue;
        }
        if ((res.status ?? 0) !== 0) {
          this.log(
            `spec-clause-seed: Memory CLI '${verb}' exited ${res.status} for clause ` +
              `${clause.clause_id} of spec ${spec.id} (non-fatal): ` +
              (res.stderr.trim() || res.stdout.trim()),
          );
        }
      } catch (err) {
        // Defence in depth: the seam must never throw into the freeze path.
        const msg = err instanceof Error ? err.message : String(err);
        this.log(
          `spec-clause-seed: unexpected error seeding clause ${clause.clause_id} of spec ` +
            `${spec.id} (non-fatal): ${msg}`,
        );
      }
    }
  }
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
 * Resolve the seeder to wire into {@link SpecsService}: a live CLI seeder when
 * Memory is configured in the environment, else a no-op. Keeps the env-read out
 * of the service so freeze stays testable with an injected stub.
 */
export function resolveSpecClauseSeeder(env: NodeJS.ProcessEnv = process.env): SpecClauseSeeder {
  return CliSpecClauseSeeder.fromEnv(env) ?? new NullSpecClauseSeeder();
}
