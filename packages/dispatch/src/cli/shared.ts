import { readFileSync } from "node:fs";

import { Dispatch } from "../core.js";
import type { Actor } from "../domain/types.js";
import { DispatchError } from "../util/errors.js";
import { assertCliDbExists, resolveDbPath } from "../util/paths.js";

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

/**
 * `--as human|system` for a command a person and the runner both run (exploratory
 * finding cli-wg/F-05). The default stays the person ($USER); the runner passes
 * `--as system` so its bookkeeping (repo-delivery record, the tokenless-resume move,
 * the bootstrap repo link, its own agent registration) is not recorded as a human's.
 */
export const AS_HUMAN_OR_SYSTEM_HELP =
  "actor type: human (default, $USER) or system (the runner's own bookkeeping)";

export function humanOrSystemActor(as: unknown): Actor {
  return parseAs(as, ["human", "system"] as const) === "system" ? { type: "system" } : cliActor();
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

/**
 * Open the CLI's database. Only `init` passes `create: true`; every other command
 * refuses to conjure an empty `./.dispatch/dispatch.sqlite` (see assertCliDbExists).
 */
export function open(
  opts: { db?: string },
  { create = false }: { create?: boolean } = {},
): Dispatch {
  if (!create) assertCliDbExists(opts.db);
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

/**
 * REVOCATION-SAFE LANDING (external review #8): a revocation acknowledged after a landing
 * had started cannot undo it. Say so on stderr, naming each landing, so the operator who
 * cancelled (or the CI hook that failed) knows a default branch already moved.
 */
export function warnLandedAlready(
  landed: ReadonlyArray<{ repo: string; commit: string; landed: boolean }>,
  what: string,
): void {
  if (landed.length === 0) return;
  const list = landed
    .map(
      (l) => `${l.repo} ${l.commit.slice(0, 12)} (${l.landed ? "landed" : "landing in progress"})`,
    )
    .join(", ");
  process.stderr.write(
    `WARNING: a landing had already started before this ${what} was recorded: ${list}. ` +
      `The ${what} stops every landing that had not started; it does not undo these — revert them by hand if needed.\n`,
  );
}
