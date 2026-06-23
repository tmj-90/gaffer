import { createInterface } from "node:readline";

/**
 * Tiny readline wrapper for `memory add` interactive mode. We deliberately
 * don't reach for inquirer — `memory` should be installable with a small
 * dependency footprint that's easy for an enterprise SecEng team to audit.
 */
export async function prompt(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** Multi-line prompt — terminated by a blank line. */
export async function promptMulti(question: string): Promise<string> {
  process.stdout.write(`${question} (end with a blank line)\n`);
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const lines: string[] = [];
  return new Promise((resolve) => {
    rl.on("line", (line) => {
      if (line.trim() === "" && lines.length > 0) {
        rl.close();
        return;
      }
      lines.push(line);
    });
    rl.on("close", () => resolve(lines.join("\n")));
  });
}
