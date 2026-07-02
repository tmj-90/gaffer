import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Backend for the dashboard's "Plan a build" chat panel.
 *
 * The panel turns a one-line app brief into a phased, dependency-ordered epic
 * of tickets — but it PROPOSES ONLY. This module spawns the runner's
 * `decompose` helper, hands it `{ brief, history }` on stdin, and returns the
 * single JSON object the helper writes to stdout:
 *
 *   { phase: "clarify", questions: [ ... ] }
 *   { phase: "plan",    plan: { epic, tickets } }
 *   { phase: "error",   error: "..." }
 *
 * Nothing is created here. When the helper returns a `plan`, the dashboard shows
 * it for review and — only on explicit human confirmation — POSTs it to
 * `/epics` (create_epic), where the tickets land as draft. That keeps the
 * "nothing runs until a human says so" guardrail in the layer that owns it.
 *
 * Bounding: a spawn/parse failure or timeout never leaks an unstructured error
 * to the panel — every failure path becomes a clean `{ phase: "error", error }`
 * envelope so the chat can render it like any other turn.
 */

/** Env var overriding the path to the decompose helper (tests point this at a stub). */
export const GAFFER_DECOMPOSE_BIN_ENV = "GAFFER_DECOMPOSE_BIN";

/**
 * Default decompose helper path when the env override is unset.
 *
 * Resolved relative to this compiled module so a clean clone works without any
 * env wiring: from `packages/dispatch/dist/api/` four levels up reaches the
 * monorepo root, where the runner (and its `bin/decompose.mjs`) lives.
 */
export const DEFAULT_DECOMPOSE_BIN = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "runner",
  "bin",
  "decompose.mjs",
);

/** Wall-clock cap on a single decompose turn (each turn is a real `claude -p` cost). */
const DEFAULT_TIMEOUT_MS = 200_000;

/** Cap the helper's stdout so a runaway child can't exhaust memory. */
const MAX_OUTPUT_BYTES = 2_000_000;

/** Cap captured stderr — error text only ever needs a little; this bounds memory. */
const MAX_STDERR_BYTES = 16_000;

/**
 * The child runs an external `claude -p`, so it needs PATH/HOME/credentials, but
 * NOT Dispatch's own secrets. Strip the API bearer token from the child env as
 * defence-in-depth so a misbehaving helper can never echo it back.
 */
function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { DISPATCH_API_TOKEN: _omitToken, ...rest } = env;
  void _omitToken;
  return rest;
}

/** One conversation turn the frontend accumulates and replays each request. */
export interface PlanBuildTurn {
  readonly role: "assistant" | "user";
  readonly questions?: readonly string[] | undefined;
  readonly answer?: string | undefined;
}

/**
 * Extend-existing context: when the panel starts in "Extend existing" mode it
 * names the scope node / epic to extend so the decomposer proposes tickets that
 * EXTEND it rather than rebuild from scratch. Absent for a greenfield "New app".
 */
export interface PlanBuildContext {
  readonly mode: "new" | "extend";
  readonly scopeNodeId?: string | undefined;
  readonly scopeNodeName?: string | undefined;
  readonly scopeNodeType?: string | undefined;
  /**
   * Brownfield target repo NAME. On "extend" the panel resolves the target repo
   * from the chosen scope node and passes it so the decomposer takes the
   * existing-repo path. Forwarded verbatim over stdin; absent for greenfield.
   */
  readonly repo?: string | undefined;
}

/**
 * Spec-Driven Development (Phase 2a): one clause of a FROZEN spec forwarded to the
 * decomposer. The `clause_id` is the stable provenance id threaded down to
 * acceptance criteria; `text`/`rationale` are untrusted and ride the decomposer's
 * `<untrusted-spec>` quarantine.
 */
export interface PlanBuildSpecClause {
  readonly clause_id: string;
  readonly kind: "requirement" | "non-goal" | "decision";
  readonly text: string;
  readonly rationale?: string | undefined;
}

export interface PlanBuildRequest {
  readonly brief: string;
  readonly history: readonly PlanBuildTurn[];
  /** Optional extend-existing target forwarded to the decomposer as context. */
  readonly context?: PlanBuildContext | undefined;
  /**
   * Spec-Driven Development (Phase 2a): the frozen spec's clauses. When present the
   * decomposer renders them in a quarantined `<untrusted-spec>` block, defaults to
   * force-plan, and threads clause ids onto the acceptance criteria it generates.
   */
  readonly spec?: readonly PlanBuildSpecClause[] | undefined;
  /**
   * "Build the tickets now" escape: when true, the decomposer is told to STOP
   * asking clarifying questions and produce the best phased plan it can from the
   * brief + history so far. Forwarded over stdin as `forcePlan`; the helper then
   * returns a plan (never a clarify). Absent/false leaves the normal clarify flow.
   */
  readonly forcePlan?: boolean | undefined;
}

/** The decompose helper's JSON result — the three bounded phases it can return. */
export type PlanBuildResult =
  | { phase: "clarify"; questions: string[] }
  | { phase: "plan"; plan: unknown }
  | { phase: "error"; error: string };

export interface PlanBuildRunner {
  /** Run one decompose turn; resolves to the helper's JSON (never rejects). */
  run(input: PlanBuildRequest): Promise<PlanBuildResult>;
}

/** Build the clean error envelope every failure path collapses to. */
function errorResult(error: string): PlanBuildResult {
  return { phase: "error", error };
}

/**
 * Narrow the helper's stdout into a {@link PlanBuildResult}. Anything that
 * isn't one of the three known phases becomes an `error` envelope so the panel
 * always has a well-formed turn to render.
 */
function parseResult(raw: string): PlanBuildResult {
  const trimmed = raw.trim();
  if (trimmed === "") return errorResult("The decompose helper produced no output.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return errorResult("The decompose helper returned output that is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null) {
    return errorResult("The decompose helper returned a non-object result.");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.phase === "clarify") {
    const questions = Array.isArray(obj.questions)
      ? obj.questions.filter((q): q is string => typeof q === "string")
      : [];
    return { phase: "clarify", questions };
  }
  if (obj.phase === "plan") {
    return { phase: "plan", plan: obj.plan ?? null };
  }
  if (obj.phase === "error") {
    return errorResult(typeof obj.error === "string" ? obj.error : "Decompose failed.");
  }
  return errorResult(`The decompose helper returned an unknown phase "${String(obj.phase)}".`);
}

/**
 * Default runner: spawns `node <decompose.mjs>` and streams `{ brief, history }`
 * to its stdin. The helper path comes from {@link GAFFER_DECOMPOSE_BIN_ENV} (or
 * the in-mono default under `runner/bin/`); request content is NEVER interpolated
 * into the command line — only the fixed binary path is, and the payload travels
 * over stdin — so there is no command-injection surface from the caller.
 */
export function createPlanBuildRunner(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): PlanBuildRunner {
  return {
    run(input) {
      const bin = (env[GAFFER_DECOMPOSE_BIN_ENV] ?? "").trim() || DEFAULT_DECOMPOSE_BIN;
      const payload = JSON.stringify({
        brief: input.brief,
        history: input.history,
        // Forward the extend-existing target only when present so a greenfield
        // request's stdin shape is byte-for-byte unchanged.
        ...(input.context !== undefined ? { context: input.context } : {}),
        // Forward the "build the tickets now" escape only when set, so a normal
        // (clarifying) turn's stdin shape is byte-for-byte unchanged.
        ...(input.forcePlan === true ? { forcePlan: true } : {}),
        // Spec-Driven Development (Phase 2a): forward the frozen spec's clauses only
        // when present so a non-spec-driven request's stdin shape is unchanged. The
        // decomposer quarantines the clause text and threads clause ids onto the ACs.
        ...(input.spec !== undefined ? { spec: input.spec } : {}),
      });

      return new Promise<PlanBuildResult>((resolve) => {
        let settled = false;
        const finish = (result: PlanBuildResult): void => {
          if (settled) return;
          settled = true;
          resolve(result);
        };

        let child;
        try {
          // No shell: argv is [binPath], so nothing from the request reaches a
          // shell. The brief + history go in over stdin below. The child env has
          // Dispatch's bearer token stripped.
          child = spawn(process.execPath, [bin], {
            stdio: ["pipe", "pipe", "pipe"],
            env: childEnv(env),
          });
        } catch (err) {
          finish(errorResult(`Could not start the decompose helper: ${describe(err)}`));
          return;
        }

        const stdout: Buffer[] = [];
        let stdoutBytes = 0;
        let overflowed = false;
        const stderr: Buffer[] = [];
        let stderrBytes = 0;

        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          finish(errorResult(`The decompose helper timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
        timer.unref?.();

        child.stdout?.on("data", (chunk: Buffer) => {
          stdoutBytes += chunk.length;
          if (stdoutBytes > MAX_OUTPUT_BYTES) {
            overflowed = true;
            clearTimeout(timer);
            child.kill("SIGKILL");
            return;
          }
          stdout.push(chunk);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          // Bound captured stderr — it only ever needs to carry a short reason.
          if (stderrBytes >= MAX_STDERR_BYTES) return;
          stderrBytes += chunk.length;
          stderr.push(chunk);
        });

        child.on("error", (err) => {
          clearTimeout(timer);
          finish(errorResult(`The decompose helper failed to run: ${describe(err)}`));
        });

        child.on("close", (code) => {
          clearTimeout(timer);
          if (overflowed) {
            finish(errorResult("The decompose helper produced too much output."));
            return;
          }
          const out = Buffer.concat(stdout).toString("utf8");
          // The helper emits valid JSON on a usable result even when it exits
          // non-zero (its `error` phase exits 1), so try to parse stdout first.
          if (out.trim() !== "") {
            finish(parseResult(out));
            return;
          }
          const errText = Buffer.concat(stderr).toString("utf8").trim();
          finish(
            errorResult(
              errText !== ""
                ? `The decompose helper failed (exit ${code ?? "?"}): ${errText}`
                : `The decompose helper exited ${code ?? "?"} with no output.`,
            ),
          );
        });

        child.stdin?.on("error", () => {
          // A broken pipe (child died before reading stdin) surfaces via `close`.
        });
        child.stdin?.end(payload);
      });
    },
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
