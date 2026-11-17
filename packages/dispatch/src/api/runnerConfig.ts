import { spawnSync } from "node:child_process";
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
  if (!existsSync(RECORDS_SH) || !existsSync(SCHEMA_PATH)) {
    return { ok: false, error: "the runner's config reader was not found beside the dashboard" };
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
  if (hit) return hit;
  const rec = spawnSync("bash", [RECORDS_SH], { env, encoding: "utf8", timeout: 30_000 });
  let out: RunnerConfigRead;
  if (rec.status !== 0 || rec.error) {
    const why = stopReason(rec.stderr ?? "");
    out = {
      ok: false,
      error: why !== "" ? why : "the runner's config could not be read",
    };
  } else {
    const show = spawnSync(process.execPath, [CONFIG_SHOW_MJS, "--all", "--json"], {
      env,
      input: rec.stdout,
      encoding: "utf8",
      timeout: 30_000,
    });
    if (show.status !== 0 || show.error) {
      out = { ok: false, error: "the runner's config report could not be read" };
    } else {
      out = {
        ok: true,
        records: parseRunnerRecords(rec.stdout),
        report: JSON.parse(show.stdout) as RunnerReport,
      };
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
