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

/**
 * Validate a `--as <type>` flag against the types a command accepts. A typo must
 * never silently pick a DIFFERENT actor type: `--as agnet` used to record a HUMAN
 * approval (autonomy ground truth) and an unknown tester `--as` became agent:tester.
 * Call it before open() so a bad value never opens the DB or writes an event.
 */
export function parseAs<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new DispatchError(
    "VALIDATION_ERROR",
    `--as must be one of: ${allowed.join(", ")} (got '${String(value)}').`,
    { as: value, allowed },
  );
}

/** Resolve a `--as <type>` flag to an Actor (BBT-001 tester verdict commands). */
export function testerActor(as: string): Actor {
  switch (parseAs(as, ["agent", "human", "admin", "system"] as const)) {
    case "human":
      return { type: "human", id: process.env.USER ?? "cli" };
    case "admin":
      return { type: "admin", id: process.env.USER ?? "cli" };
    case "system":
      return { type: "system" };
    case "agent":
      return { type: "agent", id: "tester" };
  }
}

export function open(opts: { db?: string }): Dispatch {
  return Dispatch.open(resolveDbPath(opts.db), undefined, undefined, {
    requireRegisteredAgentApprover: true,
  });
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
