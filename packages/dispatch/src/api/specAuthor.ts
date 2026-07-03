import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Backend for the dashboard's "Author a spec" step in the Plan-a-build panel.
 *
 * A spec is AI-drafted from a one-line brief, human-edited, then frozen. This
 * module is the seam between the dashboard and the runner's `spec-author`
 * helper: it spawns that helper, hands it `{ brief, history, context?, forcePlan? }`
 * on stdin, and returns the single JSON object the helper writes to stdout:
 *
 *   { phase: "clarify", questions: [ ... ] }
 *   { phase: "spec",    spec: { clauses: [ { clause_id, kind, text, rationale? } ] } }
 *   { phase: "error",   error: "..." }
 *
 * It PROPOSES ONLY — nothing is written or frozen here. When the helper returns a
 * `spec`, the dashboard shows the draft clauses for editing and — only on explicit
 * human confirmation — POSTs them to `/specs` (create_spec) and then `/specs/:id/freeze`.
 * That keeps the freeze gate in the layer that owns it, exactly like decompose's
 * plan is a proposal until create_epic.
 *
 * This is a structural clone of {@link ./planBuild.PlanBuildRunner}: same spawn
 * safety (no shell, byte caps, wall-clock timeout, token-stripped child env), and
 * every failure path collapses to a clean `{ phase: "error", error }` envelope so
 * the panel always has a well-formed turn to render.
 */

/** Env var overriding the path to the spec-author helper (tests point this at a stub). */
export const GAFFER_SPEC_AUTHOR_BIN_ENV = "GAFFER_SPEC_AUTHOR_BIN";

/**
 * Default spec-author helper path when the env override is unset.
 *
 * Resolved relative to this compiled module so a clean clone works without any
 * env wiring: from `packages/dispatch/dist/api/` four levels up reaches the
 * monorepo root, where the runner (and its `bin/spec-author.mjs`) lives. This is
 * the same resolution planBuild uses for `decompose.mjs`.
 */
export const DEFAULT_SPEC_AUTHOR_BIN = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "runner",
  "bin",
  "spec-author.mjs",
);

/** Wall-clock cap on a single spec-author turn (each turn is a real `claude -p` cost). */
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
export interface SpecAuthorTurn {
  readonly role: "assistant" | "user";
  readonly questions?: readonly string[] | undefined;
  readonly answer?: string | undefined;
}

/** A single drafted clause — the exact shape dispatch `create_spec` accepts. */
export interface SpecClauseDraft {
  readonly clause_id?: string;
  readonly kind: string;
  readonly text: string;
  readonly rationale?: string;
}

export interface SpecAuthorRequest {
  readonly brief: string;
  readonly history: readonly SpecAuthorTurn[];
  /**
   * Optional free-text grounding (e.g. "existing repo uses Vite + React"). Unlike
   * plan-build's structured `context` object, the spec-author helper treats this
   * as an untrusted grounding string; forwarded verbatim over stdin when present.
   */
  readonly context?: string | undefined;
  /**
   * "Draft the spec now" escape: when true, the author is told to STOP asking
   * clarifying questions and produce the best spec it can from the brief + history
   * so far. Forwarded over stdin as `forcePlan`; the helper then returns a spec
   * (never a clarify). Absent/false leaves the normal clarify flow.
   */
  readonly forcePlan?: boolean | undefined;
}

/** The spec-author helper's JSON result — the three bounded phases it can return. */
export type SpecAuthorResult =
  | { phase: "clarify"; questions: string[] }
  | { phase: "spec"; spec: unknown }
  | { phase: "error"; error: string };

export interface SpecAuthorRunner {
  /** Run one spec-author turn; resolves to the helper's JSON (never rejects). */
  run(input: SpecAuthorRequest): Promise<SpecAuthorResult>;
}

/** Build the clean error envelope every failure path collapses to. */
function errorResult(error: string): SpecAuthorResult {
  return { phase: "error", error };
}

/**
 * Narrow the helper's stdout into a {@link SpecAuthorResult}. Anything that isn't
 * one of the three known phases becomes an `error` envelope so the panel always
 * has a well-formed turn to render.
 */
function parseResult(raw: string): SpecAuthorResult {
  const trimmed = raw.trim();
  if (trimmed === "") return errorResult("The spec-author helper produced no output.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return errorResult("The spec-author helper returned output that is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null) {
    return errorResult("The spec-author helper returned a non-object result.");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.phase === "clarify") {
    const questions = Array.isArray(obj.questions)
      ? obj.questions.filter((q): q is string => typeof q === "string")
      : [];
    return { phase: "clarify", questions };
  }
  if (obj.phase === "spec") {
    return { phase: "spec", spec: obj.spec ?? null };
  }
  if (obj.phase === "error") {
    return errorResult(typeof obj.error === "string" ? obj.error : "Spec authoring failed.");
  }
  return errorResult(`The spec-author helper returned an unknown phase "${String(obj.phase)}".`);
}

/**
 * Default runner: spawns `node <spec-author.mjs>` and streams
 * `{ brief, history, context?, forcePlan? }` to its stdin. The helper path comes
 * from {@link GAFFER_SPEC_AUTHOR_BIN_ENV} (or the in-mono default under
 * `runner/bin/`); request content is NEVER interpolated into the command line —
 * only the fixed binary path is, and the payload travels over stdin — so there is
 * no command-injection surface from the caller.
 */
export function createSpecAuthorRunner(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): SpecAuthorRunner {
  return {
    run(input) {
      const bin = (env[GAFFER_SPEC_AUTHOR_BIN_ENV] ?? "").trim() || DEFAULT_SPEC_AUTHOR_BIN;
      const payload = JSON.stringify({
        brief: input.brief,
        history: input.history,
        // Forward the free-text grounding only when present so a request without
        // context has a byte-for-byte unchanged stdin shape.
        ...(input.context !== undefined ? { context: input.context } : {}),
        // Forward the "draft the spec now" escape only when set, so a normal
        // (clarifying) turn's stdin shape is byte-for-byte unchanged.
        ...(input.forcePlan === true ? { forcePlan: true } : {}),
      });

      return new Promise<SpecAuthorResult>((resolve) => {
        let settled = false;
        const finish = (result: SpecAuthorResult): void => {
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
          finish(errorResult(`Could not start the spec-author helper: ${describe(err)}`));
          return;
        }

        const stdout: Buffer[] = [];
        let stdoutBytes = 0;
        let overflowed = false;
        const stderr: Buffer[] = [];
        let stderrBytes = 0;

        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          finish(errorResult(`The spec-author helper timed out after ${timeoutMs}ms.`));
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
          finish(errorResult(`The spec-author helper failed to run: ${describe(err)}`));
        });

        child.on("close", (code) => {
          clearTimeout(timer);
          if (overflowed) {
            finish(errorResult("The spec-author helper produced too much output."));
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
                ? `The spec-author helper failed (exit ${code ?? "?"}): ${errText}`
                : `The spec-author helper exited ${code ?? "?"} with no output.`,
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
