import { Command } from "commander";

import { registerAc } from "../../src/cli/commands/ac.js";
import { registerAgent, registerAgentSystem } from "../../src/cli/commands/agent.js";
import { registerDecisions } from "../../src/cli/commands/decisions.js";
import { registerDiagnostics } from "../../src/cli/commands/diagnostics.js";
import { registerPrincipal } from "../../src/cli/commands/principal.js";
import { registerRepo } from "../../src/cli/commands/repo.js";
import { registerReview } from "../../src/cli/commands/review.js";
import { registerTicket } from "../../src/cli/commands/ticket.js";

/** What one CLI invocation printed, plus the error it threw (if any). */
export interface CliResult {
  /** stdout parsed as JSON (null when nothing was printed). */
  json: unknown;
  stdout: string;
  stderr: string;
  error: unknown;
}

/**
 * Drive the real commander commands in-process against a file-backed DB, the way
 * `gaffer wg` does (`--db <path> …`). stdout and stderr are captured; a thrown
 * error (DispatchError, ZodError) is returned rather than rethrown so a test can
 * assert both the refusal and what was (not) printed.
 */
export function runCli(
  dbPath: string,
  args: string[],
  env: Record<string, string> = {},
): CliResult {
  const program = new Command();
  program.exitOverride().option("--db <path>", "SQLite database path").enablePositionalOptions();
  registerTicket(program);
  registerAc(program);
  registerRepo(program);
  registerDecisions(program);
  registerAgent(program);
  registerReview(program);
  registerAgentSystem(program);
  registerPrincipal(program);
  registerDiagnostics(program);
  const out: string[] = [];
  const err: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  let error: unknown;
  try {
    program.parse(["node", "dispatch", "--db", dbPath, ...args]);
  } catch (e) {
    error = e;
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  const stdout = out.join("");
  let json: unknown;
  try {
    json = stdout ? JSON.parse(stdout) : null;
  } catch {
    json = null;
  }
  return { json, stdout, stderr: err.join(""), error };
}

/** The `code` of a structured error, or undefined. */
export function errorCode(e: unknown): string | undefined {
  if (e && typeof e === "object" && "code" in e) return String((e as { code: unknown }).code);
  return undefined;
}
