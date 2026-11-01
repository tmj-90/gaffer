import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** The built CLI (`gaffer wg` execs it with --db). CI builds before it tests. */
export const CLI_BIN = resolve(__dirname, "..", "..", "dist", "cli", "index.js");
export const CLI_BUILT = existsSync(CLI_BIN);

export interface BinResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run the built CLI as a separate process, the way `runner/gaffer wg` does
 * (`node dist/cli/index.js --db <path> …`). `db: null` passes no --db.
 */
export function runBin(
  db: string | null,
  args: string[],
  opts: { env?: Record<string, string | undefined>; cwd?: string; input?: string } = {},
): BinResult {
  const env: Record<string, string | undefined> = { ...process.env, ...opts.env };
  delete env["DISPATCH_DB"];
  if (opts.env && "DISPATCH_DB" in opts.env) env["DISPATCH_DB"] = opts.env["DISPATCH_DB"];
  const r = spawnSync(process.execPath, [CLI_BIN, ...(db === null ? [] : ["--db", db]), ...args], {
    encoding: "utf8",
    env,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.input !== undefined ? { input: opts.input } : {}),
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** The CLI's error contract: stderr is exactly one line of `{ ok:false, code, message, details? }`. */
export function oneLineError(stderr: string): {
  ok: boolean;
  code: string;
  message: string;
  details?: Record<string, unknown>;
} {
  const lines = stderr.split("\n").filter((l) => l.trim() !== "");
  const last = lines[lines.length - 1] ?? "";
  // Warnings (`warning: …`) may precede it; nothing else may.
  const others = lines.slice(0, -1).filter((l) => !l.startsWith("warning: "));
  if (others.length > 0) throw new Error(`stderr is not one JSON error line:\n${stderr}`);
  const parsed = JSON.parse(last) as {
    ok: boolean;
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  return parsed;
}
