import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The runner's own configuration, read the runner's way. The fourteen settings, the
 * values they derive and the migration of old settings.json keys are written ONCE, in
 * runner/config (the tables) and runner/config/settings-schema.json (generated from
 * them). The dashboard never keeps a second copy: it reads the schema for names,
 * kinds, accepted values, defaults and descriptions, and asks the runner's own config
 * (runner/lib/config-records.sh, the printer behind `gaffer config show`) for the
 * values a run would use now.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
/** packages/dispatch/{src,dist}/api -> the monorepo's runner/. */
export const RUNNER_DIR = join(HERE, "..", "..", "..", "..", "runner");
export const SCHEMA_PATH = join(RUNNER_DIR, "config", "settings-schema.json");
const RECORDS_SH = join(RUNNER_DIR, "lib", "config-records.sh");
const CONFIG_SHOW_MJS = join(RUNNER_DIR, "bin", "config-show.mjs");

/** One cell of a derivation table, as the schema writes it. */
export interface SchemaCell {
  readonly how: "value" | "unset" | "follows" | "from-setting" | "computed";
  readonly value?: string;
  readonly name?: string;
  readonly readIn?: string;
}
export interface SchemaDerive {
  readonly name: string;
  readonly note: string;
  readonly all?: SchemaCell;
  readonly byPreset?: Readonly<Record<string, SchemaCell>>;
}
export interface SchemaSetting {
  readonly name: string;
  /** choice | usd | count | models | gates | testing | notify | path | port */
  readonly kind: string;
  readonly values: readonly string[];
  /** The default as the spec writes it; "(none)" (or any "(...)") means empty. */
  readonly default: string;
  readonly description: string;
  readonly derives: readonly SchemaDerive[];
}
export interface SchemaOldKey {
  readonly key: string;
  readonly setting: string;
  readonly compare: string;
  readonly stillApplies: string;
}
export interface SettingsSchema {
  readonly settings: readonly SchemaSetting[];
  readonly oldKeys: readonly SchemaOldKey[];
  readonly environmentOnly: readonly string[];
}

let schemaCache: SettingsSchema | null = null;

/** The runner's settings schema (read once; it is generated and committed). */
export function loadSchema(): SettingsSchema {
  if (schemaCache === null) {
    schemaCache = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as SettingsSchema;
  }
  return schemaCache;
}

/** Raw records the runner printed (values unmasked: they stay in this process). */
export interface RunnerRecords {
  readonly settings: ReadonlyMap<string, { origin: string; value: string }>;
  readonly derived: ReadonlyMap<string, { origin: string; set: boolean; value: string }>;
  /** The derived values the config exports (what a helper a runner starts would see). */
  readonly exported: ReadonlySet<string>;
}

/** The masked report `gaffer config show --all --json` prints (bin/config-show.mjs). */
export interface RunnerReport {
  readonly settings: readonly { name: string; value: string; origin: string }[];
  readonly derived: readonly {
    name: string;
    value: string | null;
    decidedBy: string;
    setting: string;
    note?: string;
  }[];
  readonly migration: readonly {
    key: string;
    setting: string;
    old: string;
    derived: string;
    differs: boolean;
    decision: string;
  }[];
}

export type RunnerConfigRead =
  | { readonly ok: true; readonly records: RunnerRecords; readonly report: RunnerReport }
  | { readonly ok: false; readonly error: string };

/** Parse the S and D records (the M records reach the page through the report). */
export function parseRunnerRecords(text: string): RunnerRecords {
  const settings = new Map<string, { origin: string; value: string }>();
  const derived = new Map<string, { origin: string; set: boolean; value: string }>();
  const exported = new Set<string>();
  for (const line of text.split("\n")) {
    const f = line.split("\t");
    if (f[0] === "S" && f[1]) settings.set(f[1], { origin: f[2] ?? "", value: f[3] ?? "" });
    else if (f[0] === "D" && f[1])
      derived.set(f[1], { origin: f[2] ?? "", set: f[3] === "1", value: f[4] ?? "" });
    else if (f[0] === "X" && f[1]) exported.add(f[1]);
  }
  return { settings, derived, exported };
}

const cache = new Map<string, RunnerConfigRead>();
const CACHE_MAX = 16;
/** Reads running now, by cache key: a request that arrives meanwhile shares the read. */
const inflight = new Map<string, Promise<RunnerConfigRead>>();

/**
 * How long one read of the runner's config may take, both of its processes together
 * (external review 21: it was 30 s per process). A read takes about 0.4 s here and about
 * 1 s on a macOS runner with bash 3.2; a config that hangs past this is reported as
 * unreadable (the Settings page's config callout), never waited on.
 */
export const RUNNER_CONFIG_TIMEOUT_MS = 8_000;

/** The two commands a read runs (a test seam replaces them; see below). */
interface ConfigCommands {
  readonly records: readonly string[];
  readonly show: readonly string[];
  /** A shorter bound for a test (default {@link RUNNER_CONFIG_TIMEOUT_MS}). */
  readonly timeoutMs?: number;
}
let commandsOverride: ConfigCommands | null = null;
function timeoutMs(): number {
  return commandsOverride?.timeoutMs ?? RUNNER_CONFIG_TIMEOUT_MS;
}
function commands(): ConfigCommands {
  return (
    commandsOverride ?? {
      records: ["bash", RECORDS_SH],
      show: [process.execPath, CONFIG_SHOW_MJS, "--all", "--json"],
    }
  );
}
/**
 * Test seam: run these argv instead of the records printer and the report (null puts
 * the real ones back). Module state, never the environment: nothing a settings.json or
 * a request can reach picks what the dashboard runs.
 */
export function setRunnerConfigCommandsForTest(c: ConfigCommands | null): void {
  commandsOverride = c;
  cache.clear();
}

/** The last line of a stopped config (it names the setting and why), never a URL. */
function stopReason(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("gaffer:") && /refusing|fail closed/.test(l));
  const last = lines.pop() ?? "";
  return last.replace(/https?:\/\/\S+/g, "(a URL)");
}

/**
 * Ask the runner's config what a run started with `env` would use. `env` must hold
 * only the operator's real environment (see settings.ts operatorEnv), plus GAFFER_DATA
 * naming the folder of the settings.json to read. Cached on the environment and the
 * file's bytes, so a page load does not source the config twice for the same state.
 */
export function readRunnerConfig(env: Readonly<Record<string, string>>): RunnerConfigRead {
  const pre = prepare(env);
  if ("done" in pre) return pre.done;
  const c = commands();
  const t0 = Date.now();
  const rec = spawnSync(c.records[0]!, c.records.slice(1), {
    env,
    encoding: "utf8",
    timeout: timeoutMs(),
    killSignal: "SIGKILL",
  });
  const recRun: ChildRun = {
    status: rec.status,
    stdout: rec.stdout ?? "",
    stderr: rec.stderr ?? "",
    timedOut: (rec.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
    failed: rec.error !== undefined,
  };
  let showRun: ChildRun | null = null;
  if (recRun.status === 0 && !recRun.failed) {
    const left = Math.max(1, timeoutMs() - (Date.now() - t0));
    const show = spawnSync(c.show[0]!, c.show.slice(1), {
      env,
      input: recRun.stdout,
      encoding: "utf8",
      timeout: left,
      killSignal: "SIGKILL",
    });
    showRun = {
      status: show.status,
      stdout: show.stdout ?? "",
      stderr: show.stderr ?? "",
      timedOut: (show.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
      failed: show.error !== undefined,
    };
  }
  return settle(pre.key, recRun, showRun);
}

/**
 * {@link readRunnerConfig} without blocking the dashboard's event loop (external review
 * 21: the read ran two spawnSync calls on the request path, stalling every other request
 * for its length). The two processes run asynchronously, bounded together by
 * {@link RUNNER_CONFIG_TIMEOUT_MS}; at most ONE read runs at a time for one cache key
 * (environment and file bytes), and a caller that arrives meanwhile gets the same
 * answer. A read that ran out of time is reported, never cached (the next load asks
 * again).
 */
export function readRunnerConfigAsync(
  env: Readonly<Record<string, string>>,
): Promise<RunnerConfigRead> {
  const pre = prepare(env);
  if ("done" in pre) return Promise.resolve(pre.done);
  const running = inflight.get(pre.key);
  if (running) return running;
  const c = commands();
  const p = (async (): Promise<RunnerConfigRead> => {
    const t0 = Date.now();
    const rec = await runChild(c.records, env, null, timeoutMs());
    let show: ChildRun | null = null;
    if (rec.status === 0 && !rec.failed) {
      const left = Math.max(1, timeoutMs() - (Date.now() - t0));
      show = await runChild(c.show, env, rec.stdout, left);
    }
    return settle(pre.key, rec, show);
  })().finally(() => inflight.delete(pre.key));
  inflight.set(pre.key, p);
  return p;
}

/** One finished child process. */
interface ChildRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** It could not be started, or was stopped (a timeout included). */
  readonly failed: boolean;
}

/** Run argv with `input` on stdin, killed (with its process group) after `timeoutMs`. */
function runChild(
  argv: readonly string[],
  env: Readonly<Record<string, string>>,
  input: string | null,
  timeoutMs: number,
): Promise<ChildRun> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const done = (r: ChildRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      // Its own process group, so a timeout stops the config's own children too.
      child = spawn(argv[0]!, argv.slice(1), { env, detached: true, stdio: "pipe" });
    } catch (e) {
      resolve({ status: null, stdout: "", stderr: String(e), timedOut: false, failed: true });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.stdout?.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr?.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (e) =>
      done({ status: null, stdout, stderr: stderr + String(e), timedOut, failed: true }),
    );
    child.on("close", (code) =>
      done({ status: code, stdout, stderr, timedOut, failed: timedOut || code === null }),
    );
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input ?? "");
  });
}

/** The cache key for a read, or the answer when no read is needed (cached, no runner). */
function prepare(
  env: Readonly<Record<string, string>>,
): { done: RunnerConfigRead } | { key: string } {
  if (!commandsOverride && (!existsSync(RECORDS_SH) || !existsSync(SCHEMA_PATH))) {
    return {
      done: { ok: false, error: "the runner's config reader was not found beside the dashboard" },
    };
  }
  let file = "";
  try {
    file = readFileSync(join(env["GAFFER_DATA"] ?? "", "settings.json"), "utf8");
  } catch {
    // No file: the defaults.
  }
  const key = createHash("sha256")
    .update(JSON.stringify(Object.entries(env).sort()))
    .update("\0")
    .update(file)
    .digest("hex");
  const hit = cache.get(key);
  return hit ? { done: hit } : { key };
}

/** Turn the two runs into the read's answer, and cache it unless it ran out of time. */
function settle(key: string, rec: ChildRun, show: ChildRun | null): RunnerConfigRead {
  let out: RunnerConfigRead;
  if (rec.timedOut || show?.timedOut) {
    return {
      ok: false,
      error: `the runner's config did not answer within ${timeoutMs() / 1000} s`,
    };
  }
  if (rec.status !== 0 || rec.failed) {
    const why = stopReason(rec.stderr);
    out = { ok: false, error: why !== "" ? why : "the runner's config could not be read" };
  } else if (!show || show.status !== 0 || show.failed) {
    out = { ok: false, error: "the runner's config report could not be read" };
  } else {
    try {
      out = {
        ok: true,
        records: parseRunnerRecords(rec.stdout),
        report: JSON.parse(show.stdout) as RunnerReport,
      };
    } catch {
      out = { ok: false, error: "the runner's config report could not be read" };
    }
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, out);
  return out;
}

/** Test seam: forget cached reads. */
export function clearRunnerConfigCache(): void {
  cache.clear();
}
