// Preload for a timing test (node --import <this file> <script>): when the process
// exits it writes the CPU time it used itself, in whole milliseconds, to the file named
// by GAFFER_TEST_CPU_OUT. A wall-clock bound on a shared CI runner measures the
// neighbours too; a process's own CPU time does not. It does not count child processes,
// so use it only for work the script does in-process.
import { writeFileSync } from "node:fs";

const out = process.env.GAFFER_TEST_CPU_OUT;
if (out) {
  process.on("exit", () => {
    const u = process.cpuUsage();
    try {
      writeFileSync(out, String(Math.round((u.user + u.system) / 1000)));
    } catch {
      // No report: the test reads a missing file as "unknown" and falls back to the clock.
    }
  });
}
