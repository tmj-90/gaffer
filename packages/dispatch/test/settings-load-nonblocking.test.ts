/**
 * External review 21, item 3: the nightly's Settings response-time failures on macOS.
 *
 * GET /api/settings waited up to 1.5 s for the isolation probe and THEN read the runner's
 * config with two spawnSync calls (bash config-records.sh, node config-show.mjs): the
 * load was the probe wait PLUS the config read (about 0.4 s here, about 1 s on a macOS
 * runner with bash 3.2), and the read blocked the dashboard's event loop while it ran,
 * so every other request (the health poll, the live stream) waited behind it.
 *
 * Pinned here:
 *  1. a config read slowed to macOS speed (a `bash` on PATH that sleeps before the
 *     config printer) beside a probe that takes 3 s: the load stays under the 2,500 ms
 *     the isolation test allows, and GET /api/health, asked from other processes while
 *     the read runs, answers promptly;
 *  2. a slow config read (a stub that sleeps) does not add to the probe wait;
 *  3. a hung config is bounded: the load answers, saying the config could not be read;
 *  4. at most one read runs at a time for one file and environment;
 *  5. the per-request refresh still never lets a request run on values older than the
 *     file: a request that arrives while an apply is running waits for it.
 */
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { GAFFER_SANDBOX_STATUS_CMD_ENV, resetIsolationStatus } from "../src/api/isolation.js";
import {
  clearRunnerConfigCache,
  readRunnerConfigAsync,
  RUNNER_DIR,
  setRunnerConfigCommandsForTest,
} from "../src/api/runnerConfig.js";
import { createApiServer } from "../src/api/server.js";
import {
  applySettingsToEnv,
  refreshSettingsEnvAsync,
  resetDerivedSettings,
} from "../src/api/settings.js";

const RECORDS_SH = join(RUNNER_DIR, "lib", "config-records.sh");
const SHOW_MJS = join(RUNNER_DIR, "bin", "config-show.mjs");
const TOUCHED = [
  "PATH",
  "GAFFER_DATA",
  GAFFER_SANDBOX_STATUS_CMD_ENV,
  "GAFFER_MODE",
  "AUTO_MERGE",
  "DISPATCH_ALLOW_AGENT_APPROVE",
];

let dir = "";
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "r21-settings-load-"));
  for (const k of TOUCHED) saved[k] = process.env[k];
  process.env.GAFFER_DATA = dir;
  resetIsolationStatus();
  clearRunnerConfigCache();
  setRunnerConfigCommandsForTest(null);
});
afterEach(() => {
  setRunnerConfigCommandsForTest(null);
  clearRunnerConfigCache();
  resetIsolationStatus();
  resetDerivedSettings(process.env);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

function script(name: string, body: string): string {
  const f = join(dir, name);
  writeFileSync(f, `#!/bin/sh\n${body}\n`);
  chmodSync(f, 0o755);
  return f;
}

/** A probe that answers after `secs` seconds. */
function slowProbe(secs: number): void {
  const f = script("probe.sh", `sleep ${secs}\necho '{"provider":"docker","available":true}'`);
  process.env[GAFFER_SANDBOX_STATUS_CMD_ENV] = JSON.stringify([f]);
}

async function serve(): Promise<{ base: string; close: () => Promise<void> }> {
  const wg = Dispatch.open(":memory:");
  const server = createApiServer(wg);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((r) =>
        server.close(() => {
          wg.db.close();
          r();
        }),
      ),
  };
}

/**
 * GET `url` from ANOTHER process after `delayMs`, timed there: a blocked event loop in
 * this process shows in the number (a fetch from this process would wait with it).
 */
function timedGetElsewhere(url: string, delayMs: number): Promise<number> {
  const code = `setTimeout(async () => { const t = performance.now(); await (await fetch(${JSON.stringify(
    url,
  )})).text(); console.log(Math.round(performance.now() - t)); }, ${delayMs});`;
  return new Promise((resolve) => {
    execFile(process.execPath, ["-e", code], (_e, out) => resolve(Number(String(out).trim())));
  });
}

describe("GET /api/settings reads the runner's config without blocking", () => {
  it("a config read at macOS speed beside a 3 s probe: under 2,500 ms, and other requests answer meanwhile", async () => {
    // A `bash` first on PATH that takes one more second for the config printer only
    // (what the read costs on a macOS runner with bash 3.2); everything else is bash.
    const realBash = await new Promise<string>((r) =>
      execFile("sh", ["-c", "command -v bash"], (_e, out) => r(String(out).trim())),
    );
    const shim = join(dir, "shim");
    script("shim-bash", `case "$1" in *config-records.sh) sleep 1 ;; esac\nexec ${realBash} "$@"`);
    await new Promise((r) => execFile("mkdir", ["-p", shim], r));
    await new Promise((r) => execFile("mv", [join(dir, "shim-bash"), join(shim, "bash")], r));
    process.env.PATH = `${shim}${delimiter}${process.env.PATH ?? ""}`;
    slowProbe(3);
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ GAFFER_EFFORT: "large" }));
    const s = await serve();
    try {
      // Health asked from other processes all through the load (the old code read the
      // config from about 1.5 s on, blocking this process for its whole length).
      const health = Promise.all(
        [200, 700, 1_200, 1_700, 2_200].map((d) => timedGetElsewhere(`${s.base}/api/health`, d)),
      );
      const t0 = Date.now();
      const res = await fetch(`${s.base}/api/settings`);
      const elapsed = Date.now() - t0;
      expect(res.status).toBe(200);
      const body = (await res.json()) as { configError?: string; derived: unknown[] };
      expect(body.configError).toBeUndefined();
      expect(body.derived.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(2_500);
      const times = await health;
      expect(Math.max(...times)).toBeLessThan(500);
    } finally {
      await s.close();
    }
  }, 30_000);

  it("a slow config read does not add to the probe wait (they run together)", async () => {
    setRunnerConfigCommandsForTest({
      records: ["sh", "-c", `sleep 1.2; exec bash "${RECORDS_SH}"`],
      show: [process.execPath, SHOW_MJS, "--all", "--json"],
    });
    slowProbe(3);
    const s = await serve();
    try {
      const t0 = Date.now();
      const res = await fetch(`${s.base}/api/settings`);
      const elapsed = Date.now() - t0;
      const body = (await res.json()) as { configError?: string };
      expect(body.configError).toBeUndefined();
      // The probe wait (1.5 s) and the read (1.2 s + the real read) overlap: well under
      // their sum (about 3 s).
      expect(elapsed).toBeLessThan(2_400);
      expect(elapsed).toBeGreaterThanOrEqual(1_200);
    } finally {
      await s.close();
    }
  }, 30_000);

  it("a hung config is bounded: the load answers and says the config could not be read", async () => {
    setRunnerConfigCommandsForTest({
      records: ["sh", "-c", "sleep 30"],
      show: [process.execPath, SHOW_MJS, "--all", "--json"],
      timeoutMs: 1_000,
    });
    slowProbe(0);
    const s = await serve();
    try {
      const t0 = Date.now();
      const res = await fetch(`${s.base}/api/settings`);
      const elapsed = Date.now() - t0;
      expect(res.status).toBe(200);
      const body = (await res.json()) as { configError?: string };
      expect(body.configError).toMatch(/did not answer within 1 s/);
      expect(elapsed).toBeLessThan(2_500);
    } finally {
      await s.close();
    }
  }, 30_000);
});

describe("the config read is shared and the refresh keeps its guarantee", () => {
  it("at most one read runs at a time for one file and environment", async () => {
    const count = join(dir, "count");
    writeFileSync(count, "");
    setRunnerConfigCommandsForTest({
      records: ["sh", "-c", `echo x >> "${count}"; sleep 0.5; exec bash "${RECORDS_SH}"`],
      show: [process.execPath, SHOW_MJS, "--all", "--json"],
    });
    const env = { PATH: process.env.PATH ?? "", HOME: dir, GAFFER_DATA: dir };
    const reads = await Promise.all([1, 2, 3, 4].map(() => readRunnerConfigAsync(env)));
    expect(reads.every((r) => r.ok)).toBe(true);
    expect(readFileSync(count, "utf8").trim().split("\n")).toHaveLength(1);
  }, 30_000);

  it("a request that arrives while an apply runs waits for it: never the values from before the edit", async () => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: dir, GAFFER_DATA: dir };
    const settings = join(dir, "settings.json");
    writeFileSync(settings, JSON.stringify({ GAFFER_MODE: "autonomous" }));
    applySettingsToEnv(env, settings);
    expect(env["AUTO_MERGE"]).toBe("1");
    // A slow read from here on; the person tightens the mode by hand.
    setRunnerConfigCommandsForTest({
      records: ["sh", "-c", `sleep 0.8; exec bash "${RECORDS_SH}"`],
      show: [process.execPath, SHOW_MJS, "--all", "--json"],
    });
    writeFileSync(settings, JSON.stringify({ GAFFER_MODE: "supervised" }));
    const first = refreshSettingsEnvAsync(env);
    // The second request: by the time its refresh resolves, the edit is in force.
    const second = refreshSettingsEnvAsync(env).then(() => env["AUTO_MERGE"]);
    expect(await second).toBe("0");
    expect(await first).toBe(true);
    expect(env["DISPATCH_ALLOW_AGENT_APPROVE"]).toBe("0");
  }, 30_000);
});

describe("the per-request refresh is bounded (review of external review 21)", () => {
  it("a settings.json that changes continuously does not hold a request for ever", async () => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: dir, GAFFER_DATA: dir };
    const settings = join(dir, "settings.json");
    writeFileSync(settings, JSON.stringify({ GAFFER_MODE: "supervised" }));
    applySettingsToEnv(env, settings);
    setRunnerConfigCommandsForTest({
      records: ["sh", "-c", `sleep 0.3; exec bash "${RECORDS_SH}"`],
      show: [process.execPath, SHOW_MJS, "--all", "--json"],
    });
    // A writer that rewrites the file faster than one read takes.
    let n = 0;
    const writer = setInterval(() => {
      n += 1;
      // Never the same bytes twice, so no read is answered from the cache.
      writeFileSync(settings, JSON.stringify({ GAFFER_MODE: "lite", NOTE: String(n) }));
    }, 100);
    try {
      await new Promise((r) => setTimeout(r, 150)); // the file has changed once already
      const outcome = await Promise.race([
        refreshSettingsEnvAsync(env).then(
          () => "resolved",
          (e: unknown) => `refused:${(e as { code?: string }).code ?? String(e)}`,
        ),
        new Promise<string>((r) => setTimeout(() => r("starved"), 8_000)),
      ]);
      // Bounded, and never by running on values older than the file: it is refused.
      expect(outcome).toBe("refused:STATE_CONFLICT");
    } finally {
      clearInterval(writer);
    }
  }, 30_000);
});
