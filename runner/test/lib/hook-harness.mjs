// Shared harness for the focused safety-hook test files (safety-hook-*.test.mjs).
// Each case pipes a Claude Code PreToolUse payload through a real
// `node safety-hook.mjs` subprocess with an explicit env + cwd and asserts the
// exit code (0 = ALLOW, 2 = BLOCK). Zero dependencies, like safety-hook.test.mjs.
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const RUNNER_DIR = resolve(HERE, "..", "..");
export const HOOK = resolve(RUNNER_DIR, "safety-hook.mjs");

export const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });
export const write = (file) => ({ tool_name: "Write", tool_input: { file_path: file } });
export const read = (file) => ({ tool_name: "Read", tool_input: { file_path: file } });
export const tool = (name, input) => ({ tool_name: name, tool_input: input });

/** A realpath'd scratch dir (macOS /tmp is a symlink; the hook canonicalises). */
export function scratchDir(prefix) {
  return realpathSync(mkdtempSync(resolve(tmpdir(), prefix)));
}

/** Run the hook; return { status, stdout, stderr }. */
export function runHook(payload, { env = {}, cwd = RUNNER_DIR } = {}) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { status: res.status, stdout: res.stdout || "", stderr: res.stderr || "" };
}

/** A tiny pass/fail recorder; `done()` prints the summary and sets the exit code. */
export function suite(name) {
  let passed = 0;
  const failures = [];
  const cleanups = [];
  const check = (label, payload, opts, expect) => {
    const { status, stderr } = runHook(payload, opts);
    const want = expect === "deny" ? 2 : 0;
    if (status === want) passed += 1;
    else
      failures.push(
        `${expect.toUpperCase()} expected but got exit ${status}: ${label}${stderr ? ` — ${stderr.trim().slice(0, 200)}` : ""}`,
      );
  };
  return {
    deny: (label, payload, opts = {}) => check(label, payload, opts, "deny"),
    allow: (label, payload, opts = {}) => check(label, payload, opts, "allow"),
    assert: (label, ok) => (ok ? (passed += 1) : failures.push(label)),
    cleanup: (dir) => cleanups.push(dir),
    done() {
      for (const d of cleanups) rmSync(d, { recursive: true, force: true });
      if (failures.length) {
        console.error(`FAIL ${name} — ${failures.length} failed, ${passed} passed`);
        for (const f of failures) console.error("  ✗ " + f);
        process.exit(1);
      }
      console.log(`PASS ${name} — ${passed} checks passed`);
    },
  };
}
