import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { DispatchError } from "../util/errors.js";

/**
 * UI-editable factory settings — the dispatch side of an env-override config
 * layer.
 *
 * The factory's runtime config is all environment variables (sourced from
 * `factory.config.sh` in the runner). This module adds a small, UI-editable
 * persistence file the runner reads with **env-override** semantics: an explicit
 * environment variable ALWAYS wins over the file. Concretely the runner sources
 * the file and then applies `: "${KEY:=<file-value>}"` so a key already set in
 * the environment is left untouched.
 *
 * The contract this module owns:
 *
 *   - Storage: `$GAFFER_DATA/settings.json` — a FLAT JSON object mapping a known
 *     setting key to its STRING value, e.g. `{ "MAX_TICKS": "50" }`. Values are
 *     always strings (env vars are strings); the UI coerces booleans/ints to the
 *     string form the runner expects ("0"/"1" for booleans).
 *   - env-locked: a key is read-only in the UI when `process.env[KEY]` is set,
 *     because an explicit env var overrides the file, so editing the file for
 *     that key would have no effect. The API reports such keys `envLocked` and
 *     {@link writeSettings} refuses to persist them.
 *
 * The file is the source of truth for UI edits; the runner is the consumer.
 * Changes take effect on the NEXT factory tick — there is no live restart.
 */

/** A logical grouping for the settings panel's sections. */
export type SettingGroup =
  | "autonomy"
  | "idle-loops"
  | "budget"
  | "planning-debate"
  | "notifications";

/** The value type a setting carries, so the UI renders the right control. */
export type SettingType = "boolean" | "int" | "csv" | "string";

/** Static descriptor for one known setting. */
export interface SettingDef {
  readonly key: string;
  readonly type: SettingType;
  readonly group: SettingGroup;
  readonly label: string;
  readonly help?: string;
}

/** One setting as reported to the UI by GET /api/settings. */
export interface SettingView {
  readonly key: string;
  /** Current file value, or "" when unset in settings.json. */
  readonly value: string;
  /** True iff `process.env[key]` is set — env overrides the file, so read-only. */
  readonly envLocked: boolean;
  readonly type: SettingType;
  readonly group: SettingGroup;
  readonly label: string;
  readonly help?: string;
}

/**
 * The known settings, grouped. This is the allow-list: GET reports exactly these
 * keys and POST silently drops anything not in here, so the UI can never write an
 * arbitrary env var into the file.
 */
export const SETTING_DEFS: readonly SettingDef[] = [
  // --- Autonomy: how much the factory may do without a human in the loop ---
  {
    key: "DISPATCH_ALLOW_AGENT_APPROVE",
    type: "boolean",
    group: "autonomy",
    label: "Agents may approve reviews",
    help: "Let an agent actor approve a ticket's review (otherwise human-only).",
  },
  {
    key: "MERGE_ON_AGENT_REVIEW",
    type: "boolean",
    group: "autonomy",
    label: "Auto-merge on agent review",
    help: "Fire the merge command when an agent (not just a human) approves.",
  },
  {
    key: "MEMORY_AUTO_APPROVE",
    type: "boolean",
    group: "autonomy",
    label: "Auto-approve memory drafts",
    help: "Accept memory draft records without a human review step.",
  },
  {
    key: "GAFFER_TESTING",
    type: "boolean",
    group: "autonomy",
    label: "Independent black-box testing",
    help:
      "When on, an approved testable ticket routes through the independent testing " +
      "lane (in_review → in_testing) instead of straight to merge. The lane, the " +
      "contract, and the runner seam are live; the seam hands an independent tester " +
      "the contract + AC (never the diff). The live tester invocation is a documented " +
      "follow-up. Off → review approval goes straight to merge.",
  },

  // --- Idle loops: the between-work background loops + their mode ---
  {
    key: "GAFFER_IDLE_FEATURE_BACKLOG",
    type: "boolean",
    group: "idle-loops",
    label: "Feature-backlog idle loop",
    help: "When idle, mine repos for feature backlog candidates.",
  },
  {
    key: "GAFFER_IDLE_MODE",
    type: "string",
    group: "idle-loops",
    label: "Idle-loop mode",
    help: "How far an idle loop goes: observe · draft · ready.",
  },

  // --- Budget / caps: hard limits on a run ---
  {
    key: "MAX_TICKS",
    type: "int",
    group: "budget",
    label: "Max ticks (run)",
    help: "Upper bound on factory ticks for a single run.",
  },
  {
    key: "MAX_TICKS_PER_DAY",
    type: "int",
    group: "budget",
    label: "Max ticks / day",
    help: "Daily ceiling on factory ticks.",
  },
  {
    key: "GAFFER_TICK_TIMEOUT",
    type: "int",
    group: "budget",
    label: "Tick timeout (s)",
    help: "Wall-clock cap on a single tick before it is killed.",
  },
  {
    key: "GAFFER_MAX_TURNS",
    type: "int",
    group: "budget",
    label: "Max turns / agent",
    help: "Cap on agent turns within one ticket.",
  },

  // --- Planning debate: multi-model plan critique ---
  {
    key: "GAFFER_PLAN_DEBATE",
    type: "boolean",
    group: "planning-debate",
    label: "Plan debate",
    help: "Run a multi-model debate over the plan before decomposing.",
  },
  {
    key: "GAFFER_PLAN_DEBATE_MODELS",
    type: "csv",
    group: "planning-debate",
    label: "Debate models",
    help: "Comma-separated model ids that take part in the debate.",
  },
  {
    key: "GAFFER_PLAN_DEBATE_MAX_ROUNDS",
    type: "int",
    group: "planning-debate",
    label: "Debate max rounds",
    help: "Upper bound on debate rounds.",
  },
  {
    key: "GAFFER_PLAN_DEBATE_MIN_ESTIMATE",
    type: "int",
    group: "planning-debate",
    label: "Debate min estimate",
    help: "Only debate plans whose estimate is at least this.",
  },

  // --- Notifications (H2): opt-in pings when the factory needs a human ---
  // The factory runs unattended; these surface the human-gate transitions
  // (review needed · ticket blocked/parked · decision pending) outside the
  // dashboard. All default off → a no-op notifier with zero overhead. The
  // dispatch facade reads these via src/notify/config.ts (NOTIFY_ENV).
  {
    key: "GAFFER_NOTIFY_WEBHOOK_URL",
    type: "string",
    group: "notifications",
    label: "Webhook URL",
    help: "POST each human-gate event as JSON to this URL (the generic integration).",
  },
  {
    key: "GAFFER_NOTIFY_SLACK_URL",
    type: "string",
    group: "notifications",
    label: "Slack webhook URL",
    help: "Slack incoming-webhook URL — gates arrive as a Slack message.",
  },
  {
    key: "GAFFER_NOTIFY_DESKTOP",
    type: "boolean",
    group: "notifications",
    label: "Desktop notifications",
    help: "Fire a native desktop banner (macOS/Linux) on each human gate.",
  },
  {
    key: "GAFFER_NOTIFY_EVENTS",
    type: "csv",
    group: "notifications",
    label: "Notify on events",
    help:
      "Comma-separated allow-list of gate kinds to notify on " +
      "(review_needed · ticket_blocked · ticket_parked · decision_pending). " +
      "Empty = all gates.",
  },
] as const;

/** Fast lookup of a known key → its descriptor. */
const DEF_BY_KEY: ReadonlyMap<string, SettingDef> = new Map(SETTING_DEFS.map((d) => [d.key, d]));

/** True iff `key` is one of the known, writable setting keys. */
export function isKnownSetting(key: string): boolean {
  return DEF_BY_KEY.has(key);
}

/**
 * Resolve the settings file path. Precedence: explicit override → `$GAFFER_DATA`
 * → `~/.gaffer` (a bare fallback used only when `$GAFFER_DATA` is unset). When
 * launched via the runner, `$GAFFER_DATA` is set to the repo-local `.gaffer/`
 * (next to the checkout), so that path wins. Always `settings.json`.
 */
export function resolveSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const dataDir = (env.GAFFER_DATA ?? "").trim();
  const base = dataDir !== "" ? resolve(dataDir) : join(homedir(), ".gaffer");
  return join(base, "settings.json");
}

/**
 * Read the persisted settings map. A missing file is the normal "nothing set
 * yet" state and yields `{}`. A present-but-unreadable / malformed file throws a
 * {@link DispatchError} so the API surfaces a clean error rather than silently
 * losing the operator's saved config.
 */
export function readSettingsFile(path: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    // A missing file is expected (nothing saved yet) → empty map.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new DispatchError(
      "INTERNAL_ERROR",
      `Could not read settings file at ${path}: ${describe(err)}`,
    );
  }
  const trimmed = raw.trim();
  if (trimmed === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new DispatchError("INTERNAL_ERROR", `Settings file at ${path} is not valid JSON.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DispatchError(
      "INTERNAL_ERROR",
      `Settings file at ${path} must be a flat JSON object.`,
    );
  }
  // Keep only string values for known keys; ignore anything stale/foreign so a
  // hand-edited file can never inject an unknown key into the UI.
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (isKnownSetting(k) && typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Build the per-setting views GET /api/settings returns: for each known setting,
 * its current file value (or "" when unset) plus whether it is env-locked.
 */
export function listSettings(
  env: NodeJS.ProcessEnv = process.env,
  path: string = resolveSettingsPath(env),
): SettingView[] {
  const file = readSettingsFile(path);
  return SETTING_DEFS.map((def) => ({
    key: def.key,
    value: file[def.key] ?? "",
    // env-locked iff the key is PRESENT in the environment (even empty string),
    // because the runner's `:=` only fills an UNSET var — a set-but-empty env
    // var still wins over the file.
    envLocked: Object.prototype.hasOwnProperty.call(env, def.key),
    type: def.type,
    group: def.group,
    label: def.label,
    ...(def.help !== undefined ? { help: def.help } : {}),
  }));
}

/** Outcome of a settings write: which keys persisted and which were rejected. */
export interface WriteSettingsResult {
  readonly written: string[];
  /** Known keys skipped because they are env-locked (env overrides the file). */
  readonly rejected: string[];
  /** Unknown keys silently dropped (not in the allow-list). */
  readonly ignored: string[];
}

/**
 * Merge `updates` into the persisted settings and write atomically.
 *
 * Rules:
 *   - Unknown keys are dropped (not in {@link SETTING_DEFS}) → `ignored`.
 *   - env-locked keys are refused (env overrides the file, so a UI edit would be
 *     a silent no-op for the runner) → `rejected`, never persisted.
 *   - Everything else is merged onto the existing file map and written.
 *
 * Atomic write: serialise to a temp file in the same directory, then rename over
 * the target, so a crash mid-write never leaves a truncated settings file.
 */
export function writeSettings(
  updates: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
  path: string = resolveSettingsPath(env),
): WriteSettingsResult {
  const current = readSettingsFile(path);
  const merged: Record<string, string> = { ...current };
  const written: string[] = [];
  const rejected: string[] = [];
  const ignored: string[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (!isKnownSetting(key)) {
      ignored.push(key);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      // env-locked: an explicit env var overrides the file, so persisting this
      // would mislead the operator (the runner would ignore it). Refuse it.
      rejected.push(key);
      continue;
    }
    merged[key] = value;
    written.push(key);
  }

  // Only touch the disk when something actually changed.
  if (written.length > 0) {
    atomicWriteJson(path, merged);
  }

  return { written, rejected, ignored };
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
    // A failed rename (cross-device, permissions) must not leave the temp file
    // littering the data dir — clean it up best-effort, then surface the error.
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
