import { readFileSync, writeFileSync } from "node:fs";

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
  return parseOneOf("--as", value, allowed);
}

/** Validate a flag against its closed list of values, naming them on a refusal. */
export function parseOneOf<T extends string>(
  flag: string,
  value: unknown,
  allowed: readonly T[],
): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new DispatchError(
    "VALIDATION_ERROR",
    `${flag} must be one of: ${allowed.join(", ")} (got '${String(value)}').`,
    { [flag.replace(/^-+/, "")]: value, allowed },
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

/**
 * Read an input file the user named (`epic create`, `spec create`, `import`). A
 * missing file is FILE_NOT_FOUND and any other read failure IO_ERROR, both naming
 * the path, never a raw `ENOENT` stack (exploratory finding cli-wg/F-07).
 */
export function readInputFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new DispatchError("FILE_NOT_FOUND", `File not found: ${path}`, { file: path });
    }
    throw new DispatchError(
      "IO_ERROR",
      `Could not read ${path}: ${code === "EISDIR" ? "it is a directory" : ((err as Error).message ?? String(err))}`,
      { file: path, ...(code ? { errno: code } : {}) },
    );
  }
}

/**
 * Write a file the user named (`export --out`). Any failure (a missing directory, no
 * permission, a read-only disk) is WRITE_FAILED naming the path and the reason.
 */
export function writeOutputFile(path: string, data: string): void {
  try {
    writeFileSync(path, data, { encoding: "utf8" });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const reason =
      code === "ENOENT"
        ? "its directory does not exist"
        : code === "EACCES" || code === "EPERM"
          ? "permission denied"
          : code === "EISDIR"
            ? "it is a directory"
            : code === "EROFS"
              ? "the file system is read-only"
              : code === "ENOSPC"
                ? "no space left on the device"
                : ((err as Error).message ?? String(err));
    throw new DispatchError("WRITE_FAILED", `Could not write ${path}: ${reason}.`, {
      file: path,
      ...(code ? { errno: code } : {}),
    });
  }
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
  const raw = path === undefined || path === "-" ? readStdin() : readInputFile(path);
  try {
    return JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new DispatchError("VALIDATION_ERROR", `Invalid JSON input: ${reason}`);
  }
}
