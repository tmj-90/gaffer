import { readFileSync } from "node:fs";

import { Dispatch } from "../core.js";
import type { Actor } from "../domain/types.js";
import { DispatchError } from "../util/errors.js";
import { resolveDbPath } from "../util/paths.js";

/** The human running the CLI is the actor for events. */
export function cliActor(): Actor {
  return { type: "human", id: process.env.USER ?? "cli" };
}

/** Validate that a claim TTL is a positive integer, throwing a structured error otherwise. */
export function validateTtl(ttl: number): void {
  if (!Number.isInteger(ttl) || ttl <= 0) {
    throw new DispatchError("VALIDATION_ERROR", `--ttl must be a positive integer (got ${ttl}).`, {
      ttl,
    });
  }
}

/** Resolve a `--as <type>` flag to an Actor (BBT-001 tester verdict commands). */
export function testerActor(as: string): Actor {
  switch (as) {
    case "human":
      return { type: "human", id: process.env.USER ?? "cli" };
    case "admin":
      return { type: "admin", id: process.env.USER ?? "cli" };
    case "system":
      return { type: "system" };
    default:
      return { type: "agent", id: "tester" };
  }
}

export function open(opts: { db?: string }): Dispatch {
  return Dispatch.open(resolveDbPath(opts.db));
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Read the whole of stdin as a UTF-8 string (used when no file path is given). */
export function readStdin(): string {
  // fd 0 is stdin; a synchronous full read keeps the command's control flow
  // simple and matches the rest of the CLI (no streaming needed for a plan).
  return readFileSync(0, "utf8");
}

/**
 * Parse a JSON document for `epic create` from either a file path or stdin.
 * `path` is undefined or "-" ⇒ read stdin. Malformed JSON throws a DispatchError
 * so it surfaces on the standard VALIDATION_ERROR path in main().
 */
export function readJsonInput(path: string | undefined): unknown {
  const raw = path === undefined || path === "-" ? readStdin() : readFileSync(path, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new DispatchError("VALIDATION_ERROR", `Invalid JSON input: ${reason}`);
  }
}
