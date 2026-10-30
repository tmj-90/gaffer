import { execFileSync, spawnSync } from "node:child_process";

export interface CommandResult {
  stdout: string;
  exitCode: number;
  /** `run` only: the command overran its wall-clock cap and was killed. */
  timedOut?: boolean;
  /** `run` only: output exceeded the byte cap; the command was killed, output cut. */
  truncated?: boolean;
}

/**
 * Bounds for a shell `run` invocation (operator / repo commands such as
 * coverage_command). Every run is bounded: `timeoutMs` defaults to
 * $GAFFER_DOD_TIMEOUT seconds (else 900s) and `maxBuffer` to 32 MiB. On either
 * limit the WHOLE process group is killed (a `pnpm` → `vitest` grandchild
 * cannot outlive the shell) and the result says so, so a caller never parses
 * partial output as a finding.
 */
export interface RunOptions {
  timeoutMs?: number;
  maxBuffer?: number;
}

/** Default wall-clock cap for `run`: $GAFFER_DOD_TIMEOUT seconds, else 900s. */
export function defaultRunTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const secs = Number(env.GAFFER_DOD_TIMEOUT);
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : 900_000;
}

export const DEFAULT_RUN_MAX_BUFFER = 32 * 1024 * 1024;

// Runs `/bin/sh -c <cmd>` in its OWN process group and kills the group on timeout
// or overflow. A tiny node supervisor does it because the sync child_process API
// has no process-group kill: the parent waits on the supervisor synchronously.
const SUPERVISOR = `
const { spawn } = require("node:child_process");
const [cmd, timeoutMs, maxBuffer] = [process.argv[1], Number(process.argv[2]), Number(process.argv[3])];
const child = spawn("/bin/sh", ["-c", cmd], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
const out = [], err = [];
let size = 0, timedOut = false, truncated = false;
const killGroup = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
const take = (bucket) => (b) => {
  if (truncated) return;
  if (size + b.length > maxBuffer) { truncated = true; bucket.push(b.subarray(0, maxBuffer - size)); size = maxBuffer; killGroup(); return; }
  size += b.length; bucket.push(b);
};
child.stdout.on("data", take(out));
child.stderr.on("data", take(err));
const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
child.on("error", (e) => { clearTimeout(timer); process.stdout.write(JSON.stringify({ stdout: "", stderr: String(e && e.message), code: 127, timedOut, truncated })); });
child.on("close", (code) => {
  clearTimeout(timer);
  killGroup();
  process.stdout.write(JSON.stringify({ stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), code: code ?? 1, timedOut, truncated }));
});
`;

/**
 * Bounds for a no-shell `runArgs` invocation. Used by the tool oracles so a scan
 * over a big repo can never run unbounded or buffer without limit:
 *  - `timeoutMs` — wall-clock cap; an overrunning tool is killed and treated as
 *    "no findings"/fallback by the caller (a non-zero exit).
 *  - `maxBuffer`  — stdout/stderr byte cap; exceeding it errors rather than OOMs.
 */
export interface RunArgsOptions {
  timeoutMs?: number;
  maxBuffer?: number;
}

/**
 * Runs a command in a directory and returns its output. Injectable so tests
 * never spawn real processes.
 *
 * Two surfaces:
 *  - {@link run} takes a full shell command string (run via `/bin/sh -c`). Use it
 *    ONLY for trusted, operator-configured commands (coverage / audit commands).
 *    NEVER interpolate attacker-influenced data (filenames, ticket text, repo
 *    contents) into the string — that is a shell-injection sink.
 *  - {@link runArgs} takes an explicit argv with NO shell. Each arg is passed
 *    verbatim to the executable, so a filename like `$(touch PWNED).ts` is just a
 *    string, never code. Use this whenever any argument derives from on-disk or
 *    otherwise untrusted data.
 */
export interface CommandRunner {
  run(command: string, cwd: string, options?: RunOptions): CommandResult;
  /**
   * Run `file` with `args` directly (no shell). Arguments are never re-parsed by a
   * shell, so untrusted values (filenames, paths) cannot inject commands. The
   * optional `options` bound wall-clock time and output size for long-running
   * analysis tools.
   */
  runArgs(
    file: string,
    args: readonly string[],
    cwd: string,
    options?: RunArgsOptions,
  ): CommandResult;
}

export const systemCommandRunner: CommandRunner = {
  run(command: string, cwd: string, options?: RunOptions): CommandResult {
    const timeoutMs = options?.timeoutMs ?? defaultRunTimeoutMs();
    const maxBuffer = options?.maxBuffer ?? DEFAULT_RUN_MAX_BUFFER;
    const res = spawnSync(
      process.execPath,
      ["-e", SUPERVISOR, command, String(timeoutMs), String(maxBuffer)],
      // The supervisor's JSON carries at most maxBuffer bytes of output (plus
      // JSON escaping); a backstop timeout covers a wedged supervisor.
      {
        cwd,
        encoding: "utf8",
        maxBuffer: maxBuffer * 6 + 1024 * 1024,
        timeout: timeoutMs + 30_000,
      },
    );
    let parsed: {
      stdout: string;
      stderr: string;
      code: number;
      timedOut: boolean;
      truncated: boolean;
    };
    try {
      parsed = JSON.parse(res.stdout) as typeof parsed;
    } catch {
      return {
        stdout: res.stderr ?? "",
        exitCode: res.status ?? 1,
        timedOut: res.error !== undefined,
      };
    }
    // Matches the old execSync contract: stdout alone on success, stdout+stderr on failure.
    const failed = parsed.code !== 0 || parsed.timedOut || parsed.truncated;
    return {
      stdout: failed ? `${parsed.stdout}${parsed.stderr}` : parsed.stdout,
      exitCode: parsed.code !== 0 ? parsed.code : failed ? 1 : 0,
      ...(parsed.timedOut ? { timedOut: true } : {}),
      ...(parsed.truncated ? { truncated: true } : {}),
    };
  },

  runArgs(
    file: string,
    args: readonly string[],
    cwd: string,
    options?: RunArgsOptions,
  ): CommandResult {
    try {
      // execFileSync does NOT spawn a shell: `file` is exec'd directly and every
      // entry of `args` is a literal argv element. Shell metacharacters in an
      // argument (e.g. a filename `$(touch PWNED).ts`) are inert.
      const stdout = execFileSync(file, [...args], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
        ...(options?.maxBuffer !== undefined ? { maxBuffer: options.maxBuffer } : {}),
      });
      return { stdout, exitCode: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      return { stdout: `${e.stdout ?? ""}${e.stderr ?? ""}`, exitCode: e.status ?? 1 };
    }
  },
};

/** Fake runner returning a fixed output, for tests. */
export class FakeCommandRunner implements CommandRunner {
  readonly calls: Array<{ command: string; cwd: string; options?: RunArgsOptions }> = [];
  constructor(private readonly result: CommandResult) {}
  run(command: string, cwd: string): CommandResult {
    this.calls.push({ command, cwd });
    return this.result;
  }
  runArgs(
    file: string,
    args: readonly string[],
    cwd: string,
    options?: RunArgsOptions,
  ): CommandResult {
    // Record the argv as a readable command string so call-site assertions can
    // match it the same way they match `run` (e.g. `startsWith("git log")`).
    this.calls.push({
      command: [file, ...args].join(" "),
      cwd,
      ...(options !== undefined ? { options } : {}),
    });
    return this.result;
  }
}

/**
 * A scriptable fake runner for oracle tests: matches each `runArgs`/`run`
 * invocation against an ordered list of predicates and returns the first match's
 * result. Lets one test drive an "eslint available, knip absent" world without
 * spawning processes. A throwing handler simulates `execFileSync` raising
 * (tool-absent ENOENT, or a timeout) — the oracle must catch it.
 */
export class ScriptedCommandRunner implements CommandRunner {
  readonly calls: Array<{ command: string; cwd: string; options?: RunArgsOptions }> = [];
  constructor(
    private readonly handlers: ReadonlyArray<{
      match: (command: string) => boolean;
      result: CommandResult | (() => CommandResult);
    }>,
    private readonly fallback: CommandResult = { stdout: "", exitCode: 0 },
  ) {}

  private dispatch(command: string): CommandResult {
    for (const h of this.handlers) {
      if (h.match(command)) return typeof h.result === "function" ? h.result() : h.result;
    }
    return this.fallback;
  }

  run(command: string, cwd: string): CommandResult {
    this.calls.push({ command, cwd });
    return this.dispatch(command);
  }

  runArgs(
    file: string,
    args: readonly string[],
    cwd: string,
    options?: RunArgsOptions,
  ): CommandResult {
    const command = [file, ...args].join(" ");
    this.calls.push({ command, cwd, ...(options !== undefined ? { options } : {}) });
    return this.dispatch(command);
  }
}
