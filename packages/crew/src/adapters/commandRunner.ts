import { execSync } from "node:child_process";

export interface CommandResult {
  stdout: string;
  exitCode: number;
}

/**
 * Runs a shell command in a directory and returns its output. Used by the idle
 * coverage loop. Injectable so tests never spawn real processes.
 */
export interface CommandRunner {
  run(command: string, cwd: string): CommandResult;
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
};

/** Fake runner returning a fixed output, for tests. */
export class FakeCommandRunner implements CommandRunner {
  readonly calls: Array<{ command: string; cwd: string }> = [];
  constructor(private readonly result: CommandResult) {}
  run(command: string, cwd: string): CommandResult {
    this.calls.push({ command, cwd });
    return this.result;
  }
}
