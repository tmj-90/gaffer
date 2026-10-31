// Shared harness for the focused safety-hook test files (safety-hook-*.test.mjs).
// Each case hands a Claude Code PreToolUse payload, with an explicit env + cwd, to
// the hook and asserts the exit code (0 = ALLOW, 2 = BLOCK). Zero dependencies,
// like safety-hook.test.mjs.
//
// A case is decided IN-PROCESS by decide() from safety-hook-core.mjs, with the
// complete env and cwd a spawned hook would get, unless it cannot be: the core
// fixes its factory-code paths (FACTORY_CODE_TEXT) from os.homedir() when it
// loads, so a case whose HOME differs from this process's runs the real
// `node safety-hook.mjs` subprocess instead, as does any case passed
// `{ spawn: true }` (the wrapper's contract cases).
import { spawnSync } from "node:child_process";
import { realpathSync, rmSync } from "node:fs";
import { gafferMkdtemp } from "./tmpdir.mjs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decide } from "../../safety-hook-core.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const RUNNER_DIR = resolve(HERE, "..", "..");
export const HOOK = resolve(RUNNER_DIR, "safety-hook.mjs");
// The HOME the core loaded under (it is imported before this module body runs).
const LOAD_HOME = process.env.HOME;

export const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });
export const write = (file) => ({ tool_name: "Write", tool_input: { file_path: file } });
export const read = (file) => ({ tool_name: "Read", tool_input: { file_path: file } });
export const tool = (name, input) => ({ tool_name: name, tool_input: input });

/** A realpath'd scratch dir (macOS /tmp is a symlink; the hook canonicalises). */
export function scratchDir(prefix) {
  return realpathSync(gafferMkdtemp(resolve(tmpdir(), prefix)));
}

/**
 * Decide `payload` (in-process, or by spawning the hook — see the header); return
 * { status, stdout, stderr, spawned }. `env` is merged over this process's env.
 */
export function runHook(payload, { env = {}, cwd = RUNNER_DIR, spawn = false } = {}) {
  const fullEnv = { ...process.env, ...env };
  if (!spawn && fullEnv.HOME === LOAD_HOME) {
    const r = decide(payload, { env: fullEnv, cwd });
    return { status: r.exitCode, stdout: r.stdout, stderr: r.stderr, spawned: false };
  }
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    cwd,
    env: fullEnv,
    encoding: "utf8",
  });
  return {
    status: res.status,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
    spawned: true,
  };
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
