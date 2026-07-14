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
  | "delivery"
  | "execution"
  | "idle-loops"
  | "budget"
  | "planning-debate"
  | "quality"
  | "sandbox"
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
  /**
   * Closed set of allowed values for an enum-style `string` setting (e.g.
   * GAFFER_MODE). When present the UI renders a dropdown instead of a free-text
   * box, and {@link writeSettings} refuses any value outside the list (empty is
   * always allowed — it clears the override back to the built-in default).
   */
  readonly choices?: readonly string[];
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
  /** Allowed values for an enum setting — the UI renders these as a dropdown. */
  readonly choices?: readonly string[];
}

/**
 * The known settings, grouped. This is the allow-list: GET reports exactly these
 * keys and POST silently drops anything not in here, so the UI can never write an
 * arbitrary env var into the file.
 */
export const SETTING_DEFS: readonly SettingDef[] = [
  // --- Autonomy: how much the factory may do without a human in the loop ---
  {
    key: "GAFFER_MODE",
    type: "string",
    choices: ["supervised", "graduated", "autonomous", "strict"],
    group: "autonomy",
    label: "Autonomy mode",
    help:
      "Preset that sets the whole autonomy cluster at once (review mode, agent " +
      "approval, auto-merge, auto-push, memory auto-approve): supervised · " +
      "graduated · autonomous · strict. supervised (default) keeps a human on every " +
      "merge; graduated ships what each repo has EARNED at its risk level and holds " +
      "everything else for you (the reviewer agent runs, but the per-repo/risk autonomy " +
      "policy is the sole allow-path — set grants in the per-repo policy editor); " +
      "autonomous lets agents approve and auto-merges + pushes approved work; " +
      "strict adds OS-level sandbox containment on top of autonomous, chosen by " +
      "SANDBOX_PROVIDER: docker (any host with Docker) gives real read + egress " +
      "isolation; sandbox-exec (macOS) is a write-only sandbox, so with sandbox-exec on " +
      "a non-macOS host strict has no OS containment beyond the deterministic hook — set " +
      "GAFFER_STRICT_REQUIRE=1 to fail closed rather than degrade. " +
      "Picking a mode prevents a " +
      "half-configured autonomy posture. The individual knobs below still " +
      "override the mode — an explicitly-set flag always wins.",
  },
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
    choices: ["observe_only", "create_draft", "create_ready"],
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
  // --- Cost-as-control (Track 3a): spend steers routing, not just reporting ---
  {
    key: "GAFFER_BUDGET_USD",
    type: "string",
    group: "budget",
    label: "Budget ceiling (USD)",
    help:
      "Total factory spend ceiling in USD (summed from the usage-ledger). As " +
      "headroom runs low the router biases cheaper; at $0 headroom in-flight work " +
      "pauses. Empty = unlimited.",
  },
  {
    key: "GAFFER_BUDGET_LOW_THRESHOLD",
    type: "string",
    group: "budget",
    label: "Budget-low threshold (USD)",
    help:
      "USD headroom at/under which routing biases one tier CHEAPER. Empty auto-derives " +
      "~20% of the budget ceiling; set explicitly to override.",
  },
  {
    key: "GAFFER_CHEAP_PHASES",
    type: "csv",
    group: "budget",
    label: "Cheap-tier phases",
    help:
      "Comma-separated phases whose work is biased to the cheap model tier. " +
      "Only 'implement' is routed through the model router today, so 'implement' is " +
      "the only value with any effect; other phase names are inert until their call " +
      "sites are routed. High/critical-risk work is never cheapened.",
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
  {
    key: "GAFFER_NOTIFY_FULL_PAYLOAD",
    type: "boolean",
    group: "notifications",
    label: "Send full webhook payload",
    help:
      "Outbound notifications are REDACTED by default (kind · ticket number · status · " +
      "dashboard URL). The free-text ticket title/detail can be prompt-injection-" +
      "influenced, so they never leave the box unless you opt in here. Enable ONLY when " +
      "the webhook/Slack endpoint is inside your trust boundary.",
  },

  // --- Autonomy (cont.): who reviews a delivery ---
  {
    key: "REVIEW_MODE",
    type: "string",
    choices: ["human", "agent"],
    group: "autonomy",
    label: "Review mode",
    help:
      "Who reviews a delivery before merge: human · agent · both. Agent reviews are " +
      "ADVISORY — a human (or the AFK auto-approve chain) still owns the merge.",
  },

  // --- Delivery: what the factory does once a ticket is approved ---
  {
    key: "AUTO_MERGE",
    type: "boolean",
    group: "delivery",
    label: "Auto-merge on approval",
    help: "Safe-merge into the default branch on approval. Off → approved tickets wait at ready-for-merge for a human.",
  },
  {
    key: "GAFFER_AUTO_PUSH",
    type: "boolean",
    group: "delivery",
    label: "Push after merge",
    help: "The final AFK step: push the default branch to origin after a successful auto-merge. Requires Auto-merge; off → merges stay local.",
  },
  {
    key: "GAFFER_CREATE_PR",
    type: "boolean",
    group: "delivery",
    label: "Deliver as a pull request",
    help: "Open a GitHub PR with the delivery evidence instead of merging directly. Needs the gh CLI authenticated.",
  },
  {
    key: "GAFFER_REQUIRE_CI",
    type: "boolean",
    group: "delivery",
    label: "Require CI green before merge",
    help: "Poll the branch's CI checks and only merge when they pass. Off → merge without waiting on CI.",
  },
  {
    key: "GAFFER_ALLOW_SELF_DELIVERY",
    type: "boolean",
    group: "delivery",
    label: "Allow self-delivery",
    help: "Permit the factory to deliver into its OWN repo. Off (default) is the safe choice — it never edits itself by accident.",
  },

  // --- Execution: how the loop schedules and paces work ---
  {
    key: "GAFFER_CONCURRENCY",
    type: "int",
    group: "execution",
    label: "Concurrent ticks",
    help: "How many tickets run in parallel, each in its own git worktree. 1 = strictly serial (safest); >1 fans out.",
  },
  {
    key: "TICK_SLEEP",
    type: "int",
    group: "execution",
    label: "Pause between ticks (s)",
    help: "Seconds the loop waits between ticks.",
  },
  {
    key: "EMPTY_POLL_LIMIT",
    type: "int",
    group: "execution",
    label: "Empty polls before idle",
    help: "Consecutive empty polls (no ready work) before the run stops or drops into idle loops.",
  },
  {
    key: "MAX_CONCURRENT_TICKETS_PER_REPO",
    type: "int",
    group: "execution",
    label: "Max in-flight tickets / repo",
    help: "Cap on tickets worked at once within one repo.",
  },
  {
    key: "MAX_CANDIDATES",
    type: "int",
    group: "execution",
    label: "Max candidates scanned",
    help: "Upper bound on ready tickets the scheduler considers each tick.",
  },

  // --- Budget / caps (cont.): retries, CI polling, open-work ceilings ---
  {
    key: "GAFFER_MAX_DELIVERY_ATTEMPTS",
    type: "int",
    group: "budget",
    label: "Max delivery attempts",
    help: "How many times a ticket may be re-worked after a rejected review before it parks to blocked.",
  },
  {
    key: "GAFFER_MAX_NOCOMMIT_FAILURES",
    type: "int",
    group: "budget",
    label: "Max no-commit failures",
    help:
      "Cross-run bound on deliveries that crash before committing. After this many " +
      "no-commit/wrong-branch failures the ticket parks visibly to blocked instead of " +
      "being re-picked (and re-billed) every run. Defaults to Max delivery attempts.",
  },
  {
    key: "GAFFER_REWORK_BUDGET_USD",
    type: "string",
    group: "budget",
    label: "Per-ticket rework budget (USD)",
    help:
      "Cumulative spend ceiling for one ticket's rework loop. Delivery stops at whichever " +
      "hits first — this or Max delivery attempts — then parks to blocked. Defaults to the " +
      "factory Budget ceiling; empty = no per-ticket cap (attempts alone bound it).",
  },
  {
    key: "GAFFER_MAX_RESUMES_PER_TICK",
    type: "int",
    group: "budget",
    label: "Max resumes / tick",
    help: "How many times a tick may resume a timed-out agent before giving up.",
  },
  {
    key: "GAFFER_PAUSE_ON_CAP",
    type: "boolean",
    group: "budget",
    label: "Pause on budget cap",
    help: "When the spend ceiling is hit, pause in-flight work instead of hard-stopping.",
  },
  {
    key: "GAFFER_CI_POLL_ATTEMPTS",
    type: "int",
    group: "budget",
    label: "CI poll attempts",
    help: "How many times to poll CI checks (when Require-CI is on) before giving up.",
  },
  {
    key: "GAFFER_CI_POLL_INTERVAL_SECS",
    type: "int",
    group: "budget",
    label: "CI poll interval (s)",
    help: "Seconds between CI check polls.",
  },
  {
    key: "MAX_OPEN_AGENT_BRANCHES_PER_REPO",
    type: "int",
    group: "budget",
    label: "Max open agent branches / repo",
    help: "Ceiling on undelivered agent branches per repo — backpressure so work merges before more starts.",
  },
  {
    key: "MAX_OPEN_AGENT_PRS_PER_REPO",
    type: "int",
    group: "budget",
    label: "Max open agent PRs / repo",
    help: "Ceiling on open agent-authored PRs per repo.",
  },

  // --- Idle loops (cont.): the other between-work loops ---
  {
    key: "CLARIFY_DRAFTS_WHEN_IDLE",
    type: "boolean",
    group: "idle-loops",
    label: "Clarify vague drafts when idle",
    help: "When idle, run the clarify pass over vague draft tickets to sharpen their acceptance criteria.",
  },
  {
    key: "IDLE_DRAFT_WHEN_IDLE",
    type: "boolean",
    group: "idle-loops",
    label: "Draft new tickets when idle",
    help: "When idle, let the product-owner loop propose new draft tickets from the repos it watches.",
  },

  // --- Quality gates: the runner's DoD guards on every delivery ---
  {
    key: "HYGIENE_ENFORCE",
    type: "boolean",
    group: "quality",
    label: "Enforce repo hygiene",
    help: "Reject deliveries that touch forbidden paths (node_modules, .claude/, factory internals). On by default.",
  },
  {
    key: "MINIMALISM_ENFORCE",
    type: "boolean",
    group: "quality",
    label: "Enforce minimal diffs",
    help: "Flag oversized/sprawling diffs against the caps below, so a ticket ships a focused change.",
  },
  {
    key: "OVERSIZED_MAX_FILES",
    type: "int",
    group: "quality",
    label: "Oversized: max files",
    help: "A diff touching more than this many files trips the minimalism check.",
  },
  {
    key: "OVERSIZED_MAX_LINES",
    type: "int",
    group: "quality",
    label: "Oversized: max lines",
    help: "A diff changing more than this many lines trips the minimalism check.",
  },

  // --- Sandbox: optional OS-level execution confinement ---
  {
    key: "STRICT_MODE",
    type: "boolean",
    group: "sandbox",
    label: "Strict execution sandbox",
    help: "Wrap agent commands in the OS sandbox (sandbox-exec on macOS) for defence-in-depth. Off → the permission-hook guard only.",
  },
  {
    key: "STRICT_ALLOW_NETWORK",
    type: "boolean",
    group: "sandbox",
    label: "Allow network in sandbox",
    help: "When the strict sandbox is on, still permit outbound network (package installs, git, the model API).",
  },
  {
    key: "SANDBOX_PROVIDER",
    type: "string",
    choices: ["sandbox-exec", "docker", "lima", "none"],
    group: "sandbox",
    label: "Sandbox provider",
    help:
      "Which OS-level containment backend the strict sandbox uses: docker " +
      "(experimental — real read + write + egress isolation, any host with a Docker " +
      "daemon) · sandbox-exec (macOS — write-only containment) · none (disable OS " +
      "wrapping, keep the toggle). lima/VM are future (stronger per-ticket microVM). " +
      "Only consulted when the strict sandbox is on.",
  },
  {
    key: "STRICT_ALLOW_HOME",
    type: "string",
    group: "sandbox",
    label: "Sandbox writable HOME paths",
    help:
      "Space-separated HOME paths the strict sandbox may write to outside the worktree " +
      "(Claude Code keeps state/cache here; denying them breaks legitimate runtime writes). " +
      "Defaults to ~/.claude and ~/.cache.",
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
    throw new DispatchError("INTERNAL_ERROR", `Could not read settings file: ${describe(err)}`);
  }
  const trimmed = raw.trim();
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
    ...(def.choices !== undefined ? { choices: def.choices } : {}),
  }));
}

/** Outcome of a settings write: which keys persisted and which were rejected. */
export interface WriteSettingsResult {
  readonly written: string[];
  /** Known keys skipped because they are env-locked (env overrides the file). */
  readonly rejected: string[];
  /** Unknown keys silently dropped (not in the allow-list). */
  readonly ignored: string[];
  /** Known enum keys skipped because the value wasn't one of the allowed choices. */
  readonly invalid: string[];
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
  const invalid: string[] = [];

  for (const [key, value] of Object.entries(updates)) {
    const def = SETTING_DEFS.find((d) => d.key === key);
    if (def === undefined) {
      ignored.push(key);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      // env-locked: an explicit env var overrides the file, so persisting this
      // would mislead the operator (the runner would ignore it). Refuse it.
      rejected.push(key);
      continue;
    }
    // Enum settings only accept a listed choice. An empty value is always
    // allowed — it clears the override back to the built-in default.
    if (def.choices !== undefined && value !== "" && !def.choices.includes(value)) {
      invalid.push(key);
      continue;
    }
    merged[key] = value;
    written.push(key);
  }

  // Only touch the disk when something actually changed.
  if (written.length > 0) {
    atomicWriteJson(path, merged);
  }

  return { written, rejected, ignored, invalid };
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
