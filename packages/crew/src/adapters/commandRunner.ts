import { execFileSync, execSync } from "node:child_process";

export interface CommandResult {
  stdout: string;
  exitCode: number;
}

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
  run(command: string, cwd: string): CommandResult;
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
  run(command: string, cwd: string): CommandResult {
    try {
      const stdout = execSync(command, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { stdout, exitCode: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      return { stdout: `${e.stdout ?? ""}${e.stderr ?? ""}`, exitCode: e.status ?? 1 };
    }
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
