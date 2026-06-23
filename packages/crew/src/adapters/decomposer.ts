/**
 * Brownfield decomposer adapter.
 *
 * Wraps `runner`'s `bin/decompose.mjs --brief "<feature>" --repo <repo>`,
 * which turns a one-line feature brief into a ZERO-bootstrap, repo-targeted epic
 * plan (`{ epic, tickets }`). The contract is deliberately small and async so the
 * idle feature-backlog loop can inject a fake in tests and never spawn a real
 * `claude -p` process.
 *
 * The adapter only PRODUCES a plan; it never files tickets. Filing happens
 * through the Dispatch `create_epic` path so the human gate stays in the layer
 * that owns it.
 */
import { spawn } from "node:child_process";
import { z } from "zod";

import { CrewError } from "../util/errors.js";

/** One ticket in a brownfield epic plan (matches decompose.mjs `phase:"plan"`). */
export interface EpicTicketPlan {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: number;
  /** Brownfield: every ticket's repo is stamped with the target repo. */
  repo: string;
  /** Brownfield plans must contain ZERO bootstrap tickets. */
  bootstrap: boolean;
  dependsOn: number[];
}

/** A brownfield epic plan: the epic header plus its tickets. */
export interface EpicPlan {
  epic: { name: string; description: string };
  tickets: EpicTicketPlan[];
}

export interface DecomposeRequest {
  /** Free-text brief — the feature's name + summary. */
  brief: string;
  /** Target repo the epic lands on (brownfield, repo-stamped). */
  repo: string;
  /** Hard cap on decompose turns. */
  maxTurns?: number;
  /** Hard cap on the number of tickets the plan may contain. */
  maxTickets?: number;
}

/**
 * Produces a brownfield epic plan from a brief + target repo. Injectable so the
 * idle loop is unit-testable without spawning a process. Implementations MUST
 * reject (throw) on any failure so the caller can roll the feature back.
 */
export interface Decomposer {
  decompose(request: DecomposeRequest): Promise<EpicPlan>;
}

const ticketPlanSchema = z
  .object({
    title: z.string(),
    description: z.string().default(""),
    acceptanceCriteria: z.array(z.string()).default([]),
    priority: z.number().int().default(0),
    repo: z.string().optional(),
    bootstrap: z.boolean().default(false),
    dependsOn: z.array(z.number().int()).default([]),
  })
  .passthrough();

const planEnvelopeSchema = z.object({
  phase: z.string(),
  plan: z
    .object({
      epic: z.object({ name: z.string(), description: z.string().default("") }),
      tickets: z.array(ticketPlanSchema),
    })
    .optional(),
  error: z.string().optional(),
  questions: z.array(z.string()).optional(),
});

/**
 * Parse and validate the decompose helper's stdout into an {@link EpicPlan}.
 * Rejects a clarify/error phase, a bootstrap ticket (brownfield must have none),
 * or an over-cap plan. Pure + exported so it is unit-testable in isolation.
 */
export function parseEpicPlan(stdout: string, repo: string, maxTickets?: number): EpicPlan {
  let decoded: unknown;
  try {
    decoded = JSON.parse(stdout);
  } catch (cause) {
    throw new CrewError("DECOMPOSE_FAILED", "Decompose output was not valid JSON.", {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
  const parsed = planEnvelopeSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new CrewError("DECOMPOSE_FAILED", "Decompose output did not match the expected shape.", {
      issues: parsed.error.issues.map((i) => i.message),
    });
  }
  const envelope = parsed.data;
  if (envelope.phase !== "plan" || !envelope.plan) {
    throw new CrewError(
      "DECOMPOSE_FAILED",
      `Decompose returned phase '${envelope.phase}', not a plan.`,
      {
        ...(envelope.error ? { error: envelope.error } : {}),
        ...(envelope.questions ? { questions: envelope.questions } : {}),
      },
    );
  }
  const tickets = envelope.plan.tickets;
  if (tickets.length === 0) {
    throw new CrewError("DECOMPOSE_FAILED", "Decompose returned an empty plan.", {});
  }
  if (tickets.some((t) => t.bootstrap)) {
    throw new CrewError(
      "DECOMPOSE_FAILED",
      "Brownfield plan must not contain a bootstrap ticket.",
      {},
    );
  }
  if (maxTickets !== undefined && tickets.length > maxTickets) {
    throw new CrewError(
      "DECOMPOSE_FAILED",
      `Plan has ${tickets.length} tickets, over the ${maxTickets} cap.`,
      {},
    );
  }
  return {
    epic: envelope.plan.epic,
    // Stamp the target repo on every ticket (brownfield contract) so the epic
    // lands entirely on the existing repo even if the helper omitted it.
    tickets: tickets.map((t) => ({ ...t, repo: t.repo ?? repo })),
  };
}

export interface SpawnDecomposerConfig {
  /** Node executable to run the helper with (default: process.execPath). */
  node?: string;
  /** Absolute path to runner's `bin/decompose.mjs`. */
  scriptPath: string;
  /** Working directory for the spawned process (runner root). */
  cwd?: string;
  /** Hard wall-clock timeout in ms. */
  timeoutMs?: number;
}

/**
 * Real decomposer: spawns `node bin/decompose.mjs --brief … --repo …` and parses
 * its single-JSON-object stdout. A non-zero exit, a timeout, or an unparseable /
 * non-plan result all surface as a structured `DECOMPOSE_FAILED` CrewError
 * so the caller can roll the feature back.
 */
export class SpawnDecomposer implements Decomposer {
  constructor(private readonly config: SpawnDecomposerConfig) {}

  async decompose(request: DecomposeRequest): Promise<EpicPlan> {
    const node = this.config.node ?? process.execPath;
    const args = [this.config.scriptPath, "--brief", request.brief, "--repo", request.repo];
    if (request.maxTurns !== undefined) args.push("--max-turns", String(request.maxTurns));
    if (request.maxTickets !== undefined) args.push("--max-tickets", String(request.maxTickets));

    const stdout = await this.run(node, args);
    return parseEpicPlan(stdout, request.repo, request.maxTickets);
  }

  private run(node: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(node, args, {
        ...(this.config.cwd ? { cwd: this.config.cwd } : {}),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer =
        this.config.timeoutMs !== undefined
          ? setTimeout(() => {
              child.kill("SIGKILL");
              reject(
                new CrewError("DECOMPOSE_FAILED", "Decompose timed out.", {
                  timeoutMs: this.config.timeoutMs,
                }),
              );
            }, this.config.timeoutMs)
          : null;

      child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        reject(
          new CrewError("DECOMPOSE_FAILED", "Failed to spawn the decompose helper.", {
            cause: err.message,
          }),
        );
      });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        if (code === 0) {
          resolve(stdout);
          return;
        }
        reject(
          new CrewError("DECOMPOSE_FAILED", `Decompose exited with code ${code}.`, {
            ...(stderr.trim() ? { stderr: stderr.trim() } : {}),
          }),
        );
      });
    });
  }
}
