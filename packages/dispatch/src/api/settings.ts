import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { notifyAllowsPrivate, notifyUrlProblem } from "../notify/urlPolicy.js";
import { DispatchError } from "../util/errors.js";
import {
  loadSchema,
  readRunnerConfig,
  type RunnerConfigRead,
  type SchemaSetting,
} from "./runnerConfig.js";

/**
 * The dashboard side of the fourteen settings.
 *
 * A factory has fourteen settings (runner/config/01-settings.sh, generated into
 * runner/config/settings-schema.json); every other value is DERIVED from them by the
 * runner's tables, and a real environment variable still overrides a derived value.
 * This module:
 *   - reads the names, kinds, accepted values, defaults and descriptions of the
 *     fourteen from the schema (never a second copy here; a test fails on drift);
 *   - validates a value exactly as the runner's `_gaffer_setting_problem` does, then
 *     trims and stores it in `$GAFFER_DATA/settings.json` atomically (temp file and
 *     rename). Any other key is refused with the setting that now decides it;
 *   - asks the runner's own config (runnerConfig.ts) what a run would use, for the
 *     page's "What this sets", the migration callout and the override list;
 *   - puts in THIS process's environment only the fourteen and the values the runner
 *     derives for the names the dashboard reads (never an old settings.json value as
 *     it stands), each with the runner's re-source record, so every runner the
 *     dashboard starts derives them afresh from settings.json, exactly as a run
 *     started from the command line does (P-B1 of the part A review).
 *
 * env-locked: a setting is read-only in the UI when the OPERATOR set it in the real
 * environment (which always wins over the file). The operator's names come from the
 * launcher's `_GAFFER_OPERATOR_ENV` record (runner/factory.config.sh), or, for a
 * dashboard started any other way, the names in the environment when it started.
 *
 * Changes take effect on the NEXT factory tick: every tick re-sources the config.
 */

/** How the page groups the fourteen (presentation only; the schema holds the rest). */
export type SettingGroup =
  "autonomy" | "budget" | "work" | "safety" | "delivery" | "notify" | "location";

/** Static descriptor for one setting: the schema's fields plus a label and a group. */
export interface SettingDef {
  readonly key: string;
  /** The schema's kind: choice, usd, count, models, gates, testing, notify, path, port. */
  readonly kind: string;
  /** The accepted choices (presets for models; standard/strict for gates). */
  readonly values: readonly string[];
  /** The default as a value ("" when the schema says none). */
  readonly default: string;
  readonly description: string;
  readonly label: string;
  readonly group: SettingGroup;
  /** False for GAFFER_DATA: shown, never written from the dashboard. */
  readonly writable: boolean;
  /** The value can hold a credential (webhook URLs): never returned, only masked. */
  readonly secret: boolean;
}

/**
 * Label and group for each setting. Presentation only: the names here must be the
 * schema's fourteen (test/settings.test.ts fails if they drift), and every other field
 * comes from the schema.
 */
const PRESENTATION: Readonly<Record<string, { label: string; group: SettingGroup }>> = {
  GAFFER_MODE: { label: "Autonomy mode", group: "autonomy" },
  GAFFER_DAILY_BUDGET_USD: { label: "Daily budget (USD)", group: "budget" },
  GAFFER_BUDGET_USD: { label: "Lifetime budget (USD)", group: "budget" },
  GAFFER_MODELS: { label: "Models", group: "work" },
  GAFFER_EFFORT: { label: "Effort per ticket", group: "work" },
  GAFFER_CONCURRENCY: { label: "Tickets at once", group: "work" },
  GAFFER_IDLE: { label: "When idle", group: "work" },
  GAFFER_SANDBOX: { label: "Sandbox", group: "safety" },
  GAFFER_GATES: { label: "Gates", group: "safety" },
  GAFFER_TESTING: { label: "Independent testing", group: "safety" },
  GAFFER_LANDING: { label: "Landing", group: "delivery" },
  GAFFER_NOTIFY: { label: "Notify", group: "notify" },
  GAFFER_DATA: { label: "Data location", group: "location" },
  DISPATCH_API_PORT: { label: "Dashboard port", group: "location" },
};

/** The schema's table rows for a setting, cells reduced to a value or null. */
const DERIVES_OF: ReadonlyMap<string, readonly SettingDerive[]> = new Map(
  loadSchema().settings.map((s) => [
    s.name,
    s.derives.map((d): SettingDerive => {
      if (!d.byPreset) return { name: d.name, note: d.note };
      const byPreset: Record<string, string | null> = {};
      for (const [k, c] of Object.entries(d.byPreset))
        byPreset[k] = c.how === "value" ? (c.value ?? "") : null;
      return { name: d.name, note: d.note, byPreset };
    }),
  ]),
);

function defOf(s: SchemaSetting): SettingDef {
  const p = PRESENTATION[s.name] ?? { label: s.name, group: "work" as SettingGroup };
  return {
    key: s.name,
    kind: s.kind,
    values: s.values,
    default: s.default.startsWith("(") ? "" : s.default,
    description: s.description,
    label: p.label,
    group: p.group,
    writable: s.name !== "GAFFER_DATA",
    secret: s.kind === "notify",
  };
}

/** The fourteen settings, in the schema's order. The only keys the API writes. */
export const SETTING_DEFS: readonly SettingDef[] = loadSchema().settings.map(defOf);

/** The names PRESENTATION labels (the drift test compares them with the schema). */
export const PRESENTATION_KEYS: readonly string[] = Object.keys(PRESENTATION);

const DEF_BY_KEY: ReadonlyMap<string, SettingDef> = new Map(SETTING_DEFS.map((d) => [d.key, d]));
/** Old settings.json key -> the setting that decides it now (the schema's oldKeys). */
const OLD_KEY_SETTING: ReadonlyMap<string, string> = new Map(
  loadSchema().oldKeys.map((o) => [o.key, o.setting]),
);
/** Every derived name -> the setting whose table derives it. */
const DERIVED_SETTING: ReadonlyMap<string, string> = new Map(
  loadSchema().settings.flatMap((s) => s.derives.map((d) => [d.name, s.name] as const)),
);

/** True iff `key` is one of the fourteen settings. */
export function isKnownSetting(key: string): boolean {
  return DEF_BY_KEY.has(key);
}

/** The setting that now decides an old settings.json key, or null. */
export function oldKeySetting(key: string): string | null {
  return OLD_KEY_SETTING.get(key) ?? null;
}

/**
 * Keys read from the operator's real environment ONLY: settings.json never sets them,
 * here or in the runner (runner/config/01-settings.sh `_GAFFER_ENV_ONLY_KEYS` is the
 * same list, pinned by test/settings.test.ts). GAFFER_ALLOW_UNCAPPED lifts the live-run
 * dollar-cap requirement; the worker provider knobs pick the program that runs every
 * agent turn; GAFFER_PRINCIPAL_TOKEN is a person's credential.
 */
export const ENV_ONLY_KEYS: ReadonlySet<string> = new Set([
  "GAFFER_ALLOW_UNCAPPED",
  "GAFFER_WORKER_PROVIDER",
  "GAFFER_WORKER_COMMAND",
  "GAFFER_WORKER_COMMAND_ENV",
  "GAFFER_WORKER_COMMAND_COST_USD",
  "GAFFER_SANDBOX_WORKER_COMMAND",
  "GAFFER_PRINCIPAL_TOKEN",
]);

/**
 * Resolve the settings file path. Precedence: explicit override, then `$GAFFER_DATA`,
 * then `~/.gaffer` (a bare fallback used only when `$GAFFER_DATA` is unset).
 */
export function resolveSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const dataDir = (env.GAFFER_DATA ?? "").trim();
  const base = dataDir !== "" ? resolve(dataDir) : join(homedir(), ".gaffer");
  return join(base, "settings.json");
}

/**
 * Every string entry of settings.json, old keys included (the migration needs them,
 * and a write must never drop them: only the person's removal act does). A missing
 * file is `{}`; an unreadable or malformed one throws, so the API reports it instead
 * of losing the operator's saved config. Parsed as the runner parses it (a leading
 * BOM dropped, whitespace-only is empty).
 */
export function readSettingsFileRaw(path: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new DispatchError("INTERNAL_ERROR", `Could not read settings file: ${describe(err)}`);
  }
  const trimmed = raw.replace(/^\uFEFF/, "").trim();
  if (trimmed === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new DispatchError("INTERNAL_ERROR", "Settings file is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DispatchError("INTERNAL_ERROR", "Settings file must be a flat JSON object.");
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
  }
  return out;
}

/** The fourteen settings as stored in settings.json (other keys left out). */
export function readSettingsFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(readSettingsFileRaw(path))) {
    if (isKnownSetting(k)) out[k] = v;
  }
  return out;
}

// ── The operator's environment ───────────────────────────────────────────────

const OPERATOR = new WeakMap<object, Set<string>>();
/** Envs whose operator record this module wrote (no launcher record was there). */
const SELF_RECORDED = new WeakSet<object>();
/** The runner's re-source record prefix (runner/factory.config.sh RE-SOURCE HYGIENE). */
const DV = "_GAFFER_DV_";
const OPERATOR_RECORD = "_GAFFER_OPERATOR_ENV";

/**
 * The names the OPERATOR set in the real environment. From the launcher's
 * `_GAFFER_OPERATOR_ENV` (runner/gaffer dashboard keeps it for the server); for a
 * dashboard started some other way, every name in the environment this module did not
 * put there itself. Either way a record is left in `env`, so every runner the dashboard
 * starts knows which values are real environment and which it may derive afresh.
 */
export function operatorNames(env: NodeJS.ProcessEnv): ReadonlySet<string> {
  const cached = OPERATOR.get(env);
  if (cached) return cached;
  const rec = env[OPERATOR_RECORD];
  if (typeof rec === "string" && !SELF_RECORDED.has(env)) {
    const names = new Set(rec.split(/\s+/).filter((n) => n !== ""));
    OPERATOR.set(env, names);
    return names;
  }
  const mine = appliedOf(env);
  const names = new Set(Object.keys(env).filter((n) => !n.startsWith("_GAFFER_") && !mine.has(n)));
  env[OPERATOR_RECORD] = ` ${[...names].join(" ")} `;
  SELF_RECORDED.add(env);
  return names;
}

/** True iff the OPERATOR set this key in the real environment (not this process). */
export function isEnvLocked(env: NodeJS.ProcessEnv, key: string): boolean {
  return operatorNames(env).has(key) && env[key] !== undefined;
}

/**
 * The environment a run started from the command line would have: the operator's
 * names only (never a value this process derived, never a re-source record), plus
 * GAFFER_DATA naming the folder of `path`, and PATH / HOME so bash and node start.
 */
export function operatorEnv(env: NodeJS.ProcessEnv, path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of operatorNames(env)) {
    const v = env[n];
    if (v !== undefined && !n.startsWith("_GAFFER_") && n !== "DISPATCH_API_TOKEN") out[n] = v;
  }
  out["PATH"] ??= process.env.PATH ?? "/usr/bin:/bin";
  out["HOME"] ??= process.env.HOME ?? homedir();
  out["GAFFER_DATA"] = dirname(path);
  return out;
}

/** What the runner's config says a run would use now (cached on env + file bytes). */
export function runnerConfigFor(
  env: NodeJS.ProcessEnv = process.env,
  path: string = resolveSettingsPath(env),
): RunnerConfigRead {
  return readRunnerConfig(operatorEnv(env, path));
}

/** Names this process put in an env (with their re-source records). */
const APPLIED = new WeakMap<object, Set<string>>();
function appliedOf(env: NodeJS.ProcessEnv): Set<string> {
  let s = APPLIED.get(env);
  if (!s) {
    s = new Set();
    APPLIED.set(env, s);
  }
  return s;
}

/**
 * The names the dashboard takes into its own environment: the fourteen, and every value
 * they derive, with the value the RUNNER derives for it (never more permissive than the
 * setting). The dashboard's own readers need them (the approve floor, auto merge, PR
 * mode, the tester lane, notifications, budgets), and so do the helpers it starts that
 * are not runner scripts and never re-source the config: the Plan a build planner and
 * the spec author read the planning model, the worker seam the kill estimate and the MCP
 * bridge. Every old key is a derived name, so it is covered too.
 */
const DASHBOARD_NAMES: readonly string[] = [
  ...new Set([
    ...SETTING_DEFS.map((d) => d.key).filter((k) => k !== "GAFFER_DATA"),
    ...loadSchema().settings.flatMap((s) => s.derives.map((d) => d.name)),
    ...loadSchema().oldKeys.map((o) => o.key),
  ]),
];

/** The settings file as last applied to an env (see refreshSettingsEnv). */
const APPLIED_FILE = new WeakMap<object, { path: string; sig: string }>();

/** Identity of the file's current contents (a rename or an edit in place changes it). */
function fileSignature(path: string): string {
  try {
    const st = statSync(path);
    return `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
  } catch {
    return "none";
  }
}

/**
 * Re-apply settings.json to `env` when the file changed since it was last applied (a
 * hand edit, `gaffer` writing it, another dashboard). The server calls this before each
 * authenticated request, so its own readers (the approve floor, auto merge on a human
 * approval, PR mode, the tester lane) never decide on values a person has since
 * tightened. Only for an env applySettingsToEnv has already been applied to; a stat per
 * request, the runner's config only when the file changed.
 */
export function refreshSettingsEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const last = APPLIED_FILE.get(env);
  if (!last) return false;
  const path = resolveSettingsPath(env);
  if (path === last.path && fileSignature(path) === last.sig) return false;
  applySettingsToEnv(env, path);
  return true;
}

/**
 * Put the settings and what the runner derives from them in `env` (never over a name
 * the operator set). Call at API startup and after each write. Each value goes in with
 * the runner's re-source record (`_GAFFER_DV_<NAME>`, the same value), and the
 * operator record stays in `env`: a runner the dashboard starts then unsets these and
 * derives them from settings.json itself, so a dashboard-started run and a command-line
 * run use the same values, with the same origins. An old key's value in settings.json
 * is never copied: only the runner's reading of it (the stricter one) arrives.
 *
 * When the runner's config cannot be read (it refuses a value, or the runner is not
 * beside the dashboard) only the fourteen that pass validation are applied and every
 * derived name is left unset (each reader's own default, the strict side).
 */
export function applySettingsToEnv(
  env: NodeJS.ProcessEnv = process.env,
  path: string = resolveSettingsPath(env),
): { applied: string[]; error?: string } {
  const op = operatorNames(env);
  const want = new Map<string, string>();
  // Taken before the read: a change while it runs is caught by the next refresh.
  APPLIED_FILE.set(env, { path, sig: fileSignature(path) });
  const rc = runnerConfigFor(env, path);
  if (rc.ok) {
    for (const name of DASHBOARD_NAMES) {
      const s = rc.records.settings.get(name);
      if (s) {
        if (s.origin === "settings.json" && s.value !== "") want.set(name, s.value);
        continue;
      }
      const d = rc.records.derived.get(name);
      if (d && d.set) want.set(name, d.value);
    }
  } else {
    let file: Record<string, string>;
    try {
      file = readSettingsFile(path);
    } catch {
      file = {};
    }
    for (const [k, v] of Object.entries(file)) {
      const def = DEF_BY_KEY.get(k);
      if (!def || !def.writable || v === "") continue;
      if (settingValueProblem(def, v, env) === null) want.set(k, v);
    }
  }
  const applied: string[] = [];
  const mine = appliedOf(env);
  for (const k of [...mine]) {
    if (!want.has(k)) {
      delete env[k];
      delete env[DV + k];
      mine.delete(k);
    }
  }
  for (const [k, v] of want) {
    if (op.has(k)) continue;
    // A value the launcher handed this server on purpose (GAFFER_DASHBOARD_URL: the
    // --lan address, or the port it really serves on) carries no re-source record: it
    // stays, as a re-sourcing runner keeps a value its parent changed on purpose.
    if (env[k] !== undefined && !mine.has(k) && env[DV + k] !== env[k]) continue;
    env[k] = v;
    env[DV + k] = v;
    mine.add(k);
    applied.push(k);
  }
  return rc.ok ? { applied } : { applied, error: rc.error };
}

/** Test seam: forget what this process applied (a fresh process). */
export function resetDerivedSettings(env: NodeJS.ProcessEnv = process.env): void {
  for (const k of appliedOf(env)) {
    delete env[k];
    delete env[DV + k];
  }
  appliedOf(env).clear();
  APPLIED_FILE.delete(env);
  OPERATOR.delete(env);
  if (SELF_RECORDED.has(env)) {
    delete env[OPERATOR_RECORD];
    SELF_RECORDED.delete(env);
  }
}

// ── Validation (a mirror of the runner's _gaffer_setting_problem) ─────────────

const USD_RE = /^([0-9]+([.][0-9]*)?|[.][0-9]+)$/;
const MODEL_ID = "[A-Za-z0-9][A-Za-z0-9._:/@-]*";
const MODELS_RE = new RegExp(`^${MODEL_ID},${MODEL_ID},${MODEL_ID}$`);
/**
 * What separates the items of a GAFFER_NOTIFY value, as the runner splits it: a comma or
 * the shell's word separators (space, tab, newline; the loader turns a carriage return
 * into a space). Never JavaScript's `\s`, which also splits on a no-break space and other
 * unicode spaces the runner keeps inside an item: "desktop<no-break space>https://..."
 * passed here and then stopped every runner process (fail closed).
 */
const NOTIFY_SEP = /[ \t\n\r,]+/;
const GATES_LIST_RE = /^(tests|lint|typecheck)([ ,]+(tests|lint|typecheck))*$/;

/**
 * Why the runner would refuse `value` for `def` from settings.json, in the runner's
 * words (runner/config/01-settings.sh `_gaffer_setting_problem`), or null when it
 * accepts it. The caller trims first; empty means cleared (the default) and is fine.
 * Stricter than the runner in one place: a notify URL must also pass the outbound URL
 * policy (http(s), no loopback or private address unless the environment allows it).
 */
export function settingValueProblem(
  def: SettingDef,
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const v = value;
  if (v === "") return null;
  if (!def.writable) return "is shown here but only the environment can set it";
  switch (def.kind) {
    case "choice":
      return def.values.includes(v) ? null : `is not one of: ${def.values.join(", ")}`;
    case "usd":
      return USD_RE.test(v)
        ? null
        : "is not a dollar amount (digits with an optional decimal part; empty is no cap)";
    case "count":
      return /^[1-9][0-9]?$/.test(v) && Number(v) <= 64
        ? null
        : "is not a whole number from 1 to 64";
    case "port":
      return /^[1-9][0-9]{0,4}$/.test(v) && Number(v) <= 65535
        ? null
        : "is not a port number (1 to 65535)";
    case "path":
      return v.startsWith("/") ? null : "is not an absolute path";
    case "models":
      if (def.values.includes(v) || MODELS_RE.test(v)) return null;
      return `is not a preset (${def.values.join(", ")}) or three model ids as strong,standard,cheap (each starting with a letter or digit)`;
    case "gates":
      if (def.values.includes(v)) return null;
      return GATES_LIST_RE.test(v)
        ? "is a list of gates, which turns the others off; only the environment may do that (settings.json takes standard or strict)"
        : "is not standard, strict or a list of tests, lint, typecheck";
    case "testing":
      return ["auto", "on", "off", "1", "0", "true", "false", "yes", "no"].includes(v.toLowerCase())
        ? null
        : "is not one of: auto, on, off";
    case "notify": {
      let hooks = 0;
      let slack = 0;
      for (const item of v.split(NOTIFY_SEP).filter((i) => i !== "")) {
        if (item === "desktop") continue;
        if (item.startsWith("https://hooks.slack.com/")) slack += 1;
        else if (item.startsWith("http://") || item.startsWith("https://")) hooks += 1;
        else return 'holds an item that is neither "desktop" nor an http(s) URL';
        if (notifyUrlProblem(item, { allowPrivate: notifyAllowsPrivate(env) }) !== null)
          return "holds a URL that is not an allowed webhook address";
      }
      return hooks > 1 || slack > 1
        ? "names more than one webhook URL or more than one Slack URL"
        : null;
    }
    default:
      return "is not a setting";
  }
}

/** One key or value {@link writeSettings} refuses, with the reason in words. */
export interface SettingProblem {
  readonly key: string;
  readonly label: string;
  readonly problem: string;
  /** For an old key: the setting that decides it now. */
  readonly decidedBy?: string;
}

/** Why `key` cannot be written at all (it is not one of the fourteen), or null. */
export function keyProblem(key: string): SettingProblem | null {
  const def = DEF_BY_KEY.get(key);
  if (def) {
    return def.writable
      ? null
      : {
          key,
          label: def.label,
          problem:
            "is not written from the dashboard: settings.json lives inside it, so only the environment can move it (export GAFFER_DATA before starting the runner and the dashboard)",
        };
  }
  const setting = oldKeySetting(key) ?? DERIVED_SETTING.get(key) ?? null;
  if (setting !== null) {
    return {
      key,
      label: key,
      decidedBy: setting,
      problem: `is no longer a setting: ${setting} decides it now (choose a ${setting} value; to override one derived value, export ${key} before starting the runner)`,
    };
  }
  if (ENV_ONLY_KEYS.has(key)) {
    return { key, label: key, problem: "is not a setting: only the environment can set it" };
  }
  return {
    key,
    label: key,
    problem: `is not a setting (the settings are ${SETTING_DEFS.map((d) => d.key).join(", ")})`,
  };
}

/**
 * Every key or value in `updates` that a write refuses: a key that is not one of the
 * fourteen (an old key names the setting that decides it now), or a value the runner
 * would refuse (checked trimmed, as it is stored). Env-locked keys are not problems:
 * they are reported `rejected`. The route refuses the whole write when any is found.
 */
export function settingProblems(
  updates: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): SettingProblem[] {
  const out: SettingProblem[] = [];
  for (const [key, value] of Object.entries(updates)) {
    const kp = keyProblem(key);
    if (kp) {
      out.push(kp);
      continue;
    }
    const def = DEF_BY_KEY.get(key)!;
    if (isEnvLocked(env, key)) continue;
    const problem = settingValueProblem(def, value.trim(), env);
    if (problem !== null) out.push({ key, label: def.label, problem });
  }
  return out;
}

// ── Secrets ──────────────────────────────────────────────────────────────────

/** The host of a URL, or null (never any path, query or credential). */
export function secretHost(value: string): string | null {
  try {
    const u = new URL(value.trim());
    return u.host || null;
  } catch {
    return null;
  }
}

/** One notify channel as every principal sees it: its kind and host, never the URL. */
export interface NotifyChannel {
  readonly kind: "desktop" | "slack" | "webhook" | "other";
  readonly host: string | null;
}

/** The channels of a GAFFER_NOTIFY value, masked. */
export function notifyChannels(value: string): NotifyChannel[] {
  return value
    .split(NOTIFY_SEP)
    .filter((i) => i !== "")
    .map((i) =>
      i === "desktop"
        ? { kind: "desktop" as const, host: null }
        : i.startsWith("https://hooks.slack.com/")
          ? { kind: "slack" as const, host: secretHost(i) }
          : /^https?:\/\//.test(i)
            ? { kind: "webhook" as const, host: secretHost(i) }
            : { kind: "other" as const, host: null },
    );
}

/** A masked GAFFER_NOTIFY value in words ("desktop, a Slack URL (hooks.slack.com)"). */
export function maskNotify(value: string): string {
  return notifyChannels(value)
    .map((c) =>
      c.kind === "desktop"
        ? "desktop"
        : c.kind === "slack"
          ? `a Slack URL (${c.host ?? "hidden"})`
          : c.kind === "webhook"
            ? `a webhook URL (${c.host ?? "hidden"})`
            : "(hidden)",
    )
    .join(", ");
}

/** A name whose value may hold a credential (the runner's config-show rule). */
export function isSecretName(name: string): boolean {
  return /TOKEN|SECRET|PASSWORD|API_KEY|WEBHOOK|SLACK|NOTIFY_.*URL|^GAFFER_NOTIFY$/.test(name);
}

/** True when `key` is a secret-bearing setting (GAFFER_NOTIFY). */
export function isSecretSetting(key: string): boolean {
  return DEF_BY_KEY.get(key)?.secret === true;
}

/**
 * The in-force value of ONE secret setting (env when locked, else the file), for an
 * ADMIN principal's explicit read-back (GET /api/settings/secret/:key). Null when the
 * key is not a secret setting.
 */
export function readSecretSetting(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
  path: string = resolveSettingsPath(env),
): { key: string; value: string; source: SettingOrigin } | null {
  if (!isSecretSetting(key)) return null;
  if (isEnvLocked(env, key)) return { key, value: env[key] ?? "", source: "environment" };
  const fileValue = readSettingsFile(path)[key] ?? "";
  return { key, value: fileValue, source: fileValue !== "" ? "dashboard" : "default" };
}

// ── Views ────────────────────────────────────────────────────────────────────

/** Where a setting's value came from. */
export type SettingOrigin = "default" | "dashboard" | "environment";

/** One setting as GET /api/settings reports it. */
export interface SettingView {
  readonly key: string;
  readonly label: string;
  readonly group: SettingGroup;
  readonly kind: string;
  readonly values: readonly string[];
  readonly default: string;
  readonly description: string;
  readonly writable: boolean;
  /** The stored settings.json value ("" when unset); masked for a secret. */
  readonly value: string;
  /** The value a run uses now; masked for a secret. */
  readonly effective: string;
  readonly origin: SettingOrigin;
  /** True iff the OPERATOR set it in the real environment: read-only on the page. */
  readonly envLocked: boolean;
  readonly secret?: true;
  /** A secret only: the channels in force, masked. */
  readonly channels?: readonly NotifyChannel[];
  /** A secret only: true when a value is in force. */
  readonly configured?: boolean;
  /**
   * What this setting derives, from the schema: each name with its note and, where the
   * value follows the choice, what each choice derives (null: left unset or computed).
   * The page's "what changes if you pick X" reads this; nothing is re-typed there.
   */
  readonly derives: readonly SettingDerive[];
}

/** One row of a setting's table as the page reads it. */
export interface SettingDerive {
  readonly name: string;
  readonly note: string;
  readonly byPreset?: Readonly<Record<string, string | null>>;
}

/** One derived value: what a run uses and what decided it (secrets masked). */
export interface DerivedView {
  readonly name: string;
  readonly value: string | null;
  readonly decidedBy: string;
  readonly setting: string;
  readonly note?: string;
  /** Where the value came from: the setting, a real environment variable, or an old key. */
  readonly source: "setting" | "environment" | "old-key";
}

/** One old settings.json key: what decides it now and what happened to it. */
export interface MigrationView {
  readonly key: string;
  readonly setting: string;
  /** The stored value (masked when it may hold a credential). */
  readonly old: string;
  /** What the setting derives (masked likewise). */
  readonly derived: string;
  readonly differs: boolean;
  /** kept | stricter-derived | same | ignored | environment | not-a-setting */
  readonly decision: string;
  /** In plain words: which reading is in force. */
  readonly inForce: string;
}

/** One key the removal act drops. */
export interface CleanupDrop {
  readonly key: string;
  /** The stored value, masked (a key the runner never read: not shown at all). */
  readonly value: string;
  /**
   * True when the old value is in force now because it is stricter than what its
   * setting derives: removing it makes the factory LOOSER, and the page says so.
   */
  readonly loosens?: true;
  /** For `loosens`: the setting that decides it once removed, and what it derives. */
  readonly setting?: string;
  readonly after?: string;
}

/** What the removal act would do to settings.json, shown before it is done. */
export interface CleanupPlan {
  /** Keys it removes (every key that is not one of the fourteen), values masked. */
  readonly drop: readonly CleanupDrop[];
  /** Stored values of the fourteen it rewrites (padded, out of range), masked. */
  readonly rewrite: readonly { key: string; from: string; to: string }[];
  /**
   * The file this plan was made from (a keyed hash of its bytes, never the bytes). The
   * act repeats it: a file that changed in any way since, a value included, is refused.
   */
  readonly digest: string;
}

/** The whole GET /api/settings body (beside the isolation posture). */
export interface SettingsReport {
  readonly settings: SettingView[];
  readonly derived: DerivedView[];
  readonly migration: MigrationView[];
  /** Derived values a real environment variable sets (masked). */
  readonly overrides: { name: string; value: string | null; setting: string }[];
  readonly cleanup: CleanupPlan;
  /** Set when the runner's config refuses to load (it names the setting and why). */
  readonly configError?: string;
}

const IN_FORCE: Readonly<Record<string, string>> = {
  kept: "the old value is in force: it is stricter than what the setting derives (or the setting leaves it unset)",
  "stricter-derived":
    "the setting's value is in force: the old value was more permissive or costlier",
  same: "the setting derives the same value",
  ignored: "the setting's value is in force",
  environment: "the environment sets it, so neither applies",
  "not-a-setting": "ignored: it was never a setting the runner reads from settings.json",
};

function masked(name: string, value: string): string {
  if (!isSecretName(name) || value === "") return value;
  return name === "GAFFER_NOTIFY" ? maskNotify(value) : "(set, hidden)";
}

/**
 * The value of a key in settings.json as GET /api/settings shows it. A key the runner
 * never read (neither a setting nor an old key) is not shown at all: its name is enough
 * to decide on removing it, and such a key can hold anything (a hand-stored token under
 * a name the secret rule does not know), which a read-only viewer must not learn.
 */
function shownValue(name: string, value: string): string {
  if (value !== "" && !DEF_BY_KEY.has(name) && !OLD_KEY_SETTING.has(name)) return "(not shown)";
  return masked(name, value);
}

/** Per-process key for {@link fileDigest}: a plan does not outlive the server. */
const DIGEST_KEY = randomBytes(32);
/** A keyed hash of settings.json's bytes ("" for no file). */
function fileDigest(path: string): string {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    bytes = Buffer.alloc(0);
  }
  return createHmac("sha256", DIGEST_KEY).update(bytes).digest("hex").slice(0, 32);
}

/** How a stored value of one of the fourteen is rewritten by the removal act. */
function storedRewrite(def: SettingDef, stored: string, env: NodeJS.ProcessEnv): string | null {
  if (stored === "") return null;
  const t = stored.trim();
  if (def.kind === "count" && /^[0-9]+$/.test(t) && Number(t) > 64) return "64";
  if (settingValueProblem(def, t, env) === null) return t === stored ? null : t;
  return "";
}

/** What the removal act would do now. */
export function cleanupPlan(
  env: NodeJS.ProcessEnv = process.env,
  path: string = resolveSettingsPath(env),
): CleanupPlan {
  const digest = fileDigest(path);
  const raw = readSettingsFileRaw(path);
  // The old keys whose value is in force now (stricter than the setting's reading).
  const kept = new Map<string, { setting: string; derived: string }>();
  const rc = runnerConfigFor(env, path);
  if (rc.ok)
    for (const m of rc.report.migration)
      if (m.decision === "kept") kept.set(m.key, { setting: m.setting, derived: m.derived });
  const drop: CleanupDrop[] = [];
  const rewrite: { key: string; from: string; to: string }[] = [];
  for (const [k, v] of Object.entries(raw)) {
    const def = DEF_BY_KEY.get(k);
    if (!def || !def.writable) {
      const kk = kept.get(k);
      drop.push(
        kk
          ? {
              key: k,
              value: shownValue(k, v),
              loosens: true,
              setting: kk.setting,
              after: kk.derived,
            }
          : { key: k, value: shownValue(k, v) },
      );
      continue;
    }
    const to = storedRewrite(def, v, env);
    if (to !== null) rewrite.push({ key: k, from: masked(k, v), to: masked(k, to) });
  }
  return { drop, rewrite, digest };
}

/**
 * GET /api/settings: the fourteen with value, origin and env-lock, plus the read-only
 * blocks the runner's config reports (derived, migration, overrides), and the removal
 * plan. Every secret is masked.
 */
export function settingsReport(
  env: NodeJS.ProcessEnv = process.env,
  path: string = resolveSettingsPath(env),
): SettingsReport {
  const file = readSettingsFile(path);
  const raw = readSettingsFileRaw(path);
  const rc = runnerConfigFor(env, path);
  const settings = SETTING_DEFS.map((def): SettingView => {
    const locked = isEnvLocked(env, def.key);
    const stored = file[def.key] ?? "";
    let effective: string;
    let origin: SettingOrigin;
    if (locked) {
      effective = env[def.key] ?? "";
      origin = "environment";
    } else if (rc.ok) {
      const s = rc.records.settings.get(def.key);
      effective = s?.value ?? "";
      origin =
        s?.origin === "environment"
          ? "environment"
          : s?.origin === "settings.json"
            ? "dashboard"
            : "default";
    } else if (stored.trim() !== "") {
      effective = stored;
      origin = "dashboard";
    } else {
      effective = def.default;
      origin = "default";
    }
    if (effective === "" && origin === "default") effective = def.default;
    if (def.key === "GAFFER_DATA") effective = dirname(path);
    const base = {
      key: def.key,
      label: def.label,
      group: def.group,
      kind: def.kind,
      values: def.values,
      default: def.default,
      description: def.description,
      writable: def.writable,
      envLocked: locked,
      derives: DERIVES_OF.get(def.key) ?? [],
    };
    if (def.secret) {
      return {
        ...base,
        value: maskNotify(stored),
        effective: maskNotify(effective),
        origin,
        secret: true,
        channels: notifyChannels(effective),
        configured: effective.trim() !== "",
      };
    }
    return { ...base, value: stored, effective, origin };
  });
  const derived: DerivedView[] = [];
  const overrides: { name: string; value: string | null; setting: string }[] = [];
  const migration: MigrationView[] = [];
  if (rc.ok) {
    for (const d of rc.report.derived) {
      const source: DerivedView["source"] =
        d.decidedBy === "environment"
          ? "environment"
          : d.decidedBy.startsWith("settings.json")
            ? "old-key"
            : "setting";
      derived.push({ ...d, source });
      if (source === "environment")
        overrides.push({ name: d.name, value: d.value, setting: d.setting });
    }
    for (const m of rc.report.migration) {
      migration.push({ ...m, inForce: IN_FORCE[m.decision] ?? m.decision });
    }
  }
  // A key in the file the runner neither reads nor migrates (it says so and ignores it).
  const seen = new Set(migration.map((m) => m.key));
  for (const [k, v] of Object.entries(raw)) {
    if (DEF_BY_KEY.has(k) || seen.has(k) || OLD_KEY_SETTING.has(k)) continue;
    migration.push({
      key: k,
      setting: "",
      old: shownValue(k, v),
      derived: "",
      differs: false,
      decision: "not-a-setting",
      inForce: IN_FORCE["not-a-setting"]!,
    });
  }
  return {
    settings,
    derived,
    migration,
    overrides,
    cleanup: cleanupPlan(env, path),
    ...(rc.ok ? {} : { configError: rc.error }),
  };
}

/** The fourteen settings (GET /api/settings `settings`). */
export function listSettings(
  env: NodeJS.ProcessEnv = process.env,
  path: string = resolveSettingsPath(env),
): SettingView[] {
  return settingsReport(env, path).settings;
}

// ── Writes ───────────────────────────────────────────────────────────────────

/** Outcome of a settings write. */
export interface WriteSettingsResult {
  readonly written: string[];
  /** Settings skipped because the operator's environment sets them (env wins). */
  readonly rejected: string[];
  /** Keys refused: not one of the fourteen (see {@link settingProblems}). */
  readonly ignored: string[];
  /** Values refused: the runner would not accept them. */
  readonly invalid: string[];
}

/**
 * A structured change to GAFFER_NOTIFY that keeps the saved URLs on the server: the page
 * never holds them (they are masked), so it says what to change. `undefined` keeps a
 * channel as it is, `null` or "" removes it, a string replaces it.
 */
export interface NotifyChange {
  readonly desktop?: boolean | undefined;
  readonly webhook?: string | null | undefined;
  readonly slack?: string | null | undefined;
}

/** The GAFFER_NOTIFY value a {@link NotifyChange} makes from the stored one. */
export function applyNotifyChange(stored: string, change: NotifyChange): string {
  const items = stored.split(NOTIFY_SEP).filter((i) => i !== "");
  let desktop = items.includes("desktop");
  let slack = items.find((i) => i.startsWith("https://hooks.slack.com/")) ?? "";
  let webhook =
    items.find((i) => /^https?:\/\//.test(i) && !i.startsWith("https://hooks.slack.com/")) ?? "";
  if (change.desktop !== undefined) desktop = change.desktop;
  if (change.slack !== undefined) slack = (change.slack ?? "").trim();
  if (change.webhook !== undefined) webhook = (change.webhook ?? "").trim();
  return [desktop ? "desktop" : "", webhook, slack].filter((i) => i !== "").join(",");
}

/**
 * Merge `updates` into settings.json and write it atomically. Values are trimmed and
 * must pass {@link settingValueProblem}; a cleared value ("") removes the key (the
 * default applies). Keys that are not one of the fourteen are refused (`ignored`), the
 * operator's environment wins (`rejected`), and every other key already in the file,
 * old keys included, is kept as it is: only {@link removeOldKeys} removes them.
 */
export function writeSettings(
  updates: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
  path: string = resolveSettingsPath(env),
): WriteSettingsResult {
  const merged: Record<string, string> = { ...readSettingsFileRaw(path) };
  const written: string[] = [];
  const rejected: string[] = [];
  const ignored: string[] = [];
  const invalid: string[] = [];
  for (const [key, rawValue] of Object.entries(updates)) {
    const def = DEF_BY_KEY.get(key);
    if (def === undefined || !def.writable) {
      ignored.push(key);
      continue;
    }
    if (isEnvLocked(env, key)) {
      rejected.push(key);
      continue;
    }
    const value = rawValue.trim();
    if (settingValueProblem(def, value, env) !== null) {
      invalid.push(key);
      continue;
    }
    if (value === "") delete merged[key];
    else merged[key] = value;
    written.push(key);
  }
  if (written.length > 0) {
    atomicWriteJson(path, merged);
    applySettingsToEnv(env, path);
  }
  return { written, rejected, ignored, invalid };
}

/**
 * The person's removal act: rewrite settings.json keeping only the fourteen (stored
 * values trimmed; an out-of-range one clamped or cleared), atomically. `expected` is
 * the plan the page showed: when the file changed since (the plan differs), nothing is
 * written and a CONFLICT is thrown, so nothing is removed that the person did not see.
 */
export function removeOldKeys(
  expected: { drop: readonly string[]; rewrite: readonly string[]; digest: string },
  env: NodeJS.ProcessEnv = process.env,
  path: string = resolveSettingsPath(env),
): CleanupPlan {
  const plan = cleanupPlan(env, path);
  const same = (a: readonly string[], b: readonly string[]) =>
    JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  if (
    plan.digest !== expected.digest ||
    !same(
      plan.drop.map((d) => d.key),
      expected.drop,
    ) ||
    !same(
      plan.rewrite.map((r) => r.key),
      expected.rewrite,
    )
  ) {
    throw new DispatchError(
      "STATE_CONFLICT",
      "settings.json changed since the page showed what would be removed; reload the Settings page and look again.",
      { plan },
    );
  }
  if (plan.drop.length === 0 && plan.rewrite.length === 0) return plan;
  const raw = readSettingsFileRaw(path);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const def = DEF_BY_KEY.get(k);
    if (!def || !def.writable) continue;
    const to = storedRewrite(def, v, env);
    const value = to === null ? v : to;
    if (value !== "") out[k] = value;
  }
  atomicWriteJson(path, out);
  applySettingsToEnv(env, path);
  return plan;
}

/** Serialise `data` to `path` atomically (temp file in the same dir + rename). */
function atomicWriteJson(path: string, data: Record<string, string>): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  // Random suffix (not Date.now()) so two writes in the same millisecond on the
  // same pid can't collide on the temp path and clobber each other's contents.
  const tmp = join(dir, `.settings.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  const body = `${JSON.stringify(data, null, 2)}\n`;
  try {
    writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file may never have been created; nothing to clean up.
    }
    throw err;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
