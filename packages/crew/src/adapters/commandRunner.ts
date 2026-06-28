import { execFileSync, execSync } from "node:child_process";

export interface CommandResult {
  stdout: string;
  exitCode: number;
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
   * shell, so untrusted values (filenames, paths) cannot inject commands.
   */
  runArgs(file: string, args: readonly string[], cwd: string): CommandResult;
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

  runArgs(file: string, args: readonly string[], cwd: string): CommandResult {
    try {
      // execFileSync does NOT spawn a shell: `file` is exec'd directly and every
      // entry of `args` is a literal argv element. Shell metacharacters in an
      // argument (e.g. a filename `$(touch PWNED).ts`) are inert.
      const stdout = execFileSync(file, [...args], {
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
};

/** Fake runner returning a fixed output, for tests. */
export class FakeCommandRunner implements CommandRunner {
  readonly calls: Array<{ command: string; cwd: string }> = [];
  constructor(private readonly result: CommandResult) {}
  run(command: string, cwd: string): CommandResult {
    this.calls.push({ command, cwd });
    return this.result;
  }
  runArgs(file: string, args: readonly string[], cwd: string): CommandResult {
    // Record the argv as a readable command string so call-site assertions can
    // match it the same way they match `run` (e.g. `startsWith("git log")`).
    this.calls.push({ command: [file, ...args].join(" "), cwd });
    return this.result;
  }
}
